//! A numbered menu that still owns the screen's end (`fallbackMenu`, server/prompt.ts:1369-1410).

use std::sync::LazyLock;

use protocol::js;
use regex::Regex;

use super::NOT_PROMPT_TEXT;
use crate::text::{
    NUMBERED_OPTION, NumberedRow, SELECTED, is_divider, js_regex, parse_numbered_rows,
    sequential_rows,
};

/// `MENU_HINT_RE`: a line that says to choose.
static MENU_HINT: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"(?i)(?-u:\b)(?:select|choose|pick|confirm|navigate|move|esc|cancel)(?-u:\b)|[↑↓↵⏎]|(?-u:\b)(?:enter|type){s}+(?:(?:a|an|the){s}+)?number(?-u:\b)|(?-u:\b)[0-9]{s}*[-–]{s}*[0-9](?-u:\b)",
    )
});
/// `HINT_LINE_RE`: a line that starts as a hint does.
static HINT_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:[↵⏎]|(?:Press|Enter|Select|Choose|Pick|Type|Esc|ESC)(?-u:\b))").unwrap()
});
/// `/:\s*$/`: a line that ends asking for input.
static ENDS_IN_COLON: LazyLock<Regex> = LazyLock::new(|| js_regex(":{s}*$"));
/// `/\(\w\)$/`: a row that ends in its own letter key, "Read only (r)".
static LETTER_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\([0-9A-Za-z_]\)$").unwrap());
/// What follows the last `:` of `INPUT_FIELD_RE`, with the non-whitespace after it as a group.
static AFTER_COLON: LazyLock<Regex> = LazyLock::new(|| js_regex("^{s}*({S}*)$"));

/// The most lines a row's label wraps onto (`MENU_WRAP_LINES`).
const MENU_WRAP_LINES: usize = 2;

/// `INPUT_FIELD_RE` (`/:\s*\S{0,3}$/`): an input field, "Password:" or "Choice: 2". JavaScript
/// counts the three in UTF-16 code units, so the last `:` is matched and what follows it counted
/// (ADR 0193-phase-2-dependencies, "回数の指定").
fn is_input_field(line: &str) -> bool {
    line.rfind(':').is_some_and(|at| {
        AFTER_COLON
            .captures(&line[at + 1..])
            .is_some_and(|found| js::utf16_len(&found[1]) <= 3)
    })
}

/// `line.search(re)` in UTF-16 code units: where the first character `matches` takes is.
fn search(line: &str, matches: impl Fn(char) -> bool) -> Option<usize> {
    line.find(matches).map(|at| js::utf16_len(&line[..at]))
}

/// A numbered menu's first line and rows.
pub(super) struct Menu {
    pub start: usize,
    pub rows: Vec<NumberedRow>,
}

/// A numbered menu (`1.` … `n.`, 2 to 9 rows, at most one marked) that still owns the screen's end:
/// its hint, a line that says to choose, is the screen's last, and between the last row and it are
/// only the lines that row wraps onto (right under it, indented past its number). Anything else
/// there (another hint, a new prompt, an input box) may be what takes the keys now, so it is no
/// menu. A wrapped label is no guess here, since every row starts with its own number. `shown` are
/// the indices of the lines that are neither blank nor rules, `cleaned` each line's `clean_line`.
pub(super) fn find(lines: &[String], cleaned: &[String], shown: &[usize]) -> Option<Menu> {
    let clean = |index: usize| cleaned[index].as_str();
    let last_row = *shown
        .iter()
        .rev()
        .find(|&&index| NUMBERED_OPTION.is_match(clean(index)))?;
    let hint_index = *shown.last()?;
    if hint_index == last_row {
        return None;
    }
    let hint = clean(hint_index);
    // a hint that says to choose, and no input field ("Password:", "Choice: 2"): a numbered list
    // in the agent's output is not a menu
    if !MENU_HINT.is_match(hint)
        || SELECTED.is_match(hint)
        || NOT_PROMPT_TEXT.is_match(hint)
        || is_input_field(hint)
    {
        return None;
    }
    // the row's number is there: NUMBERED_OPTION matched it
    let number_at = search(&lines[last_row], |c| c.is_ascii_digit());
    let mut end = last_row + 1;
    while end < hint_index
        && !clean(end).is_empty()
        && !is_divider(&lines[end])
        && search(&lines[end], |c| !js::is_whitespace(c)) > number_at
    {
        end += 1;
    }
    if shown
        .iter()
        .any(|&index| index >= end && index < hint_index)
        || end - last_row - 1 > MENU_WRAP_LINES
    {
        return None;
    }
    // up from the last row, through rows and the lines they wrap onto, to a blank line or a rule
    let mut start = last_row;
    while start > 0 && !clean(start - 1).is_empty() && !is_divider(&lines[start - 1]) {
        start -= 1;
    }
    while start < last_row && !NUMBERED_OPTION.is_match(clean(start)) {
        start += 1;
    }
    let mut rows = parse_numbered_rows(lines, start, end);
    if !sequential_rows(&rows)
        || rows.len() < 2
        || rows.len() > 9
        || rows.iter().filter(|row| row.row.selected).count() > 1
    {
        return None;
    }
    // the lines a row wraps onto belong to its label; an input box or quote between rows, or a row
    // with its own letter key ("Read only (r)"), means the number may not be the key
    let next_lines: Vec<usize> = rows
        .iter()
        .skip(1)
        .map(|row| row.row.line_index)
        .chain([end])
        .collect();
    let last = rows.len() - 1;
    for (at, row) in rows.iter_mut().enumerate() {
        let wrapped: Vec<&str> = (row.row.line_index + 1..next_lines[at])
            .map(clean)
            .filter(|line| !line.is_empty())
            .collect();
        // a hint or an input field inside the last row's wrap may be an older prompt, with a new
        // one under it
        if wrapped.iter().any(|line| {
            NOT_PROMPT_TEXT.is_match(line)
                || (at == last && (HINT_LINE.is_match(line) || ENDS_IN_COLON.is_match(line)))
        }) {
            return None;
        }
        // the key may end the row's first line, with a description wrapped under it
        if std::iter::once(row.row.label.as_str())
            .chain(wrapped.iter().copied())
            .any(|line| LETTER_KEY.is_match(line))
        {
            return None;
        }
        for line in wrapped {
            row.row.label.push(' ');
            row.row.label.push_str(line);
        }
    }
    Some(Menu { start, rows })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::clean_line;

    #[test]
    fn an_input_field_counts_what_follows_its_colon_in_utf16_code_units() {
        // ADR 0193-phase-2-dependencies: JavaScript's /:\s*\S{0,3}$/
        assert!(is_input_field("Password:"));
        assert!(is_input_field("Choice: 2"));
        assert!(is_input_field("Pick: abc"));
        assert!(!is_input_field("Pick: abcd"));
        assert!(is_input_field("Select: 😀"));
        assert!(!is_input_field("Select: 😀😀"));
        assert!(!is_input_field("Select: a b"));
        assert!(is_input_field("a: b: c"));
        assert!(!is_input_field("no colon"));
    }

    #[test]
    fn a_hint_word_is_a_word_by_javascripts_ascii_boundaries() {
        // JavaScript's \b sees ASCII word characters only: "éselect" has a boundary before "s"
        assert!(MENU_HINT.is_match("éselect one"));
        assert!(!MENU_HINT.is_match("preselected"));
        assert!(MENU_HINT.is_match("Enter a number"));
        assert!(MENU_HINT.is_match("1-3"));
        assert!(MENU_HINT.is_match("Press ↵"));
    }

    fn lines(text: &str) -> Vec<String> {
        text.split('\n').map(str::to_owned).collect()
    }

    fn shown(lines: &[String]) -> Vec<usize> {
        (0..lines.len())
            .filter(|&index| !clean_line(&lines[index]).is_empty() && !is_divider(&lines[index]))
            .collect()
    }

    fn labels(text: &str) -> Option<Vec<String>> {
        let lines = lines(text);
        let cleaned: Vec<String> = lines.iter().map(|line| clean_line(line)).collect();
        find(&lines, &cleaned, &shown(&lines))
            .map(|menu| menu.rows.into_iter().map(|row| row.row.label).collect())
    }

    #[test]
    fn reads_a_numbered_menu_whose_hint_ends_the_screen() {
        assert_eq!(
            labels("Pick one?\n1. Alpha\n2. Beta\n   wrapped\nSelect a number"),
            Some(vec!["Alpha".into(), "Beta wrapped".into()])
        );
        // a numbered list in the output, with no hint under it
        assert_eq!(labels("1. Alpha\n2. Beta\nDone."), None);
        // a row with its own letter key
        assert_eq!(labels("1. Alpha (a)\n2. Beta\nSelect one"), None);
        // more lines under the last row than it wraps onto
        assert_eq!(
            labels("1. Alpha\n2. Beta\n   a\n   b\n   c\nSelect one"),
            None
        );
        // an input field ends the screen
        assert_eq!(labels("1. Alpha\n2. Beta\nSelect: 2"), None);
    }
}
