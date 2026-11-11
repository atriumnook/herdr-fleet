//! The fleet's notices to a thread's coordinator: the threads' questions and news, delivered once it
//! is free; `coordinatorOf`, `tellCoordinator`, `queueNews`, `deliverNotices` and the notices' texts
//! of `server/fleet/orchestrator.ts`. #264 fills it; until then its hooks do nothing.

use super::Orchestrator;

/// What the notices keep while this server runs (`delivering`).
#[derive(Debug, Default)]
pub(crate) struct State {}

impl Orchestrator {
    /// Every notice waiting for `coordinator`, in one message, once it is free (`deliverNotices`).
    pub(crate) async fn deliver_notices(&self, coordinator: &str) {
        // stub: #264
        let _ = coordinator;
    }

    /// The thread `thread`'s notices to whoever hears it now (`tellCoordinator`).
    pub(crate) async fn tell_coordinator(&self, thread: &str) {
        // stub: #264
        let _ = thread;
    }

    /// A thread's news kept on its run by a server from before the outbox, queued as a notice
    /// (the constructor's migration of `run.notice`).
    pub(crate) fn restore_notices(&self) {
        // stub: #264
    }
}
