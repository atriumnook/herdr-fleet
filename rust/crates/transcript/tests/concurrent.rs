//! Regression checks for Issue #219 through the public paging interface.
// Tests write isolated temporary transcript files (ADR 0110, tests-only exception).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::fs::{self, File, FileTimes, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Barrier, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, SystemTime};

use herdr_fleet_transcript::{ConversationError, FileSource, PageRequest, Transcripts};

/// One test at a time: the eight readers keep the CPUs busy, and the append that the first test
/// publishes a few milliseconds late must still land inside the reader's wait.
fn alone() -> MutexGuard<'static, ()> {
    static ONE: Mutex<()> = Mutex::new(());
    ONE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "herdr-fleet-rs-219-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&dir).unwrap();
        Self(dir)
    }

    fn source(&self) -> FileSource {
        FileSource::Claude(self.0.join("session.jsonl"))
    }

    fn write(&self, contents: &str) {
        fs::write(self.0.join("session.jsonl"), contents).unwrap();
    }

    /// Sets the modification time `seconds` past the epoch, the bytes left as they are.
    fn touch(&self, seconds: u64) {
        File::open(self.0.join("session.jsonl"))
            .unwrap()
            .set_times(
                FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)),
            )
            .unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn user(n: usize) -> String {
    format!("{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"prompt {n}\"}}}}\n")
}

fn contents() -> String {
    (0..80).map(user).collect()
}

#[test]
fn an_append_seen_by_its_times_before_its_size_keeps_history_and_cursors() {
    let _alone = alone();
    let fixture = Fixture::new();
    fixture.write(&contents());
    let transcripts = Transcripts::new(Box::new(|_, _| None));
    let source = fixture.source();
    let before = transcripts.page(&source, &PageRequest::default()).unwrap();
    let request = PageRequest {
        before: Some(before.cursor.clone().expect("80 prompts span pages")),
        ..PageRequest::default()
    };
    let older = transcripts.page(&source, &request).unwrap();
    // Issue #219: Linux sets a write's times before its size. New times on the same bytes, with
    // the size published a few milliseconds later, stand for that stat without relying on the
    // scheduler to land between the two.
    fixture.touch(1);
    let during = thread::scope(|scope| {
        scope.spawn(|| {
            thread::sleep(Duration::from_millis(5));
            OpenOptions::new()
                .append(true)
                .open(fixture.0.join("session.jsonl"))
                .unwrap()
                .write_all(user(80).as_bytes())
                .unwrap();
        });
        transcripts.page(&source, &PageRequest::default()).unwrap()
    });
    assert_eq!(during.history_id, before.history_id);
    assert_eq!(
        transcripts.page(&source, &request).unwrap().turns,
        older.turns
    );
    assert_eq!(
        transcripts
            .page(&source, &PageRequest::default())
            .unwrap()
            .history_id,
        before.history_id
    );
}

#[test]
fn rewrites_truncation_and_replacement_still_invalidate_cursors() {
    let _alone = alone();
    // "touch": new times on the same bytes, and no append after them, as a same-size rewrite
    // that keeps the bytes before the end looks (fixtures/conversations/codex/growing-task)
    for change in ["rewrite", "touch", "truncate", "replace"] {
        let fixture = Fixture::new();
        let contents = contents();
        fixture.write(&contents);
        fixture.touch(1);
        let transcripts = Transcripts::new(Box::new(|_, _| None));
        let source = fixture.source();
        let before = transcripts.page(&source, &PageRequest::default()).unwrap();
        match change {
            "rewrite" => fixture.write(&contents.replace("prompt 79", "change 79")),
            "touch" => fixture.touch(2),
            "truncate" => fixture.write(&user(0)),
            "replace" => {
                let replacement = fixture.0.join("new.jsonl");
                fs::write(&replacement, contents).unwrap();
                fs::rename(replacement, fixture.0.join("session.jsonl")).unwrap();
            }
            _ => unreachable!(),
        }
        assert_ne!(
            transcripts
                .page(&source, &PageRequest::default())
                .unwrap()
                .history_id,
            before.history_id,
            "{change}"
        );
        let request = PageRequest {
            before: Some(before.cursor.expect("80 prompts span pages")),
            ..PageRequest::default()
        };
        assert!(
            matches!(
                transcripts.page(&source, &request),
                Err(ConversationError::HistoryChanged)
            ),
            "{change}"
        );
    }
}

#[test]
fn eight_readers_share_history_while_a_writer_appends() {
    let _alone = alone();
    let fixture = Fixture::new();
    fixture.write(&contents());
    let transcripts = Transcripts::new(Box::new(|_, _| None));
    let source = fixture.source();
    let initial = transcripts.page(&source, &PageRequest::default()).unwrap();
    let request = PageRequest {
        before: Some(initial.cursor.clone().expect("80 prompts span pages")),
        ..PageRequest::default()
    };
    let older = transcripts.page(&source, &request).unwrap();
    let barrier = Barrier::new(9);
    thread::scope(|scope| {
        scope.spawn(|| {
            let mut writer = OpenOptions::new()
                .append(true)
                .open(fixture.0.join("session.jsonl"))
                .unwrap();
            barrier.wait();
            for n in 80..240 {
                // Split records expose partially appended lines as well as size changes.
                for chunk in user(n).as_bytes().chunks(7) {
                    writer.write_all(chunk).unwrap();
                    thread::yield_now();
                }
            }
        });
        for _ in 0..8 {
            let transcripts = &transcripts;
            let source = &source;
            let initial = &initial;
            let request = &request;
            let older = &older;
            let barrier = &barrier;
            scope.spawn(move || {
                barrier.wait();
                for _ in 0..80 {
                    let page = transcripts.page(source, &PageRequest::default()).unwrap();
                    assert_eq!(page.history_id, initial.history_id);
                    assert_eq!(
                        transcripts.page(source, request).unwrap().turns,
                        older.turns
                    );
                    thread::yield_now();
                }
            });
        }
    });
    assert_eq!(
        transcripts
            .page(&source, &PageRequest::default())
            .unwrap()
            .history_id,
        initial.history_id
    );
}
