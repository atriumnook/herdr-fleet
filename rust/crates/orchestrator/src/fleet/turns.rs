//! Delegated turns: from the prompt until the turn settles, blocks or fails; `send`, `submit`,
//! `wait`, `read`, `interrupt`, `focus`, `closeDone`, the herdr events, `reconcileRun`, `finalize`
//! and `readTurn` of `server/fleet/orchestrator.ts`. The settlement is written here once and calls
//! the other clusters' hooks.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read as _};
use std::path::Path;
use std::time::Duration;

use protocol::{AgentRun, AgentState, TurnOutcome, js};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::restart::needs_restart;
use super::spawn::{RESULT_FILE, read_lines};
use super::{
    BoxFuture, Orchestrator, OrchestratorError, PROJECT_ROLE, START_GRACE_MS, TimerKind,
    UNREPORTED_CLOSE, is_completed, is_live, is_thread, locked, state_name,
};
use crate::config::FleetConfig;
use crate::error::FleetError;
use crate::events::{FleetEvent, TurnEvent, TurnReport};
use crate::report::{REPORT_FILE, read_report};
use crate::runtime::RuntimeError;

/// the most of a result file a run keeps: a handoff, not a transcript
pub const RESULT_MAX_BYTES: usize = 64 * 1024;

/// One delegated turn, from the prompt until it settles (`PendingTurn`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingTurn {
    pub armed: bool,
    /// a blocked turn was already reported to waiters; reset when it works again
    pub blocked_reported: bool,
    pub generation: u64,
    /// when the prompt was handed to herdr; none until then, and for a turn a restart took over
    pub submitted_at: Option<i64>,
    /// when a restarted server took over this turn, which it found running without knowing its
    /// submission
    pub resumed_at: Option<i64>,
    /// herdr reported `working` for this turn at least once
    pub saw_working: bool,
    /// what the fleet sent: a thread's next lead run hears it if this one fails; unknown for a turn
    /// a restart took over
    pub text: Option<String>,
}

/// What the turns keep while this server runs (`pending`, `generations`, `waiters`).
#[derive(Debug, Default)]
pub(crate) struct State {
    pending: HashMap<String, PendingTurn>,
    generations: HashMap<String, u64>,
    /// callers waiting for a run's turn to settle or block
    waiters: HashMap<String, Vec<(u64, oneshot::Sender<AgentRun>)>>,
}

/// The handoff a run's agent wrote in `file`, up to [`RESULT_MAX_BYTES`] (`readResult`). Only a
/// regular file is read, never one reached through a symlink: an agent must not turn the result
/// into a way to read other files.
pub fn read_result(file: &Path) -> Option<String> {
    let mut opened = open_no_follow(file).ok()?;
    if !opened.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::with_capacity(4096);
    (&mut opened)
        .take(RESULT_MAX_BYTES as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    // Buffer's toString("utf8") puts U+FFFD for each byte that is not UTF-8, as this does
    let text = String::from_utf8_lossy(&bytes);
    let text = js::trim(&text);
    if text.is_empty() {
        return None;
    }
    Some(if bytes.len() == RESULT_MAX_BYTES {
        format!("{text}\n[truncated at {RESULT_MAX_BYTES} bytes]")
    } else {
        text.to_owned()
    })
}

/// `path` opened for reading without following a symlink in its last place or waiting for a FIFO's
/// writer, as `readResult` opens it (`O_NOFOLLOW | O_NONBLOCK`; ADR 0284-report-rustix).
#[cfg(unix)]
fn open_no_follow(path: &Path) -> io::Result<File> {
    use rustix::fs::OFlags;
    use std::os::unix::fs::OpenOptionsExt as _;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags((OFlags::NOFOLLOW | OFlags::NONBLOCK).bits().cast_signed())
        .open(path)
}

/// On Windows the file is opened with `FILE_FLAG_OPEN_REPARSE_POINT` (0x0020_0000, from
/// winbase.h): a symlink in the last place opens as the link itself, whose metadata is not a regular
/// file, so `read_result` turns it down from the handle it read, with no window between a check and
/// the open.
#[cfg(windows)]
fn open_no_follow(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt as _;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

// A target that is neither unix nor Windows has neither flag; the fleet does not build for one
// (ADR 0111-cross-build). Stop the build rather than read a result through a symlink.
#[cfg(not(any(unix, windows)))]
compile_error!(
    "teach open_no_follow in orchestrator's src/fleet/turns.rs to open without following a symlink on this target"
);

/// A waiter of `wait`, taken back from the table when the wait ends by its timeout or cancel (or
/// its future is dropped); a settled waiter is gone already.
struct WaiterGuard<'a> {
    fleet: &'a Orchestrator,
    id: &'a str,
    waiter: u64,
}

impl Drop for WaiterGuard<'_> {
    fn drop(&mut self) {
        let mut turns = locked(&self.fleet.inner.turns);
        if let Some(waiters) = turns.waiters.get_mut(self.id) {
            waiters.retain(|(each, _)| *each != self.waiter);
            if waiters.is_empty() {
                turns.waiters.remove(self.id);
            }
        }
    }
}

/// Whether the turn's outcome is a report (`run.outcome?.report`).
fn has_report(run: &AgentRun) -> bool {
    matches!(run.outcome, Some(TurnOutcome::Report(_)))
}

impl Orchestrator {
    /// Whether a turn the fleet sent is in flight for the run `id` (TypeScript's `pending.has`).
    pub(crate) fn turn_in_flight(&self, id: &str) -> bool {
        locked(&self.inner.turns).pending.contains_key(id)
    }

    /// The turn of the run `id` the fleet sent, as it stands.
    pub(crate) fn pending(&self, id: &str) -> Option<PendingTurn> {
        locked(&self.inner.turns).pending.get(id).cloned()
    }

    /// A turn still running when the last server stopped is read as it settles, like one this
    /// server sent: herdr may not have shown it yet, or ended it while no server listened. Each
    /// run's result comes back from its file (the constructor's loop).
    pub(crate) fn resume_turns(&self) {
        let now = self.now();
        for run in self.registry().all() {
            if run.result.is_none() {
                let result = read_result(&self.result_dir(&run.id).join(RESULT_FILE));
                if result.is_some() {
                    let _ = self
                        .registry()
                        .update(&run.id, |stored| stored.result = result);
                }
            }
            locked(&self.inner.saved_states).insert(run.id.clone(), run.state);
            if run.state == AgentState::Working {
                {
                    let mut turns = locked(&self.inner.turns);
                    turns.generations.insert(run.id.clone(), 1);
                    turns.pending.insert(
                        run.id.clone(),
                        PendingTurn {
                            armed: true,
                            blocked_reported: false,
                            generation: 1,
                            submitted_at: None,
                            resumed_at: Some(now),
                            saw_working: false,
                            text: None,
                        },
                    );
                }
                self.arm_settle_check(&run.id, 1);
            } else if !run.interactive
                && is_completed(run.state)
                && matches!(run.outcome, Some(TurnOutcome::NoReport { .. }))
            {
                // a pane the last server kept without a report closes after its quiet period still
                self.arm_unreported_close(&run.id);
            }
        }
    }

    /// `message` to the run `target` as its next turn. A settlement still being handled finishes
    /// first; the run it leaves to talk to is read after it.
    pub async fn send(
        &self,
        target: &str,
        message: &str,
        group: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<AgentRun, OrchestratorError> {
        let asked = self.get(target, group)?;
        self.inner.reconcile_locks.wait_idle(&asked.id).await;
        let run = self.get(&asked.id, group)?;
        if !is_live(&run) {
            return Err(FleetError::new(
                "run_ended",
                format!(
                    "{} has {}; start a new agent instead.",
                    run.name,
                    state_name(run.state)
                ),
            )
            .into());
        }
        self.submit(&run.id, message, cancel).await
    }

    /// Until the run's turn settles, blocks or fails, or `timeout_ms` passes. A run with no turn
    /// in flight answers at once, with its state read back from herdr.
    pub async fn wait(
        &self,
        target: &str,
        timeout_ms: Option<u64>,
        group: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<AgentRun, OrchestratorError> {
        let run = self.get(target, group)?;
        // whether the turn already answers, and the waiter if it does not, in one step: a
        // settlement on another worker in between would find no waiter to wake
        let (sender, settled) = oneshot::channel();
        let waiter = self
            .inner
            .next_waiter
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let waits = {
            let mut turns = locked(&self.inner.turns);
            let pending = turns.pending.get(&run.id).cloned();
            let state = self
                .registry()
                .get(&run.id)
                .map_or(run.state, |run| run.state);
            let answered = match &pending {
                Some(pending) => {
                    !pending.armed || (state == AgentState::Blocked && pending.blocked_reported)
                }
                None => true,
            };
            if !answered {
                turns
                    .waiters
                    .entry(run.id.clone())
                    .or_default()
                    .push((waiter, sender));
            }
            !answered
        };
        if !waits {
            if is_live(&run) && !self.turn_in_flight(&run.id) {
                self.live_state(&run.id).await;
            }
            return Ok(self.registry().get(&run.id).unwrap_or(run));
        }
        // a wait that ends otherwise takes its waiter back
        let run_id = run.id.clone();
        let _waiting = WaiterGuard {
            fleet: self,
            id: &run_id,
            waiter,
        };
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "milliseconds from the config"
        )]
        let timeout_ms = timeout_ms
            .unwrap_or_else(|| self.config(&run.cwd).default_wait_timeout_ms.max(0.0) as u64);
        // a wait is a good moment to look: an event may have been missed
        self.spawn_reconcile(&run.id);
        tokio::select! {
            settled = settled => Ok(match settled {
                Ok(run) => run,
                Err(_) => self.registry().get(&run.id).unwrap_or(run),
            }),
            () = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
                self.live_state(&run.id).await;
                let run = self.registry().get(&run.id).unwrap_or(run);
                Err(OrchestratorError::WaitTimeout { run: Box::new(run), timeout_ms })
            }
            () = cancel.cancelled() => Err(RuntimeError::Cancelled.into()),
        }
    }

    /// The run's recent output, `lines` of it or the config's number.
    pub async fn read(
        &self,
        target: &str,
        lines: Option<u32>,
        group: Option<&str>,
    ) -> Result<String, OrchestratorError> {
        let run = self.get(target, group)?;
        let lines = lines.unwrap_or_else(|| read_lines(&self.config(&run.cwd)));
        Ok(self.deps().runtime.read(&run.herdr_name, lines).await?)
    }

    /// Esc to the run's agent, and its state read back.
    pub async fn interrupt(
        &self,
        target: &str,
        group: Option<&str>,
    ) -> Result<AgentRun, OrchestratorError> {
        let run = self.get(target, group)?;
        self.deps().runtime.interrupt(&run.herdr_name).await?;
        self.live_state(&run.id).await;
        Ok(self.registry().get(&run.id).unwrap_or(run))
    }

    /// The run's pane, focused in herdr.
    pub async fn focus(
        &self,
        target: &str,
        group: Option<&str>,
    ) -> Result<AgentRun, OrchestratorError> {
        let run = self.get(target, group)?;
        self.deps().runtime.focus(&run.herdr_name).await?;
        // the run as it is now: it may have changed while herdr focused it
        Ok(self.registry().get(&run.id).unwrap_or(run))
    }

    /// Closes the panes of finished non-interactive runs herdr still reports as done; never blocked
    /// or in-flight ones.
    pub async fn close_done(&self, group: Option<&str>) -> Vec<AgentRun> {
        let mut closed = Vec::new();
        for run in self.list(group) {
            if run.interactive || run.state != AgentState::Done || self.turn_in_flight(&run.id) {
                continue;
            }
            // inside the run's settlement lock, which `send` waits for, and checked again after
            // herdr answered: a turn handed over meanwhile keeps its pane
            let id = run.id.clone();
            let close = async {
                if self.live_state(&id).await != Some(AgentState::Done) || self.turn_in_flight(&id)
                {
                    return None;
                }
                if self.close_settled_pane(&id).await {
                    self.registry().get(&id)
                } else {
                    None
                }
            };
            if let Some(run) = self.inner.reconcile_locks.run(run.id.clone(), close).await {
                closed.push(run);
            }
        }
        closed
    }

    /// The text handed to the run `id` as a turn of the fleet's: the turn is pending until it
    /// settles (`submit`). herdr refusing a blocked agent, or any failure but a cancel, comes back
    /// as the run's state rather than as an error.
    pub(crate) async fn submit(
        &self,
        id: &str,
        text: &str,
        cancel: &CancellationToken,
    ) -> Result<AgentRun, OrchestratorError> {
        self.submit_with(id, text, cancel, false).await
    }

    /// `submit`, refused with `run_busy` when a turn of the fleet's is still in flight: the check
    /// and the new turn are one step, so a second caller finds the first one's turn (TypeScript's
    /// `if (this.pending.has(run.id)) throw …` with no await before `submit`, as landing steps and
    /// plan answers do).
    #[allow(
        dead_code,
        reason = "#265's plan answers and #266's landing steps send through it"
    )]
    pub(crate) async fn submit_when_free(
        &self,
        id: &str,
        text: &str,
        cancel: &CancellationToken,
    ) -> Result<AgentRun, OrchestratorError> {
        self.submit_with(id, text, cancel, true).await
    }

    async fn submit_with(
        &self,
        id: &str,
        text: &str,
        cancel: &CancellationToken,
        when_free: bool,
    ) -> Result<AgentRun, OrchestratorError> {
        if cancel.is_cancelled() {
            return Err(RuntimeError::Cancelled.into());
        }
        self.inner.timers.clear(TimerKind::UnreportedClose, id);
        let generation = {
            let mut turns = locked(&self.inner.turns);
            if when_free && turns.pending.contains_key(id) {
                let name = self
                    .registry()
                    .get(id)
                    .map_or_else(|| id.to_owned(), |run| run.name);
                return Err(FleetError::new(
                    "run_busy",
                    format!("The lead of {name} is working; wait for its turn to end."),
                )
                .into());
            }
            self.clear_settle_check(id);
            let generation = turns.generations.get(id).copied().unwrap_or(0) + 1;
            turns.generations.insert(id.to_owned(), generation);
            turns.pending.insert(
                id.to_owned(),
                PendingTurn {
                    armed: false,
                    blocked_reported: false,
                    generation,
                    submitted_at: None,
                    resumed_at: None,
                    saw_working: false,
                    text: Some(text.to_owned()),
                },
            );
            // the files a settlement still reads are this turn's only once the turn is in the table:
            // a settlement reads them under the same lock (#240's 2)
            self.clear_turn_files(id);
            generation
        };
        let Some(run) = self.registry().get(id) else {
            self.drop_pending(id);
            return Err(
                FleetError::new("run_not_found", format!("Unknown fleet agent: {id}")).into(),
            );
        };
        let prompt = match self.undelivered(id) {
            Some(instructions) => format!("{instructions}\n\n## Task\n\n{text}"),
            None => text.to_owned(),
        };
        match self
            .deps()
            .runtime
            .prompt(&run.herdr_name, &prompt, cancel)
            .await
        {
            Ok(submitted) => {
                self.drop_undelivered(id);
                // herdr still shows the state from before the prompt: the turn IS running, so it
                // counts as working (the budget, the UI) until herdr reports a real settlement
                let state = match submitted {
                    AgentState::Idle | AgentState::Unknown | AgentState::Done => {
                        AgentState::Working
                    }
                    other => other,
                };
                // the pane may have ended while the prompt was typed: the run then stays stopped,
                // and its turn (dropped as the pane ended) is not armed again
                self.update_state(id, state, None);
                let now = self.now();
                let armed = match locked(&self.inner.turns)
                    .pending
                    .get_mut(id)
                    .filter(|pending| pending.generation == generation)
                {
                    Some(pending) => {
                        pending.armed = true;
                        pending.submitted_at = Some(now);
                        // a reconcile on another worker may have seen it working already
                        pending.saw_working |= submitted == AgentState::Working;
                        true
                    }
                    None => false,
                };
                // a turn fast enough to settle before the TUI ever flips may send no further event
                if armed && submitted != AgentState::Working {
                    self.arm_settle_check(id, generation);
                }
                Ok(self.registry().get(id).unwrap_or(run))
            }
            Err(error) => {
                self.drop_pending(id);
                match error {
                    RuntimeError::Cancelled => Err(error.into()),
                    RuntimeError::Blocked => {
                        // herdr refused before typing anything: nothing is in flight; the caller
                        // retries once a person answered
                        let lines = read_lines(&self.config(&run.cwd));
                        let output = self.deps().runtime.read(&run.herdr_name, lines).await.ok();
                        self.update_state(id, AgentState::Blocked, Some(output));
                        Ok(self.registry().get(id).unwrap_or(run))
                    }
                    other => {
                        let now = self.now();
                        let message = other.to_string();
                        self.change_live(id, |run| {
                            run.state = AgentState::Failed;
                            run.last_error = Some(message);
                            run.updated_at = now;
                        });
                        Ok(self.registry().get(id).unwrap_or(run))
                    }
                }
            }
        }
    }

    /// A turn starts: a result file and a report found when it settles are this turn's.
    pub(crate) fn clear_turn_files(&self, id: &str) {
        let dir = self.result_dir(id);
        let _ = std::fs::remove_file(dir.join(RESULT_FILE));
        let _ = std::fs::remove_file(dir.join(REPORT_FILE));
    }

    /// A pane's agent status changed: a wake-up to read the run's state back from herdr.
    pub fn on_pane_status(&self, pane_id: &str) {
        if let Some(run) = self.registry().by_pane(pane_id).filter(is_live) {
            self.spawn_reconcile(&run.id);
        }
    }

    /// A pane exited or closed: its run is over. A run that already failed keeps that verdict.
    pub fn on_pane_ended(&self, pane_id: &str) {
        let Some(run) = self.registry().by_pane(pane_id).filter(is_live) else {
            return;
        };
        self.drop_pending(&run.id);
        let now = self.now();
        self.change(&run.id, |run| {
            run.state = AgentState::Stopped;
            run.updated_at = now;
        });
        self.settle_waiters(&run.id);
    }

    /// Events may have been lost (a reconnect, a restart): every live run is read back.
    pub async fn reconcile_all(&self) {
        for run in self.list(None).into_iter().filter(is_live) {
            self.reconcile_run(&run.id).await;
        }
    }

    /// `reconcile_run` in a task of its own (TypeScript's `void this.reconcileRun(run)`). The future
    /// is boxed here, so the settlement's type does not depend on the spawns it may start.
    pub(crate) fn spawn_reconcile(&self, id: &str) {
        let task: BoxFuture<'static, ()> = {
            let (fleet, id) = (self.clone(), id.to_owned());
            Box::pin(async move { fleet.reconcile_run(&id).await })
        };
        tokio::spawn(task);
    }

    /// The run's state read back from herdr, one settlement at a time per run (`reconcileRun`).
    pub(crate) async fn reconcile_run(&self, id: &str) {
        self.inner
            .reconcile_locks
            .run(id.to_owned(), self.reconcile_now(id))
            .await;
    }

    async fn reconcile_now(&self, id: &str) {
        if self.is_stopped() {
            return;
        }
        let Some(run) = self.registry().get(id).filter(is_live) else {
            return;
        };
        let reported = match self.deps().runtime.get(&run.herdr_name).await {
            Ok(reported) => reported,
            Err(RuntimeError::NotFound) => {
                // a run that failed or stopped meanwhile keeps that verdict
                let Some(run) = self.registry().get(id).filter(is_live) else {
                    return;
                };
                if run.state == AgentState::Starting && self.now() - run.started_at < START_GRACE_MS
                {
                    return;
                }
                self.drop_pending(id);
                let now = self.now();
                self.change(id, |run| {
                    run.state = AgentState::Stopped;
                    run.updated_at = now;
                });
                self.settle_waiters(id);
                return;
            }
            Err(_) => return,
        };
        // the pane ended while herdr was asked: what it said is older than that
        let Some(run) = self.registry().get(id).filter(is_live) else {
            return;
        };
        let pending = {
            let mut turns = locked(&self.inner.turns);
            let pending = turns.pending.get_mut(id);
            if let Some(pending) = pending {
                if reported == AgentState::Working {
                    pending.saw_working = true;
                }
                Some(pending.clone())
            } else {
                None
            }
        };
        // the paste is still going and herdr still answers with the idle from before: not a
        // settlement. The check scheduled at submission (or at a restart) looks again after the
        // grace period.
        if let Some(pending) = &pending
            && pending.armed
            && !pending.saw_working
            && is_completed(reported)
            && let Some(since) = pending.submitted_at.or(pending.resumed_at)
            && i128::from(self.now() - since)
                < self
                    .deps()
                    .timings
                    .pre_visual_grace
                    .as_millis()
                    .cast_signed()
        {
            return;
        }
        let current = self.observed(&run, reported).await;
        let Some(run) = self.registry().get(id).filter(is_live) else {
            return;
        };
        let previous = run.state;
        // a turn the fleet did not send starts (a helper's result woke the agent, or the person
        // typed): the files of the turn before are not this turn's (#176's 4)
        if pending.is_none()
            && current == AgentState::Working
            && (is_completed(previous) || previous == AgentState::Blocked)
        {
            let turns = locked(&self.inner.turns);
            if !turns.pending.contains_key(id) {
                self.clear_turn_files(id);
            }
        }
        if current != run.state {
            self.update_state(id, current, None);
        }
        let state = self.registry().get(id).map_or(current, |run| run.state);
        // the turn as it stands now: a submit since may have armed it
        let pending = pending.map(|snapshot| match self.pending(id) {
            Some(now) if now.generation == snapshot.generation => now,
            _ => snapshot,
        });
        match &pending {
            Some(pending) if pending.armed && state == AgentState::Blocked => {
                self.report_blocked(id, pending.generation).await
            }
            Some(pending) if pending.armed && is_completed(state) => {
                self.finalize(id, pending).await
            }
            None if previous == AgentState::Working && is_completed(state) && is_thread(&run) => {
                self.settle_unsent_turn(id).await;
            }
            _ => {}
        }
        // free again, after the fleet's turn or the person's: the questions of the threads it hears for
        if !self.turn_in_flight(id)
            && self
                .registry()
                .get(id)
                .is_some_and(|run| is_completed(run.state))
        {
            let (fleet, id) = (self.clone(), id.to_owned());
            tokio::spawn(async move { fleet.deliver_notices(&id).await });
        }
    }

    /// A settled turn of the fleet's: what it left is read, the other clusters settle their part,
    /// the waiters hear of it, and a finished pane closes (`finalize`).
    async fn finalize(&self, id: &str, pending: &PendingTurn) {
        let Some(run) = self.registry().get(id) else {
            return;
        };
        let config = self.config(&run.cwd);
        // the turn's files are read before the turn stops being pending, under the lock a new turn
        // takes to clear them: a step sent once this turn is not pending (a landing step) clears
        // them for its own turn, and must not take a report this settlement has not read (#240's 2)
        let files = {
            let mut turns = locked(&self.inner.turns);
            if turns.pending.get(id).map(|now| now.generation) != Some(pending.generation) {
                return;
            }
            let files = self.read_turn_files(&run);
            turns.pending.remove(id);
            self.clear_settle_check(id);
            files
        };
        self.read_turn(id, &config, files).await;
        if self.registry().get(id).is_some_and(|run| is_thread(&run)) {
            self.read_thread_work(id).await;
        }
        // a thread whose lead run failed or left no report goes on in a new run first, from the
        // contract and change the turn left: what it leaves undone is the new run's
        let restart_error = match self.registry().get(id) {
            Some(run) if needs_restart(&run) => {
                self.restart_thread(id, pending.text.as_deref()).await
            }
            _ => None,
        };
        if let Some(run) = self.registry().get(id)
            && is_thread(&run)
            && run.replaced_by.is_none()
        {
            // a turn that failed or left no report went nowhere; a lead taking a thread over starts
            // with its plan still open, and keeps it so while it reports blocked on it
            if let Some(TurnOutcome::Report(report)) = &run.outcome
                && !(pending.generation == 1
                    && run.thread.is_some()
                    && report.state == protocol::ReportState::Blocked)
            {
                self.close_stale_plan(id, pending.submitted_at);
            }
            self.settle_thread_turn(id, &config, restart_error).await;
        }
        let now = self.now();
        let Some(run) = self.change(id, |run| run.updated_at = now) else {
            // the record went away: its waiters hear at once rather than at their timeout
            self.settle_waiters(id);
            return;
        };
        if run.role == PROJECT_ROLE {
            self.settle_merges(id).await;
        }
        if self
            .registry()
            .get(id)
            .is_some_and(|run| is_completed(run.state))
        {
            self.read_usage_screen(id, &config).await;
        }
        // a helper's failed first turn starts again on the next configured model
        self.respawn_after_failure(id, pending.generation).await;
        self.settle_waiters(id);
        self.close_on_settle(id, &config).await;
        if self.inner.outbox.holds(id) {
            let (fleet, id) = (self.clone(), id.to_owned());
            tokio::spawn(async move { fleet.tell_coordinator(&id).await });
        }
    }

    /// The handoff and report a settled turn left (`readTurn`'s file reads). A project's
    /// coordinator talks with the person and keeps no result folder: it reports nothing.
    pub(crate) fn read_turn_files(&self, run: &AgentRun) -> (Option<String>, Option<TurnOutcome>) {
        let dir = self.result_dir(&run.id);
        let result = read_result(&dir.join(RESULT_FILE));
        let outcome = (run.role != PROJECT_ROLE).then(|| read_report(&dir));
        (result, outcome)
    }

    /// What a settled turn left: the screen, the handoff and report read before, and the API
    /// failure it may have ended on (`readTurn`).
    pub(crate) async fn read_turn(
        &self,
        id: &str,
        config: &FleetConfig,
        files: (Option<String>, Option<TurnOutcome>),
    ) {
        let Some(run) = self.registry().get(id) else {
            return;
        };
        let output = self
            .deps()
            .runtime
            .read(&run.herdr_name, read_lines(config))
            .await
            .ok();
        let (result, outcome) = files;
        let Some(run) = self.change(id, |run| {
            run.last_output = output;
            run.result = result;
            run.outcome = outcome;
            // the thread made progress: the CLIs its runs failed on before get another chance
            if has_report(run) {
                run.avoid = None;
            }
        }) else {
            return;
        };
        self.event(FleetEvent::Turn(TurnEvent {
            run: run.id.clone(),
            role: run.role.clone(),
            agent: run.agent,
            model: run.model.clone(),
            group: run.group.clone(),
            project: run.project.clone(),
            interactive: run.interactive,
            handoff: run.result.is_some(),
            report: run.outcome.as_ref().map(|outcome| match outcome {
                TurnOutcome::Report(report) => TurnReport::from(Some(report.state)),
                TurnOutcome::NoReport { .. } => TurnReport::None,
            }),
        }));
        // an API failure (auth, rate limit, outage) ends a turn like any other once the CLI's own
        // retries are spent; a turn that wrote its report did its work, whatever its screen quotes
        let checks = screen::screen_checks(run.agent);
        let turn_error = match (&run.last_output, has_report(&run)) {
            (Some(output), false) => (checks.turn_error)(output),
            _ => None,
        };
        if let Some(error) = turn_error
            && is_completed(run.state)
        {
            let message = error.clone();
            self.change(id, |run| {
                run.state = AgentState::Failed;
                run.last_error = Some(message);
            });
            // a rate limit sits the account out: the re-spawn and later spawns pass it over
            if let Some(usage) = &self.deps().usage {
                usage.note_failure(
                    run.agent,
                    run.model.as_deref(),
                    &error,
                    config.rate_limit_cooldown_minutes,
                );
            }
        }
    }

    async fn report_blocked(&self, id: &str, generation: u64) {
        {
            let mut turns = locked(&self.inner.turns);
            let Some(pending) = turns
                .pending
                .get_mut(id)
                .filter(|pending| pending.generation == generation)
            else {
                return;
            };
            if pending.blocked_reported {
                return;
            }
            pending.blocked_reported = true;
        }
        let Some(run) = self.registry().get(id) else {
            return;
        };
        let output = self
            .deps()
            .runtime
            .read(&run.herdr_name, read_lines(&self.config(&run.cwd)))
            .await
            .ok();
        let now = self.now();
        self.change(id, |run| {
            run.last_output = output;
            run.updated_at = now;
        });
        self.settle_waiters(id);
    }

    /// A non-interactive run's pane, once its turn settled with its report written. A turn that
    /// ended without one keeps its pane for the quiet period: a question the adapter does not know
    /// reads as a finished turn (herdr reports agy's file access screen as done), and closing it at
    /// once would end the agent where the person or its lead can still see what stopped it and send
    /// it on. Left alone through the quiet period, it closes too (#189's 4).
    async fn close_on_settle(&self, id: &str, config: &FleetConfig) {
        let Some(run) = self.registry().get(id) else {
            return;
        };
        if !config.close_on_settle
            || run.interactive
            || !is_completed(run.state)
            || self.turn_in_flight(id)
        {
            return;
        }
        if !has_report(&run) {
            self.arm_unreported_close(id);
            return;
        }
        if self.live_state(id).await.is_some_and(is_completed) {
            self.close_settled_pane(id).await;
        }
    }

    /// The close of a pane left without a report, after [`UNREPORTED_CLOSE`]: inside the run's
    /// settlement lock, as a settle check, and only when no turn was sent since, the run is still
    /// live, settled and without a report, the config still closes settled panes, and herdr still
    /// calls it settled.
    fn arm_unreported_close(&self, id: &str) {
        let generation = locked(&self.inner.turns).generations.get(id).copied();
        let (fleet, run_id) = (self.clone(), id.to_owned());
        let close: BoxFuture<'static, ()> = Box::pin(async move {
            let id = run_id.as_str();
            let check = async {
                if fleet.is_stopped()
                    || fleet.turn_in_flight(id)
                    || locked(&fleet.inner.turns).generations.get(id).copied() != generation
                {
                    return;
                }
                let Some(run) = fleet.registry().get(id) else {
                    return;
                };
                if !is_live(&run)
                    || run.interactive
                    || has_report(&run)
                    || !is_completed(run.state)
                    || !fleet.config(&run.cwd).close_on_settle
                {
                    return;
                }
                if fleet.live_state(id).await.is_some_and(is_completed) && !fleet.turn_in_flight(id)
                {
                    fleet.close_settled_pane(id).await;
                }
            };
            fleet.inner.reconcile_locks.run(id.to_owned(), check).await;
        });
        self.inner
            .timers
            .set(TimerKind::UnreportedClose, id, UNREPORTED_CLOSE, close);
    }

    /// The run's pane closed, and the run stopped; false when herdr would not close it.
    async fn close_settled_pane(&self, id: &str) -> bool {
        let Some(run) = self.registry().get(id) else {
            return false;
        };
        if self.deps().runtime.close_pane(&run.pane_id).await.is_err() {
            return false;
        }
        self.drop_pending(id);
        let now = self.now();
        self.change(id, |run| {
            run.state = AgentState::Stopped;
            run.updated_at = now;
        });
        true
    }

    /// herdr's state, corrected for a question herdr takes for idle (cursor's and agy's trust and
    /// approval screens): while one shows, the run is blocked, at startup and mid-turn alike.
    async fn observed(&self, run: &AgentRun, reported: AgentState) -> AgentState {
        let Some(question) = screen::screen_checks(run.agent)
            .question
            .filter(|_| is_completed(reported))
        else {
            return reported;
        };
        let lines = read_lines(&self.config(&run.cwd));
        let screen = self
            .deps()
            .runtime
            .read(&run.herdr_name, lines)
            .await
            .unwrap_or_default();
        if question(&screen).is_some() {
            AgentState::Blocked
        } else {
            reported
        }
    }

    /// herdr's state for the run now, the run updated to it; none when herdr cannot say (never a
    /// reason to close a pane).
    pub(crate) async fn live_state(&self, id: &str) -> Option<AgentState> {
        let run = self.registry().get(id)?;
        let reported = self.deps().runtime.get(&run.herdr_name).await.ok()?;
        let current = self.observed(&run, reported).await;
        let run = self.registry().get(id).filter(is_live)?;
        if current != run.state {
            self.update_state(id, current, None);
        }
        Some(current)
    }

    /// Everyone waiting on the run `id` hears it as it is now.
    pub(crate) fn settle_waiters(&self, id: &str) {
        let waiters = locked(&self.inner.turns)
            .waiters
            .remove(id)
            .unwrap_or_default();
        if waiters.is_empty() {
            return;
        }
        let Some(run) = self.registry().get(id) else {
            return;
        };
        for (_, waiter) in waiters {
            let _ = waiter.send(run.clone());
        }
    }

    /// Looks at the run again after the grace period; keyed by generation, so a follow-up send never
    /// inherits it.
    fn arm_settle_check(&self, id: &str, generation: u64) {
        let (fleet, run_id) = (self.clone(), id.to_owned());
        self.inner.timers.set(
            TimerKind::SettleCheck,
            id,
            self.deps().timings.pre_visual_grace,
            async move {
                if fleet
                    .pending(&run_id)
                    .is_some_and(|pending| pending.generation == generation)
                {
                    fleet.spawn_reconcile(&run_id);
                }
            },
        );
    }

    fn clear_settle_check(&self, id: &str) {
        self.inner.timers.clear(TimerKind::SettleCheck, id);
    }

    /// The run's turn is no longer the fleet's to follow.
    pub(crate) fn drop_pending(&self, id: &str) {
        locked(&self.inner.turns).pending.remove(id);
        self.clear_settle_check(id);
    }

    /// The run `id` in `state`, saved; `output` replaces its last output when given
    /// (`updateState`).
    /// A run that is no longer live keeps its state: every caller decided on a state herdr reported
    /// before an await, during which the pane may have ended.
    pub(crate) fn update_state(&self, id: &str, state: AgentState, output: Option<Option<String>>) {
        let now = self.now();
        let mut previous = None;
        self.change_live(id, |run| {
            previous = Some(run.state);
            run.state = state;
            if let Some(output) = output {
                run.last_output = output;
            }
            // a thread marked done that works again is open again
            if state == AgentState::Working {
                run.resolved_at = None;
            }
            run.updated_at = now;
        });
        // working again after a question: a later block is news again
        if state == AgentState::Working
            && previous == Some(AgentState::Blocked)
            && let Some(pending) = locked(&self.inner.turns).pending.get_mut(id)
        {
            pending.blocked_reported = false;
        }
    }
}
