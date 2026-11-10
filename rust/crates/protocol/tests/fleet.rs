//! The rules of `shared/fleet.ts`: a thread's state, a turn's outcome in a line, a contract's
//! marks, the current lead, whether a model is listed, and the pane a message came from. The
//! first five tests are `shared/fleet.test.ts`'s, moved; the expected values are its own, or, for
//! the functions it does not test, worked out by hand from the TypeScript and checked by calling
//! `shared/fleet.ts` with bun.

use herdr_fleet_protocol::{
    AgentRun, ContractItem, ContractState, FROM_PANE, FleetAgentKind, FromPane, ModelListing,
    ThreadState, TurnOutcome, contract_items, current_lead, from_pane, model_listed, needs_person,
    outcome_line, thread_state,
};
use serde_json::{Value, json};

/// A run whose last turn reported `report` (`"none"`: its turn left no report; `None`: a run from
/// before reports), with `extra` laid over it: the TypeScript test's `run`, on a run that has the
/// fields Rust requires.
fn run(state: &str, report: Option<&str>, extra: Value) -> AgentRun {
    let mut value = json!({
        "id": "r1", "name": "lead", "role": "lead", "agent": "claude", "group": "g1",
        "herdrName": "g1-lead-r1", "paneId": "w1:p1", "cwd": "/repo", "state": state, "depth": 1,
        "interactive": true, "worktree": true, "startedAt": 1, "updatedAt": 1,
    });
    let human_action = extra.get("human_action").cloned();
    if let Some(report) = report {
        value["outcome"] = if report == "none" {
            json!({ "report": null, "problem": "report.json is missing." })
        } else {
            let mut report =
                json!({ "state": report, "summary": format!("{report} summary"), "evidence": [] });
            if let Some(question) = &human_action {
                report["human_action"] = question.clone();
            }
            json!({ "report": report })
        };
    }
    for (key, field) in extra.as_object().unwrap() {
        if key != "human_action" {
            value[key] = field.clone();
        }
    }
    serde_json::from_value(value).unwrap()
}

fn state(state: &str, report: Option<&str>) -> ThreadState {
    thread_state(&run(state, report, json!({})))
}

// shared/fleet.test.ts, "a thread's state" › "follows its lead, and once a turn settled, its
// report: a person is needed only when the report says so, or there is none"
#[test]
fn follows_its_lead_and_once_a_turn_settled_its_report() {
    assert_eq!(state("starting", None), ThreadState::Working);
    assert_eq!(state("working", Some("blocked")), ThreadState::Working);
    assert_eq!(state("blocked", None), ThreadState::Waiting);
    assert_eq!(state("idle", Some("blocked")), ThreadState::Waiting);
    assert_eq!(state("idle", Some("failed")), ThreadState::Waiting);
    assert_eq!(
        thread_state(&run(
            "idle",
            Some("progress"),
            json!({ "human_action": "Which one?" })
        )),
        ThreadState::Waiting
    );
    assert_eq!(state("idle", Some("none")), ThreadState::Waiting);
    assert_eq!(state("idle", Some("ready")), ThreadState::Review);
    for quiet in ["progress", "waiting", "dropped"] {
        assert_eq!(state("done", Some(quiet)), ThreadState::Idle, "{quiet}");
    }
    assert_eq!(state("idle", None), ThreadState::Idle);
    assert_eq!(state("failed", Some("ready")), ThreadState::Failed);
    assert_eq!(state("stopped", Some("ready")), ThreadState::Ended);
}

// shared/fleet.test.ts, "a thread's state" › "is resolved once the person marks it so, unless its
// lead works"
#[test]
fn is_resolved_once_the_person_marks_it_so_unless_its_lead_works() {
    let resolved = json!({ "resolvedAt": 1 });
    assert_eq!(
        thread_state(&run("idle", Some("ready"), resolved.clone())),
        ThreadState::Resolved
    );
    assert_eq!(
        thread_state(&run("stopped", None, resolved.clone())),
        ThreadState::Resolved
    );
    assert_eq!(
        thread_state(&run("working", None, resolved)),
        ThreadState::Working
    );
}

// shared/fleet.test.ts, "a thread's state" › "is landing while its pull request is open, and needs
// the person when its checks fail or a landing step went wrong"
#[test]
fn is_landing_while_its_pull_request_is_open() {
    let pr = json!({ "number": 7, "url": "https://github.com/o/r/pull/7", "state": "OPEN", "checks": "pending" });
    let with = |change: Value| {
        let mut pr = pr.clone();
        for (key, field) in change.as_object().unwrap() {
            pr[key] = field.clone();
        }
        pr
    };
    assert_eq!(
        thread_state(&run("idle", Some("ready"), json!({ "pr": pr }))),
        ThreadState::Landing
    );
    assert_eq!(
        thread_state(&run(
            "idle",
            Some("ready"),
            json!({ "pr": with(json!({ "checks": "fail", "failing": ["test"] })) })
        )),
        ThreadState::Waiting
    );
    assert_eq!(
        thread_state(&run(
            "idle",
            Some("ready"),
            json!({ "pr": with(json!({ "state": "CLOSED" })) })
        )),
        ThreadState::Review
    );
    assert_eq!(
        thread_state(&run(
            "idle",
            Some("ready"),
            json!({ "landing": { "action": "merge", "at": 1, "sent": true, "error": "not merged" } })
        )),
        ThreadState::Waiting
    );
    assert_eq!(
        thread_state(&run(
            "working",
            Some("ready"),
            json!({ "pr": with(json!({ "checks": "fail" })) })
        )),
        ThreadState::Working
    );
    assert_eq!(
        thread_state(&run(
            "stopped",
            Some("ready"),
            json!({ "pr": with(json!({ "state": "MERGED" })), "landed": "merged", "resolvedAt": 1 })
        )),
        ThreadState::Resolved
    );
}

// shared/fleet.test.ts, "a turn's outcome and a contract" › "says a turn's outcome in a line: the
// report's state and summary, or that there is none and why"
#[test]
fn says_a_turns_outcome_in_a_line() {
    let outcome = |value: Value| serde_json::from_value::<TurnOutcome>(value).unwrap();
    assert_eq!(
        outcome_line(&outcome(
            json!({ "report": { "state": "ready", "summary": "12 pass.", "evidence": [] } })
        )),
        "ready — 12 pass."
    );
    assert_eq!(
        outcome_line(&outcome(
            json!({ "report": null, "problem": "report.json is missing." })
        )),
        "no report — report.json is missing."
    );
}

// shared/fleet.test.ts, "a turn's outcome and a contract" › "reads each assertion's mark"
#[test]
fn reads_each_assertions_mark() {
    let item = |id: &str, state| ContractItem {
        id: id.into(),
        state,
    };
    assert_eq!(
        contract_items("- [x] A1 a\n- [ ] A2 b\n* [!] A3 c\n- [X] A4 d\nA5 loose"),
        vec![
            item("A1", ContractState::Met),
            item("A2", ContractState::Open),
            item("A3", ContractState::Unmet),
            item("A4", ContractState::Met),
        ]
    );
}

/// Where JavaScript's regular expression differs from Rust's: `^` with the `m` flag also starts a
/// line after `\r`, U+2028 and U+2029; `\s` spans line ends and has U+FEFF; `\d` and `\b` are ASCII.
#[test]
fn reads_contract_marks_as_javascripts_regular_expression_does() {
    let ids = |text: &str| {
        contract_items(text)
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        ids("- [x] A1 a\r- [ ] A2 b\u{2028}- [ ] A3\u{2029}- [!] A4"),
        ["A1", "A2", "A3", "A4"]
    );
    // `^\s*` crosses blank lines and takes U+FEFF and U+3000 as white space
    assert_eq!(ids("\n\n\u{FEFF}\u{3000}- [x] A1"), ["A1"]);
    // `\d` is 0-9 alone, so an Arabic-Indic digit is no number; `\b` after the number is ASCII,
    // so é (no ASCII word character) ends it and b or _ does not
    assert_eq!(ids("- [x] A\u{0661}"), Vec::<String>::new());
    assert_eq!(ids("- [x] A1é"), ["A1"]);
    assert_eq!(ids("- [x] A1b"), Vec::<String>::new());
    assert_eq!(ids("- [x] A12_"), Vec::<String>::new());
    // a mark not at a line's start is not read
    assert_eq!(ids("text - [x] A1"), Vec::<String>::new());
}

#[test]
fn a_report_needs_the_person_when_it_asks_or_is_blocked_or_failed() {
    let report = |value: Value| serde_json::from_value(value).unwrap();
    for (value, needed) in [
        (
            json!({ "state": "ready", "summary": "s", "evidence": [] }),
            false,
        ),
        (
            json!({ "state": "ready", "summary": "s", "evidence": [], "human_action": "" }),
            true,
        ),
        (
            json!({ "state": "blocked", "summary": "s", "evidence": [] }),
            true,
        ),
        (
            json!({ "state": "failed", "summary": "s", "evidence": [] }),
            true,
        ),
        (
            json!({ "state": "waiting", "summary": "s", "evidence": [] }),
            false,
        ),
    ] {
        assert_eq!(needs_person(&report(value.clone())), needed, "{value}");
    }
}

#[test]
fn the_current_lead_follows_replaced_by_through_leads_alone() {
    let lead = |id: &str, replaced_by: Option<&str>, role: &str| {
        let mut extra = json!({ "id": id, "role": role });
        if let Some(next) = replaced_by {
            extra["replacedBy"] = json!(next);
        }
        run("idle", None, extra)
    };
    let runs = vec![
        lead("a", Some("b"), "lead"),
        lead("b", Some("c"), "lead"),
        lead("c", None, "lead"),
        lead("w", Some("x"), "worker"),
        lead("x", None, "worker"),
        lead("gone", Some("missing"), "lead"),
    ];
    assert_eq!(
        current_lead(&runs, "a").map(|run| run.id.as_str()),
        Some("c")
    );
    // a helper's replacement is not a thread's lead
    assert_eq!(
        current_lead(&runs, "w").map(|run| run.id.as_str()),
        Some("w")
    );
    // a replacement that is not among the runs stops the walk
    assert_eq!(
        current_lead(&runs, "gone").map(|run| run.id.as_str()),
        Some("gone")
    );
    assert_eq!(current_lead(&runs, "nobody"), None);
    // a loop stops after 32 hops: from p, 32 hops over p ↔ q end on p again
    let loop_runs = vec![lead("p", Some("q"), "lead"), lead("q", Some("p"), "lead")];
    assert_eq!(
        current_lead(&loop_runs, "p").map(|run| run.id.as_str()),
        Some("p")
    );
}

fn listing(agent: &str, ids: &[&str]) -> ModelListing {
    serde_json::from_value(json!({
        "agent": agent,
        "models": ids.iter().map(|id| json!({ "id": id })).collect::<Vec<_>>(),
        "complete": true,
    }))
    .unwrap()
}

#[test]
fn a_model_is_listed_without_its_level_parameters_or_variant() {
    let claude = listing("claude", &["sonnet"]);
    assert!(model_listed(&claude, "sonnet"));
    assert!(model_listed(&claude, "sonnet:high"));
    assert!(!model_listed(&claude, "sonnet:turbo"));
    assert!(!model_listed(&claude, "opus"));

    let cursor = listing("cursor", &["gpt-5[effort=high]", "auto"]);
    assert!(model_listed(&cursor, "gpt-5"));
    assert!(model_listed(&cursor, "gpt-5[effort=low]"));
    assert!(model_listed(&cursor, "auto[x]:max"));

    let opencode = listing("opencode", &["anthropic/claude"]);
    assert!(model_listed(&opencode, "anthropic/claude#fast"));
    assert!(model_listed(&opencode, "anthropic/claude#fast:low"));
    // `#variant` is opencode's alone
    assert!(!model_listed(&listing("claude", &["a"]), "a#b"));

    let agy = listing("agy", &["gemini-3.1-pro-high", "gemini-3.1-pro-low"]);
    assert!(model_listed(&agy, "gemini-3.1-pro"));
    assert!(model_listed(&agy, "gemini-3.1-pro-high"));
    // the effort suffix is agy's alone
    assert!(!model_listed(&listing("codex", &["gpt-5-high"]), "gpt-5"));
    // `.` in `\[.*\]$` stops at a line end, as JavaScript's does
    assert!(!model_listed(&cursor, "gpt-5[a\nb]"));
}

#[test]
fn reads_the_pane_a_message_came_from() {
    assert_eq!(FROM_PANE, "[from pane ");
    assert_eq!(
        from_pane("[from pane w1:p2]\n\nfix the login"),
        Some(FromPane {
            pane_id: "w1:p2".into(),
            text: "fix the login".into()
        })
    );
    assert_eq!(
        from_pane("[from pane a.b-c_9]\n\n"),
        Some(FromPane {
            pane_id: "a.b-c_9".into(),
            text: String::new()
        })
    );
    // the pane id is 1 to 64 of `\w:.-`, ASCII as JavaScript's `\w`
    let longest = "p".repeat(64);
    assert!(from_pane(&format!("[from pane {longest}]\n\nx")).is_some());
    assert_eq!(from_pane(&format!("[from pane {longest}p]\n\nx")), None);
    assert_eq!(from_pane("[from pane é]\n\nx"), None);
    assert_eq!(from_pane("[from pane ]\n\nx"), None);
    // the opening line and a blank line, at the start alone
    assert_eq!(from_pane("[from pane w1:p2]\nx"), None);
    assert_eq!(from_pane(" [from pane w1:p2]\n\nx"), None);
    assert_eq!(from_pane("typed on the Fleet screen"), None);
}

/// `AGENT_KINDS` of `server/fleet/adapters.ts:480`, in its order, and each kind's name as herdr
/// and the settings spell it.
#[test]
fn every_agent_kind_in_the_order_of_agent_kinds_and_its_name() {
    let names = FleetAgentKind::ALL.map(FleetAgentKind::name);
    assert_eq!(
        names,
        ["pi", "claude", "codex", "cursor", "agy", "opencode"]
    );
    // the name is the one the records carry
    for kind in FleetAgentKind::ALL {
        assert_eq!(serde_json::to_value(kind).unwrap(), json!(kind.name()));
    }
}
