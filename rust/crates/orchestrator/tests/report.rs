//! report.json, read as a turn's report (`server/fleet/report.ts`). The four tests are
//! `server/fleet/report.test.ts`'s, with its expected values; the last two are this crate's own.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use herdr_fleet_orchestrator::report::{REPORT_MAX_BYTES, read_report};
use protocol::{ReportState, RunReport, TurnOutcome};
use serde_json::json;

/// A folder of its own under the system's temporary folder, removed when dropped.
struct Folder(PathBuf);

impl Folder {
    fn new() -> Folder {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "fleet-report-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Folder(path)
    }

    fn with(content: &str) -> Folder {
        let folder = Folder::new();
        fs::write(folder.0.join("report.json"), content).unwrap();
        folder
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn read(content: &str) -> TurnOutcome {
    read_report(Folder::with(content).path())
}

fn none(problem: &str) -> TurnOutcome {
    TurnOutcome::NoReport {
        problem: problem.to_owned(),
    }
}

fn report(
    state: ReportState,
    summary: &str,
    evidence: &[&str],
    human_action: Option<&str>,
) -> TurnOutcome {
    TurnOutcome::Report(RunReport {
        state,
        summary: summary.to_owned(),
        evidence: evidence.iter().map(|item| (*item).to_owned()).collect(),
        human_action: human_action.map(str::to_owned),
    })
}

// server/fleet/report.test.ts: "is read as the turn's report: its state, summary, evidence and the
// question for the person"
#[test]
fn is_read_as_the_turns_report() {
    let content = json!({ "state": "blocked", "summary": "Keep the old retry API?", "evidence": ["bun test: 12 pass"], "human_action": "Keep the old retry API, or drop it?" });
    assert_eq!(
        read(&content.to_string()),
        report(
            ReportState::Blocked,
            "Keep the old retry API?",
            &["bun test: 12 pass"],
            Some("Keep the old retry API, or drop it?")
        )
    );
}

// server/fleet/report.test.ts: "takes evidence written as one string, and no question when there
// is none"
#[test]
fn takes_evidence_written_as_one_string_and_no_question_when_there_is_none() {
    let one = json!({ "state": "ready", "summary": "Fixed.", "evidence": "bun test: 3 pass", "human_action": null });
    assert_eq!(
        read(&one.to_string()),
        report(ReportState::Ready, "Fixed.", &["bun test: 3 pass"], None)
    );
    let empty = json!({ "state": "dropped", "summary": "Does not reproduce.", "evidence": [] });
    assert_eq!(
        read(&empty.to_string()),
        report(ReportState::Dropped, "Does not reproduce.", &[], None)
    );
}

// server/fleet/report.test.ts: "is no report, with why, when it is missing or does not say a known
// state, a summary and evidence"
#[test]
fn is_no_report_with_why_when_it_is_missing_or_does_not_say_a_known_state_a_summary_and_evidence() {
    assert_eq!(
        read_report(Folder::new().path()),
        none("report.json is missing.")
    );
    assert_eq!(read("PASS — all good"), none("report.json is not JSON."));
    assert_eq!(read("[]"), none("report.json is not a JSON object."));
    assert_eq!(
        read(&json!({ "state": "PASS", "summary": "s", "evidence": [] }).to_string()),
        none(
            r#"report.json has state "PASS"; it must be one of progress, waiting, ready, blocked, failed, dropped."#
        )
    );
    assert_eq!(
        read(&json!({ "state": "ready", "summary": " ", "evidence": [] }).to_string()),
        none("report.json has no summary.")
    );
    assert_eq!(
        read(&json!({ "state": "ready", "summary": "s" }).to_string()),
        none("report.json has no evidence: a string or a list of strings.")
    );
    assert_eq!(
        read(&json!({ "state": "ready", "summary": "s", "evidence": [1] }).to_string()),
        none("report.json has no evidence: a string or a list of strings.")
    );
    assert_eq!(
        read(
            &json!({ "state": "blocked", "summary": "s", "evidence": [], "human_action": 3 })
                .to_string()
        ),
        none("report.json has a human_action that is not a string.")
    );
}

// server/fleet/report.test.ts: "is never read through a symlink, nor past its size limit"
#[cfg(unix)]
#[test]
fn is_never_read_through_a_symlink_nor_past_its_size_limit() {
    let dir = Folder::new();
    let secret = dir.path().join("secret.json");
    fs::write(
        &secret,
        json!({ "state": "ready", "summary": "s", "evidence": [] }).to_string(),
    )
    .unwrap();
    std::os::unix::fs::symlink(&secret, dir.path().join("report.json")).unwrap();
    assert_eq!(
        read_report(dir.path()),
        none("report.json is not a regular file.")
    );
    let big = json!({ "state": "ready", "summary": "x".repeat(REPORT_MAX_BYTES), "evidence": [] });
    assert_eq!(
        read(&big.to_string()),
        none("report.json is larger than 16384 bytes.")
    );
}

// This crate's own: a file of exactly the limit is read (16,384 bytes, counted by hand: the JSON
// around the summary is 47 bytes), one byte more is not; report.ts read the first under bun 1.4.4.
#[test]
fn reads_a_file_of_exactly_its_size_limit() {
    let wrapper = r#"{"state":"ready","summary":"","evidence":["e"]}"#;
    assert_eq!(wrapper.len(), 47);
    let at_limit = format!(
        r#"{{"state":"ready","summary":"{}","evidence":["e"]}}"#,
        "x".repeat(16_384 - 47)
    );
    assert_eq!(at_limit.len(), 16_384);
    assert!(matches!(read(&at_limit), TurnOutcome::Report(_)));
    let over = format!(
        r#"{{"state":"ready","summary":"{}","evidence":["e"]}}"#,
        "x".repeat(16_384 - 46)
    );
    assert_eq!(read(&over), none("report.json is larger than 16384 bytes."));
}

// This crate's own: a summary and a question are trimmed as JavaScript's `trim` does (U+FEFF is
// whitespace there), evidence is kept as written, and a blank question is none; report.ts answered
// the same for this file under bun 1.4.4.
#[test]
fn trims_the_summary_and_the_question_as_javascript_does() {
    let content = json!({ "state": "waiting", "summary": "\u{feff} Waiting on #244 \n", "evidence": [" as written "], "human_action": "  " });
    assert_eq!(
        read(&content.to_string()),
        report(
            ReportState::Waiting,
            "Waiting on #244",
            &[" as written "],
            None
        )
    );
}

// This crate's own: an unknown state is quoted as `JSON.stringify` writes it. The expected values
// are what server/fleet/report.ts answered for these files under bun 1.4.4.
#[test]
fn quotes_an_unknown_state_as_javascript_writes_it() {
    let tail = "; it must be one of progress, waiting, ready, blocked, failed, dropped.";
    for (state, quoted) in [
        ("3", "3"),
        ("1.5", "1.5"),
        ("1e21", "1e+21"),
        ("true", "true"),
        (r#"{"a":[1,"b"]}"#, r#"{"a":[1,"b"]}"#),
        ("null", "null"),
    ] {
        let content = format!(r#"{{"state":{state},"summary":"s","evidence":[]}}"#);
        assert_eq!(
            read(&content),
            none(&format!("report.json has state {quoted}{tail}")),
            "{state}"
        );
    }
    assert_eq!(
        read(r#"{"summary":"s","evidence":[]}"#),
        none(&format!("report.json has state null{tail}"))
    );
}

// This crate's own: a folder in report.json's place, and a FIFO, are not regular files; reading the
// FIFO does not wait for a writer (`O_NONBLOCK`, as report.ts opens it); report.ts answered the same
// for both under bun 1.4.4.
#[cfg(unix)]
#[test]
fn is_no_report_from_a_folder_or_a_fifo() {
    let dir = Folder::new();
    fs::create_dir(dir.path().join("report.json")).unwrap();
    assert_eq!(
        read_report(dir.path()),
        none("report.json is not a regular file.")
    );
    let fifo = Folder::new();
    let made = std::process::Command::new("mkfifo")
        .arg(fifo.path().join("report.json"))
        .status()
        .unwrap();
    assert!(made.success());
    assert_eq!(
        read_report(fifo.path()),
        none("report.json is not a regular file.")
    );
}
