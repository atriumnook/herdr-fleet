//! OpenCode 2's conversations: no file, the CLI's `opencode api GET <path>` answers JSON from the
//! database the background service keeps (`server/opencode-session.ts`,
//! `server/opencode-messages.ts`). The core implements `OpencodeApi` with the CLI; the reader
//! never starts a process itself (ADR 0107-crate-split).
//!
//! The types and the signatures are final (ADR 0192-phase-2-split, "OpenCode"); what the reader
//! does is a stub until #204 writes it here.

use std::fmt;
use std::sync::Arc;

use crate::{ConversationError, Image, Page, PageRequest};

/// The CLI's answers, as the core gets them: `opencode service status` and
/// `opencode api GET <path>`. Synchronous: the core calls the reader in `spawn_blocking`.
pub trait OpencodeApi: Send + Sync {
    /// Whether the background service answers; never starts it.
    fn service_running(&self) -> Result<bool, OpencodeError>;
    /// The parsed JSON body of a GET.
    fn get(&self, path: &str) -> Result<serde_json::Value, OpencodeError>;
}

/// A GET that did not answer with a body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpencodeError {
    /// The CLI answered with an HTTP error: its status code, and the body's `_tag`.
    Http { status: u16, tag: String },
    /// The read failed some other way.
    Other(String),
}

impl fmt::Display for OpencodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http { status, tag } if tag.is_empty() => {
                write!(formatter, "opencode api answered {status}")
            }
            Self::Http { status, tag } => write!(formatter, "opencode api answered {status} {tag}"),
            Self::Other(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for OpencodeError {}

/// The epoch milliseconds the reader takes as now.
pub type Clock = Box<dyn Fn() -> i64 + Send + Sync>;

/// OpenCode sessions' readers, and what they keep between reads. Its methods take `&self`; the
/// state is guarded by a lock held only while it is read or written, never during an
/// `OpencodeApi` call, so one slow call does not hold up another pane.
pub struct OpencodeConversations {
    #[expect(dead_code, reason = "#204 reads the sessions through it")]
    api: Arc<dyn OpencodeApi>,
    #[expect(dead_code, reason = "#204 reads the time through it")]
    now: Clock,
}

impl OpencodeConversations {
    pub fn new(api: Arc<dyn OpencodeApi>, now: Clock) -> Self {
        Self { api, now }
    }

    /// One page of a session (`OpencodeConversations.page`); `working`: herdr says the pane is
    /// busy.
    pub fn page(
        &self,
        _session_id: &str,
        _working: bool,
        _page: &PageRequest,
    ) -> Result<Page, ConversationError> {
        todo!("#204: OpenCode sessions")
    }

    /// The image a ref names, decoded; `Ok(None)` when there is none.
    pub fn image(
        &self,
        _session_id: &str,
        _reference: &str,
    ) -> Result<Option<Image>, ConversationError> {
        todo!("#204: OpenCode sessions")
    }

    /// The whole output of a tool call, by its ref; `Ok(None)` when there is none. Cut at 2,000,000
    /// UTF-16 code units with no mark, as the core cut it in TypeScript (`server/conversation.ts:1140`),
    /// so that the core needs no limit of its own.
    pub fn tool_output(
        &self,
        _session_id: &str,
        _reference: &str,
    ) -> Result<Option<String>, ConversationError> {
        todo!("#204: OpenCode sessions")
    }
}
