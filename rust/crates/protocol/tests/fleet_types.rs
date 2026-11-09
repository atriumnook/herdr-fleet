//! The shapes of the fleet's protocol types that no corpus holds whole: every field of a run, a
//! thread, a plan, the settings and their patch reads and writes back to the same JSON, an absent
//! field stays absent and a `null` stays `null`. The JSON is written by hand from
//! `shared/fleet.ts` and `shared/plan.ts`. `PLAN_LIMITS` and the routes are compared with the
//! TypeScript sources themselves.

#![recursion_limit = "256"]

use std::fs;
use std::path::{Path, PathBuf};

use herdr_fleet_protocol::{
    AgentRun, ErrorBody, FLEET_API, FLEET_HEADER, FLEET_HEADER_VALUE, FleetEntrances,
    FleetSettings, FleetSettingsPatch, LandAction, LandingChecks, LineComment, ModelListing,
    PLAN_LIMITS, Plan, PlanInput, REPORT_STATES, ThreadSummary, TurnOutcome, UsageEntry,
    fleet_routes,
};
use regex::Regex;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// The same JSON value, numbers compared by value: `80` and `80.0` are one JavaScript number (ADR
/// 0192-phase-2-split, "corpus の runner").
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

/// Reads `value` as a `T`, writes it back, and expects the same JSON.
fn round_trip<T: DeserializeOwned + Serialize>(value: Value) {
    let typed: T =
        serde_json::from_value(value.clone()).unwrap_or_else(|error| panic!("{error}: {value}"));
    let written = serde_json::to_value(typed).unwrap();
    assert!(same(&written, &value), "wrote {written}\nread {value}");
}

fn full_run() -> Value {
    json!({
        "id": "r2", "name": "login", "role": "lead", "agent": "codex", "group": "fleet-1",
        "herdrName": "fleet-1-lead-r2", "paneId": "w1:p3", "workspaceId": "w1", "cwd": "/repo/.wt/r1",
        "model": "gpt-5", "thinking": "xhigh", "state": "idle", "depth": 1, "interactive": true,
        "worktree": true, "startedAt": 1_762_000_000_000_i64, "updatedAt": 1_762_000_060_000_i64,
        "lastOutput": "done", "lastError": "rate limit", "result": "PASS",
        "outcome": { "report": { "state": "blocked", "summary": "needs a key", "evidence": ["cargo test"], "human_action": "Which key?" } },
        "fallbackFrom": "o3", "replacedBy": "r3", "thread": "r1", "avoid": ["agy", "opencode"],
        "skipped": [{ "candidate": "claude:opus", "reason": "cooling down" }],
        "branch": "fleet/r1", "project": "/repo", "owner": "c1", "write": ["/repo/src"],
        "notice": "Which key?", "base": "abc123",
        "contract": [{ "id": "A1", "state": "met" }, { "id": "A2", "state": "unmet" }],
        "diff": { "added": 10, "removed": 2, "files": 3 }, "resolvedAt": 1_762_000_120_000_i64,
        "baseBranch": "main",
        "pr": { "number": 12, "url": "https://github.com/o/r/pull/12", "state": "MERGED", "checks": "pass", "failing": [] },
        "landing": { "action": "merge-pr", "at": 5, "sent": true, "error": "not merged" },
        "landed": "merged",
        "plan": { "version": 2, "asks": 1, "answeredAt": 7, "closedAt": 8 },
    })
}

#[test]
fn a_run_keeps_every_field_and_leaves_out_the_absent_ones() {
    round_trip::<AgentRun>(full_run());
    let mut least = full_run();
    let fields = least.as_object_mut().unwrap();
    fields.retain(|key, _| {
        [
            "id",
            "name",
            "role",
            "agent",
            "group",
            "herdrName",
            "paneId",
            "cwd",
            "state",
            "depth",
            "interactive",
            "worktree",
            "startedAt",
            "updatedAt",
        ]
        .contains(&key.as_str())
    });
    round_trip::<AgentRun>(least.clone());
    // the fields TypeScript requires are required
    for field in ["herdrName", "cwd", "depth", "startedAt"] {
        let mut missing = least.clone();
        missing.as_object_mut().unwrap().remove(field);
        let error = serde_json::from_value::<AgentRun>(missing).unwrap_err();
        assert!(
            error
                .to_string()
                .contains(&format!("missing field `{field}`")),
            "{field}: {error}"
        );
    }
}

#[test]
fn an_outcome_is_a_report_or_a_null_report_with_its_problem() {
    round_trip::<TurnOutcome>(
        json!({ "report": { "state": "ready", "summary": "s", "evidence": [] } }),
    );
    round_trip::<TurnOutcome>(json!({ "report": null, "problem": "report.json is missing." }));
    for wrong in [
        json!({}),
        json!({ "report": null }),
        json!({ "problem": "x" }),
        json!({ "report": { "state": "ready", "summary": "s", "evidence": [] }, "problem": "x" }),
        json!({ "report": { "state": "maybe", "summary": "s", "evidence": [] } }),
    ] {
        assert!(
            serde_json::from_value::<TurnOutcome>(wrong.clone()).is_err(),
            "{wrong}"
        );
    }
}

#[test]
fn a_thread_summary_the_checks_usage_comments_entrances_and_listings_keep_their_shapes() {
    round_trip::<ThreadSummary>(
        json!({ "run": full_run(), "state": "waiting", "status": "blocked — needs a key", "contract": [{ "id": "A1", "state": "open" }] }),
    );
    round_trip::<ThreadSummary>(json!({ "run": full_run(), "state": "resolved" }));
    round_trip::<LandingChecks>(
        json!({ "baseBranch": "main", "uncommitted": ["a.rs"], "ahead": 2, "behind": 0, "pr": { "number": 1, "url": "u", "state": "OPEN", "checks": "none" }, "prError": "gh missing" }),
    );
    round_trip::<LandingChecks>(
        json!({ "baseBranch": "main", "uncommitted": [], "ahead": 0, "behind": 3 }),
    );
    round_trip::<UsageEntry>(json!({
        "key": "agy:gemini",
        "reading": { "windows": [{ "name": "5h", "usedPercent": 12.5, "resetsAt": 1_762_000_000_000.5 }], "readAt": 1_762_000_000_000_i64 },
        "cooldown": { "until": 1_762_003_600_000_i64, "reason": "rate limit", "since": 1_762_000_000_000_i64 },
        "error": "timed out",
    }));
    round_trip::<UsageEntry>(json!({ "key": "claude" }));
    round_trip::<LineComment>(
        json!({ "file": "a.rs", "line": 3, "removed": true, "text": "why?" }),
    );
    round_trip::<LineComment>(json!({ "file": "a.rs", "line": 3, "text": "why?" }));
    round_trip::<FleetEntrances>(json!({
        "entrances": [{ "id": "agents", "file": "/home/u/.agents/skills/fleet/SKILL.md", "readers": ["codex", "cursor"], "state": "outdated" }],
        "tokenRequired": false,
    }));
    round_trip::<ModelListing>(
        json!({ "agent": "cursor", "models": [{ "id": "auto", "label": "Auto" }, { "id": "gpt-5" }], "complete": true }),
    );
    round_trip::<ModelListing>(
        json!({ "agent": "codex", "models": [], "complete": false, "error": "codex is not installed" }),
    );
}

#[test]
fn the_settings_and_a_patch_keep_a_null_apart_from_an_absent_field() {
    round_trip::<FleetSettings>(json!({
        "file": "/home/u/.config/herdr-fleet/fleet.json",
        "roles": [{
            "name": "worker", "description": "builds", "readOnly": false,
            "candidates": [{ "agent": "claude", "model": "opus", "skip": "cooling down" }, { "agent": "codex" }],
            "thinking": "high", "changed": true,
            "defaults": { "candidates": [{ "agent": "pi", "model": "x" }], "thinking": "low" },
            "project": { "candidates": [{ "agent": "agy" }] },
        }, {
            "name": "scout", "description": "reads", "readOnly": true, "candidates": [], "changed": false,
            "defaults": { "candidates": [] },
        }],
        "maxUsedPercent": 92.5, "rateLimitCooldownMinutes": 60, "maxConcurrent": 6, "closeOnSettle": true,
        "language": "Japanese", "projects": [{ "path": "/repo", "setup": "bun install" }],
        "readOnlyAgents": ["claude", "cursor", "opencode"],
    }));
    // a role set to null goes back to its file's candidates; a thinking level set to null unsets it
    let patch = json!({
        "roles": {
            "lead": { "candidates": [{ "agent": "claude", "model": "opus" }], "thinking": null },
            "scout": null,
            "worker": { "candidates": [{ "agent": "codex" }], "thinking": "max" },
            "reviewer": { "candidates": [] },
        },
        "maxUsedPercent": 80, "rateLimitCooldownMinutes": 2.5, "maxConcurrent": 4, "closeOnSettle": false,
        "language": "", "projects": { "/repo": { "setup": "" } },
    });
    round_trip::<FleetSettingsPatch>(patch.clone());
    let read: FleetSettingsPatch = serde_json::from_value(patch).unwrap();
    let roles = read.roles.unwrap();
    assert_eq!(roles["lead"].as_ref().unwrap().thinking, Some(None));
    assert_eq!(roles["reviewer"].as_ref().unwrap().thinking, None);
    assert!(roles["scout"].is_none());
    round_trip::<FleetSettingsPatch>(json!({}));
}

fn plan() -> Value {
    json!({
        "version": 3, "writtenAt": 1_762_000_000_000_i64, "title": "Login",
        "why": ["make login work"],
        "claims": [{
            "text": "a person signs in",
            "exhibit": { "kind": "code", "path": "src/login.rs", "start": 3, "end": 9, "lang": "rust", "lines": ["fn a() {}"] },
            "ask": { "id": "store", "question": "Where?", "options": [{ "value": "db", "label": "Database", "note": "slower" }, { "value": "file", "label": "File" }], "recommended": "db" },
            "children": [{
                "text": "the form posts", "exhibit": { "kind": "calls", "rows": [{ "depth": 0, "text": "post", "at": "src/a.rs:3" }, { "depth": 1, "text": "check" }] },
                "children": [{ "text": "in a.rs", "exhibit": { "kind": "list", "items": ["one"] }, "children": [] }],
            }],
        }, {
            "text": "proposed", "exhibit": { "kind": "code", "path": "src/new.rs", "text": "fn b() {}" }, "children": [],
        }],
        "shared": { "text": "one table", "exhibit": { "kind": "schema", "lang": "sql", "text": "create table t ()" } },
        "scope": ["leaves the API alone"],
        "answeredAt": 1_762_000_100_000_i64,
        "answer": { "version": 3, "choices": { "store": "db" }, "seen": ["store"], "comments": [{ "claim": "1.2", "text": "ok" }], "note": "go" },
        "closedAt": 1_762_000_200_000_i64,
    })
}

#[test]
fn a_plan_keeps_its_claims_exhibits_asks_and_answers() {
    round_trip::<Plan>(plan());
    let mut input = plan();
    for field in ["version", "writtenAt", "answeredAt", "answer", "closedAt"] {
        input.as_object_mut().unwrap().remove(field);
    }
    input["shared"] = json!({ "text": "one table" });
    round_trip::<PlanInput>(input);
    let wrong = json!({ "kind": "picture", "path": "a.png" });
    let mut claim_with = plan();
    claim_with["claims"][1]["exhibit"] = wrong;
    assert!(serde_json::from_value::<Plan>(claim_with).is_err());
}

/// The number after `<name>:` in TypeScript's `PLAN_LIMITS`, read from `shared/plan.ts`.
#[test]
fn plan_limits_are_typescripts() {
    let source = fs::read_to_string(repository().join("shared/plan.ts")).unwrap();
    let block = Regex::new(r"(?s)export const PLAN_LIMITS = \{(.*?)\} as const;")
        .unwrap()
        .captures(&source)
        .expect("PLAN_LIMITS in shared/plan.ts")[1]
        .to_owned();
    let entries: Vec<(String, usize)> = Regex::new(r"(\w+): (\d+)")
        .unwrap()
        .captures_iter(&block)
        .map(|found| (found[1].to_owned(), found[2].parse().unwrap()))
        .collect();
    let l = PLAN_LIMITS;
    let rust = [
        ("title", l.title),
        ("why", l.why),
        ("quote", l.quote),
        ("claims", l.claims),
        ("depth", l.depth),
        ("text", l.text),
        ("asks", l.asks),
        ("options", l.options),
        ("codeLines", l.code_lines),
        ("codeLine", l.code_line),
        ("schema", l.schema),
        ("rows", l.rows),
        ("items", l.items),
        ("scope", l.scope),
        ("comments", l.comments),
        ("comment", l.comment),
        ("note", l.note),
    ]
    .map(|(name, value)| (name.to_owned(), value));
    assert_eq!(entries, rust);
}

#[test]
fn the_report_states_and_landing_steps_are_in_typescripts_order() {
    // shared/fleet.ts's REPORT_STATES and server/fleet/api.ts's LAND_ACTIONS
    assert_eq!(
        serde_json::to_value(REPORT_STATES).unwrap(),
        json!([
            "progress", "waiting", "ready", "blocked", "failed", "dropped"
        ])
    );
    let api = fs::read_to_string(repository().join("server/fleet/api.ts")).unwrap();
    let typescript = Regex::new(r"const LAND_ACTIONS[^=]*= \[([^\]]*)\]")
        .unwrap()
        .captures(&api)
        .expect("LAND_ACTIONS in server/fleet/api.ts")[1]
        .split(',')
        .map(|each| each.trim().trim_matches('"').to_owned())
        .filter(|each| !each.is_empty())
        .collect::<Vec<_>>();
    assert_eq!(
        serde_json::to_value(LandAction::ALL).unwrap(),
        json!(typescript)
    );
}

#[test]
fn the_error_body_and_the_header() {
    round_trip::<ErrorBody>(
        json!({ "error": { "code": "run_not_found", "message": "no agent named w1." } }),
    );
    // bin/fleet.ts sends `x-herdr-fleet: 1`; fixtures/fleet-cli/*.json record it so
    assert_eq!((FLEET_HEADER, FLEET_HEADER_VALUE), ("x-herdr-fleet", "1"));
    assert_eq!(FLEET_API, "/api/fleet");
}

/// A path of `/api/fleet` matches a route when each segment is the route's, or any segment for
/// `{target}`.
fn matches(route: &str, path: &str) -> bool {
    let route: Vec<&str> = route.split('/').collect();
    let path: Vec<&str> = path.split('/').collect();
    route.len() == path.len()
        && route
            .iter()
            .zip(&path)
            .all(|(route, path)| *route == "{target}" && !path.is_empty() || route == path)
}

/// Every request of the fleet CLI corpus goes to one of the routes, and every route is one that
/// `server/fleet/api.ts` answers: its `parts[0] === "<name>"` and `parts[2] === "<action>"` tests
/// name the same segments.
#[test]
fn the_routes_are_the_ones_the_cli_calls_and_the_server_answers() {
    let routes = fleet_routes::ALL;
    let mut unique = routes.to_vec();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), routes.len(), "a route is listed twice");

    let corpus = repository().join("fixtures/fleet-cli");
    let mut checked = 0;
    for entry in fs::read_dir(&corpus).unwrap() {
        let file = entry.unwrap().path();
        let case: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        for request in case["expected"]["requests"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let path = request["path"].as_str().unwrap();
            let path = path.split('?').next().unwrap();
            let relative = path
                .strip_prefix(FLEET_API)
                .unwrap_or_else(|| panic!("{}: {path}", file.display()));
            assert!(
                routes.iter().any(|route| matches(route, relative)),
                "{}: no route for {relative}",
                file.display()
            );
            checked += 1;
        }
    }
    assert!(checked > 50, "{checked} requests");

    let api = fs::read_to_string(repository().join("server/fleet/api.ts")).unwrap();
    let named = |pattern: &str| -> Vec<String> {
        Regex::new(pattern)
            .unwrap()
            .captures_iter(&api)
            .map(|found| found[1].to_owned())
            .collect()
    };
    let firsts = named(r#"parts\[0\] === "([a-z-]+)""#);
    let seconds = named(r#"parts\[1\] === "([a-z-]+)""#);
    let thirds = named(r#"parts\[2\] === "([a-z-]+)""#);
    let cases = named(r#"case "([a-z-]+)":"#);
    let fourths = named(r#"parts\[3\] === "([a-z-]+)""#);
    for route in routes {
        let segments: Vec<&str> = route.trim_start_matches('/').split('/').collect();
        assert!(firsts.iter().any(|name| name == segments[0]), "{route}");
        match segments.as_slice() {
            [_] => {}
            ["usage", action] => assert!(seconds.iter().any(|name| name == action), "{route}"),
            ["runs", "{target}"] => {}
            ["runs", "{target}", action] => assert!(
                thirds.iter().chain(&cases).any(|name| name == action),
                "{route}"
            ),
            ["runs", "{target}", "plan", action] => {
                assert!(fourths.iter().any(|name| name == action), "{route}")
            }
            _ => panic!("{route} is not a shape server/fleet/api.ts answers"),
        }
    }
}
