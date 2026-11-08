//! Every value of the two corpora that has a protocol type reads into that type and writes back
//! to the same JSON value: the cards of the screen corpus (`fixtures/screens/`, without the card
//! id the corpus leaves out), the questions and answers handed to the screen parsers, and the
//! pages of the conversation corpus (`fixtures/conversations/`). Values are compared as
//! `serde_json::Value`, numbers by value, so a field that is absent in the corpus must stay absent,
//! and a `null` must stay `null`.

use std::fs;
use std::path::{Path, PathBuf};

use herdr_fleet_protocol::{
    AbandonedTurns, ConversationMetadata, ConversationResponse, ConversationTurn,
    InteractivePrompt, PromptAnswer, QueuedQuestion,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures")
}

/// `(<agent>/<case>, case.json)` of every case under `fixtures/<corpus>`, sorted by name.
fn cases(corpus: &str) -> Vec<(String, Value)> {
    let root = fixtures().join(corpus);
    let mut found = Vec::new();
    for group in fs::read_dir(&root).unwrap() {
        let group = group.unwrap().path();
        if !group.is_dir() {
            continue;
        }
        for case in fs::read_dir(&group).unwrap() {
            let case = case.unwrap().path();
            let file = case.join("case.json");
            if !file.is_file() {
                continue;
            }
            let name = case.strip_prefix(&root).unwrap().display().to_string();
            let spec = serde_json::from_str(&fs::read_to_string(&file).unwrap())
                .unwrap_or_else(|error| panic!("{name}: case.json: {error}"));
            found.push((name, spec));
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

/// The same JSON value, numbers compared by value: `0` and `0.0` are one JavaScript number, and the
/// corpus runners compare them so (ADR 0192-phase-2-split, "corpus の runner").
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| same(a, b)))
        }
        _ => a == b,
    }
}

/// The values read and written so far, and the ones that did not come back the same.
#[derive(Default)]
struct Check {
    checked: usize,
    failures: Vec<String>,
}

impl Check {
    /// Reads `value` as a `T` and writes it back; a failure names the case and what differs.
    fn round_trip<T: DeserializeOwned + Serialize>(&mut self, what: &str, value: &Value) {
        self.checked += 1;
        let typed: T = match serde_json::from_value(value.clone()) {
            Ok(typed) => typed,
            Err(error) => {
                return self
                    .failures
                    .push(format!("{what}: does not read: {error}\n  {value}"));
            }
        };
        let back = serde_json::to_value(&typed).unwrap();
        if !same(&back, value) {
            self.failures.push(format!(
                "{what}: writes back another value\n  corpus {value}\n  Rust   {back}"
            ));
        }
    }

    /// Fails with every value that differed, or when fewer values were read than the corpus holds.
    fn report(self, at_least: usize) {
        let Check { checked, failures } = self;
        assert!(
            failures.is_empty(),
            "{} of {checked} values differ:\n{}",
            failures.len(),
            failures.join("\n")
        );
        assert!(
            checked >= at_least,
            "only {checked} values checked, expected at least {at_least}"
        );
    }
}

/// The calls of the screen corpus that return a card (or null when they find none).
const CARD_CALLS: [&str; 3] = [
    "parseInteractivePrompt",
    "parseFallbackPrompt",
    "codexQueuedPrompt",
];

/// The calls of the screen corpus that return no card: a boolean and a suggestion's text. An
/// adapter's look at the screen (`adapter` and `check`) returns no card either.
const OTHER_SCREEN_CALLS: [&str; 2] = ["codexQuestionsCollapsed", "parseClaudeSuggestion"];

/// The calls of the conversation corpus whose answer has no protocol type: an image and a tool's
/// whole output.
const OTHER_CONVERSATION_CALLS: [&str; 2] = ["image", "toolOutput"];

#[test]
fn screen_corpus_cards_questions_and_answers() {
    let mut check = Check::default();
    for (name, spec) in cases("screens") {
        let call = spec["call"].as_str().unwrap_or("");
        // a call this test does not know may return a card it would never read
        let known = CARD_CALLS.contains(&call)
            || OTHER_SCREEN_CALLS.contains(&call)
            || (call.is_empty() && spec.get("adapter").is_some());
        if !known {
            check.failures.push(format!(
                "{name}: a call this test does not know: {:?}",
                spec["call"]
            ));
        }
        if let Some(card) = spec["expected"]
            .as_object()
            .filter(|_| CARD_CALLS.contains(&call))
        {
            // the corpus leaves the card's id out: it is a hash, and only which cards share one matters
            let mut with_id = Map::new();
            with_id.insert("id".into(), json!("id"));
            with_id.extend(card.clone());
            check.round_trip::<InteractivePrompt>(
                &format!("{name}: expected"),
                &Value::Object(with_id),
            );
        }
        if let Some(unanswered) = spec.get("unanswered") {
            check.round_trip::<Vec<QueuedQuestion>>(&format!("{name}: unanswered"), unanswered);
        }
        for (index, answer) in spec["answers"].as_array().into_iter().flatten().enumerate() {
            // the corpus holds the choice alone; the HTTP body names the pane and the card too
            let mut body = Map::new();
            body.insert("pane_id".into(), json!("p"));
            body.insert("prompt_id".into(), json!("id"));
            body.extend(answer["answer"].as_object().unwrap().clone());
            check.round_trip::<PromptAnswer>(
                &format!("{name}: answers[{index}]"),
                &Value::Object(body),
            );
        }
    }
    // 209 cards, 15 lists of unanswered questions and 55 answers in the corpus at 82f36ce
    check.report(209 + 15 + 55);
}

#[test]
fn conversation_corpus_pages_and_unanswered_questions() {
    let mut check = Check::default();
    for (name, spec) in cases("conversations") {
        for (index, step) in spec["steps"].as_array().unwrap().iter().enumerate() {
            let what = format!("{name}: steps[{index}]");
            let expected = &step["expected"];
            match step["call"].as_str() {
                Some("page") if expected.get("turns").is_some() => {
                    let page = expected.as_object().unwrap();
                    check.round_trip::<Vec<ConversationTurn>>(
                        &format!("{what}: turns"),
                        &page["turns"],
                    );
                    if let Some(metadata) = page.get("metadata") {
                        check.round_trip::<ConversationMetadata>(
                            &format!("{what}: metadata"),
                            metadata,
                        );
                    }
                    if let Some(abandoned) = page.get("abandoned") {
                        check
                            .round_trip::<AbandonedTurns>(&format!("{what}: abandoned"), abandoned);
                    }
                    // the page answer is a ConversationResponse plus the reader's own `version`
                    let mut response = page.clone();
                    response.remove("version");
                    check.round_trip::<ConversationResponse>(
                        &format!("{what}: page"),
                        &Value::Object(response),
                    );
                }
                Some("unansweredQuestions") => {
                    check
                        .round_trip::<Vec<QueuedQuestion>>(&format!("{what}: questions"), expected);
                }
                Some("page") => {} // a failure: `{"error": …}`
                Some(call) if OTHER_CONVERSATION_CALLS.contains(&call) => {}
                Some(call) => check
                    .failures
                    .push(format!("{what}: a call this test does not know: {call}")),
                None => {} // a change to a file of the case, or OpenCode's replies or clock
            }
        }
    }
    // 418 pages (their turns, metadata and the page itself; every page has metadata), 49 of them
    // with `abandoned`, and 6 answers of unanswered questions in the corpus at 82f36ce
    check.report(418 * 3 + 49 + 6);
}
