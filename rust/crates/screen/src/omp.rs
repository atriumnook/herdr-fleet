//! omp's cards: its bordered question menu and its tool approval (server/prompt.ts:232-255,
//! 611-630, 834, 844).

use std::sync::LazyLock;

use protocol::PromptKind;
use regex::Regex;

use crate::ParsedPrompt;
use crate::answer::{Answering, Key, Multiple, Typed};
use crate::card::{self, CardFields, option};
use crate::text::{
    clean_line, ends, find_last_index, find_menu_dividers, js_regex, nearest_question,
    parse_border_menu, screen_lines, visible_lines, wrapped,
};

/// Which of omp's readers read a card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Responder {
    Question,
    Approval,
}

pub(crate) const PARSERS: &[fn(&str) -> Option<ParsedPrompt>] = &[parse_question, parse_approval];

static SINGLE_HINT: LazyLock<Regex> =
    LazyLock::new(|| js_regex("(?i)enter select{.}*↑/↓ move{.}*esc cancel"));
static MULTI_HINT: LazyLock<Regex> =
    LazyLock::new(|| js_regex("(?i)space/enter toggle{.}*↑/↓ move{.}*esc cancel"));
static CUSTOM_ROW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^Other \(type your own\)$").unwrap());
static RECOMMENDED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i) \(Recommended\)$").unwrap());
static APPROVAL_HEADER: LazyLock<Regex> =
    LazyLock::new(|| js_regex("(?i)^{s}*Allow tool:{s}*{S}+"));
static APPROVAL_ROW: LazyLock<Regex> =
    LazyLock::new(|| js_regex("(?i)^([›>❯•])?{s}*(Approve|Deny)$"));
static APPROVAL_TAIL: LazyLock<Regex> =
    LazyLock::new(|| js_regex("(?i)^(?:[›>❯•]{s}*)?(?:Approve|Deny)$|esc{.}*cancel"));

/// `parseOmpQuestion`: a bordered menu between two rules over omp's hint, ending in its
/// "Other (type your own)" row.
fn parse_question(screen: &str) -> Option<ParsedPrompt> {
    let lines = screen_lines(screen);
    let hint_index = find_last_index(&lines, |_, index| {
        let joined = wrapped(&lines, index, 3);
        SINGLE_HINT.is_match(&joined) || MULTI_HINT.is_match(&joined)
    })?;
    let (start_divider, end_divider) = find_menu_dividers(&lines, hint_index)?;
    let rows = parse_border_menu(&lines, start_divider, end_divider);
    let selected = rows.iter().position(|row| row.selected);
    let custom = rows.iter().position(|row| CUSTOM_ROW.is_match(&row.label));
    let option_rows: Vec<_> = rows
        .iter()
        .enumerate()
        .filter(|(index, _)| Some(*index) != custom)
        .map(|(_, row)| row)
        .collect();
    let multi_select = MULTI_HINT.is_match(&clean_line(&lines[hint_index]));
    let question = nearest_question(&lines, start_divider);
    let (Some(question), Some(selected), Some(custom)) = (question, selected, custom) else {
        return None;
    };
    if question.is_empty() || option_rows.is_empty() {
        return None;
    }
    let fields = CardFields {
        kind: PromptKind::Question,
        title: if multi_select {
            "Multiple choice"
        } else {
            "Question"
        }
        .into(),
        question,
        body: None,
        options: option_rows
            .iter()
            .map(|row| option(RECOMMENDED.replace(&row.label, "").into_owned()))
            .collect(),
        custom_option_index: (!multi_select).then_some(option_rows.len()),
        queued: None,
        fallback: false,
    };
    let answering = Answering {
        // a multiple choice of omp's takes no typed answer
        typed: (!multi_select).then(|| Typed {
            row: custom,
            before: vec![Key::Enter],
            after: vec![Key::Enter],
        }),
        multiple: multi_select.then(|| Multiple {
            checked: option_rows
                .iter()
                .enumerate()
                .filter(|(_, row)| row.checked)
                .map(|(index, _)| index)
                .collect(),
            toggle: Key::Space,
            finish: vec![Key::Tab, Key::Enter],
        }),
        ..Answering::menu(selected)
    };
    Some(card::finish(
        "omp",
        fields,
        None,
        Responder::Question,
        answering,
    ))
}

/// `parseOmpApproval`: `Allow tool: <name>` over its Approve and Deny rows.
fn parse_approval(screen: &str) -> Option<ParsedPrompt> {
    let lines = screen_lines(screen);
    let header_index = find_last_index(&lines, |line, _| {
        APPROVAL_HEADER.is_match(&clean_line(line))
    })?;
    let mut rows = Vec::new();
    for (index, line) in lines.iter().enumerate().skip(header_index + 1) {
        if let Some(found) = APPROVAL_ROW.captures(&clean_line(line)) {
            rows.push((found[2].to_owned(), found.get(1).is_some(), index));
        }
    }
    let selected: Vec<usize> = (0..rows.len()).filter(|index| rows[*index].1).collect();
    if rows.len() != 2 || selected.len() != 1 {
        return None;
    }
    let header = clean_line(&lines[header_index]);
    let body = lines[header_index + 1..rows[0].2]
        .iter()
        .map(|line| clean_line(line))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let fields = CardFields {
        kind: PromptKind::Approval,
        title: header.clone(),
        question: header,
        body: (!body.is_empty()).then_some(body),
        options: rows
            .into_iter()
            .map(|(label, _, _)| option(label))
            .collect(),
        custom_option_index: None,
        queued: None,
        fallback: false,
    };
    Some(card::finish(
        "omp",
        fields,
        None,
        Responder::Approval,
        Answering::menu(selected[0]),
    ))
}

/// `promptTailIsActive` for omp's cards: the hint, or the approval's last row, still ends the screen.
pub(crate) fn tail_is_active(responder: Responder, screen: &str) -> bool {
    let shown = visible_lines(screen);
    match responder {
        Responder::Question => ends(&shown, &SINGLE_HINT) || ends(&shown, &MULTI_HINT),
        Responder::Approval => ends(&shown, &APPROVAL_TAIL),
    }
}
