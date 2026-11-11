//! Starting a run (`spawn`). The tests are `server/fleet/orchestrator.test.ts`'s describe `spawn`,
//! with its expected values; each names its `it`.

mod common;

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{Setup, SetupOptions, request, role, setup, sleep_ms, spawn};
use herdr_fleet_orchestrator::agents::{AgentDefinition, RoleSource};
use herdr_fleet_orchestrator::brief::BriefDraft;
use herdr_fleet_orchestrator::events::{FleetEvent, RoleEvent};
use herdr_fleet_orchestrator::fleet::{OrchestratorError, SpawnRequest};
use herdr_fleet_orchestrator::runtime::{RuntimeError, RuntimeLocation};
use protocol::{AgentState, FleetAgentKind};
use serde_json::json;
use tokio_util::sync::CancellationToken;

fn code(error: &OrchestratorError) -> &str {
    error.code()
}

fn brief(write: &[&str]) -> BriefDraft {
    BriefDraft {
        goal: Some("g".to_owned()),
        write: Some(write.iter().map(|path| (*path).to_owned()).collect()),
        context: Some("none".to_owned()),
        done: Some("d".to_owned()),
        verify: Some("v".to_owned()),
        ..BriefDraft::default()
    }
}

// orchestrator.test.ts: "starts the role's agent beside the caller with its instructions in a file, then hands it the task"
#[tokio::test(start_paused = true)]
async fn starts_the_roles_agent_beside_the_caller_with_its_instructions_in_a_file_then_hands_it_the_task()
 {
    let setup_ = setup(SetupOptions::default());
    let Setup {
        fleet,
        runtime,
        root,
        ..
    } = &setup_;
    let run = spawn(
        fleet,
        SpawnRequest {
            caller_pane_id: Some("w0:p1".to_owned()),
            name: Some("impl".to_owned()),
            ..request()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        (
            run.name.as_str(),
            run.role.as_str(),
            run.agent,
            run.group.as_str(),
            run.depth,
            run.state
        ),
        (
            "impl",
            "worker",
            FleetAgentKind::Pi,
            "g1",
            1,
            AgentState::Working
        )
    );
    let location = &runtime.locations()[0];
    assert_eq!(location.cwd, "/work");
    assert_eq!(location.caller_pane_id.as_deref(), Some("w0:p1"));
    for (name, value) in [
        ("HERDR_FLEET_URL", "http://127.0.0.1:1"),
        ("HERDR_FLEET_GROUP", "g1"),
        ("HERDR_FLEET_DEPTH", "1"),
        ("HERDR_FLEET_RUN", run.id.as_str()),
    ] {
        assert_eq!(
            location.env.get(name).map(String::as_str),
            Some(value),
            "{name}"
        );
    }
    assert!(
        runtime.starts()[0]
            .args
            .iter()
            .any(|arg| arg == "--append-system-prompt")
    );
    let instructions = &runtime.instructions()[0];
    assert!(instructions.contains("You are worker."));
    assert!(instructions.contains("fleet send <name-or-id>"));
    assert!(instructions.contains("Do not start other agents."));
    // the outcome is a report file the fleet reads, not a status line in prose
    let report = root.join("results").join(&run.id).join("report.json");
    assert!(instructions.contains(&format!("Your report file is {}.", report.display())));
    assert!(
        instructions.contains(r#""state": progress, waiting, ready, blocked, failed or dropped"#)
    );
    for word in ["PASS", "ISSUES", "BLOCKED"] {
        assert!(!instructions.contains(word), "{word}");
    }
    let prompts = runtime.prompts();
    assert_eq!(prompts.len(), 1);
    assert_eq!(
        (prompts[0].name.as_str(), prompts[0].text.as_str()),
        (run.herdr_name.as_str(), "do it")
    );
    // the instruction file is gone once the agent has read it at startup
    let left: Vec<_> = fs::read_dir(root)
        .unwrap()
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| name.starts_with("herdr-fleet-"))
        .collect();
    assert_eq!(left, Vec::<String>::new());
}

// orchestrator.test.ts: "asks an agent caller for a full brief before any pane, and hands its helper the brief as the task"
#[tokio::test(start_paused = true)]
async fn asks_an_agent_caller_for_a_full_brief_before_any_pane_and_hands_its_helper_the_brief_as_the_task()
 {
    let setup_ = setup(SetupOptions::default());
    let Setup { fleet, runtime, .. } = &setup_;
    let refused = spawn(
        fleet,
        SpawnRequest {
            depth: Some(1),
            ..request()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(code(&refused), "incomplete_brief");
    assert!(runtime.locations().is_empty());
    let given = BriefDraft {
        goal: Some("Fix the retry.".to_owned()),
        write: Some(vec!["src/retry.ts".to_owned()]),
        context: Some("none".to_owned()),
        done: Some("One notification per retry.".to_owned()),
        verify: Some("bun test".to_owned()),
        ..BriefDraft::default()
    };
    let run = spawn(
        fleet,
        SpawnRequest {
            depth: Some(1),
            task: None,
            brief: Some(given),
            ..request()
        },
    )
    .await
    .unwrap();
    assert_eq!(run.write, Some(vec!["/work/src/retry.ts".to_owned()]));
    assert!(
        runtime.prompts()[0]
            .text
            .contains("## Goal\n\nFix the retry.")
    );
}

// orchestrator.test.ts: "refuses a second writer of paths a working agent holds, and lets it in once that agent's turn settles"
#[tokio::test(start_paused = true)]
async fn refuses_a_second_writer_of_paths_a_working_agent_holds_and_lets_it_in_once_that_agents_turn_settles()
 {
    let setup_ = setup(SetupOptions::default());
    let Setup {
        fleet,
        runtime,
        registry,
        ..
    } = &setup_;
    let with = |write: &[&str]| SpawnRequest {
        depth: Some(1),
        brief: Some(brief(write)),
        ..request()
    };
    let first = spawn(fleet, with(&["src"])).await.unwrap();
    let error = spawn(fleet, with(&["src/retry.ts"])).await.unwrap_err();
    assert_eq!(code(&error), "scope_conflict");
    assert!(
        error.to_string().contains(&format!(
            "worker ({}) is still changing /work/src",
            first.id
        )),
        "{error}"
    );
    assert_eq!(runtime.locations().len(), 1);
    // a reader holds nothing, and a worktree run writes its own checkout
    spawn(fleet, with(&[])).await.unwrap();
    let worktree = spawn(
        fleet,
        SpawnRequest {
            worktree: Some(true),
            ..with(&["src"])
        },
    )
    .await
    .unwrap();
    assert_eq!(worktree.write, None);
    registry
        .update(&first.id, |run| run.state = AgentState::Idle)
        .unwrap();
    spawn(fleet, with(&["src/retry.ts"])).await.unwrap();
}

// orchestrator.test.ts: "gives every agent the standing orders of the folder it starts in, and no section without any"
#[tokio::test(start_paused = true)]
async fn gives_every_agent_the_standing_orders_of_the_folder_it_starts_in_and_no_section_without_any()
 {
    let asked = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
    let record = asked.clone();
    let setup_ = setup(SetupOptions {
        standing_orders: Some(Arc::new(move |cwd| {
            record.lock().unwrap().push(cwd.to_path_buf());
            "1. Ask before a push.".to_owned()
        })),
        ..SetupOptions::default()
    });
    let Setup { fleet, runtime, .. } = &setup_;
    spawn(fleet, request()).await.unwrap();
    assert_eq!(*asked.lock().unwrap(), vec![PathBuf::from("/work")]);
    assert!(runtime.instructions()[0].contains("## Standing orders"));
    assert!(runtime.instructions()[0].contains("1. Ask before a push."));
    let bare = setup(SetupOptions {
        standing_orders: Some(Arc::new(|_| String::new())),
        ..SetupOptions::default()
    });
    spawn(&bare.fleet, request()).await.unwrap();
    assert!(!bare.runtime.instructions()[0].contains("Standing orders"));
}

// orchestrator.test.ts: "records the role file a run starts with, its version and the standing orders' version, after the run's first state"
#[tokio::test(start_paused = true)]
async fn records_the_role_file_a_run_starts_with_its_version_and_the_standing_orders_version_after_the_runs_first_state()
 {
    // expected hashes: `printf '<text>' | sha256sum`, first 12 hex digits
    let user_role = AgentDefinition {
        source: RoleSource::User,
        file_path: PathBuf::from("/u/worker.md"),
        hash: Some("0123456789ab".to_owned()),
        ..role("worker")
    };
    let setup_with_role = setup(SetupOptions {
        agents: Some(vec![user_role]),
        standing_orders: Some(Arc::new(|_| "1. Ask before a push.".to_owned())),
        ..SetupOptions::default()
    });
    let run = spawn(&setup_with_role.fleet, request()).await.unwrap();
    let events: Vec<FleetEvent> = setup_with_role
        .events()
        .into_iter()
        .filter(|event| event_run(event) == run.id)
        .take(2)
        .collect();
    match &events[0] {
        FleetEvent::State(state) => assert_eq!(state.to, AgentState::Starting),
        other => panic!("not a state event: {other:?}"),
    }
    assert_eq!(
        events[1],
        FleetEvent::Role(RoleEvent {
            run: run.id.clone(),
            role: "worker".to_owned(),
            source: "user".to_owned(),
            file: "/u/worker.md".to_owned(),
            hash: "0123456789ab".to_owned(),
            standing: Some("edb086f7d809".to_owned()),
        })
    );
    let bare = setup(SetupOptions {
        agents: Some(vec![role("lead")]),
        standing_orders: Some(Arc::new(|_| String::new())),
        ..SetupOptions::default()
    });
    let lead = spawn(
        &bare.fleet,
        SpawnRequest {
            role: "lead".to_owned(),
            group: Some("g2".to_owned()),
            ..request()
        },
    )
    .await
    .unwrap();
    let role_event = bare
        .events()
        .into_iter()
        .find(|event| matches!(event, FleetEvent::Role(role) if role.run == lead.id))
        .unwrap();
    assert_eq!(
        role_event,
        FleetEvent::Role(RoleEvent {
            run: lead.id.clone(),
            role: "lead".to_owned(),
            source: "bundled".to_owned(),
            file: "lead.md".to_owned(),
            hash: "8bbc2266f7e2".to_owned(),
            standing: None,
        })
    );
}

fn event_run(event: &FleetEvent) -> &str {
    match event {
        FleetEvent::State(e) => &e.run,
        FleetEvent::Turn(e) => &e.run,
        FleetEvent::Role(e) => &e.run,
        FleetEvent::Person(e) => &e.run,
        FleetEvent::Standstill(e) => &e.run,
        FleetEvent::Reconciled(e) => &e.run,
        FleetEvent::Restart(e) => &e.run,
    }
}

// orchestrator.test.ts: "tells every agent the person's language when the config sets one, and writes no section without it"
#[tokio::test(start_paused = true)]
async fn tells_every_agent_the_persons_language_when_the_config_sets_one_and_writes_no_section_without_it()
 {
    let setup_ = setup(SetupOptions {
        config: Some(json!({ "language": "Japanese" })),
        ..SetupOptions::default()
    });
    let Setup { fleet, runtime, .. } = &setup_;
    spawn(fleet, request()).await.unwrap();
    let instructions = &runtime.instructions()[0];
    assert!(instructions.contains("## The person's language"));
    assert!(instructions.contains("The person reads Japanese. Write in Japanese what the person reads: your replies to the person, a plan, a question for the person"));
    assert!(instructions.contains("Write tasks and messages for other agents in English."));
    let bare = setup(SetupOptions::default());
    spawn(&bare.fleet, request()).await.unwrap();
    assert!(!bare.runtime.instructions()[0].contains("The person reads"));
}

// orchestrator.test.ts: "names the fleet command in every spawning instruction"
#[tokio::test(start_paused = true)]
async fn names_the_fleet_command_in_every_spawning_instruction() {
    let setup_ = setup(SetupOptions {
        agents: Some(vec![AgentDefinition {
            spawning: Some(true),
            ..role("worker")
        }]),
        ..SetupOptions::default()
    });
    let Setup { fleet, runtime, .. } = &setup_;
    spawn(fleet, request()).await.unwrap();
    assert!(runtime.instructions()[0].contains("(fleet list shows each agent's CLI)"));
    assert!(!runtime.instructions()[0].contains("${"));
}

// orchestrator.test.ts: "records the idle herdr shows right after a prompt as working"
#[tokio::test(start_paused = true)]
async fn records_the_idle_herdr_shows_right_after_a_prompt_as_working() {
    let setup_ = setup(SetupOptions::default());
    let Setup { fleet, runtime, .. } = &setup_;
    runtime.set_prompt_status(AgentState::Idle);
    assert_eq!(
        spawn(fleet, request()).await.unwrap().state,
        AgentState::Working
    );
}

// orchestrator.test.ts: "refuses an unknown role, an invalid thinking level and a caller too deep, before any pane"
#[tokio::test(start_paused = true)]
async fn refuses_an_unknown_role_an_invalid_thinking_level_and_a_caller_too_deep_before_any_pane() {
    let setup_ = setup(SetupOptions::default());
    let Setup { fleet, runtime, .. } = &setup_;
    let unknown = spawn(
        fleet,
        SpawnRequest {
            role: "nobody".to_owned(),
            ..request()
        },
    )
    .await
    .unwrap_err();
    assert!(
        unknown.to_string().contains("Unknown agent role"),
        "{unknown}"
    );
    let thinking = spawn(
        fleet,
        SpawnRequest {
            thinking: Some("turbo".to_owned()),
            ..request()
        },
    )
    .await
    .unwrap_err();
    assert!(
        thinking.to_string().contains("Invalid thinking level"),
        "{thinking}"
    );
    let deep = spawn(
        fleet,
        SpawnRequest {
            depth: Some(3),
            ..request()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(code(&deep), "depth_limit");
    let group = spawn(
        fleet,
        SpawnRequest {
            group: Some("bad group".to_owned()),
            ..request()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(code(&group), "invalid_group");
    assert!(runtime.locations().is_empty());
}

// orchestrator.test.ts: "closes the pane when the agent does not start, and records the failure"
#[tokio::test(start_paused = true)]
async fn closes_the_pane_when_the_agent_does_not_start_and_records_the_failure() {
    let setup_ = setup(SetupOptions::default());
    let Setup {
        fleet,
        runtime,
        registry,
        ..
    } = &setup_;
    runtime.on_start(|_| async {
        Err(RuntimeError::Herdr {
            code: "agent_start_failed_herdr".to_owned(),
            message: "boom".to_owned(),
        })
    });
    let error = spawn(fleet, request()).await.unwrap_err();
    assert!(error.to_string().contains("boom"), "{error}");
    assert_eq!(runtime.closed(), vec!["w1:p1".to_owned()]);
    let run = &registry.all()[0];
    assert_eq!(
        (run.state, run.last_error.as_deref()),
        (AgentState::Failed, Some("boom"))
    );
}

// orchestrator.test.ts: "leaves the task unsent when the agent stops at a question while starting"
#[tokio::test(start_paused = true)]
async fn leaves_the_task_unsent_when_the_agent_stops_at_a_question_while_starting() {
    let setup_ = setup(SetupOptions::default());
    let Setup { fleet, runtime, .. } = &setup_;
    runtime.on_start(|_| async { Ok(AgentState::Blocked) });
    let run = spawn(fleet, request()).await.unwrap();
    assert_eq!(run.state, AgentState::Blocked);
    assert!(run.last_error.as_deref().unwrap().contains("not been sent"));
    assert!(runtime.prompts().is_empty());
}

// orchestrator.test.ts: "leaves the task unsent when the agent never became ready, whatever state herdr reads afterwards"
#[tokio::test(start_paused = true)]
async fn leaves_the_task_unsent_when_the_agent_never_became_ready_whatever_state_herdr_reads_afterwards()
 {
    let setup_ = setup(SetupOptions::default());
    let Setup { fleet, runtime, .. } = &setup_;
    runtime.on_start(|_| async { Err(RuntimeError::NotReady("not ready within 30s".to_owned())) });
    runtime.set_get_status(AgentState::Idle);
    let run = spawn(fleet, request()).await.unwrap();
    assert_eq!(run.state, AgentState::Idle);
    assert!(run.last_error.as_deref().unwrap().contains("not been sent"));
    assert!(runtime.prompts().is_empty());
}

// orchestrator.test.ts: "checks the concurrency budget one spawn at a time, so parallel spawns cannot overshoot it"
#[tokio::test(start_paused = true)]
async fn checks_the_concurrency_budget_one_spawn_at_a_time_so_parallel_spawns_cannot_overshoot_it()
{
    let setup_ = setup(SetupOptions {
        config: Some(json!({ "maxConcurrent": 2 })),
        ..SetupOptions::default()
    });
    let Setup { fleet, runtime, .. } = &setup_;
    let counted = runtime.clone();
    runtime.on_create_location(move |options, _| {
        let pane = format!("w1:p{}", counted.locations().len());
        async move {
            sleep_ms(10).await;
            Ok(RuntimeLocation {
                pane_id: pane,
                workspace_id: None,
                cwd: options.cwd,
            })
        }
    });
    let (a, b, c) = tokio::join!(
        spawn(fleet, request()),
        spawn(fleet, request()),
        spawn(fleet, request())
    );
    let results = [a, b, c];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 2);
    let refused = results
        .iter()
        .find_map(|result| result.as_ref().err())
        .unwrap();
    assert_eq!(code(refused), "concurrency_limit");
}

// orchestrator.test.ts: "cancels a spawn during pane creation without leaving a run, and during start by closing the pane"
#[tokio::test(start_paused = true)]
async fn cancels_a_spawn_during_pane_creation_without_leaving_a_run_and_during_start_by_closing_the_pane()
 {
    let setup_ = setup(SetupOptions::default());
    let Setup {
        fleet,
        runtime,
        registry,
        ..
    } = &setup_;
    let at = |cwd: &str| SpawnRequest {
        task: Some("t".to_owned()),
        cwd: Some(cwd.to_owned()),
        ..request()
    };
    runtime.on_create_location(|options, cancel| async move {
        tokio::select! {
            () = sleep_ms(200) => Ok(RuntimeLocation { pane_id: "w1:p9".to_owned(), workspace_id: None, cwd: options.cwd }),
            () = cancel.cancelled() => Err(RuntimeError::Cancelled),
        }
    });
    let first = CancellationToken::new();
    let cancel = first.clone();
    tokio::spawn(async move {
        sleep_ms(10).await;
        cancel.cancel();
    });
    assert!(fleet.spawn(at("/w"), &first).await.is_err());
    assert!(registry.all().is_empty());

    runtime.overrides().create_location = None;
    runtime.on_start(|options| async move {
        tokio::select! {
            () = sleep_ms(200) => Ok(AgentState::Idle),
            () = options.cancel.cancelled() => Err(RuntimeError::Cancelled),
        }
    });
    let second = CancellationToken::new();
    let cancel = second.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(10)).await;
        cancel.cancel();
    });
    assert!(fleet.spawn(at("/w"), &second).await.is_err());
    assert_eq!(runtime.closed(), vec!["w1:p1".to_owned()]);
    let run = &registry.all()[0];
    assert_eq!(
        (run.state, run.last_error.as_deref()),
        (AgentState::Stopped, Some("Spawn cancelled."))
    );
}

// The futures `/api/fleet` runs in tasks of their own (tokio::spawn) must be Send (ADR
// 0242-phase-3-split, "取り消し").
#[test]
fn the_futures_the_api_spawns_are_send() {
    fn send<T: Send>(_: &T) {}
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(true)
        .build()
        .unwrap();
    runtime.block_on(async {
        let s = setup(SetupOptions::default());
        let none = CancellationToken::new();
        send(&s.fleet.spawn(request(), &none));
        send(&s.fleet.send("x", "t", None, &none));
        send(&s.fleet.wait("x", None, None, &none));
        send(&s.fleet.read("x", None, None));
        send(&s.fleet.interrupt("x", None));
        send(&s.fleet.focus("x", None));
        send(&s.fleet.close_done(None));
        send(&s.fleet.reconcile_all());
    });
}

// /code-review: the server's own files failing after the pane exists (here the results folder is
// a file) fail the run and close its pane, as a start that failed does
// (orchestrator.ts:600-607); nothing counts against the budget afterwards.
#[tokio::test(start_paused = true)]
async fn fails_the_run_and_closes_its_pane_when_its_result_folder_cannot_be_made() {
    let setup_ = setup(SetupOptions::default());
    let Setup {
        fleet,
        runtime,
        registry,
        root,
        ..
    } = &setup_;
    fs::write(root.join("results"), "not a folder").unwrap();
    let error = spawn(fleet, request()).await.unwrap_err();
    assert_eq!(code(&error), "internal_error");
    assert_eq!(runtime.closed(), vec!["w1:p1".to_owned()]);
    assert_eq!(registry.all()[0].state, AgentState::Failed);
}
