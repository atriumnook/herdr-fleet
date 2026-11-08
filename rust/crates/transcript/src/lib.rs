//! 場所のわかった transcript(ファイルのパス、OpenCode はメッセージを返す port)を読み、会話のページ、metadata、画像、ツールの出力を返す。
//!
//! Responsibility and dependencies: docs/rust-migration/adr/0107-crate-split.md. The public
//! interface and the seam between the paging engine and the sources:
//! docs/rust-migration/adr/0192-phase-2-split.md ("transcript の seam").

use std::path::PathBuf;

use protocol::{
    AbandonedTurns, ConversationMetadata, ConversationSource, ConversationTurn, QueuedQuestion,
};
use serde::Serialize;

mod claude;
mod codex;
mod errors;
mod format;
mod js_json;
mod omp;
pub mod opencode;
mod paging;
mod pi;
mod records;
mod skill_activity;
mod tool_output;

pub use errors::{ConversationError, UnavailableReason};

use paging::Source;

/// The context window of a pi model, by its id and the provider that served it (TypeScript's
/// `piContextWindow(model, provider)`, which reads pi's own model catalog); `None` when the
/// catalog does not say.
pub type PiContextWindow = Box<dyn Fn(&str, Option<&str>) -> Option<f64> + Send + Sync>;

/// A transcript file the core found for a pane, by the store it is in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileSource {
    Claude(PathBuf),
    Codex(CodexRollout),
    Pi(PathBuf),
    Omp(PathBuf),
}

/// A Codex rollout, with what the pane it runs in adds to reading it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexRollout {
    pub path: PathBuf,
    /// the pane's Codex home: the rollouts this one continues and its images are read there
    pub home: PathBuf,
    /// the pane's folder, where a local image's relative path starts (`pane.cwd`,
    /// `server/conversation.ts:1097`)
    pub cwd: PathBuf,
}

/// Which turns: without `before`, the newest page (with `from`, from that held start while it is
/// still inside the newest page); with `before`, the page ending there, never reaching back past
/// `since`. Each is a cursor of an earlier page.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PageRequest {
    pub before: Option<String>,
    pub since: Option<String>,
    pub from: Option<String>,
}

/// One page of a conversation (TypeScript's `RecognizedConversation`). It serializes as the corpus
/// writes it, `version` included: an HTTP answer carries `version` as its ETag, not in the body
/// (`server/index.ts:1528`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Page {
    pub source: ConversationSource,
    pub turns: Vec<ConversationTurn>,
    pub metadata: ConversationMetadata,
    /// the first turn's position, for the page before it; `None` (null) at the conversation's
    /// beginning
    pub cursor: Option<String>,
    /// Turns on paths a pi `/tree` walked away from; absent for every source that keeps no entry
    /// tree.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abandoned: Option<AbandonedTurns>,
    /// Stable across appends; changes when the transcript is replaced or rewritten, or a native
    /// reset starts a new history.
    pub history_id: String,
    /// Changes whenever the answer could: the route's ETag.
    pub version: String,
}

/// An image of a conversation, decoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    pub media_type: String,
    pub bytes: Vec<u8>,
}

/// The transcript files' readers, and what they keep between reads. One value serves every pane:
/// its methods take `&self`, and each source guards its state with a lock it holds only while it
/// reads or writes that state, never while a file is read or parsed.
pub struct Transcripts {
    claude: Source<claude::Claude>,
    codex: Source<codex::Codex>,
    pi: Source<pi::Pi>,
    omp: Source<omp::Omp>,
}

impl Transcripts {
    /// `pi_context_window` looks up a pi model's context window (ADR 0107-crate-split: the crate
    /// reads no catalog of its own).
    pub fn new(pi_context_window: PiContextWindow) -> Self {
        Self {
            claude: Source::new(claude::Claude),
            codex: Source::new(codex::Codex),
            pi: Source::new(pi::Pi::new(pi_context_window)),
            omp: Source::new(omp::Omp),
        }
    }

    /// One page of a transcript, its metadata included. A cursor of another transcript, or of the
    /// history before a native reset, is `HistoryChanged`.
    pub fn page(&self, file: &FileSource, page: &PageRequest) -> Result<Page, ConversationError> {
        match file {
            FileSource::Claude(path) => self.claude.page(path, page),
            FileSource::Codex(rollout) => self.codex.page(rollout, page),
            FileSource::Pi(path) => self.pi.page(path, page),
            FileSource::Omp(path) => self.omp.page(path, page),
        }
    }

    /// The image an image part's ref names, decoded; `None` when there is none.
    pub fn image(&self, file: &FileSource, reference: &str) -> Option<Image> {
        match file {
            FileSource::Claude(path) => self.claude.image(path, reference),
            FileSource::Codex(rollout) => self.codex.image(rollout, reference),
            FileSource::Pi(path) => self.pi.image(path, reference),
            FileSource::Omp(path) => self.omp.image(path, reference),
        }
    }

    /// The whole output of a tool call whose page output was cut, by the ref the page gave it;
    /// `None` when there is none.
    pub fn tool_output(&self, file: &FileSource, reference: &str) -> Option<String> {
        match file {
            FileSource::Claude(path) => self.claude.tool_output(path, reference),
            FileSource::Codex(rollout) => self.codex.tool_output(rollout, reference),
            FileSource::Pi(path) => self.pi.tool_output(path, reference),
            FileSource::Omp(path) => self.omp.tool_output(path, reference),
        }
    }

    /// The questions a Codex rollout asked that hold no answer yet (TypeScript's
    /// `unansweredCodexQuestions`).
    /// A rollout it cannot read holds none.
    pub fn unanswered_questions(&self, rollout: &CodexRollout) -> Vec<QueuedQuestion> {
        self.codex.format.unanswered_questions(rollout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The core shares one value of each between the panes it serves (ADR 0192-phase-2-split).
    #[test]
    fn readers_can_be_shared_across_threads() {
        fn shared<T: Send + Sync>() {}
        shared::<Transcripts>();
        shared::<opencode::OpencodeConversations>();
    }
}
