//! The last-resort card for a blocked pane no reader knows (`parseFallbackPrompt`,
//! server/prompt.ts:1291-1366): a numbered menu that ends the screen, or the screen's last lines
//! with the keys its hints name. Its id reads the whole visible screen, the working line of Claude
//! Code's with its ticking parts blanked.

mod menu;
mod steady;

use std::sync::LazyLock;

use protocol::PromptKind;
use regex::Regex;

use crate::ParsedPrompt;
use crate::answer::{AnswerStep, Answering, Key, OptionKeys};
use crate::card::{self, CardFields, FallbackScreen};
use crate::text::{clean_line, ends, is_divider, js_regex, screen_lines, visible_lines};
use steady::Steady;

/// Which of the last-resort readers read a card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Responder {
    /// `fallback-menu`: a numbered menu, answered by typing a row's number
    Menu,
    /// `fallback-keys`: the screen's last lines, answered by the keys its hints name
    Keys,
}

/// `NOT_PROMPT_TEXT_RE`: a line that is an input box or quoted output rather than a prompt's own
/// text.
static NOT_PROMPT_TEXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^(?:[❯›>"'“]|\$ )"#).unwrap());
/// `ASKED_RE`: a line that asks, maybe with its choices in brackets after the question mark.
static ASKED: LazyLock<Regex> = LazyLock::new(|| js_regex(r"\?{s}*(?:[(\[][^)\]]*[)\]])?{s}*$"));
/// `YES_NO_RE`: a `(y/n)` hint at the end of a line.
static YES_NO: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"(?i)[(\[]{s}*y(?:es)?{s}*/{s}*n(?:o)?{s}*[)\]]{s}*[:?]?{s}*$"));
/// `ARROWS_RE`: a hint that names the arrow keys.
static ARROWS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)[↑↓]|(?-u:\b)arrow keys(?-u:\b)").unwrap());
/// The tail `promptTailIsActive` looks for when no case of its own names the responder
/// (server/prompt.ts:857).
static DEFAULT_TAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)ctrl\+g to edit|shift\+tab to approve with this feedback").unwrap()
});

/// A choice of a last-resort card: its label and the steps that answer it.
struct Choice {
    label: String,
    steps: Vec<AnswerStep>,
}

impl Choice {
    fn text(label: impl Into<String>, text: impl Into<String>) -> Self {
        Choice {
            label: label.into(),
            steps: vec![AnswerStep::Text { text: text.into() }],
        }
    }

    fn key(label: &str, key: Key) -> Self {
        Choice {
            label: label.to_owned(),
            steps: vec![AnswerStep::Keys { keys: vec![key] }],
        }
    }
}

/// `parseFallbackPrompt`.
pub(crate) fn parse(agent: &str, screen: &str) -> ParsedPrompt {
    let lines = screen_lines(screen);
    let shown: Vec<usize> = (0..lines.len())
        .filter(|&index| !clean_line(&lines[index]).is_empty() && !is_divider(&lines[index]))
        .collect();
    let shown_lines: Vec<String> = shown
        .iter()
        .map(|&index| clean_line(&lines[index]))
        .collect();
    let steady = Steady::new(agent, &shown_lines);

    if let Some(menu) = menu::find(&lines, &shown) {
        let above: Vec<String> = shown
            .iter()
            .zip(&shown_lines)
            .filter(|(index, _)| **index < menu.start)
            .map(|(_, line)| line.clone())
            .collect();
        let question = asked(&above);
        // a row's number is typed alone, as a menu reading keys takes it; a program reading a whole
        // line ("Enter a number >") still waits for the Enter after it, and Esc backs out
        let choices: Vec<Choice> = menu
            .rows
            .into_iter()
            .map(|row| Choice::text(row.row.label, row.number.to_string()))
            .chain([
                Choice::key("Enter", Key::Enter),
                Choice::key("Esc", Key::Escape),
            ])
            .collect();
        // the body is every other line above the rows, so a changed command above a same-looking
        // menu is another card; the display cap applies after the hash
        return card_of(
            agent,
            Responder::Menu,
            "Waiting for your answer",
            question.unwrap_or("The agent is waiting for your answer."),
            without_line(&above, question),
            choices,
            &shown_lines,
            &steady,
        );
    }

    let last = &shown_lines[shown_lines.len().saturating_sub(16)..];
    // letters and arrows only for the prompt's own last lines, never while an input box ends the
    // screen (the agent's composer owns the keys then) or for a line of quoted output
    let hints: Vec<&String> = match last.last() {
        Some(line) if NOT_PROMPT_TEXT.is_match(line) => Vec::new(),
        _ => last[last.len().saturating_sub(2)..]
            .iter()
            .filter(|line| !NOT_PROMPT_TEXT.is_match(line))
            .collect(),
    };
    let question = asked(last);
    // a (y/n) letter is offered only for the prompt at the screen's end, never for a mention above
    // it; it is typed without an Enter: a program reading a whole line still waits for one, and the
    // card that follows offers it
    let mut choices = Vec::new();
    if hints.iter().any(|line| YES_NO.is_match(line)) {
        choices.extend([Choice::text("Yes (y)", "y"), Choice::text("No (n)", "n")]);
    }
    if hints.iter().any(|line| ARROWS.is_match(line)) {
        choices.extend([Choice::key("↑", Key::Up), Choice::key("↓", Key::Down)]);
    }
    choices.extend([
        Choice::key("Enter", Key::Enter),
        Choice::key("Esc", Key::Escape),
    ]);
    card_of(
        agent,
        Responder::Keys,
        "Waiting for input",
        question.unwrap_or("The agent is waiting for input."),
        without_line(last, question),
        choices,
        &shown_lines,
        &steady,
    )
}

/// The question among `lines`: the last that asks, or else the last.
fn asked(lines: &[String]) -> Option<&str> {
    lines
        .iter()
        .rev()
        .find(|line| ASKED.is_match(line))
        .or(lines.last())
        .map(String::as_str)
}

/// `withoutLine`: the lines shown under the card's question, without the last line that is the
/// question; none when nothing is left.
fn without_line(lines: &[String], question: Option<&str>) -> Option<String> {
    let at = question.and_then(|question| lines.iter().rposition(|line| line == question));
    let body = lines
        .iter()
        .enumerate()
        .filter(|(index, _)| Some(*index) != at)
        .map(|(_, line)| line.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    (!body.is_empty()).then_some(body)
}

/// The card, its id reading the whole visible screen (`screenCard`, server/prompt.ts:1353-1361): a
/// changed command, footer or wrapped label anywhere on it makes an answer to the old card stale. A
/// working line's spinner, time and token count are the one thing it leaves out.
#[allow(clippy::too_many_arguments)]
fn card_of(
    agent: &str,
    responder: Responder,
    title: &str,
    question: &str,
    body: Option<String>,
    choices: Vec<Choice>,
    shown_lines: &[String],
    steady: &Steady,
) -> ParsedPrompt {
    let screen = FallbackScreen {
        question: steady.read(question).to_owned(),
        body: body.as_deref().map(|body| steady.read_lines(body)),
        screen: shown_lines
            .iter()
            .map(|line| steady.read(line))
            .collect::<Vec<_>>()
            .join("\n"),
        working: steady.working,
    };
    let (options, steps) = choices
        .into_iter()
        .map(|choice| (card::option(choice.label), choice.steps))
        .unzip();
    let fields = CardFields {
        kind: PromptKind::Menu,
        title: title.to_owned(),
        question: question.to_owned(),
        body,
        options,
        custom_option_index: None,
        queued: None,
        fallback: true,
    };
    let answering = Answering {
        options: OptionKeys::Steps(steps),
        ..Answering::menu(0)
    };
    card::finish(agent, fields, Some(screen), responder, answering)
}

/// Whether the screen a last-resort card was read from still ends as it did. TypeScript's
/// `promptTailIsActive` names no last-resort responder, so they take its last case.
pub(crate) fn tail_is_active(responder: Responder, screen: &str) -> bool {
    match responder {
        Responder::Menu | Responder::Keys => ends(&visible_lines(screen), &DEFAULT_TAIL),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(agent: &str, screen: &str) -> String {
        parse(agent, screen).card().id.clone()
    }

    #[test]
    fn only_claudes_working_line_ticking_keeps_the_id() {
        let screen = |working: &str, question: &str| {
            format!("Some output\n{working}\n{question}\nPress enter to continue")
        };
        let first = screen("✢ Tempering… (1m 55s · ↓ 10.0k tokens)", "Run it?");
        let ticked = screen("✻ Tempering… (1m 56s · ↓ 10.2k tokens)", "Run it?");
        assert_eq!(id("claude", &first), id("claude", &ticked));
        // the card shows the screen as it is
        assert_eq!(
            parse("claude", &ticked).card().body.as_deref(),
            Some("Some output\n✻ Tempering… (1m 56s · ↓ 10.2k tokens)\nPress enter to continue")
        );
        // the words of the working line, another line, or another agent's screen are another card
        let doing = screen("✢ Deleting… (1m 55s · ↓ 10.0k tokens)", "Run it?");
        assert_ne!(id("claude", &first), id("claude", &doing));
        let asked = screen("✢ Tempering… (1m 55s · ↓ 10.0k tokens)", "Run that?");
        assert_ne!(id("claude", &first), id("claude", &asked));
        assert_ne!(id("cursor", &first), id("cursor", &ticked));
        // a screen holding the blanked form as its own text is another card
        let blanked = screen("* Tempering… (<time> · <tokens>)", "Run it?");
        assert_ne!(id("claude", &first), id("claude", &blanked));
    }

    #[test]
    fn a_change_anywhere_on_the_screen_is_another_card() {
        let screen =
            |footer: &str| format!("Pick one?\n1. Alpha\n2. Beta\nSelect a number\n{footer}");
        // the footer under the hint is what ends the screen now, so the keys card reads it
        assert_ne!(id("cursor", &screen("x")), id("cursor", &screen("y")));
        let menu = "header\nPick one?\n1. Alpha\n2. Beta\nSelect a number";
        assert_ne!(
            id("cursor", menu),
            id("cursor", &menu.replace("header", "other"))
        );
        assert_eq!(id("cursor", menu), id("cursor", menu));
    }

    #[test]
    fn the_tail_is_typescripts_last_case() {
        assert!(tail_is_active(Responder::Keys, "x\nctrl+g to edit"));
        assert!(!tail_is_active(Responder::Menu, "Select a number"));
    }
}
