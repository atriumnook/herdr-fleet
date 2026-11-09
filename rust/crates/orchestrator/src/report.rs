//! An agent's report of a turn: `report.json` beside its handoff in the run's result folder; from
//! `server/fleet/report.ts`. The fleet takes a turn's outcome from this file alone: a turn that left
//! none, or one that does not say a known state, a summary and evidence, has the outcome "no
//! report", whatever the agent's prose or screen says. A file rather than a fleet command, because
//! agy's sandbox runs no fleet command.

use std::fs::File;
use std::io::{self, Read as _};
use std::path::Path;

use protocol::{REPORT_STATES, ReportState, RunReport, TurnOutcome, js};
use serde_json::Value;

/// The file an agent writes its report of a turn to, beside its handoff in the run's result folder.
pub const REPORT_FILE: &str = "report.json";
/// A report is a few sentences: more than this is not one.
pub const REPORT_MAX_BYTES: usize = 16 * 1024;

/// The report in `dir`, read only from a regular file (never through a symlink), or why there is none.
pub fn read_report(dir: &Path) -> TurnOutcome {
    match report(dir) {
        Ok(report) => TurnOutcome::Report(report),
        Err(problem) => TurnOutcome::NoReport {
            problem: format!("{REPORT_FILE} {problem}."),
        },
    }
}

fn report(dir: &Path) -> Result<RunReport, String> {
    let text = read_text(&dir.join(REPORT_FILE))?;
    let value: Value = serde_json::from_str(&text).map_err(|_| "is not JSON")?;
    let Value::Object(fields) = value else {
        return Err("is not a JSON object".into());
    };
    let state = fields.get("state");
    let Some(state) = state.and_then(known_state) else {
        let names: Vec<&str> = REPORT_STATES
            .iter()
            .map(|state| state_name(*state))
            .collect();
        return Err(format!(
            "has state {}; it must be one of {}",
            stringify(state.unwrap_or(&Value::Null)),
            names.join(", ")
        ));
    };
    let summary = match fields.get("summary") {
        Some(Value::String(summary)) => js::trim(summary),
        _ => "",
    };
    if summary.is_empty() {
        return Err("has no summary".into());
    }
    let no_evidence = || "has no evidence: a string or a list of strings".to_owned();
    let evidence = match fields.get("evidence") {
        Some(Value::String(item)) => vec![item.clone()],
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(no_evidence)?,
        _ => return Err(no_evidence()),
    };
    let human_action = match fields.get("human_action") {
        None | Some(Value::Null) => None,
        Some(Value::String(action)) => Some(js::trim(action)).filter(|action| !action.is_empty()),
        Some(_) => return Err("has a human_action that is not a string".into()),
    };
    Ok(RunReport {
        state,
        summary: summary.to_owned(),
        evidence,
        human_action: human_action.map(str::to_owned),
    })
}

/// The file's text, at most [`REPORT_MAX_BYTES`], or why it cannot be had.
fn read_text(path: &Path) -> Result<String, String> {
    let file = open_no_follow(path).map_err(|error| {
        match error.kind() {
            io::ErrorKind::NotFound => "is missing",
            _ if is_symlink_loop(&error) => "is not a regular file",
            _ => "cannot be read",
        }
        .to_owned()
    })?;
    match file.metadata() {
        Ok(meta) if meta.is_file() => {}
        Ok(_) => return Err("is not a regular file".into()),
        Err(_) => return Err("cannot be read".into()),
    }
    let mut bytes = Vec::with_capacity(REPORT_MAX_BYTES + 1);
    // one byte past the limit tells a file of exactly the limit from a larger one
    let limit = u64::try_from(REPORT_MAX_BYTES + 1).unwrap_or(u64::MAX);
    file.take(limit)
        .read_to_end(&mut bytes)
        .map_err(|_| "cannot be read")?;
    if bytes.len() > REPORT_MAX_BYTES {
        return Err(format!("is larger than {REPORT_MAX_BYTES} bytes"));
    }
    // Buffer's toString("utf8") puts U+FFFD for each byte that is not UTF-8, as this does
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn known_state(value: &Value) -> Option<ReportState> {
    let name = value.as_str()?;
    REPORT_STATES
        .iter()
        .copied()
        .find(|state| state_name(*state) == name)
}

fn state_name(state: ReportState) -> &'static str {
    match state {
        ReportState::Progress => "progress",
        ReportState::Waiting => "waiting",
        ReportState::Ready => "ready",
        ReportState::Blocked => "blocked",
        ReportState::Failed => "failed",
        ReportState::Dropped => "dropped",
    }
}

/// `JSON.stringify(value)` of a state that is not one: a number as JavaScript writes it (`1e+21`),
/// anything else as compact JSON.
fn stringify(value: &Value) -> String {
    match value {
        Value::Number(number) => js::number_to_string(number.as_f64().unwrap_or(0.0)),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

// `O_NOFOLLOW` and `O_NONBLOCK` of the targets the plan builds for, as their C libraries define
// them: std exports neither, and this crate depends on no libc binding. libc 0.2.191:
// src/unix/linux_like/linux/gnu/b64/x86_64/mod.rs:448 and :294, aarch64/mod.rs:359 and :206,
// src/unix/bsd/mod.rs:276 and :275 (Apple's targets among them). `ELOOP`: x86_64/mod.rs:311,
// aarch64/mod.rs:228, src/unix/bsd/apple/mod.rs:2577.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const O_NOFOLLOW: i32 = 0x20000;
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const O_NOFOLLOW: i32 = 0x8000;
#[cfg(target_vendor = "apple")]
const O_NOFOLLOW: i32 = 0x100;
#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
const O_NONBLOCK: i32 = 0o4000;
#[cfg(target_vendor = "apple")]
const O_NONBLOCK: i32 = 0x4;
#[cfg(target_os = "linux")]
const ELOOP: i32 = 40;
#[cfg(target_vendor = "apple")]
const ELOOP: i32 = 62;
#[cfg(all(
    unix,
    not(any(
        all(
            target_os = "linux",
            any(target_arch = "x86_64", target_arch = "aarch64")
        ),
        target_vendor = "apple",
    ))
))]
compile_error!(
    "add this target's O_NOFOLLOW, O_NONBLOCK and ELOOP, taken from libc, to orchestrator's src/report.rs"
);

/// `path` opened for reading, as report.ts opens it: a symlink in the last place fails with
/// `ELOOP`, and a FIFO opens without waiting for a writer (the `fstat` then turns it down).
#[cfg(unix)]
fn open_no_follow(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt as _;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(O_NOFOLLOW | O_NONBLOCK)
        .open(path)
}

#[cfg(unix)]
fn is_symlink_loop(error: &io::Error) -> bool {
    error.raw_os_error() == Some(ELOOP)
}

/// Off unix there is no `O_NOFOLLOW`: a symlink is turned down before the file is opened.
#[cfg(not(unix))]
fn open_no_follow(path: &Path) -> io::Result<File> {
    if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(io::Error::other(SymlinkRefused));
    }
    File::open(path)
}

#[cfg(not(unix))]
#[derive(Debug)]
struct SymlinkRefused;

#[cfg(not(unix))]
impl std::fmt::Display for SymlinkRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("report.json is a symlink")
    }
}

#[cfg(not(unix))]
impl std::error::Error for SymlinkRefused {}

#[cfg(not(unix))]
fn is_symlink_loop(error: &io::Error) -> bool {
    error
        .get_ref()
        .is_some_and(|inner| inner.is::<SymlinkRefused>())
}
