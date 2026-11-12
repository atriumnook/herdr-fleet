//! The orchestrator: starts agents in herdr panes and follows each delegated turn until it settles;
//! from `server/fleet/orchestrator.ts`. herdr's status events are wake-ups only: the state acted on
//! is always read back from herdr first, so a replayed or reordered event cannot move a run
//! backwards.
//!
//! How it holds its state (ADR 0242-phase-3-split, "orchestrator の状態の持ち方"; ADR
//! 0256-orchestrator-foundation):
//!
//! - [`Orchestrator`] is a handle over `Arc<Inner>` that clones cheaply; every method takes `&self`,
//!   and work that outlives a call (a settle check, a wake-up from herdr) runs in a task of its own
//!   on a clone.
//! - The runs belong to the [`RunRegistry`] (L5) alone. Reading one gives a copy; changing one goes
//!   through `Orchestrator::change` (a new run through `Orchestrator::insert`), TypeScript's `save`:
//!   it saves the run, records a change of its state as an event and tells the server. A cluster
//!   never calls `RunRegistry::update` or `insert` itself, or the event is lost. No lock is held
//!   across an await, so a copy read before an await may be stale after it: **after every await,
//!   read the run again by its id** before deciding on it. TypeScript changed one shared object in
//!   place, saw another task's change after an await without reading again, and saved it once at
//!   the end of a settlement; here each hook saves its own change.
//! - The server runs on tokio's multi-thread runtime, the tests on a current-thread one. Where
//!   TypeScript checks something and acts on it with no await between (no turn in flight, then send
//!   one), the check and the act happen under the owning cluster's lock, never on two sides of it:
//!   the tests cannot show where another worker would have run in between.
//! - The state a run has only while this server runs is split by the cluster of work that owns it:
//!   each file of this folder (spawn, turns, candidates, threads, projects, notices, plans, landing,
//!   restart, autonomy) defines its own `State`, held in `Inner` behind a `std::sync::Mutex` that is
//!   never held across an await.
//! - The turn's settlement (`turns.rs`: `reconcile_run`, `finalize`) is written once and calls the
//!   other clusters through hooks with their final signatures. A cluster whose issue has not landed
//!   yet has hooks that do nothing and return a default; each is marked `// stub: #<issue>`. A hook
//!   TypeScript calls without awaiting (`void this.deliverNotices(...)`) runs in a task of its own:
//!   awaited inside a settlement, it would wait for the run lock its caller holds.
//! - Locks: [`KeyedSerial`] runs work one at a time per key (a run's settlement, a thread's landing
//!   steps and restarts, a project's coordinator start); the spawn gate keeps the budget check and a
//!   run's first save one step; timers are tasks whose `AbortHandle`s `stop` aborts.
//! - Cancelling: a method that starts agents takes a `CancellationToken`. A spawn cancelled after
//!   its pane exists closes the pane before it returns (`abandon_spawn`), so a caller must not drop
//!   the future to cancel: `/api/fleet` runs it in a task of its own and cancels the token when the
//!   request goes away.

mod autonomy;
mod candidates;
mod landing;
mod notices;
mod plans;
mod projects;
mod restart;
mod spawn;
mod threads;
mod turns;

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::future::Future;
use std::hash::Hash;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use protocol::{AgentRun, AgentState, DiffStat, FleetAgentKind, UsageReading};
use tokio::task::AbortHandle;
use tokio_util::sync::CancellationToken;

use crate::Clock;
use crate::agents::AgentDefinition;
use crate::config::FleetConfig;
use crate::error::FleetError;
use crate::events::{FleetEvent, StateEvent};
use crate::github::{GhError, PullRequestReading};
use crate::launch::Host;
use crate::outbox::Outbox;
use crate::registry::RunRegistry;
use crate::runtime::{AgentRuntime, RuntimeError};
use crate::thread::{BranchState, DiffText, RemoveOptions, SetupOutcome};

pub use autonomy::MergeSeen;
pub use candidates::apply_model_policy;
pub use landing::GitLanding;
pub use spawn::SpawnRequest;
pub use threads::ThreadRequest;
pub use turns::{RESULT_MAX_BYTES, read_result};

/// A boxed future, as the traits of this module return (they are used as `dyn`).
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// herdr reports the state from before the prompt (usually `idle`) for a moment after it is
/// submitted: the text is still being pasted and the TUI has not flipped to working. A settled
/// state seen in this window, before the turn was ever seen working, is not a completion.
pub const PRE_VISUAL_GRACE: Duration = Duration::from_millis(2_500);
/// how long a CLI herdr already calls ready may take to draw its input (`inputReady`)
pub const READY_SCREEN: Duration = Duration::from_secs(15);
/// how long a CLI's usage screen (cursor's `/usage`) may take to show
pub const USAGE_SCREEN: Duration = Duration::from_secs(10);
/// how long a project run without the person may stand still before its coordinator hears of it;
pub const QUIET: Duration = Duration::from_secs(15 * 60);
/// how long a non-interactive pane whose turn settled without a report stays before it closes, when
/// nothing was sent to it since (#189's 4; ADR 0256-orchestrator-foundation)
pub const UNREPORTED_CLOSE: Duration = Duration::from_secs(15 * 60);
/// how soon the threads' questions are tried again while the person has a draft in the
/// coordinator's input
pub const DRAFT_RETRY: Duration = Duration::from_secs(5);
/// a run still `starting` may be inside a 30 s agent start: not-found is not its end yet
pub(crate) const START_GRACE_MS: i64 = 30_000;

/// The role a thread's lead plays.
pub(crate) const THREAD_ROLE: &str = "lead";
/// The role a project's coordinator plays.
pub(crate) const PROJECT_ROLE: &str = "coordinator";

/// The waits of the orchestrator; the tests shorten them (TypeScript's `preVisualGraceMs`,
/// `readyScreenMs`, `usageScreenMs`, `draftRetryMs`, `quietMs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timings {
    pub pre_visual_grace: Duration,
    pub ready_screen: Duration,
    pub usage_screen: Duration,
    pub draft_retry: Duration,
    pub quiet: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Timings {
            pre_visual_grace: PRE_VISUAL_GRACE,
            ready_screen: READY_SCREEN,
            usage_screen: USAGE_SCREEN,
            draft_retry: DRAFT_RETRY,
            quiet: QUIET,
        }
    }
}

/// What each account has used: a candidate without usage left is skipped, and a rate limit starts
/// a cooldown (`Pick<UsageTracker, "unavailable" | "noteFailure" | "claimScreen" | "record">`).
/// L3's `UsageTracker` implements it (#263).
pub trait UsageGate: Send + Sync + 'static {
    /// why the account of `kind` and `model` may not take a run now, if it may not
    fn unavailable<'a>(
        &'a self,
        kind: FleetAgentKind,
        model: Option<&'a str>,
        max_used_percent: f64,
    ) -> BoxFuture<'a, Option<String>>;
    /// a failure that may be a rate limit: the account cools down for what it says, or
    /// `cooldown_minutes`
    fn note_failure(
        &self,
        kind: FleetAgentKind,
        model: Option<&str>,
        message: &str,
        cooldown_minutes: f64,
    );
    /// whether the CLI's usage screen may be read now (neither a reading nor a try is recent)
    fn claim_screen(&self, kind: FleetAgentKind, model: Option<&str>) -> bool;
    /// the usage read from the CLI's own screen
    fn record(&self, kind: FleetAgentKind, model: Option<&str>, reading: UsageReading);
}

/// Refuses a model the CLI does not offer, before the run starts (`Pick<ModelCatalog, "unknown">`).
/// L4's `ModelCatalog` implements it (#263).
pub trait ModelGate: Send + Sync + 'static {
    /// why `model` cannot run on `kind`, if the CLI's complete list lacks it
    fn unknown<'a>(
        &'a self,
        kind: FleetAgentKind,
        model: Option<&'a str>,
    ) -> BoxFuture<'a, Option<String>>;
}

/// What the orchestrator reads and changes in git and on GitHub: landing a thread
/// (`LandingTools`, orchestrator.ts:171), and the repository reads and setup command a thread
/// starts with (TypeScript's `gitRoot`, `gitHead`, `diffStat`, `excludeWorktrees` and `runSetup`
/// deps), in one port as one operation reads both. `thread.rs` and `github.rs` (L6) hold the real
/// functions, and #266 writes the impl over them. The tests stand in their own: the paused clock
/// runs no git (ADR 0256-orchestrator-foundation).
pub trait LandingTools: Send + Sync + 'static {
    /// the repository `cwd` lies in
    fn git_root<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<PathBuf>>;
    /// the commit `cwd` is at
    fn git_head<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<String>>;
    /// what `cwd` changed since `base`
    fn diff_stat<'a>(&'a self, cwd: &'a Path, base: &'a str) -> BoxFuture<'a, Option<DiffStat>>;
    /// keeps the threads' worktrees out of the repository's git status
    fn exclude_worktrees<'a>(&'a self, repo: &'a Path) -> BoxFuture<'a, io::Result<()>>;
    /// the project's setup command in a thread's fresh worktree
    fn run_setup<'a>(
        &'a self,
        cwd: &'a Path,
        command: &'a str,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, SetupOutcome>;
    fn git_branch<'a>(&'a self, repo: &'a Path) -> BoxFuture<'a, Option<String>>;
    fn branch_state<'a>(
        &'a self,
        cwd: &'a Path,
        base: &'a str,
    ) -> BoxFuture<'a, Option<BranchState>>;
    fn diff_text<'a>(&'a self, cwd: &'a Path, base: &'a str) -> BoxFuture<'a, Option<DiffText>>;
    fn branch_head<'a>(&'a self, repo: &'a Path, branch: &'a str) -> BoxFuture<'a, Option<String>>;
    fn is_merged<'a>(
        &'a self,
        repo: &'a Path,
        branch: &'a str,
        into: &'a str,
    ) -> BoxFuture<'a, bool>;
    /// the thread's worktree and branch removed; what git kept, if it kept anything
    fn remove_thread<'a>(
        &'a self,
        repo: &'a Path,
        worktree: &'a Path,
        branch: &'a str,
        options: RemoveOptions,
    ) -> BoxFuture<'a, Result<(), String>>;
    fn read_pull_request<'a>(
        &'a self,
        repo: &'a Path,
        branch: &'a str,
    ) -> BoxFuture<'a, Result<Option<PullRequestReading>, GhError>>;
}

/// The config that applies in a folder: built-ins, the user's, the project's.
pub type ConfigSource = Arc<dyn Fn(&Path) -> FleetConfig + Send + Sync>;
/// The roles that exist in a folder.
pub type RoleSource = Arc<dyn Fn(&Path) -> Vec<AgentDefinition> + Send + Sync>;
/// The standing orders that apply in a folder.
pub type StandingSource = Arc<dyn Fn(&Path) -> String + Send + Sync>;
/// Hears of each run saved.
pub type RunListener = Arc<dyn Fn(&AgentRun) + Send + Sync>;
/// Hears of each fleet event.
pub type EventListener = Arc<dyn Fn(FleetEvent) + Send + Sync>;

/// What the orchestrator is built from (`OrchestratorDeps`).
#[derive(Clone)]
pub struct OrchestratorDeps {
    pub runtime: Arc<dyn AgentRuntime>,
    pub registry: Arc<RunRegistry>,
    /// where every time the records hold is read from
    pub clock: Arc<dyn Clock>,
    pub config: ConfigSource,
    pub agents: RoleSource,
    /// the standing orders that apply in a folder (`load_standing_orders`)
    pub standing_orders: Option<StandingSource>,
    pub landing: Arc<dyn LandingTools>,
    /// the shell command an agent runs to reach the fleet (the fleet CLI)
    pub fleet_command: String,
    /// set in each agent's pane so its own fleet commands reach this server; read at each spawn
    pub agent_env: Arc<dyn Fn() -> BTreeMap<String, String> + Send + Sync>,
    /// what the adapters read from the server's own process
    pub host: Host,
    /// each run's result folder goes here, removed with the run's record
    pub results_dir: PathBuf,
    /// each thread's plan, a file per run, written by the server only; beside `results_dir`
    /// (`fleet-plans`) unless given
    pub plans_dir: Option<PathBuf>,
    /// instructions still to lead the first prompt of a CLI that takes none at launch, a file per
    /// run so a restart keeps them
    pub instructions_dir: PathBuf,
    /// where the per-spawn instruction files go; the system's temporary folder unless given
    pub prompt_dir: Option<PathBuf>,
    pub timings: Timings,
    pub usage: Option<Arc<dyn UsageGate>>,
    pub models: Option<Arc<dyn ModelGate>>,
    /// a run was saved
    pub on_changed: Option<RunListener>,
    /// what happened, for the factory's metrics (`EventLog::record`)
    pub events: Option<EventListener>,
}

/// Why an orchestrator method did not do what it was asked: a refusal of the fleet's, what the
/// runtime said, a wait that ran out (`AgentWaitTimeoutError`), or a file of the server's own that
/// could not be written (TypeScript's plain Error, which the API answers as 500 `internal_error`).
#[derive(Debug, Clone)]
pub enum OrchestratorError {
    Fleet(FleetError),
    Runtime(RuntimeError),
    WaitTimeout { run: Box<AgentRun>, timeout_ms: u64 },
    Io(Arc<io::Error>),
}

impl OrchestratorError {
    /// The code the API and the CLI name the error by.
    pub fn code(&self) -> &str {
        match self {
            OrchestratorError::Fleet(error) => &error.code,
            OrchestratorError::Runtime(error) => error.code(),
            OrchestratorError::WaitTimeout { .. } => "wait_timeout",
            OrchestratorError::Io(_) => "internal_error",
        }
    }

    /// The caller cancelled it (TypeScript's `isAbortError`).
    pub fn is_cancelled(&self) -> bool {
        matches!(self, OrchestratorError::Runtime(RuntimeError::Cancelled))
    }
}

impl fmt::Display for OrchestratorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OrchestratorError::Fleet(error) => error.fmt(f),
            OrchestratorError::Runtime(error) => error.fmt(f),
            OrchestratorError::WaitTimeout { run, timeout_ms } => write!(
                f,
                "Wait timed out after {timeout_ms}ms; {} is still {}.",
                run.name,
                state_name(run.state)
            ),
            OrchestratorError::Io(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for OrchestratorError {}

impl From<FleetError> for OrchestratorError {
    fn from(error: FleetError) -> Self {
        OrchestratorError::Fleet(error)
    }
}

impl From<io::Error> for OrchestratorError {
    fn from(error: io::Error) -> Self {
        OrchestratorError::Io(Arc::new(error))
    }
}

impl From<RuntimeError> for OrchestratorError {
    fn from(error: RuntimeError) -> Self {
        OrchestratorError::Runtime(error)
    }
}

/// A state as herdr and the records spell it.
pub(crate) fn state_name(state: AgentState) -> &'static str {
    match state {
        AgentState::Starting => "starting",
        AgentState::Working => "working",
        AgentState::Idle => "idle",
        AgentState::Done => "done",
        AgentState::Blocked => "blocked",
        AgentState::Unknown => "unknown",
        AgentState::Failed => "failed",
        AgentState::Stopped => "stopped",
    }
}

/// Work run one at a time per key, in the order it came: TypeScript's promise chains in a Map
/// (`reconcileLocks`, `threadLocks`, `projectStarts`). A key nobody waits on any more is dropped.
pub struct KeyedSerial<K> {
    locks: Mutex<HashMap<K, Arc<tokio::sync::Mutex<()>>>>,
}

impl<K: Eq + Hash + Clone> Default for KeyedSerial<K> {
    fn default() -> Self {
        KeyedSerial {
            locks: Mutex::new(HashMap::new()),
        }
    }
}

impl<K: Eq + Hash + Clone> KeyedSerial<K> {
    /// `work` once the work before it under `key` ended, and before the work after it.
    pub async fn run<T>(&self, key: K, work: impl Future<Output = T>) -> T {
        let entry = self.enter(key);
        let _turn = entry.lock.lock().await;
        work.await
    }

    /// Once the work under `key` that came before ended (`await this.reconcileLocks.get(id)`):
    /// the lock is taken and let go at once.
    pub async fn wait_idle(&self, key: &K) {
        let Some(lock) = self.map().get(key).cloned() else {
            return;
        };
        let entry = Entered {
            serial: self,
            key: key.clone(),
            lock,
        };
        drop(entry.lock.lock().await);
    }

    /// Whether work under `key` runs or waits now.
    pub fn is_busy(&self, key: &K) -> bool {
        self.map().contains_key(key)
    }

    fn enter(&self, key: K) -> Entered<'_, K> {
        let lock = self.map().entry(key.clone()).or_default().clone();
        Entered {
            serial: self,
            key,
            lock,
        }
    }

    fn map(&self) -> MutexGuard<'_, HashMap<K, Arc<tokio::sync::Mutex<()>>>> {
        self.locks.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A place in a key's line; leaving it (or being dropped while it waits) drops the key once no one
/// else holds it.
struct Entered<'a, K: Eq + Hash + Clone> {
    serial: &'a KeyedSerial<K>,
    key: K,
    lock: Arc<tokio::sync::Mutex<()>>,
}

impl<K: Eq + Hash + Clone> Drop for Entered<'_, K> {
    fn drop(&mut self) {
        let mut map = self.serial.map();
        // the map's own reference and this one: nobody else waits on the key
        if Arc::strong_count(&self.lock) == 2
            && map
                .get(&self.key)
                .is_some_and(|lock| Arc::ptr_eq(lock, &self.lock))
        {
            map.remove(&self.key);
        }
    }
}

/// What a timer is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum TimerKind {
    /// looks at a run again after the grace period (`settleChecks`)
    SettleCheck,
    /// tries the threads' questions again after the person's draft (`draftRetries`)
    DraftRetry,
    /// closes a non-interactive pane left without a report after the quiet period (#189's 4)
    UnreportedClose,
}

/// The timers this server set: tasks that sleep, then work. Each is known by its kind and run, and
/// leaves the table as it fires, so clearing it then does not abort its work. `stop` aborts the
/// ones still sleeping.
#[derive(Default)]
pub(crate) struct Timers {
    handles: Mutex<HashMap<(TimerKind, String), (u64, AbortHandle)>>,
    next: AtomicU64,
}

impl Timers {
    /// `work` after `after`, in place of the timer of the same kind and run.
    pub(crate) fn set(
        self: &Arc<Self>,
        kind: TimerKind,
        id: &str,
        after: Duration,
        work: impl Future<Output = ()> + Send + 'static,
    ) {
        let seq = self.next.fetch_add(1, Ordering::Relaxed);
        let key = (kind, id.to_owned());
        let timers = Arc::clone(self);
        let fired = key.clone();
        // the table stays locked until the handle is in it: a task that fires at once waits for
        // the lock, and then finds its own entry to take out
        let mut handles = self.lock();
        let task = tokio::spawn(async move {
            tokio::time::sleep(after).await;
            {
                let mut handles = timers.lock();
                if handles.get(&fired).is_some_and(|(each, _)| *each == seq) {
                    handles.remove(&fired);
                }
            }
            work.await;
        });
        if let Some((_, previous)) = handles.insert(key, (seq, task.abort_handle())) {
            previous.abort();
        }
    }

    pub(crate) fn clear(&self, kind: TimerKind, id: &str) {
        if let Some((_, handle)) = self.lock().remove(&(kind, id.to_owned())) {
            handle.abort();
        }
    }

    pub(crate) fn has(&self, kind: TimerKind, id: &str) -> bool {
        self.lock().contains_key(&(kind, id.to_owned()))
    }

    pub(crate) fn abort_all(&self) {
        for (_, (_, handle)) in self.lock().drain() {
            handle.abort();
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<(TimerKind, String), (u64, AbortHandle)>> {
        self.handles.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// What the handle points at.
#[allow(
    dead_code,
    reason = "the locks and states of the clusters #262-#268 fill"
)]
pub(crate) struct Inner {
    pub(crate) deps: OrchestratorDeps,
    /// the fleet's notices to its agents, kept until they went
    pub(crate) outbox: Outbox,
    /// per run, its settlement one at a time (`reconcileLocks`)
    pub(crate) reconcile_locks: KeyedSerial<String>,
    /// per thread, its landing steps and restarts one at a time (`threadLocks`)
    pub(crate) thread_locks: KeyedSerial<String>,
    /// per project, one coordinator start at a time (`projectStarts`)
    pub(crate) project_starts: KeyedSerial<PathBuf>,
    /// the concurrency check and the run's first save happen as one step (`spawnGate`)
    pub(crate) spawn_gate: tokio::sync::Mutex<()>,
    pub(crate) timers: Arc<Timers>,
    pub(crate) stopped: AtomicBool,
    /// numbers the waiters of `wait`
    pub(crate) next_waiter: AtomicU64,
    /// each run's state as last saved: a save that changes it is an event
    pub(crate) saved_states: Mutex<HashMap<String, AgentState>>,
    pub(crate) turns: Mutex<turns::State>,
    pub(crate) candidates: Mutex<candidates::State>,
    pub(crate) threads: Mutex<threads::State>,
    pub(crate) projects: Mutex<projects::State>,
    pub(crate) notices: Mutex<notices::State>,
    pub(crate) plans: Mutex<plans::State>,
    pub(crate) landing: Mutex<landing::State>,
    pub(crate) restart: Mutex<restart::State>,
    pub(crate) autonomy: Mutex<autonomy::State>,
}

/// The orchestrator: a handle that clones cheaply, over the state every clone shares.
#[derive(Clone)]
pub struct Orchestrator {
    inner: Arc<Inner>,
}

/// `mutex` locked; a task that panicked while holding it left the state as it was then.
pub(crate) fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Orchestrator {
    /// The orchestrator over `deps`, after it read back what the last server left, in TypeScript's
    /// order: the result folders of runs no longer kept go, each run's result comes back from its
    /// file, a turn still running is followed again, and the outbox is read. It must be built inside
    /// a tokio runtime (a turn followed again sets a timer). An error says the outbox file could not
    /// be written.
    pub fn new(deps: OrchestratorDeps) -> Result<Orchestrator, OrchestratorError> {
        let outbox_file = deps
            .results_dir
            .parent()
            .unwrap_or(Path::new(""))
            .join("fleet-outbox.json");
        let outbox = Outbox::open(Some(outbox_file), deps.clock.clone())?;
        let fleet = Orchestrator {
            inner: Arc::new(Inner {
                deps,
                outbox,
                reconcile_locks: KeyedSerial::default(),
                thread_locks: KeyedSerial::default(),
                project_starts: KeyedSerial::default(),
                spawn_gate: tokio::sync::Mutex::new(()),
                timers: Arc::new(Timers::default()),
                stopped: AtomicBool::new(false),
                next_waiter: AtomicU64::new(0),
                saved_states: Mutex::new(HashMap::new()),
                turns: Mutex::new(turns::State::default()),
                candidates: Mutex::new(candidates::State::default()),
                threads: Mutex::new(threads::State::default()),
                projects: Mutex::new(projects::State::default()),
                notices: Mutex::new(notices::State::default()),
                plans: Mutex::new(plans::State::default()),
                landing: Mutex::new(landing::State::default()),
                restart: Mutex::new(restart::State::default()),
                autonomy: Mutex::new(autonomy::State::default()),
            }),
        };
        fleet.prune_results();
        fleet.resume_turns();
        // a notice about a run the registry dropped refers to nothing its hearer can look up
        let registry = fleet.registry();
        fleet
            .inner
            .outbox
            .prune(|notice| registry.get(&notice.about).is_some() && !fleet.stale_step(notice))?;
        fleet.restore_notices();
        fleet.restore_landing_steps();
        Ok(fleet)
    }

    pub(crate) fn deps(&self) -> &OrchestratorDeps {
        &self.inner.deps
    }

    pub(crate) fn registry(&self) -> &RunRegistry {
        &self.inner.deps.registry
    }

    pub(crate) fn now(&self) -> i64 {
        self.inner.deps.clock.now_ms()
    }

    pub(crate) fn config(&self, cwd: &str) -> FleetConfig {
        (self.inner.deps.config)(Path::new(cwd))
    }

    pub(crate) fn plans_dir(&self) -> PathBuf {
        self.inner.deps.plans_dir.clone().unwrap_or_else(|| {
            self.inner
                .deps
                .results_dir
                .parent()
                .unwrap_or(Path::new(""))
                .join("fleet-plans")
        })
    }

    pub(crate) fn result_dir(&self, id: &str) -> PathBuf {
        self.inner.deps.results_dir.join(id)
    }

    /// A result folder outlives its pane but not its run: once the registry dropped the run, it
    /// goes. So do undelivered instructions and plans.
    fn prune_results(&self) {
        let deps = self.deps();
        for dir in [
            deps.results_dir.clone(),
            deps.instructions_dir.clone(),
            self.plans_dir(),
        ] {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let id = name
                    .strip_suffix(".md")
                    .or_else(|| name.strip_suffix(".json"))
                    .unwrap_or(&name);
                if self.registry().get(id).is_none() {
                    let path = entry.path();
                    let _ = std::fs::remove_dir_all(&path).or_else(|_| std::fs::remove_file(&path));
                }
            }
        }
    }

    /// Every run, oldest first; those of `group` when one is given.
    pub fn list(&self, group: Option<&str>) -> Vec<AgentRun> {
        let mut runs: Vec<AgentRun> = self
            .registry()
            .all()
            .into_iter()
            .filter(|run| group.is_none_or(|group| run.group == group))
            .collect();
        runs.sort_by_key(|run| run.started_at);
        runs
    }

    /// The roles a spawn in `cwd` can name.
    pub fn roles(&self, cwd: &Path) -> Vec<AgentDefinition> {
        (self.deps().agents)(cwd)
    }

    /// A run of `group`, or a thread a run of `group` started: each thread is a fleet of its own,
    /// which its owner still reaches. A thread's earlier lead run reaches the lead that took it over.
    pub fn get(&self, target: &str, group: Option<&str>) -> Result<AgentRun, FleetError> {
        let registry = self.registry();
        let owned = |run: Option<AgentRun>| {
            run.filter(|run| {
                run.owner
                    .as_deref()
                    .and_then(|owner| registry.get(owner))
                    .is_some_and(|owner| Some(owner.group.as_str()) == group)
            })
        };
        let found = registry
            .resolve(target, group)
            .or_else(|| group.and_then(|_| owned(registry.resolve(target, None))));
        let Some(mut run) = found else {
            return Err(FleetError::new(
                "run_not_found",
                format!("Unknown fleet agent: {target}"),
            ));
        };
        let mut hops = 0;
        while is_thread(&run) && hops < 32 {
            let Some(next) = run.replaced_by.as_deref().and_then(|id| registry.get(id)) else {
                break;
            };
            run = next;
            hops += 1;
        }
        Ok(run)
    }

    /// Stops the timers; a settlement that would start after this does nothing.
    pub fn stop(&self) {
        self.inner.stopped.store(true, Ordering::SeqCst);
        self.inner.timers.abort_all();
    }

    pub(crate) fn is_stopped(&self) -> bool {
        self.inner.stopped.load(Ordering::SeqCst)
    }

    /// The run `id` changed by `change` and saved (TypeScript's `save`); the run as saved, or
    /// `None` when the registry no longer has it. A runs file that cannot be written is logged, and
    /// the change stays in memory for the next save to write: TypeScript threw instead, which left
    /// a spawn's new pane open and skipped the rest of a settlement (ADR 0256-orchestrator-foundation).
    pub(crate) fn change(&self, id: &str, change: impl FnOnce(&mut AgentRun)) -> Option<AgentRun> {
        let mut saved = None;
        let written = self.registry().update(id, |run| {
            change(run);
            saved = Some(run.clone());
        });
        if let Err(error) = written {
            eprintln!("herdr-fleet: the runs file could not be written: {error}");
        }
        let saved = saved?;
        self.saved(&saved);
        Some(saved)
    }

    /// `change` on the run `id` only while it is live, decided under the registry's lock: an answer
    /// herdr gave before the pane ended does not bring a stopped or failed run back. The run as
    /// saved, or `None` when it is gone or no longer live.
    pub(crate) fn change_live(
        &self,
        id: &str,
        change: impl FnOnce(&mut AgentRun),
    ) -> Option<AgentRun> {
        let mut saved = None;
        let written = self.registry().update(id, |run| {
            if is_live(run) {
                change(run);
                saved = Some(run.clone());
            }
        });
        if let Err(error) = written {
            eprintln!("herdr-fleet: the runs file could not be written: {error}");
        }
        let saved = saved?;
        self.saved(&saved);
        Some(saved)
    }

    /// A new run's first save, as `change` saves.
    pub(crate) fn insert(&self, run: AgentRun) {
        if let Err(error) = self.registry().insert(run.clone()) {
            eprintln!("herdr-fleet: the runs file could not be written: {error}");
        }
        self.saved(&run);
    }

    /// After a save: a changed state is an event, and the server hears of the run.
    fn saved(&self, run: &AgentRun) {
        let previous = locked(&self.inner.saved_states).insert(run.id.clone(), run.state);
        if previous != Some(run.state) {
            let error = run
                .last_error
                .as_deref()
                .filter(|_| {
                    matches!(
                        run.state,
                        AgentState::Failed | AgentState::Blocked | AgentState::Unknown
                    )
                })
                .map(|error| protocol::js::cut_utf16(error, 200).to_owned());
            self.event(FleetEvent::State(StateEvent {
                run: run.id.clone(),
                role: run.role.clone(),
                agent: run.agent,
                model: run.model.clone(),
                group: run.group.clone(),
                project: run.project.clone(),
                interactive: Some(run.interactive),
                from: previous,
                to: run.state,
                sent: self.turn_in_flight(&run.id),
                error,
            }));
        }
        if let Some(on_changed) = &self.deps().on_changed {
            on_changed(run);
        }
    }

    pub(crate) fn event(&self, event: FleetEvent) {
        if let Some(events) = &self.deps().events {
            events(event);
        }
    }
}

/// herdr calls the turn over.
pub(crate) fn is_completed(state: AgentState) -> bool {
    matches!(state, AgentState::Idle | AgentState::Done)
}

/// The run may still take a turn.
pub(crate) fn is_live(run: &AgentRun) -> bool {
    !matches!(run.state, AgentState::Stopped | AgentState::Failed)
}

/// A thread's lead: a lead run that works for a project.
pub(crate) fn is_thread(run: &AgentRun) -> bool {
    run.role == THREAD_ROLE && run.project.is_some()
}

/// A thread's id: its first lead run's, which names its worktree and branch, whichever run leads it
/// now.
#[allow(
    dead_code,
    reason = "the thread clusters #262-#268 key their work by it"
)]
pub(crate) fn thread_id(run: &AgentRun) -> &str {
    run.thread.as_deref().unwrap_or(&run.id)
}
