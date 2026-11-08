//! pi's session files (`~/.pi/agent/sessions/<cwd-slug>/`): an entry tree, read on the branch its
//! leaf stands on (`tree.rs`), with the parser pi shares with omp, its tool images and its own
//! context figure (pi's branches of `server/conversation.ts` and
//! `server/conversation-metadata.ts`).

mod tree;

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::LazyLock;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use protocol::{
    AbandonedTurns, ContextUsage, ConversationMetadata, ConversationSource, ConversationTurn,
};
use regex::Regex;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::errors::{ConversationError, UnavailableReason};
use crate::format::{Segment, StreamFile, TranscriptFormat, output_in_text};
use crate::records::{
    decode_base64_leniently, lines, metadata_label, metadata_start, parse_line,
    parse_omp_transcript, pi_context_clear, pi_image_block, pi_message, pi_opens_turn, pi_results,
    record, text, token_count,
};
use crate::{Image, PiContextWindow};

use self::tree::{Indexes, Range};

pub(crate) struct Pi {
    /// a model's context window from pi's catalog (`piContextWindow`)
    context_window: PiContextWindow,
    /// the entry trees of the files this reader has read
    indexes: Indexes,
}

impl Pi {
    pub(crate) fn new(context_window: PiContextWindow) -> Self {
        Self {
            context_window,
            indexes: Indexes::default(),
        }
    }

    /// The text of each range of the active branch that reads whole, in order, each read when the
    /// caller reaches it; `None` when the branch cannot be read. An output or an image is offered
    /// on the active branch only: one on a branch a /tree abandoned is one the chat never showed.
    fn branch_texts(&self, path: &Path) -> Option<impl Iterator<Item = String>> {
        let size = std::fs::metadata(path).ok()?.len();
        let branch = self.indexes.branch(path, size).ok()??;
        let mut file = File::open(path).ok()?;
        Some(
            branch
                .into_iter()
                .filter_map(move |range| read_range(&mut file, &range)),
        )
    }
}

/// One range of the file, or `None` when it no longer reads whole.
fn read_range(file: &mut File, range: &Range) -> Option<String> {
    let length = range.end - range.start;
    file.seek(SeekFrom::Start(range.start)).ok()?;
    let mut bytes = Vec::new();
    file.take(length).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 == length).then(|| String::from_utf8_lossy(&bytes).into_owned())
}

/// The refs a pi tool image is asked by: `pi:<call id>:<nth image>`.
static PI_IMAGE_REF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^pi:([A-Za-z0-9_:.\-]{1,128}):(\d{1,3})$").expect("PI_IMAGE_REF")
});

impl TranscriptFormat for Pi {
    type Place = Path;
    type Carry = ();

    const SOURCE: ConversationSource = ConversationSource::PiTranscript;

    fn live_path(place: &Path) -> &Path {
        place
    }

    /// The active branch, which skips the side paths a /tree left behind.
    fn segments(&self, place: &Path, size: u64) -> Result<Vec<Segment>, ConversationError> {
        let branch = self.indexes.branch(place, size).map_err(|_| {
            ConversationError::ConversationUnavailable(UnavailableReason::TranscriptMissing)
        })?;
        let branch = branch.ok_or(ConversationError::ConversationUnavailable(
            UnavailableReason::BranchUnreadable,
        ))?;
        Ok(branch
            .into_iter()
            .map(|range| Segment {
                path: place.to_path_buf(),
                start: range.start,
                end: range.end,
            })
            .collect())
    }

    /// A branch is laid out from one file, so its layout names the conversation: /tree moves it to
    /// other bytes while the file, its inode and its size all stay put. Every range counts by
    /// where it starts, and by where it ends except the last, which grows with every append. Two
    /// /tree moves away from the same entry differ only where their tails begin.
    fn layout_mark(&self, files: &[StreamFile]) -> String {
        let layout = files
            .iter()
            .enumerate()
            .map(|(at, file)| {
                if at == files.len() - 1 {
                    file.offset.to_string()
                } else {
                    format!("{}\0{}", file.offset, file.length)
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        let mut digest = URL_SAFE_NO_PAD.encode(Sha256::digest(layout.as_bytes()));
        digest.truncate(10);
        format!("-{digest}")
    }

    fn clear_mark(&self) -> Option<&'static str> {
        Some("context_clear")
    }

    fn is_clear(&self, entry: &Value) -> bool {
        pi_context_clear(entry)
    }

    fn keeps_settings(&self) -> bool {
        true
    }

    fn turn_marks(&self) -> &'static [&'static str] {
        &["\"user\""]
    }

    fn opens_turn(&self, entry: &Value) -> bool {
        pi_opens_turn(entry)
    }

    /// pi keeps a tool's images in the entry as base64, so its pages name them.
    fn parse_turns(&self, text: &str, _carry: &mut ()) -> Vec<ConversationTurn> {
        parse_omp_transcript(text, true)
    }

    /// Recorded settings, never inferred. pi states the provider on the records that state usage,
    /// so the window is asked of pi's catalog for what this text says; unresolved, no window is
    /// given rather than a guess.
    fn metadata(
        &self,
        text_of_page: &str,
        before: Option<ConversationMetadata>,
    ) -> ConversationMetadata {
        let mut metadata = metadata_start(before);
        let mut provider: Option<String> = None;
        for line in lines(text_of_page) {
            let Some(parsed) = parse_line(line) else {
                continue;
            };
            if pi_context_clear(&parsed) {
                metadata = metadata_start(None);
                provider = None;
                continue;
            }
            let entry = record(Some(&parsed));
            match text(entry, "type") {
                Some("model_change") => {
                    metadata.model = metadata_label(entry.get("modelId"));
                    provider = metadata_label(entry.get("provider"));
                }
                Some("thinking_level_change") => {
                    metadata.reasoning_effort = metadata_label(entry.get("thinkingLevel"))
                }
                _ => {}
            }
            let Some(message) =
                pi_message(parsed).filter(|message| text(message, "role") == Some("assistant"))
            else {
                continue;
            };
            // a turn answers at whatever model it ran at, and that is the one the window belongs to
            if let Some(model) = metadata_label(message.get("model")) {
                metadata.model = Some(model);
                if let Some(served) = metadata_label(message.get("provider")) {
                    provider = Some(served);
                }
            }
            // pi's own figure for what one request filled: it counts the answer too, and leaves a
            // failed or aborted request out, which filled nothing
            let usage = record(message.get("usage"));
            let filled = if matches!(text(&message, "stopReason"), Some("error" | "aborted")) {
                0.0
            } else {
                match token_count(usage.get("totalTokens")) {
                    0.0 => {
                        token_count(usage.get("input"))
                            + token_count(usage.get("output"))
                            + token_count(usage.get("cacheRead"))
                            + token_count(usage.get("cacheWrite"))
                    }
                    total => total,
                }
            };
            if filled != 0.0 {
                let window = metadata
                    .model
                    .as_deref()
                    .and_then(|model| (self.context_window)(model, provider.as_deref()));
                metadata.context = Some(ContextUsage {
                    used: filled,
                    window,
                });
            }
        }
        metadata
    }

    /// The abandoned turns live outside the branch's byte ranges, so the page cannot see them.
    fn abandoned(&self, place: &Path, size: u64) -> Option<AbandonedTurns> {
        self.indexes.abandoned(place, size)
    }

    /// Read on the active branch, the way the conversation is.
    fn tool_output(&self, place: &Path, reference: &str) -> Option<String> {
        self.branch_texts(place)?
            .find_map(|text| output_in_text(self, &text, reference))
    }

    fn output_in_entry(&self, entry: Value, reference: &str) -> Option<String> {
        let message = pi_message(entry)?;
        pi_results(&message)
            .into_iter()
            .find(|result| result.id == reference)
            .map(|result| result.text)
    }

    /// The image a pi tool call returned, by the ref the page gave it, on the active branch only.
    fn image(&self, place: &Path, reference: &str) -> Option<Image> {
        let captures = PI_IMAGE_REF.captures(reference)?;
        let call_id = captures.get(1)?.as_str();
        let nth: usize = captures.get(2)?.as_str().parse().ok()?;
        for text in self.branch_texts(place)? {
            for line in lines(&text) {
                if !line.contains(call_id) {
                    continue;
                }
                let Some(message) = parse_line(line).and_then(pi_message) else {
                    continue;
                };
                if let Some((media_type, data)) = pi_image_block(&message, call_id, nth) {
                    return Some(Image {
                        media_type,
                        bytes: decode_base64_leniently(&data),
                    });
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests;
