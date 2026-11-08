//! omp's session transcripts: a log of pi-family records (`~/.omp/agent/sessions/<cwd-slug>/`),
//! read with the parser pi shares (`parseOmpTranscript` without tool images), reset by a
//! `context_clear` record. omp shows no image: its tool results would carry refs nothing answers.

use std::path::Path;

use protocol::{ConversationMetadata, ConversationSource, ConversationTurn};
use serde_json::Value;

use crate::format::TranscriptFormat;
use crate::records::{
    context_of, lines, metadata_label, metadata_start, parse_line, parse_omp_transcript,
    pi_context_clear, pi_message, pi_opens_turn, pi_results, record, text, token_count,
};

pub(crate) struct Omp;

impl TranscriptFormat for Omp {
    type Place = Path;
    type Carry = ();

    const SOURCE: ConversationSource = ConversationSource::OmpTranscript;

    fn live_path(place: &Path) -> &Path {
        place
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

    fn parse_turns(&self, text: &str, _carry: &mut ()) -> Vec<ConversationTurn> {
        parse_omp_transcript(text, false)
    }

    /// Recorded settings, never inferred: a model or thinking-level change is a record of its own,
    /// and a turn answers at the model it ran at. omp states no window, so the context use stays
    /// with the rule a Claude model's figure follows (`parseConversationMetadata`).
    fn metadata(
        &self,
        text_of_page: &str,
        before: Option<ConversationMetadata>,
    ) -> ConversationMetadata {
        let mut metadata = metadata_start(before);
        for line in lines(text_of_page) {
            let Some(parsed) = parse_line(line) else {
                continue;
            };
            let entry = record(Some(&parsed));
            if pi_context_clear(&parsed) {
                metadata = metadata_start(None);
                continue;
            }
            match text(entry, "type") {
                Some("model_change") => metadata.model = metadata_label(entry.get("modelId")),
                Some("thinking_level_change") => {
                    metadata.reasoning_effort = metadata_label(entry.get("thinkingLevel"))
                }
                _ => {}
            }
            let Some(message) =
                pi_message(&parsed).filter(|message| text(message, "role") == Some("assistant"))
            else {
                continue;
            };
            if let Some(model) = metadata_label(message.get("model")) {
                metadata.model = Some(model);
            }
            let usage = record(message.get("usage"));
            let used = token_count(usage.get("input"))
                + token_count(usage.get("cacheRead"))
                + token_count(usage.get("cacheWrite"));
            metadata.context = context_of(used, metadata.model.as_deref(), None, metadata.context);
        }
        metadata
    }

    fn output_in_entry(&self, entry: &Value, reference: &str) -> Option<String> {
        let message = pi_message(entry)?;
        pi_results(&message)
            .into_iter()
            .find(|result| result.id == reference)
            .map(|result| result.text)
    }
}
