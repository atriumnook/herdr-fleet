//! The fleet skill in the folders agent CLIs read skills from; from `server/fleet/entrances.ts`.
//!
//! The skill makes an agent in a pane's conversation hand work to the project's coordinator
//! (`fleet project`). The file names only the fleet command and this server's address; the
//! instructions come from `fleet guide`, so they match the herdr-fleet that runs. A file the fleet
//! did not write is never overwritten or removed.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use protocol::{EntranceId, EntranceState, FleetAgentKind, FleetEntrance, FleetEntrances};

use crate::FleetError;

const SKILL: &str = "herdr-fleet";
/// How the fleet knows the file as its own.
const MARK: &str = "<!-- herdr-fleet entrance: written by herdr-fleet's Settings page, which updates and removes it -->";

/// Each folder, and the CLIs that read it (Claude Code, Cursor, pi, Codex and agy each document theirs).
const FOLDERS: [(EntranceId, &str, &[&str], &[FleetAgentKind]); 3] = [
    (
        EntranceId::Claude,
        "claude",
        &[".claude", "skills"],
        &[FleetAgentKind::Claude, FleetAgentKind::Cursor],
    ),
    (
        EntranceId::Agents,
        "agents",
        &[".agents", "skills"],
        &[
            FleetAgentKind::Pi,
            FleetAgentKind::Codex,
            FleetAgentKind::Cursor,
        ],
    ),
    (
        EntranceId::Gemini,
        "gemini",
        &[".gemini", "config", "skills"],
        &[FleetAgentKind::Agy],
    ),
];

/// What the store needs from the server.
pub struct EntranceDeps {
    /// The fleet command, as agents the fleet starts are given it.
    pub command: String,
    /// This server's address.
    pub url: Box<dyn Fn() -> String + Send + Sync>,
    /// The server wants a token.
    pub token_required: bool,
    /// Whose skill folders: the person's home, which the caller names (a test names its own).
    pub home: PathBuf,
}

/// Lists, installs and removes the fleet skill in the skill folders under `home`.
///
/// Errors: `unknown_entrance` for an id it does not know, `entrance_taken` when a file the fleet
/// did not write is there, `entrance_unreadable` when the file cannot be read, and
/// `internal_error` when a folder or file cannot be written or removed (TypeScript throws the
/// file system's own error there, which `/api/fleet` answers as `internal_error`, `api.ts:309`).
pub struct EntranceStore {
    deps: EntranceDeps,
}

impl EntranceStore {
    pub fn new(deps: EntranceDeps) -> Self {
        EntranceStore { deps }
    }

    /// The skill as the fleet writes it now.
    pub fn skill(&self) -> String {
        [
            "---".to_owned(),
            format!("name: {SKILL}"),
            "description: Hand work in this repository to herdr-fleet, or check on work handed to it. Use when the person says to ask, hand or delegate something to the fleet (for example 「fleet に頼んで」), or asks how the fleet's threads are going.".to_owned(),
            "---".to_owned(),
            MARK.to_owned(),
            String::new(),
            "If HERDR_FLEET_RUN is set, you are one of the fleet's own agents: do not use this skill.".to_owned(),
            String::new(),
            "Run this, and follow what it prints:".to_owned(),
            String::new(),
            format!("    HERDR_FLEET_URL={} {} guide", (self.deps.url)(), self.deps.command),
            String::new(),
        ]
        .join("\n")
    }

    pub fn list(&self) -> Result<FleetEntrances, FleetError> {
        let skill = self.skill();
        let entrances = FOLDERS
            .iter()
            .map(|&(id, name, _, readers)| {
                let file = self.file(name)?;
                let state = match read(&file)? {
                    None => EntranceState::Missing,
                    Some(text) if text == skill => EntranceState::Installed,
                    Some(text) if text.contains(MARK) => EntranceState::Outdated,
                    Some(_) => EntranceState::Taken,
                };
                Ok(FleetEntrance {
                    id,
                    file: file.to_string_lossy().into_owned(),
                    readers: readers.to_vec(),
                    state,
                })
            })
            .collect::<Result<_, FleetError>>()?;
        Ok(FleetEntrances {
            entrances,
            token_required: self.deps.token_required,
        })
    }

    /// Writes the skill into `id`'s folder; one the fleet wrote before is brought up to date.
    pub fn install(&self, id: &str) -> Result<FleetEntrances, FleetError> {
        let file = self.owned(id)?;
        let folder = file.parent().unwrap_or(&file);
        fs::create_dir_all(folder).map_err(|error| unwritable(folder, &error))?;
        // the process id keeps two processes apart, the count two threads of this one (TypeScript's
        // `install` is synchronous, so its `<file>.<pid>.tmp` never meets another call's)
        static COUNT: AtomicU64 = AtomicU64::new(0);
        let count = COUNT.fetch_add(1, Ordering::Relaxed);
        let temp = PathBuf::from(format!(
            "{}.{}.{count}.tmp",
            file.display(),
            std::process::id()
        ));
        write_new(&temp, self.skill().as_bytes()).map_err(|error| unwritable(&temp, &error))?;
        fs::rename(&temp, &file).map_err(|error| unwritable(&file, &error))?;
        self.list()
    }

    /// Removes the skill from `id`'s folder, and its folder when nothing else is in it.
    pub fn remove(&self, id: &str) -> Result<FleetEntrances, FleetError> {
        let file = self.owned(id)?;
        match fs::remove_file(&file) {
            Err(error) if error.kind() != ErrorKind::NotFound => {
                return Err(unwritable(&file, &error));
            }
            _ => {}
        }
        if let Some(folder) = file.parent() {
            // the person keeps files of their own there when it is not empty
            let _ = fs::remove_dir(folder);
        }
        self.list()
    }

    fn file(&self, id: &str) -> Result<PathBuf, FleetError> {
        let (_, _, dir, _) = FOLDERS
            .iter()
            .find(|(_, name, _, _)| *name == id)
            .ok_or_else(|| {
                FleetError::new("unknown_entrance", format!("Unknown entrance: {id}"))
            })?;
        let mut file = self.deps.home.clone();
        file.extend(dir.iter());
        Ok(file.join(SKILL).join("SKILL.md"))
    }

    /// `id`'s file, refused when a file the fleet did not write is there.
    fn owned(&self, id: &str) -> Result<PathBuf, FleetError> {
        let file = self.file(id)?;
        if read(&file)?.is_some_and(|text| !text.contains(MARK)) {
            return Err(FleetError::new(
                "entrance_taken",
                format!(
                    "{} was not written by herdr-fleet. Move it away by hand first.",
                    file.display()
                ),
            ));
        }
        Ok(file)
    }
}

/// The file's text, or none when it is not there. Bytes that are not UTF-8 read as U+FFFD, as
/// Node's `readFileSync(file, "utf8")` reads them.
fn read(file: &Path) -> Result<Option<String>, FleetError> {
    match fs::read(file) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(FleetError::new(
            "entrance_unreadable",
            format!("Cannot read {}: {error}", file.display()),
        )),
    }
}

/// Writes a new file with mode 0644 (less the umask), as `writeFileSync(…, { mode: 0o644 })`.
fn write_new(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o644);
    options.open(file)?.write_all(bytes)
}

fn unwritable(path: &Path, error: &std::io::Error) -> FleetError {
    FleetError::new("internal_error", format!("{}: {error}", path.display()))
}
