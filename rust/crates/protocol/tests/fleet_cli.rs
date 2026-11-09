//! The types the `fleet` CLI reads `/api/fleet`'s answers into (`protocol::fleet_cli`), checked
//! against the fleet CLI corpus (`fixtures/fleet-cli/`): every JSON body the stub server answers
//! reads into the type of the route it answers and writes back to the same JSON value, numbers by
//! value. A missing field and an unknown kind or state never fail, as in `bin/fleet.ts`; and every
//! field the CLI reads has the name the server's types write.

use std::fs;
use std::path::{Path, PathBuf};

use herdr_fleet_protocol::fleet_cli::{
    ClearedBody, ErrorBody, PlanBody, ReportBody, Role, RolesBody, Run, RunBody, RunsBody,
    TextBody, ThreadsBody, UsageBody,
};
use herdr_fleet_protocol::{
    AgentRun, AgentState, ContractState, FLEET_API, ThreadState, ThreadSummary, UsageEntry,
    fleet_cli, fleet_routes,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn corpus() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/fleet-cli")
}

/// The same JSON value, numbers compared by value (ADR 0192-phase-2-split, "corpus の runner").
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| same(a, b)))
        }
        _ => a == b,
    }
}

/// Reads `body` as a `T` and writes it back; the difference, if any.
fn round_trip<T: DeserializeOwned + Serialize>(body: &Value) -> Result<(), String> {
    let typed: T = serde_json::from_value(body.clone()).map_err(|error| error.to_string())?;
    let written = serde_json::to_value(typed).map_err(|error| error.to_string())?;
    if same(&written, body) {
        Ok(())
    } else {
        Err(format!("wrote {written}"))
    }
}

/// Whether `path` (relative to `/api/fleet`, without its query) is `route`, `{target}` standing
/// for any segment.
fn is(route: &str, path: &str) -> bool {
    let route: Vec<&str> = route.split('/').collect();
    let path: Vec<&str> = path.split('/').collect();
    route.len() == path.len()
        && route
            .iter()
            .zip(&path)
            .all(|(route, path)| *route == "{target}" && !path.is_empty() || route == path)
}

/// The body type the CLI reads the answer to `method path` with, by its `bin/fleet.ts` call.
fn read_as(method: &str, path: &str, status: u64, body: &Value) -> Result<(), String> {
    use fleet_routes::*;
    if status >= 400 {
        return round_trip::<ErrorBody>(body);
    }
    let run_posts = [
        SPAWN,
        THREADS,
        PROJECTS,
        RUN_SEND,
        RUN_WAIT,
        RUN_INTERRUPT,
        RUN_FOCUS,
    ];
    match method {
        "POST" if run_posts.iter().any(|route| is(route, path)) => round_trip::<RunBody>(body),
        "POST" if is(CLOSE_DONE, path) => round_trip::<RunsBody>(body),
        "POST" if is(RUN_PLAN, path) => round_trip::<PlanBody>(body),
        "POST" if is(USAGE_CLEAR, path) => round_trip::<ClearedBody>(body),
        "POST" if is(USAGE_REFRESH, path) => round_trip::<UsageBody>(body),
        "GET" if is(RUNS, path) => round_trip::<RunsBody>(body),
        "GET" if is(THREADS, path) => round_trip::<ThreadsBody>(body),
        "GET" if is(RUN_READ, path) => round_trip::<TextBody>(body),
        "GET" if is(ROLES, path) => round_trip::<RolesBody>(body),
        "GET" if is(REPORT, path) => round_trip::<ReportBody>(body),
        _ => Err(format!("the CLI does not call {method} {path}")),
    }
}

#[test]
fn every_body_of_the_corpus_reads_into_the_cli_type_and_writes_back_the_same() {
    let mut cases = 0;
    let mut json_bodies = 0;
    let mut text_bodies = 0;
    let mut failures = Vec::new();
    let mut files: Vec<PathBuf> = fs::read_dir(corpus())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    files.sort();
    for file in &files {
        cases += 1;
        let name = file.file_stem().unwrap().to_string_lossy().into_owned();
        let case: Value = serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap();
        let responses = case["responses"].as_array().cloned().unwrap_or_default();
        let requests = case["expected"]["requests"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(
            responses.len(),
            requests.len(),
            "{name}: one response per request"
        );
        for (response, request) in responses.iter().zip(&requests) {
            let status = response["status"].as_u64().unwrap();
            let body = &response["body"];
            if let Value::String(text) = body {
                // a string is sent as text: not JSON, so the CLI reads no error from it
                // (`.catch(() => ({}))`, bin/fleet.ts:92)
                text_bodies += 1;
                assert!(
                    serde_json::from_str::<Value>(text).is_err(),
                    "{name}: {text} reads as JSON"
                );
                assert!(serde_json::from_str::<ErrorBody>(text).is_err());
                continue;
            }
            json_bodies += 1;
            let method = request["method"].as_str().unwrap();
            let path = request["path"].as_str().unwrap().split('?').next().unwrap();
            let path = path.strip_prefix(FLEET_API).unwrap();
            if let Err(problem) = read_as(method, path, status, body) {
                failures.push(format!("{name}: {method} {path}: {problem}\n  read {body}"));
            }
        }
    }
    assert_eq!(cases, 87, "the fleet CLI corpus has 87 cases");
    assert_eq!(
        (json_bodies, text_bodies),
        (67, 1),
        "the bodies the corpus answers"
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// `bin/fleet.ts` reads a body without checking it: a missing field is `undefined`, not an error.
#[test]
fn a_missing_field_never_fails() {
    fn empty<T: DeserializeOwned + Serialize + Default + PartialEq + std::fmt::Debug>() {
        let read: T = serde_json::from_value(json!({})).unwrap();
        assert_eq!(read, T::default());
        assert_eq!(serde_json::to_value(read).unwrap(), json!({}));
    }
    empty::<Run>();
    empty::<fleet_cli::ThreadSummary>();
    empty::<fleet_cli::UsageEntry>();
    empty::<fleet_cli::PullRequest>();
    empty::<fleet_cli::ContractItem>();
    empty::<fleet_cli::UsageReading>();
    empty::<fleet_cli::UsageWindow>();
    empty::<fleet_cli::Cooldown>();
    empty::<Role>();
    empty::<fleet_cli::Plan>();
    empty::<fleet_cli::ErrorDetail>();
    empty::<RunBody>();
    empty::<RunsBody>();
    empty::<ThreadsBody>();
    empty::<UsageBody>();
    empty::<RolesBody>();
    empty::<PlanBody>();
    empty::<ErrorBody>();
    empty::<TextBody>();
    empty::<ReportBody>();
    empty::<ClearedBody>();
}

/// An unknown kind or state is kept as written and shown as is; `known_state` reads the ones the
/// CLI branches on.
#[test]
fn an_unknown_kind_or_state_is_kept() {
    let run: Run = serde_json::from_value(json!({ "agent": "omp", "state": "paused" })).unwrap();
    assert_eq!(run.agent.as_deref(), Some("omp"));
    assert_eq!(run.known_state(), None);
    let run: Run = serde_json::from_value(json!({ "state": "blocked" })).unwrap();
    assert_eq!(run.known_state(), Some(AgentState::Blocked));
    assert_eq!(Run::default().known_state(), None);

    let thread: fleet_cli::ThreadSummary =
        serde_json::from_value(json!({ "state": "review", "contract": [{ "id": "A1", "state": "unmet" }, { "id": "A2", "state": "maybe" }] }))
            .unwrap();
    assert_eq!(thread.known_state(), Some(ThreadState::Review));
    let contract = thread.contract.unwrap();
    assert_eq!(contract[0].known_state(), Some(ContractState::Unmet));
    assert_eq!(contract[1].known_state(), None);
    let thread: fleet_cli::ThreadSummary =
        serde_json::from_value(json!({ "state": "napping" })).unwrap();
    assert_eq!(thread.known_state(), None);
}

/// The bodies take the type of what they hold, so the CLI reads the same body as raw JSON for
/// `--json`, which prints what the server sent.
#[test]
fn a_body_reads_as_raw_json_too() {
    let body = json!({ "run": { "id": "r1", "herdrName": "x", "startedAt": 1 } });
    let raw: RunBody<Value> = serde_json::from_value(body.clone()).unwrap();
    assert_eq!(raw.run.unwrap(), body["run"]);
    let error = json!({ "error": { "code": "wait_timeout", "message": "still working" }, "run": { "id": "r1", "state": "working" } });
    let read: ErrorBody = serde_json::from_value(error).unwrap();
    assert_eq!(read.error.unwrap().code.as_deref(), Some("wait_timeout"));
    assert_eq!(read.run.unwrap().known_state(), Some(AgentState::Working));
}

/// What the server's types write, the CLI's types read under the same names: a run, a thread, a
/// usage entry and a plan with every field the CLI reads, written by hand from `shared/fleet.ts`.
#[test]
fn the_cli_reads_what_the_servers_types_write() {
    let run: AgentRun = serde_json::from_value(json!({
        "id": "r2", "name": "login", "role": "lead", "agent": "codex", "group": "g1",
        "herdrName": "g1-lead-r2", "paneId": "w1:p3", "cwd": "/repo", "model": "gpt-5", "state": "blocked",
        "depth": 1, "interactive": true, "worktree": true, "startedAt": 1, "updatedAt": 2,
        "lastOutput": "out", "lastError": "err", "result": "PASS", "replacedBy": "r3", "branch": "fleet/r1",
        "pr": { "number": 12, "url": "https://github.com/o/r/pull/12", "state": "OPEN", "checks": "fail", "failing": ["test"] },
    }))
    .unwrap();
    let thread = ThreadSummary {
        run: run.clone(),
        state: ThreadState::Waiting,
        status: Some("blocked — needs a key".into()),
        contract: Some(vec![herdr_fleet_protocol::ContractItem {
            id: "A1".into(),
            state: ContractState::Met,
        }]),
    };
    let read: fleet_cli::ThreadSummary =
        serde_json::from_value(serde_json::to_value(&thread).unwrap()).unwrap();
    let cli = read.run.clone().unwrap();
    assert_eq!(cli.id.as_deref(), Some("r2"));
    assert_eq!(cli.name.as_deref(), Some("login"));
    assert_eq!(cli.role.as_deref(), Some("lead"));
    assert_eq!(cli.agent.as_deref(), Some("codex"));
    assert_eq!(cli.group.as_deref(), Some("g1"));
    assert_eq!(cli.pane_id.as_deref(), Some("w1:p3"));
    assert_eq!(cli.known_state(), Some(AgentState::Blocked));
    assert_eq!(cli.model.as_deref(), Some("gpt-5"));
    assert_eq!(cli.last_output.as_deref(), Some("out"));
    assert_eq!(cli.last_error.as_deref(), Some("err"));
    assert_eq!(cli.result.as_deref(), Some("PASS"));
    assert_eq!(cli.replaced_by.as_deref(), Some("r3"));
    assert_eq!(cli.branch.as_deref(), Some("fleet/r1"));
    let pr = cli.pr.unwrap();
    assert_eq!(pr.number, Some(12.0));
    assert_eq!(pr.url.as_deref(), Some("https://github.com/o/r/pull/12"));
    assert_eq!(pr.state.as_deref(), Some("OPEN"));
    assert_eq!(pr.checks.as_deref(), Some("fail"));
    assert_eq!(read.known_state(), Some(ThreadState::Waiting));
    assert_eq!(read.status.as_deref(), Some("blocked — needs a key"));
    let contract = read.contract.unwrap();
    assert_eq!(contract[0].id.as_deref(), Some("A1"));
    assert_eq!(contract[0].known_state(), Some(ContractState::Met));

    let usage: UsageEntry = serde_json::from_value(json!({
        "key": "agy:gemini", "error": "timed out",
        "reading": { "windows": [{ "name": "5h", "usedPercent": 12.5, "resetsAt": 3 }], "readAt": 4 },
        "cooldown": { "until": 5, "reason": "rate limit", "since": 6 },
    }))
    .unwrap();
    let read: fleet_cli::UsageEntry =
        serde_json::from_value(serde_json::to_value(&usage).unwrap()).unwrap();
    assert_eq!(read.key.as_deref(), Some("agy:gemini"));
    assert_eq!(read.error.as_deref(), Some("timed out"));
    let reading = read.reading.unwrap();
    assert_eq!(reading.read_at, Some(4.0));
    let window = &reading.windows.unwrap()[0];
    assert_eq!(window.name.as_deref(), Some("5h"));
    assert_eq!(window.used_percent, Some(12.5));
    assert_eq!(window.resets_at, Some(3.0));
    let cooldown = read.cooldown.unwrap();
    assert_eq!(cooldown.until, Some(5.0));
    assert_eq!(cooldown.reason.as_deref(), Some("rate limit"));

    let plan: herdr_fleet_protocol::Plan = serde_json::from_value(json!({
        "version": 2, "writtenAt": 1, "title": "Login", "why": [], "scope": [],
        "claims": [{ "text": "one error", "children": [] }],
    }))
    .unwrap();
    let read: fleet_cli::Plan =
        serde_json::from_value(serde_json::to_value(&plan).unwrap()).unwrap();
    assert_eq!(read.version, Some(2.0));
    assert_eq!(read.title.as_deref(), Some("Login"));
    assert_eq!(read.claims.unwrap().len(), 1);

    // the error body the server writes on a timed-out wait carries the run (server/fleet/api.ts)
    let error = herdr_fleet_protocol::ErrorBody {
        error: herdr_fleet_protocol::ErrorDetail {
            code: "wait_timeout".into(),
            message: "still working".into(),
        },
        run: Some(run),
    };
    let read: ErrorBody = serde_json::from_value(serde_json::to_value(&error).unwrap()).unwrap();
    let detail = read.error.unwrap();
    assert_eq!(detail.code.as_deref(), Some("wait_timeout"));
    assert_eq!(detail.message.as_deref(), Some("still working"));
    assert_eq!(read.run.unwrap().id.as_deref(), Some("r2"));
}
