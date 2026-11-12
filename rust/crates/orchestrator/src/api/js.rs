//! JavaScript's `Number(text)`, which `server/fleet/api.ts` reads `?hours=` and `?lines=` with.
//! The same rules as the fleet CLI's `cli::js::number` (the orchestrator cannot depend on the CLI);
//! each follows ECMAScript, not Rust's own parsing (`"inf".parse::<f64>()` is infinity in Rust, NaN
//! in JavaScript).

use protocol::js::trim;
use serde_json::Value;

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

/// `Buffer.byteLength(JSON.stringify(value))`, which api.ts measures a plan with (api.ts:160): the
/// value as JavaScript writes it again, with no whitespace, for a value serde_json read. A number is
/// written in `Number::toString`'s form, not as it was sent (`1.0` is `1`), which has its length
/// ([`number_text`]). Text that `JSON.parse` reads and serde_json does not (`1e999`, a lone
/// surrogate) never gets here: the body is refused as `invalid_json` first (ADR 0269-fleet-api).
pub(crate) fn stringify_len(value: &Value) -> usize {
    match value {
        Value::Null => "null".len(),
        Value::Bool(true) => "true".len(),
        Value::Bool(false) => "false".len(),
        // serde_json reads only finite numbers
        Value::Number(number) => number_text(number.as_f64().unwrap_or(0.0)).len(),
        Value::String(text) => quoted_len(text),
        // `[a,b]`
        Value::Array(items) => {
            2 + items.len().saturating_sub(1) + items.iter().map(stringify_len).sum::<usize>()
        }
        // `{"k":v,"l":w}`
        Value::Object(fields) => {
            2 + fields.len().saturating_sub(1)
                + fields
                    .iter()
                    .map(|(key, value)| quoted_len(key) + 1 + stringify_len(value))
                    .sum::<usize>()
        }
    }
}

/// The length in bytes of `text` as `JSON.stringify` writes a string, quotes included: `"` and `\`
/// and the five control characters with a short escape take two bytes, any other control
/// character six (`\u001f`), and every other character its UTF-8 bytes. A `str` holds no lone
/// surrogate, the one other character JavaScript escapes.
fn quoted_len(text: &str) -> usize {
    2 + text
        .chars()
        .map(|character| match character {
            '"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t' => 2,
            '\0'..='\u{1f}' => 6,
            other => other.len_utf8(),
        })
        .sum::<usize>()
}

/// A finite `x` in the form of ECMAScript's `Number::toString(x)` in radix 10: the shortest digits
/// that read back as `x`, written in full from 1e-6 up to 1e21 and in exponent form (`1e+21`,
/// `1e-7`) outside that range. Its length is always `Number::toString`'s, which is what
/// [`stringify_len`] needs; its last digit may not be. When two shortest digit strings are as near
/// to `x` as each other, ECMAScript takes the one that ends in an even digit, and Rust's `{:e}`
/// may take the other (`137839762462415.625` is `…415.62` in Bun 1.4.4, `…415.63` here).
fn number_text(x: f64) -> String {
    if x == 0.0 {
        // -0 too
        return "0".to_owned();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    // Rust's `{:e}` writes the shortest round-trip digits: `1.2345e23`, `1e-7`
    let exponential = format!("{:e}", x.abs());
    let (mantissa, exponent) = exponential.split_once('e').unwrap_or((&exponential, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i64;
    // x = 0.d1d2… × 10^n
    let n = exponent.parse::<i64>().unwrap_or(0) + 1;
    let written = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let power = n - 1;
        let power_sign = if power < 0 { '-' } else { '+' };
        let (first, rest) = digits.split_at(1);
        let rest = if rest.is_empty() {
            String::new()
        } else {
            format!(".{rest}")
        };
        format!("{first}{rest}e{power_sign}{}", power.abs())
    };
    format!("{sign}{written}")
}

#[cfg(test)]
mod tests {
    use super::{number, number_text, stringify_len};
    use serde_json::{Value, json};

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

    #[test]
    fn measures_a_value_as_javascript_writes_it() {
        // each text as Bun 1.4.4 writes `JSON.stringify(JSON.parse(text))`, and its length in
        // bytes
        let cases = [
            ("1.0", "1"),
            ("100000.0", "100000"),
            ("1e21", "1e+21"),
            ("1e-7", "1e-7"),
            ("1.5e-7", "1.5e-7"),
            ("123456789012345678901234", "1.2345678901234569e+23"),
            ("-0.0", "0"),
            ("0.1", "0.1"),
            ("1e300", "1e+300"),
            ("-1.25e-10", "-1.25e-10"),
            ("12345678901234567890", "12345678901234567000"),
        ];
        for (text, written) in cases {
            let value: Value = serde_json::from_str(text).unwrap();
            assert_eq!(number_text(value.as_f64().unwrap()), written, "{text}");
            assert_eq!(stringify_len(&value), written.len(), "{text}");
        }
        // `137839762462415.625` exactly, as near to `…415.62` as to `…415.63`: Bun writes
        // `137839762462415.62`, 18 bytes, and Rust picks the other last digit
        let tie = f64::from_bits(0x42df_5754_84f5_b3e8);
        assert_eq!(stringify_len(&json!(tie)), 18);
        let length = |text: &str| stringify_len(&serde_json::from_str(text).unwrap());
        assert_eq!(length(r#"{"a":[1.0,2.50,3e2]}"#), 17);
        assert_eq!(length(r#"{"filler":[1.0,1.0,1.0]}"#), 18);
        assert_eq!(
            length(r#"{ "s": "a\"\u0001あ", "n": null, "t": [true, false, {}] }"#),
            49
        );
        // the escapes JavaScript writes (`\b \f \n \r \t \\` and `\u001f`), and what it writes as
        // it is (`/`, U+007F, U+2028, emoji): 39 bytes in Bun
        assert_eq!(
            length("{\"k\\n\": \"\\b\\f\\n\\r\\t\\\\\\/\\u001f\\u007f\u{2028}😀é\"}"),
            39
        );
        let filler = vec!["1.0"; 20_000].join(",");
        assert_eq!(length(&format!(r#"{{"filler":[{filler}]}}"#)), 40_012);
    }
}
