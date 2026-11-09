//! `RunRegistry`, the one owner of the runs; from `server/fleet/registry.ts`.
//!
//! The runs sit behind one `std::sync::Mutex`: a read returns a copy, and a run changes only inside
//! [`RunRegistry::update`], which saves the runs before it returns (ADR 0242-phase-3-split, "orchestrator
//! の状態の持ち方"). The lock is never held across an await: the closure is synchronous, and a
//! caller reads the run again by id after each await.

use std::fs::{self, OpenOptions};
use std::hash::{BuildHasher as _, Hasher as _, RandomState};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use protocol::{AgentRun, js};
use serde_json::Value;

use crate::Clock;

/// Runs not touched for this long are dropped when the registry loads: their callers are long gone.
pub const STALE_RUN_MS: i64 = 7 * 24 * 3_600_000;

/// A new run's id: 8 hexadecimal digits (registry.ts: `randomBytes(4)`).
pub fn make_id() -> String {
    format!("{:08x}", random_u32())
}

/// A new fleet's group: `fleet-` and 8 hexadecimal digits.
pub fn make_group_id() -> String {
    format!("fleet-{:08x}", random_u32())
}

/// 32 random bits from std's `RandomState`, whose keys come from the operating system's random
/// source once per thread and change with each `RandomState::new` (std's `std::random` is not
/// stable in this toolchain, ADR 0244-phase-3-dependencies). The counter makes each hash's input
/// differ too.
fn random_u32() -> u32 {
    static CALLS: AtomicU64 = AtomicU64::new(0);
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(CALLS.fetch_add(1, Ordering::Relaxed));
    let hash = hasher.finish();
    // the high and low halves folded together; truncating to 32 bits is the point
    #[expect(
        clippy::cast_possible_truncation,
        reason = "32 of the hash's 64 bits are wanted"
    )]
    let bits = (hash ^ (hash >> 32)) as u32;
    bits
}

/// registry.ts's `slug`: lower case, each run of characters other than `a-z0-9_-` one `-`, no `-`
/// at either end, a letter first, at most `max` characters.
fn slug(value: &str, max: usize) -> String {
    let mut normalized = String::new();
    let mut in_run = false;
    for c in value.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' {
            normalized.push(c);
            in_run = false;
        } else if !in_run {
            normalized.push('-');
            in_run = true;
        }
    }
    let normalized = normalized.trim_matches('-');
    let safe = if normalized.starts_with(|c: char| c.is_ascii_lowercase()) {
        normalized.to_owned()
    } else if normalized.is_empty() {
        "a-agent".to_owned()
    } else {
        format!("a-{normalized}")
    };
    // `safe` is ASCII by now, so a byte is a character
    let cut = safe[..safe.len().min(max)].trim_end_matches('-');
    if cut.is_empty() {
        "agent".to_owned()
    } else {
        cut.to_owned()
    }
}

/// herdr's agent name for a run: short, unique per run, and readable in herdr's own UI.
pub fn make_herdr_name(group: &str, role: &str, id: &str) -> String {
    let group = match group.strip_prefix("fleet-") {
        Some(rest) => format!("f{rest}"),
        None => group.to_owned(),
    };
    slug(
        &format!("{group}-{}-{}", slug(role, 12), js::cut_utf16(id, 4)),
        32,
    )
}

/// One entry of the file, in the order the runs were first added.
enum Entry {
    Run(Box<AgentRun>),
    /// An entry with a string `id` and `paneId` that this crate cannot read as an [`AgentRun`]
    /// (registry.ts keeps every such entry): kept as it was and written back, so no run is lost, but
    /// not listed. The week-old rule drops it like any run.
    Unread {
        id: String,
        value: Value,
    },
}

impl Entry {
    fn id(&self) -> &str {
        match self {
            Entry::Run(run) => &run.id,
            Entry::Unread { id, .. } => id,
        }
    }
}

/// Every run this server started, kept across restarts in one JSON file (0600). The last turn's
/// output and result are not kept in it: they are the bulk of a record, the file is rewritten on
/// every change, and herdr and the run's result file have them again.
pub struct RunRegistry {
    file: Option<PathBuf>,
    entries: Mutex<Vec<Entry>>,
}

impl RunRegistry {
    /// The runs `file` holds, but those not touched for [`STALE_RUN_MS`] by `clock`; none without
    /// a file, or from one that is missing or not a JSON array.
    pub fn open(file: Option<PathBuf>, clock: &dyn Clock) -> Self {
        let mut entries = Vec::new();
        if let Some(stored) = file.as_deref().and_then(read_array) {
            let now = clock.now_ms();
            for value in stored {
                let Some(id) = value.get("id").and_then(Value::as_str).map(str::to_owned) else {
                    continue;
                };
                if !value.get("paneId").is_some_and(Value::is_string) || stale(&value, now) {
                    continue;
                }
                let entry = match serde_json::from_value::<AgentRun>(value.clone()) {
                    Ok(run) => Entry::Run(Box::new(run)),
                    Err(_) => Entry::Unread { id, value },
                };
                set(&mut entries, entry);
            }
        }
        RunRegistry {
            file,
            entries: Mutex::new(entries),
        }
    }

    /// The file the runs are kept in.
    pub fn file(&self) -> Option<&Path> {
        self.file.as_deref()
    }

    /// Every run, in the order they were first added.
    pub fn all(&self) -> Vec<AgentRun> {
        self.lock().iter().filter_map(run_of).cloned().collect()
    }

    /// The run `id`.
    pub fn get(&self, id: &str) -> Option<AgentRun> {
        self.lock()
            .iter()
            .filter_map(run_of)
            .find(|run| run.id == id)
            .cloned()
    }

    /// The run in `pane_id` updated last; of two updated at once, the one added first.
    pub fn by_pane(&self, pane_id: &str) -> Option<AgentRun> {
        let entries = self.lock();
        let runs = entries
            .iter()
            .filter_map(run_of)
            .filter(|run| run.pane_id == pane_id);
        newest(runs, |run| run.updated_at).cloned()
    }

    /// A run by id, name, role, herdr name or pane, compared without case, the one started last
    /// first; within `group` when one is given.
    pub fn resolve(&self, target: &str, group: Option<&str>) -> Option<AgentRun> {
        let lowered = target.to_lowercase();
        let entries = self.lock();
        let runs = entries
            .iter()
            .filter_map(run_of)
            .filter(|run| group.is_none_or(|group| run.group == group))
            .filter(|run| {
                [&run.id, &run.name, &run.role, &run.herdr_name, &run.pane_id]
                    .iter()
                    .any(|key| key.to_lowercase() == lowered)
            });
        newest(runs, |run| run.started_at).cloned()
    }

    /// Adds `run`, in place of one with the same id, and saves the runs. When the file cannot be
    /// written the run stays added in memory, as registry.ts's `upsert` leaves it, and the error is
    /// returned.
    pub fn insert(&self, run: AgentRun) -> io::Result<()> {
        let mut entries = self.lock();
        set(&mut entries, Entry::Run(Box::new(run)));
        self.save(&entries)
    }

    /// Changes the run `id` with `change` and saves the runs; `None` when there is no such run.
    /// `change` must keep the run's id. When the file cannot be written the change stays in memory
    /// and the error is returned.
    pub fn update<T>(
        &self,
        id: &str,
        change: impl FnOnce(&mut AgentRun) -> T,
    ) -> io::Result<Option<T>> {
        let mut entries = self.lock();
        let Some(run) = entries.iter_mut().find_map(|entry| match entry {
            Entry::Run(run) if run.id == id => Some(run),
            _ => None,
        }) else {
            return Ok(None);
        };
        let answer = change(run);
        debug_assert_eq!(run.id, id, "update changed a run's id");
        self.save(&entries)?;
        Ok(Some(answer))
    }

    fn lock(&self) -> MutexGuard<'_, Vec<Entry>> {
        // a closure that panicked left the runs as they were at the panic; they are still the runs
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn save(&self, entries: &[Entry]) -> io::Result<()> {
        let Some(file) = &self.file else {
            return Ok(());
        };
        let stored = entries
            .iter()
            .map(|entry| match entry {
                Entry::Run(run) => serde_json::to_value(AgentRun {
                    last_output: None,
                    result: None,
                    ..AgentRun::clone(run)
                }),
                Entry::Unread { value, .. } => Ok(value.clone()),
            })
            .collect::<Result<Vec<_>, _>>()?;
        write_whole(file, serde_json::to_string(&stored)?.as_bytes())
    }
}

fn run_of(entry: &Entry) -> Option<&AgentRun> {
    match entry {
        Entry::Run(run) => Some(run),
        Entry::Unread { .. } => None,
    }
}

/// `entry` in place of the one with its id, or after the others: a JavaScript `Map`'s `set`.
fn set(entries: &mut Vec<Entry>, entry: Entry) {
    match entries.iter_mut().find(|each| each.id() == entry.id()) {
        Some(each) => *each = entry,
        None => entries.push(entry),
    }
}

/// The run with the greatest `key`; of equals, the first: what `sort((a, b) => key(b) - key(a))[0]`
/// gives, JavaScript's sort being stable.
fn newest<'a>(
    runs: impl Iterator<Item = &'a AgentRun>,
    key: impl Fn(&AgentRun) -> i64,
) -> Option<&'a AgentRun> {
    runs.fold(None, |best: Option<&AgentRun>, run| match best {
        Some(best) if key(best) >= key(run) => Some(best),
        _ => Some(run),
    })
}

/// registry.ts's `now - (run.updatedAt ?? 0) > STALE_RUN_MS`. An `updatedAt` that is not a number
/// makes JavaScript's subtraction NaN, which is never greater: the run is kept.
fn stale(value: &Value, now: i64) -> bool {
    let updated = match value.get("updatedAt") {
        None | Some(Value::Null) => 0.0,
        Some(Value::Number(number)) => number.as_f64().unwrap_or(0.0),
        Some(_) => return false,
    };
    #[expect(clippy::cast_precision_loss, reason = "JavaScript's numbers are f64")]
    let (now, limit) = (now as f64, STALE_RUN_MS as f64);
    now - updated > limit
}

/// The JSON array in `file`; none when it is missing, unreadable, or holds anything else. Bytes
/// that are not UTF-8 read as U+FFFD, as `readFileSync(…, "utf8")` reads them.
fn read_array(file: &Path) -> Option<Vec<Value>> {
    let bytes = fs::read(file).ok()?;
    match serde_json::from_str(&String::from_utf8_lossy(&bytes)) {
        Ok(Value::Array(values)) => Some(values),
        _ => None,
    }
}

/// Writes `bytes` to `file` whole: into `<file>.<pid>.tmp` (0600), renamed over `file`, in a folder
/// made private to the user (0700) when it is missing. The registry and the outbox save this way.
pub(crate) fn write_whole(file: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(folder) = file.parent() {
        create_private_folder(folder)?;
    }
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(format!(".{}.tmp", std::process::id()));
    let tmp = PathBuf::from(tmp);
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(&tmp)?.write_all(bytes)?;
    // the mode above applies only to a file it creates, and through the umask
    #[cfg(unix)]
    fs::set_permissions(&tmp, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    fs::rename(&tmp, file)
}

/// `folder` and the folders above it that are missing, made private to the user (0700), as
/// `mkdirSync(folder, { recursive: true, mode: 0o700 })` makes them.
pub(crate) fn create_private_folder(folder: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(folder)
}
