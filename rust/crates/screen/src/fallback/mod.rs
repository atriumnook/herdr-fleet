//! The last-resort card for a blocked pane no reader knows: a numbered menu that ends the screen,
//! or the screen's last lines with the keys its hints name. #199 reads them; until then the parser
//! is a stub.

use crate::ParsedPrompt;

/// Which of the last-resort readers read a card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Responder {}

/// `parseFallbackPrompt`.
pub(crate) fn parse(_agent: &str, _screen: &str) -> ParsedPrompt {
    todo!("#199 reads the last-resort card")
}

/// Whether the screen a last-resort card was read from still ends as it did.
pub(crate) fn tail_is_active(responder: Responder, _screen: &str) -> bool {
    match responder {}
}
