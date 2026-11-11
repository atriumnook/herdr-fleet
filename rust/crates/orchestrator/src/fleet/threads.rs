//! Threads: a lead in a workspace (and worktree) of its own, named by its title; `startThread`,
//! `threads`, `resolve` and `readThreadWork` of `server/fleet/orchestrator.ts`. #262 fills it; until
//! then its hooks do nothing.

use super::Orchestrator;

/// What the threads keep while this server runs.
#[derive(Debug, Default)]
pub(crate) struct State {}

impl Orchestrator {
    /// What a thread's lead left in its worktree as its turn settled: its contract and its change
    /// since the base, kept on the run `id` (`readThreadWork`).
    pub(crate) async fn read_thread_work(&self, id: &str) {
        // stub: #262
        let _ = id;
    }
}
