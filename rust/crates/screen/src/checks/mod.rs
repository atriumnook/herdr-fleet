//! The agent adapters' looks at their CLIs' screens (server/fleet/adapters.ts:98-130, 147-476), and
//! Cursor's usage screen (`cursorUsage`).
//!
//! TypeScript reads lines with the `m` flag (`/^\s*Error: (.+)$/gm`). Here each line, split where
//! JavaScript ends a line (`\n`, `\r`, U+2028, U+2029), is matched without it (ADR
//! 0193-phase-2-dependencies, "`m` フラグ"). In these patterns only a `\s*` next to `^` or `$` can run
//! past a line's end, over lines of whitespace alone: such a match takes the same text into its
//! groups as the line's own match, and starts no later than that line, with whitespace alone
//! between. So the answers are TypeScript's, U+2028 included, which `(?mR)` does not end a line at.

mod adapters;
mod usage;
mod vt;

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

/// The lines of `text` as a regular expression with the `m` flag sees them, each with its byte
/// index.
fn js_lines(text: &str) -> impl Iterator<Item = (usize, &str)> {
    let mut start = 0;
    let mut ends = text
        .char_indices()
        .filter(|&(_, c)| js::is_line_terminator(c))
        .map(|(at, c)| (at, at + c.len_utf8()))
        .chain([(text.len(), text.len())]);
    std::iter::from_fn(move || {
        let (end, next) = ends.next()?;
        let line = (start, &text[start..end]);
        start = next;
        Some(line)
    })
}

/// `lastMatch(output, /<line>/gm)`: the first group of the last line `line` matches, trimmed, if any
/// is left.
fn last_match(output: &str, line: &Regex) -> Option<String> {
    let found = js_lines(output)
        .filter_map(|(_, text)| line.captures(text))
        .last()?;
    let text = js::trim(found.get(1).map_or("", |group| group.as_str()));
    (!text.is_empty()).then(|| text.to_owned())
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
    use super::js_lines;

    #[test]
    fn splits_lines_where_javascript_ends_them() {
        let lines: Vec<_> = js_lines("a\r\nb\u{2028}c\n").collect();
        assert_eq!(lines, [(0, "a"), (2, ""), (3, "b"), (7, "c"), (9, "")]);
        assert_eq!(js_lines("").collect::<Vec<_>>(), [(0, "")]);
    }
}
