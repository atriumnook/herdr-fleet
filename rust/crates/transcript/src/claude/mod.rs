//! Claude Code's session transcripts (`~/.claude/projects/<project>/<session>.jsonl`): a stub until
//! #201 moves `parseClaudeTranscript` and its branches of `server/conversation.ts` here. The paging
//! engine never calls it before then: only the claude cases reach it, and #201 runs them.

use std::path::Path;

use protocol::{ConversationMetadata, ConversationSource, ConversationTurn};
use serde_json::Value;

use crate::format::TranscriptFormat;

pub(crate) struct Claude;

impl TranscriptFormat for Claude {
    type Place = Path;
    type Carry = ();

    const SOURCE: ConversationSource = ConversationSource::ClaudeTranscript;

    fn live_path(place: &Path) -> &Path {
        place
    }

    fn turn_marks(&self) -> &'static [&'static str] {
        todo!("#201: Claude Code transcripts")
    }

    fn opens_turn(&self, _entry: &Value) -> bool {
        todo!("#201: Claude Code transcripts")
    }

    fn parse_turns(&self, _text: &str, _carry: &mut ()) -> Vec<ConversationTurn> {
        todo!("#201: Claude Code transcripts")
    }

    fn metadata(&self, _text: &str, _before: Option<ConversationMetadata>) -> ConversationMetadata {
        todo!("#201: Claude Code transcripts")
    }

    fn output_in_entry(&self, _entry: &Value, _reference: &str) -> Option<String> {
        todo!("#201: Claude Code transcripts")
    }
}
