//! A structured agent conversation as GET /api/pane/conversation answers it (`shared/protocol.ts`,
//! `ConversationTurn` to `ConversationResponse`).

use serde::{Deserialize, Deserializer, Serialize};

/// A field that may be absent (`None`), `null` (`Some(None)`) or a value: called only when the
/// field is present, so a `null` is kept apart from an absent field.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}

/// One turn of a structured agent conversation (the chat lens source).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConversationTurn {
    pub role: TurnRole,
    #[serde(deserialize_with = "Option::deserialize")]
    pub ts: Option<String>,
    /// Last recorded assistant activity, never the next user's timestamp.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_ts: Option<String>,
    pub parts: Vec<ConversationPart>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnRole {
    User,
    Assistant,
}

/// Evidence of skill activity, not a claim that the skill's workflow completed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillActivity {
    pub name: String,
    pub evidence: SkillEvidence,
    pub status: SkillStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillEvidence {
    Invocation,
    Instructions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillStatus {
    Requested,
    Loaded,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ConversationPart {
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<TextPhase>,
    },
    /// The agent's reasoning block; the client folds it and shows it only on request.
    Thinking {
        text: String,
    },
    Skill {
        skill: SkillActivity,
    },
    Tool(ToolPart),
    /// A native Claude or Codex user image, addressed by an opaque ref and fetched on demand.
    Image(ImageRef),
    /// The summary a compaction left; the conversation before it is what it sums up.
    Compact {
        text: String,
    },
    /// A message the agent's runtime put in the user's seat: it starts a turn, nobody typed it.
    /// `source`: what put it there when it is no background result (`local-command`: a slash
    /// command's answer).
    Notice {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextPhase {
    Commentary,
    FinalAnswer,
}

/// A tool call. `error`: the call failed (the agent recorded it so, or its output says a command
/// exited non-zero).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolPart {
    pub name: String,
    pub summary: String,
    pub input: String,
    pub output: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<SkillActivity>,
    /// Set when `output` was cut: the call's id, for GET /api/pane/conversation/tool-output, and
    /// the whole output's length in UTF-16 code units.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_size: Option<u64>,
    /// Images the call returned; fetched as a user image is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<ImageRef>>,
}

/// An image of the conversation, fetched on demand: GET /api/pane/conversation/image?pane_id=…&ref=….
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageRef {
    pub media_type: String,
    #[serde(rename = "ref")]
    pub reference: String,
}

/// Latest model settings actually recorded by this agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConversationMetadata {
    #[serde(deserialize_with = "Option::deserialize")]
    pub model: Option<String>,
    /// Recorded reasoning effort or thinking level; `None` means not reported.
    #[serde(deserialize_with = "Option::deserialize")]
    pub reasoning_effort: Option<String>,
    /// How much of the model's context the last request filled; absent until a response reports
    /// its usage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<ContextUsage>,
}

/// Tokens of the model's context the last request filled. `window` is `None` when the transcript
/// does not say it. Both are numbers as the transcript recorded them, which TypeScript keeps
/// whatever positive finite number they are (`server/conversation-metadata.ts:8`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ContextUsage {
    pub used: f64,
    #[serde(deserialize_with = "Option::deserialize")]
    pub window: Option<f64>,
}

/// GET /api/pane/conversation: native conversation with settings, or scrollback fallback.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConversationResponse {
    /// Stable across appends; changes on transcript replacement or native context clear.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_id: Option<String>,
    pub source: ConversationSource,
    pub turns: Vec<ConversationTurn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ConversationMetadata>,
    /// Where the first turn sits in the transcript; `null` at the conversation's beginning, absent
    /// for scrollback and from bridges without pages.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub cursor: Option<Option<String>>,
    /// Turns on paths a pi `/tree` walked away from; absent for every agent that keeps no entry
    /// tree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abandoned: Option<AbandonedTurns>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConversationSource {
    ClaudeTranscript,
    OmpTranscript,
    PiTranscript,
    CodexTranscript,
    OpencodeSession,
    Scrollback,
}

/// Turns the transcript holds on paths a `/tree` walked away from, which no page of the
/// conversation can reach. `branches` is how many separate paths were left behind; `summary` is
/// pi's own account of the abandoned path, when the user asked for one. A session no `/tree`
/// touched answers zeroes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AbandonedTurns {
    pub count: u64,
    pub branches: u64,
    #[serde(deserialize_with = "Option::deserialize")]
    pub summary: Option<String>,
}
