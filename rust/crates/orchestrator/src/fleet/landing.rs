//! Landing a thread: the steps the person presses, the merges checked in git and on GitHub, and
//! closing a thread; `landable`, `checks`, `diff`, `land`, `landStep`, `onThread`,
//! `readPullRequest`, `settleLeadStep`, `settleMerges`, `settleMerge`, `onLead`, `mergedOnGitHub`,
//! `refreshPullRequests`, `closeThread`, `settleThreadTurn`, `staleStep`, `leadStep`,
//! `coordinatorStep` and the real `LandingTools` (`LANDING_TOOLS`) of
//! `server/fleet/orchestrator.ts` (ADR 0266-landing).
//!
//! The server writes nothing to GitHub: the lead takes the steps on its branch, the project's
//! coordinator the merges, and the server reads git and GitHub as their turns end to see whether a
//! step happened. The only thing it removes by itself, at the press of a step, is a discarded
//! thread's panes, worktree and branch; a merged thread's go once git or GitHub shows the merge.

use std::future::Future;
use std::path::{Path, PathBuf};

use protocol::{
    AgentRun, AgentState, DiffStat, LandAction, Landed, LandingChecks, LandingStep, LineComment,
    PullRequestState, js,
};
use tokio_util::sync::CancellationToken;

use super::autonomy::MergeSeen;
use super::notices::{STEPS_HEADER, thread_label};
use super::{
    BoxFuture, LandingTools, Orchestrator, OrchestratorError, is_live, is_thread, state_name,
    thread_id,
};
use crate::config::FleetConfig;
use crate::error::FleetError;
use crate::github::{GhError, GitHub, PullRequestReading};
use crate::outbox::{Notice, NoticeInput};
use crate::thread::{self, BranchState, DiffText, RemoveOptions, SetupOutcome, worktree_path};

/// The outbox's slot of a thread's merge step.
const LANDING_SLOT: &str = "landing";
/// The outbox's section the merge steps go under.
const STEPS_SECTION: &str = "steps";

/// What landing keeps while this server runs: nothing; the steps are on the runs, and the merges
/// waiting for the coordinator in the outbox.
#[derive(Debug, Default)]
pub(crate) struct State {}

/// The landing steps a thread's lead takes on its branch (`LEAD_STEPS`).
fn is_lead_step(action: LandAction) -> bool {
    matches!(
        action,
        LandAction::Update | LandAction::Pr | LandAction::FixCi | LandAction::Comments
    )
}

/// The landing steps the project's coordinator takes (`COORDINATOR_STEPS`).
fn is_coordinator_step(action: LandAction) -> bool {
    matches!(action, LandAction::Merge | LandAction::MergePr)
}

/// A step as the API and the records spell it.
fn action_name(action: LandAction) -> &'static str {
    match action {
        LandAction::Update => "update",
        LandAction::Pr => "pr",
        LandAction::FixCi => "fix-ci",
        LandAction::Comments => "comments",
        LandAction::Merge => "merge",
        LandAction::MergePr => "merge-pr",
        LandAction::Discard => "discard",
    }
}

fn landed_name(landed: Landed) -> &'static str {
    match landed {
        Landed::Merged => "merged",
        Landed::Discarded => "discarded",
    }
}

/// The step went as far as the fleet knows: JavaScript's `!step.error`, where an empty text is no
/// error either.
fn no_error(step: &LandingStep) -> bool {
    step.error.as_deref().is_none_or(str::is_empty)
}

/// `value` unless it is empty: JavaScript's `value ? … : …` on an optional string.
fn given(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.is_empty())
}

/// The repository and branch of a thread: the place every git and GitHub read of it takes.
fn place(run: &AgentRun) -> Option<(&str, &str)> {
    Some((
        given(run.project.as_deref())?,
        given(run.branch.as_deref())?,
    ))
}

/// Whether the run's recorded pull request is open.
fn pr_open(run: &AgentRun) -> bool {
    run.pr
        .as_ref()
        .is_some_and(|pr| pr.state == PullRequestState::Open)
}

/// The number of the run's pull request as JavaScript's `${run.pr?.number}` writes it.
fn pr_number(run: &AgentRun) -> String {
    run.pr
        .as_ref()
        .map_or_else(|| "undefined".to_owned(), |pr| pr.number.to_string())
}

impl Orchestrator {
    fn tools(&self) -> &dyn LandingTools {
        self.deps().landing.as_ref()
    }

    /// A thread on a branch of its own, still there to land: the landing steps' target
    /// (`landable`).
    fn landable(&self, target: &str, group: Option<&str>) -> Result<AgentRun, FleetError> {
        let run = self.get(target, group)?;
        if !is_thread(&run) || given(run.branch.as_deref()).is_none() {
            return Err(FleetError::new(
                "not_a_thread",
                format!("{} is not a thread on a branch of its own.", run.name),
            ));
        }
        Ok(run)
    }

    /// The branch the thread lands on: the one it recorded at its start, or the one the main
    /// checkout is on now, or main (`baseBranchOf`).
    async fn base_branch_of(&self, run: &AgentRun) -> String {
        if let Some(base) = run.base_branch.as_deref() {
            return base.to_owned();
        }
        let project = run.project.as_deref().unwrap_or_default();
        self.tools()
            .git_branch(Path::new(project))
            .await
            .unwrap_or_else(|| "main".to_owned())
    }

    /// What stands between a thread and landing: its uncommitted work, its branch beside the base,
    /// its pull request, read now (`checks`).
    pub async fn checks(
        &self,
        target: &str,
        group: Option<&str>,
    ) -> Result<LandingChecks, FleetError> {
        let run = self.landable(target, group)?;
        let base_branch = self.base_branch_of(&run).await;
        let branch = match run.landed {
            Some(_) => None,
            None => {
                self.tools()
                    .branch_state(Path::new(&run.cwd), &base_branch)
                    .await
            }
        };
        let BranchState {
            uncommitted,
            ahead,
            behind,
        } = branch.unwrap_or(BranchState {
            uncommitted: Vec::new(),
            ahead: 0,
            behind: 0,
        });
        let mut checks = LandingChecks {
            base_branch,
            uncommitted,
            ahead,
            behind,
            pr: None,
            pr_error: None,
        };
        match self.read_pull_request(&run.id).await {
            Ok(reading) => checks.pr = reading.map(|reading| reading.pr),
            Err(error) => {
                checks.pr_error = Some(error.to_string());
                checks.pr = self.registry().get(&run.id).and_then(|run| run.pr);
            }
        }
        Ok(checks)
    }

    /// A thread's change since it left its base branch, as a unified diff (`diff`).
    pub async fn diff(&self, target: &str, group: Option<&str>) -> Result<DiffText, FleetError> {
        let run = self.landable(target, group)?;
        let diff = match run.landed {
            Some(_) => None,
            None => {
                let base = self.base_branch_of(&run).await;
                self.tools().diff_text(Path::new(&run.cwd), &base).await
            }
        };
        diff.ok_or_else(|| {
            FleetError::new(
                "diff_unavailable",
                format!("git could not show the change of {}.", run.name),
            )
        })
    }

    /// A landing step the person pressed. The lead takes the steps on its branch at once (it must
    /// be free), the project's coordinator the merges once it is free (a new one starts when none
    /// lives), and a discard happens here. Each message names the step the person approved, and
    /// only that one. When the agent's turn ends, the fleet reads git and GitHub for whether the
    /// step happened (`land`).
    pub async fn land(
        &self,
        target: &str,
        action: LandAction,
        comments: &[LineComment],
        group: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<AgentRun, OrchestratorError> {
        let asked = self.landable(target, group)?;
        // a settlement still being handled finishes first: it may start the thread again on a new
        // lead. One that starts after this reads its turn's files under the lock the step's own
        // turn takes to clear them (#240's 2).
        self.inner.reconcile_locks.wait_idle(&asked.id).await;
        let (run, coordinator) = self
            .on_thread(
                thread_id(&asked),
                self.land_step(&asked.id, action, comments, group, cancel),
            )
            .await?;
        let Some(coordinator) = coordinator else {
            return Ok(run);
        };
        self.deliver_notices(&coordinator).await;
        Ok(self.get(&run.id, None)?)
    }

    /// The step on the thread's lead as the thread's lock found it, before or after a restart and
    /// never during one; a merge step comes back with the coordinator to tell once the lock is free
    /// (`landStep`).
    async fn land_step(
        &self,
        id: &str,
        action: LandAction,
        comments: &[LineComment],
        group: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<(AgentRun, Option<String>), OrchestratorError> {
        let run = self.landable(id, group)?;
        if let Some(landed) = run.landed {
            return Err(FleetError::new(
                "thread_landed",
                format!("{} was already {}.", run.name, landed_name(landed)),
            )
            .into());
        }
        if action == LandAction::Discard {
            self.close_thread(&run.id, Landed::Discarded, false).await;
            return Ok((self.registry().get(&run.id).unwrap_or(run), None));
        }
        let project = run.project.clone().unwrap_or_default();
        let handler = if is_lead_step(action) {
            Some(run.clone())
        } else {
            self.project_coordinator(&project)
        };
        if let Some(step) = &run.landing
            && no_error(step)
            && step.sent == Some(true)
            && let Some(handler) = &handler
            && is_live(handler)
            && self.turn_in_flight(&handler.id)
        {
            return Err(FleetError::new(
                "landing_busy",
                format!(
                    "{} is still on {}; wait for it to end.",
                    run.name,
                    action_name(step.action)
                ),
            )
            .into());
        }
        let base_branch = self.base_branch_of(&run).await;
        // read again after the await; the thread's lock keeps the other landing steps and the
        // restarts out meanwhile
        let run = self.registry().get(&run.id).unwrap_or(run);
        if action == LandAction::MergePr && !pr_open(&run) {
            return Err(FleetError::new(
                "no_pull_request",
                format!("{} has no open pull request.", run.name),
            )
            .into());
        }
        if action == LandAction::FixCi && run.pr.is_none() {
            return Err(FleetError::new(
                "no_pull_request",
                format!("{} has no pull request.", run.name),
            )
            .into());
        }
        if action == LandAction::Comments && comments.is_empty() {
            return Err(FleetError::new("missing_comments", "comments are required").into());
        }
        if is_lead_step(action) {
            return self
                .send_lead_step(&run, action, &base_branch, comments, cancel)
                .await
                .map(|run| (run, None));
        }
        let at = self.now();
        let step = LandingStep {
            action,
            at,
            sent: Some(false),
            error: None,
        };
        let run = self
            .change(&run.id, |run| run.landing = Some(step))
            .ok_or_else(|| run_not_found(id))?;
        let text = coordinator_step(&run, &base_branch);
        if let Some(coordinator) = self.project_coordinator(&project) {
            self.inner.outbox.put(NoticeInput {
                about: run.id.clone(),
                slot: LANDING_SLOT.to_owned(),
                section: STEPS_SECTION.to_owned(),
                text,
                landing_at: Some(at),
            })?;
            return Ok((run, Some(coordinator.id)));
        }
        // no coordinator lives: a new one starts with the step as its first task
        self.change(&run.id, |run| {
            if let Some(landing) = run.landing.as_mut() {
                landing.sent = Some(true);
            }
        });
        let task = format!("{STEPS_HEADER}\n- {text}");
        // boxed: a spawn's future is large, and `land`'s would carry it inline
        let start: BoxFuture<'_, _> =
            Box::pin(self.start_project(&task, Some(&project), None, cancel));
        if let Err(error) = start.await {
            let message = format!("No coordinator could start for the merge: {error}");
            self.change(&run.id, |run| {
                if let Some(landing) = run.landing.as_mut() {
                    landing.error = Some(message);
                }
            });
            return Err(error);
        }
        Ok((self.registry().get(&run.id).unwrap_or(run), None))
    }

    /// A step for the lead, free now: its landing marked sent, then the message written to the
    /// outbox and typed. The check that no turn of the fleet's is in flight and the new turn are
    /// one step (`submit_when_free`), so a turn sent meanwhile refuses this one, and the step goes
    /// back to what it was.
    async fn send_lead_step(
        &self,
        run: &AgentRun,
        action: LandAction,
        base_branch: &str,
        comments: &[LineComment],
        cancel: &CancellationToken,
    ) -> Result<AgentRun, OrchestratorError> {
        if !is_live(run) {
            return Err(FleetError::new(
                "run_ended",
                format!("The lead of {} has {}.", run.name, state_name(run.state)),
            )
            .into());
        }
        if self.turn_in_flight(&run.id) {
            return Err(FleetError::new(
                "run_busy",
                format!(
                    "The lead of {} is working; wait for its turn to end.",
                    run.name
                ),
            )
            .into());
        }
        let text = lead_step(run, action, base_branch, comments)?;
        let at = self.now();
        let previous = run.landing.clone();
        self.change(&run.id, |run| {
            run.landing = Some(LandingStep {
                action,
                at,
                sent: Some(true),
                error: None,
            });
        });
        let id = run.id.as_str();
        let sent = self
            .inner
            .outbox
            .send_now(id, &text, |each| async move {
                self.submit_when_free(id, &each, cancel).await
            })
            .await?;
        if let Err(error) = &sent
            && error.code() == "run_busy"
        {
            self.change(id, |run| {
                if run.landing.as_ref().is_some_and(|landing| landing.at == at) {
                    run.landing = previous;
                }
            });
        }
        sent
    }

    /// `work` once the thread's landing steps and restarts before it ended, and before the ones
    /// after it (`onThread`).
    async fn on_thread<T>(&self, thread: &str, work: impl Future<Output = T>) -> T {
        self.inner.thread_locks.run(thread.to_owned(), work).await
    }

    /// `work` on the thread the run `id` belongs to, under its lock and with its lead as the lock
    /// found it: a restart before it may have handed the thread to a new run, which the run before
    /// must not close. A thread that closed meanwhile, or a run no longer kept, is left alone
    /// (`onLead`).
    pub(crate) async fn on_lead<T, F, Fut>(&self, id: &str, work: F) -> Option<T>
    where
        F: FnOnce(AgentRun) -> Fut,
        Fut: Future<Output = T>,
    {
        let run = self.registry().get(id)?;
        self.on_thread(thread_id(&run), async {
            let lead = self.get(id, None).ok()?;
            if lead.landed.is_some() {
                return None;
            }
            Some(work(lead).await)
        })
        .await
    }

    /// The thread `id`'s pull request on GitHub now, kept on its run; none when its branch has
    /// none (`readPullRequest`).
    pub(crate) async fn read_pull_request(
        &self,
        id: &str,
    ) -> Result<Option<PullRequestReading>, GhError> {
        let Some(run) = self.registry().get(id) else {
            return Ok(None);
        };
        let Some((project, branch)) = place(&run) else {
            return Ok(None);
        };
        let reading = self
            .tools()
            .read_pull_request(Path::new(project), branch)
            .await?;
        let pr = reading.as_ref().map(|reading| reading.pr.clone());
        // read again after the await
        if self.registry().get(id).is_some_and(|run| run.pr != pr) {
            let now = self.now();
            self.change(id, |run| {
                run.pr = pr;
                run.updated_at = now;
            });
        }
        Ok(reading)
    }

    /// The lead's turn after a landing step ended: whether the step happened, as git and GitHub
    /// say (`settleLeadStep`). A step pressed while this read is kept as it is.
    async fn settle_lead_step(&self, id: &str) {
        let Some(run) = self.registry().get(id) else {
            return;
        };
        let Some(step) = run.landing.clone() else {
            return;
        };
        let branch = run.branch.clone().unwrap_or_default();
        let error = if step.action == LandAction::Pr {
            match self.read_pull_request(id).await {
                Ok(Some(reading)) if reading.pr.state == PullRequestState::Open => None,
                Ok(_) => Some(format!(
                    "The lead's turn ended without an open pull request for {branch}."
                )),
                Err(error) => Some(error.to_string()),
            }
        } else {
            let read = match pr_open(&run) {
                true => self.read_pull_request(id).await.err(),
                false => None,
            };
            match read {
                Some(error) => Some(error.to_string()),
                None if step.action == LandAction::Update => {
                    let base = self.base_branch_of(&run).await;
                    match self.tools().branch_state(Path::new(&run.cwd), &base).await {
                        Some(state) if state.behind > 0 => Some(format!(
                            "{branch} is still {} commit{} behind {base}.",
                            state.behind,
                            if state.behind == 1 { "" } else { "s" }
                        )),
                        _ => None,
                    }
                }
                None => None,
            }
        };
        self.change(id, |run| {
            if run
                .landing
                .as_ref()
                .is_some_and(|landing| landing.at == step.at)
            {
                run.landing = error.map(|error| LandingStep {
                    error: Some(error),
                    ..step
                });
            }
        });
    }

    /// The coordinator's turn ended: the merges it was handed, checked in git and on GitHub, and
    /// the threads that landed closed (`settleMerges`).
    pub(crate) async fn settle_merges(&self, coordinator: &str) {
        let handed: Vec<AgentRun> = self
            .registry()
            .all()
            .into_iter()
            .filter(|run| {
                run.replaced_by.is_none()
                    && run.landing.as_ref().is_some_and(|step| {
                        step.sent == Some(true)
                            && no_error(step)
                            && is_coordinator_step(step.action)
                    })
                    && run
                        .project
                        .as_deref()
                        .and_then(|project| self.project_coordinator(project))
                        .is_some_and(|hearer| hearer.id == coordinator)
            })
            .collect();
        // a restart of the thread under way finishes first: its new lead holds the step then
        for run in handed {
            let Some(step) = run.landing.clone() else {
                continue;
            };
            self.on_lead(&run.id, |thread| self.settle_merge(thread, step))
                .await;
        }
    }

    /// A merge step handed to the coordinator, settled on the thread's lead while it still holds
    /// that step (`settleMerge`).
    async fn settle_merge(&self, thread: AgentRun, handed: LandingStep) {
        let Some(step) = thread.landing.clone() else {
            return;
        };
        if step.sent != Some(true)
            || !no_error(&step)
            || step.action != handed.action
            || step.at != handed.at
        {
            return;
        }
        let Some((project, branch)) = place(&thread) else {
            return;
        };
        let error = if step.action == LandAction::Merge {
            let base = self.base_branch_of(&thread).await;
            if self
                .tools()
                .is_merged(Path::new(project), branch, &base)
                .await
            {
                self.close_thread(&thread.id, Landed::Merged, false).await;
                None
            } else {
                Some(format!(
                    "{branch} is not in {base} after the coordinator's turn; its reply says why."
                ))
            }
        } else {
            match self.read_pull_request(&thread.id).await {
                Ok(Some(reading)) if reading.pr.state == PullRequestState::Merged => {
                    self.merged_on_github(&thread.id, &reading).await;
                    None
                }
                Ok(_) => {
                    let number = self
                        .registry()
                        .get(&thread.id)
                        .and_then(|run| run.pr)
                        .map_or_else(|| "?".to_owned(), |pr| pr.number.to_string());
                    Some(format!(
                        "Pull request #{number} is not merged after the coordinator's turn; its reply says why."
                    ))
                }
                Err(error) => Some(error.to_string()),
            }
        };
        let now = self.now();
        self.change(&thread.id, |run| {
            if let Some(error) = error {
                run.landing = Some(LandingStep {
                    error: Some(error),
                    ..step
                });
            }
            run.updated_at = now;
        });
    }

    /// A thread whose pull request GitHub merged: closed, its branch deleted when GitHub merged the
    /// commit it is at here (`mergedOnGitHub`).
    pub(crate) async fn merged_on_github(&self, id: &str, reading: &PullRequestReading) {
        let Some(run) = self.registry().get(id) else {
            return;
        };
        let Some((project, branch)) = place(&run) else {
            return;
        };
        let local = self.tools().branch_head(Path::new(project), branch).await;
        let at_head = local.as_deref() == Some(reading.head.as_str());
        self.close_thread(id, Landed::Merged, at_head).await;
    }

    /// The open pull requests, read again: their checks, and whether the person merged or closed
    /// one on GitHub. A merged one closes its thread once its lead is not at work. The server calls
    /// this from time to time; it asks GitHub nothing while no thread has an open pull request
    /// (`refreshPullRequests`). In a project run without the person, what a merge read here does is
    /// the supervision's (`merged_without_person`, #268).
    pub async fn refresh_pull_requests(&self) {
        let open = self.list(None).into_iter().filter(|run| {
            is_thread(run) && pr_open(run) && run.landed.is_none() && run.replaced_by.is_none()
        });
        for run in open {
            // GitHub could not be asked: the reading kept stands until the next try
            let Ok(Some(reading)) = self.read_pull_request(&run.id).await else {
                continue;
            };
            if reading.pr.state != PullRequestState::Merged {
                continue;
            }
            if self.config(&run.cwd).autonomous {
                self.merged_without_person(&run.id, &reading, MergeSeen::Polled)
                    .await;
                continue;
            }
            let reading = &reading;
            self.on_lead(&run.id, |lead| async move {
                if !self.turn_in_flight(&lead.id) && lead.state != AgentState::Working {
                    self.merged_on_github(&lead.id, reading).await;
                }
            })
            .await;
        }
    }

    /// A thread that landed or was thrown away: its agents' panes close, its worktree and branch
    /// go (a discard forces both), and it is resolved. What git kept is said on the thread
    /// (`closeThread`).
    async fn close_thread(&self, id: &str, how: Landed, branch_merged: bool) {
        let Some(thread) = self.registry().get(id) else {
            return;
        };
        let members = self
            .list(None)
            .into_iter()
            .filter(|run| run.group == thread.group && is_live(run));
        for member in members {
            let _ = self.deps().runtime.close_pane(&member.pane_id).await;
            let now = self.now();
            self.drop_pending(&member.id);
            self.change(&member.id, |run| {
                run.state = AgentState::Stopped;
                run.updated_at = now;
            });
            self.settle_waiters(&member.id);
        }
        let Some((project, branch)) = place(&thread) else {
            return;
        };
        let project = Path::new(project);
        let worktree = worktree_path(project, thread_id(&thread));
        let options = RemoveOptions {
            force: how == Landed::Discarded,
            branch_merged,
        };
        let kept = self
            .tools()
            .remove_thread(project, &worktree, branch, options)
            .await
            .err()
            .filter(|kept| !kept.is_empty());
        let now = self.now();
        self.change(id, |run| {
            run.landed = Some(how);
            run.resolved_at = Some(now);
            run.landing = kept.map(|kept| LandingStep {
                action: match how {
                    Landed::Discarded => LandAction::Discard,
                    Landed::Merged => run
                        .landing
                        .as_ref()
                        .map_or(LandAction::Merge, |landing| landing.action),
                },
                at: now,
                sent: Some(true),
                error: Some(kept),
            });
            run.updated_at = now;
        });
    }

    /// A thread's settled turn: its landing step and pull request, and what its coordinator hears,
    /// with why the thread could not start again when it could not (`settleThreadTurn`).
    ///
    /// Two changes from TypeScript (ADR 0266-landing): a lead step that a turn sent while this one
    /// settled carries is left to that turn (#240's 2); and in a project run without the person, a
    /// thread with no pull request recorded asks GitHub after its news is queued, in a task of its
    /// own, so the news and the waiters do not wait on `gh` (#176's 7).
    pub(crate) async fn settle_thread_turn(
        &self,
        id: &str,
        config: &FleetConfig,
        restart_error: Option<String>,
    ) {
        let Some(run) = self.registry().get(id) else {
            return;
        };
        let lead_step = run.landing.as_ref().is_some_and(|step| {
            step.sent == Some(true) && no_error(step) && is_lead_step(step.action)
        });
        let mut ask_later = false;
        if lead_step {
            if !self.turn_in_flight(id) {
                self.settle_lead_step(id).await;
            }
        } else if pr_open(&run) || (config.autonomous && run.landed.is_none()) {
            // without the person, a lead opens and merges its own pull request: read it as its
            // turn ends
            if run.pr.is_none() {
                ask_later = true;
            } else {
                let reading = self.read_pull_request(id).await.ok().flatten();
                self.merge_at_turn_end(id, config.autonomous, reading).await;
            }
        }
        // the run holds what the news quotes: the step's outcome, the pull request, whether the
        // thread closed (ADR 0264-notices)
        self.queue_turn_news(id, config, restart_error.as_deref());
        if ask_later {
            let (fleet, id) = (self.clone(), id.to_owned());
            let ask: BoxFuture<'static, ()> =
                Box::pin(async move { fleet.ask_after_turn(&id).await });
            tokio::spawn(ask);
        }
    }

    /// A thread with no pull request recorded, asked about after its settled turn's news was
    /// queued (#176's 7): a merge read here is one no news of the turn quotes, so the supervision
    /// hears of it as one read outside a settlement (`MergeSeen::Polled`; ADR 0266-landing).
    async fn ask_after_turn(&self, id: &str) {
        if self.is_stopped() {
            return;
        }
        // GitHub could not be asked: the next turn's end or the polling asks again
        let Some(reading) = self.read_pull_request(id).await.ok().flatten() else {
            return;
        };
        let Some(run) = self.registry().get(id) else {
            return;
        };
        if !self.is_stopped()
            && reading.pr.state == PullRequestState::Merged
            && run.landed.is_none()
            && run.replaced_by.is_none()
            && self.config(&run.cwd).autonomous
        {
            self.merged_without_person(id, &reading, MergeSeen::Polled)
                .await;
        }
    }

    /// A merge read as a thread lead's turn ended in a project run without the person: the
    /// supervision's to act on (#268).
    async fn merge_at_turn_end(
        &self,
        id: &str,
        autonomous: bool,
        reading: Option<PullRequestReading>,
    ) {
        let Some(reading) = reading.filter(|reading| reading.pr.state == PullRequestState::Merged)
        else {
            return;
        };
        if autonomous
            && self
                .registry()
                .get(id)
                .is_some_and(|run| run.landed.is_none())
        {
            self.merged_without_person(id, &reading, MergeSeen::TurnEnded)
                .await;
        }
    }

    /// A merge step the thread no longer waits on: another step, a discard or a close took its
    /// place (`staleStep`).
    pub(crate) fn stale_step(&self, notice: &Notice) -> bool {
        let Some(at) = notice.landing_at else {
            return false;
        };
        match self
            .registry()
            .get(&notice.about)
            .and_then(|run| run.landing)
        {
            Some(landing) => {
                landing.at != at || landing.sent == Some(true) || landing.error.is_some()
            }
            None => true,
        }
    }

    /// Merge steps the person pressed that are neither sent nor queued, queued in the order pressed
    /// (the constructor's migration of unsent steps): saved before the outbox, or the server stopped
    /// between saving one and queuing it. A delivered step is marked sent before it leaves the
    /// outbox. The branch is the one the thread recorded: the constructor does not wait for git,
    /// and `base_branch_of` falls back to main as well.
    pub(crate) fn restore_landing_steps(&self) {
        let queued = self.inner.outbox.pending();
        let mut unsent: Vec<AgentRun> = self
            .registry()
            .all()
            .into_iter()
            .filter(|run| {
                run.replaced_by.is_none()
                    && run.landing.as_ref().is_some_and(|step| {
                        step.sent != Some(true)
                            && no_error(step)
                            && is_coordinator_step(step.action)
                    })
                    && given(run.branch.as_deref()).is_some()
                    && !queued
                        .iter()
                        .any(|notice| notice.about == run.id && notice.slot == LANDING_SLOT)
            })
            .collect();
        unsent.sort_by_key(|run| run.landing.as_ref().map_or(0, |step| step.at));
        for run in unsent {
            let Some(at) = run.landing.as_ref().map(|step| step.at) else {
                continue;
            };
            let base = run.base_branch.as_deref().unwrap_or("main");
            let put = self.inner.outbox.put(NoticeInput {
                about: run.id.clone(),
                slot: LANDING_SLOT.to_owned(),
                section: STEPS_SECTION.to_owned(),
                text: coordinator_step(&run, base),
                landing_at: Some(at),
            });
            if let Err(error) = put {
                eprintln!("herdr-fleet: the outbox file could not be written: {error}");
            }
        }
    }
}

fn run_not_found(id: &str) -> FleetError {
    FleetError::new("run_not_found", format!("Unknown fleet agent: {id}"))
}

/// A landing step for a thread's lead: what the person approved, and only that (`leadStep`,
/// agents/lead.md).
fn lead_step(
    run: &AgentRun,
    action: LandAction,
    base_branch: &str,
    comments: &[LineComment],
) -> Result<String, FleetError> {
    let branch = run.branch.as_deref().unwrap_or_default();
    let push_again = match &run.pr {
        Some(pr) if pr.state == PullRequestState::Open => {
            format!(", and push {branch} to its pull request #{}", pr.number)
        }
        _ => String::new(),
    };
    Ok(match action {
        LandAction::Pr => format!(
            "[fleet] The person pressed Create PR on the Fleet screen: they approve pushing {branch} to origin and opening a pull request from it against {base_branch}. Commit what is left, push the branch (never force), and open the pull request with gh pr create, its title and body written from this thread's work in the repository's style. Do not merge it. Put the pull request's URL in your HANDOFF."
        ),
        LandAction::Update => format!(
            "[fleet] The person pressed Update branch on the Fleet screen: {base_branch} has commits {branch} does not. Merge {base_branch} into {branch}, resolve any conflicts, run the verification again and commit{push_again}."
        ),
        LandAction::FixCi => {
            let number = pr_number(run);
            let failing = match run.pr.as_ref().and_then(|pr| pr.failing.as_deref()) {
                Some(failing) if !failing.is_empty() => format!(" ({})", failing.join(", ")),
                _ => String::new(),
            };
            let push = if push_again.is_empty() {
                format!(", and push {branch} to its pull request")
            } else {
                push_again
            };
            format!(
                "[fleet] The person pressed Fix CI on the Fleet screen: checks failed on pull request #{number}{failing}. Read their logs (gh pr checks {number}, gh run view --log-failed), fix the cause, commit{push}."
            )
        }
        LandAction::Comments => {
            let mut lines = vec![
                "[fleet] The person reviewed this thread's change on the Fleet screen and left these comments:".to_owned(),
            ];
            for comment in comments {
                // JavaScript's text.replace(/\s+/g, " ").trim()
                let text: Vec<&str> = comment
                    .text
                    .split(js::is_whitespace)
                    .filter(|part| !part.is_empty())
                    .collect();
                let removed = if comment.removed == Some(true) {
                    " (a removed line)"
                } else {
                    ""
                };
                lines.push(format!(
                    "- {}:{}{removed} — {}",
                    comment.file,
                    comment.line,
                    text.join(" ")
                ));
            }
            lines.push(format!(
                "Address each one and commit{push_again}. Where you disagree, say why in your HANDOFF instead of changing the code."
            ));
            lines.join("\n")
        }
        LandAction::Merge | LandAction::MergePr | LandAction::Discard => {
            return Err(FleetError::new(
                "invalid_action",
                format!("{} is not a step for a thread's lead.", action_name(action)),
            ));
        }
    })
}

/// A merge for the project's coordinator, on the main checkout it sits on (`coordinatorStep`,
/// agents/coordinator.md).
fn coordinator_step(run: &AgentRun, base_branch: &str) -> String {
    let thread = thread_label(run);
    if run
        .landing
        .as_ref()
        .is_some_and(|step| step.action == LandAction::MergePr)
    {
        format!(
            "Merge PR for thread {thread}: gh pr merge {} --merge. Then, when this checkout is clean and on {base_branch}, bring it up to date with git pull --ff-only.",
            pr_number(run)
        )
    } else {
        let branch = run.branch.as_deref().unwrap_or_default();
        format!(
            "Merge into {base_branch} for thread {thread}: when this checkout is clean and on {base_branch}, git merge --no-ff {branch}. On a conflict, git merge --abort and tell the person."
        )
    }
}

/// git and GitHub as they are: `thread`'s functions and `gh` (`LANDING_TOOLS`). It writes nothing
/// to GitHub: [`GitHub`] only reads.
#[allow(
    dead_code,
    reason = "the core builds it (LIVE, #270); `pub use landing::GitLanding` waits for #265's fleet/mod.rs (ADR 0266-landing)"
)]
#[derive(Debug, Clone)]
pub struct GitLanding {
    github: GitHub,
}

#[allow(
    dead_code,
    reason = "the core builds it (LIVE, #270); `pub use landing::GitLanding` waits for #265's fleet/mod.rs (ADR 0266-landing)"
)]
impl GitLanding {
    /// git, and `gh` as the server's `PATH` finds it.
    pub fn new() -> Self {
        Self::with_github(GitHub::new())
    }

    /// git, and GitHub through `github`.
    pub fn with_github(github: GitHub) -> Self {
        GitLanding { github }
    }
}

impl Default for GitLanding {
    fn default() -> Self {
        Self::new()
    }
}

impl LandingTools for GitLanding {
    fn git_root<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<PathBuf>> {
        Box::pin(thread::git_root(cwd))
    }
    fn git_head<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<String>> {
        Box::pin(thread::git_head(cwd))
    }
    fn diff_stat<'a>(&'a self, cwd: &'a Path, base: &'a str) -> BoxFuture<'a, Option<DiffStat>> {
        Box::pin(thread::diff_stat(cwd, base))
    }
    fn exclude_worktrees<'a>(&'a self, repo: &'a Path) -> BoxFuture<'a, std::io::Result<()>> {
        Box::pin(thread::exclude_worktrees(repo))
    }
    fn run_setup<'a>(
        &'a self,
        cwd: &'a Path,
        command: &'a str,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, SetupOutcome> {
        Box::pin(thread::run_setup(cwd, command, cancel))
    }
    fn git_branch<'a>(&'a self, repo: &'a Path) -> BoxFuture<'a, Option<String>> {
        Box::pin(thread::git_branch(repo))
    }
    fn branch_state<'a>(
        &'a self,
        cwd: &'a Path,
        base: &'a str,
    ) -> BoxFuture<'a, Option<BranchState>> {
        Box::pin(thread::branch_state(cwd, base))
    }
    fn diff_text<'a>(&'a self, cwd: &'a Path, base: &'a str) -> BoxFuture<'a, Option<DiffText>> {
        Box::pin(thread::diff_text(cwd, base))
    }
    fn branch_head<'a>(&'a self, repo: &'a Path, branch: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(thread::branch_head(repo, branch))
    }
    fn is_merged<'a>(
        &'a self,
        repo: &'a Path,
        branch: &'a str,
        into: &'a str,
    ) -> BoxFuture<'a, bool> {
        Box::pin(thread::is_merged(repo, branch, into))
    }
    fn remove_thread<'a>(
        &'a self,
        repo: &'a Path,
        worktree: &'a Path,
        branch: &'a str,
        options: RemoveOptions,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(thread::remove_thread(repo, worktree, branch, options))
    }
    fn read_pull_request<'a>(
        &'a self,
        repo: &'a Path,
        branch: &'a str,
    ) -> BoxFuture<'a, Result<Option<PullRequestReading>, GhError>> {
        Box::pin(self.github.read_pull_request(repo, branch))
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::Command;

    use super::{GitLanding, LandingTools};
    use crate::github::GitHub;

    /// A folder of its own under the system's temporary folder, removed when dropped.
    struct Folder(std::path::PathBuf);

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // The real tools reach git and gh: a fresh repository on a branch named here, and a gh that
    // is not there. The values are git's own answers for `git init -b trunk`.
    #[tokio::test]
    async fn the_real_tools_read_git_and_ask_gh() {
        let folder = Folder(std::env::temp_dir().join(format!(
            "fleet-landing-{}-{}",
            std::process::id(),
            line!()
        )));
        std::fs::create_dir_all(&folder.0).unwrap();
        let repo = folder.0.canonicalize().unwrap();
        let init = Command::new("git")
            .args(["init", "-q", "-b", "trunk"])
            .current_dir(&repo)
            .env_remove("GIT_DIR")
            .status()
            .unwrap();
        assert!(init.success());
        let tools = GitLanding::with_github(GitHub::with_program("/nonexistent/gh"));
        assert_eq!(tools.git_root(&repo).await.as_deref(), Some(repo.as_path()));
        assert_eq!(tools.git_branch(&repo).await.as_deref(), Some("trunk"));
        assert!(!tools.is_merged(&repo, "trunk", "other").await);
        assert!(tools.read_pull_request(&repo, "trunk").await.is_err());
        assert_eq!(tools.git_root(Path::new("/")).await, None);
    }
}
