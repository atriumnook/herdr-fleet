//! Codex's cards: its continue menu, its questions, a question of the queue it asks while it works,
//! open, and its approvals (server/prompt.ts:257-358, 590-608), and when each one's menu still ends
//! the screen (`promptTailIsActive`, 835-843). The collapsed queue is read in `queue`.

mod queue;

use std::sync::LazyLock;

use protocol::{PromptKind, QueuedState};
use regex::Regex;

use crate::ParsedPrompt;
use crate::answer::{Answering, Key, Typed};
use crate::card::{self, CardFields, option};
use crate::text::{
    NUMBERED_OPTION, NumberedRow, clean_line, clean_lines, ends, find_last_index, is_divider,
    js_regex, menu_rows, nearest_question, normalize_text, parse_numbered_rows, screen_lines,
    sequential_rows, visible_lines, wrapped,
};

pub(crate) use queue::{queued_prompt, queued_question_count};

/// Which of Codex's readers read a card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Responder {
    /// `codex-menu`: the menu after an interrupted turn
    Menu,
    /// `codex-question`: a question of `request_user_input`, ending in "None of the above"
    Question,
    /// `codex-async-question`: a question of the queue (`request_user_input_async`), open
    AsyncQuestion,
    /// `codex-queued-question`: the first question of the collapsed queue, from the rollout
    QueuedQuestion,
    /// `codex-approval`: an approval, the folder trust check among them
    Approval,
}

/// Codex's parsers, in the order `parsePrompt` tries them (server/prompt.ts:1117).
pub(crate) const PARSERS: &[fn(&str) -> Option<ParsedPrompt>] = &[
    parse_continue_menu,
    parse_question,
    parse_async_question,
    parse_approval,
];

/// `CODEX_ASK_HINT_RE`: the last of several questions submits them all.
static ASK_HINT: LazyLock<Regex> = LazyLock::new(|| {
    js_regex("(?i)tab to add notes{.}*enter to submit (?:answer|all){.}*esc to interrupt")
});
/// `CODEX_ASYNC_ASK_HINT_RE`: the hint under an open question of the queue.
pub(crate) static ASYNC_ASK_HINT: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"(?i)(?:enter|return){.}*submit{.}*(?:ctrl{s}*\+{s}*\]|skip)"));
/// `CODEX_CONTINUE_HINT_RE`.
static CONTINUE_HINT: LazyLock<Regex> =
    LazyLock::new(|| js_regex("(?i)press{s}+enter{s}+to{s}+continue"));
/// `CODEX_QUEUE_HEADER_RE`: the header of Codex 0.156's queue of questions, above the main prompt.
pub(crate) static QUEUE_HEADER: LazyLock<Regex> =
    LazyLock::new(|| js_regex("^(?:•{s}*)?Queued follow-up inputs$"));
/// `CODEX_QUEUE_POSITION_RE`: "1 of 2" over an open question of the queue.
static QUEUE_POSITION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^([0-9]+) of ([0-9]+)$").unwrap());
/// `CODEX_APPROVAL_HEADER_RE`.
static APPROVAL_HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:Would you like to (?:run|make|apply|continue|grant)|Allow Codex to|Approve (?:this )?(?:app )?tool call|Do you trust the contents|Trust this folder\?|Enable full access)",
    )
    .unwrap()
});
/// The row that takes a typed answer, last under a question.
static NONE_OF_THE_ABOVE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^None of the above(?-u:\b)").unwrap());
/// The last row of an open question of the queue in a layout without its header.
static OTHER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^Other(?-u:\b)").unwrap());
/// A question's label and its description, two spaces or more apart.
static TWO_SPACES: LazyLock<Regex> = LazyLock::new(|| js_regex("{s}{2,}"));
/// "Question 2/3" over one of several questions.
static PROGRESS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^Question ([0-9]+)/([0-9]+)").unwrap());
/// "Trust this folder? Codex can read, …": the question, then what it explains.
static QUESTION_AND_MORE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^({.}*?\?){s}+({.}+)$"));
/// An approval's row that is the same as backing out with Escape.
static REJECT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:No|Reject|Cancel|Deny)(?-u:\b)").unwrap());
/// What ends an approval: its hint, or its last row once a move has put the cursor there. The
/// folder trust check ends "enter continue · esc back" or, from 0.163, "· esc quit"; only those
/// two, as the update prompt ends "· esc skip" and must not read as an approval.
static APPROVAL_TAIL: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"(?i)press enter to confirm|esc to cancel|enter continue{s}*·{s}*esc (?:back|quit)$|^(?:[›>❯]{s}*)?[0-9]+\.{s}+(?:No|Reject|Cancel|Deny)(?-u:\b)",
    )
});
/// What `promptTailIsActive` looks for at the end of a card no branch of its own reads
/// (server/prompt.ts:869): Codex's collapsed queue is one.
static OTHER_TAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)ctrl\+g to edit|shift\+tab to approve with this feedback").unwrap()
});

/// The index of the one row the cursor is on, if exactly one has it.
fn the_selected(rows: &[NumberedRow]) -> Option<usize> {
    let mut selected = rows.iter().enumerate().filter(|(_, row)| row.row.selected);
    match (selected.next(), selected.next()) {
        (Some((index, _)), None) => Some(index),
        _ => None,
    }
}

/// The cleaned lines `from..to` without blank lines and rules.
fn text_lines(lines: &[String], from: usize, to: usize) -> Vec<String> {
    lines[from..to]
        .iter()
        .map(|line| clean_line(line))
        .filter(|line| !line.is_empty() && !is_divider(line))
        .collect()
}

/// `parseCodexContinueMenu`: the numbered menu over "press enter to continue", with up to 16 lines
/// of what came before it as the body.
fn parse_continue_menu(screen: &str) -> Option<ParsedPrompt> {
    let lines = screen_lines(screen);
    let hint_index = find_last_index(&lines, |_, index| {
        CONTINUE_HINT.is_match(&wrapped(&lines, index, 3))
    })?;
    let rows = menu_rows(&lines, hint_index.saturating_sub(64), hint_index);
    let selected = the_selected(&rows)?;
    if !sequential_rows(&rows) || rows.len() < 2 {
        return None;
    }
    let first = rows[0].row.line_index;
    let body = text_lines(&lines, first.saturating_sub(16), first).join("\n");
    let fields = CardFields {
        kind: PromptKind::Menu,
        title: "Codex".into(),
        question: "Choose how to continue".into(),
        body: (!body.is_empty()).then_some(body),
        options: rows
            .into_iter()
            .map(|row| protocol::InteractivePromptOption {
                label: row.row.label,
                description: row.row.description,
            })
            .collect(),
        custom_option_index: None,
        queued: None,
        fallback: false,
    };
    Some(card::finish(
        "codex",
        fields,
        None,
        Responder::Menu,
        Answering::menu(selected),
    ))
}

/// `parseCodexQuestion`: a question of `request_user_input`, its options numbered over the hint and
/// "None of the above" last, which takes a typed answer as a note (Tab) to it.
fn parse_question(screen: &str) -> Option<ParsedPrompt> {
    let lines = screen_lines(screen);
    let hint_index = find_last_index(&lines, |_, index| {
        ASK_HINT.is_match(&wrapped(&lines, index, 3))
    })?;
    let rows = menu_rows(&lines, hint_index.saturating_sub(48), hint_index);
    if !sequential_rows(&rows) {
        return None;
    }
    let selected = the_selected(&rows)?;
    let custom_index = rows
        .iter()
        .position(|row| NONE_OF_THE_ABOVE.is_match(&row.row.label))?;
    if custom_index != rows.len() - 1 || custom_index < 1 {
        return None;
    }
    let first = rows[0].row.line_index;
    let question = nearest_question(&lines, first).filter(|question| !question.is_empty())?;
    let options = rows[..custom_index]
        .iter()
        .map(|row| {
            let mut parts = TWO_SPACES.split(&row.row.label);
            let label = parts.next().unwrap_or_default();
            let description = parts.collect::<Vec<_>>();
            protocol::InteractivePromptOption {
                label: label.to_owned(),
                description: (!description.is_empty()).then(|| description.join(" ")),
            }
        })
        .collect::<Vec<_>>();
    let progress = lines[first.saturating_sub(6)..first]
        .iter()
        .find_map(|line| {
            PROGRESS
                .captures(&clean_line(line))
                .map(|found| (found[1].to_owned(), found[2].to_owned()))
        });
    let title = match progress {
        Some((at, of)) if of != "1" => format!("Question {at} of {of}"),
        _ => "Question".to_owned(),
    };
    let fields = CardFields {
        kind: PromptKind::Question,
        title,
        question,
        body: None,
        custom_option_index: Some(options.len()),
        options,
        queued: None,
        fallback: false,
    };
    let answering = Answering {
        typed: Some(Typed {
            row: custom_index,
            before: vec![Key::Tab],
            after: vec![Key::Enter],
        }),
        ..Answering::menu(selected)
    };
    Some(card::finish(
        "codex",
        fields,
        None,
        Responder::Question,
        answering,
    ))
}

/// `parseCodexAsyncQuestion`: a question from Codex's queue, open: under the queue header, an
/// optional "1 of 2", the question (wrapped over as many lines as the pane needs), then its options
/// and a last row that takes a typed answer ("Other", or what was typed there). A free-form question
/// has no options, only that answer line ("Type your answer").
fn parse_async_question(screen: &str) -> Option<ParsedPrompt> {
    let lines = screen_lines(screen);
    let hint_index = find_last_index(&lines, |_, index| {
        ASYNC_ASK_HINT.is_match(&wrapped(&lines, index, 3))
    })?;
    let above = hint_index.saturating_sub(48);
    let header = find_last_index(&lines[above..hint_index], |line, _| {
        QUEUE_HEADER.is_match(&clean_line(line))
    });
    let top = header.map_or(above, |header| above + header + 1);
    // without the header the rows are read from well above: a message sent before can be there too
    let rows = menu_rows(&lines, top, hint_index);
    // the lines of the question, without the "1 of 2" over it, and that position
    let question_lines = |to: usize| -> (Vec<String>, Option<(String, String)>) {
        let mut found = text_lines(&lines, top, to);
        let position = found.first().and_then(|line| {
            QUEUE_POSITION
                .captures(line)
                .map(|at| (at[1].to_owned(), at[2].to_owned()))
        });
        if position.is_some() {
            found.remove(0);
        }
        (found, position)
    };
    let question;
    let position;
    let labels: Vec<String>;
    let selected;
    if rows.is_empty() {
        // free form: the answer line sits right above the hint
        header?;
        let answer_line = find_last_index(&lines[..hint_index], |line, _| {
            !clean_line(line).is_empty() && !is_divider(line)
        })
        .filter(|line| *line >= top)?;
        let (found, at) = question_lines(answer_line);
        question = normalize_text(&found.join(" "));
        position = at;
        labels = Vec::new();
        selected = 0;
    } else {
        if !sequential_rows(&rows) || rows.len() < 2 {
            return None;
        }
        selected = the_selected(&rows)?;
        // an old layout without the header must still end in its "Other" row
        if header.is_none() && !OTHER.is_match(&rows[rows.len() - 1].row.label) {
            return None;
        }
        // a wrapped option continues on the lines under it: these rows carry no descriptions
        labels = rows
            .iter()
            .enumerate()
            .map(|(index, row)| {
                let next = rows
                    .get(index + 1)
                    .map_or(hint_index, |next| next.row.line_index);
                let mut parts = vec![row.row.label.clone()];
                parts.extend(text_lines(&lines, row.row.line_index + 1, next));
                normalize_text(&parts.join(" "))
            })
            .collect();
        let first = rows[0].row.line_index;
        (question, position) = match header {
            None => (nearest_question(&lines, first).unwrap_or_default(), None),
            Some(_) => {
                let (found, at) = question_lines(first);
                (normalize_text(&found.join(" ")), at)
            }
        };
    }
    if question.is_empty() {
        return None;
    }
    let options = labels
        .iter()
        .take(labels.len().saturating_sub(1))
        .map(option)
        .collect::<Vec<_>>();
    let fields = CardFields {
        kind: PromptKind::Question,
        title: match position {
            Some((at, of)) => format!("Question {at} of {of}"),
            None => "Question".to_owned(),
        },
        question,
        body: None,
        custom_option_index: Some(options.len()),
        options,
        // Codex keeps working while it asks: the card answers it, never a message typed in the chat
        queued: Some(QueuedState::Open),
        fallback: false,
    };
    // the queue types into its last row once it is selected: no Enter first
    let answering = Answering {
        typed: Some(Typed {
            row: labels.len().saturating_sub(1),
            before: Vec::new(),
            after: vec![Key::Enter],
        }),
        ..Answering::menu(selected)
    };
    Some(card::finish(
        "codex",
        fields,
        None,
        Responder::AsyncQuestion,
        answering,
    ))
}

/// `parseCodexApproval`: the last approval header that is not a numbered row, with the numbered
/// rows under it. A row that refuses ("No", "Reject", "Cancel", "Deny") answers with Escape.
fn parse_approval(screen: &str) -> Option<ParsedPrompt> {
    let lines = screen_lines(screen);
    let header_index = find_last_index(&lines, |line, _| {
        APPROVAL_HEADER.is_match(line) && !NUMBERED_OPTION.is_match(line)
    })?;
    let rows = parse_numbered_rows(&lines, header_index + 1, lines.len());
    if !sequential_rows(&rows) || rows.len() < 2 {
        return None;
    }
    let selected = the_selected(&rows)?;
    // "Trust this folder? Codex can read, …": the question heads the card, its explanation joins the body
    let header = clean_line(&lines[header_index]);
    let split = QUESTION_AND_MORE.captures(&header);
    let heading = split
        .as_ref()
        .map_or(header.as_str(), |split| split.get(1).unwrap().as_str())
        .to_owned();
    let explanation = split
        .as_ref()
        .map_or("", |split| split.get(2).unwrap().as_str());
    let body = std::iter::once(explanation.to_owned())
        .chain(
            lines[header_index + 1..rows[0].row.line_index]
                .iter()
                .map(|line| clean_line(line)),
        )
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let escape = rows.iter().position(|row| REJECT.is_match(&row.row.label));
    let fields = CardFields {
        kind: PromptKind::Approval,
        title: heading.clone(),
        question: heading,
        body: (!body.is_empty()).then_some(body),
        options: rows.into_iter().map(|row| option(row.row.label)).collect(),
        custom_option_index: None,
        queued: None,
        fallback: false,
    };
    let answering = Answering {
        options: crate::answer::OptionKeys::Menu { escape },
        ..Answering::menu(selected)
    };
    Some(card::finish(
        "codex",
        fields,
        None,
        Responder::Approval,
        answering,
    ))
}

/// `promptTailIsActive` for Codex's cards: the hint of the menu the card was read from still ends
/// the screen. An open question of the queue counts too while its hint is among the last 4 lines,
/// blank lines included.
pub(crate) fn tail_is_active(responder: Responder, screen: &str) -> bool {
    let cleaned = clean_lines(screen);
    let shown = visible_lines(screen);
    match responder {
        Responder::Menu => ends(&shown, &CONTINUE_HINT),
        Responder::Question => ends(&shown, &ASK_HINT),
        Responder::AsyncQuestion => {
            cleaned[cleaned.len().saturating_sub(4)..]
                .iter()
                .any(|line| ASYNC_ASK_HINT.is_match(line))
                || ends(&shown, &ASYNC_ASK_HINT)
        }
        Responder::Approval => ends(&shown, &APPROVAL_TAIL),
        Responder::QueuedQuestion => ends(&shown, &OTHER_TAIL),
    }
}
