//! Claude Code's cards (its questions, the review of several answers, approvals, plans and
//! unnumbered menus) and the prompt it suggests next. #197 reads them; until then there is no
//! parser, and the suggestion is a stub.

use crate::ParsedPrompt;

/// Which of Claude Code's readers read a card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Responder {}

/// Claude Code's parsers, in the order `parsePrompt` tries them.
pub(crate) const PARSERS: &[fn(&str) -> Option<ParsedPrompt>] = &[];

/// Whether the menu a card of Claude Code's was read from still ends the screen.
pub(crate) fn tail_is_active(responder: Responder, _screen: &str) -> bool {
    match responder {}
}

/// `parseClaudeSuggestion`.
pub(crate) fn suggestion(_screen: &str) -> Option<String> {
    todo!("#197 reads Claude Code's suggested prompt")
}
