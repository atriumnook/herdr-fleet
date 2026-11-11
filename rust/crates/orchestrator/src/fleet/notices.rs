//! The fleet's notices to a thread's coordinator: the threads' questions and news, and the landing
//! steps the person pressed, kept in the outbox (L5) and delivered in one message once the
//! coordinator is free; `coordinatorOf`, `tellCoordinator`, `queueNews`, `hearerOf`, `notifyNow`,
//! `typed`, `deliverNotices`, `hasDraft`, `retryNotices` and the notices' texts (`threadLabel`,
//! `threadTurnEnded`, `threadQuestion`, the headers) of `server/fleet/orchestrator.ts`.
//!
//! What the other clusters use (ADR 0264-notices): `queue_turn_news`, which #266's
//! `settle_thread_turn` calls once the run holds what the news quotes; `queue_news`, `notify_now`,
//! `typed`, `start_delivering`, `thread_label` and the headers, for the plans (#265), landing (#266)
//! and the supervision (#268).

use std::collections::{HashMap, HashSet};
use std::io;

use protocol::{
    AgentRun, AgentState, ContractState, Landed, PullRequestState, ReportState, TurnOutcome, js,
    outcome_line, plan_open,
};
use tokio_util::sync::CancellationToken;

use super::{BoxFuture, Orchestrator, OrchestratorError, TimerKind, is_completed, is_live, locked};
use crate::config::FleetConfig;
use crate::outbox::{Notice, NoticeInput};

/// How the coordinator hears the threads' questions.
pub(crate) const QUESTIONS_HEADER: &str =
    "[fleet] Threads ask the person. These come from the fleet, not from the person.";
/// A project run without the person: its coordinator hears every turn a thread ends.
pub(crate) const NEWS_HEADER: &str =
    "[fleet] Threads ended a turn. These come from the fleet, not from the person.";
/// How the coordinator hears the landing steps the person pressed.
pub(crate) const STEPS_HEADER: &str = "[fleet] The person pressed these on the Fleet screen. Each is the person's approval for that step only.";
/// The longest HANDOFF a question carries to the coordinator, in UTF-16 code units as JavaScript
/// counts them; the rest stays in the result file.
pub(crate) const QUESTION_MAX_CHARS: usize = 4000;

/// The outbox's slot and section of a thread's news.
const NEWS: &str = "news";

/// What the notices keep while this server runs: the coordinators a delivery is under way to
/// (`delivering`). The draft retries are timers (`TimerKind::DraftRetry`).
#[derive(Debug, Default)]
pub(crate) struct State {
    delivering: HashSet<String>,
}

/// A delivery to one coordinator under way: no other starts until this is dropped. Each message
/// reaches the coordinator's pane alone (#264's acceptance).
pub(crate) struct Delivering<'a> {
    fleet: &'a Orchestrator,
    coordinator: String,
}

impl Drop for Delivering<'_> {
    fn drop(&mut self) {
        locked(&self.fleet.inner.notices)
            .delivering
            .remove(&self.coordinator);
    }
}

impl Orchestrator {
    /// The delivery to `coordinator` as this caller's, or none while another is under way. The
    /// check and the claim are one step under the notices' lock.
    pub(crate) fn start_delivering(&self, coordinator: &str) -> Option<Delivering<'_>> {
        locked(&self.inner.notices)
            .delivering
            .insert(coordinator.to_owned())
            .then(|| Delivering {
                fleet: self,
                coordinator: coordinator.to_owned(),
            })
    }

    /// Who hears a thread's questions: the run that started it while it lives, else the project's
    /// live coordinator (`coordinatorOf`).
    fn coordinator_of(&self, thread: &AgentRun) -> Option<AgentRun> {
        if let Some(owner) = thread
            .owner
            .as_deref()
            .and_then(|owner| self.registry().get(owner))
            .filter(is_live)
        {
            return Some(owner);
        }
        self.project_coordinator(thread.project.as_deref()?)
    }

    /// The thread `thread`'s notices to whoever hears it now (`tellCoordinator`).
    pub(crate) async fn tell_coordinator(&self, thread: &str) {
        let Some(coordinator) = self
            .registry()
            .get(thread)
            .and_then(|thread| self.coordinator_of(&thread))
        else {
            return;
        };
        self.deliver_notices(&coordinator.id).await;
    }

    /// A thread's news for whoever hears it, kept until it went; none (or an empty text) takes
    /// back the news not yet sent (`queueNews`). An outbox file that cannot be written is logged:
    /// the hooks that queue news return nothing, and the news then is not kept (ADR 0264-notices).
    pub(crate) fn queue_news(&self, thread: &str, text: Option<String>) {
        log_unwritten("outbox", self.put_news(thread, text));
    }

    /// `queue_news`, with the outbox file's error handed back.
    fn put_news(&self, thread: &str, text: Option<String>) -> io::Result<()> {
        match text.filter(|text| !text.is_empty()) {
            Some(text) => self
                .inner
                .outbox
                .put(NoticeInput {
                    about: thread.to_owned(),
                    slot: NEWS.to_owned(),
                    section: NEWS.to_owned(),
                    text,
                    landing_at: None,
                })
                .map(|_| ()),
            None => self.inner.outbox.discard(thread, NEWS),
        }
    }

    /// What the coordinator hears of the thread `id`'s settled turn: its question, or, in a
    /// project run without the person, how the turn ended, with why the thread could not start
    /// again when it could not (`settleThreadTurn`'s news). The run is read again here, after what
    /// #266's `settle_thread_turn` saved before this call (ADR 0264-notices).
    pub(crate) fn queue_turn_news(
        &self,
        id: &str,
        config: &FleetConfig,
        restart_error: Option<&str>,
    ) {
        let Some(run) = self.registry().get(id) else {
            return;
        };
        let news =
            thread_question(&run).or_else(|| config.autonomous.then(|| thread_turn_ended(&run)));
        let news = match (news, restart_error.filter(|error| !error.is_empty())) {
            (Some(news), Some(error)) => Some(format!(
                "{news}\n  The fleet could not start the thread again on another CLI: {error}"
            )),
            (news, _) => news,
        };
        self.queue_news(id, news);
    }

    /// Who hears a queued notice now: a merge step the project's coordinator, news whoever hears
    /// the thread (`hearerOf`).
    fn hearer_of(&self, notice: &Notice) -> Option<AgentRun> {
        let about = self.registry().get(&notice.about)?;
        if notice.section == "steps" {
            self.project_coordinator(about.project.as_deref()?)
        } else {
            self.coordinator_of(&about)
        }
    }

    /// `text` to the run `id` now, written to the outbox before it is typed: the run as submit
    /// left it (`notifyNow`). An error says the outbox file did not take it (it then is not sent),
    /// or what `submit` refused.
    #[allow(
        dead_code,
        reason = "#265's plan answers, #266's lead steps and #268's standstill call send through it"
    )]
    pub(crate) async fn notify_now(
        &self,
        id: &str,
        text: &str,
        cancel: &CancellationToken,
    ) -> Result<AgentRun, OrchestratorError> {
        self.inner
            .outbox
            .send_now(id, text, |each| async move {
                self.submit(id, &each, cancel).await
            })
            .await?
    }

    /// The text reached the run `id`: its turn runs, or waits on an approval screen the text
    /// brought up (`typed`).
    pub(crate) fn typed(&self, id: &str, sent: &AgentRun) -> bool {
        sent.state == AgentState::Working
            || (sent.state == AgentState::Blocked && self.turn_in_flight(id))
    }

    /// Every notice waiting for `coordinator`, in one message, once it is free: no turn of the
    /// fleet's in flight, herdr calls it settled (a person's turn shows as working), and no draft of
    /// the person's in its input. A coordinator that is not free hears them when it settles, or a
    /// little later when the person left a draft; one that ended leaves them to the next
    /// (`deliverNotices`).
    pub(crate) async fn deliver_notices(&self, coordinator: &str) {
        let Some(_delivering) = self.start_delivering(coordinator) else {
            return;
        };
        let Some(run) = self.registry().get(coordinator) else {
            return;
        };
        if self.due_to(coordinator).is_empty() || self.turn_in_flight(coordinator) || !is_live(&run)
        {
            return;
        }
        self.inner
            .reconcile_locks
            .wait_idle(&coordinator.to_owned())
            .await;
        let live = self.live_state(coordinator).await;
        if !live.is_some_and(is_completed) || self.turn_in_flight(coordinator) {
            return;
        }
        if self.has_draft(coordinator).await {
            self.retry_notices(coordinator);
            return;
        }
        // read again after the waits: the person may have thrown a thread away meanwhile
        let notices = self.due_to(coordinator);
        let news = if self.config(&run.cwd).autonomous {
            NEWS_HEADER
        } else {
            QUESTIONS_HEADER
        };
        let headers = HashMap::from([(NEWS, news), ("steps", STEPS_HEADER)]);
        let due = &notices;
        let delivered = self
            .inner
            .outbox
            .deliver(&notices, &headers, |text| async move {
                // a turn sent since the checks above (a landing step, the person's send) goes
                // first: the check and the new turn are one step, and the notices wait for the
                // coordinator's next settlement
                let sent = match self
                    .submit_when_free(coordinator, &text, &CancellationToken::new())
                    .await
                {
                    Ok(sent) => sent,
                    Err(error) => {
                        if error.code() != "run_busy" {
                            eprintln!(
                                "herdr-fleet: the notices could not be sent to {coordinator}: {error}"
                            );
                        }
                        return false;
                    }
                };
                if !self.typed(coordinator, &sent) {
                    return false;
                }
                self.mark_steps_sent(due);
                true
            })
            .await;
        log_unwritten("outbox", delivered.map(|_| ()));
    }

    /// The queued notices `coordinator` hears now, in the order written; the merge steps no thread
    /// waits on any more leave the outbox first.
    fn due_to(&self, coordinator: &str) -> Vec<Notice> {
        let outbox = &self.inner.outbox;
        // the steps and the hearers are read from the registry outside the outbox's lock
        let stale: HashSet<u64> = outbox
            .pending()
            .into_iter()
            .filter(|notice| self.stale_step(notice))
            .map(|notice| notice.seq)
            .collect();
        if !stale.is_empty() {
            log_unwritten(
                "outbox",
                outbox.prune(|notice| !stale.contains(&notice.seq)),
            );
        }
        outbox
            .pending()
            .into_iter()
            .filter(|notice| {
                self.hearer_of(notice)
                    .is_some_and(|hearer| hearer.id == coordinator)
            })
            .collect()
    }

    /// The landing steps of `notices` marked sent before they leave the outbox, on the run that
    /// holds each now (a thread that started again while this was typed moved its step to the new
    /// lead): a restart in between finds them sent.
    fn mark_steps_sent(&self, notices: &[Notice]) {
        let holders: HashMap<u64, String> = self
            .inner
            .outbox
            .pending()
            .into_iter()
            .map(|notice| (notice.seq, notice.about))
            .collect();
        for notice in notices {
            let Some(at) = notice.landing_at else {
                continue;
            };
            let holder = holders.get(&notice.seq).unwrap_or(&notice.about);
            let waits = self
                .registry()
                .get(holder)
                .and_then(|run| run.landing)
                .is_some_and(|landing| landing.at == at);
            if waits {
                self.change(holder, |run| {
                    if let Some(landing) = run.landing.as_mut().filter(|landing| landing.at == at) {
                        landing.sent = Some(true);
                    }
                });
            }
        }
    }

    /// The person is writing in the run's input: what the fleet typed would join their draft
    /// (`hasDraft`, the adapter's `draft` on the screen read with colors).
    async fn has_draft(&self, id: &str) -> bool {
        let Some(run) = self.registry().get(id) else {
            return false;
        };
        let Some(draft) = screen::screen_checks(run.agent).draft else {
            return false;
        };
        let screen = self
            .deps()
            .runtime
            .screen(&run.herdr_name)
            .await
            .unwrap_or_default();
        draft(&screen)
    }

    /// The notices to `coordinator` tried again a little later, once (`retryNotices`).
    fn retry_notices(&self, coordinator: &str) {
        if self.inner.timers.has(TimerKind::DraftRetry, coordinator) {
            return;
        }
        // boxed, so the delivery's type does not depend on the retry it may set
        let retry: BoxFuture<'static, ()> = {
            let (fleet, id) = (self.clone(), coordinator.to_owned());
            Box::pin(async move {
                if !fleet.is_stopped() {
                    fleet.deliver_notices(&id).await;
                }
            })
        };
        self.inner.timers.set(
            TimerKind::DraftRetry,
            coordinator,
            self.deps().timings.draft_retry,
            retry,
        );
    }

    /// A thread's news kept on its run by a server from before the outbox, queued as a notice
    /// (the constructor's migration of `run.notice`). The run is written back without it, as
    /// TypeScript's `upsert`: nothing about it changed that a listener hears of. A notice the outbox
    /// file did not take stays on the run for the next start, as TypeScript's throw left it.
    pub(crate) fn restore_notices(&self) {
        for run in self.registry().all() {
            let Some(notice) = run.notice else {
                continue;
            };
            let queued = self.put_news(&run.id, Some(notice));
            if queued.is_err() {
                log_unwritten("outbox", queued);
                continue;
            }
            log_unwritten(
                "runs",
                self.registry()
                    .update(&run.id, |run| run.notice = None)
                    .map(|_| ()),
            );
        }
    }
}

/// A file of the server's own that could not be written, logged: the hooks that write it return
/// nothing (ADR 0264-notices).
fn log_unwritten(file: &str, written: io::Result<()>) {
    if let Err(error) = written {
        eprintln!("herdr-fleet: the {file} file could not be written: {error}");
    }
}

/// A thread as its coordinator reads it: its title, id and branch (`threadLabel`).
pub(crate) fn thread_label(run: &AgentRun) -> String {
    match run.branch.as_deref().filter(|branch| !branch.is_empty()) {
        Some(branch) => format!("\"{}\" ({}, {branch})", run.name, run.id),
        None => format!("\"{}\" ({})", run.name, run.id),
    }
}

/// A thread's settled turn that asks nothing, as the coordinator of a project run without the
/// person hears it: its report and contract, or how the turn failed, and where the rest is
/// (`threadTurnEnded`).
pub(crate) fn thread_turn_ended(run: &AgentRun) -> String {
    let status = if run.state == AgentState::Failed {
        format!(
            "failed — {}",
            run.last_error.as_deref().unwrap_or("the turn failed")
        )
    } else {
        run.outcome
            .as_ref()
            .map_or_else(|| "no report".to_owned(), outcome_line)
    };
    let contract = match run.contract.as_deref() {
        Some(items) if !items.is_empty() => {
            let marks: Vec<String> = items
                .iter()
                .map(|item| {
                    let mark = match item.state {
                        ContractState::Met => "✓",
                        ContractState::Unmet => "✗",
                        ContractState::Open => "…",
                    };
                    format!("{} {mark}", item.id)
                })
                .collect();
            format!("\n  Contract: {}", marks.join(" "))
        }
        _ => String::new(),
    };
    let pr = run.pr.as_ref().map_or_else(String::new, |pr| {
        let state = match pr.state {
            PullRequestState::Open => "OPEN",
            PullRequestState::Merged => "MERGED",
            PullRequestState::Closed => "CLOSED",
        };
        let closed = if run.landed == Some(Landed::Merged) {
            ", and the thread is closed"
        } else {
            ""
        };
        format!("\n  Pull request #{}: {state}{closed}", pr.number)
    });
    format!(
        "{} ended its turn: {status}{contract}{pr}",
        thread_label(run)
    )
}

/// A thread's settled turn whose report asks the person something (blocked, or a human_action),
/// as its coordinator hears it: the question, and the whole HANDOFF, which holds the options and
/// what the lead and the architect make of it. Every other outcome reaches the person on the
/// thread list and in push notifications (`threadQuestion`).
pub(crate) fn thread_question(run: &AgentRun) -> Option<String> {
    let Some(TurnOutcome::Report(report)) = &run.outcome else {
        return None;
    };
    if run.state == AgentState::Failed
        || (report.state != ReportState::Blocked && report.human_action.is_none())
    {
        return None;
    }
    let result = run.result.as_deref().unwrap_or("");
    let handoff = if js::utf16_len(result) > QUESTION_MAX_CHARS {
        format!(
            "{}\n[cut at {QUESTION_MAX_CHARS} characters]",
            js::cut_utf16(result, QUESTION_MAX_CHARS)
        )
    } else {
        result.to_owned()
    };
    let plan = match &run.plan {
        Some(plan) if plan_open(plan.answered_at, plan.closed_at) => format!(
            "\nIts plan (version {}, {} decision{}) waits for the person in the thread's Plan tab on the Fleet screen: point them there, and do not answer it yourself.",
            plan.version,
            plan.asks,
            if plan.asks == 1 { "" } else { "s" }
        ),
        _ => String::new(),
    };
    let quoted = if handoff.is_empty() {
        String::new()
    } else {
        let lines: Vec<String> = handoff
            .split('\n')
            .map(|line| format!("  {line}"))
            .collect();
        format!("\n{}", lines.join("\n"))
    };
    let question = report.human_action.as_deref().unwrap_or(&report.summary);
    Some(format!(
        "{} asks the person: {question}{quoted}{plan}",
        thread_label(run)
    ))
}
