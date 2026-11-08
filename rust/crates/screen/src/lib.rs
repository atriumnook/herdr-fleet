//! エージェント CLI の画面の文字を読み、カード、答えのキー、画面の判定、Cursor の使用量の画面の読み取りを返す。
//!
//! Responsibility and dependencies: docs/rust-migration/adr/0107-crate-split.md. The public
//! functions and the split into families: docs/rust-migration/adr/0192-phase-2-split.md and
//! 0195-screen-foundation.md.

mod answer;
mod card;
mod checks;
mod claude;
mod codex;
mod fallback;
mod omp;
mod pi;
mod text;

use protocol::{FleetAgentKind, QueuedQuestion, UsageReading};
use serde::{Deserialize, Serialize};

pub use answer::{Answer, AnswerStep, InvalidAnswer, Key, answer_keys};
pub use card::ParsedPrompt;

/// The question Codex's queue opened on, as the pane showed it (`QueueFront`, server/prompt.ts:392).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueueFront {
    pub question: String,
    pub options: Vec<String>,
}

/// An agent adapter's looks at its CLI's screen (`AgentAdapter`, server/fleet/adapters.ts:40-80).
/// `None` is a look the adapter does not have, as TypeScript's optional methods: the orchestrator
/// reads a missing `input_ready` as ready, and a missing `question`, `ready_error` or `draft` as
/// nothing found.
#[derive(Debug, Clone, Copy)]
pub struct ScreenChecks {
    /// the CLI gave up while starting: the screen it left, read once no agent runs in the pane
    pub startup_error: fn(&str) -> Option<String>,
    /// a question on a screen herdr reports as idle: what it asks
    pub question: Option<fn(&str) -> Option<String>>,
    /// a start that did not go as asked (an unknown model swapped for the default one)
    pub ready_error: Option<fn(&str) -> Option<String>>,
    /// whether the CLI has drawn its input or its questions, once herdr calls it ready
    pub input_ready: Option<fn(&str) -> bool>,
    /// whether the person left a draft in the CLI's input, on its screen read with colors
    pub draft: Option<fn(&str) -> bool>,
    /// a turn that settled without doing the work (an API error after the CLI's own retries), from
    /// the turn's output; a turn without output has none
    pub turn_error: fn(&str) -> Option<String>,
}

/// The card of the interactive menu that ends an agent's screen, if a reader of that agent's knows
/// it (`parseInteractivePrompt` and `parsePrompt`, server/prompt.ts:1115-1126, 1147-1150): the
/// parsers of the agent's family, tried in order, give the first card whose menu still ends the
/// screen.
pub fn parse_interactive_prompt(agent: &str, screen: &str) -> Option<ParsedPrompt> {
    let parsers = match agent {
        "codex" => codex::PARSERS,
        "omp" => omp::PARSERS,
        "claude" => claude::PARSERS,
        "pi" => pi::PARSERS,
        _ => &[],
    };
    parsers
        .iter()
        .filter_map(|parse| parse(screen))
        .find(|prompt| prompt.tail_is_active(screen))
}

/// The last-resort card for a pane herdr reports blocked that no reader knows
/// (`parseFallbackPrompt`).
pub fn parse_fallback_prompt(agent: &str, screen: &str) -> ParsedPrompt {
    fallback::parse(agent, screen)
}

/// The card for Codex's collapsed queue of questions on this screen, from the questions its rollout
/// holds no answer for (`codexQueuedPrompt`).
pub fn codex_queued_prompt(
    screen: &str,
    unanswered: &[QueuedQuestion],
    front: Option<&QueueFront>,
) -> Option<ParsedPrompt> {
    codex::queued_prompt(screen, unanswered, front)
}

/// Whether Codex's queue of questions is collapsed with its main prompt under it, which then takes a
/// message (`codexQuestionsCollapsed`).
pub fn codex_questions_collapsed(screen: &str) -> bool {
    parse_interactive_prompt("codex", screen).is_none() && codex::queued_question_count(screen) > 0
}

/// The prompt Claude Code suggests next, grey in its empty input (`parseClaudeSuggestion`).
pub fn parse_claude_suggestion(screen: &str) -> Option<String> {
    claude::suggestion(screen)
}

/// The adapter's looks at the screen of an agent kind's CLI.
pub fn screen_checks(kind: FleetAgentKind) -> ScreenChecks {
    checks::for_kind(kind)
}

/// The usage on Cursor's `/usage` screen, read at `now` (epoch milliseconds) (`cursorUsage`).
pub fn cursor_usage(screen: &str, now: i64) -> Option<UsageReading> {
    checks::cursor_usage(screen, now)
}
