//! What tells one transcript source from another: every place `server/conversation.ts` branches on
//! the source (`transcriptStream`, `applyHistoryBoundary`, `opensTurn`, `TURN_MARK`, `parseTurns`,
//! `liveTurns`, `metadataHead`, `parseConversationMetadata`, `outputInText`, `activeHistoryText`,
//! the image readers and `piAbandonedTurns`) is a method here, and `paging.rs` reads every source
//! through it (ADR 0192-phase-2-split, "transcript の seam").

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use protocol::js::{cut_utf16, utf16_len};
use protocol::{AbandonedTurns, ConversationMetadata, ConversationSource, ConversationTurn};
use regex::Regex;
use serde_json::Value;

use crate::Image;
use crate::errors::ConversationError;
use crate::records::{lines, parse_line};

/// A byte range of one file that the conversation's stream is laid out from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Segment {
    pub(crate) path: PathBuf,
    pub(crate) start: u64,
    pub(crate) end: u64,
}

/// A segment as it lies in the stream: `start` in the stream, `offset` in its file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StreamFile {
    pub(crate) path: PathBuf,
    pub(crate) start: u64,
    pub(crate) length: u64,
    pub(crate) offset: u64,
}

/// Where the metadata of the text before a page is read from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MetadataHead {
    /// From the history boundary (the last `/clear`), with the setting records found between that
    /// head and the page.
    SinceBoundary,
    /// From the start of the live file: Codex settings belong to the live rollout.
    LiveFileStart,
}

pub(crate) trait TranscriptFormat: Send + Sync {
    /// Where a transcript of this source is: its file, and what else reading it takes (the Codex
    /// home).
    type Place: ?Sized;
    /// What the parse of one part of a page hands to the parse of the next (Claude's deliveries of
    /// other sessions' messages, `peersSeen`): a page's settled turns and its live last turn are
    /// parsed apart. It is kept with the settled turns between reads.
    type Carry: Default + Clone + Send + 'static;

    const SOURCE: ConversationSource;

    /// The live file: the one whose identity names the conversation.
    fn live_path(place: &Self::Place) -> &Path;

    /// The byte ranges the conversation is read from, in order (a Codex rollout's history before
    /// it, a pi branch). By default the whole live file. `size` is the live file's size when it
    /// was identified.
    fn segments(&self, place: &Self::Place, size: u64) -> Result<Vec<Segment>, ConversationError> {
        Ok(vec![Segment {
            path: Self::live_path(place).to_path_buf(),
            start: 0,
            end: size,
        }])
    }

    /// What `history_id` adds for the layout (a Codex chain, a pi branch): a cursor names the
    /// layout too, so a read against another one answers HistoryChanged. Empty by default.
    fn layout_mark(&self, _files: &[StreamFile]) -> String {
        String::new()
    }

    /// The bytes every native reset record holds, a cheap filter before the JSON is read; `None`
    /// when the source has no reset (Codex).
    fn clear_mark(&self) -> Option<&'static str> {
        None
    }

    /// Is this record a native reset (`/clear`, a `context_clear` record)?
    fn is_clear(&self, _entry: &Value) -> bool {
        false
    }

    /// Does the boundary scan keep the latest model and thinking-level records (the pi family)?
    fn keeps_settings(&self) -> bool {
        false
    }

    /// Bytes one of which every line opening a turn contains.
    fn turn_marks(&self) -> &'static [&'static str];

    /// Does this record open a turn? A page starts at such a line, so it never splits a turn.
    fn opens_turn(&self, entry: &Value) -> bool;

    /// The turns of a page's text, in order.
    fn parse_turns(&self, text: &str, carry: &mut Self::Carry) -> Vec<ConversationTurn>;

    /// The turns of the newest page's last turn, still being written, after the settled ones.
    fn parse_live(&self, text: &str, carry: Self::Carry) -> Vec<ConversationTurn> {
        let mut carry = carry;
        self.parse_turns(text, &mut carry)
    }

    /// A parser that the newest page's live last turn is folded into a complete line at a time,
    /// kept between reads so an append is parsed alone (Codex, `codexLiveTurn`); `None`, the
    /// default: the live turn is parsed whole on every read (`parse_live`).
    fn live_parser(&self) -> Option<Box<dyn LiveParser>> {
        None
    }

    /// The settings recorded in `text`, folded onto what the text before said (`before`).
    fn metadata(&self, text: &str, before: Option<ConversationMetadata>) -> ConversationMetadata;

    fn metadata_head(&self) -> MetadataHead {
        MetadataHead::SinceBoundary
    }

    /// The turns on paths a `/tree` walked away from (pi); `None` for a source with no entry tree.
    fn abandoned(&self, _place: &Self::Place, _size: u64) -> Option<AbandonedTurns> {
        None
    }

    /// The whole output a transcript holds for one tool call. By default the live file read whole,
    /// from its last reset on.
    fn tool_output(&self, place: &Self::Place, reference: &str) -> Option<String> {
        let bytes = std::fs::read(Self::live_path(place)).ok()?;
        output_in_text(self, &String::from_utf8_lossy(&bytes), reference)
    }

    /// The output one record holds for the tool call `reference`, whole.
    fn output_in_entry(&self, entry: Value, reference: &str) -> Option<String>;

    /// An image a ref names, decoded.
    /// `None` by default: the source shows no image.
    fn image(&self, _place: &Self::Place, _reference: &str) -> Option<Image> {
        None
    }
}

/// The parse of a live turn, fed its complete lines as they are appended
/// (`createCodexTranscriptParser`).
pub(crate) trait LiveParser: Send {
    /// Folds complete lines in.
    fn write(&mut self, text: &str);

    /// The turns so far, with `tail` (a last line still without its newline) read as if it were
    /// complete but not kept: the writer can still extend it.
    fn snapshot(&self, tail: &str) -> Vec<ConversationTurn>;
}

/// The refs a tool output is asked by.
pub(crate) static TOOL_REF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_:.-]{1,128}$").expect("TOOL_REF"));

/// A whole output is still bounded: a page of it, not a log file.
const TOOL_OUTPUT_MAX: usize = 2_000_000;

/// The output `text` holds for one tool call, from its last reset on (`outputInText`).
pub(crate) fn output_in_text<F: TranscriptFormat + ?Sized>(
    format: &F,
    text: &str,
    reference: &str,
) -> Option<String> {
    let text = active_history_text(format, text);
    let needle = serde_json::to_string(reference).ok()?;
    for line in lines(text) {
        if !line.contains(&needle) {
            continue;
        }
        let Some(entry) = parse_line(line) else {
            continue;
        };
        if let Some(output) = format.output_in_entry(entry, reference) {
            return Some(if utf16_len(&output) > TOOL_OUTPUT_MAX {
                format!("{}\n… trimmed", cut_utf16(&output, TOOL_OUTPUT_MAX))
            } else {
                output
            });
        }
    }
    None
}

/// `text` from its last reset on: an asset read shares the boundary, also when its ref predates
/// the `/clear` (`activeHistoryText`).
pub(crate) fn active_history_text<'a, F: TranscriptFormat + ?Sized>(
    format: &F,
    text: &'a str,
) -> &'a str {
    if format.clear_mark().is_none() {
        return text;
    }
    let mut start = 0;
    let mut offset = 0;
    for line in lines(text) {
        if (line.contains("context_clear") || line.contains("/clear"))
            && parse_line(line).is_some_and(|entry| format.is_clear(&entry))
        {
            start = offset + line.len() + 1;
        }
        offset += line.len() + 1;
    }
    &text[start.min(text.len())..]
}
