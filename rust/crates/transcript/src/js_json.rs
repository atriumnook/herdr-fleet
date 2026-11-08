//! `JSON.stringify(value, null, 2)` of JavaScript, for the tool inputs a page shows (the rules:
//! docs/rust-migration/adr/0193-phase-2-dependencies.md, "`JSON.stringify` と serde_json").
//!
//! serde_json's pretty printer differs in two ways that reach the corpus: it writes a whole number
//! read as a float with a fraction (`1.0`, `-0.0`), and it keeps a JavaScript object's integer keys
//! where they were read, while JavaScript lists them first.

use serde_json::{Map, Value};

/// `JSON.stringify(value, null, 2)`.
pub(crate) fn stringify_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, 0);
    out
}

fn write_value(out: &mut String, value: &Value, depth: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        // JavaScript holds every number as an f64: a larger integer is rounded to one first
        Value::Number(number) => out.push_str(&number_to_string(number.as_f64().unwrap_or(0.0))),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                write_value(out, item, depth + 1);
            }
            newline(out, depth);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (index, (key, item)) in object_order(map).into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                write_string(out, key);
                out.push_str(": ");
                write_value(out, item, depth + 1);
            }
            newline(out, depth);
            out.push('}');
        }
    }
}

fn newline(out: &mut String, depth: usize) {
    out.push('\n');
    for _ in 0..depth {
        out.push_str("  ");
    }
}

/// A string as JSON: the escapes of `JSON.stringify` are serde_json's for every string a Rust
/// `str` can hold (a lone surrogate, which only JavaScript can hold, is the one difference).
fn write_string(out: &mut String, text: &str) {
    out.push_str(&serde_json::to_string(text).unwrap_or_default());
}

/// The order JavaScript lists an object's keys in: the array indices (0 to 2^32 − 2, written
/// without a leading zero) by value, then the others in the order they were added.
fn object_order(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indices: Vec<(u32, (&String, &Value))> = Vec::new();
    let mut others = Vec::new();
    for entry in map {
        match array_index(entry.0) {
            Some(index) => indices.push((index, entry)),
            None => others.push(entry),
        }
    }
    indices.sort_by_key(|(index, _)| *index);
    indices
        .into_iter()
        .map(|(_, entry)| entry)
        .chain(others)
        .collect()
}

fn array_index(key: &str) -> Option<u32> {
    if key.is_empty()
        || (key.len() > 1 && key.starts_with('0'))
        || !key.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// ECMAScript's Number::toString for a finite number, which `JSON.stringify` writes (a number
/// read from JSON is always finite).
fn number_to_string(x: f64) -> String {
    if x == 0.0 {
        return "0".to_owned();
    }
    let (digits, exponent) = shortest_digits(x.abs());
    let sign = if x < 0.0 { "-" } else { "" };
    let k = digits.len() as i32;
    // x = 0.d1d2…dk × 10^n
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let mantissa = if k == 1 {
            digits.clone()
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        let e = n - 1;
        format!("{mantissa}e{}{}", if e < 0 { "-" } else { "+" }, e.abs())
    };
    format!("{sign}{body}")
}

/// The shortest digits that read back as `x` (positive and finite), and the decimal exponent of
/// the first: `x` = d1.d2…dk × 10^exponent. Of two shortest digit strings ECMAScript takes the one
/// closer to `x`; Rust's `{:e}` may take the other, and the correctly rounded string of the same
/// length is that closer one whenever it reads back as `x`.
fn shortest_digits(x: f64) -> (String, i32) {
    let shortest = format!("{x:e}");
    let length = split_exponent(&shortest).0.len();
    let rounded = format!("{:.*e}", length.saturating_sub(1), x);
    let chosen = if rounded.parse::<f64>().ok() == Some(x) {
        rounded
    } else {
        shortest
    };
    let (digits, exponent) = split_exponent(&chosen);
    (digits, exponent)
}

/// `d.ddde±x` as its digits without the point, and the exponent.
fn split_exponent(text: &str) -> (String, i32) {
    let (mantissa, exponent) = text.split_once('e').unwrap_or((text, "0"));
    (mantissa.replace('.', ""), exponent.parse().unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pretty(json: &str) -> String {
        stringify_pretty(&serde_json::from_str(json).expect("test JSON"))
    }

    // Expected values: Bun 1.4.4, `JSON.stringify(n)` for each number (scratchpad js.ts of #196).
    #[test]
    fn writes_numbers_as_javascript_does() {
        let cases = [
            ("0", "0"),
            ("-0", "0"),
            ("-0.0", "0"),
            ("1", "1"),
            ("1.0", "1"),
            ("1e3", "1000"),
            ("1.5", "1.5"),
            ("-2.25", "-2.25"),
            ("0.1", "0.1"),
            ("0.30000000000000004", "0.30000000000000004"),
            ("100", "100"),
            ("123456789012345680000", "123456789012345680000"),
            ("1e21", "1e+21"),
            ("1.7976931348623157e308", "1.7976931348623157e+308"),
            ("5e-324", "5e-324"),
            ("1e-7", "1e-7"),
            ("-1e-10", "-1e-10"),
            ("0.000001", "0.000001"),
            ("0.000001234", "0.000001234"),
            ("652282746268236.2", "652282746268236.2"),
            ("12345.6789e10", "123456789000000"),
            // 2^53 + 1 is rounded to an f64 first
            ("9007199254740993", "9007199254740992"),
        ];
        for (json, expected) in cases {
            assert_eq!(pretty(json), expected, "JSON.stringify({json})");
        }
    }

    // Bun 1.4.4: JSON.stringify({s:"a\"b\\c\n\r\t\b\f\u0001\u001f\u007f é😀/<>"}, null, 2)
    #[test]
    fn escapes_strings_as_javascript_does() {
        assert_eq!(
            pretty(r#"{"s":"a\"b\\c\n\r\t\b\f\u0001\u001f\u007f é😀/<>"}"#),
            "{\n  \"s\": \"a\\\"b\\\\c\\n\\r\\t\\b\\f\\u0001\\u001f\u{7f}\u{2028}é😀/<>\"\n}"
        );
    }

    // Bun 1.4.4: JSON.stringify(JSON.parse(<the input>), null, 2)
    #[test]
    fn lists_integer_keys_first_and_indents_by_two() {
        assert_eq!(
            pretty(
                r#"{"b":0,"10":10,"2":2,"a":1,"4294967295":5,"4294967294":4,"01":6,"n":{"z":[],"y":{},"1":[1,{"x":null}],"t":true}}"#
            ),
            "{\n  \"2\": 2,\n  \"10\": 10,\n  \"4294967294\": 4,\n  \"b\": 0,\n  \"a\": 1,\n  \"4294967295\": 5,\n  \"01\": 6,\n  \"n\": {\n    \"1\": [\n      1,\n      {\n        \"x\": null\n      }\n    ],\n    \"z\": [],\n    \"y\": {},\n    \"t\": true\n  }\n}"
        );
        assert_eq!(pretty("{}"), "{}");
        assert_eq!(pretty("[]"), "[]");
    }
}
