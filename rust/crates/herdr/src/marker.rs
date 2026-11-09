//! herdr's Windows socket marker (`server/herdr-marker.ts`).
//!
//! On Windows herdr.sock is a marker file `pid:start` that a killed daemon leaves behind;
//! `start` is the daemon's start as Unix nanoseconds (live-verified, herdr 0.9.3:
//! `26540:1790829888292852700`, 56 ms after the process's creation time). The pid alone
//! does not say whether the daemon is there: Windows hands a dead process's pid to the next
//! one, so after a reboot another program, or another session's herdr, can hold it.
//!
//! The functions are pure and compiled on every platform, so that their tests run on Linux.

/// The daemon a marker names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkerOwner {
    pub pid: u32,
    /// The daemon's start in Unix milliseconds; `None` when the marker has no readable start.
    pub started_ms: Option<i64>,
}

/// A running process, as the probe prints it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningProcess {
    pub name: String,
    /// The process's creation time in Unix milliseconds, when known.
    pub started_ms: Option<i64>,
}

/// How far the marker's start may sit from the process's creation time and still be the same
/// daemon.
pub const MARKER_START_SLACK_MS: i64 = 30_000;

/// The pid and the start out of a marker; `None` when the pid is not a positive integer.
///
/// The pid is read as JavaScript's `Number` reads it, within a Windows pid (`u32`). The start
/// counts only when it is all digits and at least 16 of them (nanoseconds since 1970).
pub fn marker_owner(marker: &str) -> Option<MarkerOwner> {
    let mut parts = marker.trim().split(':');
    let pid = js_positive_integer(parts.next().unwrap_or(""))?;
    let started_ms = parts.next().and_then(|start| {
        if start.len() < 16 || !start.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let nanos: u128 = start.parse().ok()?;
        i64::try_from(nanos / 1_000_000).ok()
    });
    Some(MarkerOwner { pid, started_ms })
}

/// `Number(text)` that is an integer of at least 1, as a `u32`.
fn js_positive_integer(text: &str) -> Option<u32> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let value: f64 = text.parse().ok()?;
    if !value.is_finite() || value.fract() != 0.0 || value < 1.0 || value > f64::from(u32::MAX) {
        return None;
    }
    Some(value as u32)
}

/// `name|unixMs`, as the probe in `remote-entry.ts` prints a running process; `None` for a pid
/// nobody has (an empty answer).
///
/// The first line that is a name, `|`, digits and nothing but whitespace after them counts, as
/// the TypeScript `/^([^|\r\n]+)\|(\d+)\s*$/m` reads it.
pub fn parse_process_line(output: &str) -> Option<RunningProcess> {
    // JavaScript's `^` and `$` under the `m` flag stand at each of these line terminators
    output
        .split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .find_map(|line| {
            let (name, rest) = line.split_once('|')?;
            if name.is_empty() {
                return None;
            }
            let digits = rest.trim_end();
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            Some(RunningProcess {
                name: name.trim().to_owned(),
                started_ms: digits.parse().ok(),
            })
        })
}

/// A marker nobody stands behind: its pid is gone, belongs to a program that is not herdr, or
/// to a herdr that started at another time (a later daemon, or another session's). A marker that
/// cannot be read is not called stale: replacing a daemon needs proof it is gone.
pub fn stale_marker(marker: &str, process_of: impl Fn(u32) -> Option<RunningProcess>) -> bool {
    let Some(owner) = marker_owner(marker) else {
        return false;
    };
    let Some(running) = process_of(owner.pid) else {
        return true;
    };
    if !is_herdr(&running.name) {
        return true;
    }
    match (owner.started_ms, running.started_ms) {
        (Some(marker_start), Some(process_start)) => {
            (marker_start - process_start).abs() > MARKER_START_SLACK_MS
        }
        _ => false,
    }
}

/// `/^herdr(\.exe)?$/i`
fn is_herdr(name: &str) -> bool {
    name.eq_ignore_ascii_case("herdr") || name.eq_ignore_ascii_case("herdr.exe")
}
