//! The candidates a spawn tries: the primary model, then each configured fallback; a candidate
//! whose model the CLI does not offer or whose account has no usage left is passed over, a start
//! that failed moves on, and a failed first turn starts again on the next one. `spawnWithFallbacks`,
//! `respawn`, `readUsageScreen`, the turn error's cooldown and `applyModelPolicy` of
//! `server/fleet/orchestrator.ts`, and the `UsageGate` and `ModelGate` impls. #263 fills it; until
//! then a spawn tries its primary candidate alone, and the other hooks do nothing. A turn's API
//! error cools the account down through `UsageGate::note_failure`, which `turns.rs` calls and #263's
//! impl for `UsageTracker` carries out.

use protocol::{AgentRun, ThinkingLevel};
use tokio_util::sync::CancellationToken;

use super::spawn::{Attempt, PlannedSpawn};
use super::{Orchestrator, OrchestratorError};
use crate::config::{FleetConfig, parse_candidate};
use crate::error::FleetError;

/// What the candidates keep while this server runs (`spawnPlans`).
#[derive(Debug, Default)]
pub(crate) struct State {}

/// `models.<model>.thinking` as the allow-list for that model (`applyModelPolicy`).
pub fn apply_model_policy(
    config: &FleetConfig,
    model: Option<&str>,
    thinking: Option<ThinkingLevel>,
    explicit: bool,
) -> Result<Option<ThinkingLevel>, FleetError> {
    // stub: #263
    let _ = (config, model, explicit);
    Ok(thinking)
}

impl Orchestrator {
    /// The primary candidate, then each configured fallback in order (`spawnWithFallbacks`).
    /// `fallbacks` replaces the configured list for a re-spawn after a failed first turn, and
    /// `fallback_from` is the model the re-spawn replaces.
    pub(crate) async fn spawn_with_fallbacks(
        &self,
        request: PlannedSpawn,
        cancel: &CancellationToken,
        fallbacks: Option<Vec<String>>,
        fallback_from: Option<String>,
    ) -> Result<AgentRun, OrchestratorError> {
        // stub: #263 — the primary candidate alone: no usage or model gate, no fallback
        let _ = fallbacks;
        let role = self.resolve_role(&request)?;
        let candidate = parse_candidate(role.primary.as_deref(), role.kind);
        let thinking = apply_model_policy(
            &role.config,
            candidate.model.as_deref(),
            role.thinking,
            role.explicit_thinking,
        )?;
        let attempt = Attempt {
            config: role.config,
            definition: role.definition,
            over: role.over,
            kind: candidate.agent,
            model: candidate.model,
            thinking,
            fallbacks: Vec::new(),
            fallback_from,
            skipped: Vec::new(),
        };
        self.spawn_attempt(&request, attempt, cancel).await
    }

    /// The spawn keeps its untried fallbacks for a failed first turn (`spawnPlans.set`); called
    /// before the task is handed over, so a first turn that settles at once finds the plan.
    pub(crate) fn keep_spawn_plan(&self, id: &str, request: &PlannedSpawn, fallbacks: &[String]) {
        // stub: #263
        let _ = (id, request, fallbacks);
    }

    /// The run `id`'s turn of `generation` settled: a helper's failed first turn starts again on
    /// the next fallback, and the failed run names its replacement (`respawn`, and its condition
    /// in `finalize`).
    pub(crate) async fn respawn_after_failure(&self, id: &str, generation: u64) {
        // stub: #263
        let _ = (id, generation);
    }

    /// A CLI that shows its usage only on its own screen (cursor's `/usage`) is asked once a turn
    /// settled (`readUsageScreen`).
    pub(crate) async fn read_usage_screen(&self, id: &str, config: &FleetConfig) {
        // stub: #263
        let _ = (id, config);
    }
}
