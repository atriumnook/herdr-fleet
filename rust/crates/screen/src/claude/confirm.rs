//! Claude Code's unnumbered menus, live in 2.1.285 on a folder it has not seen
//! (`parseClaudeConfirm`, server/prompt.ts:714-779):
//!
//! ```text
//! Accessing workspace:
//! /home/user/project
//! Quick safety check: Is this a project you created or one you trust? (Like your own code,
//! …
//! ❯ No, exit
//!   Yes, I trust this folder
//! Enter to confirm · Esc to cancel
//! ```
//!
//! herdr reports the pane blocked. The rows are the lines right above the hint, up to a blank line
//! or a rule, exactly one of them `❯`; numbered rows are left to the menus above.

use std::sync::LazyLock;

use protocol::{PromptKind, js};
use regex::Regex;

use super::{CONFIRM_HINT, Responder};
use crate::ParsedPrompt;
use crate::answer::Answering;
use crate::card::{self, CardFields, option};
use crate::text::{
    NUMBERED_OPTION, SELECTED, clean_line, find_last_index, is_divider, js_regex, normalize_text,
    screen_lines, wrapped,
};

/// The sentence of the panel's prose that asks, ending in "?".
static ASKED: LazyLock<Regex> = LazyLock::new(|| js_regex(r"(?:^|[.:!]{s}+)([^.:!?]*\?)"));

struct Row {
    label: String,
    selected: bool,
}

/// `text.trimEnd().length`, in UTF-16 code units.
fn trimmed_len(text: &str) -> usize {
    js::utf16_len(js::trim_end(text))
}

pub(super) fn parse(screen: &str) -> Option<ParsedPrompt> {
    let lines = screen_lines(screen);
    let hint_index = find_last_index(&lines, |_, index| {
        CONFIRM_HINT.is_match(&wrapped(&lines, index, 3))
    })?;
    let end = (0..hint_index)
        .rev()
        .find(|&index| !clean_line(&lines[index]).is_empty())?;
    let mut start = end;
    while start > 0 && !clean_line(&lines[start - 1]).is_empty() && !is_divider(&lines[start - 1]) {
        start -= 1;
    }
    // A narrow pane wraps a long label onto the next line, at the label's own indent, so the indent
    // cannot tell a wrapped label from the next row. Words wrap only when the next one no longer
    // fits: a line under a row (without its own ❯) continues that row when its first word would not
    // have fitted after it. The widest line off the rows stands for the pane's width; a row wider
    // than all of them says nothing of it, and the line under it could be either, so a screen like
    // that gets no card rather than one that answers a row it does not show.
    let width = lines
        .iter()
        .enumerate()
        .filter(|(index, _)| *index < start || *index > end)
        .map(|(_, line)| trimmed_len(line))
        .max()
        .unwrap_or(0);
    let mut unsure = false;
    let mut wrapped_from = |above: &str, line: &str| {
        let first_word = line.split(js::is_whitespace).next().unwrap_or("");
        if trimmed_len(above) + 1 + js::utf16_len(first_word) <= width {
            return false;
        }
        if trimmed_len(above) > width {
            unsure = true;
        }
        true
    };
    let mut rows: Vec<Row> = Vec::new();
    for index in start..=end {
        let line = clean_line(&lines[index]);
        let selected = SELECTED.is_match(&line);
        if let Some(previous) = rows.last_mut()
            && !selected
            && wrapped_from(&lines[index - 1], &line)
        {
            previous.label = normalize_text(&format!("{} {line}", previous.label));
            continue;
        }
        rows.push(Row {
            label: js::trim(&SELECTED.replace(&line, "")).to_owned(),
            selected,
        });
    }
    if unsure {
        return None;
    }
    let selected = rows.iter().position(|row| row.selected)?;
    if rows.len() < 2 || rows.len() > 9 || rows.iter().filter(|row| row.selected).count() != 1 {
        return None;
    }
    if rows
        .iter()
        .any(|row| row.label.is_empty() || NUMBERED_OPTION.is_match(&row.label))
    {
        return None;
    }
    // the panel above the rows: its first line names it, a sentence ending in "?" asks
    let top = (0..start)
        .rev()
        .take_while(|&index| start - index <= 30)
        .find(|&index| is_divider(&lines[index]))
        .map_or_else(
            // no rule within the 30 lines: the panel starts where the search stopped
            || start.saturating_sub(30),
            |rule| rule + 1,
        );
    let panel: Vec<String> = lines[top..start]
        .iter()
        .map(|line| clean_line(line))
        .filter(|line| !line.is_empty())
        .collect();
    let first = panel.first().map_or("Choose an option", String::as_str);
    let title = first.strip_suffix(':').unwrap_or(first).to_owned();
    let rest = panel.get(1..).unwrap_or_default();
    let prose = normalize_text(&rest.join(" "));
    let asked = ASKED
        .captures(&prose)
        .map(|found| js::trim(&found[1]).to_owned());
    let body = rest.join("\n");
    Some(card::finish(
        "claude",
        CardFields {
            kind: PromptKind::Menu,
            question: asked.unwrap_or_else(|| title.clone()),
            title,
            body: (!body.is_empty()).then_some(body),
            options: rows.into_iter().map(|row| option(row.label)).collect(),
            custom_option_index: None,
            queued: None,
            fallback: false,
        },
        None,
        Responder::Confirm,
        Answering::menu(selected),
    ))
}
