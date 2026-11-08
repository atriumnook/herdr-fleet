//! Claude Code's questions (AskUserQuestion), of one choice or several, with or without previews
//! (`parseClaudeQuestion`, `claudeChip`, `claudeTabs` and `claudeQuestionText`,
//! server/prompt.ts:453-559).

use std::sync::LazyLock;

use protocol::{PromptKind, js};
use regex::Regex;

use super::preview::{PREVIEW_HINT, without_preview};
use super::{ASK_HINT, Responder, SOLID_RULE, TABS};
use crate::ParsedPrompt;
use crate::answer::{Answering, Key, Multiple, OptionKeys, Typed};
use crate::card::{self, CardFields};
use crate::text::{
    NumberedRow, SELECTED, clean_line, find_last_index, is_divider, js_regex, menu_rows,
    nearest_question, normalize_text, screen_lines, sequential_rows, wrapped,
};

/// The unnumbered Submit row of a multiple choice, between the typed answer and "Chat about this".
static SUBMIT_ROW: LazyLock<Regex> = LazyLock::new(|| js_regex("^(?:[›>❯]{s}*)?Submit$"));
/// The row that takes a typed answer, before anything is typed into it.
static TYPE_SOMETHING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^Type something\.?$").unwrap());
/// A row of a multiple choice, with its tick box.
static TICK_ROW: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"^{s}*(?:[›>❯]{s}*)?[0-9]+\.{s}+\[[ xX✓✔]\]"));
/// A single question's header chip, `☐ Dataset`.
static CHIP: LazyLock<Regex> = LazyLock::new(|| js_regex("^[☐☒☑✔]{s}+({S}{.}*)$"));
/// What starts a header chip.
static CHIP_START: LazyLock<Regex> = LazyLock::new(|| js_regex("^[☐☒☑✔]{s}+{S}"));
/// A tab of the bar: its mark and its label, up to two spaces or the bar's end (the lookahead of
/// server/prompt.ts:540 consumed, ADR 0193-phase-2-dependencies, "先読み").
static TAB: LazyLock<Regex> = LazyLock::new(|| js_regex("([☐☒☑✔]){s}+({.}+?)(?:{s}{2,}|{s}*$)"));

/// The rows a narrow pane can take back up to: a question's options are read from this far above
/// its hint.
const ROWS_ABOVE: usize = 64;

pub(super) fn parse(screen: &str) -> Option<ParsedPrompt> {
    let raw = screen_lines(screen);
    let hint_index = find_last_index(&raw, |_, index| ASK_HINT.is_match(&wrapped(&raw, index, 3)))?;
    let preview = PREVIEW_HINT.is_match(&wrapped(&raw, hint_index, 3));
    let top = hint_index.saturating_sub(ROWS_ABOVE);
    let lines = if preview {
        without_preview(&raw, top, hint_index)
    } else {
        raw
    };
    // with a preview the options end at the rule above "Chat about this": nothing under it is theirs
    let end = if preview {
        find_last_index(&lines[..hint_index], |line, _| is_divider(line))?
    } else {
        hint_index
    };
    let rows = menu_rows(&lines, top, end);
    // a multiple choice draws an unnumbered Submit row between the typed answer and "Chat about
    // this", which the cursor moves through like any other row
    let submit_line = match rows.as_slice() {
        [.., before, last] => lines[before.row.line_index + 1..last.row.line_index]
            .iter()
            .map(|line| clean_line(line))
            .find(|line| SUBMIT_ROW.is_match(line)),
        _ => None,
    };
    let on_submit = submit_line
        .as_ref()
        .is_some_and(|line| SELECTED.is_match(line));
    let selected_rows = rows.iter().filter(|row| row.row.selected).count();
    if !sequential_rows(&rows) || selected_rows != usize::from(!on_submit) {
        return None;
    }
    let first_row = rows[0].row.line_index;
    let chat_index = rows
        .iter()
        .position(|row| row.row.label == "Chat about this");
    let mut custom_index = rows
        .iter()
        .position(|row| TYPE_SOMETHING.is_match(&row.row.label));
    // typed into, the row shows the draft instead of "Type something.", with the cursor on it or
    // not (2.1.295): in Claude's own form, where the question is named by its chip or tabs and a
    // rule parts that row from "Chat about this", it is still the typed answer's
    let drafted = custom_index.is_none()
        && !preview
        && chat_index.is_some_and(|chat| {
            chat > 1
                && lines[rows[chat - 1].row.line_index + 1..rows[chat].row.line_index]
                    .iter()
                    .any(|line| is_divider(line))
                && (tabs(&lines, first_row).is_some() || chip(&lines, first_row).is_some())
        });
    if drafted {
        custom_index = chat_index.map(|chat| chat - 1);
    }
    if preview {
        // its notes are no answer of their own: no typed-answer row, the options are the menu
        if custom_index.is_some() || chat_index.is_some() {
            return None;
        }
    } else {
        let (Some(chat), Some(custom)) = (chat_index, custom_index) else {
            return None;
        };
        if chat != rows.len() - 1 || custom + 1 != chat || custom < 1 {
            return None;
        }
    }
    let tabs = tabs(&lines, first_row);
    let question = question_text(&lines, tabs.as_ref().map(|tabs| tabs.index), first_row)
        .or_else(|| nearest_question(&lines, first_row))
        .filter(|question| !question.is_empty())?;
    let chip = if tabs.is_none() {
        chip(&lines, first_row)
    } else {
        None
    };
    let option_rows: &[NumberedRow] = match custom_index {
        Some(custom) if !preview => &rows[..custom],
        _ => &rows,
    };
    let multi_select = option_rows
        .iter()
        .any(|row| TICK_ROW.is_match(&lines[row.row.line_index]));
    if on_submit && !multi_select {
        return None;
    }
    let submit = multi_select && submit_line.is_some();
    let row_at = rows.iter().position(|row| row.row.selected);
    // the cursor's place among the rows it moves through, Submit counted before the last one
    let last = rows.len() - 1;
    let selected = match row_at {
        _ if on_submit => last,
        Some(at) if submit && at == last => at + 1,
        Some(at) => at,
        // the check of the cursor above leaves no such screen; one would get no card, as in TypeScript
        None => return None,
    };
    let current = tabs.as_ref().and_then(|bar| Some((bar, bar.current()?)));
    let title = match current {
        Some((bar, current)) => {
            let label = &bar.tabs[current].label;
            // a bar cut off by a narrow pane does not show how many questions there are
            if bar.whole && bar.tabs.len() > 1 {
                format!("{label} · {} of {}", current + 1, bar.tabs.len())
            } else {
                label.clone()
            }
        }
        _ => chip.unwrap_or_else(|| {
            if multi_select {
                "Multiple choice".into()
            } else {
                "Question".into()
            }
        }),
    };
    // a multiple choice takes its typed answer where its Submit row shows: Enter there sends it
    let custom_option_index = custom_index.filter(|_| !preview && (!multi_select || submit));
    let typed = custom_option_index.map(|row| Typed {
        row,
        // an answer typed into the draft would join it, so once the cursor is in the row it is
        // emptied first, after the cursor and before it (ctrl+k, ctrl+u; measured on 2.1.295)
        before: if drafted {
            vec![Key::CtrlK, Key::CtrlU]
        } else {
            Vec::new()
        },
        // a multiple choice: typing into the row ticks it, and Enter on Submit, the row under it,
        // sends the choice (→ in the row would move the text's cursor; measured on 2.1.301)
        after: if multi_select {
            vec![Key::Down, Key::Enter]
        } else {
            vec![Key::Enter]
        },
    });
    let multiple = multi_select.then(|| Multiple {
        checked: option_rows
            .iter()
            .enumerate()
            .filter(|(_, row)| row.row.checked)
            .map(|(index, _)| index)
            .collect(),
        toggle: Key::Enter,
        // → leaves the choice for the next question or the review of the answers, never an
        // enter: on the next question it would pick that question's first option
        finish: vec![Key::Right],
    });
    Some(card::finish(
        "claude",
        CardFields {
            kind: PromptKind::Question,
            title,
            question,
            body: None,
            options: option_rows
                .iter()
                .map(|row| protocol::InteractivePromptOption {
                    label: row.row.label.clone(),
                    description: row.row.description.clone(),
                })
                .collect(),
            custom_option_index,
            queued: None,
            fallback: false,
        },
        None,
        Responder::Question,
        Answering {
            selected,
            options: OptionKeys::Menu { escape: None },
            typed,
            multiple,
        },
    ))
}

/// `claudeChip`: a single question's header chip (`☐ Dataset`), the question's own short name.
fn chip<T: AsRef<str>>(lines: &[T], first_row: usize) -> Option<String> {
    for index in (first_row.saturating_sub(40)..first_row).rev() {
        let line = clean_line(lines[index].as_ref());
        if is_divider(&line) || TABS.is_match(&line) {
            return None;
        }
        if let Some(chip) = CHIP.captures(&line) {
            return Some(js::trim(&chip[1]).to_owned());
        }
    }
    None
}

/// A tab of Claude's bar of questions.
#[derive(Debug, PartialEq)]
struct Tab {
    label: String,
    answered: bool,
}

/// Claude's bar of questions above several questions.
#[derive(Debug, PartialEq)]
struct Tabs {
    /// the bar's line
    index: usize,
    /// whether the bar shows its right end, not cut off by a narrow pane
    whole: bool,
    tabs: Vec<Tab>,
}

impl Tabs {
    /// The first question not answered yet.
    fn current(&self) -> Option<usize> {
        self.tabs.iter().position(|tab| !tab.answered)
    }
}

/// `claudeTabs`: Claude's question tabs above several questions, `←  ☒ Route  ☐ Author  ✔ Submit  →`,
/// looked for up the panel however far a long question wraps; a narrow pane can cut the bar off at
/// its right edge. ☐ is unanswered, ☒ answered, ✔ the Submit step.
fn tabs<T: AsRef<str>>(lines: &[T], before_index: usize) -> Option<Tabs> {
    for index in (before_index.saturating_sub(60)..before_index).rev() {
        let line = clean_line(lines[index].as_ref());
        if SOLID_RULE.is_match(&line) {
            return None;
        }
        if !TABS.is_match(&line) {
            continue;
        }
        let bar = line.strip_prefix('←').unwrap_or(&line);
        let bar = bar.strip_suffix('→').unwrap_or(bar);
        let tabs = TAB
            .captures_iter(bar)
            .filter(|tab| &tab[1] != "✔")
            .map(|tab| Tab {
                label: js::trim(&tab[2]).to_owned(),
                answered: &tab[1] != "☐",
            })
            .collect();
        return Some(Tabs {
            index,
            whole: line.ends_with('→'),
            tabs,
        });
    }
    None
}

/// `claudeQuestionText`: the question over Claude's options, joined back when a narrow pane wraps
/// it over several lines; it goes up to the bar of tabs, a header chip or the panel's top rule.
fn question_text<T: AsRef<str>>(
    lines: &[T],
    tabs_index: Option<usize>,
    first_row: usize,
) -> Option<String> {
    // the lines above `first_row` and below both the bar and the 30th line up
    let lowest = first_row
        .saturating_sub(29)
        .max(tabs_index.map_or(0, |at| at + 1));
    let mut text: Vec<String> = Vec::new();
    for index in (lowest..first_row).rev() {
        let line = clean_line(lines[index].as_ref());
        if line.is_empty() {
            if !text.is_empty() {
                break;
            }
            continue;
        }
        if CHIP_START.is_match(&line) || is_divider(&line) || TABS.is_match(&line) {
            break;
        }
        text.insert(0, line);
    }
    (!text.is_empty()).then(|| normalize_text(&text.join(" ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<String> {
        text.split('\n').map(str::to_owned).collect()
    }

    /// server/prompt.ts:535-546, worked out by hand: ✔ is the Submit step, not a question; a bar cut
    /// off at its right edge is not whole.
    #[test]
    fn reads_the_bar_of_tabs() {
        let read = tabs(&lines("←  ☒ Route  ☐ Author name  ✔ Submit  →\nWhich?"), 1);
        assert_eq!(
            read,
            Some(Tabs {
                index: 0,
                whole: true,
                tabs: vec![
                    Tab {
                        label: "Route".into(),
                        answered: true
                    },
                    Tab {
                        label: "Author name".into(),
                        answered: false
                    },
                ],
            })
        );
        let cut = tabs(&lines("←  ☑ Route  ☐ Au\nWhich?"), 1).unwrap();
        assert!(!cut.whole);
        assert_eq!(cut.current(), Some(1));
        // a solid rule above the question ends the panel before any bar
        assert_eq!(tabs(&lines("← ☐ A\n────────\nWhich?"), 2), None);
    }

    /// server/prompt.ts:549-559: the question lines up to the bar, joined with single spaces.
    #[test]
    fn joins_a_wrapped_question_up_to_the_bar() {
        let lines = lines("← ☐ A  →\nWhich  of\n  these?\n❯ 1. One");
        assert_eq!(
            question_text(&lines, Some(0), 3).as_deref(),
            Some("Which of these?")
        );
        // the 29 lines above the row at most
        let mut tall: Vec<String> = vec!["far".into()];
        tall.extend((0..29).map(|_| "near".to_owned()));
        tall.push("❯ 1. One".into());
        let read = question_text(&tall, None, 30).unwrap();
        assert_eq!(read.split(' ').count(), 29);
    }
}
