//! `String.prototype.localeCompare` as Bun 1.4.4 orders ASCII text in the en-US locale, for the
//! lists TypeScript sorts with `a.localeCompare(b)` (the usage tracker's accounts, the settings'
//! roles). Moved here from the two copies in orchestrator's `usage/tracker.rs` and `settings.rs`;
//! the decision: docs/rust-migration/adr/0330-locale-compare.md.

use std::cmp::Ordering;

/// The whitespace of ASCII, then its punctuation and symbols, in the order of the locale's
/// collation (the Unicode collation's default table), before the digits.
const SPACES_AND_PUNCTUATION: &str = "\t\n\u{0B}\u{0C}\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

/// `a.localeCompare(b)`: by the characters' primary weights first (whitespace, punctuation and
/// symbols in the order of [`SPACES_AND_PUNCTUATION`], digits, then letters with case set aside),
/// then lower case before upper case, character by character. The other control characters of
/// ASCII are ignored, as the locale ignores them, so strings that differ only in those are
/// `Equal`. A character past ASCII is weighed after the letters by its code point, where the
/// locale would weigh `é` next to `e`, ignore U+200B and U+00AD, and weigh a combining accent
/// after its letter: copying that needs a collation crate (#356).
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    weights(a)
        .cmp(weights(b))
        .then_with(|| cases(a).cmp(cases(b)))
}

/// The primary weights of the characters the locale does not ignore.
fn weights(text: &str) -> impl Iterator<Item = u32> + '_ {
    text.chars().filter_map(primary_weight)
}

/// Whether each character the locale does not ignore is upper case.
fn cases(text: &str) -> impl Iterator<Item = bool> + '_ {
    text.chars()
        .filter(|c| primary_weight(*c).is_some())
        .map(|c| c.is_ascii_uppercase())
}

/// `None` for a character the locale ignores.
fn primary_weight(c: char) -> Option<u32> {
    Some(if let Some(index) = SPACES_AND_PUNCTUATION.find(c) {
        index as u32
    } else if c.is_ascii_digit() {
        100 + u32::from(c as u8 - b'0')
    } else if c.is_ascii_alphabetic() {
        200 + u32::from(c.to_ascii_lowercase() as u8 - b'a')
    } else if c.is_ascii_control() {
        return None;
    } else {
        300 + u32::from(c)
    })
}
