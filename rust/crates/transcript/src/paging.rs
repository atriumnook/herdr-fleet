//! Reading a transcript a page at a time, for every source alike (`server/conversation.ts`,
//! `transcriptPage` and what it calls). What differs between sources comes through
//! `TranscriptFormat`; nothing here names a source.
//!
//! A transcript is one byte stream (a Codex rollout's history first, a pi branch's ranges) that
//! only grows at the end, so a position in it keeps naming the same turn while the file does. A
//! page starts at a line that opens a turn and holds at most `MAX_PAGE_PROMPTS` prompts.
//!
//! Between reads it keeps what makes a poll of the newest page cost the bytes appended since the
//! last one (`server/conversation.ts:547-826, 1019-1075`): each file's rewrite generation, the
//! answers, the history boundary scan, the turn starts of the newest page (`liveScans`), the turns
//! before its last turn start (`settledTurns`) and the parse of a Codex live turn (`codexTurns`).
//! What is kept is checked against the file before it is used: the stream it was read from, and
//! the bytes just before where its read stopped, which a file rewritten rather than appended to no
//! longer has. One `PagingCache` holds it for every source, with TypeScript's limits (ADR
//! 0205-incremental-reads).

use std::any::Any;
use std::collections::VecDeque;
use std::collections::hash_map::RandomState;
use std::fs::{self, File, Metadata};
use std::hash::{BuildHasher, Hasher};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use protocol::js;
use protocol::{AbandonedTurns, ConversationMetadata, ConversationSource, ConversationTurn};
use sha2::{Digest, Sha256};

use crate::errors::{ConversationError, UnavailableReason};
use crate::format::{LiveParser, MetadataHead, StreamFile, TOOL_REF, TranscriptFormat};
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

/// How many of each the cache remembers, the least recently stored dropped first: TypeScript's
/// limits, for every source together as its module variables hold them.
/// Files' rewrite generations (`transcriptRevisions`).
const REMEMBERED_REVISIONS: usize = 64;
/// Answers (`cache`).
const REMEMBERED_ANSWERS: usize = 32;
/// History boundary scans (`clearScans`).
const REMEMBERED_CLEAR_SCANS: usize = 32;
/// Turn starts of a newest page (`liveScans`).
const REMEMBERED_LIVE_SCANS: usize = 32;
/// Settled turns, by file and page start (`settledTurns`).
const REMEMBERED_SETTLED: usize = 8;
/// Parses of a Codex live turn (`codexTurns`).
const REMEMBERED_LIVE_TURNS: usize = 8;
/// The bytes the kept parses of live turns have read, together (`codexTurns`): the record count
/// and the source bytes retained are both bounded, whatever a session's length.
const LIVE_TURN_BYTES: u64 = 2 * TRANSCRIPT_WINDOW_BYTES;

/// How many bytes before where a read stopped are kept to tell an append from a rewrite
/// (`bytesBefore`).
const TAIL_BYTES: u64 = 64;

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

/// What the cache keeps of each kind, by key, the least recently stored first (TypeScript's
/// `remember`): storing a key moves it last, and past the limit the first goes.
struct Recent<K, V> {
    limit: usize,
    entries: VecDeque<(K, V)>,
}

impl<K: PartialEq, V> Recent<K, V> {
    const fn new(limit: usize) -> Self {
        Self {
            limit,
            entries: VecDeque::new(),
        }
    }

    fn get(&self, key: &K) -> Option<&V> {
        self.entries
            .iter()
            .find(|(seen, _)| seen == key)
            .map(|(_, value)| value)
    }

    fn take(&mut self, key: &K) -> Option<V> {
        let at = self.entries.iter().position(|(seen, _)| seen == key)?;
        self.entries.remove(at).map(|(_, value)| value)
    }

    fn remember(&mut self, key: K, value: V) {
        self.take(&key);
        self.entries.push_back((key, value));
        if self.entries.len() > self.limit {
            self.entries.pop_front();
        }
    }
}

/// An answer as it was given, for the same page asked of the same file state.
struct Answer {
    source: ConversationSource,
    /// the file state the answer was read from: the stream's id, and for the newest page the
    /// live file's size and times
    signature: String,
    turns: Vec<ConversationTurn>,
    metadata: ConversationMetadata,
    cursor: Option<String>,
    abandoned: Option<AbandonedTurns>,
}

/// A setting record: its start and end in the stream, and the line.
type Setting = (u64, u64, String);

/// How far a file's history boundary scan has read (`clearScans`).
struct ClearScan {
    source: ConversationSource,
    id: String,
    /// complete lines up to here are scanned
    scanned: u64,
    floor: u64,
    /// the bytes just before `scanned`
    tail: Vec<u8>,
    /// the latest record of each of `SETTING_TYPES`
    settings: [Option<Setting>; 2],
}

/// The turn starts found in a newest page so far (`LiveScan`).
struct LiveScan {
    source: ConversationSource,
    id: String,
    /// complete lines up to here are scanned
    scanned: u64,
    /// turn starts in the scanned bytes, ascending, none before the window
    starts: Vec<u64>,
    /// the bytes just before `scanned`: a file rewritten rather than appended to no longer has
    /// them
    tail: Vec<u8>,
}

/// The turns of a newest page before its last turn start: a later append cannot change a turn
/// that another has followed (`SettledTurns`).
struct Settled {
    source: ConversationSource,
    id: String,
    /// the turn start these turns end at
    end: u64,
    turns: Vec<ConversationTurn>,
    metadata: ConversationMetadata,
    /// the bytes just before `end`
    tail: Vec<u8>,
    /// the format's `Carry` after these turns (Claude's `peersSeen`)
    carry: Box<dyn Any + Send>,
}

/// The parse of a Codex live turn so far (`LiveCodexTurn`).
struct LiveTurn {
    source: ConversationSource,
    id: String,
    start: u64,
    /// complete lines up to here are parsed
    scanned: u64,
    /// the bytes just before `scanned`
    boundary: Vec<u8>,
    parser: Box<dyn LiveParser>,
    metadata: ConversationMetadata,
}

/// What the readers keep between calls. The lock is held only to read and write it, never while
/// a file is read or parsed (ADR 0192-phase-2-split): what a read builds on is taken out, and put
/// back once the read is done.
struct PagingState {
    revisions: Recent<PathBuf, Revision>,
    answers: Recent<String, Arc<Answer>>,
    clear_scans: Recent<PathBuf, ClearScan>,
    live_scans: Recent<PathBuf, LiveScan>,
    settled: Recent<(PathBuf, u64), Settled>,
    live_turns: Recent<PathBuf, LiveTurn>,
}

impl Default for PagingState {
    fn default() -> Self {
        Self {
            revisions: Recent::new(REMEMBERED_REVISIONS),
            answers: Recent::new(REMEMBERED_ANSWERS),
            clear_scans: Recent::new(REMEMBERED_CLEAR_SCANS),
            live_scans: Recent::new(REMEMBERED_LIVE_SCANS),
            settled: Recent::new(REMEMBERED_SETTLED),
            live_turns: Recent::new(REMEMBERED_LIVE_TURNS),
        }
    }
}

impl PagingState {
    /// The generation of a file's contents: in-place rewrites keep the inode, so a rewrite seen
    /// (the same file, shorter, or as long but changed) starts a new one, and every cursor into
    /// the old contents stops naming a turn (`transcriptGeneration`).
    fn generation(&mut self, path: &Path, stat: &FileStat, ids: &ProcessIds) -> String {
        let previous = self.revisions.take(&path.to_path_buf());
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
        self.revisions.remember(
            path.to_path_buf(),
            Revision {
                node: stat.node.clone(),
                size: stat.size,
                changed: stat.changed.clone(),
                generation: generation.clone(),
            },
        );
        if generation.is_empty() {
            generation
        } else {
            format!("-{generation}")
        }
    }

    /// Drops the oldest parses of live turns while those kept have read more than
    /// `LIVE_TURN_BYTES` together, the one just stored too if it alone has.
    fn bound_live_turns(&mut self) {
        let mut retained: u64 = self
            .live_turns
            .entries
            .iter()
            .map(|(_, turn)| turn.scanned - turn.start)
            .sum();
        while retained > LIVE_TURN_BYTES {
            let Some((_, turn)) = self.live_turns.entries.pop_front() else {
                break;
            };
            retained -= turn.scanned - turn.start;
        }
    }
}

/// The paging cache of one `Transcripts`, which all its sources share: the limits are
/// TypeScript's, for every source together.
#[derive(Clone, Default)]
pub(crate) struct PagingCache(Arc<Shared>);

#[derive(Default)]
struct Shared {
    state: Mutex<PagingState>,
    /// the bytes `read_file` has read: outside the lock, which counting never takes
    bytes_read: AtomicU64,
}

impl PagingCache {
    fn lock(&self) -> MutexGuard<'_, PagingState> {
        self.0
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The bytes the paging has read from transcript files, in all
    /// (`Transcripts::paging_bytes_read`).
    pub(crate) fn bytes_read(&self) -> u64 {
        self.0.bytes_read.load(Ordering::Relaxed)
    }

    /// Reads at most `length` bytes of `path` from `offset` onto `out`, and counts them. The
    /// paging reads a transcript file nowhere else, so the count misses none of its reads.
    fn read_file(
        &self,
        path: &Path,
        offset: u64,
        length: u64,
        out: &mut Vec<u8>,
    ) -> io::Result<()> {
        let mut handle = File::open(path)?;
        handle.seek(SeekFrom::Start(offset))?;
        let read = handle.take(length).read_to_end(out)?;
        self.0.bytes_read.fetch_add(read as u64, Ordering::Relaxed);
        Ok(())
    }
}

/// The conversation as one byte stream.
struct Stream {
    /// where its reads are counted
    cache: PagingCache,
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
            self.cache.read_file(
                &file.path,
                file.offset + (low - file.start),
                high - low,
                &mut out,
            )?;
        }
        Ok(out)
    }

    fn text(&self, from: u64, to: u64) -> io::Result<String> {
        Ok(String::from_utf8_lossy(&self.read(from, to)?).into_owned())
    }

    /// The bytes just before `offset` (`bytesBefore`).
    fn bytes_before(&self, offset: u64) -> io::Result<Vec<u8>> {
        self.read(offset.saturating_sub(TAIL_BYTES), offset)
    }
}

/// An I/O failure while a page is read: the file went unreadable mid-read.
fn missing(_: io::Error) -> ConversationError {
    ConversationError::ConversationUnavailable(UnavailableReason::TranscriptMissing)
}

/// One source's transcripts, read through its format.
pub(crate) struct Source<F: TranscriptFormat> {
    pub(crate) format: F,
    cache: PagingCache,
    ids: ProcessIds,
}

impl<F: TranscriptFormat> Source<F> {
    pub(crate) fn new(format: F, cache: &PagingCache) -> Self {
        Self {
            format,
            cache: cache.clone(),
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
        let (stat, generation) = self.identify(path)?;
        let mut stream = self.stream(place, &stat, &generation)?;
        self.apply_history_boundary(path, &mut stream)
            .map_err(missing)?;

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
        let cached = self
            .cache
            .lock()
            .answers
            .get(&key)
            .filter(|answer| answer.source == F::SOURCE && answer.signature == signature)
            .cloned();
        if let Some(answer) = cached {
            return Ok(Page {
                source: F::SOURCE,
                turns: answer.turns.clone(),
                metadata: answer.metadata.clone(),
                cursor: answer.cursor.clone(),
                abandoned: answer.abandoned.clone(),
                history_id: stream.id,
                version,
            });
        }

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
        // the signature is the stat from before the read: an append while it parsed makes the
        // next read read again, never keeps a torn tail
        let answer = Arc::new(Answer {
            source: F::SOURCE,
            signature,
            turns: turns.clone(),
            metadata: metadata.clone(),
            cursor: cursor.clone(),
            abandoned: abandoned.clone(),
        });
        self.cache.lock().answers.remember(key, answer);
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
    /// The live file's stat and the generation of its contents, both taken under the lock: reads
    /// in several threads record their stats in the order they took them, so a file that only
    /// grows is never seen to shrink, which would read as a rewrite. The lock covers one stat,
    /// never a read of the file's contents.
    fn identify(&self, path: &Path) -> Result<(FileStat, String), ConversationError> {
        let mut state = self.cache.lock();
        let stat = file_stat(&fs::metadata(path).map_err(missing)?);
        let generation = state.generation(path, &stat, &self.ids);
        Ok((stat, generation))
    }

    fn stream(
        &self,
        place: &F::Place,
        stat: &FileStat,
        generation: &str,
    ) -> Result<Stream, ConversationError> {
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
        Ok(Stream {
            cache: self.cache.clone(),
            id: format!("{}{mark}{generation}", stat.node),
            files,
            length,
            floor: 0,
            settings: Vec::new(),
        })
    }

    /// Sets the stream's floor after its last native reset and keeps the latest setting records
    /// (`applyHistoryBoundary`): each appended line is scanned once, in bounded chunks, from where
    /// the last scan of the same stream stopped, and a line longer than the metadata head cannot
    /// be a reset.
    fn apply_history_boundary(&self, path: &Path, stream: &mut Stream) -> io::Result<()> {
        let Some(mark) = self.format.clear_mark() else {
            return Ok(());
        };
        let is_clear = |line: &[u8]| {
            contains(line, mark.as_bytes())
                && parse_line(&String::from_utf8_lossy(line))
                    .is_some_and(|entry| self.format.is_clear(&entry))
        };
        let kept = self.cache.lock().clear_scans.take(&path.to_path_buf());
        let mut scan = match kept {
            Some(scan)
                if scan.source == F::SOURCE
                    && scan.id == stream.id
                    && scan.scanned <= stream.length
                    && stream.bytes_before(scan.scanned)? == scan.tail =>
            {
                scan
            }
            _ => ClearScan {
                source: F::SOURCE,
                id: stream.id.clone(),
                scanned: 0,
                floor: 0,
                tail: Vec::new(),
                settings: [None, None],
            },
        };
        let mut position = scan.scanned;
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
                    scan.floor = base + offset as u64;
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
                        scan.settings[at] = Some((
                            base + offset as u64,
                            base + newline as u64,
                            text.into_owned(),
                        ));
                    }
                }
                skipping = false;
                offset = newline + 1;
                scan.scanned = base + offset as u64;
            }
            carry = bytes[offset..].to_vec();
            // an oversized data record cannot be a native reset
            if carry.len() as u64 > METADATA_HEAD_BYTES {
                carry.clear();
                skipping = true;
            }
            position = end;
        }
        scan.tail = stream.bytes_before(scan.scanned)?;
        let floor = scan.floor;
        stream.settings = scan.settings.iter().flatten().cloned().collect();
        self.cache
            .lock()
            .clear_scans
            .remember(path.to_path_buf(), scan);
        // a valid final record is visible before its newline: it is scanned again once appended to
        stream.floor = if !skipping && !carry.is_empty() && is_clear(&carry) {
            stream.length - carry.len() as u64
        } else {
            floor
        };
        if stream.floor > 0 {
            stream.id = format!("{}-clear-{}", stream.id, radix36(stream.floor));
        }
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
        match self
            .newest_page(F::live_path(place), stream)
            .map_err(missing)?
        {
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
    /// (`newestPage`, read whole). The turn starts found so far are kept, and only the bytes
    /// appended since are scanned. A window that slid past the scanned bytes starts over at its
    /// edge, where a line may be cut and never counts as a start.
    fn newest_page(&self, path: &Path, stream: &Stream) -> io::Result<Option<(u64, Vec<u64>)>> {
        let from = stream
            .floor
            .max(stream.length.saturating_sub(TRANSCRIPT_WINDOW_BYTES));
        let kept = self.cache.lock().live_scans.take(&path.to_path_buf());
        let mut scan = match kept {
            Some(scan)
                if scan.source == F::SOURCE
                    && scan.id == stream.id
                    && scan.scanned <= stream.length
                    && scan.scanned >= from
                    && stream.bytes_before(scan.scanned)? == scan.tail =>
            {
                scan
            }
            _ => LiveScan {
                source: F::SOURCE,
                id: stream.id.clone(),
                scanned: from,
                starts: Vec::new(),
                tail: stream.bytes_before(from)?,
            },
        };
        let mut pending = Vec::new();
        if scan.scanned < stream.length {
            let bytes = stream.read(scan.scanned, stream.length)?;
            let complete = bytes
                .iter()
                .rposition(|byte| *byte == b'\n')
                .map_or(0, |newline| newline + 1);
            let scanned = scan.scanned;
            scan.starts.extend(
                self.turn_starts(&bytes[..complete])
                    .into_iter()
                    .map(|offset| scanned + offset),
            );
            // a last line still without its newline counts now, and is scanned again once complete
            pending = self
                .turn_starts(&bytes[complete..])
                .into_iter()
                .map(|offset| scanned + complete as u64 + offset)
                .collect();
            scan.scanned += complete as u64;
            scan.tail = stream.bytes_before(scan.scanned)?;
        }
        let stale = scan
            .starts
            .iter()
            .position(|offset| *offset >= from)
            .unwrap_or(scan.starts.len());
        scan.starts.drain(..stale);
        let mut starts = scan.starts.clone();
        starts.extend(pending);
        self.cache
            .lock()
            .live_scans
            .remember(path.to_path_buf(), scan);
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
    /// start, kept and extended by any turn that has since been followed, then the live last
    /// turn, each part parsed on its own and the settings folded across.
    fn live_turns(
        &self,
        place: &F::Place,
        stream: &Stream,
        start: u64,
        starts: &[u64],
    ) -> io::Result<(Vec<ConversationTurn>, ConversationMetadata)> {
        let path = F::live_path(place);
        // starts ascend: the last one, when it lies past the page start
        let last = start.max(starts.last().copied().unwrap_or(start));
        let key = (path.to_path_buf(), start);
        let kept = self.cache.lock().settled.take(&key);
        let mut settled = match kept {
            Some(settled)
                if settled.source == F::SOURCE
                    && settled.id == stream.id
                    && settled.end <= last
                    && settled.carry.is::<F::Carry>()
                    && stream.bytes_before(settled.end)? == settled.tail =>
            {
                settled
            }
            _ => {
                let head = if start > stream.floor {
                    self.metadata_head(place, stream, start)?
                } else {
                    String::new()
                };
                Settled {
                    source: F::SOURCE,
                    id: stream.id.clone(),
                    end: start,
                    turns: Vec::new(),
                    metadata: self.format.metadata(&format!("{head}\n"), None),
                    tail: stream.bytes_before(start)?,
                    carry: Box::new(F::Carry::default()),
                }
            }
        };
        let carry = settled
            .carry
            .downcast_mut::<F::Carry>()
            .expect("the carry of its format, checked above");
        if settled.end < last {
            let text = stream.text(settled.end, last)?;
            settled.turns.extend(self.format.parse_turns(&text, carry));
            settled.metadata = self.format.metadata(&text, Some(settled.metadata));
            settled.end = last;
            settled.tail = stream.bytes_before(last)?;
        }
        // the live turn is parsed again on every read: what it delivers is kept only once it
        // settles
        let live_carry = carry.clone();
        let mut turns = settled.turns.clone();
        let before = settled.metadata.clone();
        self.cache.lock().settled.remember(key, settled);
        if let Some(parser) = self.format.live_parser() {
            let (live, metadata) = self.live_turn(path, stream, last, before, parser)?;
            turns.extend(live);
            return Ok((turns, metadata));
        }
        let text = stream.text(last, stream.length)?;
        turns.extend(self.format.parse_live(&text, live_carry));
        let metadata = self.format.metadata(&text, Some(before));
        Ok((turns, metadata))
    }

    /// The live turn from `start`, read incrementally through the format's live parser
    /// (`codexLiveTurn`): its complete lines are parsed once, results for tools of earlier reads
    /// included; `fresh` starts the parse when none of the same turn is kept.
    fn live_turn(
        &self,
        path: &Path,
        stream: &Stream,
        start: u64,
        before: ConversationMetadata,
        fresh: Box<dyn LiveParser>,
    ) -> io::Result<(Vec<ConversationTurn>, ConversationMetadata)> {
        let kept = self.cache.lock().live_turns.take(&path.to_path_buf());
        let mut turn = match kept {
            Some(turn)
                if turn.source == F::SOURCE
                    && turn.id == stream.id
                    && turn.start == start
                    && turn.scanned <= stream.length
                    && stream.bytes_before(turn.scanned)? == turn.boundary =>
            {
                turn
            }
            _ => LiveTurn {
                source: F::SOURCE,
                id: stream.id.clone(),
                start,
                scanned: start,
                boundary: stream.bytes_before(start)?,
                parser: fresh,
                metadata: before,
            },
        };
        let bytes = stream.read(turn.scanned, stream.length)?;
        let complete = bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |newline| newline + 1);
        if complete > 0 {
            let text = String::from_utf8_lossy(&bytes[..complete]);
            turn.parser.write(&text);
            turn.metadata = self.format.metadata(&text, Some(turn.metadata));
            turn.scanned += complete as u64;
            turn.boundary = stream.bytes_before(turn.scanned)?;
        }
        let tail = String::from_utf8_lossy(&bytes[complete..]);
        let turns = turn.parser.snapshot(&tail);
        let metadata = self.format.metadata(&tail, Some(turn.metadata.clone()));
        let mut state = self.cache.lock();
        state.live_turns.remember(path.to_path_buf(), turn);
        state.bound_live_turns();
        Ok((turns, metadata))
    }

    /// The text whose settings stand before a page starting at `start` (`metadataHead`).
    fn metadata_head(&self, place: &F::Place, stream: &Stream, start: u64) -> io::Result<String> {
        if self.format.metadata_head() == MetadataHead::LiveFileStart {
            let mut bytes = Vec::new();
            self.cache
                .read_file(F::live_path(place), 0, METADATA_HEAD_BYTES, &mut bytes)?;
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
