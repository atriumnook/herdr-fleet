//! Codex 0.156's queue of questions asked with `request_user_input_async`, collapsed above its main
//! prompt ("? 2 questions" / "alt+↑ to answer"): how many wait, and the card of the first, taken
//! from the rollout's unanswered questions (server/prompt.ts:360-415, 1141-1145).

use std::sync::LazyLock;

use protocol::{PromptKind, QueuedQuestion, QueuedState, js};
use regex::Regex;
use unicode_normalization::UnicodeNormalization;

use super::{ASYNC_ASK_HINT, QUEUE_HEADER, Responder};
use crate::answer::{Answering, Key, Typed};
use crate::card::{self, CardFields, option};
use crate::text::{clean_line, find_last_index, js_regex, normalize_text, screen_lines};
use crate::{ParsedPrompt, QueueFront};

/// `CODEX_QUEUE_COUNT_RE`: "? 2 questions".
static QUEUE_COUNT: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"^\?{s}*([0-9]+){s}+questions?(?-u:\b)"));
/// A message of the user's own waiting to be submitted, which replaces the questions' block.
static OWN_MESSAGE: LazyLock<Regex> = LazyLock::new(|| js_regex("^↳{s}"));
static MESSAGES_TO_BE_SUBMITTED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i)Messages to be submitted").unwrap());
/// "alt+↑ to answer", under the count.
static TO_ANSWER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?-u:\b)to answer$").unwrap());
/// The main prompt's mark: `/^›\s(?!\d+\.)/` is this, then no `^\d+\.` where it ends (ADR
/// 0193-phase-2-dependencies).
static MAIN_PROMPT: LazyLock<Regex> = LazyLock::new(|| js_regex("^›{s}"));
static NUMBERED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]+\.").unwrap());
/// What is neither a letter nor a digit.
static NOT_LETTER_OR_DIGIT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]").unwrap());
/// A line the pane cut with an ellipsis.
static CUT: LazyLock<Regex> = LazyLock::new(|| js_regex("…{s}*$"));

/// Whether a line is the main prompt (`›` and a space), not a numbered menu row the parser did not
/// recognise.
fn is_main_prompt(line: &str) -> bool {
    MAIN_PROMPT
        .find(line)
        .is_some_and(|mark| !NUMBERED.is_match(&line[mark.end()..]))
}

/// `queuedQuestionCount`: how many questions wait in Codex's collapsed queue at the bottom of the
/// screen, with the main prompt right under it; 0 otherwise. The card (`codex_queued_prompt`) and
/// the send path (`codex_questions_collapsed`) both read this count, so they cannot disagree.
/// - A message of the user's own waiting to be submitted replaces the questions' block (alt+↑ then
///   opens nothing, checked on Codex 0.156.1): no count then.
/// - An open question (its "enter submit … skip" hint) or an approval under the queue holds the
///   input itself: no count either.
pub(crate) fn queued_question_count(screen: &str) -> usize {
    let lines: Vec<String> = screen_lines(screen)
        .iter()
        .map(|line| clean_line(line))
        .filter(|line| !line.is_empty())
        .collect();
    let Some(header) = find_last_index(&lines, |line, _| QUEUE_HEADER.is_match(line)) else {
        return 0;
    };
    // the queue sits right above the main prompt and its status line
    if lines.len() - header > 16 {
        return 0;
    }
    if lines[header..].iter().any(|line| {
        OWN_MESSAGE.is_match(line)
            || MESSAGES_TO_BE_SUBMITTED.is_match(line)
            || ASYNC_ASK_HINT.is_match(line)
    }) {
        return 0;
    }
    let Some(at) = (header + 1..=header + 7)
        .take_while(|index| *index < lines.len())
        .find(|index| QUEUE_COUNT.is_match(&lines[*index]))
    else {
        return 0;
    };
    let line = |index: usize| lines.get(index).map_or("", String::as_str);
    if !TO_ANSWER.is_match(line(at + 1)) || !is_main_prompt(line(at + 2)) {
        return 0;
    }
    // a count too long for a number is more questions than any rollout holds, as JavaScript's
    // `Number` of it is
    QUEUE_COUNT.captures(&lines[at]).unwrap()[1]
        .parse()
        .unwrap_or(usize::MAX)
}

/// Letters and digits only: a question the pane wraps or punctuates differently still compares
/// equal (`comparable`).
fn comparable(text: &str) -> String {
    let normalized: String = text.nfkc().collect();
    NOT_LETTER_OR_DIGIT
        .replace_all(&normalized, "")
        .to_lowercase()
}

/// `sameText`: whether the question a pane's queue shows is the one asked, by their letters and
/// digits. A pane too narrow for a line may cut it with an ellipsis: then what is shown, 24 or more
/// UTF-16 code units of it, begins what was asked.
pub(crate) fn same_text(shown: &str, asked: &str) -> bool {
    let a = comparable(shown);
    let b = comparable(asked);
    a == b || (CUT.is_match(shown) && js::utf16_len(&a) >= 24 && b.starts_with(&a))
}

/// `codexQueuedPrompt`: the card for Codex's collapsed queue on this screen, from the rollout's
/// unanswered questions.
pub(crate) fn queued_prompt(
    screen: &str,
    unanswered: &[QueuedQuestion],
    front: Option<&QueueFront>,
) -> Option<ParsedPrompt> {
    match queued_question_count(screen) {
        0 => None,
        count => prompt(count, unanswered, front),
    }
}

/// `queuedPrompt`: the collapsed queue shows only a count: the card takes its first question from
/// the rollout, the newest `count` unanswered ones (a skipped question leaves no record).
fn prompt(
    count: usize,
    unanswered: &[QueuedQuestion],
    front: Option<&QueueFront>,
) -> Option<ParsedPrompt> {
    let waiting = &unanswered[unanswered.len().saturating_sub(count)..];
    // the question the queue opened on last time, when that was not the newest guess: by its title
    // and its options, the newest such one (an older skipped one may share the title)
    let opened = front.and_then(|front| {
        unanswered.iter().rev().find(|question| {
            same_text(&front.question, &question.title)
                && question.options.len() == front.options.len()
                && question
                    .options
                    .iter()
                    .zip(&front.options)
                    .all(|(option, shown)| same_text(shown, option))
        })
    });
    let first = opened.or(waiting.first())?;
    if waiting.len() != count || js::trim(&first.title).is_empty() {
        return None;
    }
    let options = first.options.len();
    let fields = CardFields {
        kind: PromptKind::Question,
        title: if count > 1 {
            format!("Question 1 of {count}")
        } else {
            "Question".to_owned()
        },
        question: normalize_text(&first.title),
        body: None,
        options: first.options.iter().map(option).collect(),
        custom_option_index: Some(options),
        queued: Some(QueuedState::Collapsed),
        fallback: false,
    };
    // its "Other" row, under the options, opens with Enter and sends with Enter
    let answering = Answering {
        typed: Some(Typed {
            row: options,
            before: vec![Key::Enter],
            after: vec![Key::Enter],
        }),
        ..Answering::menu(0)
    };
    Some(card::finish(
        "codex",
        fields,
        None,
        Responder::QueuedQuestion,
        answering,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each pair and what TypeScript's sameText answers for it (server/prompt.ts:385, Bun 1.4.4).
    #[test]
    fn compares_as_typescripts_same_text() {
        let gothic = "𐌰";
        let kana = "アイウエオかきくけこさしすせそたちつてとなにぬね";
        let cases: &[(&str, &str, bool)] = &[
            ("Which dataset?", "which  dataset", true),
            // NFKC folds the full-width letters and space
            ("Ｗｈｉｃｈ　ｄａｔａｓｅｔ？", "Which dataset", true),
            ("①②", "12", true),
            ("Use ½ size", "Use 1/2 size", true),
            ("データセットは？", "データセットは", true),
            ("ΟΔΟΣ", "οδος", true),
            // the dot of `İ` lower-cased is a mark, left after the marks were taken out
            ("İstanbul", "i̇stanbul", false),
            ("", "", true),
            ("?!", "…", true),
            // cut with an ellipsis: what is shown begins what was asked
            (
                "Which dataset should we use for the benchmark…",
                "Which dataset should we use for the benchmark run tonight?",
                true,
            ),
            (
                "Which dataset should we use for the benchmark… ",
                "Which dataset should we use for the benchmark run tonight?",
                true,
            ),
            (
                "Which dataset should we use for the benchmark",
                "Which dataset should we use for the benchmark run tonight?",
                false,
            ),
            (
                "Which dataset should we use for the benchmark…",
                "Which model should we use?",
                false,
            ),
            // fewer than 24 letters and digits shown are too few to begin a question by
            ("Short question…", "Short question that goes on", false),
        ];
        for (shown, asked, expected) in cases {
            assert_eq!(same_text(shown, asked), *expected, "{shown:?} {asked:?}");
        }
        // 24 is counted in UTF-16 code units: 12 letters outside the BMP are 24
        let cut = |count: usize| format!("{}…", gothic.repeat(count));
        assert!(same_text(&cut(12), &gothic.repeat(13)));
        assert!(!same_text(&cut(11), &gothic.repeat(12)));
        let shorter: String = kana.chars().take(23).collect();
        assert!(same_text(&format!("{kana}…"), &format!("{kana}の")));
        assert!(!same_text(&format!("{shorter}…"), &format!("{kana}の")));
    }
}
