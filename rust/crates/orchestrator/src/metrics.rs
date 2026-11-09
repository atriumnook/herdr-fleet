//! The factory's metrics for one project, from the fleet's event log ([`crate::events`]) and what
//! GitHub says: how often the person stepped in, the stretches the project stood still, starts per
//! agent with the failed ones, the runs that ended without a report, the same per role version (the
//! role file a run started with), the turns that ended without a report, the thread lead runs the
//! fleet started again, the turns agents started by themselves, the threads closed against GitHub,
//! the pull requests merged into the project's base, the issues closed and the issues opened
//! (without a planned label, when one is given: found during the work); from
//! `server/fleet/metrics.ts`. Pure but for [`read_events`]: the report route reads the inputs and
//! hands them in.
//!
//! Where this differs from metrics.ts (issue #259):
//! - a run the log leaves working or starting, but that the fleet no longer shows moving (the
//!   server stopped, or the run was removed, and no state event was written), is not taken to move
//!   on forever (#176's item 8, #189's item 5): see [`MetricsInput::current`];
//! - a list that reached `gh`'s limit is said so in the report (#176's item 8);
//! - a run with neither `interactive` on its last state event nor a turn event (events written
//!   before those were recorded) is not counted as ended without a report when it stopped (#189's
//!   item 1);
//! - the anomalies the fleet acted on are its `restart` events, which the report reads, as main
//!   does since #238 (#189's item 7); the `anomaly` events of older logs do not parse and are
//!   skipped.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::path::Path;

use indexmap::IndexMap;
use jiff::Timestamp;
use jiff::tz::TimeZone;
use protocol::{AgentState, FleetAgentKind};
use regex::Regex;

use crate::events::{FleetEvent, RoleEvent, StateEvent, TimedEvent, TurnEvent, TurnReport};
use crate::events::{RestartEvent, rotated_path};
use crate::github::{
    ISSUES_LIMIT, IssueSummary, Listing, MERGED_PULL_REQUESTS_LIMIT, MergedPullRequest,
};

/// How often the person stepped in: messages through the fleet, and turns typed into the
/// coordinator's pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Interventions {
    pub messages: u64,
    pub typed_turns: u64,
}

/// A stretch with no run of the project moving, as long as the quiet period or longer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Standstill {
    pub from: i64,
    pub to: i64,
}

/// Per agent: runs started, starts that failed or stopped before the task, runs that ended without
/// a report, and whether those make an anomaly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentStarts {
    pub agent: FleetAgentKind,
    pub starts: u64,
    pub failed: u64,
    pub lost: u64,
    pub anomaly: bool,
}

/// The same counts per role version: the role file a run started with and its hash, absent for a
/// run whose version was not recorded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleStarts {
    pub role: String,
    pub hash: Option<String>,
    pub source: Option<String>,
    pub file: Option<String>,
    pub starts: u64,
    pub failed: u64,
    pub lost: u64,
}

/// Per agent: the turns that ended since the fleet reads reports, and those that left none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnReports {
    pub agent: FleetAgentKind,
    pub turns: u64,
    pub none: u64,
}

/// The thread lead runs the fleet started again: started, could not start, and replacements that
/// later reported ready.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Restarts {
    pub started: u64,
    pub failed: u64,
    pub ready: u64,
}

/// A project's factory metrics over a window (metrics.ts's `FactoryMetrics`).
#[derive(Debug, Clone, PartialEq)]
pub struct FactoryMetrics {
    pub from: i64,
    pub to: i64,
    /// the first event of the project in the log, before the window or in it
    pub log_start: Option<i64>,
    pub interventions: Interventions,
    pub standstills: Vec<Standstill>,
    pub standstill_calls: u64,
    pub starts: Vec<AgentStarts>,
    pub roles: Vec<RoleStarts>,
    pub reports: Vec<TurnReports>,
    pub restarts: Restarts,
    /// per role, in the order first seen
    pub own_turns: IndexMap<String, u64>,
    pub reconciled: u64,
    /// the runs the log leaves moving that the fleet no longer shows moving, taken as still from
    /// their last state change ([`MetricsInput::current`])
    pub unended: u64,
    pub merged: Vec<MergedPullRequest>,
    /// whether `gh`'s list of merged pull requests reached its limit: some may be missing
    pub merged_limit_reached: bool,
    pub closed: Vec<IssueSummary>,
    pub found: Vec<IssueSummary>,
    /// whether `gh`'s list of issues reached its limit: some may be missing
    pub issues_limit_reached: bool,
    /// the labels of planned issues, as given (`--planned-label`)
    pub planned: Option<String>,
}

/// What [`metrics`] counts from.
pub struct MetricsInput<'a> {
    pub events: &'a [TimedEvent],
    /// the repository's main worktree, as the event log records projects
    pub project: &'a str,
    /// the branch pull requests are counted against
    pub base: &'a str,
    pub from: i64,
    pub to: i64,
    pub quiet_ms: i64,
    pub merged: &'a Listing<MergedPullRequest>,
    pub issues: &'a Listing<IssueSummary>,
    pub planned: Option<&'a Regex>,
    /// The runs the fleet holds at `to` and their states. The fleet writes a state event only when a
    /// run's saved state changes, so a run removed while it worked (the registry drops one untouched
    /// for 7 days), or one whose last state event failed to be written, stays working in the log. A
    /// run whose last state event up to `to` is working or starting, but that is not here or is here
    /// in another state, is taken to have stood still from that event on: the last time it was seen
    /// moving. The map holds every run of the registry: a run left out of it counts as not moving,
    /// so an empty map takes every run the log leaves moving as still.
    pub current: &'a HashMap<String, AgentState>,
}

/// The events of the log at `file`, after those of the file it moved to when it reached its limit
/// ([`rotated_path`]), skipping a line that does not parse; none from a missing file.
pub fn read_events(file: &Path) -> Vec<TimedEvent> {
    // The log may move to the rotated file between the two reads, which would lose a whole file of
    // events: read again while the rotated file changes under the reads (a move happens once per
    // 8 MiB of events, so a second read finds it settled).
    let rotated = rotated_path(file);
    let stamp = || {
        std::fs::metadata(&rotated)
            .ok()
            .map(|meta| (meta.len(), meta.modified().ok()))
    };
    let mut events = Vec::new();
    for _ in 0..3 {
        let before = stamp();
        events = read_files(&[rotated.clone(), file.to_path_buf()]);
        if stamp() == before {
            break;
        }
    }
    events
}

fn read_files(paths: &[std::path::PathBuf]) -> Vec<TimedEvent> {
    paths
        .iter()
        .flat_map(|path| {
            // line by line: a byte that is not UTF-8 loses its line only
            let bytes = std::fs::read(path).unwrap_or_default();
            bytes
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.trim_ascii().is_empty())
                .filter_map(|line| serde_json::from_slice::<TimedEvent>(line).ok())
                .collect::<Vec<_>>()
        })
        .collect()
}

fn is_moving(state: AgentState) -> bool {
    matches!(state, AgentState::Working | AgentState::Starting)
}

/// The name an agent goes by in the log and the report: `FleetAgentKind`'s own serde name, as
/// `launch`'s `kind_name` reads it.
fn agent_name(agent: FleetAgentKind) -> String {
    match serde_json::to_value(agent) {
        Ok(serde_json::Value::String(name)) => name,
        _ => format!("{agent:?}"),
    }
}

/// The runs of `project` in the events: its coordinator and threads, and the helpers in their
/// groups.
fn project_runs(events: &[&TimedEvent], project: &str) -> HashSet<String> {
    let states = || {
        events.iter().filter_map(|event| match &event.event {
            FleetEvent::State(state) => Some(state),
            _ => None,
        })
    };
    let groups: HashSet<&str> = states()
        .filter(|state| state.project.as_deref() == Some(project))
        .map(|state| state.group.as_str())
        .collect();
    states()
        .filter(|state| {
            state.project.as_deref() == Some(project) || groups.contains(state.group.as_str())
        })
        .map(|state| state.run.clone())
        .collect()
}

/// Whether `event` belongs to the project: a run's events by the run, the others by their project.
fn is_mine(event: &TimedEvent, runs: &HashSet<String>, project: &str) -> bool {
    match &event.event {
        FleetEvent::State(StateEvent { run, .. })
        | FleetEvent::Turn(TurnEvent { run, .. })
        | FleetEvent::Role(RoleEvent { run, .. }) => runs.contains(run),
        FleetEvent::Person(person) => person.project == project,
        FleetEvent::Standstill(standstill) => standstill.project == project,
        FleetEvent::Reconciled(reconciled) => reconciled.project == project,
        FleetEvent::Restart(restart) => restart.project == project,
    }
}

#[derive(Default)]
struct Counts {
    starts: u64,
    failed: u64,
    lost: u64,
}

#[derive(Clone, Copy)]
enum Count {
    Starts,
    Failed,
    Lost,
}

impl Counts {
    fn add(&mut self, key: Count) {
        match key {
            Count::Starts => self.starts += 1,
            Count::Failed => self.failed += 1,
            Count::Lost => self.lost += 1,
        }
    }
}

/// Each count goes to the run's agent and to the role version it started with (a role event, when
/// the fleet recorded one).
struct StartCounts<'a> {
    version_of: HashMap<&'a str, &'a RoleEvent>,
    by_agent: IndexMap<FleetAgentKind, Counts>,
    /// by the role and its version's hash (empty for no recorded version), as metrics.ts keys them
    by_version: IndexMap<(String, String), (Option<&'a RoleEvent>, Counts)>,
}

impl<'a> StartCounts<'a> {
    fn count(&mut self, event: &StateEvent, key: Count) {
        self.by_agent.entry(event.agent).or_default().add(key);
        let version = self.version_of.get(event.run.as_str()).copied();
        let version_key = (
            event.role.clone(),
            version.map(|v| v.hash.clone()).unwrap_or_default(),
        );
        self.by_version
            .entry(version_key)
            .or_insert_with(|| (version, Counts::default()))
            .1
            .add(key);
    }
}

/// A start that failed, or that stopped before its task was sent.
fn start_failed(event: &StateEvent) -> bool {
    (event.to == AgentState::Failed && event.from == Some(AgentState::Starting))
        || event
            .error
            .as_deref()
            .is_some_and(|error| error.contains("not been sent") || error.contains("not ready"))
}

/// Counts the project's metrics over the window (metrics.ts's `metrics`).
pub fn metrics(input: &MetricsInput<'_>) -> FactoryMetrics {
    let MetricsInput {
        project, from, to, ..
    } = *input;
    let mut events: Vec<&TimedEvent> = input.events.iter().collect();
    events.sort_by_key(|event| event.t);
    let runs = project_runs(&events, project);
    let mine: Vec<&TimedEvent> = events
        .into_iter()
        .filter(|event| is_mine(event, &runs, project))
        .collect();
    let in_window: Vec<&TimedEvent> = mine
        .iter()
        .copied()
        .filter(|event| event.t >= from && event.t <= to)
        .collect();
    let log_start = mine.first().map(|event| event.t);

    let (standstills, unended) = standstills(&mine, input, log_start);

    let mut version_of = HashMap::new();
    for event in &mine {
        if let FleetEvent::Role(role) = &event.event {
            version_of.insert(role.run.as_str(), role);
        }
    }
    let mut counts = StartCounts {
        version_of,
        by_agent: IndexMap::new(),
        by_version: IndexMap::new(),
    };
    // each run's last state change in the window, its open turn's end (cleared when it works again),
    // and whether its start failed
    let mut last: IndexMap<&str, &StateEvent> = IndexMap::new();
    let mut turn_end: HashMap<&str, &TurnEvent> = HashMap::new();
    let mut failed_starts: HashSet<&str> = HashSet::new();
    let mut own_turns: IndexMap<String, u64> = IndexMap::new();
    let mut typed_turns = 0;
    for event in &in_window {
        let state = match &event.event {
            FleetEvent::Turn(turn) => {
                turn_end.insert(turn.run.as_str(), turn);
                continue;
            }
            FleetEvent::State(state) => state,
            _ => continue,
        };
        last.insert(state.run.as_str(), state);
        if state.to == AgentState::Working {
            turn_end.remove(state.run.as_str());
        }
        if state.from.is_none() {
            counts.count(state, Count::Starts);
        }
        if !failed_starts.contains(state.run.as_str()) && start_failed(state) {
            failed_starts.insert(state.run.as_str());
            counts.count(state, Count::Failed);
        }
        if state.to == AgentState::Working
            && state.from.is_some_and(|from| from != AgentState::Starting)
            && !state.sent
        {
            if state.role == "coordinator" {
                typed_turns += 1;
            } else {
                *own_turns.entry(state.role.clone()).or_default() += 1;
            }
        }
    }
    // a run without a report, its start not counted already: one that failed, one whose last turn
    // left none (a helper's pane is kept; a lead's thread starts again), or a helper that ended in
    // the middle of one. A lead stopped mid-turn is not counted: the fleet closes a landed thread,
    // the person stops one. Events written before reports say only whether a HANDOFF was there, and
    // a lead then ended turns to wait without one. A run whose events say neither whether it talks
    // in its pane nor how its turn ended was logged before either was recorded: it is not counted
    // when it stopped, since it may have been a lead (#189's item 1).
    for state in last.values() {
        if state.role == "coordinator" || failed_starts.contains(state.run.as_str()) {
            continue;
        }
        let end = turn_end.get(state.run.as_str()).copied();
        let interactive = state.interactive.or(end.map(|end| end.interactive));
        let unreported = match end {
            Some(end) => match end.report {
                Some(report) => report == TurnReport::None,
                None => !end.handoff,
            },
            None => state.to == AgentState::Stopped,
        };
        let reported_turn = end.is_some_and(|end| end.report.is_some());
        let lost = state.to == AgentState::Failed
            || interactive.is_some_and(|interactive| (!interactive || reported_turn) && unreported);
        if lost {
            counts.count(state, Count::Lost);
        }
    }

    let mut reports: Vec<TurnReports> = Vec::new();
    for event in &in_window {
        let FleetEvent::Turn(turn) = &event.event else {
            continue;
        };
        let Some(report) = turn.report else { continue };
        let row = match reports.iter_mut().position(|row| row.agent == turn.agent) {
            Some(index) => &mut reports[index],
            None => {
                reports.push(TurnReports {
                    agent: turn.agent,
                    turns: 0,
                    none: 0,
                });
                reports.last_mut().expect("just pushed")
            }
        };
        row.turns += 1;
        if report == TurnReport::None {
            row.none += 1;
        }
    }
    reports.sort_by_cached_key(|row| agent_name(row.agent));

    let restart_events: Vec<&RestartEvent> = in_window
        .iter()
        .filter_map(|event| match &event.event {
            FleetEvent::Restart(restart) => Some(restart),
            _ => None,
        })
        .collect();
    let replacements: HashSet<&str> = restart_events
        .iter()
        .filter_map(|restart| restart.by.as_deref())
        .collect();
    let ready_after: HashSet<&str> = in_window
        .iter()
        .filter_map(|event| match &event.event {
            FleetEvent::Turn(turn)
                if turn.report == Some(TurnReport::Ready)
                    && replacements.contains(turn.run.as_str()) =>
            {
                Some(turn.run.as_str())
            }
            _ => None,
        })
        .collect();
    let restarts = Restarts {
        started: replacements.len() as u64,
        failed: restart_events
            .iter()
            .filter(|restart| restart.by.is_none())
            .count() as u64,
        ready: ready_after.len() as u64,
    };

    let mut starts: Vec<AgentStarts> = counts
        .by_agent
        .iter()
        .map(|(agent, counts)| {
            let bad = counts.failed + counts.lost;
            AgentStarts {
                agent: *agent,
                starts: counts.starts,
                failed: counts.failed,
                lost: counts.lost,
                anomaly: bad >= 2 && bad * 3 >= counts.starts.max(bad),
            }
        })
        .collect();
    starts.sort_by_cached_key(|row| agent_name(row.agent));
    // per role, the recorded versions by hash, then the runs of no recorded version
    let mut roles: Vec<RoleStarts> = counts
        .by_version
        .iter()
        .map(|((role, _), (version, counts))| RoleStarts {
            role: role.clone(),
            hash: version.map(|v| v.hash.clone()),
            source: version.map(|v| v.source.clone()),
            file: version.map(|v| v.file.clone()),
            starts: counts.starts,
            failed: counts.failed,
            lost: counts.lost,
        })
        .collect();
    roles.sort_by(|a, b| {
        a.role.cmp(&b.role).then_with(|| match (&a.hash, &b.hash) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(a), Some(b)) => a.cmp(b),
        })
    });

    let within = |at: Option<&str>| {
        at.and_then(parse_time)
            .is_some_and(|at| at >= from && at <= to)
    };
    let count_of = |kind: fn(&FleetEvent) -> bool| {
        in_window.iter().filter(|event| kind(&event.event)).count() as u64
    };
    FactoryMetrics {
        from,
        to,
        log_start,
        interventions: Interventions {
            messages: count_of(|event| matches!(event, FleetEvent::Person(_))),
            typed_turns,
        },
        standstills,
        standstill_calls: count_of(|event| matches!(event, FleetEvent::Standstill(_))),
        starts,
        roles,
        reports,
        restarts,
        own_turns,
        reconciled: count_of(|event| matches!(event, FleetEvent::Reconciled(_))),
        unended,
        merged: input
            .merged
            .items
            .iter()
            .filter(|pr| pr.base_ref_name == input.base && within(Some(&pr.merged_at)))
            .cloned()
            .collect(),
        merged_limit_reached: input.merged.limit_reached,
        closed: input
            .issues
            .items
            .iter()
            .filter(|issue| within(issue.closed_at.as_deref()))
            .cloned()
            .collect(),
        found: input
            .issues
            .items
            .iter()
            .filter(|issue| {
                within(Some(&issue.created_at))
                    && !issue.labels.iter().any(|label| {
                        input
                            .planned
                            .is_some_and(|planned| planned.is_match(&label.name))
                    })
            })
            .cloned()
            .collect(),
        issues_limit_reached: input.issues.limit_reached,
        planned: input.planned.map(|planned| planned.as_str().to_owned()),
    }
}

/// The stretches with no run moving that last the quiet period, up to the end of the window, and
/// how many runs the log leaves moving that the fleet no longer shows moving. Every state change is
/// replayed, the ones before the window included.
fn standstills(
    mine: &[&TimedEvent],
    input: &MetricsInput<'_>,
    log_start: Option<i64>,
) -> (Vec<Standstill>, u64) {
    let MetricsInput {
        from, to, quiet_ms, ..
    } = *input;
    let state_events: Vec<(i64, &StateEvent)> = mine
        .iter()
        .filter_map(|event| match &event.event {
            FleetEvent::State(state) => Some((event.t, state)),
            _ => None,
        })
        .collect();
    // each run's last state change in the log, and those of them that leave it moving with no end
    let mut last_change: HashMap<&str, usize> = HashMap::new();
    for (index, (t, state)) in state_events.iter().enumerate() {
        if *t <= to {
            last_change.insert(state.run.as_str(), index);
        }
    }
    let unended: HashSet<usize> = last_change
        .iter()
        .filter(|(run, index)| {
            is_moving(state_events[**index].1.to)
                && !input
                    .current
                    .get(**run)
                    .is_some_and(|state| is_moving(*state))
        })
        .map(|(_, index)| *index)
        .collect();

    let mut states: HashMap<&str, bool> = HashMap::new();
    let mut standstills = Vec::new();
    let mut still_since = log_start.map(|start| start.max(from));
    let mut close = |at: i64, still_since: Option<i64>| {
        if let Some(since) = still_since
            && at - since >= quiet_ms
        {
            standstills.push(Standstill {
                from: since,
                to: at,
            });
        }
    };
    let moving = |states: &HashMap<&str, bool>| states.values().any(|moving| *moving);
    for (index, &(t, state)) in state_events.iter().enumerate() {
        if t > to {
            continue;
        }
        let was_moving = moving(&states);
        let ends = unended.contains(&index);
        states.insert(state.run.as_str(), is_moving(state.to) && !ends);
        let now_moving = moving(&states);
        if t < from {
            still_since = if now_moving { None } else { Some(from) };
            continue;
        }
        if !was_moving && now_moving {
            close(t, still_since);
            still_since = None;
        } else if was_moving && !now_moving {
            still_since = Some(t);
        }
    }
    close(to, still_since);
    (standstills, unended.len() as u64)
}

/// Milliseconds since the epoch of a time as GitHub writes it (RFC 3339: `2026-11-09T01:02:03Z`);
/// `None` for anything else, as `Date.parse` gives `NaN`, so that it falls in no window.
fn parse_time(text: &str) -> Option<i64> {
    text.parse::<Timestamp>().ok().map(|at| at.as_millisecond())
}

/// `at` as the local time in `zone`, `YYYY-MM-DD HH:MM` (metrics.ts:
/// `toLocaleString("sv-SE").slice(0, 16)`, the seconds cut off).
fn clock(at: i64, zone: &TimeZone) -> String {
    match Timestamp::from_millisecond(at) {
        Ok(at) => zone.to_datetime(at).strftime("%Y-%m-%d %H:%M").to_string(),
        // past ±9999 years, which no clock of the log gives: JavaScript's invalid Date
        Err(_) => "Invalid Date".to_owned(),
    }
}

/// Whole minutes, rounded half up as `Math.round` does.
fn minutes(ms: i64) -> i64 {
    (ms as f64 / 60_000.0 + 0.5).floor() as i64
}

/// The report of `fleet report` in Markdown (metrics.ts's `render`), its times in `zone`: the
/// caller passes the server's, as Bun writes the local time.
pub fn render(project: &str, base: &str, metrics: &FactoryMetrics, zone: &TimeZone) -> String {
    let clock = |at: i64| clock(at, zone);
    let stepped_in = metrics.interventions.messages + metrics.interventions.typed_turns;
    let mut anomalies: Vec<String> = Vec::new();
    if stepped_in > 0 {
        anomalies.push(format!("The person stepped in {stepped_in} times."));
    }
    for still in &metrics.standstills {
        anomalies.push(format!(
            "Stood still {} minutes ({} to {}).",
            minutes(still.to - still.from),
            clock(still.from),
            clock(still.to)
        ));
    }
    for row in metrics.starts.iter().filter(|row| row.anomaly) {
        anomalies.push(format!(
            "{}: of {} runs, {} failed or stopped before the task and {} ended without a report.",
            agent_name(row.agent),
            row.starts,
            row.failed,
            row.lost
        ));
    }
    let standstill_total: i64 = metrics
        .standstills
        .iter()
        .map(|still| still.to - still.from)
        .sum();
    let window_note = match metrics.log_start {
        Some(start) if start > metrics.from => {
            format!(" (the event log starts {})", clock(start))
        }
        Some(_) => String::new(),
        None => " (no events for this project)".to_owned(),
    };
    let own_turns = if metrics.own_turns.is_empty() {
        "none".to_owned()
    } else {
        metrics
            .own_turns
            .iter()
            .map(|(role, count)| format!("{role} {count}"))
            .collect::<Vec<_>>()
            .join(", ")
    };

    let mut lines: Vec<String> = vec![
        format!("# Factory metrics: {project} ({base})"),
        String::new(),
        format!(
            "{} to {}{window_note}",
            clock(metrics.from),
            clock(metrics.to)
        ),
        String::new(),
        "## Anomalies".to_owned(),
        String::new(),
    ];
    if anomalies.is_empty() {
        lines.push("- None.".to_owned());
    } else {
        lines.extend(anomalies.iter().map(|line| format!("- {line}")));
    }
    lines.extend([
        String::new(),
        "## Without the person".to_owned(),
        String::new(),
        format!(
            "- The person stepped in: {} messages through the fleet, {} turns typed into the coordinator's pane",
            metrics.interventions.messages, metrics.interventions.typed_turns
        ),
        format!(
            "- Stood still: {} times, {} minutes in all; the coordinator was called {} times",
            metrics.standstills.len(),
            minutes(standstill_total),
            metrics.standstill_calls
        ),
    ]);
    if metrics.unended > 0 {
        lines.push(format!(
            "- Runs the event log leaves moving that the fleet no longer shows moving (the server stopped, or the run was removed), taken as still from their last change: {}",
            metrics.unended
        ));
    }
    lines.extend([
        format!("- Threads closed against GitHub: {}", metrics.reconciled),
        format!(
            "- Lead runs the fleet restarted on another CLI: {} ({} could not start); replacements that later reported ready: {}",
            metrics.restarts.started, metrics.restarts.failed, metrics.restarts.ready
        ),
        format!("- Turns an agent started by itself: {own_turns}"),
        String::new(),
        "## Starts per agent".to_owned(),
        String::new(),
        "| Agent | Starts | Failed or stopped before the task | Ended without a report |".to_owned(),
        "|---|---|---|---|".to_owned(),
    ]);
    if metrics.starts.is_empty() {
        lines.push("| none | 0 | 0 | 0 |".to_owned());
    }
    lines.extend(metrics.starts.iter().map(|row| {
        format!(
            "| {} | {} | {} | {}{} |",
            agent_name(row.agent),
            row.starts,
            row.failed,
            row.lost,
            if row.anomaly { " (anomaly)" } else { "" }
        )
    }));
    lines.extend([
        String::new(),
        "## Runs per role version".to_owned(),
        String::new(),
        "| Role | Version | Starts | Failed or stopped before the task | Ended without a report |"
            .to_owned(),
        "|---|---|---|---|---|".to_owned(),
    ]);
    if metrics.roles.is_empty() {
        lines.push("| none | | 0 | 0 | 0 |".to_owned());
    }
    lines.extend(metrics.roles.iter().map(|row| {
        let version = match (&row.hash, &row.source) {
            (Some(hash), Some(source)) if !hash.is_empty() => format!("{hash} ({source})"),
            _ => "not recorded".to_owned(),
        };
        format!(
            "| {} | {version} | {} | {} | {} |",
            row.role, row.starts, row.failed, row.lost
        )
    }));
    lines.extend([
        String::new(),
        "## Reports".to_owned(),
        String::new(),
        "| Agent | Turns that ended | Without a report |".to_owned(),
        "|---|---|---|".to_owned(),
    ]);
    if metrics.reports.is_empty() {
        lines.push("| none | 0 | 0 |".to_owned());
    }
    lines.extend(metrics.reports.iter().map(|row| {
        format!(
            "| {} | {} | {} |",
            agent_name(row.agent),
            row.turns,
            row.none
        )
    }));
    let merged_numbers = if metrics.merged.is_empty() {
        String::new()
    } else {
        let numbers: Vec<String> = metrics
            .merged
            .iter()
            .map(|pr| format!("#{}", pr.number))
            .collect();
        format!(" ({})", numbers.join(", "))
    };
    let found = if metrics.found.is_empty() {
        String::new()
    } else {
        let issues: Vec<String> = metrics
            .found
            .iter()
            .map(|issue| format!("#{} {}", issue.number, issue.title))
            .collect();
        format!(": {}", issues.join("; "))
    };
    let planned = metrics
        .planned
        .as_ref()
        .map(|planned| format!(" without a planned label ({planned})"))
        .unwrap_or_default();
    lines.extend([
        String::new(),
        "## Output".to_owned(),
        String::new(),
        format!(
            "- Pull requests merged: {}{merged_numbers}",
            metrics.merged.len()
        ),
        format!("- Issues closed: {}", metrics.closed.len()),
        format!("- Issues opened{planned}: {}{found}", metrics.found.len()),
    ]);
    if metrics.merged_limit_reached {
        lines.push(format!(
            "- gh listed no more than {MERGED_PULL_REQUESTS_LIMIT} merged pull requests, the newest opened: the pull requests merged may be more than counted"
        ));
    }
    if metrics.issues_limit_reached {
        lines.push(format!(
            "- gh listed no more than {ISSUES_LIMIT} issues, the newest opened: the issues closed and opened may be more than counted"
        ));
    }
    lines.push(String::new());
    lines.join("\n")
}
