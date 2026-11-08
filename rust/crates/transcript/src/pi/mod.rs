//! pi's session files (`~/.pi/agent/sessions/<cwd-slug>/`): an entry tree, read on the branch its
//! leaf stands on. A stub until #203 moves `server/pi-tree.ts` and pi's branches of
//! `server/conversation.ts` and `server/conversation-metadata.ts` here. The paging engine never
//! calls it before then: only the pi cases reach it, and #203 runs them.

use std::path::Path;

use protocol::{ConversationMetadata, ConversationSource, ConversationTurn};
use serde_json::Value;

use crate::PiContextWindow;
use crate::format::TranscriptFormat;

pub(crate) struct Pi {
    /// a model's context window from pi's catalog (`piContextWindow`)
    #[expect(dead_code, reason = "#203 reads it for pi's context use")]
    context_window: PiContextWindow,
}

impl Pi {
    pub(crate) fn new(context_window: PiContextWindow) -> Self {
        Self { context_window }
    }
}

impl TranscriptFormat for Pi {
    type Place = Path;
    type Carry = ();

    const SOURCE: ConversationSource = ConversationSource::PiTranscript;

    fn live_path(place: &Path) -> &Path {
        place
    }

    fn turn_marks(&self) -> &'static [&'static str] {
        todo!("#203: pi sessions")
    }

    fn opens_turn(&self, _entry: &Value) -> bool {
        todo!("#203: pi sessions")
    }

    fn parse_turns(&self, _text: &str, _carry: &mut ()) -> Vec<ConversationTurn> {
        todo!("#203: pi sessions")
    }

    fn metadata(&self, _text: &str, _before: Option<ConversationMetadata>) -> ConversationMetadata {
        todo!("#203: pi sessions")
    }

    fn output_in_entry(&self, _entry: Value, _reference: &str) -> Option<String> {
        todo!("#203: pi sessions")
    }
}
