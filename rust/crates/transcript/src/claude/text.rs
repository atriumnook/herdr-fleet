//! The text rules of Claude Code's records (`server/conversation.ts`): what a slash command and a
//! notice print, pastes, and the JavaScript conversions the parser leans on (`String(value)`,
//! truthiness, `Date.parse`).

use std::sync::LazyLock;

use protocol::js::{self, cut_utf16, utf16_len};
use regex::{Captures, Regex};
use serde_json::Value;

use crate::js_json::stringify_pretty;

/// A command's answer is a notice, not a log: the rest of a long one stays in the terminal.
const LOCAL_COMMAND_MAX_CHARS: usize = 4000;

/// Lines of one notice Claude Code writes as separate entries, a moment apart.
const NOTICE_JOIN_MS: f64 = 1000.0;

/// Slash-command and bookkeeping entries Claude logs as user turns — not conversations.
pub(super) fn is_command_entry(text: &str) -> bool {
    text.starts_with("<command-")
        || text.starts_with("<local-command")
        || text.starts_with("<task-")
}

/// `String(value)` of JavaScript; `None` is `undefined`.
pub(super) fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(number @ Value::Number(_)) => stringify_pretty(number),
        Some(Value::String(text)) => text.clone(),
        // `Array.prototype.join`: null and undefined items are empty
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                item => js_string(Some(item)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
    }
}

/// `String(value ?? "")`.
pub(super) fn js_string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        value => js_string(value),
    }
}

/// Is the field truthy, as JavaScript's `if (value)` reads it?
pub(super) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// What a slash command printed, from the `local_command` entry Claude Code records it in. The
/// command's echo (`<command-name>…`) is a separate entry with no output tag, and reads as nothing.
/// The whole entry is the output, one stream after another: a tag quoted inside an echo's arguments
/// is not an answer.
pub(super) fn local_command_output(content: Option<&Value>) -> String {
    const STDOUT: &str = "<local-command-stdout>";
    const STDERR: &str = "<local-command-stderr>";
    let Some(Value::String(content)) = content else {
        return String::new();
    };
    let opens_stream =
        |at: usize| content[at..].starts_with(STDOUT) || content[at..].starts_with(STDERR);
    let mut streams: Vec<String> = Vec::new();
    let mut at = 0;
    loop {
        at = skip_whitespace(content, at);
        if at == content.len() {
            break;
        }
        let stream = if content[at..].starts_with(STDOUT) {
            "stdout"
        } else if content[at..].starts_with(STDERR) {
            "stderr"
        } else {
            return String::new();
        };
        let start = at + STDOUT.len();
        // a closing tag the output prints itself ends nothing: the stream's own one is at the end
        // of the entry or before the next stream. Each candidate looks only at the whitespace
        // after it.
        let close = format!("</local-command-{stream}>");
        let mut end = find_from(content, &close, start);
        let mut next = 0;
        while let Some(candidate) = end {
            next = skip_whitespace(content, candidate + close.len());
            if next == content.len() || opens_stream(next) {
                break;
            }
            end = find_from(content, &close, candidate + close.len());
        }
        let Some(end) = end else {
            return String::new();
        };
        let text = strip_terminal_controls(&content[start..end]);
        let text = js::trim(&text);
        if !text.is_empty() {
            streams.push(text.to_owned());
        }
        at = next;
    }
    cap_notice(&streams.join("\n"))
}

fn skip_whitespace(text: &str, from: usize) -> usize {
    text[from..]
        .char_indices()
        .find(|(_, c)| !js::is_whitespace(*c))
        .map_or(text.len(), |(offset, _)| from + offset)
}

fn find_from(text: &str, needle: &str, from: usize) -> Option<usize> {
    text.get(from..)?.find(needle).map(|at| from + at)
}

/// A notice Claude Code writes as plain text: no terminal codes, and not past a notice's length.
pub(super) fn notice_text(raw: &str) -> String {
    cap_notice(js::trim(&strip_terminal_controls(raw)))
}

/// A notice is not a log: past the cap the rest stays in the terminal, also for lines joined into
/// one.
pub(super) fn cap_notice(text: &str) -> String {
    if utf16_len(text) > LOCAL_COMMAND_MAX_CHARS {
        format!("{}\u{2026}", cut_utf16(text, LOCAL_COMMAND_MAX_CHARS))
    } else {
        text.to_owned()
    }
}

/// Were these two entries written together? Never when either has no readable time.
pub(super) fn written_together(a: Option<&str>, b: Option<&str>) -> bool {
    match (a.and_then(date_parse), b.and_then(date_parse)) {
        (Some(a), Some(b)) => (a - b).abs() <= NOTICE_JOIN_MS,
        _ => false,
    }
}

/// The text of terminal output without its escape codes (colours, links, cursor moves, charset
/// switches) and other controls, in one pass: a sequence cut off by the end swallows the rest,
/// and malformed input never makes it rescan what follows. Every control and every byte a
/// sequence is made of is ASCII, so reading characters reads what TypeScript's code units do.
pub(super) fn strip_terminal_controls(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let within = |i: usize, low: u32, high: u32| {
        chars
            .get(i)
            .is_some_and(|c| (low..=high).contains(&u32::from(*c)))
    };
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c != '\u{1b}' {
            // tab and newline are text; every other C0 control and DEL is not
            if c == '\t' || c == '\n' || (c >= ' ' && c != '\u{7f}') {
                out.push(c);
            }
            i += 1;
            continue;
        }
        match chars.get(i + 1) {
            Some(']' | 'P' | 'X' | '^' | '_') => {
                // a string (OSC, DCS, SOS, PM, APC) ends at BEL or ST; another ESC ends it too
                i += 2;
                while i < chars.len() && chars[i] != '\u{7}' && chars[i] != '\u{1b}' {
                    i += 1;
                }
                if chars.get(i) == Some(&'\u{7}') {
                    i += 1;
                } else if chars.get(i + 1) == Some(&'\\') {
                    i += 2;
                }
            }
            Some('[') => {
                // CSI: parameters, intermediates, one final byte
                i += 2;
                while within(i, 0x30, 0x3f) {
                    i += 1;
                }
                while within(i, 0x20, 0x2f) {
                    i += 1;
                }
                if within(i, 0x40, 0x7e) {
                    i += 1;
                }
            }
            _ => {
                // ESC, intermediates (as in ESC ( B), then one final byte
                i += 1;
                while within(i, 0x20, 0x2f) {
                    i += 1;
                }
                if within(i, 0x30, 0x7e) {
                    i += 1;
                }
            }
        }
    }
    out
}

static PASTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"<pasted_content id="([^"\r\n]+)">\r?\n((?s:.)*?)\r?\n</pasted_content id="([^"\r\n]+)">"#,
    )
    .expect("PASTE")
});

static PASTE_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9A-Za-z_-]+$").expect("PASTE_ID"));

/// Claude Code wraps a long paste in `<pasted_content id="…">` tags so the model can tell it from
/// typed text; its own TUI shows only the text, and so does the chat (`unwrapPastes`).
pub(super) fn unwrap_pastes(text: &str) -> String {
    let mut changed = false;
    let visible = PASTE.replace_all(text, |caps: &Captures| {
        let (opening, closing) = (&caps[1], &caps[3]);
        if opening != closing || utf16_len(opening) > 64 || !PASTE_ID.is_match(opening) {
            return caps[0].to_owned();
        }
        changed = true;
        caps[2].to_owned()
    });
    if changed {
        visible.trim_matches('\n').to_owned()
    } else {
        text.to_owned()
    }
}

/// `Date.parse` of Bun (JavaScriptCore) for the date-time string format and the variants it also
/// reads: a lowercase `t` or `z`, a space for the `T`, any number of fraction digits (milliseconds
/// kept, the rest dropped), an offset with or without its colon, hour 24 at the day's end, and a
/// day past the month's end up to 31 (it rolls over). A time without an offset is local time in
/// JavaScript; it is read as UTC here, which changes no difference between two such times except
/// across a daylight saving change (Claude Code writes UTC with `Z`). The other formats Bun's
/// fallback parser reads (`Tue, 12 May 2026 10:00:00 GMT` and the like) are not read. `None` for
/// NaN, also for a time past 8.64e15 ms either way.
pub(super) fn date_parse(text: &str) -> Option<f64> {
    let mut reader = Reader {
        bytes: text.as_bytes(),
        at: 0,
    };
    let year = match reader.peek() {
        Some(sign @ (b'+' | b'-')) => {
            reader.at += 1;
            let digits = reader.digits(6)?;
            if sign == b'-' && digits == 0 {
                return None;
            }
            if sign == b'-' { -digits } else { digits }
        }
        _ => reader.digits(4)?,
    };
    let mut month = 1;
    let mut day = 1;
    if reader.eat(b'-') {
        month = reader.digits(2)?;
        if reader.eat(b'-') {
            day = reader.digits(2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (mut hour, mut minute, mut second, mut millis) = (0, 0, 0, 0);
    // a fraction digit past the milliseconds that is not zero: hour 24 refuses it too
    let mut past_millis = false;
    let mut has_time = false;
    if matches!(reader.peek(), Some(b'T' | b't' | b' ')) {
        reader.at += 1;
        has_time = true;
        hour = reader.digits(2)?;
        if !reader.eat(b':') {
            return None;
        }
        minute = reader.digits(2)?;
        if reader.eat(b':') {
            second = reader.digits(2)?;
            if reader.eat(b'.') {
                let start = reader.at;
                while reader.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                    reader.at += 1;
                }
                let fraction = &text[start..reader.at];
                if fraction.is_empty() {
                    return None;
                }
                millis = format!("{fraction:0<3}")[..3].parse().ok()?;
                past_millis = fraction.bytes().skip(3).any(|digit| digit != b'0');
            }
        }
        if hour > 24
            || minute > 59
            || second > 59
            || (hour == 24 && ((minute, second, millis) != (0, 0, 0) || past_millis))
        {
            return None;
        }
    }
    let mut offset_minutes = 0;
    match reader.peek() {
        Some(b'Z' | b'z') => reader.at += 1,
        Some(sign @ (b'+' | b'-')) if has_time => {
            reader.at += 1;
            let hours = reader.digits(2)?;
            reader.eat(b':');
            let minutes = reader.digits(2)?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            offset_minutes = (hours * 60 + minutes) * if sign == b'-' { -1 } else { 1 };
        }
        _ => {}
    }
    if reader.at != text.len() {
        return None;
    }
    let days = days_from_civil(year, month, 1) + day - 1;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset_minutes * 60;
    // TimeClip: a time past 8.64e15 ms either way is NaN
    let time = seconds * 1000 + millis;
    (time.abs() <= 8_640_000_000_000_000).then_some(time as f64)
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn eat(&mut self, byte: u8) -> bool {
        let found = self.peek() == Some(byte);
        if found {
            self.at += 1;
        }
        found
    }

    /// Exactly `count` digits.
    fn digits(&mut self, count: usize) -> Option<i64> {
        let digits = self.bytes.get(self.at..self.at + count)?;
        if !digits.iter().all(u8::is_ascii_digit) {
            return None;
        }
        self.at += count;
        Some(
            digits
                .iter()
                .fold(0, |value, digit| value * 10 + i64::from(digit - b'0')),
        )
    }
}

/// Days from 1970-01-01 to a date of the proleptic Gregorian calendar (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values: Bun 1.4.4's `Date.parse` of each string (scratchpad d.ts to d4.ts of #201),
    // run in a JST (+09:00) zone; the local-time form is the one place the zone shows, and is
    // read as UTC here.
    #[test]
    fn parses_dates_as_bun_does() {
        let cases: [(&str, Option<f64>); 39] = [
            ("2026-05-12T10:00:00.123Z", Some(1778580000123.0)),
            ("2026-05-12T10:00:00Z", Some(1778580000000.0)),
            ("2026-05-12T10:00:00.123456Z", Some(1778580000123.0)),
            ("2026-05-12T10:00:00.1Z", Some(1778580000100.0)),
            ("2026-05-12T10:00Z", Some(1778580000000.0)),
            ("2026-05-12", Some(1778544000000.0)),
            ("2026-05", Some(1777593600000.0)),
            ("2026", Some(1767225600000.0)),
            ("2026-05-12T10:00:00+09:00", Some(1778547600000.0)),
            ("2026-05-12 10:00:00Z", Some(1778580000000.0)),
            ("+002026-05-12T10:00:00Z", Some(1778580000000.0)),
            ("2026-13-12T10:00:00Z", None),
            ("2026-02-30T10:00:00Z", Some(1772445600000.0)),
            ("2026-05-12T24:00:00Z", Some(1778630400000.0)),
            ("2026-05-12T10:00:60Z", None),
            ("2026-05-12t10:00:00z", Some(1778580000000.0)),
            ("x", None),
            ("2026-05-12T10:00:00.Z", None),
            (" 2026-05-12T10:00:00Z", None),
            ("2026-05-12T24:30:00Z", None),
            ("2026-02-32T00:00:00Z", None),
            ("2026-02-00T00:00:00Z", None),
            ("2026-05-12T10:00:00+0900", Some(1778547600000.0)),
            ("2026-05-12T10:00:00+09", None),
            ("2026-5-12T10:00:00Z", None),
            ("2026-05-12T10Z", None),
            ("2026-05-12Z", Some(1778544000000.0)),
            ("2026-05-12T10:00:00.123Z ", None),
            ("-000001-01-01T00:00:00Z", Some(-62198755200000.0)),
            ("-000000-01-01T00:00:00Z", None),
            ("+275760-09-13T00:00:00Z", Some(8640000000000000.0)),
            ("+275760-09-13T00:00:00.001Z", None),
            ("+275760-09-14T00:00:00Z", None),
            ("-271821-04-20T00:00:00Z", Some(-8640000000000000.0)),
            ("-271821-04-19T23:59:59.999Z", None),
            ("+999999-01-01T00:00:00Z", None),
            ("+275760-09-13T01:00:00+02:00", Some(8639999996400000.0)),
            ("2026-05-12T24:00:00.0001Z", None),
            ("2026-05-12T24:00:00.0000Z", Some(1778630400000.0)),
        ];
        for (input, expected) in cases {
            assert_eq!(date_parse(input), expected, "Date.parse({input:?})");
        }
    }

    // Expected values: Bun 1.4.4's `String(value)` (scratchpad d.ts of #201).
    #[test]
    fn converts_values_to_strings_as_javascript_does() {
        let value = serde_json::json!([null, 1.5, 1e21, [1, [2, null]], {}, true]);
        let converted: Vec<String> = value
            .as_array()
            .into_iter()
            .flatten()
            .map(|item| js_string(Some(item)))
            .collect();
        assert_eq!(
            converted,
            ["null", "1.5", "1e+21", "1,2,", "[object Object]", "true"]
        );
    }
}
