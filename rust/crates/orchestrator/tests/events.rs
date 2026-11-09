//! The fleet's event log (`server/fleet/events.ts`). TypeScript has no test of its own for it; the
//! expected lines are what `eventLog` wrote under bun 1.4.4 with `Date.now()` returning
//! 1793491200000, except where #176's item 8 says the Rust version differs: no screen text goes in,
//! and the log has a size limit.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};

use herdr_fleet_orchestrator::Clock;
use herdr_fleet_orchestrator::events::{
    EVENTS_MAX_BYTES, EventLog, FleetEvent, RestartEvent, RestartWhy, StateEvent, TimedEvent,
    TurnReport, rotated_path,
};
use protocol::{AgentState, FleetAgentKind, ReportState};

/// A folder of its own under the system's temporary folder, removed when dropped.
struct Folder(PathBuf);

impl Folder {
    fn new() -> Folder {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "fleet-events-{}-{}",
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

/// A clock that reads what the test set.
struct TestClock(AtomicI64);

impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::Relaxed)
    }
}

const NOW: i64 = 1_793_491_200_000;

fn log(file: &Path) -> EventLog {
    EventLog::new(file, Arc::new(TestClock(AtomicI64::new(NOW))))
}

/// The lines `eventLog` wrote (see the module's comment), in the order written.
const TYPESCRIPT_LINES: [&str; 8] = [
    r#"{"t":1793491200000,"kind":"state","run":"1a2b3c4d","role":"lead","agent":"claude","model":"opus","group":"fleet-6fcaf0a1","project":"/repo","interactive":true,"from":"starting","to":"blocked","sent":false,"error":"Agent stopped at a question before its first prompt; the task has not been sent."}"#,
    r#"{"t":1793491200000,"kind":"state","run":"1a2b3c4d","role":"lead","agent":"claude","group":"fleet-6fcaf0a1","interactive":true,"to":"starting","sent":false}"#,
    r#"{"t":1793491200000,"kind":"turn","run":"1a2b3c4d","role":"lead","agent":"claude","group":"fleet-6fcaf0a1","project":"/repo","interactive":true,"handoff":true,"report":"none"}"#,
    r#"{"t":1793491200000,"kind":"role","run":"1a2b3c4d","role":"lead","source":"project","file":"/repo/.herdr-fleet/agents/lead.md","hash":"0123456789ab","standing":"ba9876543210"}"#,
    r#"{"t":1793491200000,"kind":"person","run":"c0ffee00","project":"/repo"}"#,
    r#"{"t":1793491200000,"kind":"standstill","run":"c0ffee00","project":"/repo","quietMs":900000}"#,
    r#"{"t":1793491200000,"kind":"reconciled","run":"1a2b3c4d","project":"/repo","pr":276}"#,
    r#"{"t":1793491200000,"kind":"restart","run":"1a2b3c4d","project":"/repo","agent":"claude","why":"no-report","by":"5e6f7a8b","to":"codex"}"#,
];

fn events_of(lines: &[&str]) -> Vec<FleetEvent> {
    lines
        .iter()
        .map(|line| serde_json::from_str::<TimedEvent>(line).unwrap().event)
        .collect()
}

fn lines(file: &Path) -> Vec<String> {
    fs::read_to_string(file)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect()
}

fn state(to: AgentState, error: Option<&str>) -> FleetEvent {
    FleetEvent::State(StateEvent {
        run: "1a2b3c4d".into(),
        role: "lead".into(),
        agent: FleetAgentKind::Claude,
        model: None,
        group: "fleet-6fcaf0a1".into(),
        project: None,
        interactive: Some(true),
        from: Some(AgentState::Starting),
        to,
        sent: false,
        error: error.map(str::to_owned),
    })
}

fn error_of(line: &str) -> Option<String> {
    match serde_json::from_str::<TimedEvent>(line).unwrap().event {
        FleetEvent::State(event) => event.error,
        FleetEvent::Restart(event) => event.error,
        other => panic!("{other:?}"),
    }
}

#[test]
fn reads_the_lines_typescript_wrote_and_writes_them_back_alike() {
    for line in TYPESCRIPT_LINES {
        let event: TimedEvent = serde_json::from_str(line).unwrap();
        assert_eq!(serde_json::to_string(&event).unwrap(), line);
    }
}

#[test]
fn appends_one_line_per_event_in_the_shape_typescript_writes() {
    let root = Folder::new();
    let file = root.path().join("state").join("fleet-events.jsonl");
    let events = log(&file);
    for event in events_of(&TYPESCRIPT_LINES) {
        events.record(event);
    }
    // the first event's error is the fleet's own sentence about a task not sent (#176's item 8)
    let first = TYPESCRIPT_LINES[0].replace(
        "Agent stopped at a question before its first prompt; the task has not been sent.",
        "The task has not been sent.",
    );
    let mut expected = vec![first];
    expected.extend(TYPESCRIPT_LINES[1..].iter().map(|line| (*line).to_owned()));
    assert_eq!(lines(&file), expected);
    assert!(fs::read_to_string(&file).unwrap().ends_with("}\n"));
}

#[cfg(unix)]
#[test]
fn creates_its_folder_and_file_private_to_the_user() {
    use std::os::unix::fs::PermissionsExt as _;
    let root = Folder::new();
    let file = root.path().join("state").join("fleet-events.jsonl");
    log(&file).record(state(AgentState::Working, None));
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&root.path().join("state")), 0o700);
    assert_eq!(mode(&file), 0o600);
}

#[test]
fn reads_each_events_time_from_the_clock() {
    let root = Folder::new();
    let file = root.path().join("fleet-events.jsonl");
    let clock = Arc::new(TestClock(AtomicI64::new(NOW)));
    let events = EventLog::new(&file, clock.clone());
    events.record(state(AgentState::Working, None));
    clock.0.store(NOW + 60_000, Ordering::Relaxed);
    events.record(state(AgentState::Idle, None));
    let times: Vec<i64> = lines(&file)
        .iter()
        .map(|line| serde_json::from_str::<TimedEvent>(line).unwrap().t)
        .collect();
    assert_eq!(times, [NOW, NOW + 60_000]);
}

// #176's item 8: a run's last error can quote its screen (a CLI's `Error:` line, a setup command's
// output); the log keeps none of it. A start that stopped before its task was sent keeps the one
// sentence the factory's metrics count it by (server/fleet/metrics.ts: /not been sent|not ready/).
#[test]
fn keeps_screen_text_out_of_a_state_events_error() {
    let root = Folder::new();
    let file = root.path().join("fleet-events.jsonl");
    let events = log(&file);
    // orchestrator.ts:581, :590 and :598: the fleet's sentences for a start that stopped before its task
    events.record(state(
        AgentState::Blocked,
        Some("Agent stopped at a question before its first prompt; the task has not been sent."),
    ));
    events.record(state(
        AgentState::Blocked,
        Some("Cursor asks whether to trust this folder. The task has not been sent."),
    ));
    events.record(state(
        AgentState::Unknown,
        Some("Agent started but is not ready for prompts; the task has not been sent."),
    ));
    // adapters.ts startupError and turnError: lines of the agent's screen
    events.record(state(
        AgentState::Failed,
        Some("401 {\"type\":\"error\",\"message\":\"token sk-… expired\"}"),
    ));
    // orchestrator.ts:648: a setup command's output
    events.record(state(
        AgentState::Failed,
        Some("The setup command `bun install` failed in /repo:\nerror: lockfile had changes"),
    ));
    let errors: Vec<Option<String>> = lines(&file).iter().map(|line| error_of(line)).collect();
    let not_sent = Some("The task has not been sent.".to_owned());
    assert_eq!(
        errors,
        [not_sent.clone(), not_sent.clone(), not_sent, None, None]
    );
}

// #176's item 8: why a thread could not start again is a spawn's error, which can quote a screen
// (`agent_start_failed` carries the CLI's `Error:` line); the log says only that it could not.
#[test]
fn keeps_screen_text_out_of_a_restart_events_error() {
    let root = Folder::new();
    let file = root.path().join("fleet-events.jsonl");
    let events = log(&file);
    let restart = |by: Option<&str>, error: Option<&str>| {
        FleetEvent::Restart(RestartEvent {
            run: "l1".into(),
            project: "/repo".into(),
            agent: FleetAgentKind::Claude,
            why: RestartWhy::Failed,
            by: by.map(str::to_owned),
            to: by.map(|_| FleetAgentKind::Codex),
            error: error.map(str::to_owned),
        })
    };
    events.record(restart(
        None,
        Some("Error: invalid API key · Please run /login"),
    ));
    events.record(restart(Some("l2"), None));
    let errors: Vec<Option<String>> = lines(&file).iter().map(|line| error_of(line)).collect();
    assert_eq!(
        errors,
        [Some("No replacement could start.".to_owned()), None]
    );
}

// #176's item 8: the log has a size limit. A line that would take the file past it moves the file
// to `<file>.1`, in place of an older one, and starts the file again: the two hold at most twice
// the limit.
#[test]
fn starts_again_past_its_size_limit_keeping_the_one_before() {
    let root = Folder::new();
    let file = root.path().join("fleet-events.jsonl");
    assert_eq!(
        rotated_path(&file),
        root.path().join("fleet-events.jsonl.1")
    );
    let limit = usize::try_from(EVENTS_MAX_BYTES).unwrap();
    // 8 MiB, worked out by hand: 8 × 1,048,576
    assert_eq!(limit, 8_388_608);
    let events = log(&file);
    // a file one byte short of the limit takes no line more
    fs::write(&file, "x".repeat(limit - 1)).unwrap();
    fs::write(rotated_path(&file), "older").unwrap();
    events.record(state(AgentState::Working, None));
    assert_eq!(
        fs::metadata(rotated_path(&file)).unwrap().len(),
        EVENTS_MAX_BYTES - 1
    );
    assert_eq!(lines(&file).len(), 1);
    // a file with room for the line keeps it
    let before = fs::metadata(&file).unwrap().len();
    events.record(state(AgentState::Idle, None));
    assert_eq!(lines(&file).len(), 2);
    assert!(fs::metadata(&file).unwrap().len() > before);
    assert_eq!(
        fs::metadata(rotated_path(&file)).unwrap().len(),
        EVENTS_MAX_BYTES - 1
    );
}

#[test]
fn takes_a_line_that_ends_exactly_at_its_size_limit() {
    let root = Folder::new();
    let file = root.path().join("fleet-events.jsonl");
    let events = log(&file);
    events.record(state(AgentState::Working, None));
    let line = fs::read_to_string(&file).unwrap();
    let limit = usize::try_from(EVENTS_MAX_BYTES).unwrap();
    fs::write(&file, "x".repeat(limit - line.len())).unwrap();
    events.record(state(AgentState::Working, None));
    assert_eq!(fs::metadata(&file).unwrap().len(), EVENTS_MAX_BYTES);
    assert!(!rotated_path(&file).exists());
}

// #249's size bound still applies when rotation fails. Like any failed write, the event is lost;
// after the storage problem is removed, new events can be recorded again.
#[test]
fn keeps_the_size_bound_when_rotation_fails_and_recovers_afterwards() {
    let root = Folder::new();
    let file = root.path().join("fleet-events.jsonl");
    let events = log(&file);
    let before = "x".repeat(8_388_607);
    fs::write(&file, &before).unwrap();
    fs::create_dir(rotated_path(&file)).unwrap();
    events.record(state(AgentState::Working, None));
    assert_eq!(fs::read(&file).unwrap(), before.as_bytes());
    fs::remove_dir(rotated_path(&file)).unwrap();
    events.record(state(AgentState::Idle, None));
    assert_eq!(lines(&file).len(), 1);
    assert_eq!(fs::metadata(rotated_path(&file)).unwrap().len(), 8_388_607);
}

// #249 / #176 item 8 requires a size bound even when one event is larger than the whole log.
// Dropping that event must not replace either file's previously recorded events.
#[test]
fn drops_a_single_event_larger_than_the_size_limit() {
    let root = Folder::new();
    let file = root.path().join("fleet-events.jsonl");
    let events = log(&file);
    let mut oversized = state(AgentState::Working, None);
    if let FleetEvent::State(event) = &mut oversized {
        event.project = Some("x".repeat(8_388_608));
    }
    // An oversized first event must not create an oversized file either.
    events.record(oversized.clone());
    assert!(!file.exists() || fs::metadata(&file).unwrap().len() <= 8_388_608);
    events.record(state(AgentState::Working, None));
    let before = fs::read(&file).unwrap();
    fs::write(rotated_path(&file), "older\n").unwrap();
    events.record(oversized);
    assert_eq!(fs::read(&file).unwrap(), before);
    assert_eq!(fs::read(rotated_path(&file)).unwrap(), b"older\n");
    events.record(state(AgentState::Idle, None));
    assert_eq!(lines(&file).len(), 2);
}

#[test]
fn loses_the_event_but_never_fails_when_it_cannot_write() {
    let root = Folder::new();
    fs::write(root.path().join("not-a-folder"), "").unwrap();
    let file = root.path().join("not-a-folder").join("fleet-events.jsonl");
    let events = log(&file);
    events.record(state(AgentState::Working, None));
    events.record(state(AgentState::Idle, None));
    assert!(!file.exists());
}

#[test]
fn says_a_turns_report_state_or_none() {
    assert_eq!(
        TurnReport::from(Some(ReportState::Ready)),
        TurnReport::Ready
    );
    assert_eq!(
        TurnReport::from(Some(ReportState::Waiting)),
        TurnReport::Waiting
    );
    assert_eq!(TurnReport::from(None), TurnReport::None);
}
