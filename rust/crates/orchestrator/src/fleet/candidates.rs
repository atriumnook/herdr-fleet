//! The candidates a spawn tries: the primary model, then each configured fallback; a candidate
//! the caller avoids, whose CLI cannot take the role, whose model the CLI does not offer or whose
//! account has no usage left is passed over, a start that failed moves on, and a failed first turn
//! starts again on the next one. `spawnWithFallbacks`, `respawn`, `readUsageScreen` and
//! `applyModelPolicy` of `server/fleet/orchestrator.ts`, and the `UsageGate` and `ModelGate` impls.
//! A turn's API error cools the account down through `UsageGate::note_failure`, which `turns.rs`
//! calls and the impl for `UsageTracker` below carries out (ADR 0256-orchestrator-foundation).

use std::collections::HashMap;
use std::time::Duration;

use protocol::{
    AgentRun, AgentState, FleetAgentKind, SkippedCandidate, ThinkingLevel, UsageReading,
};
use serde_json::Value;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::spawn::{Attempt, PlannedSpawn, read_lines};
use super::{
    BoxFuture, ModelGate, Orchestrator, OrchestratorError, UsageGate, is_completed, is_thread,
    locked,
};
use crate::config::{FleetConfig, parse_thinking_level, role_candidates};
use crate::error::FleetError;
use crate::launch::{RoleFit, adapter_for};
use crate::models::ModelCatalog;
use crate::runtime::RuntimeError;
use crate::usage::UsageTracker;

/// how often a CLI's usage screen and its settling are looked at (`READY_SCREEN_POLL_MS`)
const USAGE_SCREEN_POLL: Duration = Duration::from_millis(250);

/// The levels from the lowest (`THINKING_LEVELS`): the order `ThinkingLevel` does not carry.
const LEVELS: [ThinkingLevel; 7] = [
    ThinkingLevel::Off,
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::Xhigh,
    ThinkingLevel::Max,
];

/// The level as fleet.json spells it: its serde name, as the config reads it.
fn level_name(level: ThinkingLevel) -> String {
    serde_json::to_value(level)
        .ok()
        .and_then(|name| name.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// A spawn's untried fallbacks, kept until its first turn settles (`SpawnPlan`).
#[derive(Debug)]
struct SpawnPlan {
    request: PlannedSpawn,
    fallbacks: Vec<String>,
}

/// What the candidates keep while this server runs (`spawnPlans`).
#[derive(Debug, Default)]
pub(crate) struct State {
    plans: HashMap<String, SpawnPlan>,
}

/// `models.<model>.thinking` is the allow-list for that model (`applyModelPolicy`). A level chosen
/// explicitly (the spawn request, a role override, the role file) outside it is refused so the
/// caller decides again; a level inherited from defaults is lowered to the highest allowed one. A
/// `:level` suffix on the model is the effective level and is checked the same way.
pub fn apply_model_policy(
    config: &FleetConfig,
    model: Option<&str>,
    thinking: Option<ThinkingLevel>,
    explicit: bool,
) -> Result<Option<ThinkingLevel>, FleetError> {
    let Some(model) = model.filter(|model| !model.is_empty()) else {
        return Ok(thinking);
    };
    // `/^(.*):(off|…|max)$/`: the last colon, with a level after it
    let suffix = model
        .rsplit_once(':')
        .and_then(|(base, level)| parse_thinking_level(&Value::from(level)).map(|l| (base, l)));
    let (base, effective) = match suffix {
        Some((base, level)) => (base, Some(level)),
        None => (model, thinking),
    };
    let Some(allowed) = config
        .models
        .get(base)
        .and_then(|policy| policy.thinking.as_deref())
        .filter(|allowed| !allowed.is_empty())
    else {
        return Ok(effective);
    };
    if effective.is_some_and(|level| allowed.contains(&level)) {
        return Ok(effective);
    }
    if explicit || suffix.is_some() {
        let names: Vec<String> = allowed.iter().copied().map(level_name).collect();
        return Err(FleetError::new(
            "thinking_not_allowed",
            format!(
                "Thinking level \"{}\" is not allowed for {base}. Allowed: {}.",
                effective.map_or_else(|| "undefined".to_owned(), level_name),
                names.join(", ")
            ),
        ));
    }
    Ok(LEVELS
        .into_iter()
        .rev()
        .find(|level| allowed.contains(level)))
}

/// The reader of a CLI's own usage screen, for a CLI that shows its usage nowhere else
/// (`usageScreen`): cursor's `/usage`.
fn usage_screen(kind: FleetAgentKind) -> Option<fn(&str, i64) -> Option<UsageReading>> {
    match kind {
        FleetAgentKind::Cursor => Some(screen::cursor_usage),
        _ => None,
    }
}

impl Orchestrator {
    /// The primary candidate, then each configured fallback in order (`spawnWithFallbacks`). A
    /// candidate the caller avoids, whose CLI cannot take the role, whose model the CLI does not
    /// offer, or whose account has no usage left or is cooling down is skipped; one that fails to
    /// start (the CLI quit with an error before it was ready) moves on to the next, and a rate
    /// limit it quit on starts a cooldown. Every other error is the caller's. `fallbacks` replaces
    /// the configured list for a re-spawn after a failed first turn, so candidates already tried
    /// are not tried again, and `fallback_from` is the model the re-spawn replaces.
    pub(crate) async fn spawn_with_fallbacks(
        &self,
        request: PlannedSpawn,
        cancel: &CancellationToken,
        fallbacks: Option<Vec<String>>,
        fallback_from: Option<String>,
    ) -> Result<AgentRun, OrchestratorError> {
        let role = self.resolve_role(&request)?;
        let fallbacks = fallbacks.unwrap_or_else(|| role.fallbacks.clone());
        let candidates = role_candidates(role.kind, role.primary.as_deref(), &fallbacks);
        // the role's facts a CLI may not fit (ADR 0248-launch-adapters)
        let fit = RoleFit {
            read_only: role.definition.edits == Some(false),
            spawning: role.definition.may_spawn(&role.over),
            reads_outside_folders: role.definition.name == "reviewer",
        };
        let usage = self.deps().usage.as_deref();
        let models = self.deps().models.as_deref();
        let mut failures: Vec<String> = Vec::new();
        let mut skipped: Vec<SkippedCandidate> = Vec::new();
        let mut started = false;
        let mut out_of_usage = false;
        for (i, candidate) in candidates.iter().enumerate() {
            let label = candidate.entry.as_deref().unwrap_or("default");
            let last = i + 1 == candidates.len();
            let (kind, model) = (candidate.agent, candidate.model.as_deref());
            let avoided = if request
                .avoid
                .as_ref()
                .is_some_and(|avoid| avoid.contains(&kind))
            {
                Some(format!("the caller keeps {} out", kind.name()))
            } else {
                adapter_for(kind).refusal(&fit)
            };
            let refused = match (avoided, models) {
                (Some(reason), _) => Some(reason),
                (None, Some(models)) => models.unknown(kind, model).await,
                (None, None) => None,
            };
            // a candidate refused for what it is, else for what its account has left
            let unusable = match (refused, usage) {
                (Some(reason), _) => Some((reason, false)),
                (None, Some(usage)) => usage
                    .unavailable(kind, model, role.config.max_used_percent)
                    .await
                    .map(|reason| (reason, true)),
                (None, None) => None,
            };
            if let Some((reason, for_usage)) = unusable {
                out_of_usage |= for_usage;
                failures.push(format!("{label}: {reason}"));
                skipped.push(SkippedCandidate {
                    candidate: label.to_owned(),
                    reason,
                });
                if !last {
                    continue;
                }
                let code = if started {
                    "fallbacks_exhausted"
                } else if out_of_usage {
                    "usage_exhausted"
                } else {
                    "no_candidates"
                };
                return Err(FleetError::new(
                    code,
                    format!("No candidate is usable: {}", failures.join("; ")),
                )
                .into());
            }
            // a fallback is bounded by its own allow-list rather than refused: a person listed it
            let thinking = apply_model_policy(
                &role.config,
                model,
                role.thinking,
                i == 0 && role.explicit_thinking,
            )?;
            started = true;
            let attempt = Attempt {
                config: role.config.clone(),
                definition: role.definition.clone(),
                over: role.over.clone(),
                kind,
                model: candidate.model.clone(),
                thinking,
                fallbacks: candidates[i + 1..]
                    .iter()
                    .filter_map(|next| next.entry.clone())
                    .filter(|entry| !entry.is_empty())
                    .collect(),
                fallback_from: match i {
                    0 => fallback_from.clone(),
                    _ => candidates[i - 1]
                        .entry
                        .clone()
                        .or_else(|| fallback_from.clone()),
                },
                skipped: skipped.clone(),
            };
            let error = match self.spawn_attempt(&request, attempt, cancel).await {
                Ok(run) => return Ok(run),
                Err(error) if error.is_cancelled() => return Err(error),
                Err(error) => error,
            };
            let reason = error.to_string();
            let model_failure = matches!(
                error,
                OrchestratorError::Runtime(RuntimeError::StartFailed(_))
            );
            if model_failure && let Some(usage) = usage {
                usage.note_failure(
                    kind,
                    model,
                    &reason,
                    role.config.rate_limit_cooldown_minutes,
                );
            }
            if !model_failure || last {
                if failures.is_empty() {
                    return Err(error);
                }
                return Err(FleetError::new(
                    "fallbacks_exhausted",
                    format!("{reason}. Fallbacks exhausted: {}", failures.join("; ")),
                )
                .into());
            }
            failures.push(format!("{label}: {reason}"));
            skipped.push(SkippedCandidate {
                candidate: label.to_owned(),
                reason,
            });
        }
        Err(FleetError::new("no_candidates", "No model candidates to spawn.").into())
    }

    /// The spawn keeps its untried fallbacks for a failed first turn (`spawnPlans.set`); called
    /// before the task is handed over, so a first turn that settles at once finds the plan.
    pub(crate) fn keep_spawn_plan(&self, id: &str, request: &PlannedSpawn, fallbacks: &[String]) {
        let mut state = locked(&self.inner.candidates);
        // a run whose record went away, or whose pane ended, before its first turn settled leaves
        // its plan behind; a failed run keeps it until its settlement takes it (`respawn`)
        let registry = self.registry();
        state.plans.retain(|id, _| {
            registry
                .get(id)
                .is_some_and(|run| run.state != AgentState::Stopped)
        });
        state.plans.insert(
            id.to_owned(),
            SpawnPlan {
                request: request.clone(),
                fallbacks: fallbacks.to_vec(),
            },
        );
    }

    /// The run `id`'s turn of `generation` settled: a helper's failed first turn starts again on
    /// the next fallback, and the failed run names its replacement (`respawn`, and its condition
    /// in `finalize`). Later turns are not retried: by then the agent holds state a replacement
    /// would not have. A thread's lead starts again in a new lead run instead (#267).
    pub(crate) async fn respawn_after_failure(&self, id: &str, generation: u64) {
        let Some(plan) = locked(&self.inner.candidates).plans.remove(id) else {
            return;
        };
        let Some(run) = self.registry().get(id) else {
            return;
        };
        if is_thread(&run) || run.state != AgentState::Failed || generation != 1 {
            return;
        }
        let mut rest = plan.fallbacks.into_iter();
        let Some(next) = rest.next() else {
            return;
        };
        let request = PlannedSpawn {
            model: Some(next),
            thinking: None,
            ..plan.request
        };
        // boxed: the spawn's own turn settles through `finalize`, which calls this
        let cancel = CancellationToken::new();
        let replacement: BoxFuture<'_, Result<AgentRun, OrchestratorError>> = Box::pin(
            self.spawn_with_fallbacks(request, &cancel, Some(rest.collect()), run.model.clone()),
        );
        let replacement = replacement.await;
        let now = self.now();
        self.change(id, |run| {
            match replacement {
                Ok(replacement) => run.replaced_by = Some(replacement.id),
                Err(error) => {
                    run.last_error = Some(format!(
                        "{}; the configured fallback could not start: {error}",
                        run.last_error.as_deref().unwrap_or("failed")
                    ));
                }
            }
            run.updated_at = now;
        });
    }

    /// A CLI that shows its usage only on its own screen (cursor's `/usage`) is asked once a turn
    /// settled, when neither the last reading nor the last try is recent (`readUsageScreen`): the
    /// command is typed, the screen read until the usage shows, and Esc closes it. Never in an
    /// interactive run's pane, where a person may be typing. This runs inside the run's settlement
    /// lock and before the waiters hear of the settlement; `send` waits for that lock, so neither
    /// herdr's events nor a next task interleave. It ends once herdr calls the CLI settled again,
    /// so the pane is not taken for a working one.
    pub(crate) async fn read_usage_screen(&self, id: &str, config: &FleetConfig) {
        let Some(run) = self.registry().get(id) else {
            return;
        };
        let Some(usage) = self.deps().usage.as_deref() else {
            return;
        };
        let (Some(command), Some(reader)) = (
            adapter_for(run.agent).usage_command,
            usage_screen(run.agent),
        ) else {
            return;
        };
        if run.interactive || !usage.claim_screen(run.agent, run.model.as_deref()) {
            return;
        }
        let runtime = &self.deps().runtime;
        let wait = self.deps().timings.usage_screen;
        let name = run.herdr_name.as_str();
        // the usage is a hint for later spawns; this turn's outcome stands without it
        if runtime
            .prompt(name, command, &CancellationToken::new())
            .await
            .is_ok()
        {
            let deadline = Instant::now() + wait;
            while Instant::now() < deadline {
                tokio::time::sleep(USAGE_SCREEN_POLL).await;
                let screen = runtime
                    .read(name, read_lines(config))
                    .await
                    .unwrap_or_default();
                if let Some(reading) = reader(&screen, self.now()) {
                    usage.record(run.agent, run.model.as_deref(), reading);
                    break;
                }
            }
        }
        let _ = runtime.interrupt(name).await;
        let deadline = Instant::now() + wait;
        while Instant::now() < deadline
            && !is_completed(runtime.get(name).await.unwrap_or(AgentState::Idle))
        {
            tokio::time::sleep(USAGE_SCREEN_POLL).await;
        }
    }
}

impl UsageGate for UsageTracker {
    fn unavailable<'a>(
        &'a self,
        kind: FleetAgentKind,
        model: Option<&'a str>,
        max_used_percent: f64,
    ) -> BoxFuture<'a, Option<String>> {
        Box::pin(UsageTracker::unavailable(
            self,
            kind,
            model,
            max_used_percent,
        ))
    }

    fn note_failure(
        &self,
        kind: FleetAgentKind,
        model: Option<&str>,
        message: &str,
        cooldown_minutes: f64,
    ) {
        UsageTracker::note_failure(self, kind, model, message, cooldown_minutes);
    }

    fn claim_screen(&self, kind: FleetAgentKind, model: Option<&str>) -> bool {
        UsageTracker::claim_screen(self, kind, model)
    }

    fn record(&self, kind: FleetAgentKind, model: Option<&str>, reading: UsageReading) {
        UsageTracker::record(self, kind, model, reading);
    }
}

impl ModelGate for ModelCatalog {
    fn unknown<'a>(
        &'a self,
        kind: FleetAgentKind,
        model: Option<&'a str>,
    ) -> BoxFuture<'a, Option<String>> {
        Box::pin(ModelCatalog::unknown(self, kind, model))
    }
}
