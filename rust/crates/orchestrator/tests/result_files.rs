//! A run's result folder: the handoff and the report its agent writes there each turn. The tests
//! are `server/fleet/orchestrator.test.ts`'s describe `result files`, with its expected values;
//! each names its `it`.

mod common;

use std::fs;
use std::sync::Arc;
use std::time::Duration;

use common::{GRACE, Setup, SetupOptions, deps, request, role, setup, spawn, start_wait};
use herdr_fleet_orchestrator::agents::AgentDefinition;
use herdr_fleet_orchestrator::config::FleetConfig;
use herdr_fleet_orchestrator::events::{FleetEvent, TurnReport};
use herdr_fleet_orchestrator::fleet::{Orchestrator, RESULT_MAX_BYTES, SpawnRequest, read_result};
use herdr_fleet_orchestrator::registry::RunRegistry;
use protocol::{AgentRun, AgentState, ReportState, RunReport, TurnOutcome};
use tokio_util::sync::CancellationToken;

fn reviewer_only() -> SetupOptions {
    SetupOptions {
        agents: Some(vec![AgentDefinition {
            interactive: Some(true),
            ..role("reviewer")
        }]),
        ..SetupOptions::default()
    }
}

fn reviewer() -> SpawnRequest {
    SpawnRequest {
        role: "reviewer".to_owned(),
        ..request()
    }
}

/// The turn settles: herdr reports idle after the grace period (`settle`, orchestrator.test.ts:752-758).
async fn settle_turn(s: &Setup, run: &AgentRun) -> AgentRun {
    let waiting = start_wait(&s.fleet, &run.id, 2000, "g1").await;
    s.runtime.set_get_status(AgentState::Idle);
    tokio::time::sleep(GRACE + Duration::from_millis(10)).await;
    s.fleet.on_pane_status(&run.pane_id);
    waiting.await.unwrap().unwrap()
}

async fn send(s: &Setup, run: &AgentRun, text: &str) {
    s.runtime.set_get_status(AgentState::Working);
    s.fleet
        .send(&run.id, text, Some("g1"), &CancellationToken::new())
        .await
        .unwrap();
}

// orchestrator.test.ts: "tells the agent a result file in a private folder of its own, and returns what it wrote there"
#[tokio::test(start_paused = true)]
async fn tells_the_agent_a_result_file_in_a_private_folder_of_its_own_and_returns_what_it_wrote_there()
 {
    let s = setup(reviewer_only());
    let run = spawn(&s.fleet, reviewer()).await.unwrap();
    let file = s.result_dir(&run.id).join("handoff.md");
    assert!(s.runtime.instructions()[0].contains(&file.display().to_string()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = fs::metadata(s.result_dir(&run.id))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }
    fs::write(&file, "HANDOFF\noutcome: reviewed\n").unwrap();
    assert_eq!(
        settle_turn(&s, &run).await.result.as_deref(),
        Some("HANDOFF\noutcome: reviewed")
    );
}

// orchestrator.test.ts: "does not hand a follow-up turn the result of the turn before"
#[tokio::test(start_paused = true)]
async fn does_not_hand_a_follow_up_turn_the_result_of_the_turn_before() {
    let s = setup(reviewer_only());
    let run = spawn(&s.fleet, reviewer()).await.unwrap();
    fs::write(s.result_dir(&run.id).join("handoff.md"), "first").unwrap();
    assert_eq!(settle_turn(&s, &run).await.result.as_deref(), Some("first"));
    send(&s, &run, "again").await;
    assert_eq!(settle_turn(&s, &run).await.result, None);
}

// orchestrator.test.ts: "does not fail a turn that wrote its report, whatever error its screen quotes"
#[tokio::test(start_paused = true)]
async fn does_not_fail_a_turn_that_wrote_its_report_whatever_error_its_screen_quotes() {
    let s = setup(reviewer_only());
    let run = spawn(&s.fleet, reviewer()).await.unwrap();
    s.runtime.set_output("Error: tests failed before the fix");
    common::write_report(&s.root, &run.id, "ready", "Fixed.");
    assert_eq!(settle_turn(&s, &run).await.state, AgentState::Idle);
}

// orchestrator.test.ts: "takes a turn's outcome from report.json alone, and calls a turn without one 'no report', whatever its handoff says"
#[tokio::test(start_paused = true)]
async fn takes_a_turns_outcome_from_report_json_alone_and_calls_a_turn_without_one_no_report_whatever_its_handoff_says()
 {
    let s = setup(reviewer_only());
    let run = spawn(&s.fleet, reviewer()).await.unwrap();
    let missing = || {
        Some(TurnOutcome::NoReport {
            problem: "report.json is missing.".to_owned(),
        })
    };
    fs::write(
        s.result_dir(&run.id).join("handoff.md"),
        "## HANDOFF\nPASS — no findings",
    )
    .unwrap();
    assert_eq!(settle_turn(&s, &run).await.outcome, missing());
    send(&s, &run, "again").await;
    let report = serde_json::json!({ "state": "ready", "summary": "Reviewed.", "evidence": ["no findings"] });
    fs::write(
        s.result_dir(&run.id).join("report.json"),
        report.to_string(),
    )
    .unwrap();
    assert_eq!(
        settle_turn(&s, &run).await.outcome,
        Some(TurnOutcome::Report(RunReport {
            state: ReportState::Ready,
            summary: "Reviewed.".to_owned(),
            evidence: vec!["no findings".to_owned()],
            human_action: None,
        }))
    );
    // the next turn starts without the report of the one before
    send(&s, &run, "and again").await;
    assert_eq!(settle_turn(&s, &run).await.outcome, missing());
    let turns: Vec<Option<TurnReport>> = s
        .events()
        .into_iter()
        .filter_map(|event| match event {
            FleetEvent::Turn(turn) => Some(turn.report),
            _ => None,
        })
        .collect();
    assert_eq!(
        turns,
        vec![
            Some(TurnReport::None),
            Some(TurnReport::Ready),
            Some(TurnReport::None)
        ]
    );
}

// orchestrator.test.ts: "never reads a result through a symlink, and cuts a long one short"
#[tokio::test(start_paused = true)]
async fn never_reads_a_result_through_a_symlink_and_cuts_a_long_one_short() {
    let s = setup(SetupOptions::default());
    let secret = s.root.join("secret");
    fs::write(&secret, "do not leak").unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&secret, s.root.join("link.md")).unwrap();
        assert_eq!(read_result(&s.root.join("link.md")), None);
    }
    fs::write(s.root.join("long.md"), "x".repeat(RESULT_MAX_BYTES + 10)).unwrap();
    let long = read_result(&s.root.join("long.md")).unwrap();
    assert!(
        long.ends_with(&format!("[truncated at {RESULT_MAX_BYTES} bytes]")),
        "{}",
        &long[long.len() - 40..]
    );
    assert_eq!(read_result(&s.root.join("missing.md")), None);
}

/// A restarted server's orchestrator, as orchestrator.test.ts:824-826 builds it: no roles, the
/// default config, the same folders.
fn restart(s: &Setup, registry: Arc<RunRegistry>) -> Orchestrator {
    let deps = deps(
        s.runtime.clone(),
        registry,
        &s.root,
        s.clock.clone(),
        FleetConfig::default(),
        Vec::new(),
    );
    Orchestrator::new(deps).unwrap()
}

// orchestrator.test.ts: "keeps results out of the registry file, and reads them back from the result files after a restart"
#[tokio::test(start_paused = true)]
async fn keeps_results_out_of_the_registry_file_and_reads_them_back_from_the_result_files_after_a_restart()
 {
    let s = setup(reviewer_only());
    let run = spawn(&s.fleet, reviewer()).await.unwrap();
    fs::write(s.result_dir(&run.id).join("handoff.md"), "outcome: kept").unwrap();
    assert_eq!(
        settle_turn(&s, &run).await.result.as_deref(),
        Some("outcome: kept")
    );
    let file = s.root.join("runs.json");
    assert!(!fs::read_to_string(&file).unwrap().contains("outcome: kept"));
    let registry = Arc::new(RunRegistry::open(Some(file), s.clock.as_ref()));
    let _restarted = restart(&s, registry.clone());
    assert_eq!(
        registry.get(&run.id).unwrap().result.as_deref(),
        Some("outcome: kept")
    );
}

// orchestrator.test.ts: "removes the result folders of runs the registry no longer has"
#[tokio::test(start_paused = true)]
async fn removes_the_result_folders_of_runs_the_registry_no_longer_has() {
    let s = setup(SetupOptions::default());
    let run = spawn(&s.fleet, request()).await.unwrap();
    fs::create_dir(s.root.join("results").join("gone1")).unwrap();
    let _restarted = restart(&s, s.registry.clone());
    let left: Vec<String> = fs::read_dir(s.root.join("results"))
        .unwrap()
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .collect();
    assert_eq!(left, vec![run.id.clone()]);
}
