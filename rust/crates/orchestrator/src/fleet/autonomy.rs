//! The projects run without the person (fleet.json's `autonomous`): the standstill call, the
//! threads closed against GitHub, and what a merge read without the person does; `superviseProjects`,
//! `reconcileThread`, `callStandstill`, `tellWhenFree` and the notices' texts (`threadMerged`,
//! `standstill`, `threadClosedAfterMerge`) of `server/fleet/orchestrator.ts`.
//!
//! Where it differs from TypeScript (ADR 0268-autonomy): a lead that reports it goes on keeps its
//! merged thread open (main's #176's 1); what the supervision tells a coordinator of a merge goes in
//! a slot of its own beside the thread's news (#176's 2); the threads of a project whose coordinator
//! ended are looked after too (#176's 3); and the standstill call claims the coordinator's delivery
//! and sends only while no turn of the fleet's is in flight (#176's 5). The anomaly notice
//! (`checkAnomalies`, #189's 3) is gone from TypeScript: a thread whose lead fails starts again
//! instead (#267).

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use protocol::{AgentRun, AgentState, PullRequestState, ReportState, TurnOutcome};
use tokio_util::sync::CancellationToken;

use super::notices::thread_label;
use super::{
    BoxFuture, Orchestrator, PROJECT_ROLE, is_completed, is_live, is_thread, locked, state_name,
};
use crate::events::{FleetEvent, ReconciledEvent, StandstillEvent};
use crate::github::PullRequestReading;
use crate::outbox::NoticeInput;

/// The outbox slot of what the supervision tells a coordinator of a thread's merge. It lies beside
/// the thread's news (`news`) in the same section, so neither takes the other's place (#176's 2),
/// and both go out in one message under the news header.
const MERGE_SLOT: &str = "merge";
/// The section the threads' news goes under (`notices.rs`).
const NEWS_SECTION: &str = "news";

/// What the supervision keeps while this server runs: per project coordinator, since when it and
/// its threads stand still and whether it heard of that (`quietSince`, `andonSent`); per thread,
/// since when its fleet is settled and when GitHub was last asked about it (`settledSince`,
/// `reconciledAt`); and the threads whose merge the coordinator was told of.
#[derive(Debug, Default)]
pub(crate) struct State {
    quiet_since: HashMap<String, i64>,
    andon_sent: HashSet<String>,
    settled_since: HashMap<String, i64>,
    reconciled_at: HashMap<String, i64>,
    merge_told: HashSet<String>,
}

/// Where a merge of a thread's pull request was read in a project run without the person.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeSeen {
    /// in the settlement of a turn of a thread with a pull request recorded (`settleThreadTurn`):
    /// the turn's news follows, and quotes the pull request and whether the thread closed
    TurnEnded,
    /// outside a settlement, with no news of a turn after it: by the polling of the open pull
    /// requests (`refreshPullRequests`), or by the read after a turn of a thread with no pull
    /// request recorded, once that turn's news was queued (#176's 7, ADR 0266-landing)
    Polled,
}

impl Orchestrator {
    /// A thread's pull request read merged in a project run without the person: whether the thread
    /// closes, waits, and what its coordinator hears (ADR 0268-autonomy). #266 calls it from both
    /// places a merge is read; `settle_thread_turn` awaits it before it writes the coordinator's
    /// news.
    ///
    /// - `TurnEnded`: the thread closes, as TypeScript closed it, unless the lead's report says it
    ///   goes on (progress or waiting): a lead that merged and broke off its turn to wait for a
    ///   helper has its issue to close yet (#176's 1). The turn's news tells the coordinator.
    /// - `Polled`: the thread stays open for its lead to finish, and the coordinator hears of the
    ///   merge once (`threadMerged`), as TypeScript did; unless nothing in the thread is at work and
    ///   the lead's last turn ended with a report that says it finished (ready or dropped), when the
    ///   thread closes and the coordinator hears so. That is where TypeScript closed a thread whose
    ///   lead opened and merged its pull request in one turn, which #266 now reads after the turn.
    pub(crate) async fn merged_without_person(
        &self,
        thread: &str,
        reading: &PullRequestReading,
        seen: MergeSeen,
    ) {
        let Some(run) = self.registry().get(thread) else {
            return;
        };
        match seen {
            MergeSeen::TurnEnded => {
                // the turn's news says it all: a merge notice not heard yet would say it twice
                locked(&self.inner.autonomy)
                    .merge_told
                    .insert(super::thread_id(&run).to_owned());
                log_unwritten(self.inner.outbox.discard(thread, MERGE_SLOT));
                if run.landed.is_none() && !goes_on(&run) {
                    self.merged_on_github(thread, reading).await;
                }
            }
            MergeSeen::Polled => {
                let closed = self
                    .on_lead(thread, |lead| async move {
                        if self.fleet_at_work(&lead.group) || !finished(&lead) {
                            return None;
                        }
                        self.merged_on_github(&lead.id, reading).await;
                        self.registry().get(&lead.id)
                    })
                    .await
                    .flatten();
                let (about, text) = match closed {
                    Some(closed) => (closed.id.clone(), thread_closed_on_merge(&closed)),
                    None => {
                        let Ok(lead) = self.get(thread, None) else {
                            return;
                        };
                        let first = locked(&self.inner.autonomy)
                            .merge_told
                            .insert(super::thread_id(&lead).to_owned());
                        if lead.landed.is_some() || !first {
                            return;
                        }
                        (lead.id.clone(), thread_merged(&lead))
                    }
                };
                self.queue_merge(&about, text);
                self.spawn_tell(&about);
            }
        }
    }

    /// The projects run without the person, looked after (the server calls this after
    /// `refresh_pull_requests`; `superviseProjects`). Two things only the person noticed before:
    ///
    /// - the fleet's records against GitHub: a thread whose pull request GitHub shows merged, while
    ///   nothing in its fleet moved through the quiet period, is closed and its coordinator told. A
    ///   merge seen at once may come from a lead that broke off its turn to wait, and goes on after
    ///   it. This holds for every thread of such a project, whether its coordinator still lives or
    ///   not (#176's 3): the news then waits in the outbox for the project's next coordinator.
    /// - a standstill: when the coordinator and every run of its threads stayed settled through the
    ///   quiet period, the coordinator hears of it once, with where each thread stands. It hears
    ///   again only after a thread moved: its own answer is no reason, so a project where everything
    ///   left is blocked or done is not called on and on.
    ///
    /// It asks GitHub nothing about a thread more often than once per quiet period, and herdr
    /// nothing but the state and screen of a coordinator it is about to call (#189's 3).
    pub async fn supervise_projects(&self) {
        let now = self.now();
        let threads: Vec<AgentRun> = self
            .list(None)
            .into_iter()
            .filter(|run| {
                is_thread(run)
                    && is_live(run)
                    && run.landed.is_none()
                    && self.config(&run.cwd).autonomous
            })
            .collect();
        // the projects where a thread closed just now: their coordinators are about to hear of it
        let mut closed_in = HashSet::new();
        for thread in &threads {
            if self.reconcile_thread(thread, now).await
                && let Some(project) = &thread.project
            {
                closed_in.insert(project.clone());
            }
        }
        let coordinators: Vec<AgentRun> = self
            .list(None)
            .into_iter()
            .filter(|run| run.role == PROJECT_ROLE && run.project.is_some() && is_live(run))
            .collect();
        for coordinator in coordinators {
            if !self.config(&coordinator.cwd).autonomous {
                continue;
            }
            let project = coordinator.project.clone().unwrap_or_default();
            let quiet = self.quiet_ms();
            if closed_in.contains(&project) {
                locked(&self.inner.autonomy)
                    .quiet_since
                    .insert(coordinator.id.clone(), now);
                continue;
            }
            let open: Vec<AgentRun> = self
                .list(None)
                .into_iter()
                .filter(|run| {
                    is_thread(run)
                        && run.project.as_deref() == Some(project.as_str())
                        && is_live(run)
                        && run.landed.is_none()
                })
                .collect();
            let groups: HashSet<&str> = std::iter::once(coordinator.group.as_str())
                .chain(open.iter().map(|run| run.group.as_str()))
                .collect();
            let members: Vec<(bool, bool)> = self
                .list(None)
                .iter()
                .filter(|run| groups.contains(run.group.as_str()) && is_live(run))
                .map(|run| (run.id == coordinator.id, self.at_work(run)))
                .collect();
            let since = {
                let mut state = locked(&self.inner.autonomy);
                if members.iter().any(|&(own, moving)| !own && moving) {
                    state.andon_sent.remove(&coordinator.id);
                }
                if members.iter().any(|&(_, moving)| moving) {
                    state.quiet_since.insert(coordinator.id.clone(), now);
                    continue;
                }
                let Some(&since) = state.quiet_since.get(&coordinator.id) else {
                    state.quiet_since.insert(coordinator.id.clone(), now);
                    continue;
                };
                if now - since < quiet || state.andon_sent.contains(&coordinator.id) {
                    continue;
                }
                since
            };
            let quiet_for = now - since;
            if self
                .call_standstill(&coordinator.id, &open, quiet_for)
                .await
            {
                locked(&self.inner.autonomy)
                    .andon_sent
                    .insert(coordinator.id.clone());
                self.event(FleetEvent::Standstill(StandstillEvent {
                    run: coordinator.id.clone(),
                    project,
                    quiet_ms: quiet_for,
                }));
            }
        }
    }

    /// A settled thread's pull request, read once per quiet period: merged on GitHub, the thread
    /// closes and its coordinator hears so (`reconcileThread`). The thread is settled while no run
    /// of its fleet is at work: a lead waiting for a helper that still works has its issue to close
    /// yet (#176's 1). True when the thread closed.
    async fn reconcile_thread(&self, thread: &AgentRun, now: i64) -> bool {
        let quiet = self.quiet_ms();
        let at_work = self.fleet_at_work(&thread.group);
        let since = {
            let mut state = locked(&self.inner.autonomy);
            if at_work {
                state.settled_since.remove(&thread.id);
                return false;
            }
            let Some(&since) = state.settled_since.get(&thread.id) else {
                state.settled_since.insert(thread.id.clone(), now);
                return false;
            };
            let asked = state.reconciled_at.get(&thread.id).copied().unwrap_or(0);
            if now - since < quiet || now - asked < quiet {
                return false;
            }
            state.reconciled_at.insert(thread.id.clone(), now);
            since
        };
        // GitHub could not be asked: the next quiet period asks again
        let Ok(Some(reading)) = self.read_pull_request(&thread.id).await else {
            return false;
        };
        if reading.pr.state != PullRequestState::Merged {
            return false;
        }
        let reading = &reading;
        let closed = self
            .on_lead(&thread.id, |lead| async move {
                if self.fleet_at_work(&lead.group) {
                    return None;
                }
                self.merged_on_github(&lead.id, reading).await;
                self.registry().get(&lead.id)
            })
            .await
            .flatten();
        let Some(closed) = closed else {
            return false;
        };
        locked(&self.inner.autonomy)
            .merge_told
            .insert(super::thread_id(&closed).to_owned());
        self.event(FleetEvent::Reconciled(ReconciledEvent {
            run: closed.id.clone(),
            project: closed.project.clone().unwrap_or_default(),
            pr: closed.pr.as_ref().map(|pr| pr.number),
        }));
        self.queue_merge(&closed.id, thread_closed_after_merge(&closed, now - since));
        self.spawn_tell(&closed.id);
        true
    }

    /// The coordinator, free, hears that its project stands still; false when it could not be told
    /// now (`callStandstill`).
    async fn call_standstill(
        &self,
        coordinator: &str,
        threads: &[AgentRun],
        quiet_for: i64,
    ) -> bool {
        self.tell_when_free(coordinator, &standstill(threads, quiet_for))
            .await
    }

    /// `text` to the coordinator when it is free: no other delivery to it under way, no turn of the
    /// fleet's in flight, herdr calls it settled, and no draft of the person's in its input; false
    /// when it is not (`tellWhenFree`). It claims the coordinator's delivery for its whole length,
    /// and sends with `submit_when_free`, which looks for a turn sent during the awaits before it
    /// under the turns' lock: one message reaches the coordinator's pane at a time (#176's 5).
    async fn tell_when_free(&self, coordinator: &str, text: &str) -> bool {
        let Some(_delivering) = self.start_delivering(coordinator) else {
            return false;
        };
        self.inner
            .reconcile_locks
            .wait_idle(&coordinator.to_owned())
            .await;
        let live = self.live_state(coordinator).await;
        if !live.is_some_and(is_completed)
            || self.turn_in_flight(coordinator)
            || self.draft_in_input(coordinator).await
        {
            return false;
        }
        // what the send came to, apart from the outbox's own writes
        let submitted = Mutex::new(None);
        let written = self
            .inner
            .outbox
            .send_now(coordinator, text, |each| {
                let submitted = &submitted;
                async move {
                    let sent = self
                        .submit_when_free(coordinator, &each, &CancellationToken::new())
                        .await;
                    *locked(submitted) = Some(sent);
                }
            })
            .await;
        log_unwritten(written);
        match submitted
            .into_inner()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
        {
            Some(Ok(sent)) => self.typed(coordinator, &sent),
            Some(Err(error)) => {
                if error.code() != "run_busy" {
                    eprintln!(
                        "herdr-fleet: the standstill call could not be sent to {coordinator}: {error}"
                    );
                }
                false
            }
            None => false,
        }
    }

    /// The person is writing in the run's input (`hasDraft`, the adapter's `draft` on the screen
    /// read with colors). `notices.rs` keeps the same check private; #340 may share it.
    async fn draft_in_input(&self, id: &str) -> bool {
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

    /// The run is at work: a turn of the fleet's in flight, or herdr shows it working or starting.
    fn at_work(&self, run: &AgentRun) -> bool {
        self.turn_in_flight(&run.id)
            || matches!(run.state, AgentState::Working | AgentState::Starting)
    }

    /// A live run of the fleet `group` is at work.
    fn fleet_at_work(&self, group: &str) -> bool {
        self.list(Some(group))
            .iter()
            .any(|run| is_live(run) && self.at_work(run))
    }

    fn quiet_ms(&self) -> i64 {
        i64::try_from(self.deps().timings.quiet.as_millis()).unwrap_or(i64::MAX)
    }

    /// What the supervision tells the coordinator of the thread `about`'s merge, in place of what it
    /// told before and not yet delivered, beside the thread's news.
    fn queue_merge(&self, about: &str, text: String) {
        log_unwritten(
            self.inner
                .outbox
                .put(NoticeInput {
                    about: about.to_owned(),
                    slot: MERGE_SLOT.to_owned(),
                    section: NEWS_SECTION.to_owned(),
                    text,
                    landing_at: None,
                })
                .map(|_| ()),
        );
    }

    /// The thread's notices to whoever hears it, in a task of its own (`void this.tellCoordinator`).
    fn spawn_tell(&self, thread: &str) {
        let (fleet, thread) = (self.clone(), thread.to_owned());
        let tell: BoxFuture<'static, ()> =
            Box::pin(async move { fleet.tell_coordinator(&thread).await });
        tokio::spawn(tell);
    }
}

/// The outbox file could not be written: logged, as the notices log it.
fn log_unwritten(written: std::io::Result<()>) {
    if let Err(error) = written {
        eprintln!("herdr-fleet: the outbox file could not be written: {error}");
    }
}

/// The state the lead's last report gave, if its last turn left one.
fn reported(run: &AgentRun) -> Option<ReportState> {
    match &run.outcome {
        Some(TurnOutcome::Report(report)) => Some(report.state),
        _ => None,
    }
}

/// The lead says it goes on: it is still at it, or waits for a helper's result or a message.
fn goes_on(run: &AgentRun) -> bool {
    matches!(
        reported(run),
        Some(ReportState::Progress | ReportState::Waiting)
    )
}

/// The lead says its task is over: done and checked, or nothing to do.
fn finished(run: &AgentRun) -> bool {
    matches!(
        reported(run),
        Some(ReportState::Ready | ReportState::Dropped)
    )
}

fn report_name(state: ReportState) -> &'static str {
    match state {
        ReportState::Progress => "progress",
        ReportState::Waiting => "waiting",
        ReportState::Ready => "ready",
        ReportState::Blocked => "blocked",
        ReportState::Failed => "failed",
        ReportState::Dropped => "dropped",
    }
}

fn pr_state_name(state: PullRequestState) -> &'static str {
    match state {
        PullRequestState::Open => "OPEN",
        PullRequestState::Merged => "MERGED",
        PullRequestState::Closed => "CLOSED",
    }
}

/// The thread's pull request number as the notices quote it, or `?` without one.
fn pr_number(run: &AgentRun) -> String {
    run.pr
        .as_ref()
        .map_or_else(|| "?".to_owned(), |pr| pr.number.to_string())
}

/// Whole minutes, rounded as JavaScript's `Math.round` rounds a time that is never negative.
fn minutes(ms: i64) -> i64 {
    (ms.max(0) + 30_000) / 60_000
}

/// A thread's pull request the polling found merged, as the coordinator of a project run without
/// the person hears it (`threadMerged`).
pub(crate) fn thread_merged(run: &AgentRun) -> String {
    format!(
        "{} merged pull request #{}; the thread closes once its lead's turn ends",
        thread_label(run),
        pr_number(run)
    )
}

/// A project run without the person that stood still, as its coordinator hears it, with where each
/// open thread stands (`standstill`).
pub(crate) fn standstill(threads: &[AgentRun], quiet_for: i64) -> String {
    let mut lines = vec![format!(
        "[fleet] Nothing in this project has moved for {} minutes: you and every thread are settled. This comes from the fleet, not from the person.",
        minutes(quiet_for)
    )];
    if threads.is_empty() {
        lines.push("- No thread is open.".to_owned());
    }
    for run in threads {
        let pr = run.pr.as_ref().map_or_else(String::new, |pr| {
            format!(", pull request #{} {}", pr.number, pr_state_name(pr.state))
        });
        lines.push(format!(
            "- {}: {}{pr}",
            thread_label(run),
            state_name(run.state)
        ));
    }
    lines.push("Check the issues and the threads: start what can start, and send a settled thread what it still has to do. When everything left is blocked or done, say so as your instructions tell you.".to_owned());
    lines.join("\n")
}

/// A thread the fleet closed against GitHub, as its coordinator hears it
/// (`threadClosedAfterMerge`).
pub(crate) fn thread_closed_after_merge(run: &AgentRun, settled_for: i64) -> String {
    format!(
        "{}: GitHub shows pull request #{} merged and its lead stayed settled {} minutes, so the fleet closed the thread. Close its issue if it is still open.",
        thread_label(run),
        pr_number(run),
        minutes(settled_for)
    )
}

/// A thread the fleet closed on a merge read after its lead's last turn ended with a report that
/// says it finished, as its coordinator hears it (ADR 0268-autonomy, decision 2).
pub(crate) fn thread_closed_on_merge(run: &AgentRun) -> String {
    format!(
        "{}: GitHub shows pull request #{} merged and its lead's last report says {}, so the fleet closed the thread. Close its issue if it is still open.",
        thread_label(run),
        pr_number(run),
        reported(run).map_or("nothing", report_name)
    )
}
