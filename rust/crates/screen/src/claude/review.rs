//! After several questions Claude shows the answers and asks before sending them
//! (`parseClaudeSubmit`, server/prompt.ts:561-588). The review is one panel from its tabs down to
//! its question, with no rule inside it. A review taller than the pane (long answers, a phone-width
//! pane) is cut off at the top, tabs and heading out of view: then the screen's first line starts
//! it, and only Claude's own answers (`→ …`) and rows make it the review.

use std::sync::LazyLock;

use protocol::PromptKind;
use regex::Regex;

use super::{Responder, TABS};
use crate::ParsedPrompt;
use crate::answer::Answering;
use crate::card::{self, CardFields, option};
use crate::text::{
    clean_line, find_last_index, is_divider, js_regex, parse_numbered_rows, screen_lines,
    sequential_rows,
};

static QUESTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^Ready to submit your answers\?$").unwrap());
/// One of Claude's answers in the review.
static ANSWER: LazyLock<Regex> = LazyLock::new(|| js_regex("^→{s}"));
static HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i)^Review your answers$").unwrap());

pub(super) fn parse(screen: &str) -> Option<ParsedPrompt> {
    let lines = screen_lines(screen);
    let question_index = find_last_index(&lines, |line, _| QUESTION.is_match(&clean_line(line)))?;
    let tabs_index = find_last_index(&lines[..question_index], |line, _| {
        TABS.is_match(&clean_line(line))
    });
    let panel = &lines[tabs_index.map_or(0, |at| at + 1)..question_index];
    if panel.iter().any(|line| is_divider(line)) {
        return None;
    }
    let rows = parse_numbered_rows(&lines, question_index + 1, lines.len());
    let selected = rows.iter().position(|row| row.row.selected)?;
    if !sequential_rows(&rows)
        || rows.len() < 2
        || rows.iter().filter(|row| row.row.selected).count() != 1
    {
        return None;
    }
    let labels: Vec<&str> = rows.iter().map(|row| row.row.label.as_str()).collect();
    if tabs_index.is_none()
        && (!panel.iter().any(|line| ANSWER.is_match(&clean_line(line)))
            || labels != ["Submit answers", "Cancel"])
    {
        return None;
    }
    let body = panel
        .iter()
        .map(|line| clean_line(line))
        .filter(|line| !line.is_empty() && !is_divider(line) && !HEADING.is_match(line))
        .collect::<Vec<_>>()
        .join("\n");
    Some(card::finish(
        "claude",
        CardFields {
            // a menu, not a question: a typed pick submits every answer at once, so it waits for
            // Confirm
            kind: PromptKind::Menu,
            title: "Review your answers".into(),
            question: clean_line(&lines[question_index]),
            body: (!body.is_empty()).then_some(body),
            options: labels.into_iter().map(option).collect(),
            custom_option_index: None,
            queued: None,
            fallback: false,
        },
        None,
        Responder::Submit,
        Answering::menu(selected),
    ))
}
