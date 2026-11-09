//! The fleet's runs, kept across restarts (`server/fleet/registry.ts`). TypeScript tests the
//! registry only through the orchestrator (`orchestrator.test.ts`, describe "registry"); its
//! behaviour here is checked against what registry.ts wrote and answered under bun 1.4.4.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use herdr_fleet_orchestrator::Clock;
use herdr_fleet_orchestrator::registry::{
    RunRegistry, STALE_RUN_MS, make_group_id, make_herdr_name, make_id,
};
use protocol::{AgentRun, AgentState, FleetAgentKind, LandAction, ThinkingLevel, TurnOutcome};
use serde_json::{Value, json};

/// A folder of its own under the system's temporary folder, removed when dropped.
struct Folder(PathBuf);

impl Folder {
    fn new() -> Folder {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "fleet-registry-{}-{}",
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

/// A clock that stays at one time.
struct FixedClock(i64);

impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

/// 2026-11-01T00:01:00Z: the time the runs below were last updated.
const NOW: i64 = 1_793_491_260_000;

/// What registry.ts wrote to fleet-runs.json for two runs upserted in this order; the first was
/// given `lastOutput: "screen text"` and `result: "HANDOFF\nPASS"`, which it leaves out.
const TYPESCRIPT_RUNS: &str = r##"[{"id":"1a2b3c4d","name":"#249 run records","role":"lead","agent":"claude","group":"fleet-6fcaf0a1","herdrName":"f6fcaf0a1-lead-1a2b","paneId":"w1:p2","workspaceId":"w1","cwd":"/repo/.herdr-fleet/worktrees/1a2b3c4d","model":"opus","thinking":"high","state":"working","depth":1,"interactive":true,"worktree":true,"startedAt":1793491200000,"updatedAt":1793491260000,"lastError":"Agent started but is not ready for prompts; the task has not been sent.","outcome":{"report":null,"problem":"report.json is missing."},"branch":"fleet/1a2b3c4d","project":"/repo","owner":"c0ffee00","write":["/repo/rust/a.rs"],"avoid":["codex"],"skipped":[{"candidate":"codex:gpt-5","reason":"rate limited"}],"landing":{"action":"merge","at":1793491250000,"sent":true}},{"id":"c0ffee00","name":"coordinator","role":"coordinator","agent":"codex","group":"fleet-6fcaf0a1","herdrName":"f6fcaf0a1-coordinat-c0ff","paneId":"w1:p1","cwd":"/repo","state":"idle","depth":0,"interactive":true,"worktree":false,"startedAt":1793491100000,"updatedAt":1793491150000,"outcome":{"report":{"state":"ready","summary":"Done.","evidence":["cargo test: ok"]}}}]"##;

fn open(file: &Path, now: i64) -> RunRegistry {
    RunRegistry::open(Some(file.to_path_buf()), &FixedClock(now))
}

fn stored(file: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap()
}

fn typescript_file(root: &Folder) -> PathBuf {
    let file = root.path().join("fleet-runs.json");
    fs::write(&file, TYPESCRIPT_RUNS).unwrap();
    file
}

fn run(id: &str, pane: &str) -> AgentRun {
    serde_json::from_value(json!({
        "id": id, "name": format!("name-{id}"), "role": "worker", "agent": "pi", "group": "g1",
        "herdrName": format!("herdr-{id}"), "paneId": pane, "cwd": "/repo", "state": "working",
        "depth": 1, "interactive": false, "worktree": false, "startedAt": NOW, "updatedAt": NOW
    }))
    .unwrap()
}

#[test]
fn reads_the_runs_typescript_wrote() {
    let root = Folder::new();
    let registry = open(&typescript_file(&root), NOW);
    let ids: Vec<String> = registry.all().into_iter().map(|run| run.id).collect();
    assert_eq!(ids, ["1a2b3c4d", "c0ffee00"]);
    let lead = registry.get("1a2b3c4d").unwrap();
    assert_eq!(lead.agent, FleetAgentKind::Claude);
    assert_eq!(lead.thinking, Some(ThinkingLevel::High));
    assert_eq!(lead.state, AgentState::Working);
    assert_eq!(lead.updated_at, 1_793_491_260_000);
    assert_eq!(lead.avoid, Some(vec![FleetAgentKind::Codex]));
    assert_eq!(lead.landing.as_ref().unwrap().action, LandAction::Merge);
    assert_eq!(
        lead.outcome,
        Some(TurnOutcome::NoReport {
            problem: "report.json is missing.".into()
        })
    );
    assert_eq!(lead.last_output, None);
    let coordinator = registry.get("c0ffee00").unwrap();
    assert_eq!(
        coordinator.outcome.unwrap().report().unwrap().summary,
        "Done."
    );
}

#[test]
fn writes_the_runs_as_typescript_does() {
    let root = Folder::new();
    let file = typescript_file(&root);
    let registry = open(&file, NOW);
    assert_eq!(registry.update("c0ffee00", |_| ()).unwrap(), Some(()));
    assert_eq!(
        stored(&file),
        serde_json::from_str::<Value>(TYPESCRIPT_RUNS).unwrap()
    );
}

// orchestrator.test.ts, describe "registry": "keeps runs across a restart without their output, and
// drops week-old ones" (the registry's part of it)
#[test]
fn keeps_runs_across_a_restart_without_their_output_and_result() {
    let root = Folder::new();
    let file = root.path().join("state").join("fleet-runs.json");
    let registry = open(&file, NOW);
    let mut first = run("r1", "w1:p1");
    first.last_output = Some("screen text".into());
    first.result = Some("HANDOFF\nPASS".into());
    registry.insert(first).unwrap();
    // in memory the run keeps them, as TypeScript's object does
    assert_eq!(
        registry.get("r1").unwrap().result.as_deref(),
        Some("HANDOFF\nPASS")
    );
    let reloaded = open(&file, NOW);
    let kept = reloaded.get("r1").unwrap();
    assert_eq!(kept.state, AgentState::Working);
    assert_eq!(kept.last_output, None);
    assert_eq!(kept.result, None);
    let written = stored(&file);
    assert_eq!(written[0].get("lastOutput"), None);
    assert_eq!(written[0].get("result"), None);
}

// orchestrator.test.ts, describe "registry": the week-old part. The boundary follows registry.ts's
// `now - updatedAt > STALE_RUN_MS`, with `updatedAt ?? 0` for a run without one.
#[test]
fn drops_runs_not_updated_for_a_week_when_it_loads() {
    let root = Folder::new();
    let file = typescript_file(&root);
    // 7 days, worked out by hand: 7 × 24 × 3,600,000 ms
    assert_eq!(STALE_RUN_MS, 604_800_000);
    // the coordinator was updated at 1793491150000, the lead at 1793491260000
    let ids = |now: i64| -> Vec<String> {
        open(&file, now)
            .all()
            .into_iter()
            .map(|run| run.id)
            .collect()
    };
    assert_eq!(
        ids(1_793_491_150_000 + 604_800_000),
        ["1a2b3c4d", "c0ffee00"]
    );
    assert_eq!(ids(1_793_491_150_000 + 604_800_001), ["1a2b3c4d"]);
    assert!(ids(NOW + 8 * 24 * 3_600_000).is_empty());
    let mut no_time = serde_json::to_value(run("r1", "w1:p1")).unwrap();
    no_time.as_object_mut().unwrap().remove("updatedAt");
    fs::write(&file, json!([no_time]).to_string()).unwrap();
    assert!(ids(NOW).is_empty());
}

// Review N1: bun's registry.ts kept only "abc" from these malformed timestamps. Rust deliberately
// retains every non-numeric timestamp as an unread entry, rather than guessing when it happened.
#[test]
fn preserves_unread_runs_with_non_numeric_timestamps() {
    let root = Folder::new();
    let file = root.path().join("fleet-runs.json");
    fs::write(
        &file,
        r#"[{"id":"s1","paneId":"p1","updatedAt":"100"},{"id":"s2","paneId":"p2","updatedAt":true},{"id":"s3","paneId":"p3","updatedAt":""},{"id":"s4","paneId":"p4","updatedAt":[]},{"id":"s5","paneId":"p5","updatedAt":"abc"}]"#,
    )
    .unwrap();
    let registry = open(&file, 10 * STALE_RUN_MS);
    assert!(registry.all().is_empty());
    registry.insert(run("witness", "p6")).unwrap();
    let written = stored(&file);
    let ids: Vec<&str> = written
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["s1", "s2", "s3", "s4", "s5", "witness"]);
    assert_eq!(written[0]["updatedAt"], json!("100"));
    assert_eq!(written[1]["updatedAt"], json!(true));
    assert_eq!(written[2]["updatedAt"], json!(""));
    assert_eq!(written[3]["updatedAt"], json!([]));
    assert_eq!(written[4]["updatedAt"], json!("abc"));
}

// #249's single owner keeps a run's identity even if an update accidentally assigns another id.
#[test]
fn keeps_a_runs_identity_when_an_update_changes_its_id() {
    let root = Folder::new();
    let file = root.path().join("fleet-runs.json");
    let registry = open(&file, NOW);
    registry.insert(run("r1", "p1")).unwrap();
    registry.insert(run("r2", "p2")).unwrap();
    registry
        .update("r1", |run| {
            run.id = "r2".into();
            run.state = AgentState::Idle;
        })
        .unwrap();
    assert_eq!(registry.get("r1").unwrap().state, AgentState::Idle);
    assert_eq!(registry.get("r2").unwrap().state, AgentState::Working);
    let reloaded = open(&file, NOW);
    assert_eq!(reloaded.all().len(), 2);
    assert_eq!(reloaded.get("r1").unwrap().state, AgentState::Idle);
    assert_eq!(reloaded.get("r2").unwrap().state, AgentState::Working);
}

#[test]
fn starts_empty_from_a_missing_unreadable_or_odd_file() {
    let root = Folder::new();
    assert!(open(&root.path().join("none.json"), NOW).all().is_empty());
    assert!(RunRegistry::open(None, &FixedClock(NOW)).all().is_empty());
    let file = root.path().join("fleet-runs.json");
    for content in ["not json", "{}", "null", "[1, \"x\", null]"] {
        fs::write(&file, content).unwrap();
        assert!(open(&file, NOW).all().is_empty(), "{content}");
    }
}

// registry.ts keeps every stored entry whose `id` and `paneId` are strings. One this crate cannot
// read as an AgentRun (here an agent kind it does not know) is not listed, but stays in the file,
// so no run is lost; the week-old rule still drops it.
#[test]
fn keeps_a_run_it_cannot_read_in_the_file_without_listing_it() {
    let root = Folder::new();
    let file = root.path().join("fleet-runs.json");
    let mut unknown = serde_json::to_value(run("r2", "w1:p2")).unwrap();
    unknown["agent"] = json!("gemini");
    let no_pane = json!({ "id": "r3", "updatedAt": NOW });
    fs::write(
        &file,
        json!([
            serde_json::to_value(run("r1", "w1:p1")).unwrap(),
            unknown,
            no_pane
        ])
        .to_string(),
    )
    .unwrap();
    let registry = open(&file, NOW);
    let ids: Vec<String> = registry.all().into_iter().map(|run| run.id).collect();
    assert_eq!(ids, ["r1"]);
    assert_eq!(registry.get("r2"), None);
    registry.update("r1", |run| run.depth = 2).unwrap();
    let written = stored(&file);
    assert_eq!(written.as_array().unwrap().len(), 2);
    assert_eq!(written[0]["depth"], 2);
    assert_eq!(written[1], unknown);
    // a new run of the same id takes its place
    registry.insert(run("r2", "w1:p2")).unwrap();
    let written = stored(&file);
    assert_eq!(written.as_array().unwrap().len(), 2);
    assert_eq!(written[1]["agent"], "pi");
    // a week later it goes, as every run does
    assert!(open(&file, NOW + STALE_RUN_MS + 1).all().is_empty());
}

#[test]
fn changes_a_run_only_through_update_and_saves_each_change() {
    let root = Folder::new();
    let file = root.path().join("fleet-runs.json");
    let registry = open(&file, NOW);
    registry.insert(run("r1", "w1:p1")).unwrap();
    // what a read returns is a copy
    let mut copy = registry.get("r1").unwrap();
    copy.state = AgentState::Failed;
    assert_eq!(registry.get("r1").unwrap().state, AgentState::Working);
    let answer = registry
        .update("r1", |run| {
            run.state = AgentState::Idle;
            run.updated_at = NOW + 1;
            "changed"
        })
        .unwrap();
    assert_eq!(answer, Some("changed"));
    assert_eq!(stored(&file)[0]["state"], "idle");
    assert_eq!(open(&file, NOW).get("r1").unwrap().updated_at, NOW + 1);
    assert_eq!(registry.update("none", |_| ()).unwrap(), None);
}

#[test]
fn replaces_a_run_inserted_again_in_its_place() {
    let root = Folder::new();
    let registry = open(&root.path().join("fleet-runs.json"), NOW);
    registry.insert(run("r1", "w1:p1")).unwrap();
    registry.insert(run("r2", "w1:p2")).unwrap();
    let mut again = run("r1", "w1:p9");
    again.depth = 3;
    registry.insert(again).unwrap();
    let all = registry.all();
    assert_eq!(
        all.iter().map(|run| run.id.as_str()).collect::<Vec<_>>(),
        ["r1", "r2"]
    );
    assert_eq!(all[0].pane_id, "w1:p9");
}

#[test]
fn applies_changes_from_many_threads_one_at_a_time() {
    let root = Folder::new();
    let file = root.path().join("fleet-runs.json");
    let registry = Arc::new(open(&file, NOW));
    registry.insert(run("r1", "w1:p1")).unwrap();
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let registry = Arc::clone(&registry);
            std::thread::spawn(move || {
                for _ in 0..25 {
                    registry.update("r1", |run| run.depth += 1).unwrap();
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    // 1 + 8 × 25
    assert_eq!(registry.get("r1").unwrap().depth, 201);
    assert_eq!(stored(&file)[0]["depth"], 201);
}

#[cfg(unix)]
#[test]
fn writes_its_file_whole_renamed_into_place_0600_in_a_0700_folder() {
    use std::os::unix::fs::PermissionsExt as _;
    let root = Folder::new();
    let folder = root.path().join("state");
    let file = folder.join("fleet-runs.json");
    open(&file, NOW).insert(run("r1", "w1:p1")).unwrap();
    let names: Vec<String> = fs::read_dir(&folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names, ["fleet-runs.json"]);
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&file), 0o600);
    assert_eq!(mode(&folder), 0o700);
}

#[test]
fn says_when_it_cannot_save_and_keeps_the_change_in_memory() {
    let root = Folder::new();
    fs::write(root.path().join("not-a-folder"), "").unwrap();
    let registry = open(
        &root.path().join("not-a-folder").join("fleet-runs.json"),
        NOW,
    );
    // registry.ts sets the run, then its persist throws
    assert!(registry.insert(run("r1", "w1:p1")).is_err());
    assert!(registry.get("r1").is_some());
    assert!(registry.update("r1", |run| run.depth = 4).is_err());
    assert_eq!(registry.get("r1").unwrap().depth, 4);
}

#[test]
fn keeps_runs_in_memory_alone_without_a_file() {
    let registry = RunRegistry::open(None, &FixedClock(NOW));
    registry.insert(run("r1", "w1:p1")).unwrap();
    registry.update("r1", |run| run.depth = 2).unwrap();
    assert_eq!(registry.get("r1").unwrap().depth, 2);
    assert_eq!(registry.file(), None);
}

#[test]
fn finds_the_run_in_a_pane_updated_last() {
    let registry = RunRegistry::open(None, &FixedClock(NOW));
    let mut older = run("r1", "w1:p1");
    older.updated_at = NOW - 10;
    registry.insert(older).unwrap();
    registry.insert(run("r2", "w1:p1")).unwrap();
    // a tie goes to the run added first, as JavaScript's stable sort leaves it
    registry.insert(run("r3", "w1:p1")).unwrap();
    registry.insert(run("r4", "w1:p2")).unwrap();
    assert_eq!(registry.by_pane("w1:p1").unwrap().id, "r2");
    assert_eq!(registry.by_pane("w1:p2").unwrap().id, "r4");
    assert_eq!(registry.by_pane("w9:p9"), None);
}

#[test]
fn resolves_a_target_by_id_name_role_herdr_name_or_pane_the_newest_first() {
    let registry = RunRegistry::open(None, &FixedClock(NOW));
    let mut first = run("r1", "w1:p1");
    first.name = "Reviewer".into();
    first.started_at = NOW - 10;
    registry.insert(first).unwrap();
    let mut second = run("r2", "w1:p2");
    second.group = "g2".into();
    registry.insert(second).unwrap();
    let resolved =
        |target: &str, group: Option<&str>| registry.resolve(target, group).map(|run| run.id);
    assert_eq!(resolved("R1", None).as_deref(), Some("r1"));
    assert_eq!(resolved("reviewer", None).as_deref(), Some("r1"));
    assert_eq!(resolved("HERDR-r2", None).as_deref(), Some("r2"));
    assert_eq!(resolved("w1:p1", None).as_deref(), Some("r1"));
    // both are workers: the one started last
    assert_eq!(resolved("worker", None).as_deref(), Some("r2"));
    assert_eq!(resolved("worker", Some("g1")).as_deref(), Some("r1"));
    assert_eq!(resolved("r2", Some("g1")), None);
    assert_eq!(resolved("nobody", None), None);
}

// The names are what registry.ts's makeHerdrName answered for the same arguments.
#[test]
fn names_a_run_for_herdr_as_typescript_does() {
    for (group, role, id, name) in [
        ("fleet-6fcaf0a1", "lead", "1a2b3c4d", "f6fcaf0a1-lead-1a2b"),
        (
            "fleet-6fcaf0a1",
            "coordinator",
            "c0ffee00",
            "f6fcaf0a1-coordinator-c0ff",
        ),
        (
            "Fleet-XY",
            "Code Reviewer!!",
            "9f8e7d6c",
            "fleet-xy-code-reviewe-9f8e",
        ),
        ("fleet-0123", "---", "abcd", "f0123-a-agent-abcd"),
        (
            "fleet-abcdefgh",
            "a-very-long-role-name-here",
            "12345678",
            "fabcdefgh-a-very-long-1234",
        ),
        ("123", "9lives", "ab", "a-123-a-9lives-ab"),
        ("fleet-ü", "Ünïcode", "dead", "f--n-code-dead"),
    ] {
        assert_eq!(
            make_herdr_name(group, role, id),
            name,
            "{group} {role} {id}"
        );
    }
}

#[test]
fn makes_ids_of_eight_hexadecimal_digits_that_differ() {
    let hex =
        |text: &str| text.len() == 8 && text.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'));
    let ids: Vec<String> = (0..100).map(|_| make_id()).collect();
    assert!(ids.iter().all(|id| hex(id)), "{ids:?}");
    let mut distinct = ids.clone();
    distinct.sort();
    distinct.dedup();
    assert_eq!(distinct.len(), ids.len());
    let group = make_group_id();
    assert!(
        group.starts_with("fleet-") && hex(&group["fleet-".len()..]),
        "{group}"
    );
}
