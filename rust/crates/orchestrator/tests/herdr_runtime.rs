//! `HerdrRuntime` through the `AgentRuntime` port, against the fake herdr of the herdr crate's
//! tests: each method's requests (method and params, as `server/fleet/runtime.ts` sends them) and
//! how herdr's answers and error codes come back. The expected requests are read off
//! `server/fleet/runtime.ts`; the tests in `mod live`, marked `#[ignore]`, are
//! `server/fleet/runtime.herdr.test.ts` against a real, isolated herdr session.

// the fake listens on a Unix socket; on Windows herdr is a named pipe (checked in phase 6)
#![cfg(unix)]

#[path = "../../herdr/tests/common/fake_herdr.rs"]
mod fake_herdr;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use fake_herdr::{FakeHerdr, Reply};
use herdr::Herdr;
use herdr_fleet_orchestrator::herdr_runtime::{HerdrRuntime, StartTimings};
use herdr_fleet_orchestrator::runtime::{
    AgentMetadata, AgentRuntime, CreateLocationOptions, RuntimeError, RuntimeLocation,
    SplitDirection, StartOptions,
};
use protocol::{AgentState, FleetAgentKind};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

// ---- herdr's answers, in the shapes of herdr 0.9.1 (ADR 0252-herdr-client's table) ----

fn pane(pane_id: &str, workspace_id: &str, agent: Option<&str>) -> Value {
    let mut pane = json!({
        "pane_id": pane_id, "workspace_id": workspace_id, "tab_id": "t1", "terminal_id": "term1",
        "agent_status": "unknown", "focused": false, "revision": 0,
    });
    if let Some(agent) = agent {
        pane["agent"] = json!(agent);
    }
    pane
}

fn workspace(workspace_id: &str) -> Value {
    json!({
        "workspace_id": workspace_id, "active_tab_id": "t1", "agent_status": "unknown",
        "focused": false, "label": "w", "number": 1, "pane_count": 1, "tab_count": 1,
    })
}

fn tab(workspace_id: &str) -> Value {
    json!({
        "tab_id": "t1", "workspace_id": workspace_id, "agent_status": "unknown", "focused": false,
        "label": "t", "number": 1, "pane_count": 1,
    })
}

fn pane_info(pane: Value) -> Value {
    json!({ "type": "pane_info", "pane": pane })
}

fn agent_info(status: &str, interactive_ready: Option<bool>, launch_pending: bool) -> Value {
    let mut agent = json!({
        "pane_id": "p9", "workspace_id": "w1", "tab_id": "t1", "terminal_id": "term1",
        "agent_status": status, "focused": false, "revision": 0, "launch_pending": launch_pending,
    });
    if let Some(ready) = interactive_ready {
        agent["interactive_ready"] = json!(ready);
    }
    json!({ "type": "agent_info", "agent": agent })
}

/// `agent.start`'s answer: at once, with the launch still pending (CLAUDE.md, "Herdr の socket
/// API の癖").
fn agent_started() -> Value {
    json!({
        "type": "agent_started",
        "agent": agent_info("unknown", None, true)["agent"],
        "argv": ["pi", "--model", "m"],
    })
}

fn pane_read(text: &str) -> Value {
    json!({
        "type": "pane_read",
        "read": {
            "pane_id": "p9", "workspace_id": "w1", "tab_id": "t1", "revision": 0,
            "format": "text", "source": "recent", "text": text, "truncated": false,
        },
    })
}

fn ok() -> Value {
    json!({ "type": "ok" })
}

fn method(request: &Value) -> &str {
    request["method"].as_str().unwrap_or_default()
}

/// The requests as `(method, params)`, in the order they arrived.
fn calls(fake: &FakeHerdr) -> Vec<(String, Value)> {
    fake.requests()
        .iter()
        .map(|request| (method(request).to_owned(), request["params"].clone()))
        .collect()
}

fn count(fake: &FakeHerdr, name: &str) -> usize {
    fake.requests().iter().filter(|r| method(r) == name).count()
}

/// Timings short enough that a test of the start's waits takes well under a second.
fn quick() -> StartTimings {
    StartTimings {
        timeout: Duration::from_millis(300),
        ready_poll: Duration::from_millis(10),
        failure_poll: Duration::from_millis(20),
        retry_step: Duration::from_millis(5),
    }
}

fn runtime(fake: &FakeHerdr) -> HerdrRuntime {
    HerdrRuntime::new(Herdr::new(fake.socket()))
}

fn quick_runtime(fake: &FakeHerdr) -> HerdrRuntime {
    runtime(fake).with_start_timings(quick())
}

fn env() -> BTreeMap<String, String> {
    BTreeMap::from([("HERDR_FLEET_GROUP".to_owned(), "g1".to_owned())])
}

fn location(
    worktree: bool,
    branch: Option<&str>,
    path: Option<&str>,
    direction: Option<SplitDirection>,
    caller: Option<&str>,
) -> CreateLocationOptions {
    CreateLocationOptions {
        cwd: "/repo".to_owned(),
        label: "helper".to_owned(),
        worktree,
        branch: branch.map(str::to_owned),
        path: path.map(str::to_owned),
        direction,
        caller_pane_id: caller.map(str::to_owned),
        env: env(),
    }
}

fn no_startup_error(_: &str) -> Option<String> {
    None
}

fn unknown_model(screen: &str) -> Option<String> {
    screen
        .lines()
        .find(|line| line.contains("Unknown model"))
        .map(str::to_owned)
}

fn start_options(startup_error: fn(&str) -> Option<String>) -> StartOptions {
    StartOptions {
        kind: FleetAgentKind::Pi,
        name: "fleet-a1".to_owned(),
        pane_id: "p9".to_owned(),
        args: vec!["--model".to_owned(), "m".to_owned()],
        startup_error,
        cancel: CancellationToken::new(),
    }
}

fn expected_start() -> (String, Value) {
    (
        "agent.start".to_owned(),
        json!({ "name": "fleet-a1", "kind": "pi", "pane_id": "p9", "args": ["--model", "m"] }),
    )
}

/// A fake whose `agent.get` answers `answers[n]` to its n-th call, and the last one after.
fn agent_get_sequence(answers: Vec<Value>) -> FakeHerdr {
    let calls = AtomicUsize::new(0);
    FakeHerdr::start(move |request| match method(request) {
        "agent.start" => Reply::result(request, agent_started()),
        "agent.get" => {
            let n = calls.fetch_add(1, Ordering::SeqCst).min(answers.len() - 1);
            Reply::result(request, answers[n].clone())
        }
        "pane.get" => Reply::result(request, pane_info(pane("p9", "w1", Some("pi")))),
        _ => Reply::error(request, "unexpected", "not scripted"),
    })
}

// ---- createLocation ----

mod create_location {
    use super::*;

    #[tokio::test]
    async fn a_worktree_run_splits_the_root_pane_with_the_env_then_closes_the_root() {
        let fake = FakeHerdr::start(|request| match method(request) {
            "worktree.create" => Reply::result(
                request,
                json!({
                    "type": "worktree_created", "workspace": workspace("w7"), "tab": tab("w7"),
                    "root_pane": pane("root1", "w7", None),
                    "worktree": {
                        "path": "/repo/.herdr-fleet/worktrees/t1", "label": "helper",
                        "is_bare": false, "is_detached": false, "is_linked_worktree": true,
                        "is_prunable": false,
                    },
                }),
            ),
            "pane.split" => Reply::result(request, pane_info(pane("p2", "w7", None))),
            "pane.close" => Reply::result(request, ok()),
            _ => Reply::error(request, "unexpected", "not scripted"),
        });
        let options = location(
            true,
            Some("fleet/t1"),
            Some("/repo/.herdr-fleet/worktrees/t1"),
            None,
            None,
        );

        let created = runtime(&fake)
            .create_location(options, &CancellationToken::new())
            .await
            .unwrap();

        assert_eq!(
            created,
            RuntimeLocation {
                pane_id: "p2".to_owned(),
                workspace_id: Some("w7".to_owned()),
                cwd: "/repo/.herdr-fleet/worktrees/t1".to_owned(),
            }
        );
        assert_eq!(
            calls(&fake),
            vec![
                (
                    "worktree.create".to_owned(),
                    json!({
                        "cwd": "/repo", "branch": "fleet/t1", "label": "helper", "focus": false,
                        "path": "/repo/.herdr-fleet/worktrees/t1",
                    })
                ),
                (
                    "pane.split".to_owned(),
                    json!({
                        "target_pane_id": "root1", "direction": "right",
                        "cwd": "/repo/.herdr-fleet/worktrees/t1",
                        "env": { "HERDR_FLEET_GROUP": "g1" }, "focus": false,
                    })
                ),
                ("pane.close".to_owned(), json!({ "pane_id": "root1" })),
            ]
        );
    }

    #[tokio::test]
    async fn a_worktree_run_without_a_path_lets_herdr_place_it_and_splits_the_way_asked() {
        let fake = FakeHerdr::start(|request| match method(request) {
            "worktree.create" => Reply::result(
                request,
                json!({
                    "type": "worktree_created", "workspace": workspace("w7"), "tab": tab("w7"),
                    "root_pane": pane("root1", "w7", None),
                    "worktree": {
                        "path": "/wt/fleet-t1", "label": "helper", "is_bare": false,
                        "is_detached": false, "is_linked_worktree": true, "is_prunable": false,
                    },
                }),
            ),
            "pane.split" => Reply::result(request, pane_info(pane("p2", "w7", None))),
            "pane.close" => Reply::result(request, ok()),
            _ => Reply::error(request, "unexpected", "not scripted"),
        });
        let options = location(
            true,
            Some("agents/scout-a1"),
            None,
            Some(SplitDirection::Down),
            None,
        );

        let created = runtime(&fake)
            .create_location(options, &CancellationToken::new())
            .await
            .unwrap();

        assert_eq!(created.cwd, "/wt/fleet-t1");
        let requests = calls(&fake);
        assert_eq!(
            requests[0].1,
            json!({ "cwd": "/repo", "branch": "agents/scout-a1", "label": "helper", "focus": false })
        );
        assert_eq!(requests[1].1["direction"], json!("down"));
        assert_eq!(requests[1].1["cwd"], json!("/wt/fleet-t1"));
    }

    #[tokio::test]
    async fn a_worktree_run_needs_a_branch_and_asks_herdr_nothing_without_one() {
        let fake = FakeHerdr::start(|request| Reply::error(request, "unexpected", "not scripted"));

        let error = runtime(&fake)
            .create_location(
                location(true, None, None, None, None),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();

        // a plain Error in TypeScript, which /api/fleet answers as internal_error
        assert_eq!(
            error,
            RuntimeError::Herdr {
                code: "internal_error".to_owned(),
                message: "A worktree run needs a branch name.".to_owned(),
            }
        );
        assert!(fake.requests().is_empty());
    }

    #[tokio::test]
    async fn a_callers_helper_with_a_direction_splits_the_callers_pane() {
        let fake = FakeHerdr::start(|request| match method(request) {
            "pane.split" => Reply::result(request, pane_info(pane("p3", "w2", None))),
            _ => Reply::error(request, "unexpected", "not scripted"),
        });

        let created = runtime(&fake)
            .create_location(
                location(
                    false,
                    None,
                    None,
                    Some(SplitDirection::Down),
                    Some("caller1"),
                ),
                &CancellationToken::new(),
            )
            .await
            .unwrap();

        assert_eq!(
            created,
            RuntimeLocation {
                pane_id: "p3".to_owned(),
                workspace_id: Some("w2".to_owned()),
                cwd: "/repo".to_owned(),
            }
        );
        assert_eq!(
            calls(&fake),
            vec![(
                "pane.split".to_owned(),
                json!({
                    "target_pane_id": "caller1", "direction": "down", "cwd": "/repo",
                    "env": { "HERDR_FLEET_GROUP": "g1" }, "focus": false,
                })
            )]
        );
    }

    #[tokio::test]
    async fn a_callers_helper_opens_in_a_new_tab_of_the_callers_workspace() {
        let fake = FakeHerdr::start(|request| match method(request) {
            "pane.get" => Reply::result(request, pane_info(pane("caller1", "w2", Some("claude")))),
            "tab.create" => Reply::result(
                request,
                json!({ "type": "tab_created", "tab": tab("w2"), "root_pane": pane("p4", "w2", None) }),
            ),
            _ => Reply::error(request, "unexpected", "not scripted"),
        });

        let created = runtime(&fake)
            .create_location(
                location(false, None, None, None, Some("caller1")),
                &CancellationToken::new(),
            )
            .await
            .unwrap();

        assert_eq!(
            created,
            RuntimeLocation {
                pane_id: "p4".to_owned(),
                workspace_id: Some("w2".to_owned()),
                cwd: "/repo".to_owned(),
            }
        );
        assert_eq!(
            calls(&fake),
            vec![
                ("pane.get".to_owned(), json!({ "pane_id": "caller1" })),
                (
                    "tab.create".to_owned(),
                    json!({
                        "workspace_id": "w2", "cwd": "/repo", "label": "helper",
                        "env": { "HERDR_FLEET_GROUP": "g1" }, "focus": false,
                    })
                ),
            ]
        );
    }

    #[tokio::test]
    async fn without_a_caller_the_agent_gets_a_workspace_of_its_own() {
        let fake = FakeHerdr::start(|request| match method(request) {
            "workspace.create" => Reply::result(
                request,
                json!({
                    "type": "workspace_created", "workspace": workspace("w5"), "tab": tab("w5"),
                    "root_pane": pane("p5", "w5", None),
                }),
            ),
            _ => Reply::error(request, "unexpected", "not scripted"),
        });

        let created = runtime(&fake)
            .create_location(
                location(false, None, None, Some(SplitDirection::Right), None),
                &CancellationToken::new(),
            )
            .await
            .unwrap();

        assert_eq!(
            created,
            RuntimeLocation {
                pane_id: "p5".to_owned(),
                workspace_id: Some("w5".to_owned()),
                cwd: "/repo".to_owned(),
            }
        );
        assert_eq!(
            calls(&fake),
            vec![(
                "workspace.create".to_owned(),
                json!({
                    "cwd": "/repo", "label": "helper", "env": { "HERDR_FLEET_GROUP": "g1" },
                    "focus": false,
                })
            )]
        );
    }

    #[tokio::test]
    async fn a_cancelled_request_asks_herdr_nothing() {
        let fake = FakeHerdr::start(|request| Reply::error(request, "unexpected", "not scripted"));
        let cancel = CancellationToken::new();
        cancel.cancel();

        let error = runtime(&fake)
            .create_location(location(false, None, None, None, None), &cancel)
            .await
            .unwrap_err();

        assert_eq!(error, RuntimeError::Cancelled);
        assert!(fake.requests().is_empty());
    }

    #[tokio::test]
    async fn herdrs_error_comes_back_with_its_code() {
        let fake = FakeHerdr::start(|request| {
            Reply::error(request, "workspace_failed", "cannot open /repo")
        });

        let error = runtime(&fake)
            .create_location(
                location(false, None, None, None, None),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();

        assert_eq!(
            error,
            RuntimeError::Herdr {
                code: "workspace_failed".to_owned(),
                message: "cannot open /repo".to_owned(),
            }
        );
    }
}

// ---- start ----

mod start {
    use super::*;

    #[test]
    fn the_default_timings_are_typescripts() {
        // START_TIMEOUT_MS, READY_POLL_MS, FAILURE_POLL_MS and the retry's `300 * (attempt + 1)`
        // in server/fleet/runtime.ts
        assert_eq!(
            StartTimings::default(),
            StartTimings {
                timeout: Duration::from_secs(30),
                ready_poll: Duration::from_millis(250),
                failure_poll: Duration::from_millis(500),
                retry_step: Duration::from_millis(300),
            }
        );
    }

    #[tokio::test]
    async fn waits_past_launch_pending_until_herdr_says_interactive_ready() {
        let fake = agent_get_sequence(vec![
            agent_info("unknown", None, true),
            agent_info("unknown", Some(false), true),
            agent_info("idle", Some(true), false),
        ]);

        let state = quick_runtime(&fake)
            .start(start_options(no_startup_error))
            .await
            .unwrap();

        assert_eq!(state, AgentState::Idle);
        let requests = calls(&fake);
        assert_eq!(requests[0], expected_start());
        let gets: Vec<_> = requests
            .iter()
            .filter(|(name, _)| name == "agent.get")
            .collect();
        assert_eq!(gets.len(), 3);
        assert_eq!(gets[0].1, json!({ "target": "fleet-a1" }));
    }

    #[tokio::test]
    async fn polls_agent_get_every_250_milliseconds_by_default() {
        let fake = agent_get_sequence(vec![
            agent_info("unknown", None, true),
            agent_info("unknown", None, true),
            agent_info("idle", Some(true), false),
        ]);
        let began = Instant::now();

        let state = runtime(&fake)
            .start(start_options(no_startup_error))
            .await
            .unwrap();

        assert_eq!(state, AgentState::Idle);
        // two waits of 250 ms between the three asks
        assert!(
            began.elapsed() >= Duration::from_millis(500),
            "{:?}",
            began.elapsed()
        );
        assert_eq!(count(&fake, "agent.get"), 3);
    }

    #[tokio::test]
    async fn a_question_before_the_first_prompt_is_blocked() {
        let fake = agent_get_sequence(vec![agent_info("blocked", Some(false), false)]);

        let state = quick_runtime(&fake)
            .start(start_options(no_startup_error))
            .await
            .unwrap();

        assert_eq!(state, AgentState::Blocked);
    }

    #[tokio::test]
    async fn a_failed_agent_get_is_asked_again() {
        let calls = AtomicUsize::new(0);
        let fake = FakeHerdr::start(move |request| match method(request) {
            "agent.start" => Reply::result(request, agent_started()),
            "agent.get" if calls.fetch_add(1, Ordering::SeqCst) == 0 => {
                Reply::error(request, "agent_not_found", "no agent yet")
            }
            "agent.get" => Reply::result(request, agent_info("working", Some(true), false)),
            _ => Reply::error(request, "unexpected", "not scripted"),
        });

        let state = quick_runtime(&fake)
            .start(start_options(no_startup_error))
            .await
            .unwrap();

        assert_eq!(state, AgentState::Working);
    }

    #[tokio::test]
    async fn not_ready_within_the_timeout_is_not_ready() {
        let fake = agent_get_sequence(vec![agent_info("unknown", Some(false), true)]);

        let error = quick_runtime(&fake)
            .start(start_options(no_startup_error))
            .await
            .unwrap_err();

        // `${name} did not become ready within ${START_TIMEOUT_MS / 1000}s`, with 300 ms
        assert_eq!(
            error,
            RuntimeError::NotReady("fleet-a1 did not become ready within 0.3s".to_owned())
        );
    }

    #[tokio::test]
    async fn an_agent_cli_that_gives_up_at_startup_is_a_start_failure() {
        let fake = FakeHerdr::start(|request| match method(request) {
            "agent.start" => Reply::result(request, agent_started()),
            "agent.get" => Reply::result(request, agent_info("unknown", Some(false), true)),
            // the CLI quit: herdr no longer names an agent in the pane
            "pane.get" => Reply::result(request, pane_info(pane("p9", "w1", None))),
            "pane.read" => {
                Reply::result(request, pane_read("$ pi --model m\nUnknown model: m\n$ "))
            }
            _ => Reply::error(request, "unexpected", "not scripted"),
        });

        let error = quick_runtime(&fake)
            .start(start_options(unknown_model))
            .await
            .unwrap_err();

        assert_eq!(
            error,
            RuntimeError::StartFailed("Unknown model: m".to_owned())
        );
        let requests = calls(&fake);
        assert!(requests.contains(&("pane.get".to_owned(), json!({ "pane_id": "p9" }))));
        assert!(requests.contains(&(
            "pane.read".to_owned(),
            json!({ "pane_id": "p9", "source": "recent", "lines": 40 })
        )));
    }

    #[tokio::test]
    async fn the_screen_is_not_read_while_herdr_still_names_the_agent() {
        let fake = agent_get_sequence(vec![
            agent_info("unknown", Some(false), true),
            agent_info("unknown", Some(false), true),
            agent_info("unknown", Some(false), true),
            agent_info("unknown", Some(false), true),
            agent_info("unknown", Some(false), true),
            agent_info("unknown", Some(false), true),
            agent_info("idle", Some(true), false),
        ]);

        let state = quick_runtime(&fake)
            .start(start_options(unknown_model))
            .await
            .unwrap();

        assert_eq!(state, AgentState::Idle);
        assert!(count(&fake, "pane.get") >= 1);
        assert_eq!(count(&fake, "pane.read"), 0);
    }

    #[tokio::test]
    async fn retries_a_pane_that_has_no_shell_yet_up_to_four_times() {
        let calls = AtomicUsize::new(0);
        let fake = FakeHerdr::start(move |request| match method(request) {
            "agent.start" if calls.fetch_add(1, Ordering::SeqCst) < 4 => Reply::error(
                request,
                "agent_start_rejected",
                "pane p9 is not an available shell",
            ),
            "agent.start" => Reply::result(request, agent_started()),
            "agent.get" => Reply::result(request, agent_info("idle", Some(true), false)),
            _ => Reply::error(request, "unexpected", "not scripted"),
        });

        let state = quick_runtime(&fake)
            .start(start_options(no_startup_error))
            .await
            .unwrap();

        assert_eq!(state, AgentState::Idle);
        assert_eq!(count(&fake, "agent.start"), 5);
    }

    #[tokio::test]
    async fn gives_up_after_the_fourth_retry_with_herdrs_error() {
        let fake = FakeHerdr::start(|request| {
            Reply::error(
                request,
                "agent_start_rejected",
                "Pane p9 is Not An Available Shell",
            )
        });

        let error = quick_runtime(&fake)
            .start(start_options(no_startup_error))
            .await
            .unwrap_err();

        assert_eq!(
            error,
            RuntimeError::Herdr {
                code: "agent_start_rejected".to_owned(),
                message: "Pane p9 is Not An Available Shell".to_owned(),
            }
        );
        assert_eq!(count(&fake, "agent.start"), 5);
    }

    #[tokio::test]
    async fn waits_longer_before_each_retry() {
        let calls = AtomicUsize::new(0);
        let fake = FakeHerdr::start(move |request| match method(request) {
            "agent.start" if calls.fetch_add(1, Ordering::SeqCst) < 2 => {
                Reply::error(request, "x", "not an available shell")
            }
            "agent.start" => Reply::result(request, agent_started()),
            "agent.get" => Reply::result(request, agent_info("idle", Some(true), false)),
            _ => Reply::error(request, "unexpected", "not scripted"),
        });
        let began = Instant::now();

        runtime(&fake)
            .start(start_options(no_startup_error))
            .await
            .unwrap();

        // 300 ms, then 600 ms
        assert!(
            began.elapsed() >= Duration::from_millis(900),
            "{:?}",
            began.elapsed()
        );
    }

    #[tokio::test]
    async fn another_refusal_is_not_retried_and_keeps_its_meaning() {
        let fake =
            FakeHerdr::start(|request| Reply::error(request, "pane_not_found", "no pane p9"));

        let error = quick_runtime(&fake)
            .start(start_options(no_startup_error))
            .await
            .unwrap_err();

        assert_eq!(error, RuntimeError::NotFound);
        assert_eq!(count(&fake, "agent.start"), 1);
    }

    #[tokio::test]
    async fn a_cancelled_start_asks_herdr_nothing() {
        let fake = FakeHerdr::start(|request| Reply::error(request, "unexpected", "not scripted"));
        let options = start_options(no_startup_error);
        options.cancel.cancel();

        let error = quick_runtime(&fake).start(options).await.unwrap_err();

        assert_eq!(error, RuntimeError::Cancelled);
        assert!(fake.requests().is_empty());
    }

    #[tokio::test]
    async fn a_cancel_while_waiting_for_ready_stops_the_wait() {
        let fake = agent_get_sequence(vec![agent_info("unknown", Some(false), true)]);
        let options = start_options(no_startup_error);
        let cancel = options.cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancel.cancel();
        });
        let began = Instant::now();

        let error = runtime(&fake).start(options).await.unwrap_err();

        assert_eq!(error, RuntimeError::Cancelled);
        assert!(
            began.elapsed() < Duration::from_secs(5),
            "{:?}",
            began.elapsed()
        );
    }
}

// ---- the other methods ----

mod calls {
    use super::*;

    #[tokio::test]
    async fn close_pane_closes_the_pane() {
        let fake = FakeHerdr::start(|request| Reply::result(request, ok()));

        runtime(&fake).close_pane("p9").await.unwrap();

        assert_eq!(
            calls(&fake),
            vec![("pane.close".to_owned(), json!({ "pane_id": "p9" }))]
        );
    }

    #[tokio::test]
    async fn prompt_sends_the_text_then_reads_the_state() {
        let fake = FakeHerdr::start(|request| match method(request) {
            "agent.prompt" => Reply::result(
                request,
                json!({ "type": "agent_prompted", "agent": agent_info("working", Some(true), false)["agent"] }),
            ),
            "agent.get" => Reply::result(request, agent_info("working", Some(true), false)),
            _ => Reply::error(request, "unexpected", "not scripted"),
        });

        let state = runtime(&fake)
            .prompt("fleet-a1", "do it", &CancellationToken::new())
            .await
            .unwrap();

        assert_eq!(state, AgentState::Working);
        assert_eq!(
            calls(&fake),
            vec![
                (
                    "agent.prompt".to_owned(),
                    json!({ "target": "fleet-a1", "text": "do it" })
                ),
                ("agent.get".to_owned(), json!({ "target": "fleet-a1" })),
            ]
        );
    }

    #[tokio::test]
    async fn a_cancelled_prompt_is_not_sent() {
        let fake = FakeHerdr::start(|request| Reply::error(request, "unexpected", "not scripted"));
        let cancel = CancellationToken::new();
        cancel.cancel();

        let error = runtime(&fake)
            .prompt("fleet-a1", "do it", &cancel)
            .await
            .unwrap_err();

        assert_eq!(error, RuntimeError::Cancelled);
        assert!(fake.requests().is_empty());
    }

    #[tokio::test]
    async fn get_keeps_herdrs_four_states_and_calls_the_rest_unknown() {
        for (status, expected) in [
            ("working", AgentState::Working),
            ("idle", AgentState::Idle),
            ("done", AgentState::Done),
            ("blocked", AgentState::Blocked),
            ("unknown", AgentState::Unknown),
            ("thinking", AgentState::Unknown),
        ] {
            let fake = FakeHerdr::start(move |request| {
                Reply::result(request, agent_info(status, Some(true), false))
            });

            let state = runtime(&fake).get("fleet-a1").await.unwrap();

            assert_eq!(state, expected, "{status}");
            assert_eq!(
                calls(&fake),
                vec![("agent.get".to_owned(), json!({ "target": "fleet-a1" }))]
            );
        }
    }

    #[tokio::test]
    async fn read_reads_the_recent_unwrapped_lines() {
        let fake = FakeHerdr::start(|request| Reply::result(request, pane_read("one\ntwo")));

        let text = runtime(&fake).read("fleet-a1", 80).await.unwrap();

        assert_eq!(text, "one\ntwo");
        assert_eq!(
            calls(&fake),
            vec![(
                "agent.read".to_owned(),
                json!({ "target": "fleet-a1", "source": "recent_unwrapped", "lines": 80 })
            )]
        );
    }

    fn screen_fake(scroll: Option<Value>, agent_get_fails: bool) -> FakeHerdr {
        FakeHerdr::start(move |request| match method(request) {
            "agent.get" if agent_get_fails => Reply::error(request, "agent_not_found", "gone"),
            "agent.get" => Reply::result(request, agent_info("idle", Some(true), false)),
            "pane.get" => {
                let mut info = pane("p9", "w1", Some("pi"));
                if let Some(scroll) = &scroll {
                    info["scroll"] = scroll.clone();
                }
                Reply::result(request, pane_info(info))
            }
            "agent.read" => Reply::result(request, pane_read("\u{1b}[2mdim\u{1b}[0m")),
            _ => Reply::error(request, "unexpected", "not scripted"),
        })
    }

    #[tokio::test]
    async fn screen_reads_the_visible_screen_with_its_colors() {
        let fake = screen_fake(
            Some(
                json!({ "offset_from_bottom": 0, "max_offset_from_bottom": 40, "viewport_rows": 24 }),
            ),
            false,
        );

        let screen = runtime(&fake).screen("fleet-a1").await.unwrap();

        assert_eq!(screen, "\u{1b}[2mdim\u{1b}[0m");
        assert_eq!(
            calls(&fake),
            vec![
                ("agent.get".to_owned(), json!({ "target": "fleet-a1" })),
                ("pane.get".to_owned(), json!({ "pane_id": "p9" })),
                (
                    "agent.read".to_owned(),
                    json!({ "target": "fleet-a1", "source": "visible", "format": "ansi", "strip_ansi": false })
                ),
            ]
        );
    }

    #[tokio::test]
    async fn screen_reads_the_bottom_of_the_output_while_the_pane_is_scrolled_up() {
        let fake = screen_fake(
            Some(
                json!({ "offset_from_bottom": 40, "max_offset_from_bottom": 56, "viewport_rows": 24 }),
            ),
            false,
        );

        runtime(&fake).screen("fleet-a1").await.unwrap();

        assert_eq!(
            calls(&fake).last().unwrap(),
            &(
                "agent.read".to_owned(),
                json!({ "target": "fleet-a1", "source": "recent", "lines": 24, "format": "ansi", "strip_ansi": false })
            )
        );
    }

    #[tokio::test]
    async fn screen_reads_the_visible_screen_when_the_scroll_is_unknown() {
        for fake in [screen_fake(None, false), screen_fake(None, true)] {
            runtime(&fake).screen("fleet-a1").await.unwrap();

            assert_eq!(
                calls(&fake).last().unwrap(),
                &(
                    "agent.read".to_owned(),
                    json!({ "target": "fleet-a1", "source": "visible", "format": "ansi", "strip_ansi": false })
                )
            );
        }
    }

    #[tokio::test]
    async fn interrupt_sends_escape() {
        let fake = FakeHerdr::start(|request| Reply::result(request, ok()));

        runtime(&fake).interrupt("fleet-a1").await.unwrap();

        assert_eq!(
            calls(&fake),
            vec![(
                "agent.send_keys".to_owned(),
                json!({ "target": "fleet-a1", "keys": ["esc"] })
            )]
        );
    }

    #[tokio::test]
    async fn focus_focuses_the_agent() {
        let fake = FakeHerdr::start(|request| {
            Reply::result(request, agent_info("idle", Some(true), false))
        });

        runtime(&fake).focus("fleet-a1").await.unwrap();

        assert_eq!(
            calls(&fake),
            vec![("agent.focus".to_owned(), json!({ "target": "fleet-a1" }))]
        );
    }

    #[tokio::test]
    async fn report_metadata_reports_as_herdr_fleet() {
        let fake = FakeHerdr::start(|request| Reply::result(request, ok()));

        runtime(&fake)
            .report_metadata(AgentMetadata {
                pane_id: "p9".to_owned(),
                title: "scout: find it".to_owned(),
                display_agent: "pi".to_owned(),
                tokens: BTreeMap::from([("role".to_owned(), "scout".to_owned())]),
            })
            .await
            .unwrap();

        assert_eq!(
            calls(&fake),
            vec![(
                "pane.report_metadata".to_owned(),
                json!({
                    "pane_id": "p9", "source": "herdr-fleet", "title": "scout: find it",
                    "display_agent": "pi", "tokens": { "role": "scout" },
                })
            )]
        );
    }

    #[tokio::test]
    async fn an_answer_whose_shape_typescript_does_not_read_is_not_a_failure() {
        // TypeScript never reads what pane.close, agent.prompt, agent.focus, agent.send_keys,
        // agent.start and pane.report_metadata answer: a prompt sent must not count as failed
        let fake = FakeHerdr::start(|request| match method(request) {
            "agent.get" => Reply::result(request, agent_info("working", Some(true), false)),
            _ => Reply::result(request, json!({ "type": "something_new" })),
        });
        let runtime = runtime(&fake);

        runtime.close_pane("p9").await.unwrap();
        runtime
            .prompt("fleet-a1", "x", &CancellationToken::new())
            .await
            .unwrap();
        runtime.focus("fleet-a1").await.unwrap();
        runtime.interrupt("fleet-a1").await.unwrap();
    }
}

// ---- herdr's error codes ----

mod errors {
    use super::*;

    async fn get_error(code: &str, message: &str) -> RuntimeError {
        let (code, message) = (code.to_owned(), message.to_owned());
        let fake = FakeHerdr::start(move |request| Reply::error(request, &code, &message));
        runtime(&fake).get("fleet-a1").await.unwrap_err()
    }

    #[tokio::test]
    async fn agent_blocked_is_blocked() {
        assert_eq!(
            get_error("agent_blocked", "waiting").await,
            RuntimeError::Blocked
        );
    }

    #[tokio::test]
    async fn the_three_not_found_codes_are_not_found() {
        for code in ["agent_not_found", "not_found", "pane_not_found"] {
            assert_eq!(
                get_error(code, "gone").await,
                RuntimeError::NotFound,
                "{code}"
            );
        }
    }

    #[tokio::test]
    async fn any_other_code_keeps_its_code_and_message() {
        assert_eq!(
            get_error("agent_start_failed", "herdr's own").await,
            RuntimeError::Herdr {
                code: "agent_start_failed".to_owned(),
                message: "herdr's own".to_owned(),
            }
        );
    }

    #[tokio::test]
    async fn a_refused_prompt_is_blocked() {
        let fake = FakeHerdr::start(|request| Reply::error(request, "agent_blocked", "question"));

        let error = runtime(&fake)
            .prompt("fleet-a1", "x", &CancellationToken::new())
            .await
            .unwrap_err();

        assert_eq!(error, RuntimeError::Blocked);
    }

    #[tokio::test]
    async fn closing_a_pane_herdr_no_longer_has_is_not_found() {
        let fake = FakeHerdr::start(|request| Reply::error(request, "pane_not_found", "no p9"));

        assert_eq!(
            runtime(&fake).close_pane("p9").await.unwrap_err(),
            RuntimeError::NotFound
        );
    }

    #[tokio::test]
    async fn an_unreachable_herdr_is_connect_failed() {
        let dir = fake_herdr::fresh_dir();
        let runtime = HerdrRuntime::new(Herdr::new(dir.join("absent.sock")));

        let error = runtime.get("fleet-a1").await.unwrap_err();

        assert_eq!(error.code(), "connect_failed");
        assert!(matches!(error, RuntimeError::Herdr { .. }));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn an_answer_of_another_shape_where_typescript_reads_one_is_bad_frame() {
        let fake = FakeHerdr::start(|request| Reply::result(request, ok()));

        let error = runtime(&fake).get("fleet-a1").await.unwrap_err();

        assert_eq!(error.code(), "bad_frame");
    }
}

// ---- against a real herdr ----

/// `server/fleet/runtime.herdr.test.ts`, against an isolated herdr session: `HERDR_SOCKET` names
/// the socket of a session `herdr-fleet-rs-<run id>`, never the one you work in.
mod live {
    use super::*;
    use herdr::herdr_api::{self, methods};
    use serde::de::DeserializeOwned;

    /// One test at a time, as Bun runs a file's tests.
    static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn socket() -> std::path::PathBuf {
        let socket = std::env::var_os("HERDR_SOCKET")
            .expect("set HERDR_SOCKET to an isolated herdr session's socket");
        assert!(
            socket.to_string_lossy().contains("herdr-fleet-rs-"),
            "HERDR_SOCKET must name a session herdr-fleet-rs-<run id>, not the one you work in"
        );
        socket.into()
    }

    fn params<P: DeserializeOwned>(value: Value) -> P {
        serde_json::from_value(value).expect("params of the schema")
    }

    /// The workspaces and folders a test made, closed and removed when it ends.
    struct Cleanup {
        herdr: Herdr,
        workspaces: Vec<String>,
        folders: Vec<std::path::PathBuf>,
    }

    impl Cleanup {
        async fn run(self) {
            for id in &self.workspaces {
                let _ = self
                    .herdr
                    .rpc::<methods::WorkspaceClose>(params(json!({ "workspace_id": id })))
                    .await;
            }
            for folder in &self.folders {
                let _ = std::fs::remove_dir_all(folder);
            }
        }
    }

    async fn workspace_create(
        herdr: &Herdr,
        label: &str,
    ) -> herdr_api::ResponseResultWorkspaceCreated {
        herdr
            .call::<methods::WorkspaceCreate>(params(
                json!({ "cwd": "/tmp", "label": label, "focus": false }),
            ))
            .await
            .unwrap()
    }

    async fn pane_get(herdr: &Herdr, pane_id: &str) -> herdr_api::PaneInfo {
        herdr
            .call::<methods::PaneGet>(params(json!({ "pane_id": pane_id })))
            .await
            .unwrap()
            .pane
    }

    // runtime.herdr.test.ts: "opens a caller's helper in a new tab of the caller's workspace, and
    // splits only when asked"
    #[tokio::test]
    #[ignore = "needs an isolated herdr session (HERDR_SOCKET)"]
    async fn opens_a_callers_helper_in_a_new_tab_of_the_callers_workspace_and_splits_only_when_asked()
     {
        let _turn = ONE_AT_A_TIME.lock().await;
        let herdr = Herdr::new(socket());
        let mut cleanup = Cleanup {
            herdr: herdr.clone(),
            workspaces: Vec::new(),
            folders: Vec::new(),
        };
        let created = workspace_create(&herdr, "fleet-contract-caller").await;
        let workspace_id = created.workspace.workspace_id.clone();
        cleanup.workspaces.push(workspace_id.clone());
        let caller = created.root_pane.pane_id.clone();
        let runtime = HerdrRuntime::new(herdr.clone());

        let mut options = location(false, None, None, None, Some(&caller));
        options.cwd = "/tmp".to_owned();
        options.env = BTreeMap::from([("HERDR_FLEET_GROUP".to_owned(), "contract".to_owned())]);
        let tab = runtime
            .create_location(options, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(tab.workspace_id.as_deref(), Some(workspace_id.as_str()));
        let tab_pane = pane_get(&herdr, &tab.pane_id).await;
        assert_eq!(tab_pane.workspace_id, workspace_id);
        assert_ne!(tab_pane.tab_id, created.root_pane.tab_id);

        let mut options = location(false, None, None, Some(SplitDirection::Down), Some(&caller));
        options.cwd = "/tmp".to_owned();
        options.label = "beside".to_owned();
        options.env = BTreeMap::new();
        let split = runtime
            .create_location(options, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            pane_get(&herdr, &split.pane_id).await.tab_id,
            created.root_pane.tab_id
        );

        cleanup.run().await;
    }

    // runtime.herdr.test.ts: "puts a thread's worktree where it is told: inside the repository"
    #[tokio::test]
    #[ignore = "needs an isolated herdr session (HERDR_SOCKET)"]
    async fn puts_a_threads_worktree_where_it_is_told_inside_the_repository() {
        let _turn = ONE_AT_A_TIME.lock().await;
        let herdr = Herdr::new(socket());
        let repo = fake_herdr::fresh_dir().canonicalize().unwrap();
        let mut cleanup = Cleanup {
            herdr: herdr.clone(),
            workspaces: Vec::new(),
            folders: vec![repo.clone()],
        };
        let git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .status()
                .expect("run git");
            assert!(status.success(), "git {args:?}");
        };
        let repo_text = repo.to_str().unwrap().to_owned();
        git(&["init", "-q", &repo_text]);
        git(&[
            "-C",
            &repo_text,
            "-c",
            "user.email=e2e@example.invalid",
            "-c",
            "user.name=e2e",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
        ]);
        let path = repo.join(".herdr-fleet").join("worktrees").join("t1");
        let path_text = path.to_str().unwrap().to_owned();

        let mut options = location(true, Some("fleet/t1"), Some(&path_text), None, None);
        options.cwd = repo_text;
        options.label = "thread".to_owned();
        options.env = BTreeMap::new();
        let created = HerdrRuntime::new(herdr.clone())
            .create_location(options, &CancellationToken::new())
            .await
            .unwrap();
        if let Some(id) = &created.workspace_id {
            cleanup.workspaces.push(id.clone());
        }

        assert_eq!(created.cwd, path_text);
        assert!(path.join(".git").exists());
        cleanup.run().await;
    }

    // runtime.herdr.test.ts: "regression: reads the live bottom with its colors while the pane is
    // scrolled up into its history"
    #[tokio::test]
    #[ignore = "needs an isolated herdr session (HERDR_SOCKET)"]
    async fn reads_the_live_bottom_with_its_colors_while_the_pane_is_scrolled_up_into_its_history()
    {
        let _turn = ONE_AT_A_TIME.lock().await;
        let herdr = Herdr::new(socket());
        let created = workspace_create(&herdr, "fleet-contract-screen").await;
        let cleanup = Cleanup {
            herdr: herdr.clone(),
            workspaces: vec![created.workspace.workspace_id.clone()],
            folders: Vec::new(),
        };
        let pane = created.root_pane.pane_id.clone();
        // a CLI on the normal screen, with its input at the bottom and a dim placeholder in it
        herdr
            .rpc::<methods::PaneSendText>(params(json!({
                "pane_id": pane,
                "text": "for i in $(seq 1 80); do echo line $i; done; printf '\\033[2mdim placeholder\\033[0m\\n'\n",
            })))
            .await
            .unwrap();
        herdr
            .rpc::<methods::PaneReportAgent>(params(json!({
                "pane_id": pane, "source": "manual", "agent": "pi", "state": "idle",
            })))
            .await
            .unwrap();
        let runtime = HerdrRuntime::new(herdr.clone());
        for _ in 0..40 {
            if runtime.screen(&pane).await.unwrap().contains("line 80") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // a drag or the wheel in the web terminal leaves the viewport on old output
        herdr
            .rpc::<methods::PaneScroll>(params(
                json!({ "pane_id": pane, "offset_from_bottom": 40 }),
            ))
            .await
            .unwrap();

        let screen = runtime.screen(&pane).await.unwrap();

        assert!(screen.contains("\u{1b}[2mdim placeholder"), "{screen:?}");
        cleanup.run().await;
    }
}
