//! `JSON.stringify(value, null, 2)` and Number::toString of JavaScript, for the tool inputs a
//! transcript page shows, the CLI's `--json` and the numbers the CLI writes into its text (the rules:
//! docs/rust-migration/adr/0193-phase-2-dependencies.md, "`JSON.stringify` と serde_json"). Moved
//! here from transcript's `js_json` (ADR 0244-phase-3-dependencies, #275).
//!
//! serde_json's pretty printer differs in two ways: it writes a whole number read as a float with a
//! fraction (`1.0`, `-0.0`), and it keeps a JavaScript object's integer keys where they were read,
//! while JavaScript lists them first.

use serde_json::{Map, Value};

/// `JSON.stringify(value, null, 2)`.
pub fn stringify_pretty(value: &Value) -> String {
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

/// ECMAScript's Number::toString for a finite number: what `String(x)`, a template literal and
/// `JSON.stringify` write (a number read from JSON is always finite).
pub fn number_to_string(x: f64) -> String {
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
