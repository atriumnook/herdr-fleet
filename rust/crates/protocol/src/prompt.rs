//! The cards of the approval and question screens, and the answer to one (`shared/protocol.ts`,
//! `InteractivePrompt` to `PromptAnswer`), and Codex's unanswered question (`server/codex.ts`).

use serde::{Deserialize, Serialize};

fn is_false(value: &bool) -> bool {
    !value
}

/// GET /api/pane/prompt: an agent's interactive TUI menu currently on the pane's screen, parsed
/// from the visible text. `id` names what the prompt says and which asking of it this is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InteractivePrompt {
    pub id: String,
    /// The agent the screen was parsed for: a fleet agent kind, or another name such as `omp`.
    pub agent: String,
    pub kind: PromptKind,
    pub title: String,
    pub question: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub body: Option<String>,
    pub options: Vec<InteractivePromptOption>,
    pub multi_select: bool,
    /// Index of the "type your own answer" option, when the menu has one.
    #[serde(deserialize_with = "Option::deserialize")]
    pub custom_option_index: Option<usize>,
    /// A question in Codex's queue while Codex keeps working: only the card answers it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued: Option<QueuedState>,
    /// The last-resort card for a blocked pane no reader knows: answered with its own buttons only.
    #[serde(default, skip_serializing_if = "is_false")]
    pub fallback: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptKind {
    Question,
    Approval,
    Plan,
    Menu,
}

/// Where a queued Codex question is: `collapsed` (a message typed in the chat still goes to
/// Codex) or `open` in the terminal (the queue holds the input).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueuedState {
    Collapsed,
    Open,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InteractivePromptOption {
    pub label: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub description: Option<String>,
}

/// POST /api/pane/prompt/answer body. Exactly one of `option_index`, `option_indices` and
/// `custom_text`. The indices are JavaScript numbers, read as they come: the screen crate checks
/// that they are whole and in range, after the card's id, as TypeScript does.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromptAnswer {
    pub pane_id: String,
    pub prompt_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_index: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_indices: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_text: Option<String>,
}

/// A question a Codex rollout holds no answer for: the transcript returns it, and the core hands
/// it to the screen parser for the card of Codex's collapsed queue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueuedQuestion {
    pub key: String,
    pub title: String,
    pub options: Vec<String>,
}
