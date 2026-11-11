//! What differs between the agent CLIs as a run starts and its turns settle. The tests are
//! `server/fleet/orchestrator.test.ts`'s describe `agent kinds` but its last `it` (a start that
//! ignored the model moves to the next candidate, which is #263's), with its expected values.

mod common;

use std::fs;
use std::time::Duration;

use common::{GRACE, Setup, SetupOptions, deps, request, role, setup, spawn, start_wait, until};
use herdr_fleet_orchestrator::agents::AgentDefinition;
use herdr_fleet_orchestrator::config::FleetConfig;
use herdr_fleet_orchestrator::fleet::{Orchestrator, SpawnRequest};
use protocol::{AgentState, FleetAgentKind};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

fn on(kind: FleetAgentKind, base: AgentDefinition) -> AgentDefinition {
    AgentDefinition {
        agent: kind,
        ..base
    }
}

fn with_roles(roles: Vec<AgentDefinition>) -> Setup {
    setup(SetupOptions {
        agents: Some(roles),
        ..SetupOptions::default()
    })
}

/// Sets the fake's screen to `output` after `ms` of the paused clock (`setTimeout`).
fn later(s: &Setup, ms: u64, output: &'static str) {
    let runtime = s.runtime.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        runtime.set_output(output);
    });
}

fn opencode_config(s: &Setup) -> Value {
    serde_json::from_str(&s.runtime.locations()[0].env["OPENCODE_CONFIG_CONTENT"]).unwrap()
}

// orchestrator.test.ts: "leads the first prompt with the instructions for a CLI that takes none at launch, and only the first"
#[tokio::test(start_paused = true)]
async fn leads_the_first_prompt_with_the_instructions_for_a_cli_that_takes_none_at_launch_and_only_the_first()
 {
    let s = with_roles(vec![AgentDefinition {
        interactive: Some(true),
        ..on(FleetAgentKind::Cursor, role("worker"))
    }]);
    s.runtime.set_output("→ Plan, search, build anything");
    let run = spawn(&s.fleet, request()).await.unwrap();
    assert_eq!(s.runtime.starts()[0].kind, FleetAgentKind::Cursor);
    let prompts = s.runtime.prompts();
    assert!(prompts[0].text.starts_with("You are worker."));
    assert!(prompts[0].text.ends_with("## Task\n\ndo it"));
    s.fleet
        .send(&run.id, "next", Some("g1"), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(s.runtime.prompts()[1].text, "next");
}

// orchestrator.test.ts: "starts opencode standalone with its config in the pane, and holds a read-only role to its result file and its commands"
#[tokio::test(start_paused = true)]
async fn starts_opencode_standalone_with_its_config_in_the_pane_and_holds_a_read_only_role_to_its_result_file_and_its_commands()
 {
    let auditor = AgentDefinition {
        model: Some("p/m".to_owned()),
        edits: Some(false),
        interactive: Some(true),
        ..on(FleetAgentKind::Opencode, role("auditor"))
    };
    let s = with_roles(vec![auditor]);
    let run = spawn(
        &s.fleet,
        SpawnRequest {
            role: "auditor".to_owned(),
            ..request()
        },
    )
    .await
    .unwrap();
    let env = &s.runtime.locations()[0].env;
    for (name, value) in [
        ("HERDR_FLEET_GROUP", "g1"),
        ("HERDR_FLEET_URL", "http://127.0.0.1:1"),
        ("OPENCODE_DISABLE_AUTOUPDATE", "true"),
    ] {
        assert_eq!(env.get(name).map(String::as_str), Some(value), "{name}");
    }
    let config = opencode_config(&s);
    assert_eq!(config["model"], "p/m");
    assert_eq!(config["share"], "disabled");
    assert_eq!(config["update"], "disable");
    assert_eq!(config["default_agent"], "fleet-readonly");
    let rule = json!({
        "action": "edit",
        "resource": format!("{}/{}/*", s.root.join("results").display(), run.id),
        "effect": "allow",
    });
    let rules = config["agents"]["fleet-readonly"]["permissions"]
        .as_array()
        .unwrap();
    assert!(rules.contains(&rule), "{rules:?}");
    let start = &s.runtime.starts()[0];
    assert_eq!(
        (start.kind, start.args.clone()),
        (FleetAgentKind::Opencode, vec!["--standalone".to_owned()])
    );
    let prompt = &s.runtime.prompts()[0].text;
    assert!(
        prompt.contains("write them with your file-editing tool, which is limited to their folder")
    );
    assert!(prompt.contains("git diff --no-ext-diff --no-textconv"));
    assert!(!prompt.contains("gh pr merge"));
}

// orchestrator.test.ts: "gives opencode's editing roles no read-only agent, and only the project's coordinator the merge commands"
#[tokio::test(start_paused = true)]
async fn gives_opencodes_editing_roles_no_read_only_agent_and_only_the_projects_coordinator_the_merge_commands()
 {
    let editing = with_roles(vec![AgentDefinition {
        model: Some("p/m".to_owned()),
        ..on(FleetAgentKind::Opencode, role("worker"))
    }]);
    spawn(&editing.fleet, request()).await.unwrap();
    let config = opencode_config(&editing);
    assert_eq!(config.get("default_agent"), None);
    assert_eq!(config.get("agents"), None);
    let deny = json!({ "action": "shell", "resource": "git *push* --force*", "effect": "deny" });
    assert!(config["permissions"].as_array().unwrap().contains(&deny));
    assert!(
        !editing.runtime.prompts()[0]
            .text
            .contains("Your shell runs only")
    );
    let merging = with_roles(vec![AgentDefinition {
        model: Some("p/m".to_owned()),
        edits: Some(false),
        interactive: Some(true),
        ..on(FleetAgentKind::Opencode, role("coordinator"))
    }]);
    spawn(
        &merging.fleet,
        SpawnRequest {
            role: "coordinator".to_owned(),
            ..request()
        },
    )
    .await
    .unwrap();
    let rules = opencode_config(&merging)["agents"]["fleet-readonly"]["permissions"].clone();
    let pull = json!({ "action": "shell", "resource": "git pull --ff-only", "effect": "allow" });
    assert!(rules.as_array().unwrap().contains(&pull));
    assert!(
        merging.runtime.prompts()[0]
            .text
            .contains("gh pr merge <number> --merge")
    );
}

// orchestrator.test.ts: "waits for a CLI herdr calls ready too early to draw its input, and blocks on a question it draws instead"
#[tokio::test(start_paused = true)]
async fn waits_for_a_cli_herdr_calls_ready_too_early_to_draw_its_input_and_blocks_on_a_question_it_draws_instead()
 {
    let drawn = with_roles(vec![on(FleetAgentKind::Cursor, role("worker"))]);
    drawn.runtime.set_output("❯ cursor-agent");
    later(&drawn, 100, "→ Plan, search, build anything");
    assert_eq!(
        spawn(&drawn.fleet, request()).await.unwrap().state,
        AgentState::Working
    );
    assert_eq!(drawn.runtime.prompts().len(), 1);

    let asked = with_roles(vec![on(FleetAgentKind::Cursor, role("worker"))]);
    asked.runtime.set_output("❯ cursor-agent");
    later(
        &asked,
        100,
        "⚠ Workspace Trust Required\n▶ [a] Trust this workspace",
    );
    assert_eq!(
        spawn(&asked.fleet, request()).await.unwrap().state,
        AgentState::Blocked
    );
    assert!(asked.runtime.prompts().is_empty());
}

// orchestrator.test.ts: "keeps a run blocked on a question herdr reports as idle when it is read back, until the question goes"
#[tokio::test(start_paused = true)]
async fn keeps_a_run_blocked_on_a_question_herdr_reports_as_idle_when_it_is_read_back_until_the_question_goes()
 {
    let s = with_roles(vec![on(FleetAgentKind::Cursor, role("worker"))]);
    s.runtime.set_output("⚠ Workspace Trust Required");
    s.runtime.set_get_status(AgentState::Idle);
    let run = spawn(&s.fleet, request()).await.unwrap();
    assert_eq!(run.state, AgentState::Blocked);
    let none = CancellationToken::new();
    assert_eq!(
        s.fleet
            .wait(&run.id, Some(500), Some("g1"), &none)
            .await
            .unwrap()
            .state,
        AgentState::Blocked
    );
    s.runtime.set_output("→ Plan, search, build anything");
    assert_eq!(
        s.fleet
            .wait(&run.id, Some(500), Some("g1"), &none)
            .await
            .unwrap()
            .state,
        AgentState::Idle
    );
}

// orchestrator.test.ts: "does not send the task to a CLI that never drew its input"
#[tokio::test(start_paused = true)]
async fn does_not_send_the_task_to_a_cli_that_never_drew_its_input() {
    let s = with_roles(vec![on(FleetAgentKind::Cursor, role("worker"))]);
    s.runtime.set_output("❯ cursor-agent");
    s.runtime.set_get_status(AgentState::Idle);
    let run = spawn(&s.fleet, request()).await.unwrap();
    assert!(
        run.last_error
            .as_deref()
            .unwrap()
            .contains("not ready for prompts")
    );
    assert!(s.runtime.prompts().is_empty());
}

// orchestrator.test.ts: "tells an agent on agy that its sandboxed terminal runs no git, no project tool and no fleet command, and no other CLI's agent"
#[tokio::test(start_paused = true)]
async fn tells_an_agent_on_agy_that_its_sandboxed_terminal_runs_no_git_no_project_tool_and_no_fleet_command_and_no_other_clis_agent()
 {
    let s = with_roles(vec![
        on(FleetAgentKind::Agy, role("worker")),
        on(FleetAgentKind::Claude, role("reviewer")),
    ]);
    s.runtime
        .set_output("──\n>\n──\n? for shortcuts    auto · Gemini 4 Argon · medium");
    spawn(&s.fleet, request()).await.unwrap();
    assert!(
        s.runtime.prompts()[0]
            .text
            .contains("Your terminal runs in Antigravity CLI's sandbox")
    );
    spawn(
        &s.fleet,
        SpawnRequest {
            role: "reviewer".to_owned(),
            ..request()
        },
    )
    .await
    .unwrap();
    assert!(
        !s.runtime
            .instructions()
            .join("\n")
            .contains("Antigravity CLI's sandbox")
    );
}

// orchestrator.test.ts: "keeps the instructions for the first prompt a person sends after a block at startup"
#[tokio::test(start_paused = true)]
async fn keeps_the_instructions_for_the_first_prompt_a_person_sends_after_a_block_at_startup() {
    let s = with_roles(vec![on(FleetAgentKind::Agy, role("worker"))]);
    s.runtime
        .set_output("Do you trust the contents of this project?\n> Yes, I trust this folder");
    let run = spawn(&s.fleet, request()).await.unwrap();
    assert_eq!(run.state, AgentState::Blocked);
    assert!(
        run.last_error
            .as_deref()
            .unwrap()
            .contains("trust this folder")
    );
    assert!(s.runtime.prompts().is_empty());
    s.fleet
        .send(&run.id, "do it", Some("g1"), &CancellationToken::new())
        .await
        .unwrap();
    assert!(s.runtime.prompts()[0].text.starts_with("You are worker."));
}

// orchestrator.test.ts: "keeps undelivered instructions across a restart, and drops them once sent"
#[tokio::test(start_paused = true)]
async fn keeps_undelivered_instructions_across_a_restart_and_drops_them_once_sent() {
    let s = with_roles(vec![on(FleetAgentKind::Agy, role("worker"))]);
    s.runtime
        .set_output("Do you trust the contents of this project?\n> Yes, I trust this folder");
    let run = spawn(&s.fleet, request()).await.unwrap();
    s.fleet.stop();
    s.runtime.set_output("──\n>\n──");
    let deps = deps(
        s.runtime.clone(),
        s.registry.clone(),
        &s.root,
        s.clock.clone(),
        FleetConfig::default(),
        Vec::new(),
    );
    let restarted = Orchestrator::new(deps).unwrap();
    restarted
        .send(&run.id, "do it", Some("g1"), &CancellationToken::new())
        .await
        .unwrap();
    assert!(s.runtime.prompts()[0].text.starts_with("You are worker."));
    let left: Vec<_> = fs::read_dir(s.root.join("instructions")).unwrap().collect();
    assert!(left.is_empty());
}

// orchestrator.test.ts: "blocks a turn on a question herdr reports as idle, and settles it once the agent is done"
#[tokio::test(start_paused = true)]
async fn blocks_a_turn_on_a_question_herdr_reports_as_idle_and_settles_it_once_the_agent_is_done() {
    let s = with_roles(vec![AgentDefinition {
        interactive: Some(true),
        ..on(FleetAgentKind::Agy, role("worker"))
    }]);
    // agy is ready once its input shows and the auto mode from its settings is set
    s.runtime
        .set_output(">\n? for shortcuts    auto · Gemini 4 Argon · medium");
    let run = spawn(&s.fleet, request()).await.unwrap();
    let waiting = start_wait(&s.fleet, &run.id, 2000, "g1").await;
    s.runtime.set_get_status(AgentState::Idle);
    s.runtime
        .set_output("Requesting permission for:\n  ls\nRun this command?");
    tokio::time::sleep(GRACE + Duration::from_millis(10)).await;
    s.fleet.on_pane_status(&run.pane_id);
    assert_eq!(waiting.await.unwrap().unwrap().state, AgentState::Blocked);
    s.runtime.set_get_status(AgentState::Working);
    s.fleet.on_pane_status(&run.pane_id);
    until(
        || s.fleet.get(&run.id, None).unwrap().state == AgentState::Working,
        "working again",
    )
    .await;
    let settled = start_wait(&s.fleet, &run.id, 2000, "g1").await;
    s.runtime.set_get_status(AgentState::Idle);
    s.runtime.set_output("● done");
    s.fleet.on_pane_status(&run.pane_id);
    assert_eq!(settled.await.unwrap().unwrap().state, AgentState::Idle);
}
