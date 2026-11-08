//! Claude Code's approvals of a tool call, and the plan it asks to execute (`parseClaudeApproval`,
//! server/prompt.ts:632-712).

use std::sync::LazyLock;

use protocol::{PromptKind, js};
use regex::Regex;

use super::{Responder, SOLID_RULE, text_lines};
use crate::ParsedPrompt;
use crate::answer::{Answering, Key, OptionKeys, Typed};
use crate::card::{self, CardFields, option};
use crate::text::{
    NumberedRow, clean_line, find_last_index, is_divider, js_regex, nearest_question,
    normalize_text, parse_numbered_rows, screen_lines, sequential_rows, strip_ansi, wrapped,
};

static PLAN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)Claude has written up a plan and is ready to execute\. Would you like to proceed\?",
    )
    .unwrap()
});
static TELL_CLAUDE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i)^Tell Claude what to change$").unwrap());
static READY_TO_CODE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)Ready to code\?").unwrap());
static REQUIRED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i)This command requires approval").unwrap());
static DANGEROUS_RM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^Dangerous rm operation(?-u:\b)").unwrap());
/// "Do you want to proceed?", "Do you want to create hello.txt?", "Do you want to make this edit to
/// a.ts?"
static DO_YOU_WANT: LazyLock<Regex> = LazyLock::new(|| js_regex(r"(?i)^Do you want to {.}+\?$"));
static ESC_TO_CANCEL: LazyLock<Regex> = LazyLock::new(|| Regex::new("(?i)esc to cancel").unwrap());
static OWN_HINT: LazyLock<Regex> = LazyLock::new(|| js_regex("(?i)esc to{s}+cancel"));
static HINT_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^esc to cancel(?-u:\b)").unwrap());
/// A tool call (`● Write(a.ts)`, an MCP call `● server - tool (MCP)(…)`); Claude's own text opens
/// with ● too, without the name and the parenthesis.
static CALL: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"^●{s}+[0-9A-Za-z_.:-]+(?:{s}[0-9A-Za-z_.:-]+)*(?:{s}\(MCP\))?\("));
static DASHED_RULE: LazyLock<Regex> = LazyLock::new(|| Regex::new("^╌{8,}$").unwrap());
static COMMAND_BLOCK: LazyLock<Regex> = LazyLock::new(|| js_regex("^│{s}"));
static OWN_TEXT: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[●⏺❯>›]").unwrap());
static TIP: LazyLock<Regex> = LazyLock::new(|| Regex::new("(?i)^Tip:").unwrap());

/// How far above the question a panel's rule may be.
const PANEL_MAX: usize = 60;

pub(super) fn parse(screen: &str) -> Option<ParsedPrompt> {
    let lines = screen_lines(screen);
    match find_last_index(&lines, |_, index| PLAN.is_match(&wrapped(&lines, index, 3))) {
        Some(plan_index) => plan(&lines, plan_index),
        None => approval(&lines),
    }
}

/// The rows' cursor, when they count up from 1, are at least `min` and one of them has it.
fn cursor(rows: &[NumberedRow], min: usize) -> Option<usize> {
    let selected: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter(|(_, row)| row.row.selected)
        .map(|(index, _)| index)
        .collect();
    match selected[..] {
        [at] if sequential_rows(rows) && rows.len() >= min => Some(at),
        _ => None,
    }
}

/// The plan Claude asks to execute, from its heading "Ready to code?" down.
fn plan(lines: &[String], plan_index: usize) -> Option<ParsedPrompt> {
    let rows = parse_numbered_rows(lines, plan_index + 1, lines.len());
    let selected = cursor(&rows, 3)?;
    let custom_index = rows
        .iter()
        .position(|row| TELL_CLAUDE.is_match(&row.row.label));
    let body_start = find_last_index(&lines[..plan_index], |line, _| {
        READY_TO_CODE.is_match(&clean_line(line))
    })
    .unwrap_or(0);
    // blank lines stay: the plan's paragraphs
    let body = lines[body_start..plan_index]
        .iter()
        .map(|line| clean_line(line))
        .filter(|line| !is_divider(line))
        .collect::<Vec<_>>()
        .join("\n");
    Some(card::finish(
        "claude",
        CardFields {
            kind: PromptKind::Plan,
            title: "Ready to code?".into(),
            question: clean_line(&lines[plan_index]),
            body: (!body.is_empty()).then_some(body),
            options: rows
                .iter()
                .map(|row| option(row.row.label.clone()))
                .collect(),
            custom_option_index: custom_index,
            queued: None,
            fallback: false,
        },
        None,
        Responder::Plan,
        Answering {
            selected,
            options: OptionKeys::Menu { escape: None },
            // the feedback is typed into the row and sent with shift+tab
            typed: custom_index.map(|row| Typed {
                row,
                before: Vec::new(),
                after: vec![Key::BackTab],
            }),
            multiple: None,
        },
    ))
}

/// The approval of a tool call: "Do you want to …?" over its numbered rows.
fn approval(lines: &[String]) -> Option<ParsedPrompt> {
    let clean_matches =
        |pattern: &Regex| find_last_index(lines, |line, _| pattern.is_match(&clean_line(line)));
    let required_index = clean_matches(&REQUIRED);
    let dangerous_rm_index = clean_matches(&DANGEROUS_RM);
    let approval_index = required_index.max(dangerous_rm_index);
    let question_index = clean_matches(&DO_YOU_WANT)?;
    // options end at the key hint: a line under the last one is then only its wrapped label
    let hint_index = find_last_index(lines, |_, index| {
        ESC_TO_CANCEL.is_match(&wrapped(lines, index, 3))
    });
    let hint_below = hint_index.filter(|hint| *hint > question_index);
    let rows_end = hint_below.unwrap_or(lines.len());
    let rows = parse_numbered_rows(lines, question_index + 1, rows_end);
    let selected = cursor(&rows, 2)?;
    // a hint of its own under the last row and over the last hint, whole or wrapped by a narrow
    // pane: the panel was answered, and what ends the screen now is another prompt ("Password:"
    // over a bare "Esc to cancel"); an option's own words may name the keys
    let after_rows = rows.last().unwrap().row.line_index + 1;
    // `lines.slice(after, hintIndex)`: without a hint (-1), up to the last line but one
    let before_hint = hint_index.unwrap_or(lines.len().saturating_sub(1));
    let between = lines
        .get(after_rows..before_hint.max(after_rows))
        .unwrap_or_default()
        .iter()
        .map(|line| clean_line(line))
        .collect::<Vec<_>>()
        .join(" ");
    if OWN_HINT.is_match(&between) {
        return None;
    }
    let (title, body) = match approval_index.filter(|at| *at < question_index) {
        Some(approval_index) => {
            let title = nearest_question(lines, approval_index)
                .unwrap_or_else(|| "Command approval".into());
            let body_end = if dangerous_rm_index > required_index {
                question_index
            } else {
                approval_index
            };
            let body = text_lines(lines, approval_index.saturating_sub(8), body_end).join("\n");
            (title, body)
        }
        None => panel(lines, question_index, hint_below)?,
    };
    // an approval's options have no descriptions: lines under one are its label wrapped by a narrow
    // pane
    let options = rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let next = rows
                .get(index + 1)
                .map_or(rows_end, |next| next.row.line_index);
            let words = std::iter::once(row.row.label.clone())
                .chain(text_lines(lines, row.row.line_index + 1, next))
                .collect::<Vec<_>>()
                .join(" ");
            option(normalize_text(&words))
        })
        .collect();
    Some(card::finish(
        "claude",
        CardFields {
            kind: PromptKind::Approval,
            title,
            question: clean_line(&lines[question_index]),
            body: (!body.is_empty()).then_some(body),
            options,
            custom_option_index: None,
            queued: None,
            fallback: false,
        },
        None,
        Responder::Approval,
        Answering::menu(selected),
    ))
}

/// Claude Code 2.1's approval, with neither marker: the panel under a solid rule opens with the tool
/// ("Bash command", "Create file"), then the command or file and its description. Its title and
/// body, or `None` when no panel is found.
fn panel(
    lines: &[String],
    question_index: usize,
    hint_below: Option<usize>,
) -> Option<(String, String)> {
    let above_question = &lines[..question_index];
    // the panel's rule is the first one under the tool call (`● Write(a.ts)`): rules further down
    // belong to a file preview; with the call scrolled away, the nearest rule
    let call_index = find_last_index(above_question, |line, _| CALL.is_match(&clean_line(line)));
    let rules: Vec<usize> = above_question
        .iter()
        .enumerate()
        .filter(|(index, line)| {
            call_index.is_none_or(|call| *index > call) && SOLID_RULE.is_match(&clean_line(line))
        })
        .map(|(index, _)| index)
        .collect();
    let rule_index = match call_index {
        Some(_) => rules.first().copied(),
        None => rules.last().copied(),
    };
    // a long command pushes the panel's rule and tool name off the top of the screen: the numbered
    // rows and Claude's own key hint under them, with what is left of the panel above them (its `│`
    // command block and the dashed rule under that), still say it is an approval. The dashed rule is
    // the last divider over the question, the block right above it, and only the panel's own few
    // lines (never Claude's or the user's text) between it and the question
    let scrolled = rule_index.is_none()
        && call_index.is_none()
        && hint_below.is_some_and(|hint| HINT_LINE.is_match(&clean_line(&lines[hint])))
        && {
            // read only when neither the rule nor the call is found
            let above: Vec<String> = above_question
                .iter()
                .map(|line| js::trim(&strip_ansi(line)).to_owned())
                .collect();
            find_last_index(&above, |line, _| is_divider(line)).is_some_and(|dash| {
                dash >= 1
                    && question_index - dash <= 8
                    && DASHED_RULE.is_match(&above[dash])
                    && COMMAND_BLOCK.is_match(&above[dash - 1])
                    && above[dash + 1..]
                        .iter()
                        .all(|line| !OWN_TEXT.is_match(line))
            })
        };
    let from = match rule_index {
        _ if scrolled => 0,
        Some(rule) if question_index - rule <= PANEL_MAX => rule + 1,
        _ => return None,
    };
    // all of a scrolled panel is the body: a command line changed far above the question is another
    // asking. Claude's own tip is a line of the panel; a `│ Tip:` line is the command's
    let panel: Vec<String> = lines[from..question_index]
        .iter()
        .filter(|line| !TIP.is_match(js::trim(&strip_ansi(line))))
        .map(|line| clean_line(line))
        .filter(|line| !line.is_empty() && !is_divider(line))
        .collect();
    let (first, rest) = panel.split_first()?;
    Some(if scrolled {
        ("Command approval".into(), panel.join("\n"))
    } else {
        (first.clone(), rest.join("\n"))
    })
}
