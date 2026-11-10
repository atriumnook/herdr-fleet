//! The factory metrics and `fleet report` (`server/fleet/metrics.ts`). The first ten tests are the
//! `it`s of `server/fleet/metrics.test.ts`, with its events and expected values; the ones after
//! them pin where the Rust version differs, as issue #259 says (the defects #176's item 8 and
//! #189's items 1, 5 and 7), with expected values worked out by hand from those issues.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use herdr_fleet_orchestrator::events::{TimedEvent, rotated_path};
use herdr_fleet_orchestrator::github::{IssueSummary, Listing, MergedPullRequest};
use herdr_fleet_orchestrator::metrics::{
    AgentStarts, FactoryMetrics, Interventions, MetricsInput, Restarts, RoleStarts, Standstill,
    TurnReports, metrics, read_events, render,
};
use jiff::tz::{TimeZone, offset};
use protocol::{AgentState, FleetAgentKind};
use regex::Regex;
use serde_json::{Value, json};

const MIN: i64 = 60_000;
const P: &str = "/repo";

/// Minutes from 0 as the event log's milliseconds.
fn at(minutes: f64) -> i64 {
    (minutes * MIN as f64).round() as i64
}

fn event(value: Value) -> TimedEvent {
    serde_json::from_value(value.clone()).unwrap_or_else(|error| panic!("{value}: {error}"))
}

/// metrics.test.ts's `state`: the reviewer `r` has no project of its own (known by its group), the
/// coordinator `c` is in the project's group, every other run in the lead's; leads and the
/// coordinator talk in their panes. `extra` overrides, as the spread does.
#[allow(clippy::too_many_arguments)]
fn state(
    t: f64,
    run: &str,
    role: &str,
    agent: &str,
    from: Option<&str>,
    to: &str,
    sent: bool,
    extra: Value,
) -> TimedEvent {
    let mut value = json!({
        "t": at(t), "kind": "state", "run": run, "role": role, "agent": agent,
        "group": if run == "c" { "g-project" } else { "g-lead" },
        "interactive": role == "lead" || role == "coordinator",
        "to": to, "sent": sent,
    });
    if run != "r" {
        value["project"] = json!(P);
    }
    if let Some(from) = from {
        value["from"] = json!(from);
    }
    for (key, field) in extra.as_object().into_iter().flatten() {
        value[key] = field.clone();
    }
    event(value)
}

/// metrics.test.ts's `turnEnd`: a turn's end as the fleet read it, whether the run's result file
/// held a HANDOFF.
fn turn_end(t: f64, run: &str, role: &str, agent: &str, interactive: bool, handoff: bool) -> Value {
    let mut value = json!({
        "t": at(t), "kind": "turn", "run": run, "role": role, "agent": agent, "group": "g-lead",
        "interactive": interactive, "handoff": handoff,
    });
    if run != "r" {
        value["project"] = json!(P);
    }
    value
}

/// metrics.test.ts's `role`: the role file a run started with, as the fleet recorded it.
fn role(t: f64, run: &str, name: &str, source: &str, hash: &str) -> TimedEvent {
    event(json!({
        "t": at(t), "kind": "role", "run": run, "role": name, "source": source,
        "file": format!("/{source}/{name}.md"), "hash": hash, "standing": "eeeeeeeeeeee",
    }))
}

/// metrics.test.ts's `events`: minutes from 0, the coordinator c, a thread's lead l, and its
/// reviewer r (no project of its own: known by its group).
fn events() -> Vec<TimedEvent> {
    let none = || json!({});
    vec![
        state(
            0.0,
            "c",
            "coordinator",
            "claude",
            None,
            "starting",
            false,
            none(),
        ),
        state(
            1.0,
            "c",
            "coordinator",
            "claude",
            Some("starting"),
            "working",
            true,
            none(),
        ),
        state(2.0, "l", "lead", "claude", None, "starting", false, none()),
        state(
            3.0,
            "l",
            "lead",
            "claude",
            Some("starting"),
            "working",
            true,
            none(),
        ),
        state(
            4.0,
            "c",
            "coordinator",
            "claude",
            Some("working"),
            "idle",
            true,
            none(),
        ),
        state(5.0, "r", "reviewer", "agy", None, "starting", false, none()),
        // an agy reviewer whose turn ended on a question the adapter did not know: no HANDOFF, its pane kept
        state(
            5.2,
            "r4",
            "reviewer",
            "agy",
            None,
            "starting",
            false,
            none(),
        ),
        state(
            5.4,
            "r4",
            "reviewer",
            "agy",
            Some("starting"),
            "working",
            true,
            none(),
        ),
        state(
            5.8,
            "r4",
            "reviewer",
            "agy",
            Some("working"),
            "done",
            true,
            none(),
        ),
        event(turn_end(5.8, "r4", "reviewer", "agy", false, false)),
        state(
            6.0,
            "r",
            "reviewer",
            "agy",
            Some("starting"),
            "idle",
            false,
            json!({ "error": "Agent started but is not ready for prompts; the task has not been sent." }),
        ),
        state(
            7.0,
            "r3",
            "reviewer",
            "agy",
            None,
            "starting",
            false,
            none(),
        ),
        state(
            8.0,
            "r3",
            "reviewer",
            "agy",
            Some("starting"),
            "failed",
            false,
            json!({ "error": "Unknown model x" }),
        ),
        // a claude reviewer whose pane closed before it wrote anything
        state(
            9.0,
            "r2",
            "reviewer",
            "claude",
            None,
            "starting",
            false,
            json!({ "group": "g-lead" }),
        ),
        state(
            9.5,
            "r2",
            "reviewer",
            "claude",
            Some("starting"),
            "working",
            true,
            json!({ "group": "g-lead" }),
        ),
        state(
            9.9,
            "r2",
            "reviewer",
            "claude",
            Some("working"),
            "stopped",
            false,
            json!({ "group": "g-lead" }),
        ),
        state(
            10.0,
            "l",
            "lead",
            "claude",
            Some("working"),
            "idle",
            true,
            none(),
        ),
        event(turn_end(10.0, "l", "lead", "claude", true, true)),
        // 10 to 40: nothing moves (30 minutes); then the lead resumes by itself
        state(
            40.0,
            "l",
            "lead",
            "claude",
            Some("idle"),
            "working",
            false,
            none(),
        ),
        state(
            45.0,
            "l",
            "lead",
            "claude",
            Some("working"),
            "done",
            false,
            none(),
        ),
        // the lead ends a turn to wait, with no HANDOFF yet: it talks in its pane, and has not ended
        event(turn_end(45.0, "l", "lead", "claude", true, false)),
        // 45 to 50: still, but shorter than the quiet period; the person writes, and types once more into the pane
        event(json!({ "t": at(50.0), "kind": "person", "run": "c", "project": P })),
        state(
            50.0,
            "c",
            "coordinator",
            "claude",
            Some("idle"),
            "working",
            true,
            none(),
        ),
        state(
            52.0,
            "c",
            "coordinator",
            "claude",
            Some("working"),
            "idle",
            true,
            none(),
        ),
        state(
            53.0,
            "c",
            "coordinator",
            "claude",
            Some("idle"),
            "working",
            false,
            none(),
        ),
        state(
            54.0,
            "c",
            "coordinator",
            "claude",
            Some("working"),
            "idle",
            false,
            none(),
        ),
        event(
            json!({ "t": at(70.0), "kind": "standstill", "run": "c", "project": P, "quietMs": 15 * MIN }),
        ),
        event(json!({ "t": at(71.0), "kind": "reconciled", "run": "l", "project": P, "pr": 9 })),
        // the fleet closes the landed thread: its lead's last turn left no HANDOFF, and it is not lost
        state(
            71.0,
            "l",
            "lead",
            "claude",
            Some("done"),
            "stopped",
            false,
            none(),
        ),
        // another project's run: never counted here
        state(
            20.0,
            "x",
            "lead",
            "codex",
            None,
            "starting",
            false,
            json!({ "project": "/other", "group": "g-other" }),
        ),
        role(20.0, "x", "lead", "bundled", "bbbbbbbbbbbb"),
        // the role version each run started with; r started before the fleet recorded it
        role(0.0, "c", "coordinator", "bundled", "aaaaaaaaaaaa"),
        role(2.0, "l", "lead", "bundled", "bbbbbbbbbbbb"),
        role(5.2, "r4", "reviewer", "bundled", "cccccccccccc"),
        role(7.0, "r3", "reviewer", "bundled", "cccccccccccc"),
        // a user's reviewer.md in place of the bundled one
        role(9.0, "r2", "reviewer", "user", "dddddddddddd"),
    ]
}

fn label(name: &str) -> herdr_fleet_orchestrator::github::Label {
    herdr_fleet_orchestrator::github::Label {
        name: name.to_owned(),
    }
}

/// metrics.test.ts's `issues`, its dates as `new Date(…).toISOString()` writes them.
fn issues() -> Listing<IssueSummary> {
    let issue = |number: u64, title: &str, created: &str, closed: Option<&str>, labels: &[&str]| {
        IssueSummary {
            number,
            title: title.to_owned(),
            created_at: created.to_owned(),
            closed_at: closed.map(str::to_owned),
            labels: labels.iter().map(|name| label(name)).collect(),
        }
    };
    Listing {
        items: vec![
            // 1 and 60 minutes after the epoch
            issue(
                1,
                "phase work",
                "1970-01-01T00:01:00.000Z",
                Some("1970-01-01T01:00:00.000Z"),
                &["rust-migration", "phase:1"],
            ),
            // 30 minutes after
            issue(
                2,
                "found a bug",
                "1970-01-01T00:30:00.000Z",
                None,
                &["rust-migration"],
            ),
            // 500 minutes before
            issue(
                3,
                "before the window",
                "1969-12-31T15:40:00.000Z",
                None,
                &[],
            ),
        ],
        limit_reached: false,
    }
}

/// metrics.test.ts's `merged`.
fn merged() -> Listing<MergedPullRequest> {
    let pr = |number: u64, title: &str, merged_at: &str, base: &str| MergedPullRequest {
        number,
        title: title.to_owned(),
        merged_at: merged_at.to_owned(),
        base_ref_name: base.to_owned(),
    };
    Listing {
        items: vec![
            // 44 minutes after the epoch, 100 before, 44 after
            pr(9, "the thread", "1970-01-01T00:44:00.000Z", "rust"),
            pr(8, "old", "1969-12-31T22:20:00.000Z", "rust"),
            pr(7, "into another branch", "1970-01-01T00:44:00.000Z", "main"),
        ],
        limit_reached: false,
    }
}

fn planned() -> Regex {
    Regex::new("^(phase:|tracking$)").unwrap()
}

/// A zone an hour ahead of UTC.
fn utc_plus_one() -> TimeZone {
    TimeZone::fixed(offset(1))
}

struct Inputs {
    events: Vec<TimedEvent>,
    merged: Listing<MergedPullRequest>,
    issues: Listing<IssueSummary>,
    current: HashMap<String, AgentState>,
}

impl Inputs {
    fn new(events: Vec<TimedEvent>) -> Inputs {
        Inputs {
            events,
            merged: merged(),
            issues: issues(),
            current: HashMap::new(),
        }
    }

    fn input<'a>(&'a self, to: i64, planned: Option<&'a Regex>) -> MetricsInput<'a> {
        MetricsInput {
            events: &self.events,
            project: P,
            base: "rust",
            from: 0,
            to,
            quiet_ms: 15 * MIN,
            merged: &self.merged,
            issues: &self.issues,
            planned,
            current: &self.current,
        }
    }
}

/// metrics.test.ts's `result`.
fn result() -> FactoryMetrics {
    let inputs = Inputs::new(events());
    let planned = planned();
    metrics(&inputs.input(80 * MIN, Some(&planned)))
}

fn report(metrics: &FactoryMetrics) -> String {
    render(P, "rust", metrics, &utc_plus_one())
}

/// The text from the heading `from` up to the heading `to`.
fn section<'a>(text: &'a str, from: &str, to: &str) -> &'a str {
    let start = text
        .find(from)
        .unwrap_or_else(|| panic!("no {from} in {text}"));
    let end = text.find(to).unwrap_or_else(|| panic!("no {to} in {text}"));
    &text[start..end]
}

fn numbers<T>(items: &[T], number: impl Fn(&T) -> u64) -> Vec<u64> {
    items.iter().map(number).collect()
}

// metrics.test.ts: "counts the person stepping in: messages through the fleet and turns typed into
// the coordinator's pane"
#[test]
fn counts_the_person_stepping_in() {
    assert_eq!(
        result().interventions,
        Interventions {
            messages: 1,
            typed_turns: 1
        }
    );
}

// metrics.test.ts: "finds the stretches with no run of the project moving that last the quiet
// period, up to the end of the window"
#[test]
fn finds_the_stretches_with_no_run_moving() {
    assert_eq!(
        result().standstills,
        vec![
            Standstill {
                from: 10 * MIN,
                to: 40 * MIN
            },
            Standstill {
                from: 54 * MIN,
                to: 80 * MIN
            },
        ]
    );
}

// metrics.test.ts: "counts runs per agent, the starts that failed or stopped before the task, the
// runs that ended or a helper's turn that settled without a HANDOFF, and calls an anomaly"
#[test]
fn counts_runs_per_agent_and_calls_an_anomaly() {
    assert_eq!(
        result().starts,
        vec![
            AgentStarts {
                agent: FleetAgentKind::Agy,
                starts: 3,
                failed: 2,
                lost: 1,
                anomaly: true
            },
            AgentStarts {
                agent: FleetAgentKind::Claude,
                starts: 3,
                failed: 0,
                lost: 1,
                anomaly: false
            },
        ]
    );
}

// metrics.test.ts: "counts runs per role version, the starts that failed and the runs without a
// HANDOFF, with the runs of no recorded version apart"
#[test]
fn counts_runs_per_role_version() {
    let result = result();
    // by hand from the events above: r3 failed to start and r4 left no HANDOFF on reviewer@cccc,
    // r2 (the user's reviewer) stopped before writing one, r failed to start before versions were recorded
    let row = |role: &str, version: Option<(&str, &str)>, starts, failed, lost| RoleStarts {
        role: role.to_owned(),
        hash: version.map(|(hash, _)| hash.to_owned()),
        source: version.map(|(_, source)| source.to_owned()),
        file: version.map(|(_, source)| format!("/{source}/{role}.md")),
        starts,
        failed,
        lost,
    };
    assert_eq!(
        result.roles,
        vec![
            row("coordinator", Some(("aaaaaaaaaaaa", "bundled")), 1, 0, 0),
            row("lead", Some(("bbbbbbbbbbbb", "bundled")), 1, 0, 0),
            row("reviewer", Some(("cccccccccccc", "bundled")), 2, 1, 1),
            row("reviewer", Some(("dddddddddddd", "user")), 1, 0, 1),
            row("reviewer", None, 1, 1, 0),
        ]
    );
    let text = report(&result);
    let table = section(&text, "## Runs per role version", "## Output");
    assert!(
        table.contains("| reviewer | cccccccccccc (bundled) | 2 | 1 | 1 |"),
        "{table}"
    );
    assert!(
        table.contains("| reviewer | dddddddddddd (user) | 1 | 0 | 1 |"),
        "{table}"
    );
    assert!(
        table.contains("| reviewer | not recorded | 1 | 1 | 0 |"),
        "{table}"
    );
}

// metrics.test.ts: "counts the turns an agent started by itself, per role, apart from the
// coordinator's typed ones"
#[test]
fn counts_the_turns_an_agent_started_by_itself() {
    let own: Vec<(String, u64)> = result().own_turns.into_iter().collect();
    assert_eq!(own, vec![("lead".to_owned(), 1)]);
}

// metrics.test.ts: "takes from GitHub what falls in the window and was merged into the base, and the
// issues opened without a phase label as found during the work"
#[test]
fn takes_from_github_what_falls_in_the_window() {
    let result = result();
    assert_eq!(numbers(&result.merged, |pr| pr.number), vec![9]);
    assert_eq!(numbers(&result.closed, |issue| issue.number), vec![1]);
    assert_eq!(numbers(&result.found, |issue| issue.number), vec![2]);
    assert_eq!(result.reconciled, 1);
    assert_eq!(result.standstill_calls, 1);
}

// metrics.test.ts: "lists every issue opened in the window when no planned label is given"
#[test]
fn lists_every_issue_opened_when_no_planned_label_is_given() {
    let inputs = Inputs::new(events());
    let all = metrics(&inputs.input(80 * MIN, None));
    assert_eq!(numbers(&all.found, |issue| issue.number), vec![1, 2]);
    assert!(report(&all).contains("- Issues opened: 2"));
    assert!(
        report(&result())
            .contains("- Issues opened without a planned label (^(phase:|tracking$)): 1")
    );
}

// metrics.test.ts: "puts the anomalies first"
#[test]
fn puts_the_anomalies_first() {
    let text = report(&result());
    let anomalies = section(&text, "## Anomalies", "## Without the person");
    assert!(
        anomalies.contains("The person stepped in 2 times."),
        "{anomalies}"
    );
    assert!(anomalies.contains("Stood still 30 minutes"), "{anomalies}");
    assert!(
        anomalies.contains(
            "agy: of 3 runs, 2 failed or stopped before the task and 1 ended without a report."
        ),
        "{anomalies}"
    );
}

// metrics.test.ts: "counts per agent the turns that ended without a report, and the lead runs the
// fleet restarted: started, not started, and later ready"
#[test]
fn counts_turns_without_a_report_and_the_restarted_leads() {
    let reported = |t: f64, run: &str, role: &str, agent: &str, report: &str| {
        let mut value = turn_end(t, run, role, agent, role == "lead", report != "none");
        value["report"] = json!(report);
        event(value)
    };
    let none = || json!({});
    let log = vec![
        state(0.0, "l1", "lead", "claude", None, "starting", false, none()),
        state(
            1.0,
            "l1",
            "lead",
            "claude",
            Some("starting"),
            "working",
            true,
            none(),
        ),
        state(
            2.0,
            "l1",
            "lead",
            "claude",
            Some("working"),
            "idle",
            true,
            none(),
        ),
        reported(2.0, "l1", "lead", "claude", "none"),
        event(json!({
            "t": at(2.0), "kind": "restart", "run": "l1", "project": P, "agent": "claude",
            "why": "no-report", "by": "l2", "to": "codex",
        })),
        state(2.0, "l2", "lead", "codex", None, "starting", false, none()),
        state(
            3.0,
            "l2",
            "lead",
            "codex",
            Some("starting"),
            "working",
            true,
            none(),
        ),
        state(
            5.0,
            "l2",
            "lead",
            "codex",
            Some("working"),
            "idle",
            true,
            none(),
        ),
        reported(5.0, "l2", "lead", "codex", "ready"),
        // another thread, whose lead failed with no CLI left to restart it on
        state(6.0, "l3", "lead", "codex", None, "starting", false, none()),
        state(
            6.5,
            "l3",
            "lead",
            "codex",
            Some("starting"),
            "working",
            true,
            none(),
        ),
        state(
            7.0,
            "l3",
            "lead",
            "codex",
            Some("working"),
            "failed",
            true,
            json!({ "error": "quota" }),
        ),
        reported(7.0, "l3", "lead", "codex", "none"),
        event(json!({
            "t": at(7.0), "kind": "restart", "run": "l3", "project": P, "agent": "codex",
            "why": "failed", "error": "No candidate is usable",
        })),
        // a helper that reported, and a turn logged before reports were (it counts for neither)
        state(
            7.5,
            "r5",
            "reviewer",
            "claude",
            None,
            "starting",
            false,
            none(),
        ),
        reported(8.0, "r5", "reviewer", "claude", "ready"),
        state(
            8.5,
            "r6",
            "reviewer",
            "claude",
            None,
            "starting",
            false,
            none(),
        ),
        event(turn_end(9.0, "r6", "reviewer", "claude", false, true)),
    ];
    let mut inputs = Inputs::new(log);
    inputs.merged.items.clear();
    inputs.issues.items.clear();
    let counted = metrics(&inputs.input(10 * MIN, None));
    assert_eq!(
        counted.reports,
        vec![
            TurnReports {
                agent: FleetAgentKind::Claude,
                turns: 2,
                none: 1
            },
            TurnReports {
                agent: FleetAgentKind::Codex,
                turns: 2,
                none: 1
            },
        ]
    );
    assert_eq!(
        counted.restarts,
        Restarts {
            started: 1,
            failed: 1,
            ready: 1
        }
    );
    // l1's last turn left no report: a lead counts now that leads report, as l3 failed does
    assert_eq!(
        counted.starts,
        vec![
            AgentStarts {
                agent: FleetAgentKind::Claude,
                starts: 3,
                failed: 0,
                lost: 1,
                anomaly: false
            },
            AgentStarts {
                agent: FleetAgentKind::Codex,
                starts: 2,
                failed: 0,
                lost: 1,
                anomaly: false
            },
        ]
    );
    let text = report(&counted);
    assert!(text.contains(
        "- Lead runs the fleet restarted on another CLI: 1 (1 could not start); replacements that later reported ready: 1"
    ));
    assert!(text.contains("| Agent | Turns that ended | Without a report |"));
    assert!(text.contains("| codex | 2 | 1 |"));
}

/// A folder of its own under the system's temporary folder, removed when dropped.
struct Folder(PathBuf);

impl Folder {
    fn new() -> Folder {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "fleet-metrics-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Folder(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// metrics.test.ts: "reads the event log line by line, skipping a line that does not parse, and
// nothing from a missing file"
#[test]
fn reads_the_event_log_line_by_line() {
    let folder = Folder::new();
    let file = folder.path().join("fleet-events.jsonl");
    assert_eq!(read_events(&file), Vec::new());
    fs::write(
        &file,
        "{\"t\":1,\"kind\":\"person\",\"run\":\"c\",\"project\":\"/repo\"}\n{\"t\":2,\"kind\":\"per\n\n{\"t\":3,\"kind\":\"standstill\",\"run\":\"c\",\"project\":\"/repo\",\"quietMs\":5}\n",
    )
    .unwrap();
    let times: Vec<i64> = read_events(&file).iter().map(|event| event.t).collect();
    assert_eq!(times, vec![1, 3]);
}

/// What metrics.ts's `render` wrote for metrics.test.ts's `result` under bun 1.4.4 with
/// `TZ=Etc/GMT-1` (an hour ahead of UTC): the events, issues and pull requests of
/// metrics.test.ts, `metrics({ events, project: P, base: "rust", from: 0, to: 80 * MIN,
/// quietMs: 15 * MIN, merged, issues, planned: /^(phase:|tracking$)/ })`.
const TYPESCRIPT_REPORT: &str = r#"# Factory metrics: /repo (rust)

1970-01-01 01:00 to 1970-01-01 02:20

## Anomalies

- The person stepped in 2 times.
- Stood still 30 minutes (1970-01-01 01:10 to 1970-01-01 01:40).
- Stood still 26 minutes (1970-01-01 01:54 to 1970-01-01 02:20).
- agy: of 3 runs, 2 failed or stopped before the task and 1 ended without a report.

## Without the person

- The person stepped in: 1 messages through the fleet, 1 turns typed into the coordinator's pane
- Stood still: 2 times, 56 minutes in all; the coordinator was called 1 times
- Threads closed against GitHub: 1
- Lead runs the fleet restarted on another CLI: 0 (0 could not start); replacements that later reported ready: 0
- Turns an agent started by itself: lead 1

## Starts per agent

| Agent | Starts | Failed or stopped before the task | Ended without a report |
|---|---|---|---|
| agy | 3 | 2 | 1 (anomaly) |
| claude | 3 | 0 | 1 |

## Runs per role version

| Role | Version | Starts | Failed or stopped before the task | Ended without a report |
|---|---|---|---|---|
| coordinator | aaaaaaaaaaaa (bundled) | 1 | 0 | 0 |
| lead | bbbbbbbbbbbb (bundled) | 1 | 0 | 0 |
| reviewer | cccccccccccc (bundled) | 2 | 1 | 1 |
| reviewer | dddddddddddd (user) | 1 | 0 | 1 |
| reviewer | not recorded | 1 | 1 | 0 |

## Reports

| Agent | Turns that ended | Without a report |
|---|---|---|
| none | 0 | 0 |

## Output

- Pull requests merged: 1 (#9)
- Issues closed: 1
- Issues opened without a planned label (^(phase:|tracking$)): 1: #2 found a bug
"#;

#[test]
fn renders_the_report_as_typescript_does() {
    assert_eq!(report(&result()), TYPESCRIPT_REPORT);
}

// Where the Rust version differs from metrics.ts (issue #259, "main の欠陥"). The expected values
// are worked out by hand from the issues that name each defect.

/// A state event as the fleet wrote it before it recorded `interactive` (#189's item 1).
fn old_state(
    t: f64,
    run: &str,
    role: &str,
    from: Option<&str>,
    to: &str,
    sent: bool,
) -> TimedEvent {
    let mut value =
        serde_json::to_value(state(t, run, role, "claude", from, to, sent, json!({}))).unwrap();
    value.as_object_mut().unwrap().remove("interactive");
    event(value)
}

// #189's item 1: a run with neither `interactive` nor a turn event (logged before either was
// recorded) that stopped is not counted as ended without a report: it may have been a lead the
// person or the fleet stopped. A failed run still is: failing says so whatever the role.
#[test]
fn does_not_count_an_old_stopped_run_as_ended_without_a_report() {
    let log = vec![
        old_state(0.0, "o1", "lead", None, "starting", false),
        old_state(1.0, "o1", "lead", Some("starting"), "working", true),
        old_state(2.0, "o1", "lead", Some("working"), "stopped", false),
        old_state(3.0, "o2", "reviewer", None, "starting", false),
        old_state(4.0, "o2", "reviewer", Some("starting"), "working", true),
        old_state(5.0, "o2", "reviewer", Some("working"), "stopped", false),
        old_state(6.0, "o3", "reviewer", None, "starting", false),
        old_state(7.0, "o3", "reviewer", Some("starting"), "working", true),
        old_state(8.0, "o3", "reviewer", Some("working"), "failed", true),
    ];
    let inputs = Inputs::new(log);
    let counted = metrics(&inputs.input(10 * MIN, None));
    // three starts, none failed before the task; only o3, which failed, ended without a report
    assert_eq!(
        counted.starts,
        vec![AgentStarts {
            agent: FleetAgentKind::Claude,
            starts: 3,
            failed: 0,
            lost: 1,
            anomaly: false
        }]
    );
}

/// A lead that starts at minute 0 and works from minute 1, and nothing after: the server stopped,
/// or the run was removed, before its turn ended.
fn left_working() -> Vec<TimedEvent> {
    let none = || json!({});
    vec![
        state(0.0, "w", "lead", "claude", None, "starting", false, none()),
        state(
            1.0,
            "w",
            "lead",
            "claude",
            Some("starting"),
            "working",
            true,
            none(),
        ),
    ]
}

// #176's item 8 and #189's item 5: a run the log leaves working, but that the fleet no longer holds
// (the registry dropped it) or holds in a state that does not move (its last state event was lost),
// does not move on forever: the project stands still from its last state change, minute 1, to the
// end of the window, minute 60, and the report says why.
#[test]
fn does_not_take_a_run_the_fleet_no_longer_shows_moving_as_moving() {
    for current in [None, Some(AgentState::Idle)] {
        let mut inputs = Inputs::new(left_working());
        if let Some(state) = current {
            inputs.current.insert("w".to_owned(), state);
        }
        check_left_working(&metrics(&inputs.input(60 * MIN, None)));
    }
}

fn check_left_working(counted: &FactoryMetrics) {
    assert_eq!(
        counted.standstills,
        vec![Standstill {
            from: MIN,
            to: 60 * MIN
        }]
    );
    assert_eq!(counted.unended, 1);
    let text = report(counted);
    assert!(
        text.contains("- Stood still 59 minutes (1970-01-01 01:01 to 1970-01-01 02:00)."),
        "{text}"
    );
    assert!(
        text.contains("- Runs the event log leaves moving that the fleet no longer shows moving (the server stopped, or the run was removed), taken as still from their last change: 1"),
        "{text}"
    );
}

// The same run while the fleet still shows it working: it moves to the end of the window, as in
// metrics.ts, and the report has no such line.
#[test]
fn takes_a_run_the_fleet_shows_working_as_moving() {
    let mut inputs = Inputs::new(left_working());
    inputs.current.insert("w".to_owned(), AgentState::Working);
    let counted = metrics(&inputs.input(60 * MIN, None));
    assert_eq!(counted.standstills, Vec::new());
    assert_eq!(counted.unended, 0);
    assert!(!report(&counted).contains("Runs the event log leaves moving"));
}

// #176's item 8: a list that reached gh's limit (200 merged pull requests, 500 issues: github.rs)
// is said so, as the counts may miss what it left out; a list under the limit says nothing.
#[test]
fn says_when_a_list_reached_the_limit_of_gh() {
    let mut inputs = Inputs::new(events());
    let text = report(&metrics(&inputs.input(80 * MIN, None)));
    assert!(!text.contains("gh listed"), "{text}");
    inputs.merged.limit_reached = true;
    inputs.issues.limit_reached = true;
    let counted = metrics(&inputs.input(80 * MIN, None));
    assert!(counted.merged_limit_reached && counted.issues_limit_reached);
    let text = report(&counted);
    let output = &text[text.find("## Output").unwrap()..];
    assert!(
        output.contains("- gh listed no more than 200 merged pull requests, the newest opened: the pull requests merged may be more than counted\n"),
        "{output}"
    );
    assert!(
        output.contains("- gh listed no more than 500 issues, the newest opened: the issues closed and opened may be more than counted\n"),
        "{output}"
    );
}

// #189's item 7: the anomalies the fleet acted on are its restart events (main since #238); the
// `anomaly` events older logs hold do not parse, and the lines around them are read.
#[test]
fn skips_the_anomaly_events_of_older_logs() {
    let folder = Folder::new();
    let file = folder.path().join("fleet-events.jsonl");
    fs::write(
        &file,
        concat!(
            "{\"t\":1,\"kind\":\"person\",\"run\":\"c\",\"project\":\"/repo\"}\n",
            "{\"t\":2,\"kind\":\"anomaly\",\"run\":\"c\",\"project\":\"/repo\",\"agent\":\"agy\"}\n",
            "{\"t\":3,\"kind\":\"restart\",\"run\":\"l1\",\"project\":\"/repo\",\"agent\":\"claude\",\"why\":\"no-report\",\"by\":\"l2\",\"to\":\"codex\"}\n",
        ),
    )
    .unwrap();
    let times: Vec<i64> = read_events(&file).iter().map(|event| event.t).collect();
    assert_eq!(times, vec![1, 3]);
}

// The event log moves to `<file>.1` at its size limit (events.rs): the moved file's events come
// first, then the log's.
#[test]
fn reads_the_moved_log_before_the_log() {
    let folder = Folder::new();
    let file = folder.path().join("fleet-events.jsonl");
    fs::write(
        &file,
        "{\"t\":2,\"kind\":\"person\",\"run\":\"c\",\"project\":\"/repo\"}\n",
    )
    .unwrap();
    fs::write(
        rotated_path(&file),
        "{\"t\":1,\"kind\":\"person\",\"run\":\"c\",\"project\":\"/repo\"}\n",
    )
    .unwrap();
    let times: Vec<i64> = read_events(&file).iter().map(|event| event.t).collect();
    assert_eq!(times, vec![1, 2]);
}

// atriumnook's comment on #259 (2026-11-09T04:07): the metrics count the events of both files of
// the log, the moved one and the log; TypeScript reads the log only. One message through the fleet
// in each file makes two.
#[test]
fn counts_the_events_of_both_files_of_the_log() {
    let folder = Folder::new();
    let file = folder.path().join("fleet-events.jsonl");
    fs::write(
        rotated_path(&file),
        "{\"t\":60000,\"kind\":\"person\",\"run\":\"c\",\"project\":\"/repo\"}\n",
    )
    .unwrap();
    fs::write(
        &file,
        "{\"t\":120000,\"kind\":\"person\",\"run\":\"c\",\"project\":\"/repo\"}\n",
    )
    .unwrap();
    let inputs = Inputs::new(read_events(&file));
    let counted = metrics(&inputs.input(10 * MIN, None));
    assert_eq!(
        counted.interventions,
        Interventions {
            messages: 2,
            typed_turns: 0
        }
    );
    assert_eq!(counted.log_start, Some(MIN));
}

/// The report's line of the window, from `from` to `to`, with no events.
fn window_line(from: i64, to: i64, zone: &TimeZone) -> String {
    let inputs = Inputs::new(Vec::new());
    let mut input = inputs.input(to, None);
    input.from = from;
    let text = render(P, "rust", &metrics(&input), zone);
    text.lines().nth(2).unwrap().to_owned()
}

// metrics.ts writes times as `toLocaleString("sv-SE").slice(0, 16)`: the local date and time to
// the minute, the seconds cut off. 1_793_491_200_000 is 2026-11-01T00:00Z (clock.rs, worked out by
// hand), so an hour ahead of UTC it is 01:00, and 59.999 seconds later still 01:00.
#[test]
fn writes_the_local_time_to_the_minute() {
    assert_eq!(
        window_line(1_793_491_200_000, 1_793_491_259_999, &utc_plus_one()),
        "2026-11-01 01:00 to 2026-11-01 01:00 (no events for this project)"
    );
}

// The offset at each instant: Central European time is two hours ahead of UTC on 2026-07-01
// (123 days before 2026-11-01: 1_782_864_000_000) and one hour ahead on 2026-11-01, as summer time
// ends on the last Sunday of October (2026-10-25).
#[test]
fn writes_each_time_with_the_offset_of_its_instant() {
    let central_europe = TimeZone::posix("CET-1CEST,M3.5.0,M10.5.0/3").unwrap();
    assert_eq!(
        window_line(1_782_864_000_000, 1_793_491_200_000, &central_europe),
        "2026-07-01 02:00 to 2026-11-01 01:00 (no events for this project)"
    );
}

// codex's review of PR #306: metrics.ts keeps the own turns in a JavaScript object, whose
// `Object.entries` lists the integer-index keys first, in numeric order, then the others in the
// order they were added. What metrics.ts's `render` wrote under bun 1.4.4 for runs of the roles
// "2", "1", "x" and "01", in that order, each starting one turn by itself.
#[test]
fn lists_the_turns_an_agent_started_by_itself_in_the_order_of_a_javascript_object() {
    let none = || json!({});
    let mut log = Vec::new();
    for (index, (run, role)) in [("a", "2"), ("b", "1"), ("x1", "x"), ("d", "01")]
        .into_iter()
        .enumerate()
    {
        let t = index as f64;
        log.extend([
            state(t, run, role, "claude", None, "starting", false, none()),
            state(
                t + 0.1,
                run,
                role,
                "claude",
                Some("starting"),
                "working",
                true,
                none(),
            ),
            state(
                t + 0.2,
                run,
                role,
                "claude",
                Some("working"),
                "idle",
                true,
                none(),
            ),
            state(
                t + 0.3,
                run,
                role,
                "claude",
                Some("idle"),
                "working",
                false,
                none(),
            ),
            state(
                t + 0.4,
                run,
                role,
                "claude",
                Some("working"),
                "idle",
                false,
                none(),
            ),
        ]);
    }
    let inputs = Inputs::new(log);
    let text = report(&metrics(&inputs.input(10 * MIN, None)));
    assert!(
        text.contains("- Turns an agent started by itself: 1 1, 2 1, x 1, 01 1\n"),
        "{text}"
    );
}
