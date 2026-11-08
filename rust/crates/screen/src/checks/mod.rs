//! The agent adapters' looks at their CLIs' screens (server/fleet/adapters.ts:98-130, 147-476), and
//! Cursor's usage screen (`cursorUsage`).
//!
//! TypeScript reads lines with the `m` flag (`/^\s*Error: (.+)$/gm`), whose `^` and `$` stand at each
//! of JavaScript's line terminators (`\n`, `\r`, U+2028, U+2029; `\r\n` is two of them). The regex
//! crate's `(?m)` stands at `\n` alone, so the text is matched with the other three written as `\n`
//! (`multiline`): each is one character, as `\n` is, and the patterns' `\s` and `.` are JavaScript's
//! (`js_regex`), so the matches are JavaScript's. `(?mR)` would not end a line at U+2028 (ADR
//! 0193-phase-2-dependencies, "`m` フラグ"), and matching line by line would miss a `\s` that runs
//! into the next line (`■\nreason` is a failed turn of Codex's).

mod adapters;
mod usage;
mod vt;

use std::borrow::Cow;

use protocol::{FleetAgentKind, UsageReading, js};
use regex::Regex;

use crate::ScreenChecks;

/// The looks of the adapter of `kind` (`adapterFor`).
pub(crate) fn for_kind(kind: FleetAgentKind) -> ScreenChecks {
    match kind {
        FleetAgentKind::Pi => adapters::PI,
        FleetAgentKind::Claude => adapters::CLAUDE,
        FleetAgentKind::Codex => adapters::CODEX,
        FleetAgentKind::Cursor => adapters::CURSOR,
        FleetAgentKind::Agy => adapters::AGY,
        FleetAgentKind::Opencode => adapters::OPENCODE,
    }
}

/// `cursorUsage`.
pub(crate) fn cursor_usage(screen: &str, now: i64) -> Option<UsageReading> {
    usage::cursor_usage(screen, now)
}

/// `text` with each of JavaScript's line terminators written as `\n`, for a pattern with `(?m)`. A
/// group that takes no line terminator holds the same text as in `text`.
fn multiline(text: &str) -> Cow<'_, str> {
    if text.contains(['\r', '\u{2028}', '\u{2029}']) {
        Cow::Owned(text.replace(['\r', '\u{2028}', '\u{2029}'], "\n"))
    } else {
        Cow::Borrowed(text)
    }
}

/// `lastMatch(output, pattern)` for a `pattern` with the `m` flag (`(?m)` here): its first group in
/// the last match, trimmed, if any is left.
fn last_match(output: &str, pattern: &Regex) -> Option<String> {
    let text = multiline(output);
    let found = pattern.captures_iter(&text).last()?;
    let trimmed = js::trim(found.get(1).map_or("", |group| group.as_str()));
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// `openQuestion`: the question whose pattern shows last on the screen, after the CLI's last input
/// line (at `input_at`, a byte index, `None` without one): one answered stays in the scrollback above
/// the input drawn after it, and asks nothing any more.
fn open_question(
    screen: &str,
    input_at: Option<usize>,
    questions: &[(&Regex, &'static str)],
) -> Option<String> {
    let mut open: Option<(usize, &str)> = None;
    for (pattern, text) in questions {
        let Some(at) = pattern.find_iter(screen).last().map(|found| found.start()) else {
            continue;
        };
        if Some(at) > input_at && open.is_none_or(|(open_at, _)| at > open_at) {
            open = Some((at, text));
        }
    }
    open.map(|(_, text)| text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::multiline;
    use crate::text::js_regex;

    /// Where JavaScript's `/^|$/gm` matches in `a\r\nb\u2028c` (Bun 1.4.4): `^` at 0, 2, 3 and 5
    /// (UTF-16 indices), `$` at 1, 2 and 4, and both at the end.
    #[test]
    fn ends_lines_where_javascript_ends_them() {
        let text = multiline("a\r\nb\u{2028}c");
        assert_eq!(text, "a\n\nb\nc");
        let starts: Vec<usize> = js_regex("(?m)^")
            .find_iter(&text)
            .map(|found| found.start())
            .collect();
        assert_eq!(starts, [0, 2, 3, 5]);
        let ends: Vec<usize> = js_regex("(?m)$")
            .find_iter(&text)
            .map(|found| found.start())
            .collect();
        assert_eq!(ends, [1, 2, 4, 6]);
    }
}
