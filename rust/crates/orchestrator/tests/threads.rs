//! Threads: a lead in a workspace (and worktree) of its own, named by its title. The tests named
//! after an `it` are `server/fleet/orchestrator.test.ts`'s describe `threads`, with their expected
//! values; its `it` "and keep the plan that turn wrote before the restart open for the person's
//! answers" calls `submitPlan` and is #265's.

mod common;

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use common::{
    FakeLanding, GRACE, SetupOptions, answer, request, role, setup, sleep_ms, spawn, until,
};
use herdr_fleet_orchestrator::agents::AgentDefinition;
use herdr_fleet_orchestrator::brief::BriefDraft;
use herdr_fleet_orchestrator::events::FleetEvent;
use herdr_fleet_orchestrator::fleet::{
    LandingTools, Orchestrator, OrchestratorError, ThreadRequest, Timings,
};
use herdr_fleet_orchestrator::registry::RunRegistry;
use herdr_fleet_orchestrator::thread::SetupOutcome;
use protocol::{
    AgentRun, AgentState, ContractItem, ContractState, DiffStat, ReportState, RunReport,
    ThreadState, TurnOutcome,
};
use serde_json::json;
use tokio_util::sync::CancellationToken;

/// `role("lead", { interactive: true, spawning: true })` (orchestrator.test.ts:985).
fn lead() -> AgentDefinition {
    AgentDefinition {
        interactive: Some(true),
        spawning: Some(true),
        ..role("lead")
    }
}

/// `role("coordinator", { interactive: true, spawning: true })`.
fn coordinator() -> AgentDefinition {
    AgentDefinition {
        interactive: Some(true),
        spawning: Some(true),
        ..role("coordinator")
    }
}

/// `{ title, task: "t", cwd }`, as most of orchestrator.test.ts's starts are.
fn titled(title: &str, cwd: &str) -> ThreadRequest {
    ThreadRequest {
        title: title.to_owned(),
        task: Some("t".to_owned()),
        cwd: Some(cwd.to_owned()),
        ..ThreadRequest::default()
    }
}

/// `fleet.startThread(...)`.
async fn start_thread(
    fleet: &Orchestrator,
    request: ThreadRequest,
) -> Result<AgentRun, OrchestratorError> {
    fleet.start_thread(request, &CancellationToken::new()).await
}

/// `fleet.startProject({ task, cwd })`.
async fn start_project(
    fleet: &Orchestrator,
    task: &str,
    cwd: &str,
) -> Result<AgentRun, OrchestratorError> {
    fleet
        .start_project(task, Some(cwd), None, &CancellationToken::new())
        .await
}

/// `gitRoot: async () => root`.
fn git_root_always(root: &'static str) -> Arc<FakeLanding> {
    let landing = FakeLanding::new();
    landing.answers().git_root = answer(move |_: PathBuf| async move { Some(PathBuf::from(root)) });
    landing
}

/// `gitRoot: async (cwd) => cwd.startsWith("/repo") ? "/repo" : null`.
fn git_root_under_repo() -> Arc<FakeLanding> {
    let landing = FakeLanding::new();
    landing.answers().git_root = answer(|cwd: PathBuf| async move {
        cwd.to_string_lossy()
            .starts_with("/repo")
            .then(|| PathBuf::from("/repo"))
    });
    landing
}

fn tools(landing: &Arc<FakeLanding>) -> Option<Arc<dyn LandingTools>> {
    Some(landing.clone())
}

/// A setup of `agents` over the fake git `landing`.
fn with(agents: Vec<AgentDefinition>, landing: &Arc<FakeLanding>) -> common::Setup {
    setup(SetupOptions {
        agents: Some(agents),
        landing: tools(landing),
        ..SetupOptions::default()
    })
}

/// The calls the fake git took of `method`, with their arguments.
fn calls(landing: &FakeLanding, method: &str) -> Vec<Vec<String>> {
    landing
        .calls()
        .into_iter()
        .filter(|call| call.method == method)
        .map(|call| call.args)
        .collect()
}

fn item(id: &str, state: ContractState) -> ContractItem {
    ContractItem {
        id: id.to_owned(),
        state,
    }
}

// orchestrator.test.ts: "start a lead in a workspace named by the title, on a worktree of its own after the user's setup command"
#[tokio::test(start_paused = true)]
async fn start_a_lead_in_a_workspace_named_by_the_title_on_a_worktree_of_its_own_after_the_users_setup_command()
 {
    let landing = git_root_always("/repo");
    let s = setup(SetupOptions {
        agents: Some(vec![lead()]),
        config: Some(
            json!({ "projects": { "/repo": { "setup": "bun install --ignore-scripts" } } }),
        ),
        landing: tools(&landing),
        ..SetupOptions::default()
    });
    let run = start_thread(
        &s.fleet,
        ThreadRequest {
            title: "Fix the retry".to_owned(),
            task: Some("Fix the duplicate notification.".to_owned()),
            cwd: Some("/repo/src".to_owned()),
            ..ThreadRequest::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(run.role, "lead");
    assert_eq!(run.name, "Fix the retry");
    assert!(run.interactive);
    assert!(run.worktree);
    assert_eq!(run.branch, Some(format!("fleet/{}", run.id)));
    assert_eq!(run.depth, 1);
    // inside the repository, which the agent CLIs already trust, and out of its git status
    let location = s.runtime.locations()[0].clone();
    assert_eq!(location.cwd, "/repo/src");
    assert_eq!(location.label, "Fix the retry");
    assert!(location.worktree);
    assert_eq!(location.branch, Some(format!("fleet/{}", run.id)));
    assert_eq!(
        location.path,
        Some(format!("/repo/.herdr-fleet/worktrees/{}", run.id))
    );
    assert_eq!(calls(&landing, "exclude_worktrees"), vec![vec!["/repo"]]);
    assert_eq!(location.caller_pane_id, None);
    assert_eq!(
        calls(&landing, "run_setup"),
        vec![vec!["/repo/src", "bun install --ignore-scripts"]]
    );
    assert_eq!(
        s.runtime.prompts()[0].text,
        "Fix the duplicate notification."
    );
    // each thread is a fleet of its own
    let second = start_thread(&s.fleet, titled("Docs", "/repo"))
        .await
        .unwrap();
    assert_ne!(second.group, run.group);
}

// orchestrator.test.ts: "belong to the run that starts them, and to the repository they work in"
#[tokio::test(start_paused = true)]
async fn belong_to_the_run_that_starts_them_and_to_the_repository_they_work_in() {
    let landing = git_root_always("/repo");
    let s = with(vec![lead(), coordinator()], &landing);
    let coordinator = s
        .fleet
        .spawn(
            herdr_fleet_orchestrator::fleet::SpawnRequest {
                role: "coordinator".to_owned(),
                task: Some("coordinate".to_owned()),
                cwd: Some("/repo".to_owned()),
                group: Some("p1".to_owned()),
                ..Default::default()
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let thread = start_thread(
        &s.fleet,
        ThreadRequest {
            title: "t".to_owned(),
            cwd: Some("/repo".to_owned()),
            depth: Some(1),
            caller_run: Some(coordinator.id.clone()),
            brief: Some(BriefDraft {
                goal: Some("g".to_owned()),
                write: Some(vec!["src".to_owned()]),
                context: Some("none".to_owned()),
                done: Some("d".to_owned()),
                verify: Some("v".to_owned()),
                ..BriefDraft::default()
            }),
            ..ThreadRequest::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(thread.owner.as_deref(), Some(coordinator.id.as_str()));
    assert_eq!(thread.project.as_deref(), Some("/repo"));
    assert_eq!(thread.depth, 2);
    let error = start_thread(
        &s.fleet,
        ThreadRequest {
            title: "t".to_owned(),
            task: Some("t".to_owned()),
            caller_run: Some("nobody".to_owned()),
            ..ThreadRequest::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code(), "run_not_found");
}

// orchestrator.test.ts: "are listed for their project, with the last report and the contract's state"
#[tokio::test(start_paused = true)]
async fn are_listed_for_their_project_with_the_last_report_and_the_contracts_state() {
    let landing = git_root_under_repo();
    let s = with(vec![lead(), role("worker")], &landing);
    let fixed = start_thread(&s.fleet, titled("Fix", "/repo"))
        .await
        .unwrap();
    let fresh = start_thread(&s.fleet, titled("Docs", "/repo/docs"))
        .await
        .unwrap();
    start_thread(&s.fleet, titled("Elsewhere", "/other"))
        .await
        .unwrap();
    spawn(
        &s.fleet,
        herdr_fleet_orchestrator::fleet::SpawnRequest {
            cwd: Some("/repo".to_owned()),
            ..request()
        },
    )
    .await
    .unwrap();
    s.registry
        .update(&fixed.id, |run| {
            run.state = AgentState::Idle;
            run.result = Some("## HANDOFF\nOutcome: fixed".to_owned());
            run.outcome = Some(TurnOutcome::Report(RunReport {
                state: ReportState::Ready,
                summary: "bun test: 12 pass".to_owned(),
                evidence: Vec::new(),
                human_action: None,
            }));
        })
        .unwrap();
    fs::write(
        s.result_dir(&fixed.id).join("contract.md"),
        "- [x] A1 no duplicate — evidence: test\n- [ ] A2 docs\n- [!] A3 old clients — evidence: none\n",
    )
    .unwrap();
    let threads = s.fleet.threads(None, Some("/repo/src")).await.unwrap();
    assert_eq!(
        threads.iter().map(|t| t.run.id.clone()).collect::<Vec<_>>(),
        vec![fixed.id.clone(), fresh.id.clone()]
    );
    assert_eq!(threads[0].state, ThreadState::Review);
    assert_eq!(
        threads[0].status.as_deref(),
        Some("ready — bun test: 12 pass")
    );
    assert_eq!(
        threads[0].contract,
        Some(vec![
            item("A1", ContractState::Met),
            item("A2", ContractState::Open),
            item("A3", ContractState::Unmet),
        ])
    );
    assert_eq!(threads[1].status, None);
    assert_eq!(threads[1].contract, None);
}

// orchestrator.test.ts: "carry what the lead's turn left: the contract, and the change since the commit the worktree started from"
#[tokio::test(start_paused = true)]
async fn carry_what_the_leads_turn_left_the_contract_and_the_change_since_the_commit_the_worktree_started_from()
 {
    let landing = git_root_always("/repo");
    landing.answers().git_head = answer(|_: PathBuf| async { Some("abc1234".to_owned()) });
    landing.answers().diff_stat = answer(|_: (PathBuf, String)| async {
        Some(DiffStat {
            added: 24,
            removed: 9,
            files: 2,
        })
    });
    let s = with(vec![lead()], &landing);
    let thread = start_thread(&s.fleet, titled("Fix", "/repo"))
        .await
        .unwrap();
    assert_eq!(thread.base.as_deref(), Some("abc1234"));
    fs::write(s.result_dir(&thread.id).join("handoff.md"), "PASS — done").unwrap();
    fs::write(
        s.result_dir(&thread.id).join("contract.md"),
        "- [x] A1 fixed\n- [ ] A2 docs\n",
    )
    .unwrap();
    s.runtime.set_get_status(AgentState::Idle);
    tokio::time::sleep(GRACE + std::time::Duration::from_millis(5)).await;
    s.fleet.on_pane_status(&thread.pane_id);
    sleep_ms(30).await;
    let run = s.registry.get(&thread.id).unwrap();
    assert_eq!(
        run.contract,
        Some(vec![
            item("A1", ContractState::Met),
            item("A2", ContractState::Open)
        ])
    );
    assert_eq!(
        run.diff,
        Some(DiffStat {
            added: 24,
            removed: 9,
            files: 2
        })
    );
    assert_eq!(
        calls(&landing, "diff_stat"),
        vec![vec![thread.cwd.clone(), "abc1234".to_owned()]]
    );
}

// orchestrator.test.ts: "are marked done by the person, and open again once their lead works again"
#[tokio::test(start_paused = true)]
async fn are_marked_done_by_the_person_and_open_again_once_their_lead_works_again() {
    let landing = git_root_always("/repo");
    let s = with(vec![lead(), role("worker")], &landing);
    let thread = start_thread(&s.fleet, titled("Fix", "/repo"))
        .await
        .unwrap();
    s.runtime.set_get_status(AgentState::Idle);
    tokio::time::sleep(GRACE + std::time::Duration::from_millis(5)).await;
    s.fleet.on_pane_status(&thread.pane_id);
    sleep_ms(20).await;
    assert!(
        s.fleet
            .resolve(&thread.id, true, None)
            .unwrap()
            .resolved_at
            .is_some()
    );
    assert_eq!(
        s.fleet
            .resolve(&thread.id, false, None)
            .unwrap()
            .resolved_at,
        None
    );
    s.fleet.resolve(&thread.id, true, None).unwrap();
    s.runtime.set_get_status(AgentState::Working);
    s.fleet.on_pane_status(&thread.pane_id);
    sleep_ms(20).await;
    assert_eq!(s.registry.get(&thread.id).unwrap().resolved_at, None);
    let helper = spawn(&s.fleet, request()).await.unwrap();
    let error = s
        .fleet
        .resolve(&helper.id, true, Some(&helper.group))
        .unwrap_err();
    assert!(
        error.to_string().contains("is not a thread's lead"),
        "{error}"
    );
}

// orchestrator.test.ts: "are listed for the calling run's project, wherever it asks from"
#[tokio::test(start_paused = true)]
async fn are_listed_for_the_calling_runs_project_wherever_it_asks_from() {
    let landing = git_root_under_repo();
    let s = with(vec![lead(), coordinator()], &landing);
    let coordinator = start_project(&s.fleet, "hello", "/repo").await.unwrap();
    let thread = start_thread(
        &s.fleet,
        ThreadRequest {
            title: "t".to_owned(),
            task: Some("t".to_owned()),
            cwd: Some("/repo".to_owned()),
            caller_run: Some(coordinator.id.clone()),
            ..ThreadRequest::default()
        },
    )
    .await
    .unwrap();
    let listed = s
        .fleet
        .threads(Some(&coordinator.id), Some("/tmp"))
        .await
        .unwrap();
    assert_eq!(
        listed.iter().map(|t| t.run.id.clone()).collect::<Vec<_>>(),
        vec![thread.id]
    );
    let error = s.fleet.threads(Some("nobody"), None).await.unwrap_err();
    assert_eq!(error.code, "run_not_found");
}

// orchestrator.test.ts: "fail before the lead starts when the setup command fails, and close the pane"
#[tokio::test(start_paused = true)]
async fn fail_before_the_lead_starts_when_the_setup_command_fails_and_close_the_pane() {
    let landing = git_root_always("/repo");
    landing.answers().run_setup = answer(|_: (PathBuf, String)| async {
        SetupOutcome {
            ok: false,
            output: "npm ERR! missing script".to_owned(),
        }
    });
    let s = setup(SetupOptions {
        agents: Some(vec![lead()]),
        config: Some(json!({ "projects": { "/repo": { "setup": "false" } } })),
        landing: tools(&landing),
        ..SetupOptions::default()
    });
    let error = start_thread(&s.fleet, titled("t", "/repo"))
        .await
        .unwrap_err();
    assert_eq!(error.code(), "setup_failed");
    assert!(
        error.to_string().contains("npm ERR! missing script"),
        "{error}"
    );
    assert!(s.runtime.starts().is_empty());
    assert_eq!(s.runtime.closed(), vec!["w1:p1"]);
    assert_eq!(s.registry.all()[0].state, AgentState::Failed);
}

// orchestrator.test.ts: "work in a plain workspace outside a repository, with no setup and no branch"
#[tokio::test(start_paused = true)]
async fn work_in_a_plain_workspace_outside_a_repository_with_no_setup_and_no_branch() {
    let landing = FakeLanding::new();
    let s = setup(SetupOptions {
        agents: Some(vec![lead()]),
        config: Some(json!({ "projects": { "/notes": { "setup": "x" } } })),
        landing: tools(&landing),
        ..SetupOptions::default()
    });
    let run = start_thread(&s.fleet, titled("Notes", "/notes"))
        .await
        .unwrap();
    assert!(!run.worktree);
    assert_eq!(run.branch, None);
    let location = s.runtime.locations()[0].clone();
    assert!(!location.worktree);
    assert_eq!(location.branch, None);
    assert!(calls(&landing, "run_setup").is_empty());
    let error = start_thread(
        &s.fleet,
        ThreadRequest {
            title: " ".to_owned(),
            task: Some("t".to_owned()),
            ..ThreadRequest::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code(), "invalid_title");
}

// ---- describe "read a lead's turn once, whatever herdr's state does as it settles" ----

const HANDOFF: &str = "## HANDOFF\nPASS — the retry sends one notification";

/// herdr's states as run 4bff4935 showed them on 2026-11-08: done, then working and done again 9 s
/// later (`flicker`).
async fn flicker(fleet: &Orchestrator, runtime: &common::FakeRuntime) {
    for state in [AgentState::Done, AgentState::Working, AgentState::Done] {
        runtime.set_get_status(state);
        fleet.reconcile_all().await;
    }
}

fn turns(events: &[FleetEvent]) -> Vec<(String, bool)> {
    events
        .iter()
        .filter_map(|event| match event {
            FleetEvent::Turn(turn) => Some((turn.run.clone(), turn.handoff)),
            _ => None,
        })
        .collect()
}

// orchestrator.test.ts: "after a done-working-done flicker"
#[tokio::test(start_paused = true)]
async fn after_a_done_working_done_flicker() {
    let landing = git_root_always("/repo");
    let s = with(vec![lead()], &landing);
    let thread = start_thread(&s.fleet, titled("Fix", "/repo"))
        .await
        .unwrap();
    fs::write(s.result_dir(&thread.id).join("handoff.md"), HANDOFF).unwrap();
    flicker(&s.fleet, &s.runtime).await;
    assert_eq!(turns(&s.events()), vec![(thread.id.clone(), true)]);
    let run = s.registry.get(&thread.id).unwrap();
    assert_eq!(run.state, AgentState::Done);
    assert_eq!(run.result.as_deref(), Some(HANDOFF));
}

/// A thread whose task the fleet sent, then a new server over the same registry file, as after a
/// restart (`restartAfterSend`).
struct AfterSend {
    s: common::Setup,
    thread: AgentRun,
}

struct Restarted {
    fleet: Orchestrator,
    registry: Arc<RunRegistry>,
    events: Arc<Mutex<Vec<FleetEvent>>>,
}

impl Restarted {
    fn turns(&self) -> Vec<(String, bool)> {
        turns(&self.events.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

async fn restart_after_send(prompt_status: AgentState) -> AfterSend {
    let landing = git_root_always("/repo");
    let s = with(vec![lead()], &landing);
    s.runtime.set_prompt_status(prompt_status);
    let thread = start_thread(&s.fleet, titled("Fix", "/repo"))
        .await
        .unwrap();
    s.fleet.stop();
    AfterSend { s, thread }
}

impl AfterSend {
    fn handoff_file(&self) -> PathBuf {
        self.s.result_dir(&self.thread.id).join("handoff.md")
    }

    /// `new Orchestrator({...})` over a new registry read from the same runs file: no repository,
    /// head, change, branch or pull request, the lead role, the shortened grace.
    fn restart(&self) -> Restarted {
        let registry = Arc::new(RunRegistry::open(
            Some(self.s.root.join("runs.json")),
            self.s.clock.as_ref(),
        ));
        let mut deps = common::deps(
            self.s.runtime.clone(),
            registry.clone(),
            &self.s.root,
            self.s.clock.clone(),
            common::config(None),
            vec![lead()],
        );
        deps.timings = Timings {
            pre_visual_grace: GRACE,
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
        Restarted {
            fleet: Orchestrator::new(deps).unwrap(),
            registry,
            events,
        }
    }
}

// orchestrator.test.ts: "when the fleet server restarted while the turn was running"
#[tokio::test(start_paused = true)]
async fn when_the_fleet_server_restarted_while_the_turn_was_running() {
    let sent = restart_after_send(AgentState::Working).await;
    let restarted = sent.restart();
    fs::write(sent.handoff_file(), HANDOFF).unwrap();
    flicker(&restarted.fleet, &sent.s.runtime).await;
    assert_eq!(restarted.turns(), vec![(sent.thread.id.clone(), true)]);
    let run = restarted.registry.get(&sent.thread.id).unwrap();
    assert_eq!(run.state, AgentState::Done);
    assert_eq!(run.result.as_deref(), Some(HANDOFF));
    restarted.fleet.stop();
}

// orchestrator.test.ts: "when the turn ended while the fleet server was down"
#[tokio::test(start_paused = true)]
async fn when_the_turn_ended_while_the_fleet_server_was_down() {
    let sent = restart_after_send(AgentState::Working).await;
    sent.s.runtime.set_get_status(AgentState::Done);
    fs::write(sent.handoff_file(), HANDOFF).unwrap();
    let restarted = sent.restart();
    // as the server does as it starts (server/index.ts); herdr sends no event for a state that
    // changed before the server came up, so a reading too early to trust is followed by another
    restarted.fleet.reconcile_all().await;
    until(
        || !restarted.turns().is_empty(),
        "the turn read after the restart",
    )
    .await;
    tokio::time::sleep(GRACE * 2).await;
    assert_eq!(restarted.turns(), vec![(sent.thread.id.clone(), true)]);
    let run = restarted.registry.get(&sent.thread.id).unwrap();
    assert_eq!(run.state, AgentState::Done);
    assert_eq!(run.result.as_deref(), Some(HANDOFF));
    restarted.fleet.stop();
}

// orchestrator.test.ts: "not before herdr shows the turn, when the server restarted while the prompt was pasted"
#[tokio::test(start_paused = true)]
async fn not_before_herdr_shows_the_turn_when_the_server_restarted_while_the_prompt_was_pasted() {
    // herdr still answered with the idle from before the prompt when the last server stopped
    let sent = restart_after_send(AgentState::Idle).await;
    sent.s.runtime.set_get_status(AgentState::Idle);
    let restarted = sent.restart();
    restarted.fleet.reconcile_all().await;
    assert_eq!(restarted.turns(), Vec::new());
    sent.s.runtime.set_get_status(AgentState::Working);
    restarted.fleet.reconcile_all().await;
    fs::write(sent.handoff_file(), HANDOFF).unwrap();
    sent.s.runtime.set_get_status(AgentState::Done);
    restarted.fleet.reconcile_all().await;
    assert_eq!(restarted.turns(), vec![(sent.thread.id.clone(), true)]);
    let run = restarted.registry.get(&sent.thread.id).unwrap();
    assert_eq!(run.state, AgentState::Done);
    assert_eq!(run.result.as_deref(), Some(HANDOFF));
    restarted.fleet.stop();
}

// codex's review of #262: TypeScript awaits gitHead before it asks gitBranch
// (orchestrator.ts:368-369); the branch is read only once the head read finished
#[tokio::test(start_paused = true)]
async fn reads_the_branch_only_after_the_head_as_typescript_awaits_them_in_turn() {
    let landing = git_root_always("/repo");
    let head_read = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let branch_saw = Arc::new(Mutex::new(None));
    let done = head_read.clone();
    landing.answers().git_head = answer(move |_: PathBuf| {
        let done = done.clone();
        async move {
            tokio::task::yield_now().await;
            done.store(true, std::sync::atomic::Ordering::SeqCst);
            Some("abc1234".to_owned())
        }
    });
    let (seen, saw) = (head_read.clone(), branch_saw.clone());
    landing.answers().git_branch = answer(move |_: PathBuf| {
        let (seen, saw) = (seen.clone(), saw.clone());
        async move {
            *saw.lock().unwrap_or_else(PoisonError::into_inner) =
                Some(seen.load(std::sync::atomic::Ordering::SeqCst));
            Some("rust".to_owned())
        }
    });
    let s = with(vec![lead()], &landing);
    let thread = start_thread(&s.fleet, titled("Fix", "/repo"))
        .await
        .unwrap();
    assert_eq!(
        *branch_saw.lock().unwrap_or_else(PoisonError::into_inner),
        Some(true)
    );
    assert_eq!(thread.base.as_deref(), Some("abc1234"));
    assert_eq!(thread.base_branch.as_deref(), Some("rust"));
}
