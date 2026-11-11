//! A thread's plan for the person: `planner`, `submitPlan`, `plan`, `answerPlan` and
//! `closeStalePlan` of `server/fleet/orchestrator.ts`. #265 fills it; until then its hooks do
//! nothing.

use super::Orchestrator;

/// What the plans keep while this server runs.
#[derive(Debug, Default)]
pub(crate) struct State {}

impl Orchestrator {
    /// A turn of the lead `id` settled after the one that wrote its plan, without the person's
    /// answers: the plan takes no answers any more (`closeStalePlan`). `submitted_at` is when the
    /// turn's prompt was handed to herdr, none for a turn a restart took over.
    pub(crate) fn close_stale_plan(&self, id: &str, submitted_at: Option<i64>) {
        // stub: #265
        let _ = (id, submitted_at);
    }
}
