//! The JavaScript built-ins `bin/fleet.ts` reads its arguments and environment with, and writes
//! paths and columns with: `Number.parseInt(text, 10)`, `encodeURIComponent`, `padEnd`, and the
//! truthiness of an optional string. `Number(text)` comes from `protocol::js`. Each follows
//! ECMAScript, not Rust's own parsing (`"inf".parse::<f64>()` is infinity in Rust, NaN in
//! JavaScript).

pub use protocol::js::number;
use protocol::js::{trim_start, utf16_len};

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
