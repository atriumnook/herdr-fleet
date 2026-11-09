//! The status of every pane of the session (`server/collector.ts`), told to a
//! [`PaneStatusHandler`]. The signatures are final (ADR 0242-phase-3-split, "ペインの状態の購読");
//! the body is #257's.
//!
//! The threading contract: [`start`] spawns onto the current Tokio runtime (it panics outside
//! one, as `tokio::spawn` does), and the handler's methods are called one at a time from that
//! task, so they must not block: a handler with slow work spawns it.

use crate::events::EventSource;
use herdr_api::{AgentStatus, PaneInfo};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

/// What a pane was last heard as, before a snapshot showed a status no event told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Replay {
    pub before: AgentStatus,
    pub agent: Option<String>,
}

/// Who is told about pane status (`StatusCollectorHandlers`).
pub trait PaneStatusHandler: Send + Sync + 'static {
    /// `agent` is the agent herdr now sees in the pane (`None`: none). `replay`: no event said
    /// so; a snapshot did, around a gap between two subscriptions.
    fn on_status(
        &self,
        pane: &str,
        status: AgentStatus,
        agent: Option<&str>,
        replay: Option<Replay>,
    );
    /// Every pane as of each reconcile's snapshot.
    fn on_baseline(&self, panes: &[PaneInfo]);
    /// Status events were lost: this snapshot is the truth for every pane but the `newer` ones.
    fn on_resync(&self, _panes: &[PaneInfo], _newer: &HashSet<String>) {}
    fn on_pane_ended(&self, pane: &str);
    fn on_structure_change(&self);
    /// herdr's focus moved onto this pane.
    fn on_focus(&self, _pane: &str) {}
}

/// How the subscription runs. The defaults are the TypeScript collector's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneStatusOptions {
    /// Open the focus connection (`pane.focused`) and tell [`PaneStatusHandler::on_focus`]; on by
    /// default, as both TypeScript callers give `onFocus`.
    pub focus: bool,
    /// First retry after a subscription closed; doubles per closure that never started.
    pub reconnect_min: Duration,
    pub reconnect_max: Duration,
    /// How often every pane is checked against a snapshot anyway.
    pub backstop: Duration,
    pub debounce: Duration,
    /// Retry delay when a reconcile's snapshot fails.
    pub snapshot_retry: Duration,
    /// How long a replay waits for events already on their way.
    pub replay_settle: Duration,
}

impl Default for PaneStatusOptions {
    fn default() -> Self {
        // server/collector.ts RECONNECT_MIN_MS … REPLAY_SETTLE_MS
        Self {
            focus: true,
            reconnect_min: Duration::from_millis(250),
            reconnect_max: Duration::from_millis(5_000),
            backstop: Duration::from_millis(60_000),
            debounce: Duration::from_millis(500),
            snapshot_retry: Duration::from_millis(5_000),
            replay_settle: Duration::from_millis(150),
        }
    }
}

/// A running subscription; [`PaneStatus::stop`] or dropping it ends it.
#[derive(Debug)]
pub struct PaneStatus {
    _private: (),
}

impl PaneStatus {
    /// Closes every connection and cancels every timer. Calling it again does nothing.
    pub fn stop(&self) {
        // stub: #257
    }
}

impl Drop for PaneStatus {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Starts telling `handler` the status of every pane `source` reports.
pub fn start(
    source: Arc<dyn EventSource>,
    handler: Arc<dyn PaneStatusHandler>,
    options: PaneStatusOptions,
) -> PaneStatus {
    let _ = (source, handler, options);
    todo!("#257")
}
