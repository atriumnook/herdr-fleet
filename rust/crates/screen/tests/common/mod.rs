//! The runner of the screen corpus (`fixtures/screens/`): reads each case, checks its shape, makes
//! its call through the crate's public functions and compares what comes back with the case's
//! `expected`, its answers' keys and its `sameIdAs`. The layout of a case is the TypeScript
//! runner's, `scripts/screen-fixtures.ts`. Each test file checks one slice of the corpus, the cases
//! one issue of phase 2 owns (`slice_of`); `check_all` runs every case (ADR 0192-phase-2-split,
//! "corpus の runner").

// Each test binary uses part of the runner.
#![allow(dead_code)]
// The runner reads the corpus from disk. herdr-fleet-screen's clippy.toml bans file I/O for the
// crate's code, and these are the only lines of the crate that may read files (ADR
// 0122-parity-criteria, "段階 2 への注意"; the CI step "Parsing crates allow their banned APIs only
// in tests").
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use herdr_fleet_screen::{
    Answer, ParsedPrompt, QueueFront, answer_keys, codex_questions_collapsed, codex_queued_prompt,
    parse_claude_suggestion, parse_fallback_prompt, parse_interactive_prompt, screen_checks,
};
use protocol::{FleetAgentKind, QueuedQuestion};
use serde::{Deserialize, Deserializer};
use serde_json::Value;

/// The cases one issue of phase 2 owns (ADR 0192-phase-2-split, "corpus の runner").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slice {
    /// #195: `parseInteractivePrompt` for pi, omp and any agent but claude and codex
    PiOmp,
    /// #197: `parseInteractivePrompt` for claude, and `parseClaudeSuggestion`
    Claude,
    /// #198: `parseInteractivePrompt` for codex, `codexQueuedPrompt` and `codexQuestionsCollapsed`
    Codex,
    /// #199: `parseFallbackPrompt`
    Fallback,
    /// #200: the adapters' looks at a screen
    Checks,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Call {
    ParseInteractivePrompt,
    ParseFallbackPrompt,
    CodexQueuedPrompt,
    CodexQuestionsCollapsed,
    ParseClaudeSuggestion,
}

/// An adapter's look at a screen (`server/fleet/adapters.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Check {
    StartupError,
    Question,
    ReadyError,
    InputReady,
    Draft,
    TurnError,
}

/// `case.json`. Fields the runner does not read are ignored, as the TypeScript runner keeps them.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub call: Option<Call>,
    pub adapter: Option<FleetAgentKind>,
    pub check: Option<Check>,
    pub agent: Option<String>,
    pub unanswered: Option<Vec<QueuedQuestion>>,
    #[serde(default, deserialize_with = "present")]
    pub front: Option<Value>,
    /// `None` when the case has no `expected`; `Some(Value::Null)` when it expects null.
    #[serde(default, deserialize_with = "present")]
    pub expected: Option<Value>,
    pub same_id_as: Option<Vec<String>>,
    pub answers: Option<Vec<AnswerCase>>,
}

#[derive(Debug, Deserialize)]
pub struct AnswerCase {
    pub answer: Answer,
    #[serde(default, deserialize_with = "present")]
    pub expected: Option<Value>,
}

/// A field that is there, `null` included, as `Some`; a missing one stays `None` by `default`.
fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

pub struct Case {
    /// `<agent>/<case>`
    pub name: String,
    pub screen: String,
    pub spec: Spec,
}

fn screens_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/screens")
}

/// Every case of the corpus, sorted by name.
pub fn load_cases() -> Vec<Case> {
    let root = screens_dir();
    let mut cases = Vec::new();
    for group in fs::read_dir(&root).unwrap_or_else(|error| panic!("{}: {error}", root.display())) {
        let group = group.unwrap().path();
        if !group.is_dir() {
            continue;
        }
        for dir in fs::read_dir(&group).unwrap() {
            let dir = dir.unwrap().path();
            if !dir.is_dir() {
                continue;
            }
            // `<agent>/<case>` on every platform, as `sameIdAs` names a case
            let name = format!(
                "{}/{}",
                group.file_name().unwrap().to_string_lossy(),
                dir.file_name().unwrap().to_string_lossy()
            );
            let screen = fs::read_to_string(dir.join("screen.txt"))
                .unwrap_or_else(|error| panic!("{name}: screen.txt: {error}"));
            let json = fs::read_to_string(dir.join("case.json"))
                .unwrap_or_else(|error| panic!("{name}: case.json: {error}"));
            let spec = serde_json::from_str(&json)
                .unwrap_or_else(|error| panic!("{name}: case.json: {error}"));
            cases.push(Case { name, screen, spec });
        }
    }
    cases.sort_by(|a, b| a.name.cmp(&b.name));
    cases
}

/// The issue that owns a case.
pub fn slice_of(spec: &Spec) -> Slice {
    if spec.adapter.is_some() || spec.check.is_some() {
        return Slice::Checks;
    }
    match spec.call {
        Some(Call::ParseInteractivePrompt) => match spec.agent.as_deref() {
            Some("claude") => Slice::Claude,
            Some("codex") => Slice::Codex,
            _ => Slice::PiOmp,
        },
        Some(Call::ParseFallbackPrompt) => Slice::Fallback,
        Some(Call::CodexQueuedPrompt | Call::CodexQuestionsCollapsed) => Slice::Codex,
        Some(Call::ParseClaudeSuggestion) => Slice::Claude,
        None => panic!("a case needs a call, or an adapter and a check"),
    }
}

/// What a case's call returned, as the case compares it.
pub struct Evaluated {
    /// the call's answer as JSON, a card without its id
    pub value: Value,
    /// the card's id, when the call returned a card
    pub id: Option<String>,
    /// the keys each of the case's answers sends, as JSON
    pub answers: Vec<Value>,
}

enum Outcome {
    Card(Option<Box<ParsedPrompt>>),
    Value(Value),
}

fn call(case: &Case) -> Result<Outcome, String> {
    let spec = &case.spec;
    if spec.adapter.is_some() || spec.check.is_some() {
        let (Some(kind), Some(check), None) = (spec.adapter, spec.check, spec.call) else {
            return Err("a check needs an adapter and a check, and no call".into());
        };
        let checks = screen_checks(kind);
        let screen = case.screen.as_str();
        let missing = || format!("the {kind:?} adapter has no {check:?}");
        let value = match check {
            Check::StartupError => Value::from((checks.startup_error)(screen)),
            Check::TurnError => Value::from((checks.turn_error)(screen)),
            Check::Question => Value::from(checks.question.ok_or_else(missing)?(screen)),
            Check::ReadyError => Value::from(checks.ready_error.ok_or_else(missing)?(screen)),
            Check::InputReady => Value::from(checks.input_ready.ok_or_else(missing)?(screen)),
            Check::Draft => Value::from(checks.draft.ok_or_else(missing)?(screen)),
        };
        return Ok(Outcome::Value(value));
    }
    let agent = || {
        // `agentOf` of scripts/screen-fixtures.ts: an empty name is no agent either
        spec.agent
            .as_deref()
            .filter(|agent| !agent.is_empty())
            .ok_or_else(|| format!("{:?} needs an agent", spec.call))
    };
    Ok(match spec.call {
        Some(Call::ParseInteractivePrompt) => {
            Outcome::Card(parse_interactive_prompt(agent()?, &case.screen).map(Box::new))
        }
        Some(Call::ParseFallbackPrompt) => Outcome::Card(Some(Box::new(parse_fallback_prompt(
            agent()?,
            &case.screen,
        )))),
        Some(Call::CodexQueuedPrompt) => {
            let front: Option<QueueFront> = match &spec.front {
                None | Some(Value::Null) => None,
                Some(front) => Some(
                    serde_json::from_value(front.clone())
                        .map_err(|error| format!("front: {error}"))?,
                ),
            };
            let unanswered = spec.unanswered.as_deref().unwrap_or_default();
            Outcome::Card(
                codex_queued_prompt(&case.screen, unanswered, front.as_ref()).map(Box::new),
            )
        }
        Some(Call::CodexQuestionsCollapsed) => {
            Outcome::Value(Value::from(codex_questions_collapsed(&case.screen)))
        }
        Some(Call::ParseClaudeSuggestion) => {
            Outcome::Value(Value::from(parse_claude_suggestion(&case.screen)))
        }
        None => return Err("a case needs a call, or an adapter and a check".into()),
    })
}

/// Makes the case's call and reads it as the case compares it. Err: the case is malformed or an
/// answer was refused.
pub fn evaluate(case: &Case) -> Result<Evaluated, String> {
    let answers = case.spec.answers.as_deref().unwrap_or_default();
    match call(case)? {
        Outcome::Value(value) => {
            if !answers.is_empty() {
                return Err("answers are given for a call that returned no card".into());
            }
            Ok(Evaluated {
                value,
                id: None,
                answers: Vec::new(),
            })
        }
        Outcome::Card(None) => {
            if !answers.is_empty() {
                return Err("answers are given for a call that returned no card".into());
            }
            Ok(Evaluated {
                value: Value::Null,
                id: None,
                answers: Vec::new(),
            })
        }
        Outcome::Card(Some(prompt)) => {
            let mut value = serde_json::to_value(prompt.card()).unwrap();
            let id = value
                .as_object_mut()
                .and_then(|card| card.remove("id"))
                .and_then(|id| id.as_str().map(str::to_owned))
                .filter(|id| !id.is_empty())
                .ok_or("the call returned a card without an id")?;
            let answers = answers
                .iter()
                .enumerate()
                .map(|(index, each)| {
                    answer_keys(&prompt, &each.answer)
                        .map(|steps| serde_json::to_value(steps).unwrap())
                        .map_err(|error| format!("answer {index} was refused: {error}"))
                })
                .collect::<Result<_, _>>()?;
            Ok(Evaluated {
                value,
                id: Some(id),
                answers,
            })
        }
    }
}

/// The same JSON value, numbers compared by value: `1` and `1.0` are one JavaScript number, and
/// serde_json tells them apart (ADR 0192-phase-2-split, "corpus の runner").
pub fn same(a: &Value, b: &Value) -> bool {
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

/// What is wrong with a case's answers, or `None` when they are what it expects.
fn mismatch(case: &Case, result: &Evaluated) -> Option<String> {
    let Some(expected) = &case.spec.expected else {
        return Some("the case has no expected value".into());
    };
    if !same(&result.value, expected) {
        return Some(format!("returned {}\nexpected {expected}", result.value));
    }
    for (index, each) in case.spec.answers.iter().flatten().enumerate() {
        let Some(expected) = &each.expected else {
            return Some(format!("answer {index} has no expected keys"));
        };
        if !same(&result.answers[index], expected) {
            return Some(format!(
                "answer {index} sent {}\nexpected {expected}",
                result.answers[index]
            ));
        }
    }
    None
}

/// For each case whose call returned a card, the other cases whose card has the same id, sorted by
/// name.
fn same_ids<'a>(evaluated: &BTreeMap<&'a str, Evaluated>) -> BTreeMap<&'a str, Vec<&'a str>> {
    let mut by_id: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (name, result) in evaluated {
        if let Some(id) = &result.id {
            by_id.entry(id).or_default().push(name);
        }
    }
    let mut same = BTreeMap::new();
    for names in by_id.values() {
        for name in names {
            same.insert(
                *name,
                names
                    .iter()
                    .copied()
                    .filter(|other| other != name)
                    .collect(),
            );
        }
    }
    same
}

/// Runs the cases `slice` owns. Fails when one returns other than its expected value, when its card
/// shares an id with other cases than its `sameIdAs` names, or when its `sameIdAs` names a case
/// outside the slice.
pub fn check(slice: Slice) {
    run(&format!("{slice:?}"), |spec| slice_of(spec) == slice);
}

/// Runs every case of the corpus, whichever issue owns it.
pub fn check_all() {
    run("every", |_| true);
}

fn run(what: &str, owned: impl Fn(&Spec) -> bool) {
    let cases = load_cases();
    assert!(!cases.is_empty(), "the corpus has no cases");
    let mine: Vec<&Case> = cases.iter().filter(|case| owned(&case.spec)).collect();
    assert!(!mine.is_empty(), "the slice {what} has no cases");
    let failures = failures(&mine, what);
    let failed: BTreeSet<&str> = failures
        .iter()
        .map(|failure| failure.split(": ").next().unwrap())
        .collect();
    println!(
        "{} of {} cases of the slice {what} passed",
        mine.len() - failed.len(),
        mine.len()
    );
    assert!(
        failures.is_empty(),
        "{} cases failed:\n\n{}",
        failed.len(),
        failures.join("\n\n")
    );
}

/// What is wrong with the cases of a slice, each as `<case>: <problem>`: a case that returns other
/// than its expected values, a card that shares its id with other cases than its `sameIdAs` names,
/// and a `sameIdAs` that names a case outside the slice.
pub fn failures(mine: &[&Case], what: &str) -> Vec<String> {
    let names: BTreeSet<&str> = mine.iter().map(|case| case.name.as_str()).collect();
    let mut failures = Vec::new();
    let mut evaluated = BTreeMap::new();
    for case in mine {
        match panic::catch_unwind(AssertUnwindSafe(|| evaluate(case))) {
            Ok(Ok(result)) => {
                if let Some(problem) = mismatch(case, &result) {
                    failures.push(format!("{}: {problem}", case.name));
                }
                evaluated.insert(case.name.as_str(), result);
            }
            Ok(Err(problem)) => failures.push(format!("{}: {problem}", case.name)),
            Err(_) => failures.push(format!("{}: the call panicked", case.name)),
        }
    }
    let same = same_ids(&evaluated);
    for case in mine {
        // as the case lists them: the TypeScript test compares the list, its order and any
        // repeated name included, with the sorted names of the other cases (server/screen-fixtures.test.ts:32)
        let named: Vec<&str> = case
            .spec
            .same_id_as
            .iter()
            .flatten()
            .map(String::as_str)
            .collect();
        let outside: Vec<&str> = named
            .iter()
            .copied()
            .filter(|name| !names.contains(name))
            .collect();
        if !outside.is_empty() {
            failures.push(format!(
                "{}: sameIdAs names cases outside the slice {what}: {outside:?}",
                case.name
            ));
            continue;
        }
        if !evaluated.contains_key(case.name.as_str()) {
            continue;
        }
        let found = same.get(case.name.as_str()).cloned().unwrap_or_default();
        if found != named {
            failures.push(format!(
                "{}: its card has the same id as {found:?}, and sameIdAs names {named:?}",
                case.name
            ));
        }
    }
    failures
}
