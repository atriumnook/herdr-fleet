//! What the orchestrator's tests share (`server/fleet/orchestrator.test.ts:17-116`): a
//! `FakeRuntime` that records what the orchestrator asked of herdr, `setup()` with the options
//! TypeScript's `SetupOptions` takes, and helpers to wait. The tests run on a paused tokio clock
//! (`#[tokio::test(start_paused = true)]`); the records' time is a fixed start plus how far that
//! clock moved (ADR 0242-phase-3-split, "非同期と時刻").

#![allow(dead_code, reason = "each test file uses a part of this module")]

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use herdr_fleet_orchestrator::Clock;
use herdr_fleet_orchestrator::agents::{AgentDefinition, RoleSource};
use herdr_fleet_orchestrator::config::{FleetConfig, merge_config};
use herdr_fleet_orchestrator::events::FleetEvent;
use herdr_fleet_orchestrator::fleet::{
    BoxFuture, LandingTools, ModelGate, Orchestrator, OrchestratorDeps, OrchestratorError,
    SpawnRequest, StandingSource, Timings, UsageGate,
};
use herdr_fleet_orchestrator::github::{GhError, PullRequestReading};
use herdr_fleet_orchestrator::launch::Host;
use herdr_fleet_orchestrator::registry::RunRegistry;
use herdr_fleet_orchestrator::runtime::{
    AgentMetadata, AgentRuntime, CreateLocationOptions, RuntimeError, RuntimeFuture,
    RuntimeLocation, StartOptions,
};
use herdr_fleet_orchestrator::thread::{BranchState, DiffText, RemoveOptions, SetupOutcome};
use protocol::{AgentRun, AgentState, DiffStat, FleetAgentKind};
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

/// The grace period after a prompt the tests run with (`GRACE`, orchestrator.test.ts:17).
pub const GRACE: Duration = Duration::from_millis(60);

/// When the tests' clock starts: 2026-11-01T00:00:00Z (20,758 days after 1970-01-01, by hand).
pub const START_MS: i64 = 1_793_491_200_000;

/// A clock that reads `START_MS` plus how far tokio's (paused) clock moved since it was made.
pub struct TestClock {
    origin: tokio::time::Instant,
    start_ms: i64,
}

impl TestClock {
    pub fn new() -> Arc<TestClock> {
        TestClock::at(START_MS)
    }

    pub fn at(start_ms: i64) -> Arc<TestClock> {
        Arc::new(TestClock {
            origin: tokio::time::Instant::now(),
            start_ms,
        })
    }
}

impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        let elapsed = i64::try_from(self.origin.elapsed().as_millis()).unwrap_or(i64::MAX);
        self.start_ms + elapsed
    }
}

/// A folder of its own under the system's temporary folder, removed when dropped.
pub struct Folder(PathBuf);

impl Folder {
    pub fn new() -> Folder {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "fleet-orchestrator-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Folder(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// An agent start as the fake saw it (`StartOptions` without its function and token).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Started {
    pub kind: FleetAgentKind,
    pub name: String,
    pub pane_id: String,
    pub args: Vec<String>,
}

/// A prompt as the fake saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prompted {
    pub name: String,
    pub text: String,
}

/// What `FakeRuntime` answers and what it saw (`FakeRuntime`'s fields, orchestrator.test.ts:19-32).
pub struct Recorded {
    pub closed: Vec<String>,
    pub prompts: Vec<Prompted>,
    pub starts: Vec<Started>,
    pub locations: Vec<CreateLocationOptions>,
    pub prompt_status: AgentState,
    pub get_status: AgentState,
    pub output: String,
    pub instructions: Vec<String>,
    pub screens: HashMap<String, String>,
    pub interrupts: usize,
    pub metadata: Vec<AgentMetadata>,
    panes: usize,
}

type CreateLocationImpl = Arc<
    dyn Fn(
            CreateLocationOptions,
            CancellationToken,
        ) -> BoxFuture<'static, Result<RuntimeLocation, RuntimeError>>
        + Send
        + Sync,
>;
type StartImpl =
    Arc<dyn Fn(StartOptions) -> BoxFuture<'static, Result<AgentState, RuntimeError>> + Send + Sync>;
type PromptImpl = Arc<
    dyn Fn(
            String,
            String,
            CancellationToken,
        ) -> BoxFuture<'static, Result<AgentState, RuntimeError>>
        + Send
        + Sync,
>;
type GetImpl =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<AgentState, RuntimeError>> + Send + Sync>;
type FocusImpl = Arc<dyn Fn(String) -> BoxFuture<'static, Result<(), RuntimeError>> + Send + Sync>;
type ReadImpl =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<String, RuntimeError>> + Send + Sync>;

/// What the tests replace of the fake's answers (`createLocationImpl`, `startImpl`, `promptImpl`,
/// `getImpl`), and a read this crate's own tests replace.
#[derive(Default)]
pub struct Overrides {
    pub create_location: Option<CreateLocationImpl>,
    pub start: Option<StartImpl>,
    pub prompt: Option<PromptImpl>,
    pub get: Option<GetImpl>,
    pub read: Option<ReadImpl>,
    pub focus: Option<FocusImpl>,
}

/// herdr as the tests stand it in: it records each call, and answers with what the test set.
pub struct FakeRuntime {
    recorded: Mutex<Recorded>,
    overrides: Mutex<Overrides>,
}

impl FakeRuntime {
    pub fn new() -> Arc<FakeRuntime> {
        Arc::new(FakeRuntime {
            recorded: Mutex::new(Recorded {
                closed: Vec::new(),
                prompts: Vec::new(),
                starts: Vec::new(),
                locations: Vec::new(),
                prompt_status: AgentState::Working,
                get_status: AgentState::Working,
                output: "agent output".to_owned(),
                instructions: Vec::new(),
                screens: HashMap::new(),
                interrupts: 0,
                metadata: Vec::new(),
                panes: 0,
            }),
            overrides: Mutex::new(Overrides::default()),
        })
    }

    /// What the fake saw and answers, to read or change.
    pub fn recorded(&self) -> MutexGuard<'_, Recorded> {
        self.recorded.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The answers the test replaced.
    pub fn overrides(&self) -> MutexGuard<'_, Overrides> {
        self.overrides
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub fn set_output(&self, output: &str) {
        self.recorded().output = output.to_owned();
    }

    pub fn set_get_status(&self, state: AgentState) {
        self.recorded().get_status = state;
    }

    pub fn set_prompt_status(&self, state: AgentState) {
        self.recorded().prompt_status = state;
    }

    pub fn closed(&self) -> Vec<String> {
        self.recorded().closed.clone()
    }

    pub fn prompts(&self) -> Vec<Prompted> {
        self.recorded().prompts.clone()
    }

    pub fn starts(&self) -> Vec<Started> {
        self.recorded().starts.clone()
    }

    pub fn locations(&self) -> Vec<CreateLocationOptions> {
        self.recorded().locations.clone()
    }

    pub fn instructions(&self) -> Vec<String> {
        self.recorded().instructions.clone()
    }

    pub fn on_create_location<F, Fut>(&self, imp: F)
    where
        F: Fn(CreateLocationOptions, CancellationToken) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<RuntimeLocation, RuntimeError>> + Send + 'static,
    {
        self.overrides().create_location = Some(Arc::new(move |options, cancel| {
            Box::pin(imp(options, cancel))
        }));
    }

    pub fn on_start<F, Fut>(&self, imp: F)
    where
        F: Fn(StartOptions) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<AgentState, RuntimeError>> + Send + 'static,
    {
        self.overrides().start = Some(Arc::new(move |options| Box::pin(imp(options))));
    }

    pub fn on_prompt<F, Fut>(&self, imp: F)
    where
        F: Fn(String, String, CancellationToken) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<AgentState, RuntimeError>> + Send + 'static,
    {
        self.overrides().prompt = Some(Arc::new(move |name, text, cancel| {
            Box::pin(imp(name, text, cancel))
        }));
    }

    pub fn on_get<F, Fut>(&self, imp: F)
    where
        F: Fn(String) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<AgentState, RuntimeError>> + Send + 'static,
    {
        self.overrides().get = Some(Arc::new(move |name| Box::pin(imp(name))));
    }

    pub fn on_focus<F, Fut>(&self, imp: F)
    where
        F: Fn(String) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), RuntimeError>> + Send + 'static,
    {
        self.overrides().focus = Some(Arc::new(move |name| Box::pin(imp(name))));
    }

    pub fn on_read<F, Fut>(&self, imp: F)
    where
        F: Fn(String) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<String, RuntimeError>> + Send + 'static,
    {
        self.overrides().read = Some(Arc::new(move |name| Box::pin(imp(name))));
    }
}

/// The file an agent CLI was told to read its instructions from: the argument after pi's
/// `--append-system-prompt` (orchestrator.test.ts:43-45).
fn instructions_file(args: &[String]) -> Option<&str> {
    let flag = args
        .iter()
        .position(|arg| arg.starts_with("--append-system-prompt"))?;
    args.get(flag + 1).map(String::as_str)
}

impl AgentRuntime for FakeRuntime {
    fn create_location<'a>(
        &'a self,
        options: CreateLocationOptions,
        cancel: &'a CancellationToken,
    ) -> RuntimeFuture<'a, RuntimeLocation> {
        self.recorded().locations.push(options.clone());
        let imp = self.overrides().create_location.clone();
        Box::pin(async move {
            if let Some(imp) = imp {
                return imp(options, cancel.clone()).await;
            }
            if cancel.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            let mut recorded = self.recorded();
            recorded.panes += 1;
            Ok(RuntimeLocation {
                pane_id: format!("w1:p{}", recorded.panes),
                workspace_id: None,
                cwd: options.cwd,
            })
        })
    }

    fn start(&self, options: StartOptions) -> RuntimeFuture<'_, AgentState> {
        {
            let mut recorded = self.recorded();
            recorded.starts.push(Started {
                kind: options.kind,
                name: options.name.clone(),
                pane_id: options.pane_id.clone(),
                args: options.args.clone(),
            });
            if let Some(text) =
                instructions_file(&options.args).and_then(|file| fs::read_to_string(file).ok())
            {
                recorded.instructions.push(text);
            }
        }
        let imp = self.overrides().start.clone();
        Box::pin(async move {
            if let Some(imp) = imp {
                return imp(options).await;
            }
            if options.cancel.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            Ok(AgentState::Idle)
        })
    }

    fn close_pane<'a>(&'a self, pane_id: &'a str) -> RuntimeFuture<'a, ()> {
        self.recorded().closed.push(pane_id.to_owned());
        Box::pin(async { Ok(()) })
    }

    fn prompt<'a>(
        &'a self,
        name: &'a str,
        text: &'a str,
        cancel: &'a CancellationToken,
    ) -> RuntimeFuture<'a, AgentState> {
        let imp = self.overrides().prompt.clone();
        Box::pin(async move {
            if let Some(imp) = imp {
                return imp(name.to_owned(), text.to_owned(), cancel.clone()).await;
            }
            if cancel.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            let mut recorded = self.recorded();
            recorded.prompts.push(Prompted {
                name: name.to_owned(),
                text: text.to_owned(),
            });
            Ok(recorded.prompt_status)
        })
    }

    fn get<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, AgentState> {
        let imp = self.overrides().get.clone();
        Box::pin(async move {
            match imp {
                Some(imp) => imp(name.to_owned()).await,
                None => Ok(self.recorded().get_status),
            }
        })
    }

    fn read<'a>(&'a self, name: &'a str, _lines: u32) -> RuntimeFuture<'a, String> {
        let imp = self.overrides().read.clone();
        Box::pin(async move {
            match imp {
                Some(imp) => imp(name.to_owned()).await,
                None => Ok(self.recorded().output.clone()),
            }
        })
    }

    fn screen<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, String> {
        let screen = self
            .recorded()
            .screens
            .get(name)
            .cloned()
            .unwrap_or_default();
        Box::pin(async move { Ok(screen) })
    }

    fn interrupt<'a>(&'a self, _name: &'a str) -> RuntimeFuture<'a, ()> {
        self.recorded().interrupts += 1;
        Box::pin(async { Ok(()) })
    }

    fn focus<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, ()> {
        let imp = self.overrides().focus.clone();
        Box::pin(async move {
            match imp {
                Some(imp) => imp(name.to_owned()).await,
                None => Ok(()),
            }
        })
    }

    fn report_metadata(&self, metadata: AgentMetadata) -> RuntimeFuture<'_, ()> {
        self.recorded().metadata.push(metadata);
        Box::pin(async { Ok(()) })
    }
}

/// One answer of the fake git and GitHub: a function of the call's arguments.
pub type Answer<A, T> = Arc<dyn Fn(A) -> BoxFuture<'static, T> + Send + Sync>;

/// `f` as an answer of [`FakeLanding`].
pub fn answer<A, T, F, Fut>(f: F) -> Option<Answer<A, T>>
where
    F: Fn(A) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = T> + Send + 'static,
{
    Some(Arc::new(move |args| Box::pin(f(args))))
}

/// `remove_thread`'s arguments: the repository, the worktree, the branch and how.
pub type RemoveArgs = (PathBuf, PathBuf, String, RemoveOptions);
/// What `read_pull_request` answers.
pub type PullRequestAnswer = Result<Option<PullRequestReading>, GhError>;

/// What the tests replace of git's and GitHub's answers, one per [`LandingTools`] method. A method
/// left `None` answers as TypeScript's `setup()` leaves it (orchestrator.test.ts:98-100): no
/// repository, head, branch or pull request, and for the reads TypeScript leaves real, what git
/// answers for a folder that is no repository (no change, nothing merged, nothing kept, a setup
/// command that succeeds).
#[derive(Default)]
pub struct LandingAnswers {
    pub git_root: Option<Answer<PathBuf, Option<PathBuf>>>,
    pub git_head: Option<Answer<PathBuf, Option<String>>>,
    pub diff_stat: Option<Answer<(PathBuf, String), Option<DiffStat>>>,
    pub exclude_worktrees: Option<Answer<PathBuf, std::io::Result<()>>>,
    pub run_setup: Option<Answer<(PathBuf, String), SetupOutcome>>,
    pub git_branch: Option<Answer<PathBuf, Option<String>>>,
    pub branch_state: Option<Answer<(PathBuf, String), Option<BranchState>>>,
    pub diff_text: Option<Answer<(PathBuf, String), Option<DiffText>>>,
    pub branch_head: Option<Answer<(PathBuf, String), Option<String>>>,
    pub is_merged: Option<Answer<(PathBuf, String, String), bool>>,
    pub remove_thread: Option<Answer<RemoveArgs, Result<(), String>>>,
    pub read_pull_request: Option<Answer<(PathBuf, String), PullRequestAnswer>>,
}

/// A call the fake git and GitHub took: the method and its arguments as text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LandingCall {
    pub method: &'static str,
    pub args: Vec<String>,
}

/// git and GitHub as the tests stand them in: each call is recorded, and answered by the test's
/// function or as [`LandingAnswers`] says.
#[derive(Default)]
pub struct FakeLanding {
    answers: Mutex<LandingAnswers>,
    calls: Mutex<Vec<LandingCall>>,
}

impl FakeLanding {
    pub fn new() -> Arc<FakeLanding> {
        Arc::new(FakeLanding::default())
    }

    /// The answers the test replaced, to change.
    pub fn answers(&self) -> MutexGuard<'_, LandingAnswers> {
        self.answers.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The calls taken so far.
    pub fn calls(&self) -> Vec<LandingCall> {
        self.calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn record(&self, method: &'static str, args: &[&dyn std::fmt::Display]) {
        let args = args.iter().map(ToString::to_string).collect();
        self.calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(LandingCall { method, args });
    }

    fn reply<A, T: Send + 'static>(
        &self,
        pick: impl FnOnce(&LandingAnswers) -> Option<Answer<A, T>>,
        args: A,
        otherwise: impl FnOnce() -> T + Send + 'static,
    ) -> BoxFuture<'static, T> {
        match pick(&self.answers()) {
            Some(answer) => answer(args),
            None => Box::pin(async move { otherwise() }),
        }
    }
}

impl LandingTools for FakeLanding {
    fn git_root<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<PathBuf>> {
        self.record("git_root", &[&cwd.display()]);
        self.reply(|a| a.git_root.clone(), cwd.to_path_buf(), || None)
    }
    fn git_head<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<String>> {
        self.record("git_head", &[&cwd.display()]);
        self.reply(|a| a.git_head.clone(), cwd.to_path_buf(), || None)
    }
    fn diff_stat<'a>(&'a self, cwd: &'a Path, base: &'a str) -> BoxFuture<'a, Option<DiffStat>> {
        self.record("diff_stat", &[&cwd.display(), &base]);
        self.reply(
            |a| a.diff_stat.clone(),
            (cwd.to_path_buf(), base.to_owned()),
            || None,
        )
    }
    fn exclude_worktrees<'a>(&'a self, repo: &'a Path) -> BoxFuture<'a, std::io::Result<()>> {
        self.record("exclude_worktrees", &[&repo.display()]);
        self.reply(
            |a| a.exclude_worktrees.clone(),
            repo.to_path_buf(),
            || Ok(()),
        )
    }
    fn run_setup<'a>(
        &'a self,
        cwd: &'a Path,
        command: &'a str,
        _cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, SetupOutcome> {
        self.record("run_setup", &[&cwd.display(), &command]);
        self.reply(
            |a| a.run_setup.clone(),
            (cwd.to_path_buf(), command.to_owned()),
            || SetupOutcome {
                ok: true,
                output: String::new(),
            },
        )
    }
    fn git_branch<'a>(&'a self, repo: &'a Path) -> BoxFuture<'a, Option<String>> {
        self.record("git_branch", &[&repo.display()]);
        self.reply(|a| a.git_branch.clone(), repo.to_path_buf(), || None)
    }
    fn branch_state<'a>(
        &'a self,
        cwd: &'a Path,
        base: &'a str,
    ) -> BoxFuture<'a, Option<BranchState>> {
        self.record("branch_state", &[&cwd.display(), &base]);
        self.reply(
            |a| a.branch_state.clone(),
            (cwd.to_path_buf(), base.to_owned()),
            || None,
        )
    }
    fn diff_text<'a>(&'a self, cwd: &'a Path, base: &'a str) -> BoxFuture<'a, Option<DiffText>> {
        self.record("diff_text", &[&cwd.display(), &base]);
        self.reply(
            |a| a.diff_text.clone(),
            (cwd.to_path_buf(), base.to_owned()),
            || None,
        )
    }
    fn branch_head<'a>(&'a self, repo: &'a Path, branch: &'a str) -> BoxFuture<'a, Option<String>> {
        self.record("branch_head", &[&repo.display(), &branch]);
        self.reply(
            |a| a.branch_head.clone(),
            (repo.to_path_buf(), branch.to_owned()),
            || None,
        )
    }
    fn is_merged<'a>(
        &'a self,
        repo: &'a Path,
        branch: &'a str,
        into: &'a str,
    ) -> BoxFuture<'a, bool> {
        self.record("is_merged", &[&repo.display(), &branch, &into]);
        self.reply(
            |a| a.is_merged.clone(),
            (repo.to_path_buf(), branch.to_owned(), into.to_owned()),
            || false,
        )
    }
    fn remove_thread<'a>(
        &'a self,
        repo: &'a Path,
        worktree: &'a Path,
        branch: &'a str,
        options: RemoveOptions,
    ) -> BoxFuture<'a, Result<(), String>> {
        self.record(
            "remove_thread",
            &[&repo.display(), &worktree.display(), &branch],
        );
        let args = (
            repo.to_path_buf(),
            worktree.to_path_buf(),
            branch.to_owned(),
            options,
        );
        self.reply(|a| a.remove_thread.clone(), args, || Ok(()))
    }
    fn read_pull_request<'a>(
        &'a self,
        repo: &'a Path,
        branch: &'a str,
    ) -> BoxFuture<'a, Result<Option<PullRequestReading>, GhError>> {
        self.record("read_pull_request", &[&repo.display(), &branch]);
        self.reply(
            |a| a.read_pull_request.clone(),
            (repo.to_path_buf(), branch.to_owned()),
            || Ok(None),
        )
    }
}

/// A role as orchestrator.test.ts's `role(name, extra)` builds it: pi, its prompt `You are <name>.`,
/// bundled from `<name>.md`.
pub fn role(name: &str) -> AgentDefinition {
    AgentDefinition {
        name: name.to_owned(),
        description: name.to_owned(),
        agent: FleetAgentKind::Pi,
        model: None,
        thinking: None,
        fallback_models: None,
        tools: None,
        system_prompt: format!("You are {name}."),
        worktree: None,
        interactive: None,
        spawning: None,
        edits: None,
        source: RoleSource::Bundled,
        file_path: PathBuf::from(format!("{name}.md")),
        hash: None,
    }
}

/// The roles of a setup without `agents`: worker, and reviewer, which talks in its pane.
pub fn default_roles() -> Vec<AgentDefinition> {
    vec![
        role("worker"),
        AgentDefinition {
            interactive: Some(true),
            ..role("reviewer")
        },
    ]
}

/// What a setup may be given (`SetupOptions`, orchestrator.test.ts:75-87): CC hands in the run
/// records, the config, git and GitHub, and the clock as well.
#[derive(Default)]
pub struct SetupOptions {
    /// fleet.json's keys over the defaults (`mergeConfig(DEFAULT_CONFIG, options.config)`)
    pub config: Option<Value>,
    pub agents: Option<Vec<AgentDefinition>>,
    pub standing_orders: Option<StandingSource>,
    pub usage: Option<Arc<dyn UsageGate>>,
    pub models: Option<Arc<dyn ModelGate>>,
    /// git and GitHub; a new `FakeLanding` when absent
    pub landing: Option<Arc<dyn LandingTools>>,
    /// the run records; a new registry in the setup's folder (`runs.json`) when absent
    pub registry: Option<Arc<RunRegistry>>,
    pub clock: Option<Arc<dyn Clock>>,
    pub quiet: Option<Duration>,
    pub draft_retry: Option<Duration>,
    /// the folder the results, instructions and prompts go in; a new one when absent
    pub root: Option<PathBuf>,
}

/// An orchestrator over a `FakeRuntime`, with what the test reads back.
pub struct Setup {
    pub fleet: Orchestrator,
    pub runtime: Arc<FakeRuntime>,
    pub registry: Arc<RunRegistry>,
    pub root: PathBuf,
    pub clock: Arc<dyn Clock>,
    pub events: Arc<Mutex<Vec<FleetEvent>>>,
    /// the fake git and GitHub, unless the options gave other ones
    pub landing: Arc<FakeLanding>,
    /// the setup's own folder, removed when the setup is dropped
    _folder: Option<Folder>,
}

impl Setup {
    /// The events recorded so far.
    pub fn events(&self) -> Vec<FleetEvent> {
        self.events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// The result folder of the run `id`.
    pub fn result_dir(&self, id: &str) -> PathBuf {
        self.root.join("results").join(id)
    }
}

/// The config `raw` makes over the defaults.
pub fn config(raw: Option<&Value>) -> FleetConfig {
    let empty = Map::new();
    let raw = raw.and_then(Value::as_object).unwrap_or(&empty);
    merge_config(&FleetConfig::default(), raw)
}

/// The deps an orchestrator of the tests starts with, as orchestrator.test.ts's `setup` and its
/// restarts (`new Orchestrator({...})`, orchestrator.test.ts:824-826) build them.
pub fn deps(
    runtime: Arc<FakeRuntime>,
    registry: Arc<RunRegistry>,
    root: &Path,
    clock: Arc<dyn Clock>,
    config: FleetConfig,
    agents: Vec<AgentDefinition>,
) -> OrchestratorDeps {
    OrchestratorDeps {
        runtime,
        registry,
        clock,
        config: Arc::new(move |_| config.clone()),
        agents: Arc::new(move |_| agents.clone()),
        standing_orders: None,
        landing: FakeLanding::new(),
        fleet_command: "fleet".to_owned(),
        agent_env: Arc::new(BTreeMap::new),
        // the checkout's guard plugin: a role that edits nothing on OpenCode does not start without it
        host: Host::new(
            BTreeMap::new(),
            herdr_fleet_orchestrator::launch::opencode::guard_plugin_dir(),
        ),
        results_dir: root.join("results"),
        plans_dir: None,
        instructions_dir: root.join("instructions"),
        prompt_dir: Some(root.to_path_buf()),
        timings: Timings::default(),
        usage: None,
        models: None,
        on_changed: None,
        events: None,
    }
}

/// orchestrator.test.ts's `setup()`: a fake runtime, a registry in a folder of its own, the config
/// the options give over the defaults, and the timings shortened as TypeScript's are.
pub fn setup(options: SetupOptions) -> Setup {
    let folder = match options.root {
        Some(_) => None,
        None => Some(Folder::new()),
    };
    let root = options
        .root
        .clone()
        .unwrap_or_else(|| folder.as_ref().unwrap().path().to_path_buf());
    let clock: Arc<dyn Clock> = options.clock.unwrap_or_else(|| TestClock::new());
    let runtime = FakeRuntime::new();
    let registry = options.registry.unwrap_or_else(|| {
        Arc::new(RunRegistry::open(
            Some(root.join("runs.json")),
            clock.as_ref(),
        ))
    });
    let events = Arc::new(Mutex::new(Vec::new()));
    let mut deps = deps(
        runtime.clone(),
        registry.clone(),
        &root,
        clock.clone(),
        config(options.config.as_ref()),
        options.agents.unwrap_or_else(default_roles),
    );
    deps.agent_env = Arc::new(|| {
        BTreeMap::from([(
            "HERDR_FLEET_URL".to_owned(),
            "http://127.0.0.1:1".to_owned(),
        )])
    });
    deps.standing_orders = options.standing_orders;
    deps.usage = options.usage;
    deps.models = options.models;
    let landing = FakeLanding::new();
    deps.landing = options.landing.unwrap_or_else(|| landing.clone());
    deps.timings = Timings {
        pre_visual_grace: GRACE,
        ready_screen: Duration::from_millis(300),
        usage_screen: Duration::from_millis(300),
        ..Timings::default()
    };
    if let Some(quiet) = options.quiet {
        deps.timings.quiet = quiet;
    }
    if let Some(draft_retry) = options.draft_retry {
        deps.timings.draft_retry = draft_retry;
    }
    let recorder = events.clone();
    deps.events = Some(Arc::new(move |event| {
        recorder
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(event);
    }));
    let fleet = Orchestrator::new(deps).unwrap();
    Setup {
        fleet,
        runtime,
        registry,
        root,
        clock,
        events,
        landing,
        _folder: folder,
    }
}

/// A spawn as orchestrator.test.ts's `spawn(fleet, extra)` sends it: worker, `do it`, fleet g1, in
/// /work.
pub fn request() -> SpawnRequest {
    SpawnRequest {
        role: "worker".to_owned(),
        task: Some("do it".to_owned()),
        group: Some("g1".to_owned()),
        cwd: Some("/work".to_owned()),
        ..SpawnRequest::default()
    }
}

/// `spawn(fleet, extra)` with the request `extra` made.
pub async fn spawn(
    fleet: &Orchestrator,
    request: SpawnRequest,
) -> Result<AgentRun, OrchestratorError> {
    fleet.spawn(request, &CancellationToken::new()).await
}

/// What an agent writes as its turn's report: report.json beside its handoff (`writeReport`).
pub fn write_report(root: &Path, id: &str, state: &str, summary: &str) {
    let report = serde_json::json!({ "state": state, "summary": summary, "evidence": [] });
    fs::write(
        root.join("results").join(id).join("report.json"),
        report.to_string(),
    )
    .unwrap();
}

/// Lets the tasks the test started run up to where they wait.
pub async fn settle() {
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
}

/// `fleet.wait(...)` started now, as TypeScript's call registers its waiter before it returns: the
/// wait runs as a task, and the test goes on once it is waiting.
pub async fn start_wait(
    fleet: &Orchestrator,
    id: &str,
    timeout_ms: u64,
    group: &str,
) -> tokio::task::JoinHandle<Result<AgentRun, OrchestratorError>> {
    let (fleet, id, group) = (fleet.clone(), id.to_owned(), group.to_owned());
    let waiting = tokio::spawn(async move {
        fleet
            .wait(
                &id,
                Some(timeout_ms),
                Some(&group),
                &CancellationToken::new(),
            )
            .await
    });
    settle().await;
    waiting
}

/// Waits, in 5 ms steps of the paused clock, until `check` holds; fails after 2 s
/// (`until`, orchestrator.test.ts:113-116).
pub async fn until(check: impl Fn() -> bool, label: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while !check() {
        assert!(
            tokio::time::Instant::now() <= deadline,
            "timed out: {label}"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// Sleeps `ms` on the paused clock (`Bun.sleep`).
pub async fn sleep_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}
