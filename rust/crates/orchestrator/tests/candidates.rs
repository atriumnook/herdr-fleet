//! The candidates a spawn tries: the thinking policy of a model, the fallbacks after a failed
//! start or first turn, a model the CLI does not offer, and the routing by usage (cursor's `/usage`
//! screen included). The tests named after an `it` are `server/fleet/orchestrator.test.ts`'s
//! describes `model thinking policy`, `model fallbacks`, `a model the CLI does not offer`, `usage
//! routing`, and the last `it` of `agent kinds`, with their expected values. The last ones check
//! what ADR 0248-launch-adapters gives the candidate loop (the roles a CLI cannot take) and the
//! `ModelGate` impl over L4's catalog.

mod common;

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use child_process::Env;
use common::{
    FakeRuntime, Folder, GRACE, Prompted, Setup, SetupOptions, TestClock, request, role, setup,
    sleep_ms, spawn, start_wait, until, write_report,
};
use herdr_fleet_orchestrator::Clock;
use herdr_fleet_orchestrator::agents::AgentDefinition;
use herdr_fleet_orchestrator::fleet::{
    BoxFuture, ModelGate, Orchestrator, OrchestratorError, SpawnRequest, Timings,
    apply_model_policy,
};
use herdr_fleet_orchestrator::models::{CatalogOptions, ListOptions, ModelCatalog, ModelSource};
use herdr_fleet_orchestrator::registry::RunRegistry;
use herdr_fleet_orchestrator::runtime::{
    AgentMetadata, AgentRuntime, CreateLocationOptions, RuntimeError, RuntimeFuture,
    RuntimeLocation, StartOptions,
};
use herdr_fleet_orchestrator::usage::{UsageTracker, UsageTrackerOptions};
use protocol::{
    AgentRun, AgentState, FleetAgentKind, ListedModel, SkippedCandidate, ThinkingLevel,
    UsageReading, UsageWindow,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn skipped(candidate: &str, reason: &str) -> SkippedCandidate {
    SkippedCandidate {
        candidate: candidate.to_owned(),
        reason: reason.to_owned(),
    }
}

fn fleet_error(error: &OrchestratorError) -> (&str, String) {
    (error.code(), error.to_string())
}

fn with(agents: Vec<AgentDefinition>, config: Value) -> Setup {
    setup(SetupOptions {
        agents: Some(agents),
        config: Some(config),
        ..SetupOptions::default()
    })
}

fn fail_start(message: &str) -> Result<AgentState, RuntimeError> {
    Err(RuntimeError::StartFailed(message.to_owned()))
}

// describe("model thinking policy")

fn strong_config() -> herdr_fleet_orchestrator::config::FleetConfig {
    common::config(Some(
        &json!({ "models": { "p/strong": { "thinking": ["low", "medium"] } } }),
    ))
}

// orchestrator.test.ts: "refuses an explicit level or a :level suffix outside the model's list"
#[test]
fn refuses_an_explicit_level_or_a_level_suffix_outside_the_models_list() {
    let config = strong_config();
    let error =
        apply_model_policy(&config, Some("p/strong"), Some(ThinkingLevel::High), true).unwrap_err();
    assert_eq!(
        error.message,
        "Thinking level \"high\" is not allowed for p/strong. Allowed: low, medium."
    );
    assert_eq!(error.code, "thinking_not_allowed");
    assert!(apply_model_policy(&config, Some("p/strong:max"), None, false).is_err());
}

// orchestrator.test.ts: "lowers an inherited level to the highest allowed one, and leaves models without a list alone"
#[test]
fn lowers_an_inherited_level_to_the_highest_allowed_one_and_leaves_models_without_a_list_alone() {
    let config = strong_config();
    assert_eq!(
        apply_model_policy(&config, Some("p/strong"), Some(ThinkingLevel::Max), false).unwrap(),
        Some(ThinkingLevel::Medium)
    );
    assert_eq!(
        apply_model_policy(&config, Some("p/strong"), Some(ThinkingLevel::Low), true).unwrap(),
        Some(ThinkingLevel::Low)
    );
    assert_eq!(
        apply_model_policy(&config, Some("p/other"), Some(ThinkingLevel::Max), true).unwrap(),
        Some(ThinkingLevel::Max)
    );
}

// orchestrator.test.ts: "applies to role-level levels on spawn, before any pane"
#[tokio::test(start_paused = true)]
async fn applies_to_role_level_levels_on_spawn_before_any_pane() {
    let s = with(
        vec![AgentDefinition {
            model: Some("p/strong".to_owned()),
            thinking: Some(ThinkingLevel::High),
            ..role("worker")
        }],
        json!({ "models": { "p/strong": { "thinking": ["low"] } } }),
    );
    let error = spawn(&s.fleet, request()).await.unwrap_err();
    assert_eq!(error.code(), "thinking_not_allowed");
    assert!(s.runtime.locations().is_empty());
}

// describe("model fallbacks")

fn fallback_role() -> Vec<AgentDefinition> {
    vec![AgentDefinition {
        model: Some("p/primary".to_owned()),
        fallback_models: Some(strings(&["p/second", "p/third"])),
        ..role("worker")
    }]
}

// orchestrator.test.ts: "moves to the next configured model when the agent quits at startup"
#[tokio::test(start_paused = true)]
async fn moves_to_the_next_configured_model_when_the_agent_quits_at_startup() {
    let s = with(fallback_role(), json!({}));
    s.runtime.on_start(|options: StartOptions| async move {
        if options.args.iter().any(|arg| arg == "p/primary") {
            return fail_start("Model \"p/primary\" not found");
        }
        Ok(AgentState::Idle)
    });
    let run = spawn(&s.fleet, request()).await.unwrap();
    assert_eq!(run.model.as_deref(), Some("p/second"));
    assert_eq!(run.fallback_from.as_deref(), Some("p/primary"));
    assert_eq!(run.state, AgentState::Working);
    assert_eq!(s.runtime.closed(), strings(&["w1:p1"]));
}

// orchestrator.test.ts: "does not fall back on errors that are not the model's, and reports every failure once all are spent"
#[tokio::test(start_paused = true)]
async fn does_not_fall_back_on_errors_that_are_not_the_models_and_reports_every_failure_once_all_are_spent()
 {
    // TypeScript's HerdrError("pane_not_found") is RuntimeError::NotFound here (runtime.rs)
    let other = with(fallback_role(), json!({}));
    other
        .runtime
        .on_start(|_| async { Err(RuntimeError::NotFound) });
    let error = spawn(&other.fleet, request()).await.unwrap_err();
    assert!(matches!(
        error,
        OrchestratorError::Runtime(RuntimeError::NotFound)
    ));
    assert_eq!(other.runtime.starts().len(), 1);

    let spent = with(fallback_role(), json!({}));
    spent.runtime.on_start(|options: StartOptions| async move {
        fail_start(&format!("{} down", options.args[1]))
    });
    let error = spawn(&spent.fleet, request()).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "p/third down. Fallbacks exhausted: p/primary: p/primary down; p/second: p/second down"
    );
}

// orchestrator.test.ts: "bounds a fallback model by its own allow-list instead of refusing it"
#[tokio::test(start_paused = true)]
async fn bounds_a_fallback_model_by_its_own_allow_list_instead_of_refusing_it() {
    let s = with(
        vec![AgentDefinition {
            model: Some("p/primary".to_owned()),
            thinking: Some(ThinkingLevel::High),
            fallback_models: Some(strings(&["p/small"])),
            ..role("worker")
        }],
        json!({ "models": { "p/small": { "thinking": ["low"] } } }),
    );
    s.runtime.on_start(|options: StartOptions| async move {
        if options.args.iter().any(|arg| arg.starts_with("p/primary")) {
            return fail_start("no");
        }
        Ok(AgentState::Idle)
    });
    let run = spawn(&s.fleet, request()).await.unwrap();
    assert_eq!(run.model.as_deref(), Some("p/small"));
    assert_eq!(run.thinking, Some(ThinkingLevel::Low));
}

// orchestrator.test.ts: "re-spawns the task on the next model when the first turn ends in an API error, and names the replacement"
#[tokio::test(start_paused = true)]
async fn re_spawns_the_task_on_the_next_model_when_the_first_turn_ends_in_an_api_error_and_names_the_replacement()
 {
    let s = with(fallback_role(), json!({}));
    let run = spawn(&s.fleet, request()).await.unwrap();
    let waiting = start_wait(&s.fleet, &run.id, 2000, "g1").await;
    s.runtime.set_get_status(AgentState::Idle);
    s.runtime.set_output("Error: 429 rate limited");
    sleep_ms(GRACE.as_millis() as u64 + 5).await;
    s.runtime.set_output("Error: 429 rate limited");
    s.fleet.on_pane_status(&run.pane_id);
    let failed = waiting.await.unwrap().unwrap();
    assert_eq!(failed.state, AgentState::Failed);
    assert_eq!(failed.last_error.as_deref(), Some("429 rate limited"));
    let replacement = s
        .fleet
        .get(failed.replaced_by.as_deref().unwrap(), Some("g1"))
        .unwrap();
    assert_eq!(replacement.model.as_deref(), Some("p/second"));
    assert_eq!(replacement.fallback_from.as_deref(), Some("p/primary"));
    let texts: Vec<String> = s.runtime.prompts().into_iter().map(|p| p.text).collect();
    assert_eq!(texts, strings(&["do it", "do it"]));
}

// orchestrator.test.ts: "does not count an Error: line inside a real handoff, and never re-spawns after a later turn"
#[tokio::test(start_paused = true)]
async fn does_not_count_an_error_line_inside_a_real_handoff_and_never_re_spawns_after_a_later_turn()
{
    // closeOnSettle off: a non-interactive pane closes once its turn settles, and a second turn needs it
    let s = with(fallback_role(), json!({ "closeOnSettle": false }));
    let run = spawn(&s.fleet, request()).await.unwrap();
    s.runtime.set_get_status(AgentState::Idle);
    s.runtime
        .set_output("Error: flaky test, fixed\nHANDOFF: done");
    sleep_ms(GRACE.as_millis() as u64 + 5).await;
    s.fleet.on_pane_status(&run.pane_id);
    let first = start_wait(&s.fleet, &run.id, 2000, "g1").await;
    assert_eq!(first.await.unwrap().unwrap().state, AgentState::Idle);

    s.runtime.set_get_status(AgentState::Working);
    s.fleet
        .send(&run.id, "again", Some("g1"), &CancellationToken::new())
        .await
        .unwrap();
    let waiting = start_wait(&s.fleet, &run.id, 2000, "g1").await;
    s.runtime.set_get_status(AgentState::Idle);
    s.runtime.set_output("Error: quota");
    sleep_ms(GRACE.as_millis() as u64 + 5).await;
    s.fleet.on_pane_status(&run.pane_id);
    let failed = waiting.await.unwrap().unwrap();
    assert_eq!(failed.state, AgentState::Failed);
    assert_eq!(failed.last_error.as_deref(), Some("quota"));
    assert_eq!(s.fleet.get(&run.id, None).unwrap().replaced_by, None);
    assert_eq!(s.runtime.starts().len(), 1);
}

// describe("a model the CLI does not offer")

/// `offers(...names)`: a catalog that knows only `names` (orchestrator.test.ts:524).
struct Offers(Vec<String>);

impl ModelGate for Offers {
    fn unknown<'a>(
        &'a self,
        kind: FleetAgentKind,
        model: Option<&'a str>,
    ) -> BoxFuture<'a, Option<String>> {
        let refused = model
            .filter(|model| !self.0.iter().any(|name| name == model))
            .map(|model| format!("{} does not offer a model named {model}", kind.name()));
        Box::pin(async move { refused })
    }
}

fn offering(agents: Vec<AgentDefinition>, names: &[&str]) -> Setup {
    setup(SetupOptions {
        agents: Some(agents),
        models: Some(Arc::new(Offers(strings(names)))),
        ..SetupOptions::default()
    })
}

// orchestrator.test.ts: "is passed over for the next candidate before any pane opens"
#[tokio::test(start_paused = true)]
async fn is_passed_over_for_the_next_candidate_before_any_pane_opens() {
    let s = offering(
        vec![AgentDefinition {
            model: Some("p/primary".to_owned()),
            fallback_models: Some(strings(&["codex:gpt-6"])),
            ..role("worker")
        }],
        &["gpt-6"],
    );
    let run = spawn(&s.fleet, request()).await.unwrap();
    assert_eq!(run.agent, FleetAgentKind::Codex);
    assert_eq!(run.model.as_deref(), Some("gpt-6"));
    assert_eq!(run.fallback_from.as_deref(), Some("p/primary"));
    assert_eq!(
        run.skipped,
        Some(vec![skipped(
            "p/primary",
            "pi does not offer a model named p/primary"
        )])
    );
    assert_eq!(s.runtime.locations().len(), 1);
}

// orchestrator.test.ts: "refuses the spawn, with every reason, when no candidate is left"
#[tokio::test(start_paused = true)]
async fn refuses_the_spawn_with_every_reason_when_no_candidate_is_left() {
    let s = offering(
        vec![AgentDefinition {
            model: Some("nope".to_owned()),
            ..role("worker")
        }],
        &[],
    );
    let error = spawn(&s.fleet, request()).await.unwrap_err();
    let (code, message) = fleet_error(&error);
    assert_eq!(code, "no_candidates");
    assert!(message.contains("nope: pi does not offer a model named nope"));
    assert!(s.runtime.locations().is_empty());
}

// describe("usage routing")

/// A tracker that keeps nothing on disk and asks no CLI, on the setup's clock.
fn tracker(clock: &Arc<dyn Clock>) -> UsageTracker {
    UsageTracker::new(UsageTrackerOptions::new(None, clock.clone()))
}

/// `full`: a 5h window 95% used, resetting in an hour (orchestrator.test.ts:545).
fn full(now: f64) -> UsageReading {
    UsageReading {
        read_at: now,
        windows: vec![UsageWindow {
            name: "5h".to_owned(),
            used_percent: 95.0,
            resets_at: Some(now + 3_600_000.0),
        }],
    }
}

fn cross_role() -> Vec<AgentDefinition> {
    vec![AgentDefinition {
        model: Some("p/primary".to_owned()),
        fallback_models: Some(strings(&["codex:gpt-6", "claude:sonnet"])),
        ..role("worker")
    }]
}

/// A setup whose spawns route by `usage`, on `clock`.
fn routed(
    agents: Vec<AgentDefinition>,
    usage: &UsageTracker,
    clock: &Arc<dyn Clock>,
    config: Value,
) -> Setup {
    setup(SetupOptions {
        agents: Some(agents),
        config: Some(config),
        usage: Some(Arc::new(usage.clone())),
        clock: Some(clock.clone()),
        ..SetupOptions::default()
    })
}

fn now(clock: &Arc<dyn Clock>) -> f64 {
    clock.now_ms() as f64
}

// orchestrator.test.ts: "skips a candidate whose account is used past the threshold, onto another CLI"
#[tokio::test(start_paused = true)]
async fn skips_a_candidate_whose_account_is_used_past_the_threshold_onto_another_cli() {
    let clock: Arc<dyn Clock> = TestClock::new();
    let usage = tracker(&clock);
    usage.record(FleetAgentKind::Pi, Some("p/primary"), full(now(&clock)));
    let s = routed(cross_role(), &usage, &clock, json!({}));
    let run = spawn(&s.fleet, request()).await.unwrap();
    assert_eq!(run.agent, FleetAgentKind::Codex);
    assert_eq!(run.model.as_deref(), Some("gpt-6"));
    assert_eq!(run.fallback_from.as_deref(), Some("p/primary"));
    assert_eq!(run.state, AgentState::Working);
    // the run keeps why it is not on the primary, for the Fleet screen
    let skipped = run.skipped.unwrap();
    assert_eq!(skipped.len(), 1);
    assert_eq!(skipped[0].candidate, "p/primary");
    assert!(
        skipped[0]
            .reason
            .contains("pi:p has used 95% of its 5h limit")
    );
    let kinds: Vec<FleetAgentKind> = s.runtime.starts().iter().map(|s| s.kind).collect();
    assert_eq!(kinds, vec![FleetAgentKind::Codex]);
    assert_eq!(s.runtime.locations().len(), 1);
}

// orchestrator.test.ts: "refuses the spawn, before any pane, when no candidate has usage left"
#[tokio::test(start_paused = true)]
async fn refuses_the_spawn_before_any_pane_when_no_candidate_has_usage_left() {
    let clock: Arc<dyn Clock> = TestClock::new();
    let usage = tracker(&clock);
    usage.record(FleetAgentKind::Pi, Some("p/primary"), full(now(&clock)));
    usage.record(FleetAgentKind::Codex, None, full(now(&clock)));
    usage.note_failure(
        FleetAgentKind::Claude,
        Some("sonnet"),
        "rate limit reached",
        60.0,
    );
    let s = routed(
        cross_role(),
        &usage,
        &clock,
        json!({ "maxUsedPercent": 95 }),
    );
    let error = spawn(&s.fleet, request()).await.unwrap_err();
    let (code, message) = fleet_error(&error);
    assert_eq!(code, "usage_exhausted");
    assert!(message.contains("p/primary: pi:p has used 95% of its 5h limit"));
    assert!(message.contains("claude:sonnet: claude is cooling down"));
    assert!(s.runtime.locations().is_empty());
}

// orchestrator.test.ts: "keeps the CLIs a caller avoids out, onto the next candidate, and says why"
#[tokio::test(start_paused = true)]
async fn keeps_the_clis_a_caller_avoids_out_onto_the_next_candidate_and_says_why() {
    let s = with(cross_role(), json!({}));
    let run = spawn(
        &s.fleet,
        SpawnRequest {
            avoid: Some(vec![FleetAgentKind::Pi]),
            ..request()
        },
    )
    .await
    .unwrap();
    assert_eq!(run.agent, FleetAgentKind::Codex);
    assert_eq!(run.model.as_deref(), Some("gpt-6"));
    assert_eq!(run.fallback_from.as_deref(), Some("p/primary"));
    assert_eq!(
        run.skipped,
        Some(vec![skipped("p/primary", "the caller keeps pi out")])
    );
    let kinds: Vec<FleetAgentKind> = s.runtime.starts().iter().map(|s| s.kind).collect();
    assert_eq!(kinds, vec![FleetAgentKind::Codex]);
}

// orchestrator.test.ts: "refuses the spawn, before any pane, when the caller avoids every candidate's CLI"
#[tokio::test(start_paused = true)]
async fn refuses_the_spawn_before_any_pane_when_the_caller_avoids_every_candidates_cli() {
    let s = with(cross_role(), json!({}));
    let error = spawn(
        &s.fleet,
        SpawnRequest {
            avoid: Some(vec![
                FleetAgentKind::Pi,
                FleetAgentKind::Codex,
                FleetAgentKind::Claude,
            ]),
            ..request()
        },
    )
    .await
    .unwrap_err();
    let (code, message) = fleet_error(&error);
    assert_eq!(code, "no_candidates");
    assert!(message.contains("claude:sonnet: the caller keeps claude out"));
    assert!(s.runtime.locations().is_empty());
}

// orchestrator.test.ts: "plays a role that edits nothing only on a CLI that can be held to that, with its editing tools off"
#[tokio::test(start_paused = true)]
async fn plays_a_role_that_edits_nothing_only_on_a_cli_that_can_be_held_to_that_with_its_editing_tools_off()
 {
    let s = with(
        vec![AgentDefinition {
            model: Some("codex:gpt-6".to_owned()),
            fallback_models: Some(strings(&["claude:sonnet"])),
            edits: Some(false),
            ..role("auditor")
        }],
        json!({}),
    );
    let run = spawn(
        &s.fleet,
        SpawnRequest {
            role: "auditor".to_owned(),
            ..request()
        },
    )
    .await
    .unwrap();
    assert_eq!(run.agent, FleetAgentKind::Claude);
    assert_eq!(run.model.as_deref(), Some("sonnet"));
    assert_eq!(
        run.skipped,
        Some(vec![skipped(
            "codex:gpt-6",
            "codex cannot be kept from editing files"
        )])
    );
    assert!(
        s.runtime.starts()[0]
            .args
            .join(" ")
            .contains("--disallowedTools Edit,Write,NotebookEdit")
    );
    assert!(s.runtime.instructions()[0].contains(
        "your file-editing tools are off: write your result file and your report file with a shell command"
    ));
}

// orchestrator.test.ts: "holds a pi role that edits nothing with pi's own denylist, whatever tools the role lists"
#[tokio::test(start_paused = true)]
async fn holds_a_pi_role_that_edits_nothing_with_pis_own_denylist_whatever_tools_the_role_lists() {
    let s = with(
        vec![AgentDefinition {
            agent: FleetAgentKind::Pi,
            model: Some("p/primary".to_owned()),
            tools: Some(strings(&["read", "bash", "edit", "write"])),
            edits: Some(false),
            interactive: Some(true),
            spawning: Some(true),
            ..role("keeper")
        }],
        json!({}),
    );
    let run = spawn(
        &s.fleet,
        SpawnRequest {
            role: "keeper".to_owned(),
            ..request()
        },
    )
    .await
    .unwrap();
    assert_eq!(run.agent, FleetAgentKind::Pi);
    assert!(run.interactive);
    let args = s.runtime.starts()[0].args.clone();
    assert!(args.join(" ").contains("--exclude-tools edit,write"));
    let position = |flag: &str| args.iter().position(|arg| arg == flag).unwrap();
    assert!(position("--exclude-tools") > position("--tools"));
    assert!(s.runtime.instructions()[0].contains("your file-editing tools are off"));
}

// orchestrator.test.ts: "refuses a role that edits nothing when no candidate CLI can be held to that"
#[tokio::test(start_paused = true)]
async fn refuses_a_role_that_edits_nothing_when_no_candidate_cli_can_be_held_to_that() {
    let s = with(
        vec![AgentDefinition {
            model: Some("codex:gpt-6".to_owned()),
            fallback_models: Some(strings(&["cursor:auto"])),
            edits: Some(false),
            ..role("auditor")
        }],
        json!({}),
    );
    let error = spawn(
        &s.fleet,
        SpawnRequest {
            role: "auditor".to_owned(),
            ..request()
        },
    )
    .await
    .unwrap_err();
    let (code, message) = fleet_error(&error);
    assert_eq!(code, "no_candidates");
    assert!(message.contains("cursor:auto: cursor cannot be kept from editing files"));
    assert!(s.runtime.locations().is_empty());
}

// orchestrator.test.ts: "leaves a role's editing tools as they are unless it says it edits nothing"
#[tokio::test(start_paused = true)]
async fn leaves_a_roles_editing_tools_as_they_are_unless_it_says_it_edits_nothing() {
    let s = with(
        vec![AgentDefinition {
            model: Some("claude:sonnet".to_owned()),
            ..role("worker")
        }],
        json!({}),
    );
    spawn(&s.fleet, request()).await.unwrap();
    assert!(
        !s.runtime.starts()[0]
            .args
            .iter()
            .any(|arg| arg == "--disallowedTools")
    );
}

// orchestrator.test.ts: "lets a caller pick another CLI with an <agent>:<model> model"
#[tokio::test(start_paused = true)]
async fn lets_a_caller_pick_another_cli_with_an_agent_model_model() {
    let s = setup(SetupOptions::default());
    let run = spawn(
        &s.fleet,
        SpawnRequest {
            model: Some("agy:gemini-pro".to_owned()),
            ..request()
        },
    )
    .await
    .unwrap();
    assert_eq!(run.agent, FleetAgentKind::Agy);
    assert_eq!(run.model.as_deref(), Some("gemini-pro"));
    assert_eq!(s.runtime.starts()[0].kind, FleetAgentKind::Agy);
}

// orchestrator.test.ts: "cools down the account a start quit on with a rate limit, and moves on"
#[tokio::test(start_paused = true)]
async fn cools_down_the_account_a_start_quit_on_with_a_rate_limit_and_moves_on() {
    let clock: Arc<dyn Clock> = TestClock::new();
    let usage = tracker(&clock);
    let s = routed(cross_role(), &usage, &clock, json!({}));
    s.runtime.on_start(|options: StartOptions| async move {
        if options.kind == FleetAgentKind::Pi {
            return fail_start("429 Too Many Requests");
        }
        Ok(AgentState::Idle)
    });
    let run = spawn(&s.fleet, request()).await.unwrap();
    assert_eq!(run.agent, FleetAgentKind::Codex);
    assert_eq!(
        run.skipped,
        Some(vec![skipped("p/primary", "429 Too Many Requests")])
    );
    let reason = usage
        .unavailable(FleetAgentKind::Pi, Some("p/primary"), 90.0)
        .await
        .unwrap();
    assert!(reason.contains("pi:p is cooling down"));
}

// orchestrator.test.ts: "cools down the account a first turn hit a rate limit on, and re-spawns past it"
#[tokio::test(start_paused = true)]
async fn cools_down_the_account_a_first_turn_hit_a_rate_limit_on_and_re_spawns_past_it() {
    let clock: Arc<dyn Clock> = TestClock::new();
    let usage = tracker(&clock);
    let s = routed(
        vec![AgentDefinition {
            agent: FleetAgentKind::Claude,
            model: Some("sonnet".to_owned()),
            fallback_models: Some(strings(&["opus", "codex:gpt-6"])),
            ..role("worker")
        }],
        &usage,
        &clock,
        json!({}),
    );
    let run = spawn(&s.fleet, request()).await.unwrap();
    let waiting = start_wait(&s.fleet, &run.id, 2000, "g1").await;
    s.runtime.set_get_status(AgentState::Idle);
    s.runtime
        .set_output("⎿  API Error: Claude usage limit reached. Your limit will reset in 2 hours");
    sleep_ms(GRACE.as_millis() as u64 + 5).await;
    s.fleet.on_pane_status(&run.pane_id);
    let failed = waiting.await.unwrap().unwrap();
    assert_eq!(failed.state, AgentState::Failed);
    // opus draws on the same claude account: the replacement skips it
    let replacement = s
        .fleet
        .get(failed.replaced_by.as_deref().unwrap(), Some("g1"))
        .unwrap();
    assert_eq!(replacement.agent, FleetAgentKind::Codex);
    assert_eq!(replacement.model.as_deref(), Some("gpt-6"));
    assert_eq!(replacement.fallback_from.as_deref(), Some("opus"));
    let claude = usage
        .list()
        .into_iter()
        .find(|entry| entry.key == "claude")
        .unwrap();
    assert!(claude.cooldown.unwrap().until > now(&clock) + 7_000_000.0);
}

// describe("cursor's /usage screen")

const INPUT: &str = "→ Plan, search, build anything";
const PAGER: &str = "Usage · Pro    Resets Oct 23\nIncluded        12% used        ███░░░";

/// herdr as `FakeRuntime` stands it in, with what an Esc does replaceable (`interruptImpl`,
/// orchestrator.test.ts:63-64): the shared fake has no such hook.
struct EscRuntime {
    fake: Arc<FakeRuntime>,
    on_interrupt: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}

impl EscRuntime {
    fn on_interrupt(&self, imp: impl Fn() + Send + Sync + 'static) {
        *self
            .on_interrupt
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(Box::new(imp));
    }
}

impl AgentRuntime for EscRuntime {
    fn create_location<'a>(
        &'a self,
        options: CreateLocationOptions,
        cancel: &'a CancellationToken,
    ) -> RuntimeFuture<'a, RuntimeLocation> {
        self.fake.create_location(options, cancel)
    }
    fn start(&self, options: StartOptions) -> RuntimeFuture<'_, AgentState> {
        self.fake.start(options)
    }
    fn close_pane<'a>(&'a self, pane_id: &'a str) -> RuntimeFuture<'a, ()> {
        self.fake.close_pane(pane_id)
    }
    fn prompt<'a>(
        &'a self,
        name: &'a str,
        text: &'a str,
        cancel: &'a CancellationToken,
    ) -> RuntimeFuture<'a, AgentState> {
        self.fake.prompt(name, text, cancel)
    }
    fn get<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, AgentState> {
        self.fake.get(name)
    }
    fn read<'a>(&'a self, name: &'a str, lines: u32) -> RuntimeFuture<'a, String> {
        self.fake.read(name, lines)
    }
    fn screen<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, String> {
        self.fake.screen(name)
    }
    fn interrupt<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, ()> {
        if let Some(imp) = &*self
            .on_interrupt
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
        {
            imp();
        }
        self.fake.interrupt(name)
    }
    fn focus<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, ()> {
        self.fake.focus(name)
    }
    fn report_metadata(&self, metadata: AgentMetadata) -> RuntimeFuture<'_, ()> {
        self.fake.report_metadata(metadata)
    }
}

/// A fleet of cursor workers over [`EscRuntime`], as `setup` builds one.
struct CursorSetup {
    fleet: Orchestrator,
    fake: Arc<FakeRuntime>,
    esc: Arc<EscRuntime>,
    folder: Folder,
}

fn cursor_setup(usage: &UsageTracker, interactive: bool, config: &Value) -> CursorSetup {
    let folder = Folder::new();
    let clock: Arc<dyn Clock> = TestClock::new();
    let fake = FakeRuntime::new();
    let esc = Arc::new(EscRuntime {
        fake: fake.clone(),
        on_interrupt: Mutex::new(None),
    });
    let registry = Arc::new(RunRegistry::open(
        Some(folder.path().join("runs.json")),
        clock.as_ref(),
    ));
    let roles = vec![AgentDefinition {
        agent: FleetAgentKind::Cursor,
        interactive: Some(interactive),
        ..role("worker")
    }];
    let mut deps = common::deps(
        fake.clone(),
        registry,
        folder.path(),
        clock,
        common::config(Some(config)),
        roles,
    );
    deps.runtime = esc.clone();
    deps.usage = Some(Arc::new(usage.clone()));
    deps.timings = Timings {
        pre_visual_grace: GRACE,
        ready_screen: Duration::from_millis(300),
        usage_screen: Duration::from_millis(300),
        ..Timings::default()
    };
    CursorSetup {
        fleet: Orchestrator::new(deps).unwrap(),
        fake,
        esc,
        folder,
    }
}

/// `settleCursorTurn` (orchestrator.test.ts:660-684): a cursor worker's first turn settles with
/// its report written; herdr calls it working while the pager loads, and idle a moment after Esc.
async fn settle_cursor_turn(
    usage: &UsageTracker,
    pager_after_prompt: bool,
    interactive: bool,
) -> (AgentRun, AgentRun, CursorSetup) {
    let c = cursor_setup(usage, interactive, &json!({}));
    c.fake.set_output(INPUT);
    let run = spawn(&c.fleet, request()).await.unwrap();
    // a turn that wrote its report: only such a turn's pane closes on settle
    write_report(c.folder.path(), &run.id, "ready", "Done.");
    let (fake, fleet, pane) = (c.fake.clone(), c.fleet.clone(), run.pane_id.clone());
    c.fake.on_prompt(move |name, text, _cancel| {
        fake.recorded().prompts.push(Prompted {
            name,
            text: text.clone(),
        });
        if text == "/usage" {
            fake.set_get_status(AgentState::Working);
            fleet.on_pane_status(&pane);
            if pager_after_prompt {
                fake.set_output(&format!("{INPUT}\n{PAGER}"));
            }
        }
        async { Ok(AgentState::Working) }
    });
    let fake = c.fake.clone();
    c.esc.on_interrupt(move || {
        let fake = fake.clone();
        tokio::spawn(async move {
            sleep_ms(100).await;
            fake.set_get_status(AgentState::Idle);
        });
    });
    let waiting = start_wait(&c.fleet, &run.id, 2000, "g1").await;
    c.fake.set_get_status(AgentState::Idle);
    c.fake.set_output(&format!("{INPUT}\n● done"));
    sleep_ms(GRACE.as_millis() as u64 + 5).await;
    c.fleet.on_pane_status(&run.pane_id);
    let settled = waiting.await.unwrap().unwrap();
    (settled, run, c)
}

fn texts(fake: &FakeRuntime) -> Vec<String> {
    fake.prompts().into_iter().map(|p| p.text).collect()
}

// orchestrator.test.ts: "is read once a turn settles, then closed, and the run stays settled"
#[tokio::test(start_paused = true)]
async fn is_read_once_a_turn_settles_then_closed_and_the_run_stays_settled() {
    let usage = tracker(&(TestClock::new() as Arc<dyn Clock>));
    let (settled, run, c) = settle_cursor_turn(&usage, true, false).await;
    assert_eq!(settled.state, AgentState::Idle);
    // the non-interactive pane closes on settle: herdr's working during the pager did not hold it open
    until(|| c.fake.closed().contains(&run.pane_id), "pane closed").await;
    assert_eq!(
        c.fleet.get(&run.id, None).unwrap().state,
        AgentState::Stopped
    );
    assert_eq!(texts(&c.fake).last().map(String::as_str), Some("/usage"));
    assert_eq!(c.fake.recorded().interrupts, 1);
    let cursor = usage
        .list()
        .into_iter()
        .find(|entry| entry.key == "cursor")
        .unwrap();
    let window = cursor.reading.unwrap().windows[0].clone();
    assert_eq!(window.name, "monthly");
    assert!((window.used_percent - 12.0).abs() < f64::EPSILON);
}

// orchestrator.test.ts: "holds a send made while it reads until the pager is closed"
#[tokio::test(start_paused = true)]
async fn holds_a_send_made_while_it_reads_until_the_pager_is_closed() {
    let usage = tracker(&(TestClock::new() as Arc<dyn Clock>));
    let c = cursor_setup(&usage, false, &json!({ "closeOnSettle": false }));
    c.fake.set_output(INPUT);
    let run = spawn(&c.fleet, request()).await.unwrap();
    type Sent = tokio::task::JoinHandle<Result<AgentRun, OrchestratorError>>;
    let sent: Arc<Mutex<Option<Sent>>> = Arc::new(Mutex::new(None));
    let (fake, fleet, id, slot) = (
        c.fake.clone(),
        c.fleet.clone(),
        run.id.clone(),
        sent.clone(),
    );
    c.fake.on_prompt(move |name, text, _cancel| {
        fake.recorded().prompts.push(Prompted {
            name,
            text: text.clone(),
        });
        if text == "/usage" {
            fake.set_output(&format!("{INPUT}\n{PAGER}"));
            let (fleet, id) = (fleet.clone(), id.clone());
            *slot.lock().unwrap() = Some(tokio::spawn(async move {
                fleet
                    .send(&id, "next task", Some("g1"), &CancellationToken::new())
                    .await
            }));
        }
        async { Ok(AgentState::Working) }
    });
    let (fake, name) = (c.fake.clone(), run.herdr_name.clone());
    c.esc.on_interrupt(move || {
        fake.recorded().prompts.push(Prompted {
            name: name.clone(),
            text: "<esc>".to_owned(),
        });
    });
    c.fake.set_get_status(AgentState::Idle);
    c.fake.set_output(&format!("{INPUT}\n● done"));
    sleep_ms(GRACE.as_millis() as u64 + 5).await;
    c.fleet.on_pane_status(&run.pane_id);
    until(
        || sent.lock().unwrap().is_some(),
        "send made during the read",
    )
    .await;
    let handle = sent.lock().unwrap().take().unwrap();
    handle.await.unwrap().unwrap();
    // Esc closed the pager before the next task was typed, not after
    let texts = texts(&c.fake);
    assert_eq!(
        texts[texts.len() - 3..].to_vec(),
        strings(&["/usage", "<esc>", "next task"])
    );
}

// orchestrator.test.ts: "is not asked in an interactive run or while the last reading is fresh, and a screen that never shows it costs only the wait"
#[tokio::test(start_paused = true)]
async fn is_not_asked_in_an_interactive_run_or_while_the_last_reading_is_fresh_and_a_screen_that_never_shows_it_costs_only_the_wait()
 {
    let clock: Arc<dyn Clock> = TestClock::new();
    let fresh = tracker(&clock);
    fresh.record(
        FleetAgentKind::Cursor,
        None,
        UsageReading {
            read_at: now(&clock),
            windows: Vec::new(),
        },
    );
    let (_, _, first) = settle_cursor_turn(&fresh, true, false).await;
    assert!(!texts(&first.fake).contains(&"/usage".to_owned()));
    // a person may be typing in an interactive run's pane
    let (_, _, interactive) = settle_cursor_turn(&tracker(&clock), true, true).await;
    assert!(!texts(&interactive.fake).contains(&"/usage".to_owned()));

    let empty = tracker(&clock);
    let (settled, _, second) = settle_cursor_turn(&empty, false, false).await;
    assert_eq!(settled.state, AgentState::Idle);
    assert_eq!(second.fake.recorded().interrupts, 1);
    assert!(empty.list().is_empty());
}

// describe("agent kinds")

// orchestrator.test.ts: "treats a start that ignored the model as a failed start, so the next model is tried"
#[tokio::test(start_paused = true)]
async fn treats_a_start_that_ignored_the_model_as_a_failed_start_so_the_next_model_is_tried() {
    let s = with(
        vec![AgentDefinition {
            agent: FleetAgentKind::Agy,
            model: Some("no-such".to_owned()),
            fallback_models: Some(strings(&["gemini-pro"])),
            ..role("worker")
        }],
        json!({}),
    );
    let runtime = s.runtime.clone();
    s.runtime.on_start(move |options: StartOptions| {
        let output = if options.args.iter().any(|arg| arg == "no-such") {
            "model no-such is not recognized as a known model or custom model"
        } else {
            "ready"
        };
        runtime.set_output(output);
        async { Ok(AgentState::Idle) }
    });
    let run = spawn(&s.fleet, request()).await.unwrap();
    assert_eq!(run.model.as_deref(), Some("gemini-pro"));
    assert_eq!(run.fallback_from.as_deref(), Some("no-such"));
    assert_eq!(run.state, AgentState::Working);
    assert_eq!(s.runtime.closed(), strings(&["w1:p1"]));
}

// ADR 0248-launch-adapters: the candidate loop asks `Adapter::refusal` of each CLI, with the role's
// facts (#189's 8, #190)

// a role that starts agents runs the fleet command, which agy's terminal sandbox hides
#[tokio::test(start_paused = true)]
async fn passes_over_agy_for_a_role_that_runs_the_fleet_command() {
    let s = with(
        vec![AgentDefinition {
            agent: FleetAgentKind::Agy,
            model: Some("gemini-pro".to_owned()),
            fallback_models: Some(strings(&["claude:sonnet"])),
            spawning: Some(true),
            ..role("keeper")
        }],
        json!({}),
    );
    let run = spawn(
        &s.fleet,
        SpawnRequest {
            role: "keeper".to_owned(),
            ..request()
        },
    )
    .await
    .unwrap();
    assert_eq!(run.agent, FleetAgentKind::Claude);
    let skipped = run.skipped.unwrap();
    assert_eq!(skipped[0].candidate, "gemini-pro");
    assert!(skipped[0].reason.contains("fleet command"));
    let kinds: Vec<FleetAgentKind> = s.runtime.starts().iter().map(|s| s.kind).collect();
    assert_eq!(kinds, vec![FleetAgentKind::Claude]);
}

// the reviewer reads files outside its folders, and agy stops to ask before each
#[tokio::test(start_paused = true)]
async fn passes_over_agy_for_the_reviewer() {
    let s = with(
        vec![AgentDefinition {
            agent: FleetAgentKind::Agy,
            model: Some("gemini-pro".to_owned()),
            fallback_models: Some(strings(&["claude:sonnet"])),
            ..role("reviewer")
        }],
        json!({}),
    );
    let run = spawn(
        &s.fleet,
        SpawnRequest {
            role: "reviewer".to_owned(),
            ..request()
        },
    )
    .await
    .unwrap();
    assert_eq!(run.agent, FleetAgentKind::Claude);
    let skipped = run.skipped.unwrap();
    assert_eq!(skipped[0].candidate, "gemini-pro");
    assert!(skipped[0].reason.contains("outside its folders"));
}

// `impl ModelGate for ModelCatalog`: a model missing from a CLI's complete list is passed over
#[tokio::test(start_paused = true)]
async fn passes_over_a_model_the_catalog_says_the_cli_does_not_offer() {
    let mut options = CatalogOptions::new("/nonexistent", Env::new());
    options.sources = Arc::new(|_kind| {
        Some(ModelSource {
            complete: true,
            list: Arc::new(|_options: ListOptions| {
                Box::pin(async {
                    Ok(vec![ListedModel {
                        id: "gpt-6".to_owned(),
                        label: None,
                    }])
                })
            }),
        })
    });
    let s = setup(SetupOptions {
        agents: Some(vec![AgentDefinition {
            agent: FleetAgentKind::Codex,
            model: Some("nope".to_owned()),
            fallback_models: Some(strings(&["gpt-6"])),
            ..role("worker")
        }]),
        models: Some(Arc::new(ModelCatalog::new(options))),
        ..SetupOptions::default()
    });
    let run = spawn(&s.fleet, request()).await.unwrap();
    assert_eq!(run.model.as_deref(), Some("gpt-6"));
    assert_eq!(
        run.skipped,
        Some(vec![skipped(
            "nope",
            "codex does not offer a model named nope"
        )])
    );
    assert_eq!(s.runtime.locations().len(), 1);
}
