//! The JavaScript built-ins `bin/fleet.ts` reads its arguments and environment with, and writes
//! paths and columns with: `Number(text)`, `Number.parseInt(text, 10)`, `encodeURIComponent`,
//! `padEnd`, and the truthiness of an optional string. Each follows ECMAScript, not Rust's own
//! parsing (`"inf".parse::<f64>()` is infinity in Rust, NaN in JavaScript).

use protocol::js::{trim, trim_start, utf16_len};

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

/// The digits of a `0x`/`0o`/`0b` literal, rounded to the nearest double; NaN when one is not a
/// digit of the radix.
fn integer_in_radix(digits: &str, radix: u32) -> f64 {
    let mut exact: Option<u128> = Some(0);
    let mut rounded = 0.0f64;
    for c in digits.chars() {
        let Some(digit) = c.to_digit(radix) else {
            return f64::NAN;
        };
        exact = exact
            .and_then(|v| v.checked_mul(radix as u128))
            .and_then(|v| v.checked_add(digit as u128));
        rounded = rounded * radix as f64 + digit as f64;
    }
    // u128 to f64 rounds to the nearest double; past 128 bits the running product is close enough
    exact.map(|v| v as f64).unwrap_or(rounded)
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

/// `Number.parseInt(text, 10)`: leading whitespace skipped, an optional sign, then as many
/// decimal digits as there are; NaN when there is none.
pub fn parse_int(text: &str) -> f64 {
    let text = trim_start(text);
    let (negative, rest) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let digits = &rest[..rest.bytes().take_while(u8::is_ascii_digit).count()];
    if digits.is_empty() {
        return f64::NAN;
    }
    let value: f64 = digits.parse().unwrap_or(f64::NAN);
    if negative { -value } else { value }
}

/// `encodeURIComponent`: every byte of the UTF-8 form but the letters, digits and `-_.!~*'()`
/// as `%XX` in capitals.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `text.padEnd(length)`: spaces after `text` up to `length` UTF-16 code units.
pub fn pad_end(text: &str, length: usize) -> String {
    let mut out = text.to_string();
    for _ in utf16_len(text)..length {
        out.push(' ');
    }
    out
}

/// A string's truthiness: present and not empty.
pub fn truthy(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}
