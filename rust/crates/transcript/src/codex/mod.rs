//! Codex's rollouts (`<codex home>/sessions/<y>/<m>/<d>/…`): a stub until #202 moves
//! `server/codex.ts`, `server/codex-images.ts` and their branches of `server/conversation.ts`
//! here. The paging engine never calls it before then: only the codex cases reach it, and #202
//! runs them.

use std::path::Path;

use protocol::{ConversationMetadata, ConversationSource, ConversationTurn, QueuedQuestion};
use serde_json::Value;

use crate::CodexRollout;
use crate::format::TranscriptFormat;

pub(crate) struct Codex;

impl Codex {
    /// The questions a rollout asked that hold no answer yet (`unansweredCodexQuestions`).
    pub(crate) fn unanswered_questions(&self, _rollout: &CodexRollout) -> Vec<QueuedQuestion> {
        todo!("#202: Codex rollouts")
    }
}

impl TranscriptFormat for Codex {
    type Place = CodexRollout;
    type Carry = ();

    const SOURCE: ConversationSource = ConversationSource::CodexTranscript;

    fn live_path(place: &CodexRollout) -> &Path {
        &place.path
    }

    fn turn_marks(&self) -> &'static [&'static str] {
        todo!("#202: Codex rollouts")
    }

    fn opens_turn(&self, _entry: &Value) -> bool {
        todo!("#202: Codex rollouts")
    }

    fn parse_turns(&self, _text: &str, _carry: &mut ()) -> Vec<ConversationTurn> {
        todo!("#202: Codex rollouts")
    }

    fn metadata(&self, _text: &str, _before: Option<ConversationMetadata>) -> ConversationMetadata {
        todo!("#202: Codex rollouts")
    }

    fn output_in_entry(&self, _entry: Value, _reference: &str) -> Option<String> {
        todo!("#202: Codex rollouts")
    }
}
