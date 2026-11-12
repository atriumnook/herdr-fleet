//! `Buffer.byteLength(JSON.stringify(value))`, the size `server/fleet/api.ts` puts on a plan, for
//! code moved from TypeScript.

use serde_json::Value;

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
    use super::{number_text, stringify_len};
    use serde_json::{Value, json};

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
