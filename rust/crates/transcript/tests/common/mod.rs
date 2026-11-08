//! The conversation corpus runner (ADR 0122-parity-criteria, "会話ログの corpus"; ADR
//! 0192-phase-2-split, "corpus の runner"): it reads `fixtures/conversations/<source>/<case>/`,
//! runs each case's steps against the crate's public functions and compares what they return with
//! the case's `expected`, as `scripts/conversation-fixtures.ts` does for TypeScript (its head says
//! how a case is laid out). Each issue's test calls `check` with the slice it owns; `check_all`
//! runs every case.
//!
//! Each case runs in a new temporary folder, the case folder's files copied there byte for byte,
//! against a new `Transcripts` (and a new `OpencodeConversations` for its OpenCode calls) that all
//! its steps share. Every case runs again in the reverse order, and must answer the same.

// Each test binary uses a part of the runner.
#![allow(dead_code)]
// The runner writes the case's files: it copies a case into its temporary folder and runs the
// steps that change a file (append, replace, rewrite, remove). clippy.toml forbids writing files
// in this crate, and the CI's clippy runs over the tests too; ADR 0122-parity-criteria ("段階 2
// への注意") allows it in this module alone, and ADR 0107-crate-split allows temporary files in
// tests.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod opencode;

use std::collections::hash_map::RandomState;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, FileTimes, OpenOptions};
use std::hash::{BuildHasher, Hasher};
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, SystemTime};

use herdr_fleet_transcript::opencode::OpencodeConversations;
use herdr_fleet_transcript::{
    CodexRollout, ConversationError, FileSource, Image, PageRequest, Transcripts,
};
use regex::Regex;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use self::opencode::RecordedOpencodeApi;

/// The cases' folder: the repository's `fixtures/conversations`.
fn conversations_dir() -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/conversations");
    // without its `..`: a case's paths are checked to stay inside its folder by their components
    fs::canonicalize(&dir).unwrap_or_else(|error| panic!("{}: {error}", dir.display()))
}

/// Which issue owns a case: its source's (ADR 0192-phase-2-split, "corpus の runner").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slice {
    Claude,
    Codex,
    Pi,
    Omp,
    Opencode,
}

const SOURCES: [&str; 5] = ["claude", "codex", "pi", "omp", "opencode"];
const CALLS: [&str; 4] = ["page", "image", "toolOutput", "unansweredQuestions"];
const FILE_STEPS: [&str; 3] = ["append", "replace", "rewrite"];
const STEP_KINDS: [&str; 6] = ["append", "replace", "rewrite", "remove", "api", "at"];

/// A case of the corpus, read and checked against the format.
pub struct Case {
    /// `<source>/<folder>`
    pub name: String,
    pub dir: PathBuf,
    pub source: String,
    pub spec: Map<String, Value>,
}

impl Case {
    fn steps(&self) -> &[Value] {
        self.spec
            .get("steps")
            .and_then(Value::as_array)
            .map_or(&[], Vec::as_slice)
    }
}

/// The slice that owns a case.
pub fn slice_of(case: &Case) -> Slice {
    match case.source.as_str() {
        "claude" => Slice::Claude,
        "codex" => Slice::Codex,
        "pi" => Slice::Pi,
        "omp" => Slice::Omp,
        "opencode" => Slice::Opencode,
        other => panic!("{}: not a source ({other})", case.name),
    }
}

/// Runs the cases of `slice`, in order and in the reverse order, and fails naming every step
/// whose answer is not its expected value.
pub fn check(slice: Slice) {
    let cases = load_cases();
    let owned: Vec<&Case> = cases
        .iter()
        .filter(|case| slice_of(case) == slice)
        .collect();
    assert!(!owned.is_empty(), "the corpus has no {slice:?} case");
    check_cases(&owned);
}

/// Runs every case of the corpus, whichever slice owns it.
pub fn check_all() {
    let cases = load_cases();
    assert!(!cases.is_empty(), "the corpus has no case");
    check_cases(&cases.iter().collect::<Vec<_>>());
}

fn check_cases(cases: &[&Case]) {
    let mut failures = Vec::new();
    let mut forward = HashMap::new();
    for case in cases {
        match run_case(case) {
            Ok(values) => {
                for (index, step) in case.steps().iter().enumerate() {
                    if step.get("call").is_none() {
                        continue;
                    }
                    let Some(expected) = step.get("expected") else {
                        failures.push(format!(
                            "{} step {index} has no expected value: write it with `bun scripts/conversation-fixtures.ts --update` and read the diff",
                            case.name
                        ));
                        continue;
                    };
                    let actual = values[index].as_ref().unwrap_or(&Value::Null);
                    if !same(actual, expected) {
                        failures.push(format!(
                            "{} step {index}:\n  expected: {expected}\n    actual: {actual}",
                            case.name
                        ));
                    }
                }
                forward.insert(case.name.clone(), values);
            }
            Err(error) => failures.push(error),
        }
    }
    for case in cases.iter().rev() {
        let Some(earlier) = forward.get(&case.name) else {
            continue;
        };
        match run_case(case) {
            Ok(values)
                if values.len() == earlier.len()
                    && values.iter().zip(earlier).all(|(a, b)| same_step(a, b)) => {}
            Ok(_) => failures.push(format!(
                "{}: answers otherwise when the cases run in the reverse order",
                case.name
            )),
            Err(error) => failures.push(format!("{error} (the cases in the reverse order)")),
        }
    }
    assert!(
        failures.is_empty(),
        "{} failure(s) in {} case(s):\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

fn same_step(a: &Option<Value>, b: &Option<Value>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => same(a, b),
        (None, None) => true,
        _ => false,
    }
}

/// Two JSON values alike, numbers by their value: serde_json tells `1` from `1.0`, the
/// TypeScript runner's `JSON.parse` does not (ADR 0192-phase-2-split, "比べ方").
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| same(value, other)))
        }
        _ => a == b,
    }
}

/// Every case of the corpus, by name; panics naming a folder or field the format does not know.
pub fn load_cases() -> Vec<Case> {
    let root = conversations_dir();
    let mut cases = Vec::new();
    for source in folders(&root) {
        assert!(
            SOURCES.contains(&source.as_str()),
            "{source}: not a source ({})",
            SOURCES.join(", ")
        );
        for folder in folders(&root.join(&source)) {
            let name = format!("{source}/{folder}");
            let dir = root.join(&source).join(&folder);
            let text = fs::read_to_string(dir.join("case.json"))
                .unwrap_or_else(|_| panic!("{name}: the case folder has no readable case.json"));
            let value: Value = serde_json::from_str(&text)
                .unwrap_or_else(|error| panic!("{name}: case.json is not JSON ({error})"));
            let spec = validate_case(&name, value).unwrap_or_else(|error| panic!("{error}"));
            let case = Case {
                name,
                dir,
                source: source.clone(),
                spec,
            };
            // a case reads its own source only: the folder is the issue that owns it
            for (index, step) in case.steps().iter().enumerate() {
                if let Some(other) = step
                    .get("call")
                    .and(step.get("source"))
                    .and_then(Value::as_str)
                {
                    assert_eq!(
                        other, source,
                        "{} step {index}: source \"{other}\" in a {source} case",
                        case.name
                    );
                }
            }
            cases.push(case);
        }
    }
    cases.sort_by(|a, b| a.name.cmp(&b.name));
    cases
}

fn folders(path: &Path) -> Vec<String> {
    let entries = fs::read_dir(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// The keys of `value` that are not `allowed`, as an error naming them.
fn only_keys(place: &str, value: &Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
    let unknown: Vec<String> = value
        .keys()
        .filter(|key| !allowed.contains(&key.as_str()))
        .map(|key| format!("\"{key}\""))
        .collect();
    if unknown.is_empty() {
        return Ok(());
    }
    Err(format!(
        "{place}: unknown field{} {}",
        if unknown.len() > 1 { "s" } else { "" },
        unknown.join(", ")
    ))
}

/// The fields a call takes: the file sources', or OpenCode's.
fn call_fields(source: &str, call: &str) -> Vec<&'static str> {
    let mut fields: Vec<&'static str> = match (source == "opencode", call) {
        (false, "page") => vec!["call", "source", "path", "page", "expected"],
        (false, "image") => vec!["call", "source", "path", "ref", "expected"],
        (false, "toolOutput") => vec!["call", "source", "path", "ref", "expected"],
        (false, "unansweredQuestions") => vec!["call", "source", "path", "expected"],
        (true, "page") => vec!["call", "source", "sessionId", "working", "page", "expected"],
        (true, "image") => vec!["call", "source", "sessionId", "ref", "expected"],
        (true, "toolOutput") => vec!["call", "source", "sessionId", "ref", "expected"],
        _ => Vec::new(),
    };
    if source == "codex" && call == "image" {
        fields.push("cwd");
    }
    fields
}

/// case.json as the format says (`validateCase`): an error naming any field it does not know.
pub fn validate_case(name: &str, value: Value) -> Result<Map<String, Value>, String> {
    let Value::Object(spec) = value else {
        return Err(format!("{name}: case.json is not an object"));
    };
    only_keys(name, &spec, &["about", "piContextWindows", "steps"])?;
    if spec.get("about").is_some_and(|about| !about.is_string()) {
        return Err(format!("{name}: \"about\" is not a string"));
    }
    if let Some(windows) = spec.get("piContextWindows") {
        let Value::Object(windows) = windows else {
            return Err(format!("{name}: \"piContextWindows\" is not an object"));
        };
        for (key, tokens) in windows {
            if pi_model_key(key).is_none() {
                return Err(format!(
                    "{name}: piContextWindows key \"{key}\" is not \"<provider>/<model>\""
                ));
            }
            if !tokens.as_f64().is_some_and(is_safe_integer) {
                return Err(format!(
                    "{name}: piContextWindows \"{key}\" is not a whole number"
                ));
            }
        }
    }
    let steps = spec
        .get("steps")
        .and_then(Value::as_array)
        .filter(|steps| !steps.is_empty());
    let Some(steps) = steps else {
        return Err(format!("{name}: \"steps\" is not a list of steps"));
    };
    for (index, step) in steps.iter().enumerate() {
        validate_step(&format!("{name} step {index}"), step)?;
    }
    Ok(spec)
}

/// `<provider>/<model>` as (provider, model): the provider holds no `/`, the model is one line.
fn pi_model_key(key: &str) -> Option<(&str, &str)> {
    let (provider, model) = key.split_once('/')?;
    let one_line = !model.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
    (!provider.is_empty() && !model.is_empty() && one_line).then_some((provider, model))
}

fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

fn validate_step(place: &str, step: &Value) -> Result<(), String> {
    let Value::Object(step) = step else {
        return Err(format!("{place}: not an object"));
    };
    if let Some(call) = step.get("call") {
        let call = call
            .as_str()
            .filter(|call| CALLS.contains(call))
            .ok_or_else(|| format!("{place}: unknown call {call}"))?;
        let source = step.get("source").cloned().unwrap_or(Value::Null);
        let source = source
            .as_str()
            .filter(|source| SOURCES.contains(source))
            .ok_or_else(|| format!("{place}: unknown source {source}"))?;
        let fields = call_fields(source, call);
        if fields.is_empty() {
            return Err(format!("{place}: opencode has no {call} call"));
        }
        if call == "unansweredQuestions" && source != "codex" {
            return Err(format!("{place}: only codex has unansweredQuestions"));
        }
        if call == "image" && source == "omp" {
            return Err(format!("{place}: omp has no image call"));
        }
        only_keys(place, step, &fields)?;
        for field in &fields {
            if matches!(*field, "expected" | "page" | "working") {
                continue;
            }
            if !step.get(*field).is_some_and(Value::is_string) {
                return Err(format!("{place}: \"{field}\" is not a string"));
            }
        }
        if step
            .get("working")
            .is_some_and(|working| !working.is_boolean())
        {
            return Err(format!("{place}: \"working\" is not a boolean"));
        }
        if let Some(page) = step.get("page") {
            let Value::Object(page) = page else {
                return Err(format!("{place}: \"page\" is not an object"));
            };
            only_keys(&format!("{place} page"), page, &["before", "since", "from"])?;
            if let Some((key, _)) = page.iter().find(|(_, cursor)| !cursor.is_string()) {
                return Err(format!("{place}: page \"{key}\" is not a string"));
            }
        }
        return Ok(());
    }
    let kinds: Vec<&str> = STEP_KINDS
        .iter()
        .copied()
        .filter(|kind| step.contains_key(*kind))
        .collect();
    if kinds.len() != 1 {
        let fields: Vec<&str> = step.keys().map(String::as_str).collect();
        return Err(format!(
            "{place}: a step is one of call, {} (fields: {})",
            STEP_KINDS.join(", "),
            if fields.is_empty() {
                "none".to_owned()
            } else {
                fields.join(", ")
            }
        ));
    }
    let kind = kinds[0];
    if FILE_STEPS.contains(&kind) {
        only_keys(place, step, &[kind, "from", "text"])?;
        if !step[kind].is_string() {
            return Err(format!("{place}: \"{kind}\" is not a path"));
        }
        if step.contains_key("from") == step.contains_key("text") {
            return Err(format!(
                "{place}: {kind} takes one of \"from\" and \"text\""
            ));
        }
        if step.get("from").is_some_and(|from| !from.is_string()) {
            return Err(format!("{place}: \"from\" is not a path"));
        }
        if step.get("text").is_some_and(|text| !text.is_string()) {
            return Err(format!("{place}: \"text\" is not a string"));
        }
    } else if kind == "remove" {
        only_keys(place, step, &["remove"])?;
        if !step["remove"].is_string() {
            return Err(format!("{place}: \"remove\" is not a path"));
        }
    } else if kind == "api" {
        only_keys(place, step, &["api"])?;
        validate_replies(&format!("{place} api"), &step["api"])?;
    } else {
        only_keys(place, step, &["at"])?;
        // the reader's clock is whole epoch milliseconds, as `Date.now()` is
        if step["at"].as_i64().is_none() {
            return Err(format!("{place}: \"at\" is not a whole number"));
        }
    }
    Ok(())
}

/// OpenCode's recorded replies as the format says: `{"<path>": {"status", "body"}}`.
pub fn validate_replies(place: &str, replies: &Value) -> Result<(), String> {
    let Value::Object(replies) = replies else {
        return Err(format!("{place}: not an object of paths"));
    };
    for (path, reply) in replies {
        if !path.starts_with('/') {
            return Err(format!("{place}: \"{path}\" is not a path"));
        }
        let Value::Object(reply) = reply else {
            return Err(format!("{place} \"{path}\": not {{status, body}}"));
        };
        only_keys(&format!("{place} \"{path}\""), reply, &["status", "body"])?;
        if !reply
            .get("status")
            .and_then(Value::as_f64)
            .is_some_and(|status| status.fract() == 0.0)
        {
            return Err(format!(
                "{place} \"{path}\": \"status\" is not a whole number"
            ));
        }
        if !reply.contains_key("body") {
            return Err(format!("{place} \"{path}\": no \"body\""));
        }
    }
    Ok(())
}

static NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\$[A-Za-z_][A-Za-z0-9_]*$").expect("NAME"));
static NOT_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^!\$[A-Za-z_][A-Za-z0-9_]*$").expect("NOT_NAME"));

/// The page fields whose values change with every run, and so are named.
const NAMED_FIELDS: [&str; 3] = ["history_id", "cursor", "version"];

/// The names a case gives to the values that change with every run; two names never name one
/// value.
#[derive(Default)]
struct Names {
    by_name: HashMap<String, String>,
    by_value: HashMap<String, String>,
}

impl Names {
    fn value(&self, name: &str) -> Option<&String> {
        self.by_name.get(name)
    }

    fn bind(&mut self, name: &str, value: &str) {
        self.by_name.insert(name.to_owned(), value.to_owned());
        self.by_value.insert(value.to_owned(), name.to_owned());
    }

    /// A value as the case holds it: the name the expected value gives, bound here or compared,
    /// and a value that does not fit its name as it is, so the comparison shows it (`nameValue`).
    fn name_value(&mut self, actual: &Value, expected: Option<&Value>) -> Value {
        let (Some(text), Some(Value::String(expected))) = (actual.as_str(), expected) else {
            return actual.clone();
        };
        if NOT_NAME.is_match(expected) {
            let other = self.value(&expected[1..]);
            return if other.is_some_and(|other| other != text) {
                Value::String(expected.clone())
            } else {
                actual.clone()
            };
        }
        if !NAME.is_match(expected) || expected == "$CASE" {
            return actual.clone();
        }
        if let Some(bound) = self.value(expected) {
            return if bound == text {
                Value::String(expected.clone())
            } else {
                actual.clone()
            };
        }
        if self.by_value.contains_key(text) {
            return actual.clone();
        }
        self.bind(expected, text);
        Value::String(expected.clone())
    }
}

/// Every string in `value` with the case folder's path written `$CASE`, where the path ends at a
/// `/`, the end, or a character no file name of the case holds (`withCase`). `folders`: its
/// spellings, the longest first.
fn with_case(value: Value, folders: &[String]) -> Value {
    match value {
        Value::String(text) => Value::String(
            folders
                .iter()
                .fold(text, |text, folder| replace_folder(&text, folder)),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| with_case(item, folders))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, item)| (key, with_case(item, folders)))
                .collect(),
        ),
        other => other,
    }
}

fn replace_folder(text: &str, folder: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find(folder) {
        let after = &rest[at + folder.len()..];
        let ends = after
            .chars()
            .next()
            .is_none_or(|next| !(next.is_ascii_alphanumeric() || matches!(next, '.' | '_' | '-')));
        if ends {
            out.push_str(&rest[..at]);
            out.push_str("$CASE");
            rest = after;
        } else {
            let step = at + rest[at..].chars().next().map_or(1, char::len_utf8);
            out.push_str(&rest[..step]);
            rest = &rest[step..];
        }
    }
    out.push_str(rest);
    out
}

/// What a read returns, as a case writes it: its value, or the failure it says. A failure of
/// OpenCode's CLI is none a case expects: it fails the case, as TypeScript's `failure` throws it
/// again.
fn answer<T>(
    result: Result<T, ConversationError>,
    value: impl FnOnce(T) -> Value,
    place: &str,
) -> Result<Value, String> {
    match result {
        Ok(found) => Ok(value(found)),
        Err(ConversationError::HistoryChanged) => Ok(json!({ "error": "HistoryChanged" })),
        Err(error @ ConversationError::ConversationUnavailable(_)) => {
            Ok(json!({ "error": "ConversationUnavailable", "reason": error.reason() }))
        }
        Err(ConversationError::ConversationNotStarted {
            session_id,
            source,
            identity,
        }) => Ok(json!({
            "error": "ConversationNotStarted",
            "reason": "session_not_written",
            "sessionId": session_id,
            "source": source,
            "identity": identity,
        })),
        Err(ConversationError::Opencode(error)) => Err(format!("{place}: {error}")),
    }
}

fn page_json(page: herdr_fleet_transcript::Page) -> Value {
    serde_json::to_value(page).expect("a page as JSON")
}

/// An image as a case writes it: its type, the sha256 of its bytes in hex, and their length.
fn image(found: Option<Image>) -> Value {
    match found {
        None => Value::Null,
        Some(image) => {
            let digest = Sha256::digest(&image.bytes);
            let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
            json!({ "mediaType": image.media_type, "sha256": hex, "length": image.bytes.len() })
        }
    }
}

/// A path of the case, inside its folder; an error when it leads outside.
fn inside(folder: &Path, path: &str, place: &str) -> Result<PathBuf, String> {
    let mut full = PathBuf::new();
    for component in folder.join(path).components() {
        match component {
            Component::ParentDir => {
                full.pop();
            }
            Component::CurDir => {}
            other => full.push(other),
        }
    }
    if full != folder && !full.starts_with(folder) {
        return Err(format!("{place}: \"{path}\" is outside the case folder"));
    }
    Ok(full)
}

/// A cursor the case passes: a name it gave before, or a value as written.
fn cursor_input(cursor: &str, names: &Names, place: &str) -> Result<String, String> {
    if !NAME.is_match(cursor) {
        return Ok(cursor.to_owned());
    }
    names
        .value(cursor)
        .cloned()
        .ok_or_else(|| format!("{place}: {cursor} is passed before a step names it"))
}

/// A new folder no other run uses, under the system's temporary folder.
fn temporary_root() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    loop {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        let root =
            std::env::temp_dir().join(format!("herdr-conversation-{:016x}", hasher.finish()));
        match fs::create_dir(&root) {
            Ok(()) => return root,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => panic!("{}: {error}", root.display()),
        }
    }
}

/// Removes a case's temporary folder however its run ends.
struct Cleanup(PathBuf);

impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Copies a folder's files, but case.json at its top, byte for byte.
fn copy_case(from: &Path, to: &Path, top: bool) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| format!("{}: {error}", to.display()))?;
    let entries = fs::read_dir(from).map_err(|error| format!("{}: {error}", from.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("{}: {error}", from.display()))?;
        let name = entry.file_name();
        if top && name == "case.json" {
            continue;
        }
        let kind = entry
            .file_type()
            .map_err(|error| format!("{}: {error}", entry.path().display()))?;
        if kind.is_dir() {
            copy_case(&entry.path(), &to.join(&name), false)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), to.join(&name))
                .map_err(|error| format!("{}: {error}", entry.path().display()))?;
        } else {
            return Err(format!(
                "{}: neither a file nor a folder",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

/// pi's model catalog as the case states it, looked up by provider then model id.
fn pi_context_windows(spec: &Map<String, Value>) -> HashMap<String, HashMap<String, f64>> {
    let mut providers: HashMap<String, HashMap<String, f64>> = HashMap::new();
    for (key, tokens) in spec
        .get("piContextWindows")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        if let (Some((provider, model)), Some(tokens)) = (pi_model_key(key), tokens.as_f64()) {
            providers
                .entry(provider.to_owned())
                .or_default()
                .insert(model.to_owned(), tokens);
        }
    }
    providers
}

/// A case's OpenCode reader and the recorded replies it reads, made at its first OpenCode step.
struct Opencode {
    api: Arc<RecordedOpencodeApi>,
    reader: OpencodeConversations,
}

/// What one run of a case keeps across its steps.
struct Run<'a> {
    case: &'a Case,
    folder: PathBuf,
    folders: Vec<String>,
    transcripts: Transcripts,
    now: Arc<Mutex<i64>>,
    opencode: Option<Opencode>,
    names: Names,
}

impl Run<'_> {
    fn opencode(&mut self, place: &str) -> Result<&Opencode, String> {
        if self.opencode.is_none() {
            let path = self.case.dir.join("api.json");
            let recorded: Value = fs::read_to_string(&path)
                .map_err(|error| error.to_string())
                .and_then(|text| serde_json::from_str(&text).map_err(|error| error.to_string()))
                .map_err(|error| format!("{place}: the case has no readable api.json ({error})"))?;
            let api = Arc::new(RecordedOpencodeApi::new(
                &recorded,
                &format!("{}/api.json", self.case.name),
            )?);
            let now = Arc::clone(&self.now);
            let reader = OpencodeConversations::new(
                api.clone(),
                Box::new(move || *now.lock().unwrap_or_else(|poisoned| poisoned.into_inner())),
            );
            self.opencode = Some(Opencode { api, reader });
        }
        Ok(self.opencode.as_ref().expect("made above"))
    }

    /// What a call step returns, as the case writes it before its values are named.
    fn call(&mut self, step: &Map<String, Value>, place: &str) -> Result<Value, String> {
        let field = |name: &str| {
            step.get(name)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let mut request = PageRequest::default();
        if let Some(page) = step.get("page").and_then(Value::as_object) {
            for (key, cursor) in page {
                let cursor = cursor_input(
                    cursor.as_str().unwrap_or_default(),
                    &self.names,
                    &format!("{place} page.{key}"),
                )?;
                match key.as_str() {
                    "before" => request.before = Some(cursor),
                    "since" => request.since = Some(cursor),
                    _ => request.from = Some(cursor),
                }
            }
        }
        let (call, source) = (field("call"), field("source"));
        if source == "opencode" {
            let reader = &self.opencode(place)?.reader;
            let (session, reference) = (field("sessionId"), field("ref"));
            return match call.as_str() {
                "page" => {
                    let working = step
                        .get("working")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    answer(reader.page(&session, working, &request), page_json, place)
                }
                "image" => answer(reader.image(&session, &reference), image, place),
                "toolOutput" => answer(
                    reader.tool_output(&session, &reference),
                    |output| json!(output),
                    place,
                ),
                other => Err(format!("{place}: opencode has no {other} call")),
            };
        }
        let path = inside(&self.folder, &field("path"), place)?;
        // a codex call reads the case's own Codex home, whether or not the case has one; a local
        // image's path starts at the image step's `cwd`, and the other steps read none
        let rollout = CodexRollout {
            path: path.clone(),
            home: self.folder.join("codex-home"),
            cwd: match step.get("cwd").and_then(Value::as_str) {
                Some(cwd) => inside(&self.folder, cwd, place)?,
                None => self.folder.clone(),
            },
        };
        let file = match source.as_str() {
            "claude" => FileSource::Claude(path),
            "codex" => FileSource::Codex(rollout.clone()),
            "pi" => FileSource::Pi(path),
            _ => FileSource::Omp(path),
        };
        match call.as_str() {
            "page" => answer(self.transcripts.page(&file, &request), page_json, place),
            "toolOutput" => Ok(json!(self.transcripts.tool_output(&file, &field("ref")))),
            "image" => Ok(image(self.transcripts.image(&file, &field("ref")))),
            _ => Ok(
                serde_json::to_value(self.transcripts.unanswered_questions(&rollout))
                    .expect("questions as JSON"),
            ),
        }
    }

    /// Runs a step that changes a file of the case.
    fn change(&self, step: &Map<String, Value>, index: usize, place: &str) -> Result<(), String> {
        let fail = |error: std::io::Error| format!("{place}: {error}");
        if let Some(path) = step.get("remove").and_then(Value::as_str) {
            return fs::remove_file(inside(&self.folder, path, place)?).map_err(fail);
        }
        let kind = FILE_STEPS
            .iter()
            .copied()
            .find(|kind| step.contains_key(*kind))
            .expect("a file step");
        let target = inside(&self.folder, step[kind].as_str().unwrap_or_default(), place)?;
        let bytes = match step.get("from").and_then(Value::as_str) {
            Some(from) => fs::read(inside(&self.case.dir, from, place)?).map_err(fail)?,
            None => step
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .as_bytes()
                .to_vec(),
        };
        match kind {
            "append" => OpenOptions::new()
                .append(true)
                .open(&target)
                .and_then(|mut file| file.write_all(&bytes))
                .map_err(fail),
            "replace" => {
                // another file, another inode, put in its place
                let next = target
                    .parent()
                    .unwrap_or(&self.folder)
                    .join(format!(".replace-{index}"));
                fs::write(&next, &bytes)
                    .and_then(|()| fs::rename(&next, &target))
                    .map_err(fail)
            }
            _ => {
                // written over in place, its mtime then set one second past the later of the one
                // it had and the clock: a rewrite is found by size, mtime and ctime, and two writes
                // can share one mtime tick
                let before = fs::metadata(&target)
                    .and_then(|meta| meta.modified())
                    .map_err(fail)?;
                fs::write(&target, &bytes).map_err(fail)?;
                let at = before.max(SystemTime::now()) + Duration::from_secs(1);
                File::options()
                    .write(true)
                    .open(&target)
                    .and_then(|file| {
                        file.set_times(FileTimes::new().set_accessed(at).set_modified(at))
                    })
                    .map_err(fail)
            }
        }
    }
}

/// Runs a case in a new temporary folder: per step, what a call returned as the case writes it,
/// `None` for the steps that are no call. An error names a case the runner cannot run.
fn run_case(case: &Case) -> Result<Vec<Option<Value>>, String> {
    let root = temporary_root();
    let _cleanup = Cleanup(root.clone());
    let folder = root.join("case");
    copy_case(&case.dir, &folder, true)?;
    let mut folders: Vec<String> = vec![folder.to_string_lossy().into_owned()];
    if let Ok(real) = fs::canonicalize(&folder) {
        folders.push(real.to_string_lossy().into_owned());
    }
    folders = folders
        .into_iter()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    folders.sort_by_key(|folder| std::cmp::Reverse(folder.len()));
    // pi's model catalog: the case's own, never the machine's
    let windows = pi_context_windows(&case.spec);
    let transcripts = Transcripts::new(Box::new(move |model, provider| {
        windows.get(provider?)?.get(model).copied()
    }));
    let mut run = Run {
        case,
        folder,
        folders,
        transcripts,
        now: Arc::new(Mutex::new(0)),
        opencode: None,
        names: Names::default(),
    };

    let mut values = Vec::new();
    for (index, step) in case.steps().iter().enumerate() {
        let place = format!("{} step {index}", case.name);
        let step = step.as_object().expect("a validated step");
        if step.contains_key("call") {
            let mut value = with_case(run.call(step, &place)?, &run.folders);
            if step.get("call").and_then(Value::as_str) == Some("page")
                && let Value::Object(page) = &mut value
                && !page.contains_key("error")
            {
                let expected = step.get("expected").and_then(Value::as_object);
                for field in NAMED_FIELDS {
                    // OpenCode's history id and cursors are message ids, the same in every run
                    if case.source == "opencode" && field != "version" {
                        continue;
                    }
                    if let Some(actual) =
                        page.get(field).filter(|actual| !actual.is_null()).cloned()
                    {
                        let named = run
                            .names
                            .name_value(&actual, expected.and_then(|expected| expected.get(field)));
                        page.insert(field.to_owned(), named);
                    }
                }
            }
            // a reader that catches a failed GET (the model list) must not hide a reply the case forgot
            if let Some(opencode) = &run.opencode {
                let unrecorded = opencode.api.unrecorded();
                if !unrecorded.is_empty() {
                    return Err(format!(
                        "{place}: api.json records no reply for GET {}",
                        unrecorded.join(", ")
                    ));
                }
            }
            values.push(Some(value));
            continue;
        }
        values.push(None);
        if let Some(at) = step.get("at").and_then(Value::as_i64) {
            *run.now
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = at;
        } else if let Some(replies) = step.get("api") {
            run.opencode(&place)?
                .api
                .set(replies, &format!("{place} api"))?;
        } else {
            run.change(step, index, &place)?;
        }
    }
    Ok(values)
}

#[test]
fn writes_the_case_folder_as_case() {
    let folders = vec!["/tmp/x/case".to_owned()];
    assert_eq!(
        with_case(
            json!([
                "/tmp/x/case",
                "/tmp/x/case/a.jsonl",
                "/tmp/x/cases",
                "at /tmp/x/case: gone",
                "/tmp/x/case-2"
            ]),
            &folders
        ),
        json!([
            "$CASE",
            "$CASE/a.jsonl",
            "/tmp/x/cases",
            "at $CASE: gone",
            "/tmp/x/case-2"
        ])
    );
}
