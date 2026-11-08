//! Codex's rollouts (`<codex home>/sessions/<y>/<m>/<d>/…`): `server/codex.ts`,
//! `server/codex-images.ts` and the Codex branches of `server/conversation.ts` and
//! `server/conversation-metadata.ts`. A conversation is read across the rollouts a paginated one
//! continues (`chain`), its records are folded into turns (`parser`), and its attachments are read
//! when asked for (`images`).
//!
//! What finds a pane's rollout (the matching of a screen against rollouts, `resumedThread`, the
//! Codex home of a process) is the core's, not moved here (ADR 0192-phase-2-split).

mod chain;
mod images;
mod memory;
mod parser;
mod questions;
mod skills;

use std::fs::File;
use std::io::Read;
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use protocol::{ConversationMetadata, ConversationSource, ConversationTurn, QueuedQuestion};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::errors::ConversationError;
use crate::format::{MetadataHead, Segment, StreamFile, TranscriptFormat, output_in_text};
use crate::paging::file_stat;
use crate::records::{
    context_of, lines, metadata_label, metadata_start, parse_line, record, token_count,
};
use crate::{CodexRollout, Image};

use chain::Chains;
use parser::{content_text, string};
use questions::Questions;

/// Codex's reader, with what it keeps between reads: the chains of rollouts found and the scans
/// of unanswered questions. Each `Transcripts` value holds its own.
pub(crate) struct Codex {
    chains: Chains,
    questions: Questions,
}

/// A new reader, under the name `lib.rs` builds one by (`codex::Codex`, written when the reader
/// kept nothing; that file is not this module's to change, ADR 0192-phase-2-split). Every use of a
/// `const` is a new value, so each `Transcripts` gets a reader of its own, as `Codex::new()` would.
#[allow(non_upper_case_globals, clippy::declare_interior_mutable_const)]
pub(crate) const Codex: Codex = Codex::new();

impl Codex {
    const fn new() -> Self {
        Self {
            chains: Chains::new(),
            questions: Questions::new(),
        }
    }

    /// The questions a rollout asked that hold no answer yet (`unansweredCodexQuestions`); none
    /// for a rollout it cannot read.
    pub(crate) fn unanswered_questions(&self, rollout: &CodexRollout) -> Vec<QueuedQuestion> {
        self.questions.unanswered(&rollout.path)
    }

    /// The conversation's files as they stand now, the live one whole; `None` when it is gone.
    fn segments_now(&self, place: &CodexRollout) -> Option<Vec<Segment>> {
        let size = std::fs::metadata(&place.path).ok()?.len();
        Some(self.chains.segments(&place.path, &place.home, size))
    }
}

/// The first `end` bytes of a file as text (`readRange(path, 0, end)`).
fn read_range(path: &Path, end: u64) -> std::io::Result<String> {
    let mut bytes = Vec::new();
    File::open(path)?.take(end).read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

impl TranscriptFormat for Codex {
    type Place = CodexRollout;
    type Carry = ();

    const SOURCE: ConversationSource = ConversationSource::CodexTranscript;

    fn live_path(place: &CodexRollout) -> &Path {
        &place.path
    }

    /// The history a paginated rollout continues comes first (`codexHistorySegments`).
    fn segments(&self, place: &CodexRollout, size: u64) -> Result<Vec<Segment>, ConversationError> {
        Ok(self.chains.segments(&place.path, &place.home, size))
    }

    /// Positions count from the start of the whole chain: a cursor names the live file AND the
    /// rollouts before it, so a read against another chain (an earlier rollout found later, a
    /// parent since archived) answers HistoryChanged instead of pointing at other turns.
    fn layout_mark(&self, files: &[StreamFile]) -> String {
        let Some((_, earlier)) = files.split_last() else {
            return String::new();
        };
        if earlier.is_empty() {
            return String::new();
        }
        let layout: Vec<String> = earlier
            .iter()
            .map(|file| {
                let identity = std::fs::metadata(&file.path)
                    .map_or_else(|_| "-".to_owned(), |meta| file_stat(&meta).node);
                format!(
                    "{}\0{}\0{identity}",
                    file.path.to_string_lossy(),
                    file.length
                )
            })
            .collect();
        let mut mark = URL_SAFE_NO_PAD.encode(Sha256::digest(layout.join("\n").as_bytes()));
        mark.truncate(10);
        format!("-{mark}")
    }

    fn turn_marks(&self) -> &'static [&'static str] {
        &["\"task_started\""]
    }

    /// A Codex task opens a turn: its prompt, duplicate records and tool calls all follow it.
    fn opens_turn(&self, entry: &Value) -> bool {
        let entry = record(Some(entry));
        string(entry, "type") == "event_msg"
            && string(record(entry.get("payload")), "type") == "task_started"
    }

    fn parse_turns(&self, text: &str, _carry: &mut ()) -> Vec<ConversationTurn> {
        parser::parse(text)
    }

    /// Recorded settings, never inferred: `turn_context` is a snapshot, and a new complete context
    /// without an effort does not keep an older one. The context use is what the last request
    /// filled, against the window Codex itself states.
    fn metadata(&self, text: &str, before: Option<ConversationMetadata>) -> ConversationMetadata {
        let mut metadata = metadata_start(before);
        for line in lines(text) {
            let Some(parsed) = parse_line(line) else {
                continue;
            };
            let entry = record(Some(&parsed));
            let payload = record(entry.get("payload"));
            let kind = string(entry, "type");
            if kind == "event_msg" && string(payload, "type") == "token_count" {
                let info = record(payload.get("info"));
                let window = token_count(info.get("model_context_window"));
                let used = token_count(record(info.get("last_token_usage")).get("total_tokens"));
                metadata.context = context_of(
                    used,
                    metadata.model.as_deref(),
                    (window != 0.0).then_some(window),
                    metadata.context,
                );
                continue;
            }
            if kind != "turn_context" && kind != "session_meta" {
                continue;
            }
            let settings = record(record(payload.get("collaboration_mode")).get("settings"));
            let model = metadata_label(payload.get("model"))
                .or_else(|| metadata_label(settings.get("model")));
            // a field recorded as null still states the effort: none
            let effort = if payload.contains_key("effort") {
                payload.get("effort")
            } else if payload.contains_key("reasoning_effort") {
                payload.get("reasoning_effort")
            } else {
                settings.get("reasoning_effort")
            };
            if model.is_some() || effort.is_some() {
                metadata.reasoning_effort = metadata_label(effort);
            }
            if model.is_some() {
                metadata.model = model;
            }
        }
        metadata
    }

    /// Codex settings belong to the live rollout.
    fn metadata_head(&self) -> MetadataHead {
        MetadataHead::LiveFileStart
    }

    /// Each file of the conversation in turn, from the oldest; a rollout archived since the chain
    /// was found is passed over, the others still hold theirs.
    fn tool_output(&self, place: &CodexRollout, reference: &str) -> Option<String> {
        for segment in self.segments_now(place)? {
            let Ok(text) = read_range(&segment.path, segment.end) else {
                continue;
            };
            if let Some(output) = output_in_text(self, &text, reference) {
                return Some(output);
            }
        }
        None
    }

    fn output_in_entry(&self, entry: Value, reference: &str) -> Option<String> {
        let payload = record(entry.get("payload"));
        let kind = string(payload, "type");
        ((kind == "function_call_output" || kind == "custom_tool_call_output")
            && payload.get("call_id").and_then(Value::as_str) == Some(reference))
        .then(|| content_text(payload.get("output"), false))
    }

    /// A user's attachment, by the hash a page named it with; only the conversation's own
    /// history is searched, including the rollouts it continues.
    fn image(&self, place: &CodexRollout, reference: &str) -> Option<Image> {
        if !images::is_image_ref(reference) {
            return None;
        }
        images::transcript_image(&self.segments_now(place)?, reference, &place.cwd)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The core may hold several `Transcripts`: what one reader keeps is its own (ADR
    // 0192-phase-2-split, "transcript の seam").
    #[test]
    fn each_reader_keeps_its_own_state() {
        let (first, second) = (Codex, Codex);
        let rollout = Path::new("/nonexistent/sessions/rollout.jsonl");
        first.chains.segments(rollout, Path::new("/nonexistent"), 0);
        assert!(first.chains.remembers(rollout));
        assert!(!second.chains.remembers(rollout));
    }
}
