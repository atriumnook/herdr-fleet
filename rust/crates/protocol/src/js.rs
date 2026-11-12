//! JavaScript's built-in string behaviour that two or more crates need, for code moved from
//! TypeScript: the whitespace of `trim` and `\s`, the line terminators of `.` and the `m` flag,
//! `Number(text)`, and lengths in UTF-16 code units. What one crate alone needs stays in that
//! crate.
//! The rules: docs/rust-migration/adr/0193-phase-2-dependencies.md. `JSON.stringify` and the way
//! JavaScript writes a number: `json` (ADR 0244-phase-3-dependencies). The order of `localeCompare`:
//! `locale` (ADR 0330-locale-compare).

mod json;
mod locale;

pub use json::{number_to_string, stringify_pretty};
pub use locale::locale_compare;

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

/// `Number(text)`: StringToNumber of ECMAScript. Whitespace and line terminators around the
/// number are ignored, the empty string is 0, `0x`, `0o` and `0b` prefix an integer in that radix
/// (with no sign), `Infinity` may carry a sign, and anything else that is not a decimal literal
/// (`1_000`, `inf`, `1e`) is NaN.
pub fn number(text: &str) -> f64 {
    let text = trim(text);
    if text.is_empty() {
        return 0.0;
    }
    match text {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let bytes = text.as_bytes();
    if bytes.len() > 2 && bytes[0] == b'0' {
        let radix = match bytes[1] {
            b'x' | b'X' => Some(16),
            b'o' | b'O' => Some(8),
            b'b' | b'B' => Some(2),
            _ => None,
        };
        if let Some(radix) = radix {
            return integer_in_radix(&text[2..], radix);
        }
    }
    if is_decimal_literal(text) {
        text.parse().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// The digits of a `0x`/`0o`/`0b` literal, NaN when one is not a digit of the radix. Bun 1.4.4's
/// JavaScriptCore, not the nearest double that ECMAScript's RoundMVResult asks for up to 20
/// significant digits: it sums the digits left to right in a double, and once that reaches 2^53 it
/// sums them again from the last one, whose terms are the ones a double keeps
/// (`parseIntOverflow`). `0xd87a1cbe50f2943` is the double below the nearest one for that reason.
/// The TypeScript fleet runs on Bun.
fn integer_in_radix(digits: &str, radix: u32) -> f64 {
    let mut folded = 0.0f64;
    for c in digits.chars() {
        let Some(digit) = c.to_digit(radix) else {
            return f64::NAN;
        };
        folded = folded * f64::from(radix) + f64::from(digit);
    }
    // 2^53: the doubles from here on are not every integer
    if folded < 9_007_199_254_740_992.0 {
        return folded;
    }
    let mut number = 0.0f64;
    let mut multiplier = 1.0f64;
    for c in digits.chars().rev() {
        // the loop above has already answered NaN for what is not a digit of the radix
        let digit = c.to_digit(radix).unwrap_or(0);
        // Past the 1024th power of the radix the multiplier is infinite: a non-zero digit then
        // makes the sum infinite, and a zero digit adds nothing.
        if digit != 0 {
            number += f64::from(digit) * multiplier;
        }
        multiplier *= f64::from(radix);
    }
    number
}

/// StrUnsignedDecimalLiteral with an optional sign: digits with an optional fraction, or a
/// fraction alone, then an optional exponent.
fn is_decimal_literal(text: &str) -> bool {
    let bytes = text.strip_prefix(['+', '-']).unwrap_or(text).as_bytes();
    let digits = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let whole = digits(0);
    let mut at = whole;
    let mut fraction = 0;
    if bytes.get(at) == Some(&b'.') {
        fraction = digits(at + 1);
        at += 1 + fraction;
    }
    if whole + fraction == 0 {
        return false;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let exponent = digits(at);
        if exponent == 0 {
            return false;
        }
        at += exponent;
    }
    at == bytes.len()
}
