//! pi's cards: the dialogs its menu widget draws (an extension's select, confirm and input, and the
//! selectors `/login` and `/scoped-models` open) and the `/model` catalogue (server/prompt.ts:
//! 852-1113). pi stays idle while a dialog waits, so the card can only come from the screen.

use std::sync::LazyLock;

use protocol::{InteractivePromptOption, PromptKind, js};
use regex::Regex;

use crate::ParsedPrompt;
use crate::answer::{Answering, Key, OptionKeys, Typed};
use crate::card::{self, CardFields};
use crate::text::{
    clean_line, find_last_index, is_divider, js_regex, screen_lines, strip_ansi, visible_lines,
    wrapped,
};

/// Which of pi's readers read a card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Responder {
    Question,
    Confirm,
    Input,
    Model,
}

pub(crate) const PARSERS: &[fn(&str) -> Option<ParsedPrompt>] = &[parse_model, parse_dialog];

/// The hint at a dialog's end while it offers rows.
const MENU_HINT: &str = r"(?i)↑↓ navigate{s}+enter select{s}+escape/ctrl\+c cancel";
/// The hint at a dialog's end while it wants text.
const INPUT_HINT: &str = r"(?i)enter submit{s}+escape/ctrl\+c cancel";
/// The hint of `/model`'s own widget, which carries no `↑↓ navigate`.
const MODEL_HINT: &str =
    r"(?i)enter to select{s}*·{s}*ctrl\+s to set as default{s}*·{s}*escape/ctrl\+c to cancel";

static MENU_HINT_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(MENU_HINT));
static INPUT_HINT_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(INPUT_HINT));
static MODEL_HINT_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(MODEL_HINT));
/// The same hints told from the end of a joined window, so lines that follow a hint cannot complete
/// a match of their own: the footer's lines would keep an answered dialog offering keys.
static MENU_HINT_AT_END: LazyLock<Regex> = LazyLock::new(|| js_regex(&format!("{MENU_HINT}$")));
static INPUT_HINT_AT_END: LazyLock<Regex> = LazyLock::new(|| js_regex(&format!("{INPUT_HINT}$")));
static MODEL_HINT_AT_END: LazyLock<Regex> = LazyLock::new(|| js_regex(&format!("{MODEL_HINT}$")));
/// The line pi types an answer into.
static INPUT_LINE: LazyLock<Regex> = LazyLock::new(|| js_regex("^[›>❯]+{s}*({.}*)$"));
/// A menu row: pi's cursor, an optional tick marking the current choice, then the label.
static ROW: LazyLock<Regex> = LazyLock::new(|| js_regex("^([→❯➜])?{s}*(?:[✓✔]{s}+)?({S}{.}*)$"));
/// A row with pi's cursor on it.
static CURSOR: LazyLock<Regex> = LazyLock::new(|| js_regex("^[→❯➜]{s}*{S}"));
/// The rest of a row a narrow pane wrapped, one column in (`PI_WRAPPED_REST_RE`, a negative
/// lookahead written as one class: ADR 0193-phase-2-dependencies).
static WRAPPED_REST: LazyLock<Regex> = LazyLock::new(|| js_regex("^ [^{ws}→❯➜]"));
static YES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^yes(?-u:\b)").unwrap());
static NO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^no(?-u:\b)").unwrap());
static TWO_SPACES: LazyLock<Regex> = LazyLock::new(|| js_regex("{s}{2,}"));
/// `/model` types a filter into this line, then lists what is left under it.
static MODEL_FILTER: LazyLock<Regex> = LazyLock::new(|| js_regex("^[›>❯]{s}*$"));
/// pi marks the model it starts on with `· default`.
static MODEL_DEFAULT: LazyLock<Regex> = LazyLock::new(|| js_regex("{s}*·{s}*default$"));
/// A catalogue row names the provider serving the model, in brackets.
static MODEL_PROVIDER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[[^\]]+\]").unwrap());
/// The tail of a model's name a narrow pane wrapped onto its own line: only the provider's bracket.
static MODEL_TAIL: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^\[[^\]]+\]({s}*·{s}*default)?$"));
static AT_MOST_ONE_SPACE_IN: LazyLock<Regex> = LazyLock::new(|| js_regex("^ {0,1}{S}"));
static INDENTED: LazyLock<Regex> = LazyLock::new(|| Regex::new("^ {2,}").unwrap());

/// pi's own footer under `/model` and every dialog: the pane's folder, then its context meter. A
/// hint may have this many of its lines under it.
const FOOTER_LINES: usize = 2;

fn option(label: String) -> InteractivePromptOption {
    InteractivePromptOption {
        label,
        description: None,
    }
}

fn menu(selected: usize) -> Answering {
    Answering {
        selected,
        options: OptionKeys::Menu { escape: None },
        typed: None,
        multiple: None,
    }
}

/// `hintAtEnd`: whether a hint is the last thing before the footer, allowing for a phone's pane
/// wrapping it over up to `span` lines.
fn hint_at_end(shown: &[String], at_end: &Regex, footer_lines: usize, span: usize) -> bool {
    let Some(last) = shown.len().checked_sub(1) else {
        return false;
    };
    (last.saturating_sub(footer_lines)..=last).rev().any(|end| {
        (1..=span)
            .take_while(|size| *size <= end + 1)
            .any(|size| at_end.is_match(&shown[end + 1 - size..=end].join(" ")))
    })
}

struct DialogRow {
    line: String,
    cursor: bool,
}

/// `piDialogRows`: the run of rows right over the hint, each with the rest a narrow pane wrapped
/// under it, and the run of lines over the blank above them, which is what the dialog asks.
fn dialog_rows(lines: &[String], hint_index: usize) -> (Vec<DialogRow>, Vec<String>) {
    let mut index = hint_index as isize - 1;
    while index >= 0 && clean_line(&lines[index as usize]).is_empty() {
        index -= 1;
    }
    // read upwards, so the wrapped rest of a row is met before the row it belongs to
    let mut rows = Vec::new();
    let mut rest: Vec<String> = Vec::new();
    while index >= 0 {
        let raw = strip_ansi(&lines[index as usize]);
        let line = clean_line(&raw);
        if line.is_empty() || is_divider(&line) {
            break;
        }
        if WRAPPED_REST.is_match(&raw) {
            rest.insert(0, line);
        } else {
            let cursor = CURSOR.is_match(&line);
            let joined = std::iter::once(line)
                .chain(rest.drain(..))
                .collect::<Vec<_>>()
                .join(" ");
            rows.insert(
                0,
                DialogRow {
                    line: joined,
                    cursor,
                },
            );
        }
        index -= 1;
    }
    // lines one column in with no row over them stand as they are, for the caller to refuse
    for line in rest.into_iter().rev() {
        rows.insert(
            0,
            DialogRow {
                line,
                cursor: false,
            },
        );
    }
    // the run of lines right over the rows' blank: past the next blank is what the pane showed before
    let mut title = Vec::new();
    while index >= 0 && title.len() < 8 {
        let raw = &lines[index as usize];
        if is_divider(raw) {
            break;
        }
        let line = clean_line(raw);
        if line.is_empty() {
            if !title.is_empty() {
                break;
            }
        } else {
            title.insert(0, line);
        }
        index -= 1;
    }
    (rows, title)
}

struct ModelRow {
    label: String,
    cursor: bool,
    current: bool,
}

/// `piModelRows`: the catalogue under `/model`'s filter line. A row a narrow pane wrapped is joined
/// back first, and a row still without its provider voids the reading: half a name would switch pi
/// to a model that does not exist.
fn model_rows(lines: &[String], start_index: usize) -> Option<Vec<ModelRow>> {
    let mut start = start_index;
    while start < lines.len() && clean_line(&lines[start]).is_empty() {
        start += 1;
    }
    let mut block: Vec<String> = Vec::new();
    for line in lines.iter().skip(start) {
        let raw = strip_ansi(line);
        let cleaned = clean_line(&raw);
        if let Some(previous) = block.last_mut() {
            let before = clean_line(previous);
            if !before.is_empty()
                && !MODEL_PROVIDER.is_match(&before)
                && AT_MOST_ONE_SPACE_IN.is_match(&raw)
                && MODEL_TAIL.is_match(&cleaned)
            {
                *previous = format!("{previous} {cleaned}");
                continue;
            }
        }
        block.push(raw);
    }
    // a row cut before its provider bracket closes is a catalogue still being drawn
    let cut_mid_bracket = |line: &str| line.contains('[') && !MODEL_PROVIDER.is_match(line);
    let mut rows = Vec::new();
    for raw in &block {
        let line = clean_line(raw);
        if line.is_empty() || is_divider(&line) || MODEL_HINT_RE.is_match(&line) {
            break;
        }
        let cursor = CURSOR.is_match(&line);
        if !cursor && !INDENTED.is_match(raw) {
            break;
        }
        let label = ROW
            .captures(&line)
            .map(|found| js::trim(&found[2]).to_owned());
        let Some(label) = label.filter(|label| {
            !label.is_empty() && MODEL_PROVIDER.is_match(label) && !TWO_SPACES.is_match(label)
        }) else {
            if cut_mid_bracket(&line) {
                return None;
            }
            break;
        };
        rows.push(ModelRow {
            label,
            cursor,
            current: raw.contains(['✓', '✔']),
        });
    }
    if !rows.iter().all(|row| MODEL_PROVIDER.is_match(&row.label)) {
        return None;
    }
    (rows.len() >= 2 && rows.iter().any(|row| row.cursor)).then_some(rows)
}

/// `parsePiModel`: `/model`'s catalogue, the cursor where pi drew it.
fn parse_model(screen: &str) -> Option<ParsedPrompt> {
    let lines = screen_lines(screen);
    let hint_index = find_last_index(&lines, |_, index| {
        MODEL_HINT_RE.is_match(&wrapped(&lines, index, 3))
    })?;
    // the filter line is the anchor: anything above it is what the pane showed before `/model`
    let filter_index = find_last_index(&lines[..hint_index], |line, _| {
        MODEL_FILTER.is_match(&clean_line(line))
    })?;
    let rows = model_rows(&lines, filter_index + 1)?;
    let selected = rows.iter().position(|row| row.cursor)?;
    // the card names the model answering now: the answer switches it
    let question = match rows.iter().find(|row| row.current) {
        Some(current) => format!(
            "Select model (currently {})",
            MODEL_DEFAULT.replace(&current.label, "")
        ),
        None => "Select model".to_owned(),
    };
    let fields = CardFields {
        kind: PromptKind::Question,
        title: String::new(),
        question,
        body: None,
        options: rows.into_iter().map(|row| option(row.label)).collect(),
        custom_option_index: None,
        queued: None,
        fallback: false,
    };
    Some(card::finish(
        "pi",
        fields,
        None,
        Responder::Model,
        menu(selected),
    ))
}

fn parse_dialog(screen: &str) -> Option<ParsedPrompt> {
    parse_pi_dialog(screen, false)
}

/// `parsePiDialog`: a dialog of pi's menu widget. `moved`: an answer's own keys moved the cursor,
/// and the read before its Enter looks where it stands; otherwise the cursor must be on the first
/// row, since the chat cannot see where a hand left it.
pub(crate) fn parse_pi_dialog(screen: &str, moved: bool) -> Option<ParsedPrompt> {
    let lines = screen_lines(screen);
    let hint_index = find_last_index(&lines, |_, index| {
        let joined = wrapped(&lines, index, 3);
        MENU_HINT_RE.is_match(&joined) || INPUT_HINT_RE.is_match(&joined)
    })?;
    let (rows, title_lines) = dialog_rows(&lines, hint_index);
    if rows.is_empty() {
        return None;
    }
    // the first line is the dialog's own; what follows is a confirm's message, or more of a wrapped line
    let title = title_lines.first().cloned();
    let body = (title_lines.len() > 1).then(|| title_lines[1..].join(" "));
    // pi wants text on a `>` line: there is nothing to pick, and the answer is typed into it
    if INPUT_HINT_RE.is_match(&wrapped(&lines, hint_index, 3)) {
        if !rows.iter().all(|row| INPUT_LINE.is_match(&row.line)) {
            return None;
        }
        let fields = CardFields {
            kind: PromptKind::Question,
            title: body.unwrap_or_default(),
            question: title.unwrap_or_default(),
            body: None,
            options: vec![option("Type your answer".into())],
            custom_option_index: Some(0),
            queued: None,
            fallback: false,
        };
        let answering = Answering {
            // the `>` line already owns the input: an Enter before the answer would submit the
            // dialog empty, and what was typed there in the terminal is emptied first, after the
            // cursor and before it (pi's editor keys, measured on 0.87.1)
            typed: Some(Typed {
                row: 0,
                before: vec![Key::CtrlK, Key::CtrlU],
                after: vec![Key::Enter],
            }),
            ..menu(0)
        };
        return Some(card::finish(
            "pi",
            fields,
            None,
            Responder::Input,
            answering,
        ));
    }
    // every line of the block must be a row of a single label: pi's command palette sets its rows
    // out in two columns, and offering those would run a slash command on a click
    let labels: Vec<String> = rows
        .iter()
        .filter_map(|row| ROW.captures(&row.line).map(|found| found[2].to_owned()))
        .collect();
    if labels.len() != rows.len() || labels.len() < 2 {
        return None;
    }
    if labels.iter().any(|label| TWO_SPACES.is_match(label)) {
        return None;
    }
    let cursor = rows.iter().position(|row| row.cursor);
    let cursor = match (moved, cursor) {
        (true, Some(cursor)) | (false, Some(cursor @ 0)) => cursor,
        _ => return None,
    };
    let labels: Vec<String> = labels
        .iter()
        .map(|label| js::trim(label).to_owned())
        .collect();
    // Yes/No reads as a confirmation; anything else is a question asked among its options
    let confirming = labels.len() == 2 && YES.is_match(&labels[0]) && NO.is_match(&labels[1]);
    let fields = CardFields {
        kind: if confirming {
            PromptKind::Approval
        } else {
            PromptKind::Question
        },
        title: if confirming {
            title.clone().unwrap_or_default()
        } else {
            String::new()
        },
        // a select has a title alone: a second line is the rest of it, wrapped
        question: if confirming {
            body.or(title).unwrap_or_default()
        } else {
            title_lines.join(" ")
        },
        body: None,
        options: labels.into_iter().map(option).collect(),
        custom_option_index: None,
        queued: None,
        fallback: false,
    };
    // "No" is pressed, not cancelled: pi's own No answers the question false, where Escape would
    // leave it unanswered
    let responder = if confirming {
        Responder::Confirm
    } else {
        Responder::Question
    };
    Some(card::finish("pi", fields, None, responder, menu(cursor)))
}

/// `promptTailIsActive` for pi's cards: the hint is the last thing before pi's footer. A dialog
/// already answered leaves its hint far above whatever came after.
pub(crate) fn tail_is_active(responder: Responder, screen: &str) -> bool {
    let shown = visible_lines(screen);
    match responder {
        Responder::Model => hint_at_end(&shown, &MODEL_HINT_AT_END, FOOTER_LINES, 3),
        Responder::Question | Responder::Confirm | Responder::Input => {
            hint_at_end(&shown, &MENU_HINT_AT_END, FOOTER_LINES, 4)
                || hint_at_end(&shown, &INPUT_HINT_AT_END, FOOTER_LINES, 4)
        }
    }
}
