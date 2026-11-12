//! A thread outlives its lead run: a lead that failed, or whose turn ended without a report, is
//! taken over by a new run on another CLI; `settleUnsentTurn`, `restartThread`, `startThreadAgain`,
//! `needsRestart`, `carried`, `carryFiles` and `recoveryTask` of `server/fleet/orchestrator.ts`
//! (ADR 0267-restart).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use protocol::{AgentRun, AgentState, FleetAgentKind, TurnOutcome, js};
use tokio_util::sync::CancellationToken;

use super::spawn::{PlannedSpawn, TASK_FILE, Takeover, ThreadPlace, write_private};
use super::threads::CONTRACT_FILE;
use super::turns::read_result;
use super::{BoxFuture, Orchestrator, THREAD_ROLE, is_live, is_thread, locked, thread_id};
use crate::config::FleetConfig;
use crate::events::{FleetEvent, RestartEvent, RestartWhy};

/// The check before any outside action that a lead taking a thread over is told to make
/// (dsh-superagent's recovery note).
const RECOVERY_NOTE: &str = "Check the worktree, git history and GitHub before repeating any outside action (push, PR, comment).";
/// The outbox slot of a thread's news for its coordinator.
const NEWS: &str = "news";

/// What the restarts keep while this server runs.
#[derive(Debug, Default)]
pub(crate) struct State {}

/// What became of a thread whose lead a settlement found in need of a new run (`restart_thread`).
#[derive(Debug, PartialEq)]
enum Restart {
    /// it needs none any more, a new run took it over, or the restart was cancelled
    Done,
    /// a turn the fleet sent the lead is on its way: that turn's settlement decides, and settles
    /// the thread; the turn before is left to it (ADR 0358-settlement-and-sent-turn)
    Deferred,
    /// no new run could take it over, for this reason
    Failed(String),
}

impl Restart {
    /// Why the thread could not start again, for its news.
    fn error(self) -> Option<String> {
        match self {
            Restart::Failed(error) => Some(error),
            Restart::Done | Restart::Deferred => None,
        }
    }
}

/// A turn of a thread's lead, read by its settlement, as the thread's part of that settlement needs
/// it (`settle_lead_turn`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LeadTurn {
    /// what the fleet sent for it, which a new run hears as the fleet's last message
    pub text: Option<String>,
    /// for the plan it went past; none for a turn the fleet did not send
    pub sent: Option<SentTurn>,
}

/// A turn the fleet sent, as the plan it went past needs it (`LeadTurn`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SentTurn {
    pub generation: u64,
    /// when its prompt was handed to herdr; none for a turn a restart took over
    pub submitted_at: Option<i64>,
}

/// A thread's settled lead whose run failed or whose turn left no report, and the thread still
/// open: it goes on in a new run (`needsRestart`).
pub(crate) fn needs_restart(run: &AgentRun) -> bool {
    is_thread(run)
        && run.landed.is_none()
        && run.replaced_by.is_none()
        && (run.state == AgentState::Failed
            || matches!(run.outcome, Some(TurnOutcome::NoReport { .. })))
}

impl Orchestrator {
    /// The thread of the lead `id` goes on in a new run (`restartThread`). `last_message` is what
    /// the fleet last sent the run, when it sent it.
    ///
    /// A landing step pressed before goes first, under the thread's lock: a discard leaves nothing
    /// to start again. The run is read again under the lock, and `Failed` comes back only when no
    /// new run took the thread over, never for a cancel (ADR 0265-plans).
    ///
    /// A turn the fleet sent the run since the settlement read `turn` (a landing step, which holds
    /// this lock until it is sent) leaves the thread as it is: that turn's settlement decides
    /// whether it starts again, and the run keeps its pane meanwhile. That turn keeps `turn`, for
    /// when it is dropped before it reaches the lead (ADR 0358-settlement-and-sent-turn).
    async fn restart_thread(&self, id: &str, turn: &LeadTurn) -> Restart {
        let Some(run) = self.registry().get(id) else {
            return Restart::Done;
        };
        self.inner
            .thread_locks
            .run(thread_id(&run).to_owned(), async {
                let Some(run) = self.registry().get(id).filter(needs_restart) else {
                    return Restart::Done;
                };
                if self.leave_restart(id, turn) {
                    return Restart::Deferred;
                }
                self.start_thread_again(run, turn.text.as_deref())
                    .await
                    .map_or(Restart::Done, Restart::Failed)
            })
            .await
    }

    /// The thread goes on in a new run of its lead, on a CLI none of its runs failed on since its
    /// last report, in the same worktree, branch and fleet. Once the new run has the task, the old
    /// run's pane closes, so one lead works in the worktree; its news is dropped and its other
    /// notices (a merge step the coordinator has not heard yet) are the new run's. The coordinator
    /// hears nothing of a restart, only of one that could not start: this returns why
    /// (`startThreadAgain`).
    async fn start_thread_again(
        &self,
        run: AgentRun,
        last_message: Option<&str>,
    ) -> Option<String> {
        let why = if run.state == AgentState::Failed {
            RestartWhy::Failed
        } else {
            RestartWhy::NoReport
        };
        let mut avoid: Vec<FleetAgentKind> = Vec::new();
        for kind in run.avoid.iter().flatten().copied().chain([run.agent]) {
            if !avoid.contains(&kind) {
                avoid.push(kind);
            }
        }
        let result_dir = self.result_dir(&run.id);
        let task = read_result(&result_dir.join(TASK_FILE));
        let thread = thread_id(&run).to_owned();
        let since = self.now();
        let request = PlannedSpawn {
            name: Some(run.name.clone()),
            role: THREAD_ROLE.to_owned(),
            model: None,
            thinking: None,
            cwd: run.cwd.clone(),
            worktree: Some(false),
            interactive: Some(true),
            direction: None,
            group: run.group.clone(),
            depth: run.depth.saturating_sub(1),
            caller_pane_id: None,
            avoid: Some(avoid),
            task: recovery_task(&run, &result_dir, task.as_deref(), last_message),
            write: None,
            thread: Some(ThreadPlace {
                repo: run.project.as_ref().map(PathBuf::from),
                owner: run.owner.clone(),
                base: run.base.clone(),
                base_branch: run.base_branch.clone(),
                takeover: Some(Takeover {
                    from: run.clone(),
                    thread: thread.clone(),
                    task,
                }),
            }),
        };
        let event = |by: Option<&AgentRun>, error: Option<String>| {
            FleetEvent::Restart(RestartEvent {
                run: run.id.clone(),
                project: run.project.clone().unwrap_or_default(),
                agent: run.agent,
                why,
                by: by.map(|next| next.id.clone()),
                to: by.map(|next| next.agent),
                error,
            })
        };
        // no caller waits on a restart: nothing cancels it
        let spawned = self
            .spawn_with_fallbacks(request, &CancellationToken::new(), None, None)
            .await;
        let outcome = match &spawned {
            Ok(next) => {
                self.hand_over(&run, next).await;
                self.event(event(Some(next), None));
                None
            }
            Err(error) if error.is_cancelled() => None,
            Err(error) => {
                let reason = error.to_string();
                self.event(event(None, Some(js::cut_utf16(&reason, 200).to_owned())));
                Some(reason)
            }
        };
        // a candidate that failed to start on the way is no lead of the thread: it points to the
        // run that leads it, and gives back the landing step it was handed, which only that run
        // holds
        let leader = spawned
            .as_ref()
            .map_or(run.id.as_str(), |next| next.id.as_str());
        for failed in self.list(None) {
            if failed.thread.as_deref() != Some(thread.as_str())
                || failed.id == leader
                || failed.state != AgentState::Failed
                || failed.replaced_by.is_some()
                || failed.started_at < since
            {
                continue;
            }
            self.change(&failed.id, |failed| {
                failed.replaced_by = Some(leader.to_owned());
                failed.landing = None;
            });
        }
        outcome
    }

    /// The thread is the new run `next`'s: the old run points to it, gives it the landing step and
    /// its notices, and its pane closes.
    async fn hand_over(&self, run: &AgentRun, next: &AgentRun) {
        let old = self.take_over_plan(run, next);
        // the new run took the landing step over as it started: a step marked sent meanwhile goes
        // as marked
        if let Some(step) = old.and_then(|old| old.landing) {
            self.change(&next.id, |lead| {
                if lead
                    .landing
                    .as_ref()
                    .is_some_and(|carried| carried.at == step.at)
                {
                    lead.landing = Some(step);
                }
            });
        }
        // the thread's question and landing step went to the new run: the old one must not be
        // landed too, and a merge step the coordinator has not heard yet waits for it as the new
        // run's
        let outbox = &self.inner.outbox;
        for written in [
            outbox.discard(&run.id, NEWS),
            outbox.move_notices(&run.id, &next.id),
        ] {
            if let Err(error) = written {
                eprintln!("herdr-fleet: the outbox file could not be written: {error}");
            }
        }
        self.change(&run.id, |old| old.landing = None);
        let _ = self.deps().runtime.close_pane(&run.pane_id).await;
        let now = self.now();
        self.change(&run.id, |old| {
            if is_live(old) {
                old.state = AgentState::Stopped;
            }
            old.updated_at = now;
        });
        self.drop_pending(&run.id);
    }

    /// The old run points to the new run `next`, and a plan its lead handed over while `next`
    /// started (a newer version than `next` holds) goes on as `next`'s; the old run as saved.
    /// Both happen under the plans' lock, which `submit_plan` holds while it finds the lead: a plan
    /// handed over before goes to `next` here, one after reaches `next` itself (ADR 0267-restart).
    fn take_over_plan(&self, run: &AgentRun, next: &AgentRun) -> Option<AgentRun> {
        let _plans = locked(&self.inner.plans);
        let old = self.change(&run.id, |old| old.replaced_by = Some(next.id.clone()))?;
        let version = |run: Option<&AgentRun>| {
            run.and_then(|run| run.plan.as_ref())
                .map_or(0, |mark| mark.version)
        };
        if version(Some(&old)) > version(self.registry().get(&next.id).as_ref()) {
            let plan = |id: &str| self.plans_dir().join(format!("{id}.json"));
            match fs::copy(plan(&old.id), plan(&next.id)) {
                Ok(_) => {
                    self.change(&next.id, |lead| lead.plan.clone_from(&old.plan));
                }
                Err(error) => {
                    eprintln!(
                        "herdr-fleet: the plan of {} was not carried: {error}",
                        old.id
                    );
                }
            }
        }
        Some(old)
    }

    /// A thread's turn the fleet did not send ended: its agent started it itself (a helper's
    /// result woke it after a turn that broke off to wait) or the person typed in its pane. Without
    /// the person, nothing else tells the coordinator, which waits for this news to go on
    /// (`settleUnsentTurn`). Called only under the run's `reconcile_locks`, as `finalize` is: one
    /// settlement at a time per run (ADR 0358-settlement-and-sent-turn).
    pub(crate) async fn settle_unsent_turn(&self, id: &str) {
        let Some(run) = self.registry().get(id) else {
            return;
        };
        let config = self.config(&run.cwd);
        if !config.autonomous {
            return;
        }
        // once a turn the fleet sends is on its way, it cleared these files for its own: its
        // settlement reads them, and this turn's are gone. The check and the read are one step
        // under the lock that turn takes (ADR 0267-restart, #344)
        let Some((generation, files)) = self.read_unsent_turn_files(&run) else {
            return;
        };
        self.read_turn(id, &config, files).await;
        self.read_thread_work(id).await;
        let turn = LeadTurn {
            text: None,
            sent: None,
        };
        self.settle_lead_turn(id, &config, turn, true).await;
        let now = self.now();
        self.change(id, |run| run.updated_at = now);
        // a turn the fleet sent meanwhile keeps its own waiters
        self.settle_turn_waiters(id, generation);
        if self.inner.outbox.holds(id) {
            let (fleet, id) = (self.clone(), id.to_owned());
            tokio::spawn(async move { fleet.tell_coordinator(&id).await });
        }
    }

    /// The thread's part of the settlement of its lead's `turn`, once the turn is read: a lead
    /// whose run failed or whose turn left no report goes on in a new run, from the contract and
    /// change the turn left; then, while no new run took the thread over, the plan the turn went
    /// past closes, and the thread's turn settles (its landing step and news). A turn the fleet
    /// sent the lead since takes all of it over (`Restart::Deferred`, ADR
    /// 0358-settlement-and-sent-turn). Without `may_restart`, the lead stays as it is (it waits on
    /// a question).
    pub(crate) async fn settle_lead_turn(
        &self,
        id: &str,
        config: &FleetConfig,
        turn: LeadTurn,
        may_restart: bool,
    ) {
        let restart = match self.registry().get(id) {
            Some(run) if may_restart && needs_restart(&run) => self.restart_thread(id, &turn).await,
            _ => Restart::Done,
        };
        if restart == Restart::Deferred {
            return;
        }
        let Some(run) = self
            .registry()
            .get(id)
            .filter(|run| is_thread(run) && run.replaced_by.is_none())
        else {
            return;
        };
        let restart_error = restart.error();
        if let Some(SentTurn {
            generation,
            submitted_at,
        }) = turn.sent
        {
            // a turn that failed or left no report went nowhere; a lead taking a thread over starts
            // with its plan still open, and keeps it so while it reports blocked on it
            let passed = match &run.outcome {
                Some(TurnOutcome::Report(report)) => {
                    !(generation == 1
                        && run.thread.is_some()
                        && report.state == protocol::ReportState::Blocked)
                }
                _ => restart_error.is_some(),
            };
            if passed {
                self.close_stale_plan(id, submitted_at);
            }
        }
        self.settle_thread_turn(id, config, restart_error).await;
    }

    /// The turn the fleet sent the lead `id`, to which a settlement left the restart of the thread,
    /// was dropped before it reached the lead: no settlement of it follows, so the thread's part of
    /// the settlement of `turn`, the turn before it, runs now, in a task of its own and under the
    /// run's `reconcile_locks`, one settlement at a time per run; without `may_restart`, it leaves
    /// the lead as it is (ADR 0358-settlement-and-sent-turn). Nothing runs once the fleet stops.
    /// Boxed, so the send's type does not depend on it.
    pub(crate) fn settle_left_restart(&self, id: &str, turn: LeadTurn, may_restart: bool) {
        let task: BoxFuture<'static, ()> = {
            let (fleet, id) = (self.clone(), id.to_owned());
            Box::pin(async move {
                let settle = async {
                    if fleet.is_stopped() {
                        return;
                    }
                    let Some(run) = fleet.registry().get(&id) else {
                        return;
                    };
                    let config = fleet.config(&run.cwd);
                    fleet
                        .settle_lead_turn(&id, &config, turn, may_restart)
                        .await;
                };
                fleet.inner.reconcile_locks.run(id.clone(), settle).await;
                if !fleet.is_stopped() && fleet.inner.outbox.holds(&id) {
                    fleet.tell_coordinator(&id).await;
                }
            })
        };
        tokio::spawn(task);
    }

    /// What a lead that takes a thread over carries on its new run from the run before: the
    /// thread, what the fleet knows of its landing, and the CLIs to pass over (`carried`).
    pub(crate) fn carry_over(
        &self,
        takeover: &Takeover,
        avoid: Option<&[FleetAgentKind]>,
        run: &mut AgentRun,
    ) {
        // the run before as it stands now, as TypeScript reads its record here: what changed on it
        // since the restart began (a plan answered, a pull request read) goes on with the thread
        let from = self
            .registry()
            .get(&takeover.from.id)
            .unwrap_or_else(|| takeover.from.clone());
        run.thread = Some(takeover.thread.clone());
        if let Some(avoid) = avoid.filter(|avoid| !avoid.is_empty()) {
            run.avoid = Some(avoid.to_vec());
        }
        run.pr.clone_from(&from.pr);
        run.plan.clone_from(&from.plan);
        run.landing.clone_from(&from.landing);
        run.contract.clone_from(&from.contract);
        run.diff.clone_from(&from.diff);
    }

    /// What a lead that takes a thread over starts from in its result folder: the run before's
    /// contract, as its own to bring up to date (read as a result is, never through a symlink),
    /// and the thread's plan (`carryFiles`). A contract that cannot be written fails the new run's
    /// start: it is told its contract starts as the run before's.
    pub(crate) fn carry_files(&self, from: &AgentRun, to: &AgentRun) -> io::Result<()> {
        if let Some(contract) = read_result(&self.result_dir(&from.id).join(CONTRACT_FILE)) {
            let file = self.result_dir(&to.id).join(CONTRACT_FILE);
            // the error names the file, as Node's does
            write_private(&file, &format!("{contract}\n")).map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!(
                        "the contract was not carried to {}: {error}",
                        file.display()
                    ),
                )
            })?;
        }
        let plan = |id: &str| self.plans_dir().join(format!("{id}.json"));
        // the thread has no plan when there is none to copy
        let _ = fs::copy(plan(&from.id), plan(&to.id));
        Ok(())
    }
}

/// The first task of a lead that takes a thread over from `run` (`recoveryTask`).
fn recovery_task(
    run: &AgentRun,
    result_dir: &Path,
    task: Option<&str>,
    last_message: Option<&str>,
) -> String {
    let how = if run.state == AgentState::Failed {
        let error = run.last_error.as_deref().unwrap_or("its turn failed");
        format!("failed: {}", error.strip_suffix('.').unwrap_or(error))
    } else {
        let problem = match &run.outcome {
            Some(TurnOutcome::NoReport { problem }) => problem.as_str(),
            _ => "no report",
        };
        format!("ended its turn without a report ({problem})")
    };
    // the message that started the run before is the thread's task, or this note: neither is
    // repeated
    let last = last_message.map(js::trim).unwrap_or_default();
    let repeat = last.is_empty()
        || Some(last) == task
        || last.starts_with("[fleet] You take over the thread");
    let on_branch = run
        .branch
        .as_deref()
        .filter(|branch| !branch.is_empty())
        .map(|branch| format!(" on {branch}"))
        .unwrap_or_default();
    let mut lines = vec![
        format!(
            "[fleet] You take over the thread \"{}\" from run {} on {}, which {how}. This comes from the fleet, not from the person.",
            run.name,
            run.id,
            run.agent.name()
        ),
        format!(
            "Your folder is the thread's worktree{on_branch}, where the run before left its work. It left its handoff, contract and report, as far as it wrote them, in {}: read them. Your contract starts as its contract; bring it up to date.",
            result_dir.display()
        ),
        RECOVERY_NOTE.to_owned(),
    ];
    if let Some(task) = task.filter(|task| !task.is_empty()) {
        lines.extend([
            String::new(),
            "The thread's task:".to_owned(),
            String::new(),
        ]);
        lines.push(task.to_owned());
    }
    if !repeat {
        lines.extend([
            String::new(),
            "The fleet's last message to the run before:".to_owned(),
            String::new(),
            last.to_owned(),
        ]);
    }
    lines.join("\n")
}
