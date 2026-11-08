//! The prompt Claude Code suggests next, grey in its empty input box (`parseClaudeSuggestion` and
//! `sgrRuns`, server/prompt.ts:1407-1471).

use std::sync::LazyLock;

use protocol::js;
use regex::Regex;

use super::SOLID_RULE;
use crate::text::{js_regex, strip_ansi};

/// `CLAUDE_TIP_RE`: Claude's new-session tip in the empty input (`Try "how does <filepath> work?"`),
/// not a suggestion.
const TIP: &str = "Try \"";
/// An OSC sequence, which `ANSI_RE` leaves.
static OSC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)").unwrap());
/// The escapes `sgrRuns` reads: a CSI sequence (its parameters and final byte captured), an OSC
/// sequence, or a two-byte escape.
static ESCAPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\x1b(?:\[([0-?]*)[ -/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])").unwrap()
});
/// The input box's prompt.
static PROMPT: LazyLock<Regex> = LazyLock::new(|| js_regex("^❯{s}"));

/// A run of an ANSI line's text, with whether it is drawn dim (SGR 2) and inverse (SGR 7).
struct Run<'a> {
    text: &'a str,
    dim: bool,
    inverse: bool,
}

/// `Number(code || 0)` of an SGR parameter: `None` for what JavaScript reads as NaN.
fn sgr_code(code: &str) -> Option<u64> {
    if code.is_empty() {
        return Some(0);
    }
    // the parameter bytes are 0-9 : < = > ?, and only digits make a number
    if !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    // a code too long for a u64 is none of those read below
    Some(code.parse().unwrap_or(u64::MAX))
}

/// `sgrRuns`: the line's text, cut where its SGR state changes. Only SGR sequences change the state;
/// 38/48/58 colors are skipped whole, so the 2 of `38;2;r;g;b` is a color mode, not dim. Other
/// escapes are dropped.
fn sgr_runs(line: &str) -> Vec<Run<'_>> {
    let mut runs = Vec::new();
    let mut dim = false;
    let mut inverse = false;
    let mut offset = 0;
    for found in ESCAPE.captures_iter(line) {
        let whole = found.get(0).unwrap();
        if whole.start() > offset {
            runs.push(Run {
                text: &line[offset..whole.start()],
                dim,
                inverse,
            });
        }
        offset = whole.end();
        if found.get(2).map(|end| end.as_str()) != Some("m") {
            continue;
        }
        let parameters = found.get(1).map_or("", |codes| codes.as_str());
        let parameters = if parameters.is_empty() {
            "0"
        } else {
            parameters
        };
        let codes: Vec<Option<u64>> = parameters.split(';').map(sgr_code).collect();
        let mut index = 0;
        while index < codes.len() {
            match codes[index] {
                Some(38 | 48 | 58) => {
                    index += match codes.get(index + 1) {
                        Some(Some(5)) => 2,
                        Some(Some(2)) => 4,
                        _ => 0,
                    };
                }
                Some(0) => {
                    dim = false;
                    inverse = false;
                }
                Some(22) => dim = false,
                Some(2) => dim = true,
                Some(27) => inverse = false,
                Some(7) => inverse = true,
                _ => {}
            }
            index += 1;
        }
    }
    if offset < line.len() {
        runs.push(Run {
            text: &line[offset..],
            dim,
            inverse,
        });
    }
    runs
}

/// `parseClaudeSuggestion`: the `❯` line between the screen's last two rules (the live input box,
/// not an earlier one above a bash-mode input), all of it dim but for Claude's own drawn cursor on
/// its first character. None while anything is typed there (typed text is not dim), for the
/// new-session tip, or for an input box of more than one line.
pub(crate) fn suggestion(ansi: &str) -> Option<String> {
    let lines: Vec<&str> = ansi
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let plain: Vec<String> = lines
        .iter()
        .map(|line| OSC.replace_all(&strip_ansi(line), "").into_owned())
        .collect();
    let rule = (0..plain.len())
        .rev()
        .find(|&index| SOLID_RULE.is_match(js::trim(&plain[index])))?;
    let index = rule.checked_sub(1).filter(|index| *index >= 1)?;
    if !PROMPT.is_match(&plain[index]) || !SOLID_RULE.is_match(js::trim(&plain[index - 1])) {
        return None;
    }
    let runs = sgr_runs(lines[index]);
    let mut text = String::new();
    let mut seen_prompt = false;
    let mut cursor = false;
    for run in &runs {
        for character in run.text.chars() {
            if !seen_prompt {
                seen_prompt = character == '❯';
                continue;
            }
            let blank = js::is_whitespace(character);
            // the cursor Claude draws itself sits inverse on the first grey character
            if !run.dim && !blank && !(run.inverse && js::trim(&text).is_empty() && !cursor) {
                return None;
            }
            if !run.dim && !blank {
                cursor = true;
            }
            text.push(character);
        }
    }
    // a cursor over typed text has nothing grey after it
    if cursor
        && !runs
            .iter()
            .any(|run| run.dim && !js::trim(run.text).is_empty())
    {
        return None;
    }
    let suggestion = js::trim(&text.replace('\u{a0}', " ")).to_owned();
    (!suggestion.is_empty() && !suggestion.starts_with(TIP)).then_some(suggestion)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(line: &str) -> Vec<(&str, bool, bool)> {
        sgr_runs(line)
            .iter()
            .map(|run| (run.text, run.dim, run.inverse))
            .collect()
    }

    /// server/prompt.ts:1414-1439, worked out by hand.
    #[test]
    fn reads_dim_and_inverse_from_sgr_sequences_alone() {
        assert_eq!(
            read("a\x1b[2mb\x1b[7mc\x1b[22md\x1b[0me"),
            [
                ("a", false, false),
                ("b", true, false),
                ("c", true, true),
                ("d", false, true),
                ("e", false, false),
            ]
        );
        // the 2 of a 24-bit color is its mode, and the 5 of a 256 color: neither is dim
        assert_eq!(
            read("\x1b[38;2;1;2;3mx\x1b[48;5;2my"),
            [("x", false, false), ("y", false, false)]
        );
        // an empty SGR resets; other escapes are dropped without changing the state
        assert_eq!(
            read("\x1b[2;7ma\x1b[mb\x1b]8;;u\x07c\x1bMd"),
            [
                ("a", true, true),
                ("b", false, false),
                ("c", false, false),
                ("d", false, false)
            ]
        );
        // a parameter JavaScript reads as NaN changes nothing; leading zeros are the number
        assert_eq!(
            read("\x1b[2:1ma\x1b[0002mb"),
            [("a", false, false), ("b", true, false)]
        );
    }
}
