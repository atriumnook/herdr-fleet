//! The fleet skill's entrances: from `server/fleet/entrances.test.ts`, each test naming its `it`.
//! Every test gives the store a home of its own under the system's temporary folder, so none
//! reads or writes the person's skill folders.

use std::collections::HashMap;
use std::fs;
use std::hash::{BuildHasher, Hasher, RandomState};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use herdr_fleet_orchestrator::entrances::{EntranceDeps, EntranceStore};
use protocol::{EntranceId, EntranceState, FleetAgentKind, FleetEntrance};

/// A new folder no other test uses, removed when the test ends however it ends.
struct Home(PathBuf);

impl Home {
    fn new() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        loop {
            let mut hasher = RandomState::new().build_hasher();
            hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
            let root =
                std::env::temp_dir().join(format!("fleet-entrances-{:016x}", hasher.finish()));
            match fs::create_dir(&root) {
                Ok(()) => return Home(root),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("{}: {error}", root.display()),
            }
        }
    }

    fn store(&self, url: &str, token_required: bool) -> EntranceStore {
        let url = url.to_owned();
        EntranceStore::new(EntranceDeps {
            command: "/usr/bin/bun /opt/herdr-fleet/bin/fleet.ts".into(),
            url: Box::new(move || url.clone()),
            token_required,
            home: self.0.clone(),
        })
    }

    fn skill_file(&self, dir: &[&str]) -> PathBuf {
        let mut file = self.0.clone();
        file.extend(dir);
        file.join("herdr-fleet").join("SKILL.md")
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const URL: &str = "http://127.0.0.1:7317";

fn states(store: &EntranceStore) -> HashMap<EntranceId, EntranceState> {
    store
        .list()
        .unwrap()
        .entrances
        .into_iter()
        .map(|entrance| (entrance.id, entrance.state))
        .collect()
}

fn text(file: &Path) -> String {
    fs::read_to_string(file).unwrap_or_else(|error| panic!("{}: {error}", file.display()))
}

// entrances.test.ts: "are the three folders the five CLIs read, none installed at first"
#[test]
fn are_the_three_folders_the_five_clis_read_none_installed_at_first() {
    let home = Home::new();
    let listed = home.store(URL, false).list().unwrap();
    let path = |dir: &[&str]| home.skill_file(dir).to_string_lossy().into_owned();
    assert_eq!(
        listed.entrances,
        vec![
            FleetEntrance {
                id: EntranceId::Claude,
                file: path(&[".claude", "skills"]),
                readers: vec![FleetAgentKind::Claude, FleetAgentKind::Cursor],
                state: EntranceState::Missing,
            },
            FleetEntrance {
                id: EntranceId::Agents,
                file: path(&[".agents", "skills"]),
                readers: vec![
                    FleetAgentKind::Pi,
                    FleetAgentKind::Codex,
                    FleetAgentKind::Cursor
                ],
                state: EntranceState::Missing,
            },
            FleetEntrance {
                id: EntranceId::Gemini,
                file: path(&[".gemini", "config", "skills"]),
                readers: vec![FleetAgentKind::Agy],
                state: EntranceState::Missing,
            },
        ]
    );
    assert!(!listed.token_required);
    assert!(home.store(URL, true).list().unwrap().token_required);
}

// entrances.test.ts: "write a skill that names the fleet command and this server, and leaves the instructions to fleet guide"
#[test]
fn write_a_skill_that_names_the_fleet_command_and_this_server_and_leaves_the_instructions_to_fleet_guide()
 {
    let home = Home::new();
    let store = home.store(URL, false);
    store.install("agents").unwrap();
    let file = home.skill_file(&[".agents", "skills"]);
    let written = text(&file);
    assert!(
        written.starts_with("---\nname: herdr-fleet\ndescription: "),
        "{written}"
    );
    assert!(
        written.contains("    HERDR_FLEET_URL=http://127.0.0.1:7317 /usr/bin/bun /opt/herdr-fleet/bin/fleet.ts guide\n"),
        "{written}"
    );
    assert!(written.contains("If HERDR_FLEET_RUN is set"), "{written}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // entrances.ts writes with mode 0o644, which the umask may narrow; 022 is the usual one
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }
    assert_eq!(
        states(&store),
        HashMap::from([
            (EntranceId::Claude, EntranceState::Missing),
            (EntranceId::Agents, EntranceState::Installed),
            (EntranceId::Gemini, EntranceState::Missing),
        ])
    );
}

// entrances.test.ts: "say a skill written for another address is outdated, and bring it up to date"
#[test]
fn say_a_skill_written_for_another_address_is_outdated_and_bring_it_up_to_date() {
    let home = Home::new();
    home.store("http://127.0.0.1:7318", false)
        .install("claude")
        .unwrap();
    let now = home.store(URL, false);
    assert_eq!(states(&now)[&EntranceId::Claude], EntranceState::Outdated);
    now.install("claude").unwrap();
    assert_eq!(states(&now)[&EntranceId::Claude], EntranceState::Installed);
    assert!(text(&home.skill_file(&[".claude", "skills"])).contains("127.0.0.1:7317"));
}

// entrances.test.ts: "never overwrite or remove a file the fleet did not write"
#[test]
fn never_overwrite_or_remove_a_file_the_fleet_did_not_write() {
    let home = Home::new();
    let file = home.skill_file(&[".gemini", "config", "skills"]);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, "---\nname: herdr-fleet\ndescription: my own\n---\n").unwrap();
    let store = home.store(URL, false);
    assert_eq!(states(&store)[&EntranceId::Gemini], EntranceState::Taken);
    assert_eq!(store.install("gemini").unwrap_err().code, "entrance_taken");
    assert_eq!(store.remove("gemini").unwrap_err().code, "entrance_taken");
    assert!(text(&file).contains("my own"));
}

// entrances.test.ts: "remove the skill and its folder, but keep the person's files beside it"
#[test]
fn remove_the_skill_and_its_folder_but_keep_the_persons_files_beside_it() {
    let home = Home::new();
    let store = home.store(URL, false);
    store.install("claude").unwrap();
    store.remove("claude").unwrap();
    assert!(!home.0.join(".claude/skills/herdr-fleet").exists());
    assert!(home.0.join(".claude/skills").exists());
    store.install("agents").unwrap();
    fs::write(home.0.join(".agents/skills/herdr-fleet/notes.md"), "mine").unwrap();
    store.remove("agents").unwrap();
    assert!(!home.skill_file(&[".agents", "skills"]).exists());
    assert_eq!(
        text(&home.0.join(".agents/skills/herdr-fleet/notes.md")),
        "mine"
    );
    // removing one that is not there changes nothing
    let after = store.remove("gemini").unwrap();
    let gemini = after
        .entrances
        .iter()
        .find(|entrance| entrance.id == EntranceId::Gemini)
        .unwrap();
    assert_eq!(gemini.state, EntranceState::Missing);
}

// entrances.test.ts: "refuse a folder they do not know"
#[test]
fn refuse_a_folder_they_do_not_know() {
    let home = Home::new();
    assert_eq!(
        home.store(URL, false)
            .install("../../etc")
            .unwrap_err()
            .code,
        "unknown_entrance"
    );
}

// Not in entrances.test.ts: the skill is byte for byte what TypeScript writes, so a skill the
// TypeScript server installed reads as installed. The expected text is TypeScript's output:
// `new EntranceStore({ command: "C", url: () => "U", tokenRequired: false, home: "/h" }).skill()`.
#[test]
fn writes_the_skill_typescript_writes() {
    let store = EntranceStore::new(EntranceDeps {
        command: "C".into(),
        url: Box::new(|| "U".into()),
        token_required: false,
        home: "/h".into(),
    });
    assert_eq!(
        store.skill(),
        "---\nname: herdr-fleet\ndescription: Hand work in this repository to herdr-fleet, or check on work handed to it. Use when the person says to ask, hand or delegate something to the fleet (for example 「fleet に頼んで」), or asks how the fleet's threads are going.\n---\n<!-- herdr-fleet entrance: written by herdr-fleet's Settings page, which updates and removes it -->\n\nIf HERDR_FLEET_RUN is set, you are one of the fleet's own agents: do not use this skill.\n\nRun this, and follow what it prints:\n\n    HERDR_FLEET_URL=U C guide\n"
    );
}

// Review regression (/code-review high on d5da038): TypeScript's `install` is synchronous, so two
// requests never interleave, but the server calls `EntranceStore` from several threads at once.
// With a temporary file named by the process id alone, two installs of one entrance wrote the same
// temporary file and the second `rename` failed. Both installs must succeed, as two TypeScript
// requests in a row do.
#[test]
fn installs_one_entrance_from_two_threads_at_once() {
    let home = Home::new();
    let store = home.store(URL, false);
    for _ in 0..200 {
        let barrier = std::sync::Barrier::new(2);
        let results: Vec<_> = std::thread::scope(|scope| {
            let threads: Vec<_> = (0..2)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        store.install("claude").map(|_| ())
                    })
                })
                .collect();
            threads
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .collect()
        });
        for result in results {
            assert!(
                result.is_ok(),
                "{:?}",
                result.err().map(|error| error.message)
            );
        }
    }
    assert_eq!(
        states(&store)[&EntranceId::Claude],
        EntranceState::Installed
    );
}
