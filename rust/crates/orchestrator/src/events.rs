//! What happened in the fleet, one JSON object per line, appended: the raw data the factory's
//! metrics are computed from (`server/fleet/metrics.ts`, `scripts/factory-report.ts`); from
//! `server/fleet/events.ts`. The run registry keeps each run's last state only; this keeps every
//! change, so how long a project stood still, how often the person stepped in and how often an
//! agent failed to start can be counted afterwards.
//!
//! No message text, handoff or screen goes in: only ids, roles, agents, models, states and times.
//! Unlike events.ts, this holds to that for errors too (#176's item 8): a run's last error can quote
//! its screen (a CLI's `Error:` line) or a setup command's output, so [`EventLog::record`] writes a
//! state event's `error` only as the fleet's one sentence for a start that stopped before its task
//! was sent (what the metrics count it by), and a restart event's only as the fleet's sentence that
//! no replacement could start. And unlike events.ts, the log has a size limit (#176's item 8): a
//! line that would take the file past [`EVENTS_MAX_BYTES`] first moves the file to
//! [`rotated_path`], in place of the one before, so the two hold at most twice the limit.

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use protocol::{AgentState, FleetAgentKind, ReportState};
use serde::{Deserialize, Serialize};

use crate::Clock;
use crate::registry::create_private_folder;

/// The size the event log grows to before it moves to [`rotated_path`] and starts again. An event
/// is about 250 bytes, so the file holds some 30,000 of them.
pub const EVENTS_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// The error a state event keeps for a start that stopped before its task was sent: the words the
/// factory's metrics count such a start by (metrics.ts: `/not been sent|not ready/`).
pub const TASK_NOT_SENT: &str = "The task has not been sent.";

/// The error a restart event keeps when no replacement could start.
pub const NO_REPLACEMENT: &str = "No replacement could start.";

/// What happened in the fleet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FleetEvent {
    State(StateEvent),
    Turn(TurnEvent),
    Role(RoleEvent),
    Person(PersonEvent),
    Standstill(StandstillEvent),
    Reconciled(ReconciledEvent),
    Restart(RestartEvent),
}

/// A run's state changed. `from` is absent for a new run; `sent` says whether a turn the fleet sent
/// is open; `interactive`, whether the run talks in its pane (absent in events written before it
/// was); `error`, see the module's comment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateEvent {
    pub run: String,
    pub role: String,
    pub agent: FleetAgentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub group: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interactive: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<AgentState>,
    pub to: AgentState,
    pub sent: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A run's turn ended and the fleet read what it left: `handoff`, whether its result file holds a
/// HANDOFF; `report`, the state its report.json gave, or `none` without a valid one (absent for a
/// run that keeps no result folder, and in events written before reports).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnEvent {
    pub run: String,
    pub role: String,
    pub agent: FleetAgentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub group: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub interactive: bool,
    pub handoff: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<TurnReport>,
}

/// The state a turn's report.json gave, or none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnReport {
    Progress,
    Waiting,
    Ready,
    Blocked,
    Failed,
    Dropped,
    None,
}

impl From<Option<ReportState>> for TurnReport {
    /// The report's state, or `none` for a turn without a valid report.
    fn from(state: Option<ReportState>) -> Self {
        match state {
            Some(ReportState::Progress) => TurnReport::Progress,
            Some(ReportState::Waiting) => TurnReport::Waiting,
            Some(ReportState::Ready) => TurnReport::Ready,
            Some(ReportState::Blocked) => TurnReport::Blocked,
            Some(ReportState::Failed) => TurnReport::Failed,
            Some(ReportState::Dropped) => TurnReport::Dropped,
            None => TurnReport::None,
        }
    }
}

/// The role a run started with: its file, where that came from (`bundled`, `user`, `project`), the
/// file's version (its hash), and the version of the standing orders it was given, absent when
/// there were none; `fleet report` compares runs per role version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleEvent {
    pub run: String,
    pub role: String,
    pub source: String,
    pub file: String,
    pub hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub standing: Option<String>,
}

/// The person wrote to a project's coordinator through the fleet (`fleet project`, the Fleet screen).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonEvent {
    pub run: String,
    pub project: String,
}

/// A project run without the person stood still and its coordinator was told.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StandstillEvent {
    pub run: String,
    pub project: String,
    pub quiet_ms: i64,
}

/// A thread the fleet closed because GitHub showed its pull request merged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReconciledEvent {
    pub run: String,
    pub project: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<u64>,
}

/// A thread's lead run failed, or ended a turn without a report, and the fleet started the thread
/// again: `by` the new run on CLI `to`, or `error` when none could start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestartEvent {
    pub run: String,
    pub project: String,
    pub agent: FleetAgentKind,
    pub why: RestartWhy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<FleetAgentKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Why a thread's lead was started again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RestartWhy {
    Failed,
    NoReport,
}

/// An event and when it happened (epoch milliseconds).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimedEvent {
    pub t: i64,
    #[serde(flatten)]
    pub event: FleetEvent,
}

/// The file the event log moves to when it reaches [`EVENTS_MAX_BYTES`]: `<file>.1`. Who reads the
/// log reads this file first, then the log.
pub fn rotated_path(file: &Path) -> PathBuf {
    let mut rotated = file.as_os_str().to_owned();
    rotated.push(".1");
    PathBuf::from(rotated)
}

/// Appends events to a file, creating it private to the user (see the module's comment).
pub struct EventLog {
    file: PathBuf,
    clock: Arc<dyn Clock>,
    /// whether the file's folder was made; held while a line is written, so that two lines and a
    /// move of the file do not interleave
    ready: Mutex<bool>,
}

impl EventLog {
    pub fn new(file: impl Into<PathBuf>, clock: Arc<dyn Clock>) -> Self {
        EventLog {
            file: file.into(),
            clock,
            ready: Mutex::new(false),
        }
    }

    /// The file events are appended to.
    pub fn file(&self) -> &Path {
        &self.file
    }

    /// Appends `event`, at the clock's time, with no screen text in it. A failed write loses the
    /// event, never the fleet's work: the metrics miss one event, and the run itself goes on.
    pub fn record(&self, event: FleetEvent) {
        let timed = TimedEvent {
            t: self.clock.now_ms(),
            event: without_screen_text(event),
        };
        let Ok(mut line) = serde_json::to_string(&timed) else {
            return;
        };
        line.push('\n');
        let mut ready = self.ready.lock().unwrap_or_else(PoisonError::into_inner);
        if !*ready {
            let Some(folder) = self.file.parent() else {
                return;
            };
            if create_private_folder(folder).is_err() {
                return;
            }
            *ready = true;
        }
        let _ = self.append(line.as_bytes());
    }

    fn append(&self, line: &[u8]) -> std::io::Result<()> {
        let length = u64::try_from(line.len()).unwrap_or(u64::MAX);
        // A single event must fit too. Drop it before rotating so it cannot discard older events.
        if length > EVENTS_MAX_BYTES {
            return Ok(());
        }
        let size = match fs::metadata(&self.file) {
            Ok(meta) => meta.len(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(error) => return Err(error),
        };
        if size > 0 && size.saturating_add(length) > EVENTS_MAX_BYTES {
            fs::rename(&self.file, rotated_path(&self.file))?;
        }
        let mut options = OpenOptions::new();
        options.append(true).create(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options.open(&self.file)?.write_all(line)
    }
}

/// `event` as the log keeps it: a state event's error only as [`TASK_NOT_SENT`], for the fleet's own
/// sentences about a start that stopped before its task (orchestrator.ts: "…; the task has not been
/// sent.", "Agent started but is not ready for prompts; …"), and a restart event's only as
/// [`NO_REPLACEMENT`].
fn without_screen_text(event: FleetEvent) -> FleetEvent {
    match event {
        FleetEvent::State(mut state) => {
            state.error = state
                .error
                .filter(|error| error.contains("not been sent") || error.contains("not ready"))
                .map(|_| TASK_NOT_SENT.to_owned());
            FleetEvent::State(state)
        }
        FleetEvent::Restart(mut restart) => {
            restart.error = restart.error.map(|_| NO_REPLACEMENT.to_owned());
            FleetEvent::Restart(restart)
        }
        other => other,
    }
}
