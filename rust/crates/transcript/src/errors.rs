//! What a conversation read can say instead of turns (`server/conversation-errors.ts`, and
//! `ConversationNotStarted` of `server/conversation.ts`). The decisions: ADR 0196-transcript-interface.

use std::fmt;

use protocol::ConversationSource;

use crate::opencode::OpencodeError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConversationError {
    /// A cursor from another transcript: the pane started a new session, a native `/clear` reset
    /// it, or a Codex backtrack replaced the file. The chat reloads from the newest turns.
    HistoryChanged,
    /// No conversation to read, for this reason.
    ConversationUnavailable(UnavailableReason),
    /// The pane's agent holds a session it has not written yet: a conversation with no turns, not
    /// a missing one. Only the core's path resolution finds it (`server/conversation.ts:416`); its
    /// reason is always `session_not_written`.
    ConversationNotStarted {
        session_id: String,
        source: ConversationSource,
        identity: String,
    },
    /// OpenCode's CLI failed otherwise than the reader can answer (a timeout, a body that is not
    /// JSON, a 500): only `OpencodeConversations` returns it, and the route answers it as an
    /// internal error (`server/opencode-session.ts:310`).
    Opencode(OpencodeError),
}

/// Why a conversation cannot be read, of those the readers in this crate find. The core's path
/// resolution has reasons of its own (`no_session_path` and the like) in its own error type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnavailableReason {
    /// The transcript is gone, or went unreadable mid-read.
    TranscriptMissing,
    /// A pi branch cannot be walked.
    BranchUnreadable,
    /// OpenCode's background service does not answer.
    OpencodeServiceStopped,
    /// OpenCode has no such session.
    OpencodeSessionMissing,
    /// An OpenCode revert hides more than a page can reach back through.
    OpencodeRevertTooDeep,
}

impl UnavailableReason {
    /// The reason as TypeScript spells it (`ConversationUnavailable.message`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TranscriptMissing => "transcript_missing",
            Self::BranchUnreadable => "branch_unreadable",
            Self::OpencodeServiceStopped => "opencode_service_stopped",
            Self::OpencodeSessionMissing => "opencode_session_missing",
            Self::OpencodeRevertTooDeep => "opencode_revert_too_deep",
        }
    }
}

impl ConversationError {
    /// The reason an unavailable conversation gives; `None` for `HistoryChanged` and for an
    /// OpenCode failure.
    pub fn reason(&self) -> Option<&'static str> {
        match self {
            Self::HistoryChanged | Self::Opencode(_) => None,
            Self::ConversationUnavailable(reason) => Some(reason.as_str()),
            Self::ConversationNotStarted { .. } => Some("session_not_written"),
        }
    }
}

impl fmt::Display for ConversationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HistoryChanged => formatter.write_str(
                "the conversation's transcript changed; reload it from its newest turns",
            ),
            Self::Opencode(error) => error.fmt(formatter),
            other => formatter.write_str(other.reason().unwrap_or_default()),
        }
    }
}

impl std::error::Error for ConversationError {}
