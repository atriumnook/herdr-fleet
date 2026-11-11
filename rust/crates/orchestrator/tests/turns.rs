//! Delegated turns: from the prompt until the turn settles, blocks or fails. The tests named after
//! an `it` are `server/fleet/orchestrator.test.ts`'s describe `turns` and `registry`, with their
//! expected values; the last ones check that the Rust version does not carry over the defects main
//! has (#176's 4, #189's 4, #240's 2), with the expected behaviour those issues give.

mod common;

use std::fs;
use std::time::Duration;

use common::{
    GRACE, SetupOptions, TestClock, request, settle, setup, sleep_ms, spawn, start_wait, until,
    write_report,
};
use herdr_fleet_orchestrator::fleet::{
    Orchestrator, OrchestratorError, SpawnRequest, UNREPORTED_CLOSE,
};
use herdr_fleet_orchestrator::registry::RunRegistry;
use herdr_fleet_orchestrator::runtime::RuntimeError;
use protocol::{AgentRun, AgentState, TurnOutcome};
use serde_json::json;
use tokio_util::sync::CancellationToken;

fn none() -> CancellationToken {
    CancellationToken::new()
}

// orchestrator.test.ts: "settles a turn when herdr reports it finished, hands the output to the waiter, and closes a non-interactive pane that wrote its report"
#[tokio::test(start_paused = true)]
async fn settles_a_turn_when_herdr_reports_it_finished_hands_the_output_to_the_waiter_and_closes_a_non_interactive_pane_that_wrote_its_report()
 {
    let s = setup(SetupOptions::default());
    let run = spawn(&s.fleet, request()).await.unwrap();
    let waiting = start_wait(&s.fleet, &run.id, 2000, "g1").await;
    fs::write(s.result_dir(&run.id).join("handoff.md"), "PASS — done").unwrap();
    write_report(&s.root, &run.id, "ready", "Done.");
    s.runtime.set_get_status(AgentState::Done);
    s.runtime.set_output("work\nHANDOFF: done");
    s.fleet.on_pane_status(&run.pane_id);
    let settled = waiting.await.unwrap().unwrap();
    assert_eq!(settled.state, AgentState::Done);
    assert_eq!(settled.last_output.as_deref(), Some("work\nHANDOFF: done"));
    assert_eq!(settled.result.as_deref(), Some("PASS — done"));
    until(
        || s.fleet.get(&run.id, None).unwrap().state == AgentState::Stopped,
        "pane closed",
    )
    .await;
    assert_eq!(s.runtime.closed(), vec![run.pane_id.clone()]);
}

// orchestrator.test.ts: "keeps the pane of a non-interactive turn that ended without its handoff, so what stopped it can be seen and the run sent on"
#[tokio::test(start_paused = true)]
async fn keeps_the_pane_of_a_non_interactive_turn_that_ended_without_its_handoff_so_what_stopped_it_can_be_seen_and_the_run_sent_on()
 {
    // a question the adapter does not know (agy's file access screen before it did) reads as a finished turn
    let s = setup(SetupOptions::default());
    let run = spawn(&s.fleet, request()).await.unwrap();
    let waiting = start_wait(&s.fleet, &run.id, 2000, "g1").await;
    s.runtime.set_get_status(AgentState::Done);
    s.runtime.set_output("Allow access to this file?");
    s.fleet.on_pane_status(&run.pane_id);
    let settled = waiting.await.unwrap().unwrap();
    assert_eq!(settled.state, AgentState::Done);
    assert_eq!(
        settled.last_output.as_deref(),
        Some("Allow access to this file?")
    );
    assert_eq!(settled.result, None);
    sleep_ms(20).await;
    assert!(s.runtime.closed().is_empty());
    assert_eq!(s.fleet.get(&run.id, None).unwrap().state, AgentState::Done);
}

// orchestrator.test.ts: "keeps an interactive agent's pane, and every pane when closeOnSettle is off"
#[tokio::test(start_paused = true)]
async fn keeps_an_interactive_agents_pane_and_every_pane_when_close_on_settle_is_off() {
    for (config, role) in [
        (json!({}), "reviewer"),
        (json!({ "closeOnSettle": false }), "worker"),
    ] {
        let s = setup(SetupOptions {
            config: Some(config),
            ..SetupOptions::default()
        });
        let run = spawn(
            &s.fleet,
            SpawnRequest {
                role: role.to_owned(),
                ..request()
            },
        )
        .await
        .unwrap();
        let waiting = start_wait(&s.fleet, &run.id, 2000, "g1").await;
        s.runtime.set_get_status(AgentState::Idle);
        tokio::time::sleep(GRACE + Duration::from_millis(10)).await;
        s.fleet.on_pane_status(&run.pane_id);
        assert_eq!(waiting.await.unwrap().unwrap().state, AgentState::Idle);
        sleep_ms(20).await;
        assert!(s.runtime.closed().is_empty(), "{role}");
    }
}

// orchestrator.test.ts: "does not take the idle from before the prompt for a finished turn; the check after the grace period does"
#[tokio::test(start_paused = true)]
async fn does_not_take_the_idle_from_before_the_prompt_for_a_finished_turn_the_check_after_the_grace_period_does()
 {
    let s = setup(SetupOptions::default());
    s.runtime.set_prompt_status(AgentState::Idle);
    s.runtime.set_get_status(AgentState::Idle);
    let run = spawn(&s.fleet, request()).await.unwrap();
    s.fleet.on_pane_status(&run.pane_id);
    sleep_ms(10).await;
    assert_eq!(
        s.fleet.get(&run.id, None).unwrap().state,
        AgentState::Working
    );
    assert!(s.runtime.closed().is_empty());
    let settled = s
        .fleet
        .wait(&run.id, Some(2000), Some("g1"), &none())
        .await
        .unwrap();
    assert_eq!(settled.state, AgentState::Idle);
}

// orchestrator.test.ts: "does not let the settle check of an earlier turn finish a follow-up"
#[tokio::test(start_paused = true)]
async fn does_not_let_the_settle_check_of_an_earlier_turn_finish_a_follow_up() {
    let s = setup(SetupOptions::default());
    s.runtime.set_prompt_status(AgentState::Idle);
    s.runtime.set_get_status(AgentState::Working);
    let run = spawn(&s.fleet, request()).await.unwrap();
    tokio::time::sleep(GRACE / 2).await;
    s.fleet
        .send(&run.id, "next", Some("g1"), &none())
        .await
        .unwrap();
    s.runtime.set_get_status(AgentState::Idle);
    // the first turn's timer would fire now; the follow-up's grace has not passed yet
    tokio::time::sleep(GRACE / 2 + Duration::from_millis(5)).await;
    s.fleet.on_pane_status(&run.pane_id);
    sleep_ms(5).await;
    assert_eq!(
        s.fleet.get(&run.id, None).unwrap().state,
        AgentState::Working
    );
}

// orchestrator.test.ts: "reports a block to the waiter with the screen, and keeps the turn and the pane"
#[tokio::test(start_paused = true)]
async fn reports_a_block_to_the_waiter_with_the_screen_and_keeps_the_turn_and_the_pane() {
    let s = setup(SetupOptions::default());
    let run = spawn(&s.fleet, request()).await.unwrap();
    let waiting = start_wait(&s.fleet, &run.id, 2000, "g1").await;
    s.runtime.set_get_status(AgentState::Blocked);
    s.runtime.set_output("Allow edit? [y/n]");
    s.fleet.on_pane_status(&run.pane_id);
    let blocked = waiting.await.unwrap().unwrap();
    assert_eq!(blocked.state, AgentState::Blocked);
    assert_eq!(blocked.last_output.as_deref(), Some("Allow edit? [y/n]"));
    // a second wait on the same block answers at once
    let again = s
        .fleet
        .wait(&run.id, Some(50), Some("g1"), &none())
        .await
        .unwrap();
    assert_eq!(again.state, AgentState::Blocked);
    assert!(s.runtime.closed().is_empty());
    s.runtime.set_get_status(AgentState::Working);
    s.fleet.on_pane_status(&run.pane_id);
    sleep_ms(5).await;
    let next = start_wait(&s.fleet, &run.id, 2000, "g1").await;
    s.runtime.set_get_status(AgentState::Done);
    s.runtime.set_output("HANDOFF");
    s.fleet.on_pane_status(&run.pane_id);
    assert_eq!(next.await.unwrap().unwrap().state, AgentState::Done);
}

// orchestrator.test.ts: "surfaces herdr refusing a prompt to a blocked agent, without a turn in flight"
#[tokio::test(start_paused = true)]
async fn surfaces_herdr_refusing_a_prompt_to_a_blocked_agent_without_a_turn_in_flight() {
    let s = setup(SetupOptions::default());
    let run = spawn(&s.fleet, request()).await.unwrap();
    s.runtime
        .on_prompt(|_, _, _| async { Err(RuntimeError::Blocked) });
    s.runtime.set_output("Trust this folder?");
    let sent = s
        .fleet
        .send(&run.id, "more", Some("g1"), &none())
        .await
        .unwrap();
    assert_eq!(sent.state, AgentState::Blocked);
    assert_eq!(sent.last_output.as_deref(), Some("Trust this folder?"));
}

// orchestrator.test.ts: "times a wait out with the state read back, and cancels one with the request"
#[tokio::test(start_paused = true)]
async fn times_a_wait_out_with_the_state_read_back_and_cancels_one_with_the_request() {
    let s = setup(SetupOptions::default());
    let run = spawn(&s.fleet, request()).await.unwrap();
    let timed_out = s
        .fleet
        .wait(&run.id, Some(30), Some("g1"), &none())
        .await
        .unwrap_err();
    match timed_out {
        OrchestratorError::WaitTimeout { run, timeout_ms } => {
            assert_eq!((run.state, timeout_ms), (AgentState::Working, 30));
        }
        other => panic!("not a wait timeout: {other:?}"),
    }
    let control = CancellationToken::new();
    let (fleet, id, token) = (s.fleet.clone(), run.id.clone(), control.clone());
    let cancelled =
        tokio::spawn(async move { fleet.wait(&id, Some(2000), Some("g1"), &token).await });
    settle().await;
    control.cancel();
    assert!(cancelled.await.unwrap().is_err());
}

// orchestrator.test.ts: "ends a run whose pane went away, waking its waiter; a failed run keeps its verdict"
#[tokio::test(start_paused = true)]
async fn ends_a_run_whose_pane_went_away_waking_its_waiter_a_failed_run_keeps_its_verdict() {
    let s = setup(SetupOptions::default());
    let run = spawn(&s.fleet, request()).await.unwrap();
    let waiting = start_wait(&s.fleet, &run.id, 2000, "g1").await;
    s.fleet.on_pane_ended(&run.pane_id);
    assert_eq!(waiting.await.unwrap().unwrap().state, AgentState::Stopped);
    let error = s
        .fleet
        .send(&run.id, "x", Some("g1"), &none())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "run_ended");
}

// orchestrator.test.ts: "stops a run herdr no longer knows, but not one still inside its start"
#[tokio::test(start_paused = true)]
async fn stops_a_run_herdr_no_longer_knows_but_not_one_still_inside_its_start() {
    let s = setup(SetupOptions::default());
    let run = spawn(&s.fleet, request()).await.unwrap();
    s.runtime.on_get(|_| async { Err(RuntimeError::NotFound) });
    let young = AgentRun {
        id: "young".to_owned(),
        herdr_name: "young".to_owned(),
        pane_id: "w1:p99".to_owned(),
        state: AgentState::Starting,
        started_at: s.clock.now_ms(),
        ..s.fleet.get(&run.id, None).unwrap()
    };
    s.registry.insert(young).unwrap();
    s.fleet.reconcile_all().await;
    assert_eq!(
        s.fleet.get(&run.id, None).unwrap().state,
        AgentState::Stopped
    );
    assert_eq!(
        s.fleet.get("young", None).unwrap().state,
        AgentState::Starting
    );
}

fn stored(id: &str, state: AgentState, interactive: bool) -> AgentRun {
    serde_json::from_value(json!({
        "id": id, "name": id, "role": "worker", "agent": "pi", "group": "g1", "herdrName": id,
        "paneId": format!("w1:{id}"), "cwd": "/w", "state": state, "depth": 1,
        "interactive": interactive, "worktree": false, "startedAt": 1, "updatedAt": 1,
    }))
    .unwrap()
}

// orchestrator.test.ts: "closes only finished non-interactive panes herdr still reports done"
#[tokio::test(start_paused = true)]
async fn closes_only_finished_non_interactive_panes_herdr_still_reports_done() {
    let s = setup(SetupOptions::default());
    for (id, state, interactive) in [
        ("d1", AgentState::Done, false),
        ("i1", AgentState::Idle, false),
        ("b1", AgentState::Blocked, false),
        ("di", AgentState::Done, true),
    ] {
        s.registry.insert(stored(id, state, interactive)).unwrap();
    }
    s.runtime.on_get(|name| async move {
        Ok(match name.as_str() {
            "d1" | "di" => AgentState::Done,
            "i1" => AgentState::Idle,
            _ => AgentState::Blocked,
        })
    });
    let closed = s.fleet.close_done(Some("g1")).await;
    assert_eq!(
        closed.iter().map(|run| run.id.as_str()).collect::<Vec<_>>(),
        vec!["d1"]
    );
    assert_eq!(s.runtime.closed(), vec!["w1:d1".to_owned()]);
}

// orchestrator.test.ts: "addresses runs within the caller's fleet only"
#[tokio::test(start_paused = true)]
async fn addresses_runs_within_the_callers_fleet_only() {
    let s = setup(SetupOptions::default());
    let run = spawn(
        &s.fleet,
        SpawnRequest {
            name: Some("impl".to_owned()),
            ..request()
        },
    )
    .await
    .unwrap();
    assert_eq!(s.fleet.get("impl", Some("g1")).unwrap().id, run.id);
    let error = s.fleet.get("impl", Some("other")).unwrap_err();
    assert!(error.to_string().contains("Unknown fleet agent"), "{error}");
    assert!(s.fleet.list(Some("other")).is_empty());
}

// orchestrator.test.ts (describe "registry"): "keeps runs across a restart without their output, and drops week-old ones"
#[tokio::test(start_paused = true)]
async fn keeps_runs_across_a_restart_without_their_output_and_drops_week_old_ones() {
    let s = setup(SetupOptions::default());
    let run = spawn(&s.fleet, request()).await.unwrap();
    let file = s.root.join("runs.json");
    let reloaded = RunRegistry::open(Some(file.clone()), s.clock.as_ref());
    let kept = reloaded.get(&run.id).unwrap();
    assert_eq!(
        (kept.id.as_str(), kept.state),
        (run.id.as_str(), AgentState::Working)
    );
    assert_eq!(kept.last_output, None);
    let week_later = TestClock::at(s.clock.now_ms() + 8 * 24 * 3_600_000);
    assert!(
        RunRegistry::open(Some(file), week_later.as_ref())
            .all()
            .is_empty()
    );
}

// #176's 4 (fixed on main by #238): a turn the fleet did not send starts (the agent woke itself, or
// the person typed); the handoff of the turn before is not left for it to be read as its own.
#[tokio::test(start_paused = true)]
async fn clears_the_turn_before_s_handoff_when_a_turn_the_fleet_did_not_send_starts() {
    let s = setup(SetupOptions::default());
    let run = spawn(
        &s.fleet,
        SpawnRequest {
            role: "reviewer".to_owned(),
            ..request()
        },
    )
    .await
    .unwrap();
    let handoff = s.result_dir(&run.id).join("handoff.md");
    fs::write(&handoff, "first").unwrap();
    let waiting = start_wait(&s.fleet, &run.id, 2000, "g1").await;
    s.runtime.set_get_status(AgentState::Idle);
    tokio::time::sleep(GRACE + Duration::from_millis(10)).await;
    s.fleet.on_pane_status(&run.pane_id);
    assert_eq!(
        waiting.await.unwrap().unwrap().result.as_deref(),
        Some("first")
    );
    // the agent starts a turn of its own: herdr shows it working, with no turn of the fleet's open
    s.runtime.set_get_status(AgentState::Working);
    s.fleet.on_pane_status(&run.pane_id);
    until(
        || s.fleet.get(&run.id, None).unwrap().state == AgentState::Working,
        "working",
    )
    .await;
    assert!(!handoff.exists());
}

// #189's 4: a non-interactive pane whose turn settled without a report is kept for a while (the
// test above), but not until a person closes it: once it stayed settled for UNREPORTED_CLOSE
// (15 minutes, ADR 0256-orchestrator-foundation) with no turn sent since, it closes.
#[tokio::test(start_paused = true)]
async fn closes_a_non_interactive_pane_left_without_a_report_once_it_stayed_settled_for_its_period()
{
    let s = setup(SetupOptions::default());
    let run = spawn(&s.fleet, request()).await.unwrap();
    let waiting = start_wait(&s.fleet, &run.id, 2000, "g1").await;
    s.runtime.set_get_status(AgentState::Done);
    s.fleet.on_pane_status(&run.pane_id);
    assert_eq!(waiting.await.unwrap().unwrap().state, AgentState::Done);
    tokio::time::sleep(UNREPORTED_CLOSE - Duration::from_secs(1)).await;
    assert!(s.runtime.closed().is_empty());
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(s.runtime.closed(), vec![run.pane_id.clone()]);
    assert_eq!(
        s.fleet.get(&run.id, None).unwrap().state,
        AgentState::Stopped
    );
}

// #189's 4: the close does not take a pane that was sent on meanwhile.
#[tokio::test(start_paused = true)]
async fn keeps_a_pane_left_without_a_report_that_was_sent_on_before_its_period_ended() {
    let s = setup(SetupOptions::default());
    let run = spawn(&s.fleet, request()).await.unwrap();
    let waiting = start_wait(&s.fleet, &run.id, 2000, "g1").await;
    s.runtime.set_get_status(AgentState::Done);
    s.fleet.on_pane_status(&run.pane_id);
    waiting.await.unwrap().unwrap();
    tokio::time::sleep(UNREPORTED_CLOSE / 2).await;
    s.runtime.set_get_status(AgentState::Working);
    s.fleet
        .send(&run.id, "go on", Some("g1"), &none())
        .await
        .unwrap();
    tokio::time::sleep(UNREPORTED_CLOSE).await;
    assert!(s.runtime.closed().is_empty());
    assert_eq!(
        s.fleet.get(&run.id, None).unwrap().state,
        AgentState::Working
    );
}

// #189's 4: a server restarted while such a pane waited still closes it once the period ends.
#[tokio::test(start_paused = true)]
async fn closes_a_pane_left_without_a_report_after_a_restart_too() {
    let s = setup(SetupOptions::default());
    let run = spawn(&s.fleet, request()).await.unwrap();
    let waiting = start_wait(&s.fleet, &run.id, 2000, "g1").await;
    s.runtime.set_get_status(AgentState::Done);
    s.fleet.on_pane_status(&run.pane_id);
    waiting.await.unwrap().unwrap();
    s.fleet.stop();
    let deps = common::deps(
        s.runtime.clone(),
        s.registry.clone(),
        &s.root,
        s.clock.clone(),
        common::config(None),
        common::default_roles(),
    );
    let _restarted = Orchestrator::new(deps).unwrap();
    tokio::time::sleep(UNREPORTED_CLOSE + Duration::from_secs(1)).await;
    assert_eq!(s.runtime.closed(), vec![run.pane_id.clone()]);
}

// #240's 2, the settlement's side: a landing step typed while the settlement awaits herdr's screen
// clears the turn's files (`clearTurnFiles`); the report the settlement had not read yet must not
// be lost. The fake's read stands in for that step: it removes report.json while it is awaited.
#[tokio::test(start_paused = true)]
async fn reads_the_turn_s_report_before_anything_it_awaits_can_clear_it() {
    let s = setup(SetupOptions::default());
    let run = spawn(
        &s.fleet,
        SpawnRequest {
            role: "reviewer".to_owned(),
            ..request()
        },
    )
    .await
    .unwrap();
    write_report(&s.root, &run.id, "ready", "Done.");
    let report = s.result_dir(&run.id).join("report.json");
    s.runtime.on_read(move |_| {
        let report = report.clone();
        async move {
            let _ = fs::remove_file(&report);
            Ok("screen".to_owned())
        }
    });
    let waiting = start_wait(&s.fleet, &run.id, 2000, "g1").await;
    s.runtime.set_get_status(AgentState::Idle);
    tokio::time::sleep(GRACE + Duration::from_millis(10)).await;
    s.fleet.on_pane_status(&run.pane_id);
    let settled = waiting.await.unwrap().unwrap();
    match settled.outcome {
        Some(TurnOutcome::Report(report)) => assert_eq!(report.summary, "Done."),
        other => panic!("the report was lost: {other:?}"),
    }
}
