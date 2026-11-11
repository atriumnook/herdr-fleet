//! JavaScript's `Number(text)`, which `server/fleet/api.ts` reads `?hours=` and `?lines=` with.
//! The same rules as the fleet CLI's `cli::js::number` (the orchestrator cannot depend on the CLI);
//! each follows ECMAScript, not Rust's own parsing (`"inf".parse::<f64>()` is infinity in Rust, NaN
//! in JavaScript).

use protocol::js::trim;

/// `Number(text)`: StringToNumber of ECMAScript. Whitespace and line terminators around the
/// number are ignored, the empty string is 0, `0x`, `0o` and `0b` prefix an integer in that radix
/// (with no sign), `Infinity` may carry a sign, and anything else that is not a decimal literal
/// (`1_000`, `inf`, `1e`) is NaN.
pub(crate) fn number(text: &str) -> f64 {
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

#[cfg(test)]
mod tests {
    use super::number;

    #[test]
    fn reads_text_as_javascript_number_does() {
        // each value as `Number(text)` gives it in Bun 1.4.4 and the ECMAScript grammar
        assert_eq!(number(""), 0.0);
        assert_eq!(number(" 6 "), 6.0);
        assert_eq!(number("0x10"), 16.0);
        assert_eq!(number("1e2"), 100.0);
        assert_eq!(number(".5"), 0.5);
        assert_eq!(number("-Infinity"), f64::NEG_INFINITY);
        assert!(number("inf").is_nan());
        assert!(number("1_000").is_nan());
        assert!(number("6h").is_nan());
        assert!(number("-0x10").is_nan());
    }
}
