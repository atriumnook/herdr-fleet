//! A thread outlives its lead run: a lead whose run failed, or whose turn ended without a report,
//! is taken over by a new run of its lead on another CLI, in the same worktree and on the same
//! branch. The tests named after an `it` are `server/fleet/orchestrator.test.ts`'s describe
//! `a thread outlives its lead run` (22 `it`s), with their expected values; where an expected value
//! differs from TypeScript's, the test says why.

mod common;

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};

use common::{
    FakeLanding, FakeRuntime, Folder, GRACE, LandingAnswers, Prompted, RemoveArgs, TestClock,
    answer, deps, role, sleep_ms, until,
};
use herdr_fleet_orchestrator::Clock;
use herdr_fleet_orchestrator::agents::AgentDefinition;
use herdr_fleet_orchestrator::events::{FleetEvent, RestartEvent, RestartWhy};
use herdr_fleet_orchestrator::fleet::{
    BoxFuture, Orchestrator, OrchestratorError, ThreadRequest, Timings,
};
use herdr_fleet_orchestrator::github::PullRequestReading;
use herdr_fleet_orchestrator::registry::RunRegistry;
use herdr_fleet_orchestrator::runtime::{
    AgentMetadata, AgentRuntime, CreateLocationOptions, RuntimeError, RuntimeFuture,
    RuntimeLocation, StartOptions,
};
use protocol::{
    AgentRun, AgentState, ChecksState, ContractItem, ContractState, FleetAgentKind, LandAction,
    Landed, LandingStep, PullRequest, PullRequestState, ThreadState, TurnOutcome, thread_state,
};
use serde_json::{Value, json};
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// The check a lead taking a thread over is told to make (orchestrator.test.ts:1199).
const NOTE: &str = "Check the worktree, git history and GitHub before repeating any outside action (push, PR, comment).";
/// The header the landing steps go under (orchestrator.test.ts:1451).
const STEPS_HEADER: &str = "[fleet] The person pressed these on the Fleet screen. Each is the person's approval for that step only.";
/// The pull request of the describe's tests (orchestrator.test.ts:1298).
const PR_URL: &str = "https://github.com/o/r/pull/7";

/// `role(name, { agent: "claude", fallbackModels, interactive: true, spawning: true })`.
fn on_claude(name: &str, fallbacks: &[&str]) -> AgentDefinition {
    AgentDefinition {
        agent: FleetAgentKind::Claude,
        fallback_models: (!fallbacks.is_empty())
            .then(|| fallbacks.iter().map(|&model| model.to_owned()).collect()),
        interactive: Some(true),
        spawning: Some(true),
        ..role(name)
    }
}

/// The bundled lead's candidates: claude, then codex (orchestrator.test.ts:1197-1198).
fn lead() -> AgentDefinition {
    on_claude("lead", &["codex:"])
}

/// A lead with a third candidate, pi (orchestrator.test.ts:1252).
fn lead_of_three() -> AgentDefinition {
    on_claude("lead", &["codex:", "pi:"])
}

fn coordinator() -> AgentDefinition {
    on_claude("coordinator", &[])
}

/// What herdr says for each pane, by its agent's name (`states`); `working` when unsaid.
#[derive(Clone, Default)]
struct States(Arc<Mutex<HashMap<String, AgentState>>>);

impl States {
    fn set(&self, run: &AgentRun, state: AgentState) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(run.herdr_name.clone(), state);
    }

    fn of(&self, name: &str) -> AgentState {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(name)
            .copied()
            .unwrap_or(AgentState::Working)
    }
}

type CloseHook = Arc<dyn Fn(String) -> BoxFuture<'static, ()> + Send + Sync>;

/// The fake herdr, with the pane closes a test may hold (TypeScript replaces `runtime.closePane`,
/// orchestrator.test.ts:1687).
struct Hooked {
    fake: Arc<FakeRuntime>,
    closing: Arc<Mutex<Option<CloseHook>>>,
}

impl AgentRuntime for Hooked {
    fn create_location<'a>(
        &'a self,
        options: CreateLocationOptions,
        cancel: &'a CancellationToken,
    ) -> RuntimeFuture<'a, RuntimeLocation> {
        self.fake.create_location(options, cancel)
    }
    fn start(&self, options: StartOptions) -> RuntimeFuture<'_, AgentState> {
        self.fake.start(options)
    }
    fn close_pane<'a>(&'a self, pane_id: &'a str) -> RuntimeFuture<'a, ()> {
        let hook = self
            .closing
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        Box::pin(async move {
            self.fake.close_pane(pane_id).await?;
            if let Some(hook) = hook {
                hook(pane_id.to_owned()).await;
            }
            Ok(())
        })
    }
    fn prompt<'a>(
        &'a self,
        name: &'a str,
        text: &'a str,
        cancel: &'a CancellationToken,
    ) -> RuntimeFuture<'a, AgentState> {
        self.fake.prompt(name, text, cancel)
    }
    fn get<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, AgentState> {
        self.fake.get(name)
    }
    fn read<'a>(&'a self, name: &'a str, lines: u32) -> RuntimeFuture<'a, String> {
        self.fake.read(name, lines)
    }
    fn screen<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, String> {
        self.fake.screen(name)
    }
    fn interrupt<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, ()> {
        self.fake.interrupt(name)
    }
    fn focus<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, ()> {
        self.fake.focus(name)
    }
    fn report_metadata(&self, metadata: AgentMetadata) -> RuntimeFuture<'_, ()> {
        self.fake.report_metadata(metadata)
    }
}

/// The describe's `thread(options)` (orchestrator.test.ts:1201-1216): a setup in the repository
/// /repo at commit abc1234, with the lead and a coordinator unless `agents` says otherwise, where
/// herdr says what `states` holds.
struct Thread {
    fleet: Orchestrator,
    runtime: Arc<FakeRuntime>,
    registry: Arc<RunRegistry>,
    root: PathBuf,
    clock: Arc<dyn Clock>,
    events: Arc<Mutex<Vec<FleetEvent>>>,
    states: States,
    closing: Arc<Mutex<Option<CloseHook>>>,
    _folder: Folder,
}

fn thread() -> Thread {
    thread_with(None, None, |_| {})
}

fn thread_with(
    agents: Option<Vec<AgentDefinition>>,
    config: Option<Value>,
    landing: impl FnOnce(&mut LandingAnswers),
) -> Thread {
    let folder = Folder::new();
    let root = folder.path().to_path_buf();
    let clock: Arc<dyn Clock> = TestClock::new();
    let runtime = FakeRuntime::new();
    let registry = Arc::new(RunRegistry::open(
        Some(root.join("runs.json")),
        clock.as_ref(),
    ));
    let git = FakeLanding::new();
    {
        let mut answers = git.answers();
        answers.git_root = answer(|_: PathBuf| async { Some(PathBuf::from("/repo")) });
        answers.git_head = answer(|_: PathBuf| async { Some("abc1234".to_owned()) });
        landing(&mut answers);
    }
    let mut deps = deps(
        runtime.clone(),
        registry.clone(),
        &root,
        clock.clone(),
        common::config(config.as_ref()),
        agents.unwrap_or_else(|| vec![lead(), coordinator()]),
    );
    let closing = Arc::new(Mutex::new(None));
    deps.runtime = Arc::new(Hooked {
        fake: runtime.clone(),
        closing: closing.clone(),
    });
    deps.agent_env = Arc::new(|| {
        [(
            "HERDR_FLEET_URL".to_owned(),
            "http://127.0.0.1:1".to_owned(),
        )]
        .into()
    });
    deps.landing = git;
    deps.timings = Timings {
        pre_visual_grace: GRACE,
        ready_screen: std::time::Duration::from_millis(300),
        usage_screen: std::time::Duration::from_millis(300),
        ..Timings::default()
    };
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorder = events.clone();
    deps.events = Some(Arc::new(move |event| {
        recorder
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(event);
    }));
    let states = States::default();
    let read = states.clone();
    runtime.on_get(move |name| std::future::ready(Ok(read.of(&name))));
    Thread {
        fleet: Orchestrator::new(deps).unwrap(),
        runtime,
        registry,
        root,
        clock,
        events,
        states,
        closing,
        _folder: folder,
    }
}

impl Thread {
    /// herdr says `state` for the run's pane, and sends the event (`turn`).
    async fn turn(&self, run: &AgentRun, state: AgentState) {
        self.turn_task(run, state).await.unwrap();
    }

    /// `turn` started now, awaited later.
    fn turn_task(&self, run: &AgentRun, state: AgentState) -> JoinHandle<()> {
        self.states.set(run, state);
        let (fleet, pane) = (self.fleet.clone(), run.pane_id.clone());
        tokio::spawn(async move {
            sleep_ms(GRACE.as_millis() as u64 + 5).await;
            fleet.on_pane_status(&pane);
            sleep_ms(30).await;
        })
    }

    /// The agent of `run` writes `file` in its result folder (`write`).
    fn write(&self, run: &AgentRun, file: &str, text: &str) {
        fs::write(self.root.join("results").join(&run.id).join(file), text).unwrap();
    }

    /// The agent of `run` writes its report (`report`).
    fn report(&self, run: &AgentRun, value: Value) {
        self.write(run, "report.json", &value.to_string());
    }

    /// The report `{ state, summary, evidence: [] }`.
    fn report_state(&self, run: &AgentRun, state: &str, summary: &str) {
        self.report(
            run,
            json!({ "state": state, "summary": summary, "evidence": [] }),
        );
    }

    /// What the run was given, in order (`promptsTo`).
    fn to(&self, run: &AgentRun) -> Vec<String> {
        self.runtime
            .prompts()
            .into_iter()
            .filter(|prompt| prompt.name == run.herdr_name)
            .map(|prompt| prompt.text)
            .collect()
    }

    /// The run `id` as the registry holds it now.
    fn run(&self, id: &str) -> AgentRun {
        self.registry.get(id).unwrap()
    }

    /// The news about `run` waiting in the outbox.
    fn news(&self, run: &AgentRun) -> Vec<String> {
        herdr_fleet_orchestrator::outbox::Outbox::open(
            Some(self.root.join("fleet-outbox.json")),
            self.clock.clone(),
        )
        .unwrap()
        .pending_where(|notice| notice.about == run.id && notice.slot == "news")
        .into_iter()
        .map(|notice| notice.text)
        .collect()
    }

    /// The run that took the thread over from `run`.
    fn next(&self, run: &AgentRun) -> AgentRun {
        let id = self.run(&run.id).replaced_by.expect("a new run took over");
        self.run(&id)
    }

    fn restarts(&self) -> Vec<RestartEvent> {
        self.events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .filter_map(|event| match event {
                FleetEvent::Restart(restart) => Some(restart.clone()),
                _ => None,
            })
            .collect()
    }

    /// `fleet.startThread({ title, task, cwd: "/repo", callerRun })`.
    async fn start_thread(&self, title: &str, task: &str, caller: Option<&AgentRun>) -> AgentRun {
        self.fleet
            .start_thread(
                ThreadRequest {
                    title: title.to_owned(),
                    task: Some(task.to_owned()),
                    cwd: Some("/repo".to_owned()),
                    caller_run: caller.map(|run| run.id.clone()),
                    ..ThreadRequest::default()
                },
                &CancellationToken::new(),
            )
            .await
            .unwrap()
    }

    /// `fleet.startProject({ task: "go", cwd: "/repo" })`.
    async fn start_project(&self) -> AgentRun {
        self.fleet
            .start_project("go", Some("/repo"), None, &CancellationToken::new())
            .await
            .unwrap()
    }

    async fn send(&self, id: &str, message: &str) -> AgentRun {
        self.fleet
            .send(id, message, None, &CancellationToken::new())
            .await
            .unwrap()
    }

    async fn land(&self, id: &str, action: LandAction) -> AgentRun {
        self.land_task(id, action).await.unwrap().unwrap()
    }

    /// `fleet.land(id, action)` started now, awaited later.
    fn land_task(
        &self,
        id: &str,
        action: LandAction,
    ) -> JoinHandle<Result<AgentRun, OrchestratorError>> {
        let (fleet, id) = (self.fleet.clone(), id.to_owned());
        tokio::spawn(async move {
            fleet
                .land(&id, action, &[], None, &CancellationToken::new())
                .await
        })
    }

    async fn threads(&self) -> Vec<String> {
        self.fleet
            .threads(None, Some("/repo"))
            .await
            .unwrap()
            .into_iter()
            .map(|thread| thread.run.id)
            .collect()
    }

    /// The prompts to the coordinator that hand it Merge into main.
    fn merges_to(&self, coordinator: &AgentRun) -> usize {
        self.to(coordinator)
            .iter()
            .filter(|text| text.contains("Merge into main"))
            .count()
    }

    /// A coordinator, and a thread of its whose lead ended a turn reporting ready.
    async fn ready(&self) -> (AgentRun, AgentRun) {
        let coordinator = self.start_project().await;
        self.turn(&coordinator, AgentState::Idle).await;
        let first = self.start_thread("Fix", "t", Some(&coordinator)).await;
        self.report_state(&first, "ready", "Fixed.");
        self.turn(&first, AgentState::Idle).await;
        (coordinator, first)
    }

    /// The lead of `first` is sent `go on`, and that turn fails on an API error the CLI gave up on.
    async fn fail_next_turn(&self, first: &AgentRun) {
        self.turn(first, AgentState::Working).await;
        self.send(&first.id, "go on").await;
        self.runtime.set_output("API Error: 529 overloaded");
    }

    /// A server started again over the same folder (orchestrator.test.ts:1475-1480): a new
    /// registry read from runs.json, the default config, the lead and the coordinator, and git on
    /// main.
    fn restarted(&self) -> Orchestrator {
        let registry = Arc::new(RunRegistry::open(
            Some(self.root.join("runs.json")),
            self.clock.as_ref(),
        ));
        let mut deps = deps(
            self.runtime.clone(),
            registry,
            &self.root,
            self.clock.clone(),
            common::config(None),
            vec![lead(), coordinator()],
        );
        let git = FakeLanding::new();
        git.answers().git_branch = answer(|_: PathBuf| async { Some("main".to_owned()) });
        deps.landing = git;
        deps.timings = Timings {
            pre_visual_grace: GRACE,
            ..Timings::default()
        };
        Orchestrator::new(deps).unwrap()
    }
}

/// A gate a test holds a fake call at until it lets it go.
#[derive(Clone)]
struct Gate(Arc<Semaphore>);

impl Gate {
    fn new() -> Gate {
        Gate(Arc::new(Semaphore::new(0)))
    }

    async fn pass(&self) {
        let _ = self.0.acquire().await;
    }

    fn open(&self) {
        self.0.add_permits(1);
    }
}

/// A flag a fake call raises.
#[derive(Clone, Default)]
struct Flag(Arc<AtomicBool>);

impl Flag {
    fn raise(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    fn lower(&self) {
        self.0.store(false, Ordering::SeqCst);
    }

    fn up(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// codex starts only once `gate` opens, and raises `starting` as it waits; the others start.
fn hold_codex(t: &Thread, gate: &Gate, starting: &Flag) {
    let (gate, starting) = (gate.clone(), starting.clone());
    t.runtime.on_start(move |options: StartOptions| {
        let (gate, starting) = (gate.clone(), starting.clone());
        async move {
            if options.kind == FleetAgentKind::Codex {
                starting.raise();
                gate.pass().await;
            }
            Ok(AgentState::Idle)
        }
    });
}

/// The pull request #7 as the run keeps it.
fn pr7(state: PullRequestState) -> PullRequest {
    PullRequest {
        number: 7,
        url: PR_URL.to_owned(),
        state,
        checks: ChecksState::Pass,
        failing: None,
    }
}

/// The merge step the coordinator is handed for the thread `first` onto main
/// (orchestrator.test.ts:1452).
fn merge_step(first: &AgentRun) -> String {
    let id = &first.id;
    format!(
        "- Merge into main for thread \"Fix\" ({id}, fleet/{id}): when this checkout is clean and on main, git merge --no-ff fleet/{id}. On a conflict, git merge --abort and tell the person."
    )
}

fn step(run: &AgentRun) -> Option<(LandAction, Option<bool>)> {
    run.landing
        .as_ref()
        .map(|step: &LandingStep| (step.action, step.sent))
}

/// The plan of the describe's plan tests (orchestrator.test.ts:1358, :1407): one claim on the code
/// of src/retry.ts.
fn plan_value() -> Value {
    json!({ "title": "Retry limit", "claims": [{
        "text": "A failed send is tried three times.",
        "exhibit": { "kind": "code", "path": "src/retry.ts", "start": 1 }
    }] })
}

/// A thread's worktree that is a real folder holding src/retry.ts, which the plan's code is read
/// from (orchestrator.test.ts:1351-1356).
fn with_tree(t: &Thread) -> Folder {
    let tree = Folder::new();
    fs::create_dir(tree.path().join("src")).unwrap();
    fs::write(
        tree.path().join("src").join("retry.ts"),
        "export const RETRIES = 3;\n",
    )
    .unwrap();
    let worktree = tree.path().to_string_lossy().into_owned();
    let panes = Arc::new(AtomicUsize::new(0));
    t.runtime.on_create_location(move |options, _| {
        let pane = panes.fetch_add(1, Ordering::SeqCst);
        let cwd = if options.worktree {
            worktree.clone()
        } else {
            options.cwd.clone()
        };
        std::future::ready(Ok(RuntimeLocation {
            pane_id: format!("w1:p{pane}"),
            workspace_id: None,
            cwd,
        }))
    });
    tree
}

// orchestrator.test.ts: "goes on in a new run on another CLI when its lead's turn ended without a report, in the same worktree, with the recovery note"
#[tokio::test(start_paused = true)]
async fn goes_on_in_a_new_run_on_another_cli_when_its_leads_turn_ended_without_a_report_in_the_same_worktree_with_the_recovery_note()
 {
    let t = thread();
    let first = t
        .start_thread("Fix", "Fix the duplicate notification.", None)
        .await;
    // a HANDOFF that says PASS is prose: without report.json the turn has no report
    t.write(&first, "handoff.md", "## HANDOFF\nPASS — bun test: 12 pass");
    t.write(
        &first,
        "contract.md",
        "- [x] A1 no duplicate — evidence: test\n",
    );
    t.turn(&first, AgentState::Idle).await;
    let old = t.run(&first.id);
    assert_eq!(
        old.outcome,
        Some(TurnOutcome::NoReport {
            problem: "report.json is missing.".to_owned()
        })
    );
    assert!(old.replaced_by.is_some());
    assert_eq!(old.state, AgentState::Stopped);
    assert!(t.runtime.closed().contains(&first.pane_id));
    let next = t.next(&first);
    let branch = format!("fleet/{}", first.id);
    assert_eq!(
        (
            next.role.as_str(),
            next.name.as_str(),
            next.agent,
            next.group.as_str(),
            next.branch.as_deref(),
            next.thread.as_deref(),
            next.project.as_deref(),
            next.base.as_deref(),
            next.cwd.as_str(),
            next.depth,
            next.state,
        ),
        (
            "lead",
            "Fix",
            FleetAgentKind::Codex,
            first.group.as_str(),
            Some(branch.as_str()),
            Some(first.id.as_str()),
            Some("/repo"),
            Some("abc1234"),
            first.cwd.as_str(),
            first.depth,
            AgentState::Working,
        )
    );
    // no second worktree: the new run opens in the thread's own
    let location = t.runtime.locations()[1].clone();
    assert_eq!(
        (location.cwd.as_str(), location.worktree),
        (first.cwd.as_str(), false)
    );
    assert_eq!(location.path, None);
    let task = t.to(&next)[0].clone();
    assert!(
        task.starts_with(&format!(
            "[fleet] You take over the thread \"Fix\" from run {} on claude, which ended its turn without a report (report.json is missing.). This comes from the fleet, not from the person.",
            first.id
        )),
        "{task}"
    );
    assert!(task.contains(NOTE), "{task}");
    let result_dir = t.root.join("results").join(&first.id);
    assert!(
        task.contains(result_dir.to_string_lossy().as_ref()),
        "{task}"
    );
    assert!(
        task.contains("The thread's task:\n\nFix the duplicate notification."),
        "{task}"
    );
    // its first turn's message was the task: it is not repeated
    assert!(!task.contains("The fleet's last message"), "{task}");
    assert_eq!(
        fs::read_to_string(t.root.join("results").join(&next.id).join("contract.md")).unwrap(),
        "- [x] A1 no duplicate — evidence: test\n"
    );
    // the thread list shows the contract as the turn before left it, while the new run works
    assert_eq!(
        next.contract,
        Some(vec![ContractItem {
            id: "A1".to_owned(),
            state: ContractState::Met
        }])
    );
    assert_eq!(
        t.restarts(),
        vec![RestartEvent {
            run: first.id.clone(),
            project: "/repo".to_owned(),
            agent: FleetAgentKind::Claude,
            why: RestartWhy::NoReport,
            by: Some(next.id.clone()),
            to: Some(FleetAgentKind::Codex),
            error: None,
        }]
    );
    // the thread is known by its first id: the fleet's commands and the thread list reach its current lead
    assert_eq!(t.fleet.get(&first.id, None).unwrap().id, next.id);
    assert_eq!(t.threads().await, vec![next.id.clone()]);
}

// orchestrator.test.ts: "goes on in a new run when its lead's run failed, with the fleet's last message, and stops once every CLI of the role failed since its last report"
#[tokio::test(start_paused = true)]
async fn goes_on_in_a_new_run_when_its_leads_run_failed_with_the_fleets_last_message_and_stops_once_every_cli_of_the_role_failed_since_its_last_report()
 {
    let t = thread_with(Some(vec![lead_of_three()]), None, |_| {});
    let first = t.start_thread("Fix", "Fix it.", None).await;
    t.turn(&first, AgentState::Idle).await;
    let second = t.next(&first);
    t.turn(&second, AgentState::Working).await;
    t.send(&second.id, "Also update the docs.").await;
    // an API failure the CLI gave up on: the run failed
    t.runtime
        .set_output("■ stream disconnected before completion");
    t.turn(&second, AgentState::Idle).await;
    let failed = t.run(&second.id);
    assert_eq!(
        (failed.state, failed.last_error.as_deref()),
        (
            AgentState::Failed,
            Some("stream disconnected before completion")
        )
    );
    let third = t.next(&second);
    let branch = format!("fleet/{}", first.id);
    assert_eq!(
        (
            third.agent,
            third.thread.as_deref(),
            third.branch.as_deref(),
            third.avoid.clone()
        ),
        (
            FleetAgentKind::Pi,
            Some(first.id.as_str()),
            Some(branch.as_str()),
            Some(vec![FleetAgentKind::Claude, FleetAgentKind::Codex])
        )
    );
    let task = t.to(&third)[0].clone();
    assert!(
        task.starts_with(&format!(
            "[fleet] You take over the thread \"Fix\" from run {} on codex, which failed: stream disconnected before completion.",
            second.id
        )),
        "{task}"
    );
    assert!(task.contains("The thread's task:\n\nFix it."), "{task}");
    assert!(
        task.contains("The fleet's last message to the run before:\n\nAlso update the docs."),
        "{task}"
    );
    // every CLI of the role failed since the thread's last report: nothing is left to restart on
    t.runtime.set_output("agent output");
    t.turn(&third, AgentState::Idle).await;
    assert_eq!(t.run(&third.id).replaced_by, None);
    assert_eq!(t.run(&third.id).state, AgentState::Idle);
    let restarts: Vec<(RestartWhy, FleetAgentKind, String)> = t
        .restarts()
        .into_iter()
        .map(|e| {
            let to = e.to.map(|to| to.name().to_owned());
            (e.why, e.agent, to.or(e.error).unwrap_or_default())
        })
        .collect();
    assert_eq!(
        restarts,
        vec![
            (RestartWhy::NoReport, FleetAgentKind::Claude, "codex".to_owned()),
            (RestartWhy::Failed, FleetAgentKind::Codex, "pi".to_owned()),
            (
                RestartWhy::NoReport,
                FleetAgentKind::Pi,
                "No candidate is usable: default: the caller keeps claude out; codex:: the caller keeps codex out; pi:: the caller keeps pi out".to_owned()
            ),
        ]
    );
    assert_eq!(thread_state(&t.run(&third.id)), ThreadState::Waiting);
}

// orchestrator.test.ts: "stays with its lead when the report says ready, blocked, failed or waiting: a failed report waits for the person"
#[tokio::test(start_paused = true)]
async fn stays_with_its_lead_when_the_report_says_ready_blocked_failed_or_waiting_a_failed_report_waits_for_the_person()
 {
    let t = thread();
    let mut runs = Vec::new();
    for state in ["ready", "blocked", "failed", "waiting"] {
        let run = t.start_thread(state, "t", None).await;
        let mut report = json!({ "state": state, "summary": format!("{state} summary"), "evidence": ["bun test"] });
        if state == "blocked" {
            report["human_action"] = json!("Keep the old API?");
        }
        t.report(&run, report);
        t.turn(&run, AgentState::Idle).await;
        runs.push(run);
    }
    let replaced: Vec<Option<String>> = runs.iter().map(|run| t.run(&run.id).replaced_by).collect();
    assert_eq!(replaced, vec![None, None, None, None]);
    let states: Vec<ThreadState> = runs
        .iter()
        .map(|run| thread_state(&t.run(&run.id)))
        .collect();
    assert_eq!(
        states,
        vec![
            ThreadState::Review,
            ThreadState::Waiting,
            ThreadState::Waiting,
            ThreadState::Idle
        ]
    );
}

// orchestrator.test.ts: "hands the thread's pull request and landing step to the new run, so the thread is not landed twice"
#[tokio::test(start_paused = true)]
async fn hands_the_threads_pull_request_and_landing_step_to_the_new_run_so_the_thread_is_not_landed_twice()
 {
    let removed: Arc<Mutex<Vec<String>>> = Arc::default();
    let merged = Flag::default();
    let (saw, gh) = (removed.clone(), merged.clone());
    let t = thread_with(None, None, move |a| {
        a.git_branch = answer(|_: PathBuf| async { Some("main".to_owned()) });
        a.branch_head = answer(|_: (PathBuf, String)| async { Some("c0ffee".to_owned()) });
        a.read_pull_request = answer(move |_: (PathBuf, String)| {
            let state = if gh.up() {
                PullRequestState::Merged
            } else {
                PullRequestState::Open
            };
            std::future::ready(Ok(Some(PullRequestReading {
                pr: pr7(state),
                head: "c0ffee".to_owned(),
            })))
        });
        a.remove_thread = answer(move |(_, worktree, branch, _): RemoveArgs| {
            saw.lock()
                .unwrap()
                .push(format!("{} {branch}", worktree.display()));
            std::future::ready(Ok(()))
        });
    });
    let first = t.start_thread("Fix", "t", None).await;
    t.registry
        .update(&first.id, |run| {
            run.pr = Some(pr7(PullRequestState::Open));
            run.landing = Some(LandingStep {
                action: LandAction::MergePr,
                at: 1,
                sent: Some(true),
                error: None,
            });
        })
        .unwrap();
    t.turn(&first, AgentState::Idle).await;
    let next = t.next(&first);
    assert_eq!(
        next.pr.as_ref().map(|pr| (pr.number, pr.state)),
        Some((7, PullRequestState::Open))
    );
    assert_eq!(step(&next), Some((LandAction::MergePr, Some(true))));
    assert_eq!(t.run(&first.id).landing, None);
    // the new run's turn ends (no CLI is left to restart it on), then the person merges it on
    // GitHub: the thread closes once, on the run that leads it
    t.turn(&next, AgentState::Idle).await;
    merged.raise();
    t.fleet.refresh_pull_requests().await;
    assert_eq!(
        *removed.lock().unwrap(),
        vec![format!(
            "/repo/.herdr-fleet/worktrees/{0} fleet/{0}",
            first.id
        )]
    );
    assert_eq!(t.run(&next.id).landed, Some(Landed::Merged));
    assert_eq!(t.run(&first.id).landed, None);
}

// orchestrator.test.ts: "reads no report from a turn its lead started itself and ended without one, though the turn before left one"
#[tokio::test(start_paused = true)]
async fn reads_no_report_from_a_turn_its_lead_started_itself_and_ended_without_one_though_the_turn_before_left_one()
 {
    let t = thread_with(None, Some(json!({ "autonomous": true })), |_| {});
    let first = t.start_thread("Fix", "t", None).await;
    t.report_state(&first, "waiting", "Waiting for the helper.");
    t.turn(&first, AgentState::Idle).await;
    assert_eq!(t.run(&first.id).replaced_by, None);
    // the helper's result wakes the lead: the fleet sent nothing, and this turn writes no report
    t.turn(&first, AgentState::Working).await;
    t.turn(&first, AgentState::Idle).await;
    assert_eq!(
        t.run(&first.id).outcome,
        Some(TurnOutcome::NoReport {
            problem: "report.json is missing.".to_owned()
        })
    );
    assert!(t.run(&first.id).replaced_by.is_some());
}

// Not in TypeScript, whose `settleUnsentTurn` reads the files whatever the fleet sent meanwhile
// (ADR 0267-restart, #344): a step the fleet sends while the end of a turn it did not send is
// read cleared the turn's files for its own turn. That turn's settlement reads them; the turn
// before is not read as one that left no report, and the thread does not start again under it.
#[tokio::test(start_paused = true)]
async fn leaves_the_files_of_a_turn_its_lead_started_itself_to_a_step_the_fleet_sent_before_that_turn_is_settled()
 {
    const READY: &str = "→ Plan, search, build anything";
    let (read_branch, hold_branch, reading_branch) =
        (Gate::new(), Flag::default(), Flag::default());
    let (gate, held, raised) = (
        read_branch.clone(),
        hold_branch.clone(),
        reading_branch.clone(),
    );
    // a lead on cursor, whose turn's end is read from its screen before it is settled
    let cursor_lead = AgentDefinition {
        agent: FleetAgentKind::Cursor,
        ..lead()
    };
    let t = thread_with(
        Some(vec![cursor_lead, coordinator()]),
        Some(json!({ "autonomous": true })),
        move |a| {
            a.git_branch = answer(move |_: PathBuf| {
                let (gate, held, raised) = (gate.clone(), held.clone(), raised.clone());
                async move {
                    // none at the start: the thread records no base, and a step reads it
                    if !held.up() {
                        return None;
                    }
                    raised.raise();
                    gate.pass().await;
                    Some("main".to_owned())
                }
            });
        },
    );
    let (read_screen, hold_screen, reading_screen) =
        (Gate::new(), Flag::default(), Flag::default());
    let (gate, held, raised) = (
        read_screen.clone(),
        hold_screen.clone(),
        reading_screen.clone(),
    );
    t.runtime.on_read(move |_| {
        let (gate, held, raised) = (gate.clone(), held.clone(), raised.clone());
        async move {
            // only the first read once held: the settlement's look at the screen
            if held.up() {
                held.lower();
                raised.raise();
                gate.pass().await;
            }
            Ok(READY.to_owned())
        }
    });
    let first = t.start_thread("Fix", "t", None).await;
    t.report_state(&first, "waiting", "Waiting for the helper.");
    t.turn(&first, AgentState::Idle).await;
    // the helper's result wakes the lead, and the person presses Create PR, which reads the branch
    t.turn(&first, AgentState::Working).await;
    hold_branch.raise();
    let pressed = t.land_task(&first.id, LandAction::Pr);
    until(|| reading_branch.up(), "the base branch being read").await;
    // the woken turn ends, and its end is read while the step goes out
    hold_screen.raise();
    t.turn(&first, AgentState::Idle).await;
    until(|| reading_screen.up(), "the screen being read").await;
    read_branch.open();
    pressed.await.unwrap().unwrap();
    assert!(t.to(&first).last().unwrap().contains("gh pr create"));
    t.states.set(&first, AgentState::Working);
    read_screen.open();
    sleep_ms(1000).await;
    assert!(
        matches!(t.run(&first.id).outcome, Some(TurnOutcome::Report(_))),
        "{:?}",
        t.run(&first.id).outcome
    );
    assert!(t.restarts().is_empty());
    assert_eq!(t.run(&first.id).replaced_by, None);
    assert!(t.runtime.closed().is_empty());
}

/// Where the settlement of a turn a lead started itself waits while the fleet sends that lead
/// Create PR: at its look at the screen, once it read the turn's files, or at the thread's lock,
/// which the step holds while it reads the base branch.
#[derive(Clone, Copy, PartialEq)]
enum HeldAt {
    Screen,
    ThreadLock,
}

/// A fake call held once `held` is raised: it raises `reached` and waits for `gate`, once.
#[derive(Clone)]
struct Hold {
    gate: Gate,
    held: Flag,
    reached: Flag,
}

impl Hold {
    fn new() -> Hold {
        let (gate, held, reached) = (Gate::new(), Flag::default(), Flag::default());
        Hold {
            gate,
            held,
            reached,
        }
    }

    /// Whether the call was held, once it was let go.
    async fn pass(&self) -> bool {
        if !self.held.up() {
            return false;
        }
        self.held.lower();
        self.reached.raise();
        self.gate.pass().await;
        true
    }
}

/// A thread without the person whose lead, on claude, ended a turn it started itself without a
/// report, and Create PR sent to that lead while that turn's settlement waits `at` (#358). The
/// lead works on the step when this returns; with `HeldAt::Screen`, the settlement still waits
/// for the gate that comes back.
async fn create_pr_sent_while_settling(at: HeldAt) -> (Thread, AgentRun, Gate) {
    let (branch, screen) = (Hold::new(), Hold::new());
    let hold = branch.clone();
    let t = thread_with(None, Some(json!({ "autonomous": true })), move |a| {
        a.git_branch = answer(move |_: PathBuf| {
            let hold = hold.clone();
            // none at the start: the thread records no base, and a step reads it
            async move { hold.pass().await.then(|| "main".to_owned()) }
        });
    });
    let hold = screen.clone();
    t.runtime.on_read(move |_| {
        let hold = hold.clone();
        async move {
            // on claude, which herdr reports right, the settlement's first look at the screen is
            // once it read the turn's files
            hold.pass().await;
            Ok("agent output".to_owned())
        }
    });
    let first = t.start_thread("Fix", "t", None).await;
    t.report_state(&first, "waiting", "Waiting for the helper.");
    t.turn(&first, AgentState::Idle).await;
    // the helper's result wakes the lead, and the person presses Create PR, which reads the branch
    // under the thread's lock
    t.turn(&first, AgentState::Working).await;
    branch.held.raise();
    let pressed = t.land_task(&first.id, LandAction::Pr);
    until(|| branch.reached.up(), "the base branch being read").await;
    // the woken turn ends without a report
    match at {
        HeldAt::Screen => {
            screen.held.raise();
            t.turn(&first, AgentState::Idle).await;
            until(|| screen.reached.up(), "the screen being read").await;
        }
        HeldAt::ThreadLock => {
            t.turn(&first, AgentState::Idle).await;
            // the settlement read the turn and went as far as it could: to the lock the step
            // holds, before it starts the thread again
            assert_eq!(
                t.run(&first.id).outcome,
                Some(TurnOutcome::NoReport {
                    problem: "report.json is missing.".to_owned()
                })
            );
            assert!(t.restarts().is_empty());
        }
    }
    branch.gate.open();
    pressed.await.unwrap().unwrap();
    assert!(t.to(&first).last().unwrap().contains("gh pr create"));
    t.states.set(&first, AgentState::Working);
    (t, first, screen.gate)
}

// Not in TypeScript, whose `settleUnsentTurn` starts the thread again whatever the fleet sent
// meanwhile (#358): a turn that left no report is settled while the fleet sends its lead Create
// PR. Whether the thread starts again is that step's turn's to settle: the run before keeps its
// pane, and once that turn ends without a report too, its settlement starts the thread again with
// the step as the fleet's last message.
#[tokio::test(start_paused = true)]
async fn leaves_the_restart_to_the_turn_of_a_step_the_fleet_sent_while_a_turn_that_left_no_report_was_settled()
 {
    let (t, first, read_screen) = create_pr_sent_while_settling(HeldAt::Screen).await;
    read_screen.open();
    sleep_ms(1000).await;
    assert!(t.restarts().is_empty());
    assert_eq!(t.run(&first.id).replaced_by, None);
    assert!(t.runtime.closed().is_empty());
    // nor is the turn before news while the step's turn runs: the news is still of the turn
    // before it
    let news = t.news(&first);
    assert!(
        news.len() == 1 && news[0].contains("ended its turn: waiting"),
        "{news:?}"
    );
    // the step's turn ends without a report too
    t.turn(&first, AgentState::Idle).await;
    let next = t.next(&first);
    let task = t.to(&next)[0].clone();
    assert!(
        task.contains("The fleet's last message to the run before:\n\n"),
        "{task}"
    );
    assert!(task.contains("gh pr create"), "{task}");
    assert_eq!(t.runtime.closed(), vec![first.pane_id.clone()]);
}

// Not in TypeScript (#358): the step is sent once the settlement read the turn that left no report,
// while it waits for the thread's lock to start the thread again. The settlement looks under that
// lock: a turn of the fleet's is on its way, and the thread does not start again under it.
#[tokio::test(start_paused = true)]
async fn starts_the_thread_again_under_its_lock_only_when_no_step_went_out_while_the_settlement_waited_for_it()
 {
    let (t, first, _) = create_pr_sent_while_settling(HeldAt::ThreadLock).await;
    sleep_ms(1000).await;
    assert!(t.restarts().is_empty());
    assert_eq!(t.run(&first.id).replaced_by, None);
    assert!(t.runtime.closed().is_empty());
}

// #358's first finding: the settlement of a turn its lead started itself writes the turn it read
// once it looked at the screen. A step's turn that ends meanwhile is settled only after it, one
// settlement at a time per run (ADR 0358-settlement-and-sent-turn): the step's report is the one
// the run keeps.
#[tokio::test(start_paused = true)]
async fn settles_a_steps_turn_that_ended_while_a_turn_before_it_was_settled_after_that_settlement()
{
    let (t, first, read_screen) = create_pr_sent_while_settling(HeldAt::Screen).await;
    t.report_state(&first, "ready", "Opened the pull request.");
    t.turn(&first, AgentState::Idle).await;
    // the step's turn waits for the settlement before it
    let summary = |run: &AgentRun| match &run.outcome {
        Some(TurnOutcome::Report(report)) => report.summary.clone(),
        other => format!("{other:?}"),
    };
    assert_eq!(summary(&t.run(&first.id)), "Waiting for the helper.");
    read_screen.open();
    sleep_ms(1000).await;
    assert_eq!(summary(&t.run(&first.id)), "Opened the pull request.");
    assert!(t.restarts().is_empty());
    assert_eq!(t.run(&first.id).replaced_by, None);
    assert!(t.runtime.closed().is_empty());
}

// orchestrator.test.ts: "hands a landing step its lead did not finish to the new run, unjudged, and judges it when that run's turn ends"
#[tokio::test(start_paused = true)]
async fn hands_a_landing_step_its_lead_did_not_finish_to_the_new_run_unjudged_and_judges_it_when_that_runs_turn_ends()
 {
    let opened = Flag::default();
    let gh = opened.clone();
    let t = thread_with(None, None, move |a| {
        a.git_branch = answer(|_: PathBuf| async { Some("main".to_owned()) });
        a.read_pull_request = answer(move |_: (PathBuf, String)| {
            let reading = gh.up().then(|| PullRequestReading {
                pr: PullRequest {
                    number: 70,
                    url: "https://github.com/o/r/pull/70".to_owned(),
                    state: PullRequestState::Open,
                    checks: ChecksState::Pending,
                    failing: None,
                },
                head: "c0ffee".to_owned(),
            });
            std::future::ready(Ok(reading))
        });
    });
    let first = t.start_thread("Fix", "t", None).await;
    t.report_state(&first, "ready", "Fixed.");
    t.turn(&first, AgentState::Idle).await;
    t.land(&first.id, LandAction::Pr).await;
    // the lead's turn ends without a report, and without the pull request
    t.turn(&first, AgentState::Idle).await;
    let next = t.next(&first);
    assert_eq!(step(&next), Some((LandAction::Pr, Some(true))));
    assert_eq!(next.landing.as_ref().unwrap().error, None);
    let task = t.to(&next)[0].clone();
    assert!(
        task.contains(
            "The fleet's last message to the run before:\n\n[fleet] The person pressed Create PR"
        ),
        "{task}"
    );
    opened.raise();
    t.report_state(&next, "ready", "Opened #70.");
    t.turn(&next, AgentState::Idle).await;
    let landed = t.run(&next.id);
    assert_eq!(landed.landing, None);
    assert_eq!(
        landed.pr.as_ref().map(|pr| (pr.number, pr.state)),
        Some((70, PullRequestState::Open))
    );
}

// orchestrator.test.ts: "keeps a plan open across a restart: the new run's turn waiting on it does not close it"
#[tokio::test(start_paused = true)]
async fn keeps_a_plan_open_across_a_restart_the_new_runs_turn_waiting_on_it_does_not_close_it() {
    let t = thread();
    let _tree = with_tree(&t);
    let first = t.start_thread("Fix", "t", None).await;
    t.fleet.submit_plan(&first.id, &plan_value(), None).unwrap();
    // the lead handed over its plan, then its turn ended without a report
    t.turn(&first, AgentState::Idle).await;
    let next = t.next(&first);
    let mark = next.plan.clone().unwrap();
    assert_eq!(
        (mark.version, mark.asks, mark.answered_at, mark.closed_at),
        (1, 0, None, None)
    );
    t.report(
        &next,
        json!({ "state": "blocked", "summary": "The plan waits for the person.", "evidence": [], "human_action": "Answer the plan in the Plan tab." }),
    );
    t.turn(&next, AgentState::Idle).await;
    assert_eq!(t.run(&next.id).plan.unwrap().closed_at, None);
    assert_eq!(t.fleet.plan(&first.id, None).unwrap().closed_at, None);
    let kept: Value = serde_json::from_str(
        &fs::read_to_string(t.root.join("fleet-plans").join(format!("{}.json", next.id))).unwrap(),
    )
    .unwrap();
    assert_eq!(kept.get("closedAt"), None);
}

// codex's review of #267 (no `it` of TypeScript's, whose `carried` and `carryFiles` copy the plan
// once as well): a plan the lead hands over while its new run starts is the thread's plan once the
// new run holds the thread, as `sends a message for the old run ...` hands a message to it
#[tokio::test(start_paused = true)]
async fn hands_a_plan_handed_over_to_the_old_run_while_the_new_run_starts_to_the_new_run() {
    let t = thread();
    let _tree = with_tree(&t);
    let first = t.start_thread("Fix", "t", None).await;
    let (gate, starting) = (Gate::new(), Flag::default());
    hold_codex(&t, &gate, &starting);
    let failing = t.turn_task(&first, AgentState::Idle);
    until(|| starting.up(), "the new lead starting").await;
    let plan = t.fleet.submit_plan(&first.id, &plan_value(), None).unwrap();
    assert_eq!(plan.version, 1);
    gate.open();
    failing.await.unwrap();
    let next = t.next(&first);
    let mark = next.plan.clone().expect("the new run holds the plan");
    assert_eq!((mark.version, mark.closed_at), (1, None));
    assert_eq!(t.fleet.plan(&first.id, None).unwrap().version, 1);
}

// orchestrator.test.ts: "sends a message for the old run, made while the new run starts, to the new run"
#[tokio::test(start_paused = true)]
async fn sends_a_message_for_the_old_run_made_while_the_new_run_starts_to_the_new_run() {
    let t = thread();
    let first = t.start_thread("Fix", "t", None).await;
    let gate = Gate::new();
    let held = gate.clone();
    t.runtime.on_create_location(move |options, _| {
        let held = held.clone();
        async move {
            held.pass().await;
            Ok(RuntimeLocation {
                pane_id: "w1:p9".to_owned(),
                workspace_id: None,
                cwd: options.cwd,
            })
        }
    });
    let settling = t.turn_task(&first, AgentState::Idle);
    until(
        || t.runtime.locations().len() == 2,
        "the new run's pane asked for",
    )
    .await;
    let (fleet, id) = (t.fleet.clone(), first.id.clone());
    let sent = tokio::spawn(async move {
        fleet
            .send(
                &id,
                "Also update the docs.",
                None,
                &CancellationToken::new(),
            )
            .await
    });
    gate.open();
    settling.await.unwrap();
    let next = t.next(&first);
    assert_eq!(sent.await.unwrap().unwrap().id, next.id);
    assert_eq!(
        t.to(&next).last().map(String::as_str),
        Some("Also update the docs.")
    );
}

// orchestrator.test.ts: "hides a candidate that failed to start in a restart behind the run that took the thread over, without the landing step it was handed"
#[tokio::test(start_paused = true)]
async fn hides_a_candidate_that_failed_to_start_in_a_restart_behind_the_run_that_took_the_thread_over_without_the_landing_step_it_was_handed()
 {
    let t = thread_with(Some(vec![lead_of_three()]), None, |_| {});
    let first = t.start_thread("Fix", "t", None).await;
    // a merge the person pressed waits for the coordinator while the restart runs
    t.registry
        .update(&first.id, |run| {
            run.landing = Some(LandingStep {
                action: LandAction::Merge,
                at: 1,
                sent: Some(false),
                error: None,
            });
        })
        .unwrap();
    t.runtime.on_start(|options: StartOptions| async move {
        if options.kind == FleetAgentKind::Codex {
            return Err(RuntimeError::StartFailed("codex is signed out".to_owned()));
        }
        Ok(AgentState::Idle)
    });
    t.turn(&first, AgentState::Idle).await;
    let next = t.next(&first);
    assert_eq!(next.agent, FleetAgentKind::Pi);
    let failed = t
        .registry
        .all()
        .into_iter()
        .find(|run| run.agent == FleetAgentKind::Codex)
        .unwrap();
    assert_eq!(
        (failed.state, failed.replaced_by.as_deref()),
        (AgentState::Failed, Some(next.id.as_str()))
    );
    // only the thread's lead holds the merge: the coordinator is not handed it twice, nor the
    // thread closed on a hidden run
    let holders: Vec<String> = t
        .registry
        .all()
        .into_iter()
        .filter(|run| run.landing.is_some())
        .map(|run| run.id)
        .collect();
    assert_eq!(holders, vec![next.id.clone()]);
    assert_eq!(t.threads().await, vec![next.id.clone()]);
}

/// Folders made in `dir` from now on are not writable, whatever mode they are made with: `dir`
/// takes the default ACL `setfacl -d -m u::r-x,g::-,o::-` would give it, written as the
/// `system.posix_acl_default` value of the kernel's include/uapi/linux/posix_acl_xattr.h.
#[cfg(target_os = "linux")]
fn deny_new_folders(dir: &std::path::Path) {
    use std::os::unix::fs::DirBuilderExt;
    // version 2, then a (tag, permissions, id) entry for the owner, the group and others, in
    // the order of their tags
    let mut acl = 2u32.to_le_bytes().to_vec();
    for (tag, permissions) in [(0x01u16, 0o5u16), (0x04, 0), (0x20, 0)] {
        acl.extend(tag.to_le_bytes());
        acl.extend(permissions.to_le_bytes());
        acl.extend(u32::MAX.to_le_bytes());
    }
    rustix::fs::setxattr(
        dir,
        "system.posix_acl_default",
        &acl,
        rustix::fs::XattrFlags::empty(),
    )
    .expect("the folder takes a default ACL");
    // the setup holds: a folder made there with a result folder's mode takes no file
    let probe = dir.join("probe");
    fs::DirBuilder::new().mode(0o700).create(&probe).unwrap();
    let written = fs::write(probe.join("file"), "");
    fs::remove_dir(&probe).unwrap();
    assert_eq!(
        written.map_err(|error| error.kind()),
        Err(std::io::ErrorKind::PermissionDenied),
        "a folder made in {} takes no file",
        dir.display()
    );
}

// #347, not an `it` of the describe: TypeScript's `carryFiles` throws when the contract cannot be
// written, and the candidate's `spawnAttempt` fails
#[cfg(target_os = "linux")]
#[tokio::test(start_paused = true)]
async fn fails_the_new_run_and_sends_it_no_task_when_the_contract_cannot_be_carried_to_its_result_folder()
 {
    let t = thread();
    let first = t.start_thread("Fix", "t", None).await;
    t.write(&first, "contract.md", "- [ ] A1 no duplicate — evidence:\n");
    // without the thread's task, no task.md goes to the new run's result folder before the
    // contract: the contract is the file that cannot be written there
    fs::remove_file(t.root.join("results").join(&first.id).join("task.md")).unwrap();
    deny_new_folders(&t.root.join("results"));
    t.turn(&first, AgentState::Idle).await;
    let candidate = t
        .registry
        .all()
        .into_iter()
        .find(|run| run.agent == FleetAgentKind::Codex)
        .expect("a candidate took the thread over");
    assert_eq!(candidate.state, AgentState::Failed);
    assert!(t.runtime.closed().contains(&candidate.pane_id));
    assert_eq!(t.to(&candidate), Vec::<String>::new());
    // no run took the thread over: it stays with its lead, and the restart says why
    assert_eq!(t.run(&first.id).replaced_by, None);
    let errors: Vec<Option<String>> = t.restarts().into_iter().map(|e| e.error).collect();
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert!(
        errors[0]
            .as_deref()
            .is_some_and(|error| error.contains("the contract was not carried to")
                && error.contains("Permission denied")),
        "{errors:?}"
    );
}

// orchestrator.test.ts: "closes a carried plan when the new run went on to a report other than blocked, and keeps it open when a turn failed and no run could take over" (its first half)
#[tokio::test(start_paused = true)]
async fn closes_a_carried_plan_when_the_new_run_went_on_to_a_report_other_than_blocked() {
    let t = thread();
    let _tree = with_tree(&t);
    let first = t.start_thread("Fix", "t", None).await;
    t.fleet.submit_plan(&first.id, &plan_value(), None).unwrap();
    t.turn(&first, AgentState::Idle).await;
    let next = t.next(&first);
    t.report_state(&next, "ready", "Built it without the answers.");
    t.turn(&next, AgentState::Idle).await;
    assert!(t.run(&next.id).plan.unwrap().closed_at.is_some());
}

// orchestrator.test.ts: "closes a carried plan when the new run went on to a report other than blocked, and keeps it open when a turn failed and no run could take over" (its second half)
//
// The expected value differs from TypeScript's (`:1429` expects `closedAt` undefined): a plan the
// lead went on from stays answerable when no run could take the thread over, which is #240's 3, a
// defect of main's fleet that #265 and #267 ask the Rust version not to copy. #338 closes the plan
// in `turns.rs`'s `finalize` (ADR 0265-plans).
#[tokio::test(start_paused = true)]
async fn closes_a_plan_the_lead_went_on_from_when_a_turn_failed_and_no_run_could_take_over() {
    let t = thread();
    let _tree = with_tree(&t);
    // a thread whose plan waits, the lead's next turn fails, and no CLI is left to take over
    let other = t.start_thread("Other", "t", None).await;
    t.fleet.submit_plan(&other.id, &plan_value(), None).unwrap();
    t.report(
        &other,
        json!({ "state": "blocked", "summary": "The plan waits.", "evidence": [], "human_action": "Answer the plan." }),
    );
    t.turn(&other, AgentState::Idle).await;
    t.turn(&other, AgentState::Working).await;
    t.send(&other.id, "go on").await;
    t.runtime.set_output("API Error: 529 overloaded");
    t.runtime
        .on_start(|_| async { Err(RuntimeError::StartFailed("down".to_owned())) });
    t.turn(&other, AgentState::Idle).await;
    assert_eq!(t.run(&other.id).state, AgentState::Failed);
    assert!(t.run(&other.id).plan.unwrap().closed_at.is_some());
}

// #338: a landed thread is not restarted, so a turn without a report does not close its plan.
#[tokio::test(start_paused = true)]
async fn keeps_a_plan_open_when_a_landed_thread_ends_a_turn_without_a_report() {
    let t = thread();
    let _tree = with_tree(&t);
    let run = t.start_thread("Other", "t", None).await;
    t.fleet.submit_plan(&run.id, &plan_value(), None).unwrap();
    t.registry
        .update(&run.id, |run| run.landed = Some(Landed::Merged))
        .unwrap();
    t.turn(&run, AgentState::Idle).await;
    assert_eq!(t.run(&run.id).replaced_by, None);
    assert_eq!(t.run(&run.id).plan.unwrap().closed_at, None);
}

// orchestrator.test.ts: "hands Merge into main the coordinator has not heard yet to it once, though the thread started again meanwhile"
#[tokio::test(start_paused = true)]
async fn hands_merge_into_main_the_coordinator_has_not_heard_yet_to_it_once_though_the_thread_started_again_meanwhile()
 {
    let t = thread_with(None, None, on_main);
    let (coordinator, first) = t.ready().await;
    // the person talks with the coordinator: the merge waits, and the lead's next turn fails meanwhile
    t.turn(&coordinator, AgentState::Working).await;
    t.land(&first.id, LandAction::Merge).await;
    t.fail_next_turn(&first).await;
    t.turn(&first, AgentState::Idle).await;
    let next = t.next(&first);
    assert_eq!(step(&next), Some((LandAction::Merge, Some(false))));
    t.runtime.set_output("agent output");
    t.turn(&coordinator, AgentState::Idle).await;
    assert_eq!(
        t.to(&coordinator),
        vec![
            "go".to_owned(),
            [STEPS_HEADER, &merge_step(&first)].join("\n")
        ]
    );
    assert_eq!(
        step(&t.run(&next.id)),
        Some((LandAction::Merge, Some(true)))
    );
    t.turn(&coordinator, AgentState::Idle).await;
    assert_eq!(t.to(&coordinator).len(), 2);
}

/// `landing: { gitBranch: async () => "main" }`.
fn on_main(a: &mut LandingAnswers) {
    a.git_branch = answer(|_: PathBuf| async { Some("main".to_owned()) });
}

// orchestrator.test.ts: "hands Merge into main to the coordinator once after the server restarts, though the thread started again before"
#[tokio::test(start_paused = true)]
async fn hands_merge_into_main_to_the_coordinator_once_after_the_server_restarts_though_the_thread_started_again_before()
 {
    let t = thread_with(None, None, on_main);
    let (coordinator, first) = t.ready().await;
    t.turn(&coordinator, AgentState::Working).await;
    t.land(&first.id, LandAction::Merge).await;
    t.fail_next_turn(&first).await;
    t.turn(&first, AgentState::Idle).await;
    assert!(t.run(&first.id).replaced_by.is_some());
    t.runtime.set_output("agent output");
    t.fleet.stop();
    let restarted = t.restarted();
    t.states.set(&coordinator, AgentState::Idle);
    restarted.reconcile_all().await;
    until(
        || t.to(&coordinator).len() == 2,
        "the merge after the restart",
    )
    .await;
    assert_eq!(
        t.to(&coordinator)[1],
        [STEPS_HEADER, &merge_step(&first)].join("\n")
    );
    restarted.stop();
}

// orchestrator.test.ts: "marks Merge into main sent on the new lead when the thread started again while the coordinator was being told"
#[tokio::test(start_paused = true)]
async fn marks_merge_into_main_sent_on_the_new_lead_when_the_thread_started_again_while_the_coordinator_was_being_told()
 {
    let t = thread_with(None, None, on_main);
    let (coordinator, first) = t.ready().await;
    // the merge is being typed into the coordinator while the lead's next turn fails and the
    // thread starts again
    let gate = Gate::new();
    let typing = Flag::default();
    let (held, raised, name) = (gate.clone(), typing.clone(), coordinator.herdr_name.clone());
    let fake: Weak<FakeRuntime> = Arc::downgrade(&t.runtime);
    t.runtime.on_prompt(move |asked, text, _| {
        let (held, raised, name, fake) = (held.clone(), raised.clone(), name.clone(), fake.clone());
        async move {
            if let Some(fake) = fake.upgrade() {
                fake.recorded().prompts.push(Prompted {
                    name: asked.clone(),
                    text: text.clone(),
                });
            }
            if asked == name && text.contains("Merge into main") {
                raised.raise();
                held.pass().await;
            }
            Ok(AgentState::Working)
        }
    });
    let merging = t.land_task(&first.id, LandAction::Merge);
    until(|| typing.up(), "the merge being typed").await;
    t.fail_next_turn(&first).await;
    t.turn(&first, AgentState::Idle).await;
    let next = t.next(&first);
    gate.open();
    merging.await.unwrap().unwrap();
    assert_eq!(
        step(&t.run(&next.id)),
        Some((LandAction::Merge, Some(true)))
    );
    // the server restarts: the merge went out, and does not go again
    t.runtime.set_output("agent output");
    t.runtime.overrides().prompt = None;
    t.fleet.stop();
    let restarted = t.restarted();
    t.states.set(&coordinator, AgentState::Idle);
    restarted.reconcile_all().await;
    sleep_ms(50).await;
    assert_eq!(t.merges_to(&coordinator), 1);
    restarted.stop();
}

// orchestrator.test.ts: "hands Merge into main pressed while the thread starts again to the new lead once it holds the thread"
#[tokio::test(start_paused = true)]
async fn hands_merge_into_main_pressed_while_the_thread_starts_again_to_the_new_lead_once_it_holds_the_thread()
 {
    let t = thread_with(None, None, on_main);
    let (coordinator, first) = t.ready().await;
    t.turn(&coordinator, AgentState::Working).await;
    // the lead's turn fails, and the person presses Merge while its new lead starts
    t.fail_next_turn(&first).await;
    let (gate, starting) = (Gate::new(), Flag::default());
    hold_codex(&t, &gate, &starting);
    let failing = t.turn_task(&first, AgentState::Idle);
    until(|| starting.up(), "the new lead starting").await;
    let merging = t.land_task(&first.id, LandAction::Merge);
    sleep_ms(20).await;
    assert!(!merging.is_finished());
    gate.open();
    failing.await.unwrap();
    let run = merging.await.unwrap().unwrap();
    let next = t.next(&first);
    assert_eq!(run.id, next.id);
    assert_eq!(
        step(&t.run(&next.id)),
        Some((LandAction::Merge, Some(false)))
    );
    assert_eq!(t.run(&first.id).landing, None);
    t.runtime.set_output("agent output");
    t.turn(&coordinator, AgentState::Idle).await;
    assert_eq!(t.merges_to(&coordinator), 1);
    assert_eq!(
        step(&t.run(&next.id)),
        Some((LandAction::Merge, Some(true)))
    );
}

// orchestrator.test.ts: "starts the thread again only once a Merge into main pressed before has its branch read, so the new lead holds it"
#[tokio::test(start_paused = true)]
async fn starts_the_thread_again_only_once_a_merge_into_main_pressed_before_has_its_branch_read_so_the_new_lead_holds_it()
 {
    let (read_branch, hold_branch, reading) = (Gate::new(), Flag::default(), Flag::default());
    let (gate, held, raised) = (read_branch.clone(), hold_branch.clone(), reading.clone());
    let t = thread_with(None, None, move |a| {
        a.git_branch = answer(move |_: PathBuf| {
            let (gate, held, raised) = (gate.clone(), held.clone(), raised.clone());
            async move {
                if !held.up() {
                    return None;
                }
                raised.raise();
                gate.pass().await;
                Some("main".to_owned())
            }
        });
    });
    let (coordinator, first) = t.ready().await;
    t.turn(&coordinator, AgentState::Working).await;
    t.turn(&first, AgentState::Working).await;
    t.send(&first.id, "go on").await;
    // the person presses Merge, and the lead's turn fails while the branch is read
    hold_branch.raise();
    let merging = t.land_task(&first.id, LandAction::Merge);
    until(|| reading.up(), "the base branch being read").await;
    t.runtime.set_output("API Error: 529 overloaded");
    t.turn(&first, AgentState::Idle).await;
    assert_eq!(t.run(&first.id).replaced_by, None);
    hold_branch.lower();
    read_branch.open();
    merging.await.unwrap().unwrap();
    until(|| t.run(&first.id).replaced_by.is_some(), "the new lead").await;
    let next = t.next(&first);
    assert_eq!(step(&next), Some((LandAction::Merge, Some(false))));
    // pressed again, on the lead that holds the thread: the newer step replaces it
    t.registry
        .update(&next.id, |run| run.pr = Some(pr7(PullRequestState::Open)))
        .unwrap();
    t.land(&first.id, LandAction::MergePr).await;
    t.runtime.set_output("agent output");
    t.turn(&coordinator, AgentState::Idle).await;
    let steps = t.to(&coordinator)[1..].to_vec();
    assert_eq!(steps.len(), 1, "{steps:?}");
    assert!(steps[0].contains("gh pr merge 7 --merge"), "{steps:?}");
    assert!(!steps[0].contains("Merge into main"), "{steps:?}");
}

// orchestrator.test.ts: "puts a step pressed on the new lead while it starts after the merge the old run handed it"
#[tokio::test(start_paused = true)]
async fn puts_a_step_pressed_on_the_new_lead_while_it_starts_after_the_merge_the_old_run_handed_it()
{
    let t = thread_with(None, None, on_main);
    let (coordinator, first) = t.ready().await;
    t.registry
        .update(&first.id, |run| run.pr = Some(pr7(PullRequestState::Open)))
        .unwrap();
    t.turn(&coordinator, AgentState::Working).await;
    t.land(&first.id, LandAction::Merge).await;
    t.fail_next_turn(&first).await;
    let (gate, starting) = (Gate::new(), Flag::default());
    hold_codex(&t, &gate, &starting);
    let failing = t.turn_task(&first, AgentState::Idle);
    until(|| starting.up(), "the new lead starting").await;
    // the new lead is listed while it starts, and the person presses Merge PR on it
    let next = t
        .registry
        .all()
        .into_iter()
        .find(|run| run.thread.as_deref() == Some(first.id.as_str()) && run.id != first.id)
        .unwrap();
    let pressing = t.land_task(&next.id, LandAction::MergePr);
    gate.open();
    failing.await.unwrap();
    pressing.await.unwrap().unwrap();
    assert_eq!(
        step(&t.run(&next.id)),
        Some((LandAction::MergePr, Some(false)))
    );
    t.runtime.set_output("agent output");
    t.turn(&coordinator, AgentState::Idle).await;
    let steps = t.to(&coordinator)[1..].to_vec();
    assert_eq!(steps.len(), 1, "{steps:?}");
    assert!(steps[0].contains("gh pr merge 7 --merge"), "{steps:?}");
    assert!(!steps[0].contains("Merge into main"), "{steps:?}");
}

// orchestrator.test.ts: "discards the thread on its new lead when Discard was pressed while it started again, and hands on no merge"
#[tokio::test(start_paused = true)]
async fn discards_the_thread_on_its_new_lead_when_discard_was_pressed_while_it_started_again_and_hands_on_no_merge()
 {
    let t = thread_with(None, None, |a| {
        on_main(a);
        a.remove_thread = answer(|_: RemoveArgs| async { Ok(()) });
    });
    let (coordinator, first) = t.ready().await;
    t.turn(&coordinator, AgentState::Working).await;
    t.land(&first.id, LandAction::Merge).await;
    t.fail_next_turn(&first).await;
    let (gate, starting) = (Gate::new(), Flag::default());
    hold_codex(&t, &gate, &starting);
    let failing = t.turn_task(&first, AgentState::Idle);
    until(|| starting.up(), "the new lead starting").await;
    let discarding = t.land_task(&first.id, LandAction::Discard);
    gate.open();
    failing.await.unwrap();
    discarding.await.unwrap().unwrap();
    let next = t.next(&first);
    assert_eq!(
        (next.landed, next.state),
        (Some(Landed::Discarded), AgentState::Stopped)
    );
    t.runtime.set_output("agent output");
    t.turn(&coordinator, AgentState::Idle).await;
    assert_eq!(t.merges_to(&coordinator), 0);
}

// orchestrator.test.ts: "hands a step pressed during a second restart of the thread to the lead that restart starts"
#[tokio::test(start_paused = true)]
async fn hands_a_step_pressed_during_a_second_restart_of_the_thread_to_the_lead_that_restart_starts()
 {
    let t = thread_with(Some(vec![lead_of_three(), coordinator()]), None, on_main);
    let (coordinator, first) = t.ready().await;
    t.turn(&coordinator, AgentState::Working).await;
    // the first restart is still closing the old pane when the new lead's first turn fails too
    let (closing, closed) = (Gate::new(), Flag::default());
    let (starting, started) = (Gate::new(), Flag::default());
    {
        let (gate, raised, pane) = (closing.clone(), closed.clone(), first.pane_id.clone());
        let hook: CloseHook = Arc::new(move |id: String| {
            let (gate, raised, pane) = (gate.clone(), raised.clone(), pane.clone());
            Box::pin(async move {
                if id == pane {
                    raised.raise();
                    gate.pass().await;
                }
            })
        });
        *t.closing.lock().unwrap() = Some(hook);
    }
    {
        let (gate, raised) = (starting.clone(), started.clone());
        t.runtime.on_start(move |options: StartOptions| {
            let (gate, raised) = (gate.clone(), raised.clone());
            async move {
                if options.kind == FleetAgentKind::Pi {
                    raised.raise();
                    gate.pass().await;
                }
                Ok(AgentState::Idle)
            }
        });
    }
    t.fail_next_turn(&first).await;
    let first_failing = t.turn_task(&first, AgentState::Idle);
    until(|| closed.up(), "the first restart closing the old pane").await;
    let second = t.next(&first);
    t.runtime
        .set_output("■ stream disconnected before completion");
    let second_failing = t.turn_task(&second, AgentState::Idle);
    closing.open();
    first_failing.await.unwrap();
    until(|| started.up(), "the third lead starting").await;
    let merging = t.land_task(&second.id, LandAction::Merge);
    sleep_ms(20).await;
    assert!(!merging.is_finished());
    starting.open();
    second_failing.await.unwrap();
    let run = merging.await.unwrap().unwrap();
    let third = t.next(&second);
    assert_eq!(run.id, third.id);
    assert_eq!(step(&third), Some((LandAction::Merge, Some(false))));
    t.runtime.set_output("agent output");
    t.turn(&coordinator, AgentState::Idle).await;
    assert_eq!(t.merges_to(&coordinator), 1);
}

// orchestrator.test.ts: "reads the branch for a step pressed on the starting new lead only once it holds the thread"
#[tokio::test(start_paused = true)]
async fn reads_the_branch_for_a_step_pressed_on_the_starting_new_lead_only_once_it_holds_the_thread()
 {
    let reading = Flag::default();
    let raised = reading.clone();
    // no branch recorded on the thread: a step reads it
    let t = thread_with(None, None, move |a| {
        a.git_branch = answer(move |_: PathBuf| {
            raised.raise();
            std::future::ready(None)
        });
    });
    let (coordinator, first) = t.ready().await;
    t.turn(&coordinator, AgentState::Working).await;
    t.fail_next_turn(&first).await;
    let (gate, starting) = (Gate::new(), Flag::default());
    hold_codex(&t, &gate, &starting);
    let failing = t.turn_task(&first, AgentState::Idle);
    until(|| starting.up(), "the new lead starting").await;
    let next = t
        .registry
        .all()
        .into_iter()
        .find(|run| run.thread.as_deref() == Some(first.id.as_str()) && run.id != first.id)
        .unwrap();
    reading.lower();
    let merging = t.land_task(&next.id, LandAction::Merge);
    sleep_ms(20).await;
    assert!(!reading.up());
    gate.open();
    failing.await.unwrap();
    merging.await.unwrap().unwrap();
    assert!(reading.up());
    assert_eq!(
        step(&t.run(&next.id)),
        Some((LandAction::Merge, Some(false)))
    );
}

// orchestrator.test.ts: "closes the thread on its new lead when the coordinator's turn ends with the branch merged while the thread starts again"
#[tokio::test(start_paused = true)]
async fn closes_the_thread_on_its_new_lead_when_the_coordinators_turn_ends_with_the_branch_merged_while_the_thread_starts_again()
 {
    let merged = Flag::default();
    let removed: Arc<Mutex<Vec<String>>> = Arc::default();
    let (git, saw) = (merged.clone(), removed.clone());
    let t = thread_with(None, None, move |a| {
        on_main(a);
        a.is_merged = answer(move |_: (PathBuf, String, String)| std::future::ready(git.up()));
        a.remove_thread = answer(move |(_, worktree, _, _): RemoveArgs| {
            saw.lock()
                .unwrap()
                .push(worktree.to_string_lossy().into_owned());
            std::future::ready(Ok(()))
        });
    });
    let (coordinator, first) = t.ready().await;
    // the coordinator is handed the merge and works on it
    t.turn(&coordinator, AgentState::Working).await;
    t.land(&first.id, LandAction::Merge).await;
    t.turn(&coordinator, AgentState::Idle).await;
    assert_eq!(
        step(&t.run(&first.id)),
        Some((LandAction::Merge, Some(true)))
    );
    t.fail_next_turn(&first).await;
    // the lead's turn fails, and the coordinator's turn ends with the branch merged while the new
    // lead starts
    let (gate, starting) = (Gate::new(), Flag::default());
    hold_codex(&t, &gate, &starting);
    let failing = t.turn_task(&first, AgentState::Idle);
    until(|| starting.up(), "the new lead starting").await;
    t.runtime.set_output("agent output");
    merged.raise();
    t.turn(&coordinator, AgentState::Idle).await;
    gate.open();
    failing.await.unwrap();
    sleep_ms(50).await;
    // the thread is known by its first id: its lead now is the new run, closed as merged with its pane
    let lead = t.fleet.get(&first.id, None).unwrap();
    assert_ne!(lead.id, first.id);
    assert_eq!(
        (lead.landed, lead.state),
        (Some(Landed::Merged), AgentState::Stopped)
    );
    assert!(t.runtime.closed().contains(&lead.pane_id));
    let open: Vec<String> = t
        .registry
        .all()
        .into_iter()
        .filter(|run| {
            run.thread.as_deref() == Some(first.id.as_str())
                && run.state != AgentState::Stopped
                && run.state != AgentState::Failed
        })
        .map(|run| run.id)
        .collect();
    assert_eq!(open, Vec::<String>::new());
    assert_eq!(
        *removed.lock().unwrap(),
        vec![format!("/repo/.herdr-fleet/worktrees/{}", first.id)]
    );
}

// orchestrator.test.ts: "leaves the new lead's worktree alone when a pull request merged on GitHub is read while the thread starts again"
#[tokio::test(start_paused = true)]
async fn leaves_the_new_leads_worktree_alone_when_a_pull_request_merged_on_github_is_read_while_the_thread_starts_again()
 {
    let merged = Flag::default();
    let removed: Arc<Mutex<Vec<String>>> = Arc::default();
    let (gh, saw) = (merged.clone(), removed.clone());
    let t = thread_with(None, None, move |a| {
        on_main(a);
        a.branch_head = answer(|_: (PathBuf, String)| async { Some("c0ffee".to_owned()) });
        a.remove_thread = answer(move |(_, worktree, _, _): RemoveArgs| {
            saw.lock()
                .unwrap()
                .push(worktree.to_string_lossy().into_owned());
            std::future::ready(Ok(()))
        });
        a.read_pull_request = answer(move |_: (PathBuf, String)| {
            let state = if gh.up() {
                PullRequestState::Merged
            } else {
                PullRequestState::Open
            };
            std::future::ready(Ok(Some(PullRequestReading {
                pr: pr7(state),
                head: "c0ffee".to_owned(),
            })))
        });
    });
    let first = t.start_thread("Fix", "t", None).await;
    t.report_state(&first, "ready", "Fixed.");
    t.turn(&first, AgentState::Idle).await;
    t.registry
        .update(&first.id, |run| run.pr = Some(pr7(PullRequestState::Open)))
        .unwrap();
    t.fail_next_turn(&first).await;
    let (gate, starting) = (Gate::new(), Flag::default());
    hold_codex(&t, &gate, &starting);
    let failing = t.turn_task(&first, AgentState::Idle);
    until(|| starting.up(), "the new lead starting").await;
    t.runtime.set_output("agent output");
    // the person merged the pull request on GitHub; the polling reads it while the new lead starts
    merged.raise();
    let fleet = t.fleet.clone();
    let refreshing = tokio::spawn(async move { fleet.refresh_pull_requests().await });
    sleep_ms(20).await;
    gate.open();
    failing.await.unwrap();
    refreshing.await.unwrap();
    // the new lead works in the thread's worktree: the run it replaced closes nothing
    let lead = t.fleet.get(&first.id, None).unwrap();
    assert_ne!(lead.id, first.id);
    assert_eq!(t.run(&first.id).landed, None);
    assert_eq!(lead.landed, None);
    assert_ne!(lead.state, AgentState::Stopped);
    assert_eq!(*removed.lock().unwrap(), Vec::<String>::new());
}

// orchestrator.test.ts: "tells the coordinator of a project run without the person nothing of a restart, and the replacement's turn as usual"
#[tokio::test(start_paused = true)]
async fn tells_the_coordinator_of_a_project_run_without_the_person_nothing_of_a_restart_and_the_replacements_turn_as_usual()
 {
    let t = thread_with(None, Some(json!({ "autonomous": true })), |_| {});
    let coordinator = t.start_project().await;
    t.turn(&coordinator, AgentState::Idle).await;
    let first = t.start_thread("Fix", "t", Some(&coordinator)).await;
    t.turn(&first, AgentState::Idle).await;
    let next = t.next(&first);
    let news = herdr_fleet_orchestrator::outbox::Outbox::open(
        Some(t.root.join("fleet-outbox.json")),
        t.clock.clone(),
    )
    .unwrap()
    .pending_where(|notice| notice.about == first.id && notice.slot == "news");
    assert!(news.is_empty(), "{news:?}");
    t.turn(&coordinator, AgentState::Idle).await;
    assert_eq!(t.to(&coordinator), vec!["go".to_owned()]);
    assert_eq!(next.owner.as_deref(), Some(coordinator.id.as_str()));
    assert_eq!(next.avoid, Some(vec![FleetAgentKind::Claude]));
    t.report(
        &next,
        json!({ "state": "ready", "summary": "Fixed.", "evidence": ["bun test: 3 pass"] }),
    );
    t.turn(&next, AgentState::Idle).await;
    // a report: the CLIs that failed before get another chance at the next restart
    assert_eq!(t.run(&next.id).avoid, None);
    t.turn(&coordinator, AgentState::Idle).await;
    let told = t.to(&coordinator)[1].clone();
    assert!(
        told.contains(&format!(
            "\"Fix\" ({}, fleet/{}) ended its turn: ready — Fixed.",
            next.id, first.id
        )),
        "{told}"
    );
}
