//! A thread outlives its lead run: a lead that failed, or whose turn ended without a report, is
//! taken over by a new run on another CLI; `settleUnsentTurn`, `restartThread`, `startThreadAgain`,
//! `needsRestart`, `carried`, `carryFiles` and `recoveryTask` of `server/fleet/orchestrator.ts`.
//! #267 fills it; until then its hooks do nothing.

use protocol::{AgentRun, FleetAgentKind};

use super::Orchestrator;
use super::spawn::Takeover;

/// What the restarts keep while this server runs.
#[derive(Debug, Default)]
pub(crate) struct State {}

/// A thread's settled lead whose run failed or whose turn left no report, and the thread still
/// open: it goes on in a new run (`needsRestart`).
pub(crate) fn needs_restart(run: &AgentRun) -> bool {
    // stub: #267
    let _ = run;
    false
}

impl Orchestrator {
    /// The thread of the lead `id` goes on in a new run; why it could not, if it could not
    /// (`restartThread`). `last_message` is what the fleet last sent the run, when it sent it.
    pub(crate) async fn restart_thread(
        &self,
        id: &str,
        last_message: Option<&str>,
    ) -> Option<String> {
        // stub: #267
        let _ = (id, last_message);
        None
    }

    /// A thread's turn the fleet did not send ended (`settleUnsentTurn`).
    pub(crate) async fn settle_unsent_turn(&self, id: &str) {
        // stub: #267
        let _ = id;
    }

    /// What a lead that takes a thread over carries on its new run from the run before: the
    /// thread, its landing, and the CLIs to pass over (`carried`).
    pub(crate) fn carry_over(
        &self,
        takeover: &Takeover,
        avoid: Option<&[FleetAgentKind]>,
        run: &mut AgentRun,
    ) {
        // stub: #267
        let _ = (takeover, avoid, run);
    }

    /// What a lead that takes a thread over starts from in its result folder: the run before's
    /// contract, and the thread's plan (`carryFiles`).
    pub(crate) fn carry_files(&self, from: &AgentRun, to: &AgentRun) {
        // stub: #267
        let _ = (from, to);
    }
}
