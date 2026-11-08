//! JavaScript's built-in string behaviour that two or more crates need, for code moved from
//! TypeScript: the whitespace of `trim` and `\s`, the line terminators of `.` and the `m` flag,
//! and lengths in UTF-16 code units. What one crate alone needs stays in that crate.
//! The rules: docs/rust-migration/adr/0193-phase-2-dependencies.md.

/// `String.prototype.trim`'s set and the regular expression `\s`: WhiteSpace and LineTerminator of
/// ECMAScript. Rust's `char::is_whitespace` differs: it has U+0085 and lacks U+FEFF.
pub fn is_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// The regular expression `\s` of JavaScript, as a class for the regex crate.
pub const WHITESPACE: &str = r"[\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

/// `String.prototype.trimStart`.
pub fn trim_start(text: &str) -> &str {
    text.trim_start_matches(is_whitespace)
}

/// `String.prototype.trim`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_whitespace)
}

/// `String.prototype.trimEnd`.
pub fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_whitespace)
}

/// JavaScript's LineTerminator: what `.` without the `s` flag does not match, and where `^` and
/// `$` of a regular expression with the `m` flag match. The regex crate's `.` matches all but
/// `\n`, and its `(?m)` knows only `\n` (and `\r` with `R`).
pub fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// [`is_line_terminator`] as a class for the regex crate.
pub const LINE_TERMINATOR: &str = r"[\n\r\u{2028}\u{2029}]";

/// `String.prototype.length`: the UTF-16 code units of `text`.
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `text.slice(0, max)`: the longest start of `text` of at most `max` UTF-16 code units. Where
/// JavaScript would cut a surrogate pair and keep its first half, which a Rust string cannot hold,
/// the cut goes before the pair, one code unit short of `max`.
pub fn cut_utf16(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (index, c) in text.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &text[..index];
        }
    }
    text
}
