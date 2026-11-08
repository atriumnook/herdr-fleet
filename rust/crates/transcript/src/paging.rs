//! Reading a transcript a page at a time, for every source alike (`server/conversation.ts`,
//! `transcriptPage` and what it calls). What differs between sources comes through
//! `TranscriptFormat`; nothing here names a source.
//!
//! A transcript is one byte stream (a Codex rollout's history first, a pi branch's ranges) that
//! only grows at the end, so a position in it keeps naming the same turn while the file does. A
//! page starts at a line that opens a turn and holds at most `MAX_PAGE_PROMPTS` prompts.
//!
//! This engine reads again on every call: the caches that make the newest page incremental
//! (`liveScans`, `settledTurns`, the boundary scan's resumption, the answer cache, Codex's live
//! turn) are #205's. What changes an answer is kept: a rewrite's generation, and where the history
//! boundary lies.

use std::collections::hash_map::RandomState;
use std::fs::{self, File, Metadata};
use std::hash::{BuildHasher, Hasher};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use protocol::js;
use protocol::{ConversationMetadata, ConversationTurn};
use sha2::{Digest, Sha256};

use crate::errors::{ConversationError, UnavailableReason};
use crate::format::{MetadataHead, StreamFile, TOOL_REF, TranscriptFormat};
use crate::records::{MAX_TURNS, parse_line};
use crate::{Image, Page, PageRequest};

/// A transcript is read a page at a time, the newest page re-read on every append while an agent
/// works: Codex rollouts reach hundreds of MB. 16 MB still holds dozens of turns of a tool-heavy
/// session; the chat asks for the pages before it as the reader scrolls up.
pub(crate) const TRANSCRIPT_WINDOW_BYTES: u64 = 16 * 1024 * 1024;

/// A page never holds more prompts than this (each opens a user + assistant pair).
const MAX_PAGE_PROMPTS: usize = MAX_TURNS / 2;

/// A single turn longer than a window still gets a page of its own, up to this.
const MAX_PAGE_BYTES: u64 = 4 * TRANSCRIPT_WINDOW_BYTES;

/// Settings recorded once at the start (an omp thinking level) sit before a tail window.
pub(crate) const METADATA_HEAD_BYTES: u64 = 64 * 1024;

/// How many files' rewrite generations a source remembers (`transcriptRevisions`).
const REMEMBERED_REVISIONS: usize = 64;

/// The setting records the boundary scan keeps for the pi family.
const SETTING_TYPES: [&str; 2] = ["model_change", "thinking_level_change"];

/// Values that differ in every process and never repeat in one (TypeScript's `randomUUID`): a
/// seed from `RandomState`, which the OS's randomness keys, and a counter.
pub(crate) struct ProcessIds {
    seed: String,
    counter: AtomicU64,
}

impl ProcessIds {
    pub(crate) fn new() -> Self {
        let half = || {
            let mut hasher = RandomState::new().build_hasher();
            hasher.write_u8(0);
            hasher.finish()
        };
        Self {
            seed: format!("{:016x}{:016x}", half(), half()),
            counter: AtomicU64::new(0),
        }
    }

    /// One value of this process: `PROCESS_VERSION` of TypeScript.
    fn process(&self) -> &str {
        &self.seed
    }

    /// A value no other call of this process returns.
    fn next(&self) -> String {
        format!(
            "{}{:x}",
            self.seed,
            self.counter.fetch_add(1, Ordering::Relaxed)
        )
    }
}

/// What tells a file and its changes apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileStat {
    /// the file itself, whatever its contents: its device and inode on unix
    pub(crate) node: String,
    pub(crate) size: u64,
    /// its modification and status change times
    pub(crate) changed: String,
}

/// The device, inode, size, modification time and status change time of a file (the stat that
/// TypeScript reads as `dev`, `ino`, `size`, `mtimeMs`, `ctimeMs`).
#[cfg(unix)]
pub(crate) fn file_stat(meta: &Metadata) -> FileStat {
    use std::os::unix::fs::MetadataExt;
    FileStat {
        node: format!("{}-{}", radix36(meta.dev()), radix36(meta.ino())),
        size: meta.len(),
        changed: format!(
            "{}.{:09}:{}.{:09}",
            meta.mtime(),
            meta.mtime_nsec(),
            meta.ctime(),
            meta.ctime_nsec()
        ),
    }
}

/// std names no device and inode outside unix: the creation time stands in for the file, and the
/// modification time for its changes (whether this serves on Windows is checked in phase 6, ADR
/// 0192-phase-2-split).
#[cfg(not(unix))]
pub(crate) fn file_stat(meta: &Metadata) -> FileStat {
    let nanos = |time: io::Result<std::time::SystemTime>| {
        time.ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |since| since.as_nanos())
    };
    FileStat {
        node: format!("{:x}", nanos(meta.created())),
        size: meta.len(),
        changed: format!("{:x}", nanos(meta.modified())),
    }
}

fn radix36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
        if value == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// A file as last seen, for telling an in-place rewrite from an append.
struct Revision {
    node: String,
    size: u64,
    changed: String,
    generation: String,
}

/// The state a source keeps between calls. The lock is held only to read and write it, never
/// while a file is read or parsed (ADR 0192-phase-2-split).
#[derive(Default)]
struct PagingState {
    /// by path, the least recently seen first
    revisions: Vec<(PathBuf, Revision)>,
}

impl PagingState {
    /// The generation of a file's contents: in-place rewrites keep the inode, so a rewrite seen
    /// (the same file, shorter, or as long but changed) starts a new one, and every cursor into
    /// the old contents stops naming a turn (`transcriptGeneration`).
    fn generation(&mut self, path: &Path, stat: &FileStat, ids: &ProcessIds) -> String {
        let previous = self
            .revisions
            .iter()
            .position(|(seen, _)| seen == path)
            .map(|at| self.revisions.remove(at).1);
        let same_file = previous
            .as_ref()
            .is_some_and(|previous| previous.node == stat.node);
        let rewritten = previous.as_ref().is_some_and(|previous| {
            same_file
                && (stat.size < previous.size
                    || (stat.size == previous.size && stat.changed != previous.changed))
        });
        let generation = match previous {
            _ if rewritten => ids.next(),
            Some(previous) if same_file => previous.generation,
            _ => String::new(),
        };
        self.revisions.push((
            path.to_path_buf(),
            Revision {
                node: stat.node.clone(),
                size: stat.size,
                changed: stat.changed.clone(),
                generation: generation.clone(),
            },
        ));
        if self.revisions.len() > REMEMBERED_REVISIONS {
            self.revisions.remove(0);
        }
        if generation.is_empty() {
            generation
        } else {
            format!("-{generation}")
        }
    }
}

/// The conversation as one byte stream.
struct Stream {
    /// the live file's identity, its layout and where the history starts: cursors from any other
    /// stream are refused
    id: String,
    files: Vec<StreamFile>,
    length: u64,
    /// where the history starts: after the last native reset
    floor: u64,
    /// the latest setting record of each type (the pi family), as (start, end, line)
    settings: Vec<(u64, u64, String)>,
}

impl Stream {
    fn read(&self, from: u64, to: u64) -> io::Result<Vec<u8>> {
        let mut out = Vec::new();
        for file in &self.files {
            let low = from.max(file.start);
            let high = to.min(file.start + file.length);
            if low >= high {
                continue;
            }
            let mut handle = File::open(&file.path)?;
            handle.seek(SeekFrom::Start(file.offset + (low - file.start)))?;
            handle.take(high - low).read_to_end(&mut out)?;
        }
        Ok(out)
    }

    fn text(&self, from: u64, to: u64) -> io::Result<String> {
        Ok(String::from_utf8_lossy(&self.read(from, to)?).into_owned())
    }
}

/// An I/O failure while a page is read: the file went unreadable mid-read.
fn missing(_: io::Error) -> ConversationError {
    ConversationError::ConversationUnavailable(UnavailableReason::TranscriptMissing)
}

/// One source's transcripts, read through its format.
pub(crate) struct Source<F: TranscriptFormat> {
    pub(crate) format: F,
    state: Mutex<PagingState>,
    ids: ProcessIds,
}

impl<F: TranscriptFormat> Source<F> {
    pub(crate) fn new(format: F) -> Self {
        Self {
            format,
            state: Mutex::new(PagingState::default()),
            ids: ProcessIds::new(),
        }
    }

    /// One page of a transcript (`transcriptPage`): without `before` the newest page (with `from`,
    /// from that held start while it is still inside the newest page); with `before` the page
    /// ending there, never reaching back past `since`.
    pub(crate) fn page(
        &self,
        place: &F::Place,
        request: &PageRequest,
    ) -> Result<Page, ConversationError> {
        let path = F::live_path(place);
        let meta = fs::metadata(path).map_err(missing)?;
        let stat = file_stat(&meta);
        let mut stream = self.stream(place, &stat)?;
        self.apply_history_boundary(&mut stream).map_err(missing)?;

        // the answer is a function of the page asked for and the file's state, so they name it;
        // an older page never changes while the stream's id stays the same
        let shown = path.to_string_lossy();
        let key = match &request.before {
            Some(before) => format!(
                "{shown}\0before:{before}:{}",
                request.since.as_deref().unwrap_or("")
            ),
            None => format!("{shown}\0from:{}", request.from.as_deref().unwrap_or("")),
        };
        let signature = if request.before.is_some() {
            stream.id.clone()
        } else {
            format!("{}:{}:{}", stream.id, stat.size, stat.changed)
        };
        let version = self.answer_version(&key, &signature);

        let (start, read) = self.locate(place, &stream, request)?;
        let cursor = (start > stream.floor).then(|| format!("{}:{start}", stream.id));
        let (turns, metadata) = match read {
            PageRead::Live { turns, metadata } => (turns, metadata),
            PageRead::Text { head, text } => {
                let turns = self.format.parse_turns(&text, &mut F::Carry::default());
                let metadata = self.format.metadata(&format!("{head}\n{text}"), None);
                (turns, metadata)
            }
        };
        // the abandoned turns live outside the branch's byte ranges, so the page cannot see them
        let abandoned = self.format.abandoned(place, stat.size);
        Ok(Page {
            source: F::SOURCE,
            turns,
            metadata,
            cursor,
            abandoned,
            history_id: stream.id,
            version,
        })
    }

    /// The whole output of a tool call whose page output was cut; `None` when there is none.
    pub(crate) fn tool_output(&self, place: &F::Place, reference: &str) -> Option<String> {
        if !TOOL_REF.is_match(reference) {
            return None;
        }
        self.format.tool_output(place, reference)
    }

    /// An image an image part's ref names, decoded; `None` when there is none.
    pub(crate) fn image(&self, place: &F::Place, reference: &str) -> Option<Image> {
        self.format.image(place, reference)
    }

    fn answer_version(&self, key: &str, signature: &str) -> String {
        let digest =
            Sha256::digest(format!("{}\0{key}\0{signature}", self.ids.process()).as_bytes());
        let mut version = URL_SAFE_NO_PAD.encode(digest);
        version.truncate(22);
        version
    }

    /// The stream of `place` as the live file stands (`transcriptStream`).
    fn stream(&self, place: &F::Place, stat: &FileStat) -> Result<Stream, ConversationError> {
        let path = F::live_path(place);
        let segments = self.format.segments(place, stat.size)?;
        let mut files = Vec::new();
        let mut length = 0;
        for segment in segments {
            // the live file is read to the size it had when it was identified
            let end = if segment.path == path {
                segment.end.min(stat.size)
            } else {
                segment.end
            };
            if end <= segment.start {
                continue;
            }
            files.push(StreamFile {
                path: segment.path,
                start: length,
                length: end - segment.start,
                offset: segment.start,
            });
            length += end - segment.start;
        }
        let mark = self.format.layout_mark(&files);
        let generation = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .generation(path, stat, &self.ids);
        Ok(Stream {
            id: format!("{}{mark}{generation}", stat.node),
            files,
            length,
            floor: 0,
            settings: Vec::new(),
        })
    }

    /// Sets the stream's floor after its last native reset and keeps the latest setting records
    /// (`applyHistoryBoundary`): each line is scanned in bounded chunks, and a line longer than
    /// the metadata head cannot be a reset.
    fn apply_history_boundary(&self, stream: &mut Stream) -> io::Result<()> {
        let Some(mark) = self.format.clear_mark() else {
            return Ok(());
        };
        let is_clear = |line: &[u8]| {
            contains(line, mark.as_bytes())
                && parse_line(&String::from_utf8_lossy(line))
                    .is_some_and(|entry| self.format.is_clear(&entry))
        };
        let mut floor = 0;
        let mut settings: [Option<(u64, u64, String)>; 2] = [None, None];
        let mut position = 0;
        let mut carry: Vec<u8> = Vec::new();
        let mut skipping = false;
        while position < stream.length {
            let end = stream.length.min(position + TRANSCRIPT_WINDOW_BYTES);
            let mut bytes = std::mem::take(&mut carry);
            let base = position - bytes.len() as u64;
            bytes.extend(stream.read(position, end)?);
            let mut offset = 0;
            while let Some(newline) = find(&bytes, b'\n', offset) {
                let line = &bytes[offset..newline];
                if !skipping && is_clear(line) {
                    floor = base + offset as u64;
                } else if !skipping
                    && self.format.keeps_settings()
                    && SETTING_TYPES
                        .iter()
                        .any(|kind| contains(line, format!("\"{kind}\"").as_bytes()))
                {
                    let text = String::from_utf8_lossy(line);
                    let kind = parse_line(&text).and_then(|entry| {
                        entry
                            .get("type")
                            .and_then(|kind| kind.as_str())
                            .map(str::to_owned)
                    });
                    if let Some(at) = SETTING_TYPES
                        .iter()
                        .position(|setting| Some(*setting) == kind.as_deref())
                    {
                        settings[at] = Some((
                            base + offset as u64,
                            base + newline as u64,
                            text.into_owned(),
                        ));
                    }
                }
                skipping = false;
                offset = newline + 1;
            }
            carry = bytes[offset..].to_vec();
            // an oversized data record cannot be a native reset
            if carry.len() as u64 > METADATA_HEAD_BYTES {
                carry.clear();
                skipping = true;
            }
            position = end;
        }
        // a valid final record is visible before its newline
        stream.floor = if !skipping && !carry.is_empty() && is_clear(&carry) {
            stream.length - carry.len() as u64
        } else {
            floor
        };
        if stream.floor > 0 {
            stream.id = format!("{}-clear-{}", stream.id, radix36(stream.floor));
        }
        stream.settings = settings.into_iter().flatten().collect();
        Ok(())
    }

    /// Where the page asked for starts, and what is read for it.
    fn locate(
        &self,
        place: &F::Place,
        stream: &Stream,
        request: &PageRequest,
    ) -> Result<(u64, PageRead), ConversationError> {
        if let Some(before) = &request.before {
            let before = parse_cursor(stream, before)?;
            let floor = match &request.since {
                Some(since) => parse_cursor(stream, since)?,
                None => stream.floor,
            };
            if floor > before {
                return Err(ConversationError::HistoryChanged);
            }
            let (start, bytes) = if before == floor {
                (floor, Vec::new())
            } else {
                self.page_before(stream, before, floor, true)
                    .map_err(missing)?
            };
            return Ok((
                start,
                PageRead::Text {
                    head: String::new(),
                    text: String::from_utf8_lossy(&bytes).into_owned(),
                },
            ));
        }
        let held = request
            .from
            .as_deref()
            .map(|from| parse_cursor(stream, from))
            .transpose()?;
        // A chat that shows older pages holds the start of its newest turns and keeps every turn
        // after it while they are inside the newest page; once the newest page has moved past it,
        // the chat gets the newest page and fetches the turns between with `before` + `since`
        match self.newest_page(stream).map_err(missing)? {
            Some((newest, starts)) => {
                let start = held.filter(|held| *held >= newest).unwrap_or(newest);
                let (turns, metadata) = self
                    .live_turns(place, stream, start, &starts)
                    .map_err(missing)?;
                Ok((start, PageRead::Live { turns, metadata }))
            }
            None => {
                // no turn starts in the window: the page begins mid-turn, read whole
                let (whole, bytes) = self
                    .page_before(stream, stream.length, stream.floor, false)
                    .map_err(missing)?;
                let start = held.filter(|held| *held >= whole).unwrap_or(whole);
                let text = String::from_utf8_lossy(&bytes[(start - whole) as usize..]).into_owned();
                let head = if start > stream.floor {
                    self.metadata_head(place, stream, start).map_err(missing)?
                } else {
                    String::new()
                };
                Ok((start, PageRead::Text { head, text }))
            }
        }
    }

    /// The offsets of the lines in `bytes` that open a turn.
    fn turn_starts(&self, bytes: &[u8]) -> Vec<u64> {
        let marks = self.format.turn_marks();
        let mut starts = Vec::new();
        let mut offset = 0;
        while offset < bytes.len() {
            let end = find(bytes, b'\n', offset).unwrap_or(bytes.len());
            let line = &bytes[offset..end];
            if marks.iter().any(|mark| contains(line, mark.as_bytes()))
                && parse_line(&String::from_utf8_lossy(line)).is_some_and(|entry| {
                    (entry.is_object() || entry.is_array()) && self.format.opens_turn(&entry)
                })
            {
                starts.push(offset as u64);
            }
            offset = end + 1;
        }
        starts
    }

    /// The page of turns ending at `to`: at most `MAX_PAGE_PROMPTS` prompts, starting on a line
    /// that opens a turn, at `floor` or at the very beginning. An older page (`widen`) reaches
    /// further back, a window at a time, for a turn longer than a window, up to `MAX_PAGE_BYTES`;
    /// the newest page never does, and with no turn start in its window starts mid-turn at a
    /// whole line (`pageBefore`).
    fn page_before(
        &self,
        stream: &Stream,
        to: u64,
        floor: u64,
        widen: bool,
    ) -> io::Result<(u64, Vec<u8>)> {
        let mut from = floor.max(to.saturating_sub(TRANSCRIPT_WINDOW_BYTES));
        let mut bytes = stream.read(from, to)?;
        loop {
            let starts = self.turn_starts(&bytes);
            let keep = if starts.len() > MAX_PAGE_PROMPTS {
                Some(starts[starts.len() - MAX_PAGE_PROMPTS])
            } else if from == floor {
                Some(0)
            } else {
                starts.first().copied()
            };
            if let Some(keep) = keep {
                return Ok((from + keep, bytes.split_off(keep as usize)));
            }
            if !widen || to - from >= MAX_PAGE_BYTES {
                let first = find(&bytes, b'\n', 0).map_or(0, |newline| newline + 1);
                return Ok((from + first as u64, bytes.split_off(first)));
            }
            let next = floor.max(from.saturating_sub(TRANSCRIPT_WINDOW_BYTES));
            let mut earlier = stream.read(next, from)?;
            earlier.extend(bytes);
            bytes = earlier;
            from = next;
        }
    }

    /// The newest page's start and every turn start in it, or `None` when it starts mid-turn
    /// (`newestPage`, read whole). A window that does not reach the floor starts at its edge,
    /// where a line may be cut.
    fn newest_page(&self, stream: &Stream) -> io::Result<Option<(u64, Vec<u64>)>> {
        let from = stream
            .floor
            .max(stream.length.saturating_sub(TRANSCRIPT_WINDOW_BYTES));
        let bytes = stream.read(from, stream.length)?;
        let complete = bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |newline| newline + 1);
        let mut starts: Vec<u64> = self
            .turn_starts(&bytes[..complete])
            .into_iter()
            .map(|offset| from + offset)
            .collect();
        // a last line still without its newline counts too
        starts.extend(
            self.turn_starts(&bytes[complete..])
                .into_iter()
                .map(|offset| from + complete as u64 + offset),
        );
        let start = if starts.len() > MAX_PAGE_PROMPTS {
            Some(starts[starts.len() - MAX_PAGE_PROMPTS])
        } else if from == stream.floor {
            Some(stream.floor)
        } else {
            starts.first().copied()
        };
        Ok(start.map(|start| (start, starts)))
    }

    /// The newest page's turns from `start` (`liveTurns`): the settled ones, before the last turn
    /// start, then the live last turn, each part parsed on its own and the settings folded across.
    fn live_turns(
        &self,
        place: &F::Place,
        stream: &Stream,
        start: u64,
        starts: &[u64],
    ) -> io::Result<(Vec<ConversationTurn>, ConversationMetadata)> {
        let last = start.max(starts.last().copied().unwrap_or(start));
        let head = if start > stream.floor {
            self.metadata_head(place, stream, start)?
        } else {
            String::new()
        };
        let mut metadata = self.format.metadata(&format!("{head}\n"), None);
        let mut carry = F::Carry::default();
        let mut turns = Vec::new();
        if start < last {
            let text = stream.text(start, last)?;
            turns = self.format.parse_turns(&text, &mut carry);
            metadata = self.format.metadata(&text, Some(metadata));
        }
        let text = stream.text(last, stream.length)?;
        turns.extend(self.format.parse_live(&text, carry));
        let metadata = self.format.metadata(&text, Some(metadata));
        Ok((turns, metadata))
    }

    /// The text whose settings stand before a page starting at `start` (`metadataHead`).
    fn metadata_head(&self, place: &F::Place, stream: &Stream, start: u64) -> io::Result<String> {
        if self.format.metadata_head() == MetadataHead::LiveFileStart {
            let mut bytes = Vec::new();
            File::open(F::live_path(place))?
                .take(METADATA_HEAD_BYTES)
                .read_to_end(&mut bytes)?;
            return Ok(String::from_utf8_lossy(&bytes).into_owned());
        }
        let end = start.min(stream.floor + METADATA_HEAD_BYTES);
        // a setting record after the head and before the page follows the head, in order; one the
        // head cuts in two is read whole here
        let mut later: Vec<&(u64, u64, String)> = stream
            .settings
            .iter()
            .filter(|(offset, line_end, _)| *line_end > end && *offset < start)
            .collect();
        later.sort_by_key(|(offset, _, _)| *offset);
        let mut parts = vec![stream.text(stream.floor, end)?];
        parts.extend(later.into_iter().map(|(_, _, line)| line.clone()));
        Ok(parts.join("\n"))
    }
}

/// What a page is read from.
enum PageRead {
    /// the newest page, settled and live turns already parsed
    Live {
        turns: Vec<ConversationTurn>,
        metadata: ConversationMetadata,
    },
    /// a page's text, and the text whose settings stand before it
    Text { head: String, text: String },
}

/// The position a cursor names in this stream; HistoryChanged for a cursor of another stream or
/// one outside its history (`parseCursor`).
fn parse_cursor(stream: &Stream, cursor: &str) -> Result<u64, ConversationError> {
    let separator = cursor
        .rfind(':')
        .filter(|separator| *separator > 0)
        .ok_or(ConversationError::HistoryChanged)?;
    if cursor[..separator] != stream.id {
        return Err(ConversationError::HistoryChanged);
    }
    let offset = js_number(&cursor[separator + 1..]);
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    if !offset.is_finite()
        || offset.fract() != 0.0
        || offset.abs() > MAX_SAFE_INTEGER
        || offset < stream.floor as f64
        || offset > stream.length as f64
    {
        return Err(ConversationError::HistoryChanged);
    }
    Ok(offset as u64)
}

/// `Number(text)` of JavaScript, for the offset of a cursor: NaN for what it does not read.
fn js_number(text: &str) -> f64 {
    let text = js::trim(text);
    if text.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = text.strip_prefix(prefix) {
            return if !digits.is_empty() && digits.chars().all(|c| c.is_digit(radix)) {
                digits.chars().fold(0.0, |value, c| {
                    value * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
                })
            } else {
                f64::NAN
            };
        }
    }
    match text {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // Rust also reads `inf` and `nan`, which JavaScript does not
    if !text
        .bytes()
        .all(|byte| byte.is_ascii_digit() || matches!(byte, b'+' | b'-' | b'.' | b'e' | b'E'))
    {
        return f64::NAN;
    }
    text.parse().unwrap_or(f64::NAN)
}

fn find(bytes: &[u8], byte: u8, from: usize) -> Option<usize> {
    bytes
        .get(from..)?
        .iter()
        .position(|candidate| *candidate == byte)
        .map(|at| from + at)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    needle.is_empty()
        || haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values: JavaScript's Number(text) for each (ECMAScript StringToNumber), by hand.
    #[test]
    fn reads_an_offset_as_javascript_number_does() {
        assert_eq!(js_number("12"), 12.0);
        assert_eq!(js_number(" 12 "), 12.0);
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number("0x10"), 16.0);
        assert_eq!(js_number("1e3"), 1000.0);
        assert!(js_number("inf").is_nan());
        assert!(js_number("12a").is_nan());
        assert_eq!(js_number("Infinity"), f64::INFINITY);
    }

    #[test]
    fn writes_numbers_in_base_36() {
        assert_eq!(radix36(0), "0");
        assert_eq!(radix36(35), "z");
        assert_eq!(radix36(36), "10");
    }
}
