//! The rollouts a paginated Codex rollout continues (`historyChain`, `codexHistorySegments` of
//! `server/codex.ts`). Paginated rollouts (Codex 0.156) do not copy history: a backtrack or fork
//! starts a new file whose `session_meta.history_base` names what it continues by thread, ordinal
//! and byte: the same thread before a backtrack, the parent after a fork. The bytes past that cut
//! are the turns the backtrack discarded. A thread can have several rollouts (one per backtrack)
//! and a later backtrack can cut into any of them, so the one that continues is the one that
//! holds the cut, never guessed from names or sizes. A chain that stops at a cut no file holds
//! shows less history rather than the wrong one, and is looked up again a while later.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::Value;

use super::parser::{string, truthy};
use crate::format::Segment;
use crate::paging::file_stat;
use crate::records::{Row, parse_line, record};

static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").expect("UUID")
});

/// How much of a rollout's start holds its header line.
const HEADER_BYTES: u64 = 256 * 1024;
/// A chain that stops at a cut no file holds yet is looked up afresh after this.
const INCOMPLETE_CHAIN: Duration = Duration::from_secs(30);
/// How far a chain is followed.
const MAX_DEPTH: usize = 32;
const REMEMBERED_CHAINS: usize = 64;
const REMEMBERED_LINE_COUNTS: usize = 256;

/// A rollout before the live one, with how many of its bytes belong to the conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Link {
    path: PathBuf,
    end: u64,
}

struct Remembered {
    /// newest first
    chain: Vec<Link>,
    complete: bool,
    at: Instant,
}

/// The chains found and the lines counted before cuts, kept between reads. A header never
/// changes, so a complete chain is kept for good; an incomplete one a short while, so every append
/// does not walk `sessions/` again. The bytes before a cut never change either.
pub(super) struct Chains {
    /// by rollout, the least recently found first
    chains: Mutex<Vec<(PathBuf, Remembered)>>,
    /// by file (its device and inode) and cut, the least recently counted first
    line_counts: Mutex<Vec<((String, u64), u64)>>,
}

/// Puts `value` last under `key`, dropping the oldest past `limit` (TypeScript's delete + set on
/// a `Map`).
fn remember<K: PartialEq, V>(entries: &mut Vec<(K, V)>, key: K, value: V, limit: usize) {
    entries.retain(|(known, _)| *known != key);
    entries.push((key, value));
    if entries.len() > limit {
        entries.remove(0);
    }
}

/// The `session_meta` payload on a rollout's first line; `Ok(None)` when the file is not a rollout,
/// `Err` when its first line cannot be read as JSON.
fn rollout_header(path: &Path) -> Result<Option<Row>, ()> {
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|file| file.take(HEADER_BYTES).read_to_end(&mut bytes))
        .map_err(|_| ())?;
    let text = String::from_utf8_lossy(&bytes);
    let header = parse_line(text.split('\n').next().unwrap_or("")).ok_or(())?;
    let header = record(Some(&header));
    Ok((string(header, "type") == "session_meta").then(|| record(header.get("payload")).clone()))
}

/// A number that `Number.isSafeInteger` accepts.
fn safe_integer(value: Option<&Value>) -> Option<i64> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && number.abs() <= MAX_SAFE).then_some(number as i64)
}

/// A rollout's first ordinal: where the history it continues ends, 0 for a whole history.
fn first_ordinal(header: &Row) -> i64 {
    safe_integer(record(header.get("history_base")).get("end_ordinal_exclusive"))
        .filter(|ordinal| *ordinal > 0)
        .unwrap_or(0)
}

/// A rollout of `home`'s sessions that is a user's conversation, by its canonical path
/// (`codexRolloutPath`): file access is constrained by canonical paths, including symlink
/// targets. A child Codex's rollout is not the conversation of the parent TUI.
fn rollout_path(path: &Path, home: &Path) -> Option<PathBuf> {
    let canonical = fs::canonicalize(path).ok()?;
    let sessions = fs::canonicalize(home.join("sessions")).ok()?;
    if canonical == sessions
        || !canonical.starts_with(&sessions)
        || !canonical
            .as_os_str()
            .as_encoded_bytes()
            .ends_with(b".jsonl")
        || !fs::metadata(&canonical).ok()?.is_file()
    {
        return None;
    }
    let meta = rollout_header(&canonical).ok()??;
    let truthy = |field: &str| truthy(meta.get(field));
    let source = meta.get("source");
    if (truthy("source") && !source.is_some_and(Value::is_string))
        || source.and_then(Value::as_str) == Some("subagent")
        || (truthy("thread_source")
            && meta.get("thread_source").and_then(Value::as_str) != Some("user"))
        || truthy("agent_role")
    {
        return None;
    }
    Some(canonical)
}

/// The names in a folder, or none when it cannot be read.
fn names(path: &Path) -> Vec<String> {
    fs::read_dir(path)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// Every rollout of a thread: rollout-<time>-<thread>.jsonl and its
/// rollout-<time>-<thread>_<segment>.jsonl.
fn thread_rollouts(home: &Path, thread: &str) -> Vec<PathBuf> {
    let sessions = home.join("sessions");
    let (whole, segment) = (format!("-{thread}.jsonl"), format!("-{thread}_"));
    let mut found = Vec::new();
    for year in names(&sessions) {
        let year = sessions.join(year);
        for month in names(&year) {
            let month = year.join(month);
            for day in names(&month) {
                let day = month.join(day);
                found.extend(
                    names(&day)
                        .into_iter()
                        .filter(|name| name.ends_with(&whole) || name.contains(&segment))
                        .map(|name| day.join(name)),
                );
            }
        }
    }
    found
}

impl Chains {
    pub(super) const fn new() -> Self {
        Self {
            chains: Mutex::new(Vec::new()),
            line_counts: Mutex::new(Vec::new()),
        }
    }

    /// The lines of a file before byte `end`.
    fn count_lines(&self, path: &Path, end: u64) -> Option<u64> {
        let key = (file_stat(&fs::metadata(path).ok()?).node, end);
        let known = self
            .line_counts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .find(|(counted, _)| *counted == key)
            .map(|(_, lines)| *lines);
        if let Some(lines) = known {
            return Some(lines);
        }
        let mut file = File::open(path).ok()?.take(end);
        let mut buffer = vec![0; 1024 * 1024];
        let mut lines = 0;
        loop {
            let length = file.read(&mut buffer).ok()?;
            if length == 0 {
                break;
            }
            lines += buffer[..length]
                .iter()
                .filter(|byte| **byte == b'\n')
                .count() as u64;
        }
        let mut counts = self
            .line_counts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        remember(&mut counts, key, lines, REMEMBERED_LINE_COUNTS);
        Some(lines)
    }

    /// Does `path` hold a cut at (ordinal, byte)? Every record is one line and a rollout's
    /// ordinals start at its own first ordinal, so the cut must end a line with exactly
    /// `ordinal - first` lines before it (checked on a three-rollout Codex 0.156 chain against
    /// the turn offsets in its thread_history_1.sqlite).
    fn holds_cut(&self, path: &Path, ordinal: i64, end: u64) -> bool {
        let Ok(Some(header)) = rollout_header(path) else {
            return false;
        };
        let lines = ordinal - first_ordinal(&header);
        if lines <= 0 || fs::metadata(path).map_or(0, |meta| meta.len()) < end {
            return false;
        }
        let mut last = [0];
        let ends_a_line = File::open(path)
            .and_then(|mut file| {
                file.seek(SeekFrom::Start(end - 1))?;
                file.read_exact(&mut last)
            })
            .is_ok_and(|()| last[0] == b'\n');
        ends_a_line && self.count_lines(path, end) == Some(lines as u64)
    }

    /// The rollouts `path` continues, newest first (`historyChain`).
    fn history_chain(&self, path: &Path, home: &Path) -> Vec<Link> {
        {
            let chains = self
                .chains
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some((_, known)) = chains.iter().find(|(rollout, _)| rollout == path)
                && (known.complete || known.at.elapsed() < INCOMPLETE_CHAIN)
            {
                return known.chain.clone();
            }
        }
        let (chain, complete) = self.walk(path, home);
        let mut chains = self
            .chains
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        remember(
            &mut chains,
            path.to_path_buf(),
            Remembered {
                chain: chain.clone(),
                complete,
                at: Instant::now(),
            },
            REMEMBERED_CHAINS,
        );
        chain
    }

    /// Follows the cuts from `path`: the chain, and whether it reached a whole history.
    fn walk(&self, path: &Path, home: &Path) -> (Vec<Link>, bool) {
        let mut chain: Vec<Link> = Vec::new();
        let mut current = path.to_path_buf();
        for _ in 0..MAX_DEPTH {
            let Ok(header) = rollout_header(&current) else {
                return (chain, false);
            };
            let base = header
                .as_ref()
                .map(|header| record(header.get("history_base")).clone())
                .unwrap_or_default();
            if base.is_empty() {
                return (chain, true);
            }
            let thread = string(&base, "thread_id");
            let ordinal = safe_integer(base.get("end_ordinal_exclusive"));
            let end = safe_integer(base.get("end_byte_offset")).filter(|end| *end > 0);
            let (Some(ordinal), Some(end)) = (ordinal, end) else {
                return (chain, false);
            };
            if !UUID.is_match(thread) {
                return (chain, false);
            }
            let end = end as u64;
            let holders: Vec<PathBuf> = thread_rollouts(home, thread)
                .into_iter()
                .filter_map(|candidate| rollout_path(&candidate, home))
                .filter(|resolved| {
                    *resolved != current
                        && !chain.iter().any(|link| link.path == *resolved)
                        && self.holds_cut(resolved, ordinal, end)
                })
                .collect();
            let [holder] = holders.as_slice() else {
                return (chain, false);
            };
            chain.push(Link {
                path: holder.clone(),
                end,
            });
            current = holder.clone();
        }
        (chain, false)
    }

    /// The conversation's files oldest first, each with how many of its bytes belong to it, the
    /// live one to `size` (`codexHistorySegments`). A remembered chain can outlive its files (a
    /// parent archived since, moved out of `sessions/`): then it is looked up again and comes back
    /// shorter, so the stream's id changes and a cursor into the old chain answers HistoryChanged
    /// once (`liveChain`).
    pub(super) fn segments(&self, path: &Path, home: &Path, size: u64) -> Vec<Segment> {
        let mut chain = self.history_chain(path, home);
        if !chain.iter().all(|link| fs::metadata(&link.path).is_ok()) {
            self.chains
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .retain(|(rollout, _)| rollout != path);
            chain = self.history_chain(path, home);
        }
        chain
            .into_iter()
            .rev()
            .map(|link| Segment {
                path: link.path,
                start: 0,
                end: link.end,
            })
            .chain(std::iter::once(Segment {
                path: path.to_path_buf(),
                start: 0,
                end: size,
            }))
            .collect()
    }

    /// Whether a chain of `path` is remembered.
    #[cfg(test)]
    pub(super) fn remembers(&self, path: &Path) -> bool {
        self.chains
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .any(|(rollout, _)| rollout == path)
    }
}
