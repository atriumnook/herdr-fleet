//! Landing a thread: the steps the person presses, the merges checked in git and on GitHub, and
//! closing a thread; `land`, `landStep`, `onThread`, `settleLeadStep`, `settleMerges`,
//! `closeThread`, `settleThreadTurn`, `mergedOnGitHub` and `refreshPullRequests` of
//! `server/fleet/orchestrator.ts`, and the real `LandingTools`. #266 fills it; until then its hooks
//! do nothing.

use super::Orchestrator;
use crate::config::FleetConfig;
use crate::outbox::Notice;

/// What landing keeps while this server runs.
#[derive(Debug, Default)]
pub(crate) struct State {}

impl Orchestrator {
    /// A thread's settled turn: its landing step and pull request, and what its coordinator hears,
    /// with why the thread could not start again when it could not (`settleThreadTurn`).
    pub(crate) async fn settle_thread_turn(
        &self,
        id: &str,
        config: &FleetConfig,
        restart_error: Option<String>,
    ) {
        // stub: #266
        let _ = (id, config, restart_error);
    }

    /// The coordinator's turn ended: the merges it was handed, checked, and the threads that landed
    /// closed (`settleMerges`).
    pub(crate) async fn settle_merges(&self, coordinator: &str) {
        // stub: #266
        let _ = coordinator;
    }

    /// A merge step the thread no longer waits on: another step, a discard or a close took its
    /// place (`staleStep`).
    pub(crate) fn stale_step(&self, notice: &Notice) -> bool {
        // stub: #266
        let _ = notice;
        false
    }

    /// Merge steps the person pressed that are neither sent nor queued, queued in the order pressed
    /// (the constructor's migration of unsent steps).
    pub(crate) fn restore_landing_steps(&self) {
        // stub: #266
    }
}
