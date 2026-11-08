//! pi's session file is an append-only entry tree, not a linear log (`server/pi-tree.ts`): entries
//! link to their predecessor by id and `parentId`, and `/tree` moves the leaf back to an earlier
//! entry without rewriting the file, so a later append grows a branch beside the abandoned one. The
//! conversation pi shows is the path from the last entry written back to its root. Parents always
//! precede their children, so the last line is the leaf and one forward pass indexes the tree.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use protocol::AbandonedTurns;
use protocol::js;
use serde_json::Value;

use crate::paging::file_stat;
use crate::records::{parse_line, record, text};

/// A branch longer than this is not returned at all: the page answers `branch_unreadable` and the
/// chat falls back to the pane's terminal output. The largest branch across 147 real session files
/// was 23.3 MiB (`server/pi-tree.ts`).
pub(super) const MAX_BRANCH_BYTES: u64 = 64 * 1024 * 1024;

/// How many files' indexes one reader keeps (`piIndexes`).
const REMEMBERED_INDEXES: usize = 32;

/// The bytes before the scanned end that tell an append from a rewrite.
const TAIL_BYTES: u64 = 64;

/// The file is read for indexing this much at a time.
const INDEX_CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// One byte range of the transcript file, in the order it is read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Range {
    pub(super) start: u64,
    pub(super) end: u64,
}

struct Entry {
    id: String,
    parent: Option<String>,
    start: u64,
    end: u64,
    kind: String,
    role: String,
    summary: Option<String>,
}

/// The tree of one file as far as it was scanned.
struct Index {
    /// the file the index was built from: another file at the same path starts over
    node: String,
    /// in append order; entries without an id (the session header) are not nodes
    entries: Vec<Entry>,
    /// each entry's children in append order, as positions in `entries`
    children: HashMap<String, Vec<usize>>,
    /// bytes scanned into entries; appends extend it, one line at a time, never a rewrite
    scanned: u64,
    /// the bytes before `scanned`, which no append overwrites
    tail: Vec<u8>,
}

/// The indexes one reader keeps, by path, in the order they were first indexed (TypeScript's
/// module-level `piIndexes`, here a field of each reader). The lock is held only to take an index
/// out and put it back, never while the file is read.
#[derive(Default)]
pub(super) struct Indexes {
    state: Mutex<IndexState>,
}

#[derive(Default)]
struct IndexState {
    order: Vec<PathBuf>,
    indexes: HashMap<PathBuf, Index>,
}

impl Indexes {
    /// `f` over the tree of `path` as it stands; `Ok(None)` when the file cannot be stat'ed (TypeScript's
    /// `piEntryIndex` answering null), `Err` when it went unreadable while it was indexed.
    fn with_index<T>(&self, path: &Path, f: impl FnOnce(&Index) -> T) -> io::Result<Option<T>> {
        let Ok(meta) = fs::metadata(path) else {
            return Ok(None);
        };
        let stat = file_stat(&meta);
        let cached = self.lock().indexes.remove(path);
        // an append cannot disturb what was scanned (parents precede children), but a rewrite, a
        // truncation or an in-place replacement can, and only the tail check tells them apart; a
        // file put in the old one's place is another file even where its tail reads the same
        let index = match cached {
            Some(mut index)
                if index.node == stat.node
                    && index.scanned <= stat.size
                    && read_before(path, index.scanned)? == index.tail =>
            {
                extend(&mut index, path, stat.size)?;
                index
            }
            _ => {
                let mut index = Index {
                    node: stat.node,
                    entries: Vec::new(),
                    children: HashMap::new(),
                    scanned: 0,
                    tail: Vec::new(),
                };
                extend(&mut index, path, stat.size)?;
                index
            }
        };
        let answer = f(&index);
        let mut state = self.lock();
        if !state.order.iter().any(|seen| seen == path) {
            state.order.push(path.to_path_buf());
        }
        state.indexes.insert(path.to_path_buf(), index);
        if state.order.len() > REMEMBERED_INDEXES {
            let oldest = state.order.remove(0);
            state.indexes.remove(&oldest);
        }
        Ok(Some(answer))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, IndexState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// How many files' indexes this reader holds.
    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.lock().indexes.len()
    }

    /// The active branch, the last entry written back to its root, oldest first, as byte ranges
    /// of the file; adjacent entries merge into one range (`piBranchSegments`). An id repeated
    /// keeps its last append. `Ok(None)` when the tree cannot be read, holds no entry, no longer
    /// fits in `size`, or its branch runs past `MAX_BRANCH_BYTES`.
    pub(super) fn branch(&self, path: &Path, size: u64) -> io::Result<Option<Vec<Range>>> {
        Ok(self
            .with_index(path, |index| branch_of(index, size))?
            .flatten())
    }

    /// The turns on paths pi walked away from (`piAbandonedTurns`): `count` turns, under
    /// `branches` places a live entry was given a child that is not itself live, and pi's summary
    /// of the abandoned path when the live path holds one. `None` when the tree cannot be walked.
    pub(super) fn abandoned(&self, path: &Path, size: u64) -> Option<AbandonedTurns> {
        self.with_index(path, |index| abandoned_of(index, size))
            .ok()
            .flatten()
            .flatten()
    }
}

fn index_entry(line: &[u8], start: u64, end: u64) -> Option<Entry> {
    // the header and a torn fragment answer no sooner
    if !line.windows(4).any(|window| window == b"\"id\"") {
        return None;
    }
    let parsed = parse_line(&String::from_utf8_lossy(line))?;
    let entry = record(Some(&parsed));
    let id = text(entry, "id").filter(|id| !id.is_empty())?;
    // type and role are taken here because the line is parsed for this anyway
    let role = match entry.get("message") {
        Some(Value::Object(message)) => text(message, "role").unwrap_or(""),
        _ => "",
    };
    Some(Entry {
        id: id.to_owned(),
        parent: text(entry, "parentId")
            .filter(|parent| !parent.is_empty())
            .map(str::to_owned),
        start,
        end,
        kind: text(entry, "type").unwrap_or("").to_owned(),
        role: role.to_owned(),
        summary: text(entry, "summary").map(str::to_owned),
    })
}

/// Indexes whole lines from `scanned` on; a last line still without its newline waits for it, so
/// `scanned` always names a line boundary and the bytes before it never change.
fn extend(index: &mut Index, path: &Path, size: u64) -> io::Result<()> {
    if index.scanned < size {
        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(index.scanned))?;
        let mut reader =
            BufReader::with_capacity(INDEX_CHUNK_BYTES, file.take(size - index.scanned));
        let mut line = Vec::new();
        loop {
            line.clear();
            let read = reader.read_until(b'\n', &mut line)?;
            if read == 0 || line.last() != Some(&b'\n') {
                break;
            }
            let start = index.scanned;
            let end = start + read as u64;
            if let Some(entry) = index_entry(&line[..read - 1], start, end) {
                if let Some(parent) = &entry.parent {
                    index
                        .children
                        .entry(parent.clone())
                        .or_default()
                        .push(index.entries.len());
                }
                index.entries.push(entry);
            }
            index.scanned = end;
        }
    }
    index.tail = read_before(path, index.scanned)?;
    Ok(())
}

/// The `TAIL_BYTES` bytes before `offset`.
fn read_before(path: &Path, offset: u64) -> io::Result<Vec<u8>> {
    let from = offset.saturating_sub(TAIL_BYTES);
    if from >= offset {
        return Ok(Vec::new());
    }
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(from))?;
    let mut bytes = Vec::new();
    file.take(offset - from).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// The last append of each id.
fn by_id(index: &Index) -> HashMap<&str, &Entry> {
    index
        .entries
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect()
}

/// The leaf, when the tree holds one that the file of `size` bytes still holds.
fn leaf(index: &Index, size: u64) -> Option<&Entry> {
    index.entries.last().filter(|leaf| leaf.end <= size)
}

fn branch_of(index: &Index, size: u64) -> Option<Vec<Range>> {
    let leaf = leaf(index, size)?;
    let by_id = by_id(index);
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut total = 0;
    let mut next = Some(leaf);
    while let Some(entry) = next {
        if !seen.insert(entry.id.as_str()) {
            break;
        }
        chain.push(entry);
        total += entry.end - entry.start;
        if total > MAX_BRANCH_BYTES {
            return None;
        }
        // a parent that never appears (a foreign id, a torn index) ends the walk short: what it
        // still resolves to is shown, the unreadable head is not invented
        next = entry
            .parent
            .as_deref()
            .and_then(|parent| by_id.get(parent).copied());
    }
    let mut ranges: Vec<Range> = Vec::new();
    for entry in chain.into_iter().rev() {
        match ranges.last_mut() {
            Some(last) if last.end == entry.start => last.end = entry.end,
            _ => ranges.push(Range {
                start: entry.start,
                end: entry.end,
            }),
        }
    }
    Some(ranges)
}

fn abandoned_of(index: &Index, size: u64) -> Option<AbandonedTurns> {
    let leaf = leaf(index, size)?;
    let by_id = by_id(index);
    let mut live: Vec<&str> = Vec::new();
    let mut on_live = HashSet::new();
    let mut next = Some(leaf);
    while let Some(entry) = next {
        if !on_live.insert(entry.id.as_str()) {
            break;
        }
        live.push(&entry.id);
        next = entry
            .parent
            .as_deref()
            .and_then(|parent| by_id.get(parent).copied());
    }
    let children = |id: &str| {
        index
            .children
            .get(id)
            .into_iter()
            .flatten()
            .map(|at| &index.entries[*at])
    };
    // a branch is a place the pointer was moved away from: a live entry with a child left behind
    let mut heads: Vec<&str> = Vec::new();
    for id in &live {
        // ids deduped the way the branch dedupes them: an entry appended twice is still one place
        // navigated away from
        let mut left: Vec<&str> = Vec::new();
        for child in children(id) {
            if !on_live.contains(child.id.as_str()) && !left.contains(&child.id.as_str()) {
                left.push(&child.id);
            }
        }
        heads.extend(left);
    }
    // a parentless entry other than pi's header, off the live path, with something left under it:
    // pi's leaf cleared to null starts a path at the root, and abandoning it is the same navigation
    let is_head = |entry: &Entry| {
        entry.parent.is_none()
            && entry.kind != "session"
            && !on_live.contains(entry.id.as_str())
            && children(&entry.id).any(|child| !on_live.contains(child.id.as_str()))
    };
    for entry in &index.entries {
        if is_head(entry) && !heads.contains(&entry.id.as_str()) {
            heads.push(&entry.id);
        }
    }
    let branches = heads.len() as u64;
    // the turns are counted inside these subtrees, never over the whole file: a turn no counted
    // head leads to belongs to no branch, so `count > 0` only ever with a branch behind it
    let mut count = 0;
    if branches > 0 {
        let heads: HashSet<&str> = heads.into_iter().collect();
        let mut owned = HashSet::new();
        let mut counted = HashSet::new();
        for entry in &index.entries {
            let under_head = heads.contains(entry.id.as_str())
                || entry
                    .parent
                    .as_deref()
                    .is_some_and(|parent| owned.contains(parent));
            if !under_head {
                continue;
            }
            owned.insert(entry.id.as_str());
            if entry.kind != "message" || counted.contains(entry.id.as_str()) {
                continue;
            }
            // a tool call and its result are one step of the turn that asked for them
            if entry.role != "user" && entry.role != "assistant" {
                continue;
            }
            counted.insert(entry.id.as_str());
            count += 1;
        }
    }
    // pi's summary of an abandoned path sits on the branch that replaced it; the newest on the
    // live path wins, as a later /tree supersedes an earlier answer
    let summary = index
        .entries
        .iter()
        .filter(|entry| entry.kind == "branch_summary" && on_live.contains(entry.id.as_str()))
        .filter_map(|entry| entry.summary.as_deref())
        .rfind(|summary| !js::trim(summary).is_empty())
        .map(str::to_owned);
    Some(AbandonedTurns {
        count,
        branches,
        summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, parent: Option<&str>, start: u64, end: u64) -> Entry {
        Entry {
            id: id.to_owned(),
            parent: parent.map(str::to_owned),
            start,
            end,
            kind: "message".to_owned(),
            role: "user".to_owned(),
            summary: None,
        }
    }

    /// A branch of two entries whose lines hold `bytes` bytes together, the first line 10 bytes.
    fn two_entries(bytes: u64) -> Index {
        let mut children = HashMap::new();
        children.insert("a".to_owned(), vec![1]);
        Index {
            node: String::new(),
            entries: vec![entry("a", None, 0, 10), entry("b", Some("a"), 10, bytes)],
            children,
            scanned: bytes,
            tail: Vec::new(),
        }
    }

    // The cap: a branch over `MAX_BRANCH_BYTES` (64 MiB) is not returned, and the page answers
    // branch_unreadable (`piBranchSegments` returns null when `total > MAX_BRANCH_BYTES`,
    // server/pi-tree.ts; `transcriptStream` throws, server/conversation.ts:485-486).
    #[test]
    fn a_branch_over_the_cap_is_not_returned() {
        let at_cap = 64 * 1024 * 1024;

        assert_eq!(
            branch_of(&two_entries(at_cap), at_cap),
            Some(vec![Range {
                start: 0,
                end: at_cap
            }])
        );
        assert_eq!(branch_of(&two_entries(at_cap + 1), at_cap + 1), None);
    }
}
