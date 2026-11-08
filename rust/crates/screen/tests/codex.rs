//! Codex's cards (its continue menu, questions, the queue of questions it asks while it works, and
//! approvals), the card of its collapsed queue and whether that queue is collapsed (#198).

mod common;

use herdr_fleet_screen::{
    Answer, ParsedPrompt, answer_keys, codex_questions_collapsed, codex_queued_prompt,
};
use protocol::QueuedQuestion;
use serde_json::{Value, json};

#[test]
fn codex_cases() {
    common::check(common::Slice::Codex);
}

/// Codex's collapsed queue from
/// `fixtures/screens/codex/a-collapsed-queue-shows-its-first-question-taken-from-the-ro-2`.
const COLLAPSED: &str = concat!(
    "\n",
    "• WAITING\n",
    "• Queued follow-up inputs\n",
    "  ? 2 questions · 8s\n",
    "    alt+↑ to answer\n",
    "› Ask Codex to do anything\n",
    "  GPT-6-Sol xhigh · ~/lab · Context 97% left · weekly 56% left\n",
);

fn question(key: &str, title: &str, options: &[&str]) -> QueuedQuestion {
    QueuedQuestion {
        key: key.into(),
        title: title.into(),
        options: options.iter().map(|option| (*option).to_owned()).collect(),
    }
}

/// The steps an answer sends to a card, as JSON, or the message it is refused with.
fn sent(prompt: &ParsedPrompt, answer: Value) -> Value {
    match answer_keys(prompt, &Answer::from(answer)) {
        Ok(steps) => serde_json::to_value(steps).unwrap(),
        Err(error) => Value::from(error.to_string()),
    }
}

/// The answers to the collapsed queue's card the corpus does not hold. The expected cards, keys and
/// messages are what TypeScript's codexQueuedPrompt and answerKeys return and throw for the same
/// screen and questions (Bun 1.4.4): Enter opens the "Other" row under the options, Enter sends it.
#[test]
fn answers_the_collapsed_queues_card_as_typescript_does() {
    let unanswered = [
        question("a", "Which dataset?", &["LM-O", "YCB-V"]),
        question("b", "Any notes?", &[]),
    ];
    let prompt = codex_queued_prompt(COLLAPSED, &unanswered, None).expect("a card");
    let card = serde_json::to_value(prompt.card()).unwrap();
    assert_eq!(card["title"], "Question 1 of 2");
    assert_eq!(card["custom_option_index"], 2);
    assert_eq!(card["queued"], "collapsed");
    assert_eq!(
        sent(&prompt, json!({"option_index": 0})),
        json!([{"keys": ["enter"]}])
    );
    assert_eq!(
        sent(&prompt, json!({"option_index": 1})),
        json!([{"keys": ["down"]}, {"keys": ["enter"]}])
    );
    assert_eq!(
        sent(&prompt, json!({"option_index": 2})),
        json!("A valid option index is required.")
    );
    assert_eq!(
        sent(&prompt, json!({"custom_text": " T-LESS "})),
        json!([{"keys": ["down"]}, {"keys": ["down"]}, {"keys": ["enter"]}, {"text": "T-LESS"}, {"keys": ["enter"]}])
    );

    // a free-form question: no options, the typed answer alone
    let one = COLLAPSED.replace("? 2 questions", "? 1 question");
    let free = codex_queued_prompt(&one, &unanswered[1..], None).expect("a card");
    let card = serde_json::to_value(free.card()).unwrap();
    assert_eq!(card["title"], "Question");
    assert_eq!(card["options"], json!([]));
    assert_eq!(card["custom_option_index"], 0);
    assert_eq!(
        sent(&free, json!({"option_index": 0})),
        json!("A valid option index is required.")
    );
    assert_eq!(
        sent(&free, json!({"custom_text": "none"})),
        json!([{"keys": ["enter"]}, {"text": "none"}, {"keys": ["enter"]}])
    );
}

/// TypeScript (Bun 1.4.4) on the same screens: a count too long for a number collapses the queue but
/// waits for more questions than the rollout holds, so there is no card; "0 questions" is no queue.
#[test]
fn a_count_of_none_or_of_too_many_gives_no_card() {
    let unanswered = [
        question("a", "Which dataset?", &["LM-O"]),
        question("b", "Any notes?", &[]),
    ];
    let huge = COLLAPSED.replace("? 2 questions", "? 99999999999999999999999 questions");
    assert!(codex_queued_prompt(&huge, &unanswered, None).is_none());
    assert!(codex_questions_collapsed(&huge));
    let zero = COLLAPSED.replace("? 2 questions", "? 0 questions");
    assert!(codex_queued_prompt(&zero, &unanswered, None).is_none());
    assert!(!codex_questions_collapsed(&zero));
}
