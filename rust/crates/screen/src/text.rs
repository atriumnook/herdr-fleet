//! Reading the lines of a screen, as every family of readers does (server/prompt.ts:6-196), and
//! the widths of `Bun.stringWidth` and the graphemes of `Intl.Segmenter`. The rules for writing
//! TypeScript's regular expressions and string functions in Rust are in
//! docs/rust-migration/adr/0193-phase-2-dependencies.md; how the widths copy Bun's in
//! docs/rust-migration/adr/0218-bun-string-width.md.

use std::sync::LazyLock;

use protocol::js;
use regex::Regex;
use unicode_segmentation::UnicodeSegmentation;

use width::WidthCounter;

mod width;

/// A regular expression written with JavaScript's classes, which the regex crate's differ from:
/// `{s}` is `\s`, `{S}` is `\S`, `{.}` is `.` without the `s` flag, and `{ws}` is `\s`'s characters,
/// for a class of its own (`[^{ws}→]`).
pub(crate) fn js_regex(pattern: &str) -> Regex {
    let inner = &js::WHITESPACE[1..js::WHITESPACE.len() - 1];
    let written = pattern
        .replace("{s}", js::WHITESPACE)
        .replace("{S}", &format!("[^{inner}]"))
        .replace(
            "{.}",
            &format!(
                "[^{}]",
                &js::LINE_TERMINATOR[1..js::LINE_TERMINATOR.len() - 1]
            ),
        )
        .replace("{ws}", inner);
    Regex::new(&written).unwrap_or_else(|error| panic!("{pattern}: {error}"))
}

/// `ANSI_RE`: a CSI sequence (server/prompt.ts:6).
static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").unwrap());
/// `SELECTED_RE`: the cursor before a menu's row.
pub(crate) static SELECTED: LazyLock<Regex> = LazyLock::new(|| js_regex("^[❯›>]{s}*"));
/// `NUMBERED_OPTION_RE`: a numbered row, `❯ 1. Yes`.
pub(crate) static NUMBERED_OPTION: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"^{s}*([›>❯])?{s}*([0-9]+)\.{s}+({.}+)$"));

/// `text.replace(ANSI_RE, "")`.
pub(crate) fn strip_ansi(text: &str) -> String {
    ANSI.replace_all(text, "").into_owned()
}

/// `text.split(/\r?\n/)`: the last line keeps a `\r` it ends in, the others lose it.
pub(crate) fn split_lines(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    let last = lines.len() - 1;
    for line in &mut lines[..last] {
        *line = line.strip_suffix('\r').unwrap_or(line);
    }
    lines
}

/// The lines of a screen without its CSI sequences: `screen.replace(ANSI_RE, "").split(/\r?\n/)`.
pub(crate) fn screen_lines(screen: &str) -> Vec<String> {
    split_lines(&strip_ansi(screen))
        .into_iter()
        .map(str::to_owned)
        .collect()
}

/// `cleanLine`: a line without CSI sequences, its surrounding whitespace, and one box edge `│` at
/// each end.
pub(crate) fn clean_line(raw: &str) -> String {
    let stripped = strip_ansi(raw);
    let mut line = js::trim(&stripped);
    if let Some(rest) = line.strip_prefix('│') {
        line = js::trim_start(rest);
    }
    if let Some(rest) = line.strip_suffix('│') {
        line = js::trim_end(rest);
    }
    js::trim(line).to_owned()
}

/// `isDivider`: a line of box-drawing rules and whitespace alone (`DIVIDER_RE`).
pub(crate) fn is_divider(line: &str) -> bool {
    let value = clean_line(line);
    !value.is_empty()
        && value
            .chars()
            .all(|c| js::is_whitespace(c) || "╭╮╰╯├┤┬┴┼─━═╌▔".contains(c))
}

/// `normalizeText`: each run of whitespace as one space, none at the ends.
pub(crate) fn normalize_text(value: &str) -> String {
    value
        .split(js::is_whitespace)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// `findLastIndex`: the last index whose line `predicate` takes.
pub(crate) fn find_last_index<T>(
    lines: &[T],
    mut predicate: impl FnMut(&T, usize) -> bool,
) -> Option<usize> {
    (0..lines.len())
        .rev()
        .find(|&index| predicate(&lines[index], index))
}

/// `wrapped`: a line and the `span - 1` after it as one, without blank lines and rules: a narrow
/// pane wraps a hint line, so hints are matched across the wrap.
pub(crate) fn wrapped<T: AsRef<str>>(lines: &[T], index: usize, span: usize) -> String {
    lines
        .iter()
        .skip(index)
        .take(span)
        .map(|line| clean_line(line.as_ref()))
        .filter(|line| !line.is_empty() && !is_divider(line))
        .collect::<Vec<_>>()
        .join(" ")
}

static PLANNING: LazyLock<Regex> = LazyLock::new(|| Regex::new("(?i)^Planning:").unwrap());
static SUBMIT_TAB: LazyLock<Regex> = LazyLock::new(|| js_regex("(?i)^[←→]{.}*Submit"));
static CHIP: LazyLock<Regex> = LazyLock::new(|| js_regex("^[☐☑✔]{s}+{S}"));
static PROGRESS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i)^Question [0-9]+/[0-9]+").unwrap());
static SELECTED_COUNT: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"(?i)^\([0-9]+{s}+selected\){s}*"));

/// `nearestQuestion`: the first line of text among the 14 above `before_index` that is not a rule,
/// a tab bar, a header chip or a progress line.
pub(crate) fn nearest_question<T: AsRef<str>>(lines: &[T], before_index: usize) -> Option<String> {
    for index in (before_index.saturating_sub(14)..before_index).rev() {
        let line = clean_line(lines[index].as_ref());
        if line.is_empty()
            || is_divider(&line)
            || PLANNING.is_match(&line)
            || SUBMIT_TAB.is_match(&line)
            || CHIP.is_match(&line)
            || PROGRESS.is_match(&line)
        {
            continue;
        }
        return Some(js::trim(&SELECTED_COUNT.replace(&line, "")).to_owned());
    }
    None
}

/// A row of a menu.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MenuRow {
    pub label: String,
    pub selected: bool,
    pub checked: bool,
    pub description: Option<String>,
    pub line_index: usize,
}

/// A numbered row of a menu, `1.` and on.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NumberedRow {
    /// the number before the row; a number too long to count is `u64::MAX`
    pub number: u64,
    pub row: MenuRow,
}

static BORDER_CHECKED: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[☑☒✓]").unwrap());
static BORDER_MARK: LazyLock<Regex> = LazyLock::new(|| js_regex("^[○●◉◯☐☑☒✓]{s}*"));

/// `parseBorderMenu`: the rows between two rules of a bordered menu.
pub(crate) fn parse_border_menu<T: AsRef<str>>(
    lines: &[T],
    start_divider: usize,
    end_divider: usize,
) -> Vec<MenuRow> {
    let mut rows = Vec::new();
    for (line_index, line) in lines
        .iter()
        .enumerate()
        .take(end_divider)
        .skip(start_divider + 1)
    {
        let text = clean_line(line.as_ref());
        if text.is_empty() || is_divider(&text) {
            continue;
        }
        let selected = SELECTED.is_match(&text);
        let text = js::trim(&SELECTED.replace(&text, "")).to_owned();
        let checked = BORDER_CHECKED.is_match(&text);
        let text = js::trim(&BORDER_MARK.replace(&text, "")).to_owned();
        if !text.is_empty() {
            rows.push(MenuRow {
                label: normalize_text(&text),
                selected,
                checked,
                description: None,
                line_index,
            });
        }
    }
    rows
}

/// `findMenuDividers`: the two rules nearest above `hint_index`.
pub(crate) fn find_menu_dividers<T: AsRef<str>>(
    lines: &[T],
    hint_index: usize,
) -> Option<(usize, usize)> {
    let mut end = None;
    for index in (0..hint_index).rev() {
        if !is_divider(lines[index].as_ref()) {
            continue;
        }
        match end {
            None => end = Some(index),
            Some(end) => return Some((index, end)),
        }
    }
    None
}

static NUMBERED_CHECKED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[[xX✓✔]\]").unwrap());
static NUMBERED_MARK: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^\[[ xX✓✔]\]{s}*"));

/// `parseNumberedRows`: the numbered rows among lines `start..end`, each with the description a
/// narrow pane wraps under it, up to the next blank line or rule.
pub(crate) fn parse_numbered_rows<T: AsRef<str>>(
    lines: &[T],
    start: usize,
    end: usize,
) -> Vec<NumberedRow> {
    let mut rows = Vec::new();
    for (line_index, line) in lines.iter().enumerate().take(end).skip(start) {
        let stripped = strip_ansi(line.as_ref());
        let Some(found) = NUMBERED_OPTION.captures(js::trim(&stripped)) else {
            continue;
        };
        let label = js::trim(&found[3]);
        // Claude Code 2.1.296 ticks a row with ✔, older ones with ✓
        let checked = NUMBERED_CHECKED.is_match(label);
        let label = js::trim(&NUMBERED_MARK.replace(label, "")).to_owned();
        rows.push(NumberedRow {
            number: found[2].parse().unwrap_or(u64::MAX),
            row: MenuRow {
                label,
                selected: found.get(1).is_some(),
                checked,
                description: None,
                line_index,
            },
        });
    }
    for index in 0..rows.len() {
        let next = rows.get(index + 1).map_or(end, |next| next.row.line_index);
        let mut description = Vec::new();
        for line in lines.iter().take(next).skip(rows[index].row.line_index + 1) {
            let line = clean_line(line.as_ref());
            if !line.is_empty() && !is_divider(&line) {
                description.push(line);
            } else if !description.is_empty() {
                break;
            }
        }
        if !description.is_empty() {
            rows[index].row.description = Some(normalize_text(&description.join(" ")));
        }
    }
    rows
}

/// `menuRows`: a menu's rows among numbered lines read from well above it: the last run that counts
/// up from 1, among the lines numbered in the column of the row the cursor is on (or of the last
/// row, without one).
pub(crate) fn menu_rows<T: AsRef<str>>(lines: &[T], start: usize, end: usize) -> Vec<NumberedRow> {
    let rows = parse_numbered_rows(lines, start, end);
    // `line.replace(ANSI_RE, "").search(/\d/)`, in UTF-16 code units
    let column = |row: &NumberedRow| {
        let line = strip_ansi(lines[row.row.line_index].as_ref());
        line.find(|c: char| c.is_ascii_digit())
            .map(|at| js::utf16_len(&line[..at]))
    };
    let anchor = rows
        .iter()
        .rev()
        .find(|row| row.row.selected)
        .or(rows.last())
        .map(column);
    let menu: Vec<NumberedRow> = match anchor {
        None => rows,
        Some(anchor) => rows
            .into_iter()
            .filter(|row| column(row) == anchor)
            .collect(),
    };
    let first = menu.iter().rposition(|row| row.number == 1).unwrap_or(0);
    menu.into_iter().skip(first).collect()
}

/// `sequentialRows`: rows numbered 1, 2, 3 and on, and at least one.
pub(crate) fn sequential_rows(rows: &[NumberedRow]) -> bool {
    !rows.is_empty()
        && rows
            .iter()
            .enumerate()
            .all(|(index, row)| row.number == index as u64 + 1)
}

/// `cleanLines` of `promptTailIsActive` (server/prompt.ts:823): each line of the screen cleaned,
/// blank lines included.
pub(crate) fn clean_lines(screen: &str) -> Vec<String> {
    screen_lines(screen)
        .iter()
        .map(|line| clean_line(line))
        .collect()
}

/// `visible` of `promptTailIsActive` (server/prompt.ts:824): the cleaned lines without blank lines
/// and rules.
pub(crate) fn visible_lines(screen: &str) -> Vec<String> {
    clean_lines(screen)
        .into_iter()
        .filter(|line| !line.is_empty() && !is_divider(line))
        .collect()
}

/// The `ends` of `promptTailIsActive` (server/prompt.ts:832-833): whether `pattern` matches what
/// ends `shown`. A narrow pane wraps a hint, so the last line alone can be its tail: the two lines
/// before it count only when the match runs into the last one.
pub(crate) fn ends<T: AsRef<str>>(shown: &[T], pattern: &Regex) -> bool {
    let joined = |from: usize, to: usize| {
        shown[from..to]
            .iter()
            .map(AsRef::as_ref)
            .collect::<Vec<_>>()
            .join(" ")
    };
    let len = shown.len();
    (1..=3).any(|span| {
        let from = len.saturating_sub(span);
        pattern.is_match(&joined(from, len))
            && (span == 1 || !pattern.is_match(&joined(from, len.saturating_sub(1).max(from))))
    })
}

/// `Intl.Segmenter`'s graphemes of `text` (granularity `grapheme`), each with its byte index.
/// unicode-segmentation's extended graphemes split every line of the screen corpus as it does (ADR
/// 0193-phase-2-dependencies).
pub(crate) fn graphemes(text: &str) -> impl Iterator<Item = (usize, &str)> {
    text.grapheme_indices(true)
}

/// The states of Bun's escape sequence reader (`consumeANSI`, src/jsc/bindings/ANSIHelpers.h of
/// Bun 1.4.4, the side for UTF-16 and Latin-1).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Escape {
    Start,
    GotEsc,
    IgnoreNextChar,
    InCsi,
    InOsc,
    InOscGotEsc,
    NeedSt,
    NeedStGotEsc,
}

/// Whether Bun starts reading an escape sequence at `c` (`isEscapeCharacter`).
fn starts_escape(c: char) -> bool {
    matches!(
        c,
        '\u{1b}' | '\u{9b}' | '\u{9d}' | '\u{90}' | '\u{98}' | '\u{9e}' | '\u{9f}'
    )
}

/// Bun's `consumeANSI` on `chars[at..]`, which starts with an escape character: where the escape
/// sequences that start there end, a sequence followed right away by another included.
fn consume_escape(chars: &[char], at: usize) -> usize {
    let mut state = Escape::Start;
    let mut index = at;
    while index < chars.len() {
        let c = chars[index];
        match state {
            Escape::Start => match c {
                '\u{1b}' => state = Escape::GotEsc,
                '\u{9b}' => state = Escape::InCsi,
                '\u{9d}' => state = Escape::InOsc,
                '\u{90}' | '\u{98}' | '\u{9e}' | '\u{9f}' => state = Escape::NeedSt,
                _ => return index,
            },
            Escape::InOscGotEsc | Escape::NeedStGotEsc if c == '\\' => {
                // ESC \ is the string terminator
                state = Escape::Start;
            }
            Escape::GotEsc | Escape::InOscGotEsc | Escape::NeedStGotEsc => match c {
                // ESC aborts the sequence in progress and introduces a new one
                '\u{1b}' => state = Escape::GotEsc,
                // CAN and SUB abort the sequence; the character is consumed
                '\u{18}' | '\u{1a}' => state = Escape::Start,
                '[' => state = Escape::InCsi,
                ']' => state = Escape::InOsc,
                'P' | 'X' | '^' | '_' => state = Escape::NeedSt,
                // intermediate bytes: the character after them ends the sequence
                '\u{20}'..='\u{2f}' => state = Escape::IgnoreNextChar,
                // the final byte of a two-byte escape, or the C1 ST
                '\u{30}'..='\u{7e}' | '\u{9c}' => state = Escape::Start,
                // anything else cannot continue a sequence: only the ESC is consumed
                _ => return index,
            },
            Escape::IgnoreNextChar => {
                // Bun skips one UTF-16 code unit; a character outside the BMP leaves its second
                // half, which takes no columns, so skipping the whole character counts the same
                state = if c == '\u{1b}' {
                    Escape::GotEsc
                } else {
                    Escape::Start
                };
            }
            Escape::InCsi => {
                // the final byte; ESC, CAN, SUB and ST abort the sequence
                if c == '\u{1b}' {
                    state = Escape::GotEsc;
                } else if matches!(c, '\u{40}'..='\u{7e}' | '\u{18}' | '\u{1a}' | '\u{9c}') {
                    state = Escape::Start;
                }
            }
            Escape::InOsc | Escape::NeedSt => {
                // OSC ends at BEL or ST, the control strings at ST; CAN and SUB abort them
                if c == '\u{1b}' {
                    state = if state == Escape::InOsc {
                        Escape::InOscGotEsc
                    } else {
                        Escape::NeedStGotEsc
                    };
                } else if matches!(c, '\u{9c}' | '\u{18}' | '\u{1a}')
                    || (c == '\u{7}' && state == Escape::InOsc)
                {
                    state = Escape::Start;
                }
            }
        }
        index += 1;
    }
    chars.len()
}

/// The terminal columns `text` takes, as `Bun.stringWidth` counts them (Bun 1.4.4,
/// `visibleUTF16Width` with escape sequences excluded and ambiguous characters narrow): escape
/// sequences take none, read as Bun reads them; the rest is split into graphemes by Bun's own rules
/// and each grapheme counted as Bun's `GraphemeState::width` counts it (ADR 0218-bun-string-width).
/// Bun carries the grapheme across an escape sequence, so `❤ ESC[31m U+FE0F` is 2 columns.
pub(crate) fn string_width(text: &str) -> usize {
    let chars: Vec<char> = text.chars().collect();
    let mut counter = WidthCounter::default();
    let mut index = 0;
    while index < chars.len() {
        if starts_escape(chars[index]) {
            index = consume_escape(&chars, index);
            continue;
        }
        counter.push(chars[index]);
        index += 1;
    }
    counter.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<String> {
        text.split('\n').map(str::to_owned).collect()
    }

    #[test]
    fn splits_lines_as_javascripts_split_on_an_optional_cr_and_a_newline() {
        // ADR 0193-phase-2-dependencies, "行に分ける": the values of `split(/\r?\n/)`
        assert_eq!(split_lines("abc\r"), ["abc\r"]);
        assert_eq!(split_lines("a\r\nb\r"), ["a", "b\r"]);
        assert_eq!(split_lines("a\n"), ["a", ""]);
        assert_eq!(split_lines(""), [""]);
    }

    #[test]
    fn cleans_a_line_of_its_escapes_whitespace_and_box_edges() {
        // what TypeScript's cleanLine returns (Bun 1.4.4)
        assert_eq!(
            clean_line("  \x1b[1m│ Which target? │\x1b[0m  "),
            "Which target?"
        );
        assert_eq!(clean_line("│"), "");
        assert_eq!(clean_line("\u{feff} a \u{3000}"), "a");
        assert_eq!(clean_line("││ a ││"), "│ a │");
    }

    #[test]
    fn tells_a_rule_from_a_line_of_text() {
        assert!(is_divider("╭──── ────╮"));
        assert!(is_divider("│ ─── │"));
        assert!(!is_divider("   "));
        assert!(!is_divider("── a ──"));
    }

    #[test]
    fn normalizes_whitespace_as_typescript_does() {
        // `"  a\t  b ﻿".replace(/\s+/g, " ").trim()` is "a b"
        assert_eq!(normalize_text("\u{a0} a\t\u{2028} b \u{feff}"), "a b");
        assert_eq!(normalize_text("a\u{85}b"), "a\u{85}b");
    }

    #[test]
    fn joins_a_wrapped_hint_without_its_blank_lines_and_rules() {
        let lines = lines("Enter to select · ↑/↓ to navigate · Esc to\n\n────\ncancel\nmore");
        assert_eq!(
            wrapped(&lines, 0, 3),
            "Enter to select · ↑/↓ to navigate · Esc to"
        );
        assert_eq!(wrapped(&lines, 1, 3), "cancel");
        assert_eq!(wrapped(&lines, 3, 3), "cancel more");
        assert_eq!(wrapped(&lines, 9, 3), "");
    }

    /// The numbered rows of Codex's questions: what TypeScript's `parseNumberedRows` and `menuRows`
    /// return for these lines (Bun 1.4.4, server/prompt.ts of this branch).
    #[test]
    fn reads_numbered_rows_with_their_wrapped_descriptions() {
        let lines = lines(concat!(
            "› 1. sent before\n",
            "Which one?\n",
            "\x1b[2m› 1. [✔] Alpha\x1b[0m\n",
            "     The first\n",
            "     of them\n",
            "\n",
            "  2. [ ] Beta\n",
            "  3. Gamma\n",
            "────\n",
            "     not a description\n",
        ));
        let rows = parse_numbered_rows(&lines, 0, lines.len());
        let read: Vec<_> = rows
            .iter()
            .map(|row| {
                (
                    row.number,
                    row.row.label.as_str(),
                    row.row.selected,
                    row.row.checked,
                    row.row.description.as_deref(),
                    row.row.line_index,
                )
            })
            .collect();
        assert_eq!(
            read,
            [
                (1, "sent before", true, false, Some("Which one?"), 0),
                (1, "Alpha", true, true, Some("The first of them"), 2),
                (2, "Beta", false, false, None, 6),
                // a rule right under a row ends no description: none has begun yet
                (3, "Gamma", false, false, Some("not a description"), 7),
            ]
        );
        assert!(!sequential_rows(&rows));
        let menu = menu_rows(&lines, 0, lines.len());
        let numbers: Vec<_> = menu
            .iter()
            .map(|row| (row.number, row.row.line_index))
            .collect();
        assert_eq!(numbers, [(1, 2), (2, 6), (3, 7)]);
        assert!(sequential_rows(&menu));
        assert!(!sequential_rows(&[]));
    }

    #[test]
    fn reads_a_menu_in_the_column_of_its_cursor() {
        // a numbered line in a description is indented further than the menu's rows
        let lines = lines("❯ 1. Yes\n     1. inside the description\n  2. No");
        let menu = menu_rows(&lines, 0, lines.len());
        let numbers: Vec<_> = menu
            .iter()
            .map(|row| (row.number, row.row.line_index))
            .collect();
        assert_eq!(numbers, [(1, 0), (2, 2)]);
    }

    #[test]
    fn matches_a_hint_that_ends_the_lines() {
        let hint = Regex::new("(?i)esc to cancel").unwrap();
        assert!(ends(&["out", "Esc to cancel"], &hint));
        // wrapped: the last line is the hint's tail
        assert!(ends(&["out", "Esc to", "cancel"], &hint));
        // answered: the hint ended above later output
        assert!(!ends(&["Esc to cancel", "later output"], &hint));
        assert!(!ends::<&str>(&[], &hint));
    }

    /// ADR 0193-phase-2-dependencies, "文字の幅と grapheme": Bun 1.4.4's `Bun.stringWidth`.
    #[test]
    fn counts_widths_as_bun_string_width() {
        let table = [
            ("a\x1b[31mb", 2),
            ("a\x1b]8;;http://x\x07b", 2),
            ("a\x1b]8;;http://x\x1b\\b", 2),
            ("a\x1bb", 1),
            ("a\x1b(Bb", 2),
            ("a\x7fb", 2),
            ("a\u{9b}31mb", 2),
            ("a\u{85}b", 2),
            ("a\tb", 2),
            ("a\u{200b}b", 2),
            ("👨\u{200d}👩\u{200d}👧", 2),
            ("☺\u{fe0f}", 2),
            ("e\u{301}", 1),
            ("…─○", 3),
            ("あ", 2),
            ("a\x1b]8;;xb", 1),
            ("a\x1b😀b", 4),
            ("a\x1bé b", 4),
            ("a\x1b(😀b", 2),
            ("a\x1b\x1b[31mb", 2),
            ("a\x1b b", 1),
            ("a\x1b\x7fb", 2),
            ("a\x1b", 1),
            ("a\x1b\u{9b}\x18b", 2),
            ("a\x1b\u{9b}\x1ab", 2),
            ("a\x1b((b", 2),
            ("a\x1bPb", 1),
            // a control character ends the grapheme, an escape sequence does not (Bun 1.4.4)
            ("❤\t\u{fe0f}", 1),
            ("❤\x1b[31m\u{fe0f}", 2),
            ("e\x07\u{301}", 1),
            ("👨\0\u{200d}👩", 4),
        ];
        for (text, width) in table {
            assert_eq!(string_width(text), width, "{text:?}");
        }
    }

    /// Issue #218: what Bun 1.4.4's `Bun.stringWidth` returns for spacing marks, emoji sequences
    /// and each case of its grapheme width rules (measured with Bun 1.4.4).
    #[test]
    fn counts_marks_and_emoji_sequences_as_bun_string_width() {
        let table = [
            // spacing combining marks (Mc) take no columns
            ("का", 1),
            ("किताब", 3),
            ("क्ष", 2),
            // an emoji with a ZWJ, a regional indicator with a mark
            ("❤\u{200d}", 2),
            ("👍\u{200d}", 2),
            ("🇦\u{301}", 2),
            // regional indicators: a pair is a flag, one alone is narrow
            ("🇯🇵", 2),
            ("🇯🇵🇺", 3),
            ("🇦", 1),
            ("🇦🇧🇨", 3),
            // keycaps
            ("1\u{fe0f}\u{20e3}", 2),
            ("#\u{20e3}", 2),
            ("x\u{20e3}", 2),
            ("\u{20e3}", 2),
            // skin tones: on a base they join it, alone they are wide
            ("👍🏽", 2),
            ("🏽", 2),
            ("a🏽", 3),
            ("😀🏻", 4),
            // variation selectors
            ("❤\u{fe0f}", 2),
            ("❤\u{fe0e}", 1),
            ("☺\u{fe0e}", 1),
            ("©\u{fe0f}", 2),
            ("®\u{fe0f}", 2),
            ("a\u{fe0f}", 1),
            ("中\u{fe0e}", 2),
            // Bun ends a grapheme before ASCII and its fast-path letters, and UAX #29 does not
            // after a prepended concatenation mark
            ("\u{600}a\u{fe0f}", 1),
            ("\u{600}\u{915}\u{fe0f}", 0),
            // Hangul jamo
            ("\u{1100}\u{1161}", 2),
            ("\u{1100}가", 4),
            // full width, soft hyphen, zero width joiner
            ("Ａ", 2),
            ("\u{3000}", 2),
            ("\u{2e80}", 2),
            ("\u{ad}", 0),
            ("\u{200d}", 0),
            // a C1 control is not an escape, a mark after an escape joins the grapheme before it
            ("e\u{85}\u{301}", 1),
            ("a\x1b[31m\u{301}", 1),
            ("\u{915}\x1b[1m\u{93e}", 1),
        ];
        for (text, width) in table {
            assert_eq!(string_width(text), width, "{text:?}");
        }
    }

    /// The columns of a preview's lines as `indexAtColumn` sums them (server/prompt.ts:428-433):
    /// `Bun.stringWidth` of each segment `Intl.Segmenter` gives, and of the whole line (Bun 1.4.4).
    /// unicode-segmentation's graphemes are not Bun's: `U+0600 a U+FE0F` is one segment, which Bun
    /// counts as 1.
    #[test]
    fn sums_the_widths_of_graphemes_as_bun_and_intl_segmenter_do() {
        let table = [
            ("❯ 1. किताब  ┌──", 13, 13),
            ("  2. 🇯🇵 flag   │ x", 18, 18),
            ("  3. 👨\u{200d}👩\u{200d}👧 family │", 16, 16),
            ("\u{600}a\u{fe0f} b", 3, 3),
            ("क्ष ❤\u{200d} e\u{301} │", 9, 9),
            ("1\u{fe0f}\u{20e3} 🇦\u{301} ├", 7, 7),
        ];
        for (line, summed, whole) in table {
            let sum: usize = graphemes(line).map(|(_, g)| string_width(g)).sum();
            assert_eq!(sum, summed, "{line:?}");
            assert_eq!(string_width(line), whole, "{line:?}");
        }
    }

    #[test]
    fn a_grapheme_of_control_characters_takes_no_columns() {
        // ADR 0193-phase-2-dependencies: Bun.stringWidth is 0 for ESC and BEL alone
        assert_eq!(string_width("\x1b"), 0);
        assert_eq!(string_width("\x07"), 0);
        assert_eq!(string_width("\r\n"), 0);
        assert_eq!(string_width("あ"), 2);
        assert_eq!(string_width("👨\u{200d}👩\u{200d}👧"), 2);
        let split: Vec<_> = graphemes("e\u{301}👨\u{200d}👩\u{200d}👧a").collect();
        assert_eq!(
            split,
            [(0, "e\u{301}"), (3, "👨\u{200d}👩\u{200d}👧"), (21, "a")]
        );
    }
}
