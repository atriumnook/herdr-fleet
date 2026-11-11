//! `protocol::js` against JavaScript: the expected values are what Bun 1.4.4 answers
//! (`/\s/.test`, `/^.$/u.test`, `trim`, `trimStart`, `trimEnd`, `length` and `slice`).

use herdr_fleet_protocol::js;
use regex::Regex;

/// The code points `/\s/` matches, as Bun answered for every code point but the surrogates.
const JS_WHITESPACE: [u32; 25] = [
    0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
    0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];

/// The code points `.` does not match (`/^.$/u`), as Bun answered.
const JS_LINE_TERMINATORS: [u32; 4] = [0xa, 0xd, 0x2028, 0x2029];

fn every_char() -> impl Iterator<Item = char> {
    (0..=0x10ffff).filter_map(char::from_u32)
}

#[test]
fn whitespace_is_javascripts_set() {
    let class = Regex::new(&format!("^{}$", js::WHITESPACE)).unwrap();
    for c in every_char() {
        let expected = JS_WHITESPACE.contains(&(c as u32));
        assert_eq!(
            js::is_whitespace(c),
            expected,
            "is_whitespace(U+{:04X})",
            c as u32
        );
        assert_eq!(
            class.is_match(c.encode_utf8(&mut [0; 4])),
            expected,
            "WHITESPACE on U+{:04X}",
            c as u32
        );
    }
}

#[test]
fn line_terminators_are_what_dot_does_not_match() {
    let class = Regex::new(&format!("^{}$", js::LINE_TERMINATOR)).unwrap();
    for c in every_char() {
        let expected = JS_LINE_TERMINATORS.contains(&(c as u32));
        assert_eq!(
            js::is_line_terminator(c),
            expected,
            "is_line_terminator(U+{:04X})",
            c as u32
        );
        assert_eq!(
            class.is_match(c.encode_utf8(&mut [0; 4])),
            expected,
            "LINE_TERMINATOR on U+{:04X}",
            c as u32
        );
    }
}

#[test]
fn trims_as_javascript_does() {
    // U+FEFF goes, U+0085 stays
    assert_eq!(js::trim("\u{feff} a \u{85}\u{3000}"), "a \u{85}");
    assert_eq!(js::trim_start("\u{feff} a \u{85}"), "a \u{85}");
    assert_eq!(js::trim_end(" a \u{85}\u{2029}"), " a \u{85}");
}

#[test]
fn counts_and_cuts_utf16_code_units() {
    assert_eq!(js::utf16_len("a😀b"), 4);
    assert_eq!(js::utf16_len(""), 0);
    assert_eq!(js::utf16_len("日本"), 2);
    assert_eq!(js::cut_utf16("a😀b", 3), "a😀");
    assert_eq!(js::cut_utf16("a😀b", 9), "a😀b");
    assert_eq!(js::cut_utf16("日本語", 2), "日本");
    // JavaScript's slice keeps the pair's first half ("a\ud83d"), which a Rust string cannot
    // hold: the cut goes before the pair (ADR 0193-phase-2-dependencies)
    assert_eq!(js::cut_utf16("a😀b", 2), "a");
}

// `JSON.stringify(value, null, 2)` and Number::toString, for transcript's tool inputs, the CLI's
// `--json` and the numbers it shows. Expected values: Bun 1.4.4, `JSON.stringify(n)` for each number
// (scratchpad js.ts of #196). These three tests hold every case of transcript's former js_json tests
// (#275).
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
        let value: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(
            js::stringify_pretty(&value),
            expected,
            "JSON.stringify({json})"
        );
        assert_eq!(
            js::number_to_string(value.as_f64().unwrap()),
            expected,
            "String({json})"
        );
    }
}

// Bun 1.4.4: JSON.stringify({s:"a\"b\\c\n\r\t\b\f\u0001\u001f\u007f\u2028é😀/<>"}, null, 2)
#[test]
fn escapes_strings_as_javascript_does() {
    let value =
        serde_json::from_str(r#"{"s":"a\"b\\c\n\r\t\b\f\u0001\u001f\u007f\u2028é😀/<>"}"#).unwrap();
    assert_eq!(
        js::stringify_pretty(&value),
        "{\n  \"s\": \"a\\\"b\\\\c\\n\\r\\t\\b\\f\\u0001\\u001f\u{7f}\u{2028}é😀/<>\"\n}"
    );
}

// Bun 1.4.4: JSON.stringify(JSON.parse(<the input>), null, 2)
#[test]
fn lists_integer_keys_first_and_indents_by_two() {
    let pretty = |json: &str| js::stringify_pretty(&serde_json::from_str(json).unwrap());
    assert_eq!(
        pretty(
            r#"{"b":0,"10":10,"2":2,"a":1,"4294967295":5,"4294967294":4,"01":6,"n":{"z":[],"y":{},"1":[1,{"x":null}],"t":true}}"#
        ),
        "{\n  \"2\": 2,\n  \"10\": 10,\n  \"4294967294\": 4,\n  \"b\": 0,\n  \"a\": 1,\n  \"4294967295\": 5,\n  \"01\": 6,\n  \"n\": {\n    \"1\": [\n      1,\n      {\n        \"x\": null\n      }\n    ],\n    \"z\": [],\n    \"y\": {},\n    \"t\": true\n  }\n}"
    );
    assert_eq!(pretty("{}"), "{}");
    assert_eq!(pretty("[]"), "[]");
}

// Bun 1.4.4 under LANG=en_US.UTF-8: the 128 characters of ASCII from U+007F down to U+0000, each a
// string, .sort((a, b) => a.localeCompare(b)).join(""). The ignored control characters tie, so a
// stable sort keeps them in the order given.
#[test]
fn orders_ascii_characters_as_locale_compare_does() {
    let order = "\u{7F}\u{1F}\u{1E}\u{1D}\u{1C}\u{1B}\u{1A}\u{19}\u{18}\u{17}\u{16}\u{15}\u{14}\u{13}\u{12}\u{11}\u{10}\u{0F}\u{0E}\u{08}\u{07}\u{06}\u{05}\u{04}\u{03}\u{02}\u{01}\u{00}\t\n\u{0B}\u{0C}\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ";
    let mut chars: Vec<String> = (0..128u8)
        .rev()
        .map(|b| char::from(b).to_string())
        .collect();
    chars.sort_by(|a, b| js::locale_compare(a, b));
    assert_eq!(chars.concat(), order);
}

// Bun 1.4.4 under LANG=en_US.UTF-8: [...words].sort((a, b) => a.localeCompare(b)).
#[test]
fn orders_words_as_locale_compare_does() {
    let expected = [
        "a b",
        "a_b",
        "a-b",
        "a:b",
        "a1",
        "a10",
        "a9",
        "ab",
        "Ab",
        "agy",
        "agy:gemini",
        "b",
        "B",
        "ba",
        "bA",
        "Ba",
        "beta",
        "Beta",
        "claude",
        "codex",
        "pi:anthropic",
        "pi:openai",
        "Zeta",
    ];
    let mut words = expected.to_vec();
    words.reverse();
    words.sort_by(|a, b| js::locale_compare(a, b));
    assert_eq!(words, expected);
}

// Bun 1.4.4 under LANG=en_US.UTF-8: a.localeCompare(b) of each pair. The control characters other
// than \t, \n, \v, \f and \r are ignored, and those five and a space weigh differently.
#[test]
fn compares_pairs_as_locale_compare_does() {
    use std::cmp::Ordering::{Equal, Greater, Less};
    for (a, b, expected) in [
        ("a", "a", Equal),
        ("a", "A", Less),
        ("A", "a", Greater),
        ("ab", "aB", Less),
        ("", "a", Less),
        ("a b", "ab", Less),
        ("a\tz", "a b", Less),
        ("a\u{0B}b", "aab", Less),
        ("a\u{01}b", "ab", Equal),
        ("a\u{7F}b", "ab", Equal),
        ("x", "x\u{00}", Equal),
        ("a\u{01}B", "ab", Greater),
        ("a\u{01}b", "aB", Less),
        ("\u{01}", "", Equal),
    ] {
        assert_eq!(js::locale_compare(a, b), expected, "{a:?} vs {b:?}");
    }
}
