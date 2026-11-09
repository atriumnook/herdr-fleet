//! The fleet's outbox of notices to its agents (`server/fleet/outbox.ts`). The twelve tests named
//! after an `it` are `server/fleet/outbox.test.ts`'s, with its expected values; the rest are this
//! crate's own.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};

use herdr_fleet_orchestrator::Clock;
use herdr_fleet_orchestrator::outbox::{Notice, NoticeInput, Outbox, message};
use serde_json::{Value, json};

/// A folder of its own under the system's temporary folder, removed when dropped.
struct Folder(PathBuf);

impl Folder {
    fn new() -> Folder {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "fleet-outbox-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Folder(path)
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

/// A clock that reads what the test set.
struct TestClock(AtomicI64);

impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::Relaxed)
    }
}

fn clock() -> Arc<TestClock> {
    // 2026-11-01T00:00:00Z
    Arc::new(TestClock(AtomicI64::new(1_793_491_200_000)))
}

fn open(file: &Path) -> Outbox {
    Outbox::open(Some(file.to_path_buf()), clock()).unwrap()
}

fn notice(about: &str, slot: &str, section: &str, text: &str) -> NoticeInput {
    NoticeInput {
        about: about.to_owned(),
        slot: slot.to_owned(),
        section: section.to_owned(),
        text: text.to_owned(),
        landing_at: None,
    }
}

fn step(about: &str, text: &str, landing_at: i64) -> NoticeInput {
    NoticeInput {
        landing_at: Some(landing_at),
        ..notice(about, "landing", "steps", text)
    }
}

fn headers() -> HashMap<&'static str, &'static str> {
    HashMap::from([("news", "[fleet] News:"), ("steps", "[fleet] Steps:")])
}

fn texts(outbox: &Outbox) -> Vec<String> {
    outbox
        .pending()
        .into_iter()
        .map(|notice| notice.text)
        .collect()
}

// server/fleet/outbox.test.ts: "keeps queued notices across a restart and delivers each once, in
// the order written"
#[tokio::test]
async fn keeps_queued_notices_across_a_restart_and_delivers_each_once_in_the_order_written() {
    let root = Folder::new();
    let file = root.path().join("state").join("fleet-outbox.json");
    let before = open(&file);
    before
        .put(notice("t2", "news", "news", "Two asks"))
        .unwrap();
    before
        .put(notice("t1", "news", "news", "One asks"))
        .unwrap();
    before.put(step("t1", "Merge One", 7)).unwrap();
    before
        .put(notice("t3", "news", "news", "Three ended"))
        .unwrap();
    let after = open(&file);
    assert_eq!(
        texts(&after),
        ["Two asks", "One asks", "Merge One", "Three ended"]
    );
    let mut sent = Vec::new();
    let delivered = after
        .deliver(&after.pending(), &headers(), |text| {
            sent.push(text);
            async { true }
        })
        .await
        .unwrap();
    assert!(delivered);
    assert_eq!(
        sent,
        [
            "[fleet] News:\n- Two asks\n- One asks\n[fleet] Steps:\n- Merge One\n[fleet] News:\n- Three ended"
        ]
    );
    assert!(texts(&after).is_empty());
    assert!(texts(&open(&file)).is_empty());
}

// server/fleet/outbox.test.ts: "keeps the notices of a message that was not typed for the next one"
#[tokio::test]
async fn keeps_the_notices_of_a_message_that_was_not_typed_for_the_next_one() {
    let root = Folder::new();
    let file = root.path().join("fleet-outbox.json");
    let outbox = open(&file);
    outbox
        .put(notice("t1", "news", "news", "One asks"))
        .unwrap();
    let delivered = outbox
        .deliver(&outbox.pending(), &headers(), |_| async { false })
        .await
        .unwrap();
    assert!(!delivered);
    assert_eq!(texts(&open(&file)), ["One asks"]);
}

// server/fleet/outbox.test.ts: "sends a notice written while a message went out with the next one"
#[tokio::test]
async fn sends_a_notice_written_while_a_message_went_out_with_the_next_one() {
    let root = Folder::new();
    let file = root.path().join("fleet-outbox.json");
    let outbox = open(&file);
    outbox
        .put(notice("t1", "news", "news", "One asks"))
        .unwrap();
    outbox
        .deliver(&outbox.pending(), &headers(), |_| {
            outbox
                .put(notice("t1", "news", "news", "One asks again"))
                .unwrap();
            outbox
                .put(notice("t2", "news", "news", "Two asks"))
                .unwrap();
            async { true }
        })
        .await
        .unwrap();
    assert_eq!(texts(&open(&file)), ["One asks again", "Two asks"]);
}

// server/fleet/outbox.test.ts: "puts a run's newer notice of a slot in place of one not yet
// delivered, after the others, and drops one no longer news"
#[test]
fn puts_a_runs_newer_notice_of_a_slot_in_place_of_one_not_yet_delivered_and_drops_one_no_longer_news()
 {
    let root = Folder::new();
    let file = root.path().join("fleet-outbox.json");
    let outbox = open(&file);
    outbox
        .put(notice("t1", "news", "news", "One asks"))
        .unwrap();
    outbox
        .put(notice("t2", "news", "news", "Two asks"))
        .unwrap();
    outbox
        .put(notice("t1", "landing", "steps", "Merge One"))
        .unwrap();
    outbox
        .put(notice("t1", "news", "news", "One merged"))
        .unwrap();
    assert_eq!(texts(&outbox), ["Two asks", "Merge One", "One merged"]);
    outbox.discard("t2", "news").unwrap();
    assert_eq!(texts(&open(&file)), ["Merge One", "One merged"]);
    assert!(outbox.holds("t1"));
    assert!(!outbox.holds("t2"));
}

// server/fleet/outbox.test.ts: "hands a run's notices to the run that took over, in their place, so
// a newer one of theirs replaces them"
#[test]
fn hands_a_runs_notices_to_the_run_that_took_over_in_their_place() {
    let root = Folder::new();
    let file = root.path().join("fleet-outbox.json");
    let outbox = open(&file);
    outbox.put(step("t1", "Merge One", 7)).unwrap();
    outbox
        .put(notice("t2", "news", "news", "Two asks"))
        .unwrap();
    outbox.move_notices("t1", "t1b").unwrap();
    let held: Vec<(String, String)> = open(&file)
        .pending()
        .into_iter()
        .map(|notice| (notice.about, notice.text))
        .collect();
    assert_eq!(
        held,
        [
            ("t1b".to_owned(), "Merge One".to_owned()),
            ("t2".to_owned(), "Two asks".to_owned())
        ]
    );
    outbox.put(step("t1b", "Merge PR One", 7)).unwrap();
    assert_eq!(texts(&open(&file)), ["Two asks", "Merge PR One"]);
}

// server/fleet/outbox.test.ts: "drops the queued notices a prune turns down, on disk too"
#[test]
fn drops_the_queued_notices_a_prune_turns_down_on_disk_too() {
    let root = Folder::new();
    let file = root.path().join("fleet-outbox.json");
    let outbox = open(&file);
    outbox
        .put(notice("gone", "news", "news", "Gone asks"))
        .unwrap();
    outbox
        .put(notice("t1", "news", "news", "One asks"))
        .unwrap();
    outbox.prune(|notice| notice.about != "gone").unwrap();
    assert_eq!(texts(&open(&file)), ["One asks"]);
}

// server/fleet/outbox.test.ts: "writes a notice sent now before it is typed, removes it after, and
// drops one a crash left behind on load". TypeScript's send that throws is a send whose value is an
// error here: send_now hands it back, and the notice is gone either way.
#[tokio::test]
async fn writes_a_notice_sent_now_before_it_is_typed_removes_it_after_and_drops_one_a_crash_left_behind()
 {
    let root = Folder::new();
    let file = root.path().join("fleet-outbox.json");
    let crashed = root.path().join("crashed.json");
    let outbox = open(&file);
    outbox
        .put(notice("t1", "news", "news", "One asks"))
        .unwrap();
    let mut typed = String::new();
    let told = outbox
        .send_now("lead", "Merge main into the branch", |text| {
            typed = text;
            // the server dies here: what the file holds while the text is typed
            fs::copy(&file, &crashed).unwrap();
            async { true }
        })
        .await
        .unwrap();
    assert!(told);
    assert_eq!(typed, "Merge main into the branch");
    assert!(
        fs::read_to_string(&crashed)
            .unwrap()
            .contains("Merge main into the branch")
    );
    assert!(
        !fs::read_to_string(&file)
            .unwrap()
            .contains("Merge main into the branch")
    );
    // after the crash: the queued notice stays, the press the person saw fail does not go out later
    let restarted = open(&crashed);
    assert_eq!(texts(&restarted), ["One asks"]);
    assert!(
        !fs::read_to_string(&crashed)
            .unwrap()
            .contains("Merge main into the branch")
    );
    // a refused or failed send leaves nothing behind either
    let refused = outbox
        .send_now("lead", "Fix CI", |_| async { false })
        .await
        .unwrap();
    assert!(!refused);
    let failed: Result<bool, &str> = outbox
        .send_now("lead", "Fix CI", |_| async { Err("pane gone") })
        .await
        .unwrap();
    assert_eq!(failed, Err("pane gone"));
    assert!(!fs::read_to_string(&file).unwrap().contains("Fix CI"));
}

// server/fleet/outbox.test.ts: "writes its file whole: renamed into place, 0600, no temp file left"
#[test]
fn writes_its_file_whole_renamed_into_place_0600_no_temp_file_left() {
    let root = Folder::new();
    let file = root.path().join("fleet-outbox.json");
    open(&file)
        .put(notice("t1", "news", "news", "One asks"))
        .unwrap();
    let names: Vec<String> = fs::read_dir(root.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names, ["fleet-outbox.json"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let stored: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(stored[0]["about"], "t1");
    assert_eq!(stored[0]["text"], "One asks");
    assert_eq!(stored[0]["seq"], 1);
}

// server/fleet/outbox.test.ts: "numbers notices after the highest kept, so ones written after a
// restart go out after"
#[test]
fn numbers_notices_after_the_highest_kept_so_ones_written_after_a_restart_go_out_after() {
    let root = Folder::new();
    let file = root.path().join("fleet-outbox.json");
    let before = open(&file);
    before
        .put(notice("t1", "news", "news", "One asks"))
        .unwrap();
    before
        .put(notice("t2", "news", "news", "Two asks"))
        .unwrap();
    before.discard("t1", "news").unwrap();
    let after = open(&file);
    after
        .put(notice("t3", "news", "news", "Three asks"))
        .unwrap();
    let numbered: Vec<(String, u64)> = after
        .pending()
        .into_iter()
        .map(|notice| (notice.text, notice.seq))
        .collect();
    assert_eq!(
        numbered,
        [("Two asks".to_owned(), 2), ("Three asks".to_owned(), 3)]
    );
}

// server/fleet/outbox.test.ts: "sends nothing the file did not take"
#[tokio::test]
async fn sends_nothing_the_file_did_not_take() {
    let root = Folder::new();
    fs::write(root.path().join("not-a-folder"), "").unwrap();
    let outbox = open(&root.path().join("not-a-folder").join("fleet-outbox.json"));
    assert!(
        outbox
            .put(notice("t1", "news", "news", "One asks"))
            .is_err()
    );
    assert!(texts(&outbox).is_empty());
    let mut sent = false;
    let result = outbox
        .send_now("lead", "Fix CI", |_| {
            sent = true;
            async { true }
        })
        .await;
    assert!(result.is_err());
    assert!(!sent);
}

// server/fleet/outbox.test.ts: "starts empty from a missing or unreadable file"
#[test]
fn starts_empty_from_a_missing_or_unreadable_file() {
    let root = Folder::new();
    assert!(texts(&open(&root.path().join("none.json"))).is_empty());
    assert!(texts(&Outbox::open(None, clock()).unwrap()).is_empty());
}

// server/fleet/outbox.test.ts: describe "message", "lists each notice under its section's header,
// again when the section changes"
#[test]
fn lists_each_notice_under_its_sections_header_again_when_the_section_changes() {
    let at = 0;
    let notices = [
        Notice {
            seq: 1,
            at,
            about: "a".into(),
            slot: "news".into(),
            section: "news".into(),
            text: "A".into(),
            landing_at: None,
        },
        Notice {
            seq: 2,
            at,
            about: "b".into(),
            slot: "landing".into(),
            section: "steps".into(),
            text: "B".into(),
            landing_at: None,
        },
    ];
    assert_eq!(
        message(&notices, &headers()),
        "[fleet] News:\n- A\n[fleet] Steps:\n- B"
    );
}

// This crate's own: the file holds the shape server/fleet/outbox.ts writes, so either reads the
// other's. The expected JSON is what outbox.ts wrote for these notices under bun 1.4.4, with
// `Date.now()` returning 1793491200000.
#[test]
fn writes_and_reads_the_file_typescript_writes() {
    let root = Folder::new();
    let file = root.path().join("fleet-outbox.json");
    let outbox = open(&file);
    outbox
        .put(notice("t1", "news", "news", "One asks"))
        .unwrap();
    outbox.put(step("t2", "Merge Two", 7)).unwrap();
    let written = r#"[{"about":"t1","slot":"news","section":"news","text":"One asks","seq":1,"at":1793491200000},{"about":"t2","slot":"landing","section":"steps","text":"Merge Two","landingAt":7,"seq":2,"at":1793491200000}]"#;
    assert_eq!(fs::read_to_string(&file).unwrap(), written);
    let other = root.path().join("written-by-typescript.json");
    fs::write(&other, written).unwrap();
    let read = open(&other).pending();
    assert_eq!(read, open(&file).pending());
    assert_eq!(read[1].landing_at, Some(7));
}

// This crate's own: a notice sent now that a crash left behind holds the shape outbox.ts writes
// for one (`{seq, at, to, text, now: true}`), and such entries and ones without a number or a text
// are dropped on load, the file rewritten without them; the next number follows the highest of
// every valid entry, the dropped notice sent now among them (outbox.ts: `Math.max(0, ...valid.map(…))`).
#[test]
fn drops_entries_sent_now_and_invalid_ones_on_load() {
    let root = Folder::new();
    let file = root.path().join("fleet-outbox.json");
    let stored = json!([
        { "about": "t1", "slot": "news", "section": "news", "text": "One asks", "seq": 4, "at": 1 },
        { "seq": 9, "at": 2, "to": "lead", "text": "Fix CI", "now": true },
        { "about": "t2", "slot": "news", "section": "news", "seq": 5, "at": 3 },
        { "about": "t3", "slot": "news", "section": "news", "text": "Three asks", "seq": 2, "at": 4 },
        "not an entry"
    ]);
    fs::write(&file, stored.to_string()).unwrap();
    let outbox = open(&file);
    assert_eq!(texts(&outbox), ["Three asks", "One asks"]);
    let kept: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(
        kept,
        json!([
            { "about": "t3", "slot": "news", "section": "news", "text": "Three asks", "seq": 2, "at": 4 },
            { "about": "t1", "slot": "news", "section": "news", "text": "One asks", "seq": 4, "at": 1 }
        ])
    );
    assert_eq!(
        outbox
            .put(notice("t4", "news", "news", "Four asks"))
            .unwrap()
            .seq,
        10
    );
}

// This crate's own: a notice's time is the clock's when it is put.
#[test]
fn stamps_a_notice_with_the_clocks_time() {
    let root = Folder::new();
    let time = clock();
    let outbox = Outbox::open(Some(root.path().join("fleet-outbox.json")), time.clone()).unwrap();
    assert_eq!(
        outbox.put(notice("t1", "news", "news", "One")).unwrap().at,
        1_793_491_200_000
    );
    time.0.store(1_793_491_260_000, Ordering::Relaxed);
    assert_eq!(
        outbox.put(notice("t2", "news", "news", "Two")).unwrap().at,
        1_793_491_260_000
    );
}

// This crate's own: a send that is cancelled (its future dropped while the text is typed) removes
// the notice sent now, as TypeScript's `finally` does for a send that throws.
#[tokio::test]
async fn removes_a_notice_sent_now_whose_send_was_cancelled() {
    let root = Folder::new();
    let file = root.path().join("fleet-outbox.json");
    let outbox = open(&file);
    let sending = outbox.send_now("lead", "Fix CI", |_| std::future::pending::<bool>());
    let cancelled = tokio::time::timeout(std::time::Duration::from_millis(10), sending).await;
    assert!(cancelled.is_err());
    assert!(!fs::read_to_string(&file).unwrap().contains("Fix CI"));
}
