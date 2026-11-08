//! A `Transcripts` that keeps reading answers as a new one does (#205, ADR 0192-phase-2-split:
//! "1 つの `Transcripts` で読み続けた答えが、毎回新しい `Transcripts` で読んだ答えと同じ"), reads
//! after an append what was appended, and keeps no more than TypeScript does (the tests after
//! `TAIL`, ADR 0205-incremental-reads).
//!
//! Two checks of the answers, both against the conversation corpus of the file sources (claude,
//! codex, pi, omp):
//! - every step of every case runs against one `Transcripts`, as the corpus runner does, and each
//!   call is asked again of a new `Transcripts` made for that call alone;
//! - every transcript file of the corpus grows a piece at a time (cut mid-line too), and the
//!   newest page and the page before it are read after each piece, of the one value and of a new
//!   one.
//!
//! What is compared: the turns, the metadata, the abandoned turns, and the byte position of the
//! cursor. Not `history_id` and `version`: a rewrite's generation is found only by a value that
//! remembers the read before it, and `version` names the process too.
//!
//! A cursor is the stream's id and a byte position: the new value's id lacks the generation of a
//! rewrite the old one saw. So a cursor of the stream the warm read answered from is passed to the
//! cold read with the id that a new value gives that stream; a cursor the warm read refused is
//! passed as it is, and the cold read must refuse it too. A warm read that wrongly refuses a
//! cursor is found by the corpus tests, which compare the warm reads with the expected values.

// The runner writes the case's files: it copies a case into a temporary folder and runs the steps
// that change a file (append, replace, rewrite, remove), as the corpus runner of `common` does.
// clippy.toml forbids writing files in this crate; ADR 0122-parity-criteria ("段階 2 への注意")
// allows it in a runner's module with the reason, ADR 0107-crate-split allows temporary files in
// tests, and ADR 0205-incremental-reads records this runner.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::collections::HashMap;
use std::collections::hash_map::RandomState;
use std::fs::{self, File, FileTimes, OpenOptions};
use std::hash::{BuildHasher, Hasher};
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use herdr_fleet_transcript::{
    CodexRollout, ConversationError, FileSource, PageRequest, PiContextWindow, Transcripts,
};
use serde_json::{Map, Value, json};

const FILE_SOURCES: [&str; 4] = ["claude", "codex", "pi", "omp"];

/// A file larger than this grows in the corpus steps alone: each piece is read cold whole.
const GROWN_FILE_MAX: u64 = 1024 * 1024;

#[test]
fn reading_on_answers_as_a_new_value_does_at_every_step_of_the_corpus() {
    let mut failures = Vec::new();
    let mut calls = 0;
    for case in common::load_cases() {
        if !FILE_SOURCES.contains(&case.source.as_str()) {
            continue;
        }
        match run_case(&case) {
            Ok((count, mut found)) => {
                calls += count;
                failures.append(&mut found);
            }
            Err(error) => failures.push(error),
        }
    }
    assert!(calls > 0, "the corpus has no call of a file source");
    assert!(
        failures.is_empty(),
        "{} step(s) answered otherwise warm than cold:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn reading_on_answers_as_a_new_value_does_while_a_transcript_grows() {
    let mut failures = Vec::new();
    let mut grown = 0;
    for case in common::load_cases() {
        if !FILE_SOURCES.contains(&case.source.as_str()) {
            continue;
        }
        for file in transcript_files(&case.dir) {
            let size = fs::metadata(&file).map_or(0, |meta| meta.len());
            if size == 0 || size > GROWN_FILE_MAX {
                continue;
            }
            let name = format!(
                "{} {}",
                case.name,
                file.strip_prefix(&case.dir).unwrap_or(&file).display()
            );
            match grow(&case, &file, &name) {
                Ok(mut found) => failures.append(&mut found),
                Err(error) => failures.push(error),
            }
            grown += 1;
        }
    }
    assert!(grown > 0, "the corpus has no transcript file");
    assert!(
        failures.is_empty(),
        "{} read(s) answered otherwise warm than cold:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// The `.jsonl` files of a case folder, at any depth.
fn transcript_files(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut folders = vec![dir.to_path_buf()];
    while let Some(folder) = folders.pop() {
        let Ok(entries) = fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                folders.push(path);
            } else if path.extension().is_some_and(|ext| ext == "jsonl") {
                found.push(path);
            }
        }
    }
    found.sort();
    found
}

/// Grows a copy of `file` a piece at a time: after each piece, the newest page and the page
/// before it, warm and cold.
fn grow(case: &common::Case, file: &Path, name: &str) -> Result<Vec<String>, String> {
    let bytes = fs::read(file).map_err(|error| format!("{name}: {error}"))?;
    let root = temporary_root();
    let _cleanup = Cleanup(root.clone());
    let folder = root.join("case");
    fs::create_dir_all(folder.join("codex-home")).map_err(|error| format!("{name}: {error}"))?;
    let path = folder.join("grown.jsonl");
    let target = file_source(&case.source, path.clone(), &folder);
    let windows = pi_context_windows(&case.spec);
    let warm = Transcripts::new(windows.clone().context_window());
    let mut failures = Vec::new();
    let mut written = 0;
    for (at, end) in cuts(&bytes).into_iter().enumerate() {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut out| out.write_all(&bytes[written..end]))
            .map_err(|error| format!("{name}: {error}"))?;
        written = end;
        let place = format!("{name} after {end} of {} bytes (piece {at})", bytes.len());
        let newest = PageRequest::default();
        let warm_newest = warm.page(&target, &newest);
        let cold_newest = Transcripts::new(windows.clone().context_window()).page(&target, &newest);
        compare(
            &format!("{place}, the newest page"),
            &page_value(&warm_newest),
            &page_value(&cold_newest),
            &mut failures,
        );
        let Ok(page) = &warm_newest else { continue };
        let Some(cursor) = page.cursor.clone() else {
            continue;
        };
        let warm_before = warm.page(
            &target,
            &PageRequest {
                before: Some(cursor.clone()),
                ..PageRequest::default()
            },
        );
        let cold_id = cold_newest
            .as_ref()
            .ok()
            .map(|page| page.history_id.as_str());
        let cold_before = Transcripts::new(windows.clone().context_window()).page(
            &target,
            &PageRequest {
                before: Some(cold_cursor(&cursor, Some(&page.history_id), cold_id)),
                ..PageRequest::default()
            },
        );
        compare(
            &format!("{place}, the page before the newest"),
            &page_value(&warm_before),
            &page_value(&cold_before),
            &mut failures,
        );
    }
    Ok(failures)
}

/// Where a file grows to, piece by piece: cuts of uneven sizes, mid-line and at line ends, the
/// last one its whole length.
fn cuts(bytes: &[u8]) -> Vec<usize> {
    const PIECES: usize = 12;
    let mut cuts = Vec::new();
    for piece in 1..PIECES {
        let at = bytes.len() * piece / PIECES;
        // every other cut moves to the end of its line, the others stay mid-line
        let at = if piece % 2 == 0 {
            bytes[at..]
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(bytes.len(), |newline| at + newline + 1)
        } else {
            at
        };
        if cuts.last().is_none_or(|last| at > *last) && at < bytes.len() {
            cuts.push(at);
        }
    }
    cuts.push(bytes.len());
    cuts
}

/// The cursor `cursor` as the cold read is given it: of the stream the warm read answered from
/// (`warm_id`), with the id a new value gives that stream (`cold_id`); any other as it is.
fn cold_cursor(cursor: &str, warm_id: Option<&str>, cold_id: Option<&str>) -> String {
    match (cursor.rsplit_once(':'), warm_id, cold_id) {
        (Some((id, offset)), Some(warm), Some(cold)) if id == warm => format!("{cold}:{offset}"),
        _ => cursor.to_owned(),
    }
}

/// What a read answered, as compared: a page without `history_id` and `version`, its cursor as
/// the byte position alone; a failure as the error it is.
fn page_value(result: &Result<herdr_fleet_transcript::Page, ConversationError>) -> Value {
    match result {
        Ok(page) => {
            let mut value = serde_json::to_value(page).expect("a page as JSON");
            if let Value::Object(fields) = &mut value {
                fields.remove("history_id");
                fields.remove("version");
                let position = page
                    .cursor
                    .as_deref()
                    .and_then(|cursor| cursor.rsplit_once(':'))
                    .map(|(_, offset)| offset.to_owned());
                fields.insert("cursor".to_owned(), json!(position));
            }
            value
        }
        Err(error) => json!({ "error": format!("{error:?}") }),
    }
}

fn compare(place: &str, warm: &Value, cold: &Value, failures: &mut Vec<String>) {
    if warm != cold {
        failures.push(format!("{place}:\n  warm: {warm}\n  cold: {cold}"));
    }
}

/// pi's model catalog as the case states it (`<provider>/<model>` keys), never the machine's.
#[derive(Clone)]
struct Windows(HashMap<String, HashMap<String, f64>>);

impl Windows {
    fn context_window(self) -> PiContextWindow {
        Box::new(move |model, provider| self.0.get(provider?)?.get(model).copied())
    }
}

fn pi_context_windows(spec: &Map<String, Value>) -> Windows {
    let mut providers: HashMap<String, HashMap<String, f64>> = HashMap::new();
    for (key, tokens) in spec
        .get("piContextWindows")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        if let (Some((provider, model)), Some(tokens)) = (key.split_once('/'), tokens.as_f64()) {
            providers
                .entry(provider.to_owned())
                .or_default()
                .insert(model.to_owned(), tokens);
        }
    }
    Windows(providers)
}

fn file_source(source: &str, path: PathBuf, folder: &Path) -> FileSource {
    match source {
        "claude" => FileSource::Claude(path),
        "codex" => FileSource::Codex(CodexRollout {
            path,
            home: folder.join("codex-home"),
            cwd: folder.to_path_buf(),
        }),
        "pi" => FileSource::Pi(path),
        _ => FileSource::Omp(path),
    }
}

/// The values a case names (`$name`), as the warm reads gave them: a cursor a step passes is the
/// warm read's.
#[derive(Default)]
struct Names(HashMap<String, String>);

fn is_name(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next() == Some('$')
        && chars
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|rest| rest.is_ascii_alphanumeric() || rest == '_')
}

/// Runs a case's steps in a new temporary folder: each call against the case's one `Transcripts`
/// and against a new one. Returns the number of calls and the calls that answered otherwise.
fn run_case(case: &common::Case) -> Result<(usize, Vec<String>), String> {
    let root = temporary_root();
    let _cleanup = Cleanup(root.clone());
    let folder = root.join("case");
    copy_case(&case.dir, &folder, true)?;
    let windows = pi_context_windows(&case.spec);
    let warm = Transcripts::new(windows.clone().context_window());
    let mut names = Names::default();
    let mut failures = Vec::new();
    let mut calls = 0;
    let steps = case
        .spec
        .get("steps")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    for (index, step) in steps.iter().enumerate() {
        let place = format!("{} step {index}", case.name);
        let step = step.as_object().expect("a validated step");
        if step.contains_key("call") {
            calls += 1;
            let (warm_value, cold_value) =
                call(step, &folder, &warm, &windows, &mut names, &place)?;
            compare(&place, &warm_value, &cold_value, &mut failures);
        } else if step.contains_key("at") || step.contains_key("api") {
            // OpenCode's steps: no file source reads them
        } else {
            change(case, &folder, step, index, &place)?;
        }
    }
    Ok((calls, failures))
}

/// A call step, warm and then cold: what each answered, as compared.
fn call(
    step: &Map<String, Value>,
    folder: &Path,
    warm: &Transcripts,
    windows: &Windows,
    names: &mut Names,
    place: &str,
) -> Result<(Value, Value), String> {
    let field = |name: &str| {
        step.get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let cold = || Transcripts::new(windows.clone().context_window());
    let path = inside(folder, &field("path"), place)?;
    let rollout = CodexRollout {
        path: path.clone(),
        home: folder.join("codex-home"),
        cwd: match step.get("cwd").and_then(Value::as_str) {
            Some(cwd) => inside(folder, cwd, place)?,
            None => folder.to_path_buf(),
        },
    };
    let file = match field("source").as_str() {
        "codex" => FileSource::Codex(rollout.clone()),
        source => file_source(source, path, folder),
    };
    match field("call").as_str() {
        "page" => {
            let mut request = Vec::new();
            for (key, cursor) in step
                .get("page")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
            {
                let cursor = cursor.as_str().unwrap_or_default();
                let cursor = if is_name(cursor) {
                    names.0.get(cursor).cloned().ok_or_else(|| {
                        format!("{place} page.{key}: {cursor} is passed before a step names it")
                    })?
                } else {
                    cursor.to_owned()
                };
                request.push((key.clone(), cursor));
            }
            let warm_answer = warm.page(&file, &page_request(&request));
            // a new value's id of the stream the warm read answered from
            let (warm_id, cold_id) = match &warm_answer {
                Ok(page) => (
                    Some(page.history_id.clone()),
                    cold()
                        .page(&file, &PageRequest::default())
                        .ok()
                        .map(|page| page.history_id),
                ),
                Err(_) => (None, None),
            };
            let cold_request: Vec<(String, String)> = request
                .iter()
                .map(|(key, cursor)| {
                    (
                        key.clone(),
                        cold_cursor(cursor, warm_id.as_deref(), cold_id.as_deref()),
                    )
                })
                .collect();
            let cold_answer = cold().page(&file, &page_request(&cold_request));
            if let (Ok(page), Some(expected)) = (
                &warm_answer,
                step.get("expected").and_then(Value::as_object),
            ) {
                for (field, value) in [
                    ("cursor", page.cursor.clone()),
                    ("history_id", Some(page.history_id.clone())),
                ] {
                    if let (Some(Value::String(name)), Some(value)) = (expected.get(field), value)
                        && is_name(name)
                    {
                        names.0.entry(name.clone()).or_insert(value);
                    }
                }
            }
            Ok((page_value(&warm_answer), page_value(&cold_answer)))
        }
        "toolOutput" => Ok((
            json!(warm.tool_output(&file, &field("ref"))),
            json!(cold().tool_output(&file, &field("ref"))),
        )),
        "image" => {
            let image = |found: Option<herdr_fleet_transcript::Image>| {
                found.map_or(
                    Value::Null,
                    |image| json!({ "mediaType": image.media_type, "bytes": image.bytes }),
                )
            };
            Ok((
                image(warm.image(&file, &field("ref"))),
                image(cold().image(&file, &field("ref"))),
            ))
        }
        _ => Ok((
            serde_json::to_value(warm.unanswered_questions(&rollout)).expect("questions as JSON"),
            serde_json::to_value(cold().unanswered_questions(&rollout)).expect("questions as JSON"),
        )),
    }
}

fn page_request(fields: &[(String, String)]) -> PageRequest {
    let mut request = PageRequest::default();
    for (key, cursor) in fields {
        match key.as_str() {
            "before" => request.before = Some(cursor.clone()),
            "since" => request.since = Some(cursor.clone()),
            _ => request.from = Some(cursor.clone()),
        }
    }
    request
}

/// Runs a step that changes a file of the case, as the corpus runner does (`Run::change` of
/// `common`).
fn change(
    case: &common::Case,
    folder: &Path,
    step: &Map<String, Value>,
    index: usize,
    place: &str,
) -> Result<(), String> {
    let fail = |error: std::io::Error| format!("{place}: {error}");
    if let Some(path) = step.get("remove").and_then(Value::as_str) {
        return fs::remove_file(inside(folder, path, place)?).map_err(fail);
    }
    let kind = ["append", "replace", "rewrite"]
        .into_iter()
        .find(|kind| step.contains_key(*kind))
        .ok_or_else(|| format!("{place}: not a step this runner knows"))?;
    let target = inside(folder, step[kind].as_str().unwrap_or_default(), place)?;
    let bytes = match step.get("from").and_then(Value::as_str) {
        Some(from) => fs::read(inside(&case.dir, from, place)?).map_err(fail)?,
        None => step
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .as_bytes()
            .to_vec(),
    };
    match kind {
        "append" => OpenOptions::new()
            .create(true)
            .append(true)
            .open(&target)
            .and_then(|mut file| file.write_all(&bytes))
            .map_err(fail),
        "replace" => {
            let next = target
                .parent()
                .unwrap_or(folder)
                .join(format!(".replace-{index}"));
            fs::write(&next, &bytes)
                .and_then(|()| fs::rename(&next, &target))
                .map_err(fail)
        }
        _ => {
            // a rewrite is found by size, mtime and ctime, and two writes can share one mtime tick
            let before = fs::metadata(&target)
                .and_then(|meta| meta.modified())
                .map_err(fail)?;
            fs::write(&target, &bytes).map_err(fail)?;
            let at = before.max(SystemTime::now()) + Duration::from_secs(1);
            File::options()
                .write(true)
                .open(&target)
                .and_then(|file| file.set_times(FileTimes::new().set_accessed(at).set_modified(at)))
                .map_err(fail)
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

/// A new folder no other run uses, under the system's temporary folder.
fn temporary_root() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    loop {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        let root = std::env::temp_dir().join(format!("herdr-warm-{:016x}", hasher.finish()));
        match fs::create_dir(&root) {
            Ok(()) => return root,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => panic!("{}: {error}", root.display()),
        }
    }
}

/// Removes a temporary folder however its run ends.
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
        let path = entry.path();
        if path.is_dir() {
            copy_case(&path, &to.join(&name), false)?;
        } else {
            fs::copy(&path, to.join(&name))
                .map_err(|error| format!("{}: {error}", path.display()))?;
        }
    }
    Ok(())
}

// What a read after an append reads, and how much the reads keep, through
// `Transcripts::paging_bytes_read` (ADR 0205-incremental-reads). The values are TypeScript's
// (`server/conversation.ts`), written here rather than taken from the crate, and the bounds are
// worked out by hand from its reads: a poll reads the bytes appended since the last one (once for
// the history boundary, once for the turn starts), `TAIL` bytes before each place a kept read
// stopped, and the live last turn, which only Codex parses incrementally.

/// `bytesBefore` reads this many bytes (`:703-705`).
const TAIL: u64 = 64;
/// `TRANSCRIPT_WINDOW_BYTES`.
const WINDOW: u64 = 16 * 1024 * 1024;

fn no_catalog() -> Transcripts {
    Transcripts::new(Box::new(|_, _| None))
}

/// The bytes `call` makes `transcripts` read.
fn read_by<T>(transcripts: &Transcripts, call: impl FnOnce() -> T) -> (u64, T) {
    let before = transcripts.paging_bytes_read();
    let value = call();
    (transcripts.paging_bytes_read() - before, value)
}

/// Writes `text` at the end of `path`, made when there is none; the file's new size.
fn append(path: &Path, text: &str) -> u64 {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(text.as_bytes()))
        .expect("an append");
    size(path)
}

fn size(path: &Path) -> u64 {
    fs::metadata(path).expect("the file").len()
}

fn omp_line(role: &str, text: &str) -> String {
    let content = if role == "user" {
        json!(text)
    } else {
        json!([{ "type": "text", "text": text }])
    };
    format!(
        "{}\n",
        json!({ "type": "message", "message": { "role": role, "content": content } })
    )
}

fn codex_line(kind: &str, message: &str) -> String {
    format!(
        "{}\n",
        json!({ "type": "event_msg", "payload": { "type": kind, "message": message } })
    )
}

fn omp(path: &Path) -> FileSource {
    FileSource::Omp(path.to_path_buf())
}

fn codex(folder: &Path, path: &Path) -> FileSource {
    file_source("codex", path.to_path_buf(), folder)
}

fn newest(transcripts: &Transcripts, file: &FileSource) -> herdr_fleet_transcript::Page {
    transcripts
        .page(file, &PageRequest::default())
        .expect("a page")
}

/// A temporary folder of its own, with an empty Codex home, removed when dropped.
fn folder() -> (PathBuf, Cleanup) {
    let root = temporary_root();
    fs::create_dir_all(root.join("codex-home")).expect("a Codex home");
    (root.clone(), Cleanup(root))
}

/// An omp session of 40 prompts, each answered at length: its newest page starts at its
/// beginning, and the live last turn is short.
fn long_omp_session(path: &Path) -> u64 {
    for prompt in 0..40 {
        append(path, &omp_line("user", &format!("prompt {prompt}")));
        append(path, &omp_line("assistant", &"x".repeat(10_000)));
    }
    let live_start = size(path);
    append(path, &omp_line("user", "the live prompt"));
    live_start
}

/// A Codex rollout of one long task: the whole rollout is its live turn.
fn long_codex_task(path: &Path, steps: usize) {
    append(path, &codex_line("task_started", ""));
    append(path, &codex_line("user_message", "a long task"));
    for step in 0..steps {
        append(
            path,
            &codex_line(
                "agent_message",
                &format!("step {step} {}", "y".repeat(3_000)),
            ),
        );
    }
}

#[test]
fn a_read_after_an_append_reads_what_was_appended_and_the_live_turn() {
    let (root, _cleanup) = folder();
    let path = root.join("session.jsonl");
    let live_start = long_omp_session(&path);
    let size = size(&path);
    let transcripts = no_catalog();
    let (read, first) = read_by(&transcripts, || newest(&transcripts, &omp(&path)));
    assert!(
        read >= size,
        "the first read reads the file: {read} of {size}"
    );

    // unchanged: the answer is kept, and the bytes before where the boundary scan stopped are
    // read twice, to check that nothing was rewritten and again to keep them
    // (`applyHistoryBoundary`, `:551, 584`)
    let (read, page) = read_by(&transcripts, || newest(&transcripts, &omp(&path)));
    assert_eq!(page.turns, first.turns);
    assert_eq!(read, 2 * TAIL);

    // the live turn grows: the appended bytes twice, six tails, the live turn once
    let reply = omp_line("assistant", "a reply");
    let grown = append(&path, &reply);
    let (read, page) = read_by(&transcripts, || newest(&transcripts, &omp(&path)));
    assert_eq!(page.turns.len(), first.turns.len() + 1);
    let appended = reply.len() as u64;
    let live_turn = grown - live_start;
    let bound = 2 * appended + live_turn + 6 * TAIL;
    assert!(read <= bound, "read {read} bytes, at most {bound}");
    assert!(
        bound * 20 < size,
        "the file is large next to what a read reads"
    );

    // a new prompt: the turn that was live settles and is parsed once more, eight tails
    let prompt = omp_line("user", "the next prompt");
    append(&path, &prompt);
    let (read, _) = read_by(&transcripts, || newest(&transcripts, &omp(&path)));
    let appended = prompt.len() as u64;
    let bound = 2 * appended + 2 * (live_turn + appended) + 8 * TAIL;
    assert!(read <= bound, "read {read} bytes, at most {bound}");
}

#[test]
fn a_read_after_an_append_to_a_long_codex_task_reads_what_was_appended() {
    let (root, _cleanup) = folder();
    let path = root.join("rollout.jsonl");
    long_codex_task(&path, 300);
    let size = size(&path);
    let file = codex(&root, &path);
    let transcripts = no_catalog();
    let (read, _) = read_by(&transcripts, || newest(&transcripts, &file));
    assert!(
        read >= size,
        "the first read reads the file: {read} of {size}"
    );

    // no history boundary in Codex: the appended bytes twice and four tails
    let line = codex_line("agent_message", "one more step");
    append(&path, &line);
    let (read, page) = read_by(&transcripts, || newest(&transcripts, &file));
    let last = page.turns.last().expect("the assistant's turn");
    assert!(matches!(
        last.parts.last(),
        Some(protocol::ConversationPart::Text { text, .. }) if text == "one more step"
    ));
    let appended = line.len() as u64;
    let bound = 2 * appended + 4 * TAIL;
    assert!(read <= bound, "read {read} bytes, at most {bound}");
    assert!(
        bound * 100 < size,
        "the task is long next to what a read reads"
    );
}

/// Reads `files` once each, `between` them all, then again from the last to the first: what each
/// read again read, the first file's last. Each file read again is stored again and moves last,
/// and the count stays the same, so nothing is dropped before the first file is read again.
fn read_again_in_reverse(
    transcripts: &Transcripts,
    files: &[FileSource],
    between: impl FnOnce(),
) -> Vec<u64> {
    for file in files {
        newest(transcripts, file);
    }
    between();
    files
        .iter()
        .rev()
        .map(|file| read_by(transcripts, || newest(transcripts, file)).0)
        .collect()
}

// The answers (`cache`, `:1075`), 32: Codex has no history boundary to scan, so a rollout read
// again unchanged reads nothing while its answer is kept.
#[test]
fn keeps_32_answers() {
    const KEPT: usize = 32;
    let (root, _cleanup) = folder();
    let paths: Vec<PathBuf> = (0..=KEPT)
        .map(|at| {
            let path = root.join(format!("rollout-{at}.jsonl"));
            long_codex_task(&path, 1);
            path
        })
        .collect();
    let files: Vec<FileSource> = paths.iter().map(|path| codex(&root, path)).collect();
    let transcripts = no_catalog();
    let reads = read_again_in_reverse(&transcripts, &files, || {});
    let (dropped, kept) = reads.split_last().expect("33 reads");
    assert!(kept.iter().all(|read| *read == 0), "{kept:?}");
    assert!(*dropped >= size(&paths[0]), "{dropped}");
}

// The history boundary scans (`clearScans`, `:585`), 32: an omp file read again unchanged reads
// two tails only while both its scan and its answer are kept (the answers' limit alone:
// `keeps_32_answers`).
#[test]
fn keeps_32_boundary_scans() {
    const KEPT: usize = 32;
    let (root, _cleanup) = folder();
    let paths: Vec<PathBuf> = (0..=KEPT)
        .map(|at| {
            let path = root.join(format!("{at}.jsonl"));
            append(
                &path,
                &omp_line("user", &format!("file {at} {}", "x".repeat(1_000))),
            );
            path
        })
        .collect();
    let files: Vec<FileSource> = paths.iter().map(|path| omp(path)).collect();
    let transcripts = no_catalog();
    let reads = read_again_in_reverse(&transcripts, &files, || {});
    let (dropped, kept) = reads.split_last().expect("33 reads");
    assert!(kept.iter().all(|read| *read == 2 * TAIL), "{kept:?}");
    assert!(*dropped >= size(&paths[0]), "{dropped}");
}

// The turn starts of a newest page (`liveScans`, `:735`), 32: each file is one turn, so no turn
// settles and the 8 settled turns kept do not count. A file kept reads its appended bytes for the
// two scans and its live turn whole once (omp parses the live turn whole); the file dropped scans
// for its boundary and its turn starts from its beginning too, three times its size in all.
#[test]
fn keeps_32_scans_of_turn_starts() {
    const KEPT: usize = 32;
    let (root, _cleanup) = folder();
    let paths: Vec<PathBuf> = (0..=KEPT)
        .map(|at| {
            let path = root.join(format!("{at}.jsonl"));
            append(&path, &omp_line("user", &format!("file {at}")));
            append(&path, &omp_line("assistant", &"x".repeat(5_000)));
            path
        })
        .collect();
    let files: Vec<FileSource> = paths.iter().map(|path| omp(path)).collect();
    let reply = omp_line("assistant", "more");
    let transcripts = no_catalog();
    let reads = read_again_in_reverse(&transcripts, &files, || {
        for path in &paths {
            append(path, &reply);
        }
    });
    let (dropped, kept) = reads.split_last().expect("33 reads");
    let size = size(&paths[0]);
    let bound = size + 2 * reply.len() as u64 + 6 * TAIL;
    assert!(
        kept.iter().all(|read| *read <= bound),
        "{kept:?}, at most {bound}"
    );
    assert!(*dropped >= 3 * size, "{dropped}");
}

// The settled turns (`settledTurns`, `:817`), 8: files whose settled turns are long and live
// turn short. 9 files keep every scan (32 each), so the file dropped differs by parsing its
// settled turns again.
#[test]
fn keeps_8_settled_turns() {
    const KEPT: usize = 8;
    let (root, _cleanup) = folder();
    let paths: Vec<PathBuf> = (0..=KEPT)
        .map(|at| {
            let path = root.join(format!("{at}.jsonl"));
            long_omp_session(&path);
            path
        })
        .collect();
    let files: Vec<FileSource> = paths.iter().map(|path| omp(path)).collect();
    let reply = omp_line("assistant", "a reply");
    let transcripts = no_catalog();
    let reads = read_again_in_reverse(&transcripts, &files, || {
        for path in &paths {
            append(path, &reply);
        }
    });
    let (dropped, kept) = reads.split_last().expect("9 reads");
    let size = size(&paths[0]);
    let bound = size / 20;
    assert!(
        kept.iter().all(|read| *read <= bound),
        "{kept:?}, at most {bound}"
    );
    assert!(*dropped >= size - bound, "{dropped}");
}

// The parses of a Codex live turn (`codexTurns`, `:777`), 8: a rollout kept reads its appended
// bytes, the one dropped parses its task again.
#[test]
fn keeps_8_codex_live_turns() {
    const KEPT: usize = 8;
    let (root, _cleanup) = folder();
    let paths: Vec<PathBuf> = (0..=KEPT)
        .map(|at| {
            let path = root.join(format!("rollout-{at}.jsonl"));
            long_codex_task(&path, 50);
            path
        })
        .collect();
    let files: Vec<FileSource> = paths.iter().map(|path| codex(&root, path)).collect();
    let line = codex_line("agent_message", "one more step");
    let transcripts = no_catalog();
    let reads = read_again_in_reverse(&transcripts, &files, || {
        for path in &paths {
            append(path, &line);
        }
    });
    let (dropped, kept) = reads.split_last().expect("9 reads");
    let bound = 2 * line.len() as u64 + 4 * TAIL;
    assert!(
        kept.iter().all(|read| *read <= bound),
        "{kept:?}, at most {bound}"
    );
    assert!(*dropped >= size(&paths[0]), "{dropped}");
}

// The parses of Codex live turns read 2 × 16 MB together at most (`:779-783`): of three tasks of
// 11 MB, two are kept.
#[test]
fn keeps_codex_live_turns_that_read_two_windows_together() {
    let (root, _cleanup) = folder();
    let padding = format!(
        "{}\n",
        json!({ "type": "response_item", "payload": { "type": "padding", "text": "z".repeat(1024 * 1024) } })
    );
    let paths: Vec<PathBuf> = (0..3)
        .map(|at| {
            let path = root.join(format!("rollout-{at}.jsonl"));
            append(&path, &codex_line("task_started", ""));
            while size(&path) < 11 * 1024 * 1024 {
                append(&path, &padding);
            }
            path
        })
        .collect();
    assert!(3 * size(&paths[0]) > 2 * WINDOW && 2 * size(&paths[1]) <= 2 * WINDOW);
    let files: Vec<FileSource> = paths.iter().map(|path| codex(&root, path)).collect();
    let line = codex_line("agent_message", "one more step");
    let transcripts = no_catalog();
    let reads = read_again_in_reverse(&transcripts, &files, || {
        for path in &paths {
            append(path, &line);
        }
    });
    let (dropped, kept) = reads.split_last().expect("3 reads");
    let bound = 2 * line.len() as u64 + 4 * TAIL;
    assert!(
        kept.iter().all(|read| *read <= bound),
        "{kept:?}, at most {bound}"
    );
    assert!(*dropped >= size(&paths[0]), "{dropped}");
}

// The files' rewrite generations (`transcriptRevisions`, `:478`), 64: a file rewritten shorter in
// place starts a new generation, and so a new history id, only while its last state is kept; one
// forgotten reads as the first time again.
#[test]
fn keeps_64_rewrite_generations() {
    const KEPT: usize = 64;
    let (root, _cleanup) = folder();
    let paths: Vec<PathBuf> = (0..=KEPT)
        .map(|at| {
            let path = root.join(format!("{at}.jsonl"));
            append(&path, &omp_line("user", &format!("file {at} at length")));
            path
        })
        .collect();
    let transcripts = no_catalog();
    let ids: Vec<String> = paths
        .iter()
        .map(|path| newest(&transcripts, &omp(path)).history_id)
        .collect();
    for path in &paths[..2] {
        // written over in place, shorter: the same inode
        fs::write(path, omp_line("user", "short")).expect("a rewrite");
    }
    assert_ne!(newest(&transcripts, &omp(&paths[1])).history_id, ids[1]);
    assert_eq!(newest(&transcripts, &omp(&paths[0])).history_id, ids[0]);
}
