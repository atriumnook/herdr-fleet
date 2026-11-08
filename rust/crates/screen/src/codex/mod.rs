//! Codex's cards (its continue menu, questions, the queue of questions it asks while it works, and
//! approvals). #198 reads them; until then there is no parser, and the queue's readers are stubs.

use protocol::QueuedQuestion;

use crate::{ParsedPrompt, QueueFront};

/// Which of Codex's readers read a card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Responder {}

/// Codex's parsers, in the order `parsePrompt` tries them.
pub(crate) const PARSERS: &[fn(&str) -> Option<ParsedPrompt>] = &[];

/// Whether the menu a card of Codex's was read from still ends the screen.
pub(crate) fn tail_is_active(responder: Responder, _screen: &str) -> bool {
    match responder {}
}

/// `queuedQuestionCount`: how many questions wait in Codex's collapsed queue at the bottom of the
/// screen, with the main prompt right under it; 0 otherwise.
pub(crate) fn queued_question_count(_screen: &str) -> usize {
    todo!("#198 reads Codex's collapsed queue")
}

/// `codexQueuedPrompt`: the card for Codex's collapsed queue, from the rollout's unanswered questions.
pub(crate) fn queued_prompt(
    _screen: &str,
    _unanswered: &[QueuedQuestion],
    _front: Option<&QueueFront>,
) -> Option<ParsedPrompt> {
    todo!("#198 reads Codex's collapsed queue")
}
