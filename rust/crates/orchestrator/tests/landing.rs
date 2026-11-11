//! Landing a thread: the steps the person presses, handed to the thread's lead or the project's
//! coordinator; the merges checked in git and on GitHub; and the thread closed once it landed. The
//! tests named after an `it` are `server/fleet/orchestrator.test.ts`'s describe `landing`, with
//! their expected values; the others say where theirs come from.

mod common;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use common::{
    FakeLanding, FakeRuntime, GRACE, RemoveArgs, SetupOptions, answer, config, deps, request, role,
    settle, setup, sleep_ms, spawn, start_wait, until, write_report,
};
use herdr_fleet_orchestrator::agents::AgentDefinition;
use herdr_fleet_orchestrator::fleet::{
    LandingTools, Orchestrator, OrchestratorError, SpawnRequest, ThreadRequest, Timings,
};
use herdr_fleet_orchestrator::github::{GhError, PullRequestReading};
use herdr_fleet_orchestrator::registry::RunRegistry;
use herdr_fleet_orchestrator::thread::{BranchState, DiffText, RemoveOptions};
use protocol::{
    AgentRun, AgentState, ChecksState, DiffStat, LandAction, Landed, LandingChecks, LineComment,
    PullRequest, PullRequestState, ThreadState, TurnOutcome, thread_state,
};
use serde_json::{Value, json};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

/// The header the landing steps go under (orchestrator.test.ts:2493).
const STEPS_HEADER: &str = "[fleet] The person pressed these on the Fleet screen. Each is the person's approval for that step only.";
/// The header the threads' questions go under (orchestrator.test.ts:2647).
const QUESTIONS_HEADER: &str =
    "[fleet] Threads ask the person. These come from the fleet, not from the person.";
/// The header of a project run without the person (orchestrator.ts's `NEWS_HEADER`).
const NEWS_HEADER: &str =
    "[fleet] Threads ended a turn. These come from the fleet, not from the person.";
/// The pull request's URL (orchestrator.test.ts:2402).
const PR_URL: &str = "https://github.com/o/r/pull/70";

/// `role(name, { interactive: true, spawning: true })`.
fn talking(name: &str) -> AgentDefinition {
    AgentDefinition {
        interactive: Some(true),
        spawning: Some(true),
        ..role(name)
    }
}

/// The describe's roles: a coordinator, a lead and a reviewer (orchestrator.test.ts:2401).
fn agents() -> Vec<AgentDefinition> {
    vec![talking("coordinator"), talking("lead"), role("reviewer")]
}

/// A pull request as the run keeps it.
fn pr(state: PullRequestState, checks: ChecksState) -> PullRequest {
    PullRequest {
        number: 70,
        url: PR_URL.to_owned(),
        state,
        checks,
        failing: None,
    }
}

/// `PR` (orchestrator.test.ts:2402): open, checks pending, at commit c0ffee.
fn reading(state: PullRequestState, checks: ChecksState, head: &str) -> PullRequestReading {
    PullRequestReading {
        pr: pr(state, checks),
        head: head.to_owned(),
    }
}

/// What the describe's fake git and GitHub answer (`git`, orchestrator.test.ts:2407), and what
/// `removeThread` was asked (`removed`).
struct Git {
    pr: Option<PullRequestReading>,
    pr_error: Option<String>,
    merged: bool,
    behind: u64,
    head: Option<String>,
    kept: Option<String>,
    removed: Vec<RemoveArgs>,
}

#[derive(Clone)]
struct SharedGit(Arc<Mutex<Git>>);

impl SharedGit {
    fn new() -> SharedGit {
        SharedGit(Arc::new(Mutex::new(Git {
            pr: None,
            pr_error: None,
            merged: false,
            behind: 0,
            head: Some("c0ffee".to_owned()),
            kept: None,
            removed: Vec::new(),
        })))
    }

    fn lock(&self) -> MutexGuard<'_, Git> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
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

/// The describe's `project()` (orchestrator.test.ts:2404-2437): a setup in the repository /repo on
/// main, whose git and GitHub answer what `git` holds, and where herdr says what `states` holds.
struct Project {
    s: common::Setup,
    states: States,
    git: SharedGit,
    landing: Arc<FakeLanding>,
}

fn project() -> Project {
    project_with(SetupOptions::default())
}

fn project_with(options: SetupOptions) -> Project {
    let git = SharedGit::new();
    let landing = FakeLanding::new();
    {
        let mut answers = landing.answers();
        answers.git_root = answer(|_: PathBuf| async { Some(PathBuf::from("/repo")) });
        answers.git_branch = answer(|_: PathBuf| async { Some("main".to_owned()) });
        let g = git.clone();
        answers.read_pull_request = answer(move |_: (PathBuf, String)| {
            let git = g.lock();
            let answer = match &git.pr_error {
                Some(error) => Err(GhError(error.clone())),
                None => Ok(git.pr.clone()),
            };
            std::future::ready(answer)
        });
        let g = git.clone();
        answers.is_merged =
            answer(move |_: (PathBuf, String, String)| std::future::ready(g.lock().merged));
        let g = git.clone();
        answers.branch_state = answer(move |_: (PathBuf, String)| {
            std::future::ready(Some(BranchState {
                uncommitted: Vec::new(),
                ahead: 2,
                behind: g.lock().behind,
            }))
        });
        let g = git.clone();
        answers.branch_head =
            answer(move |_: (PathBuf, String)| std::future::ready(g.lock().head.clone()));
        answers.diff_text = answer(|_: (PathBuf, String)| async {
            Some(DiffText {
                diff: "diff --git a/x b/x".to_owned(),
                truncated: false,
            })
        });
        let g = git.clone();
        answers.remove_thread = answer(move |args: RemoveArgs| {
            let mut git = g.lock();
            git.removed.push(args);
            std::future::ready(git.kept.clone().map_or(Ok(()), Err))
        });
    }
    let s = setup(SetupOptions {
        agents: Some(agents()),
        landing: Some(landing.clone() as Arc<dyn LandingTools>),
        ..options
    });
    let states = States::default();
    let read = states.clone();
    s.runtime
        .on_get(move |name| std::future::ready(Ok(read.of(&name))));
    Project {
        s,
        states,
        git,
        landing,
    }
}

impl Project {
    /// herdr says `state` for the run's pane, and sends the event (`turn`).
    async fn turn(&self, run: &AgentRun, state: AgentState) {
        self.states.set(run, state);
        sleep_ms(GRACE.as_millis() as u64 + 5).await;
        self.s.fleet.on_pane_status(&run.pane_id);
        sleep_ms(30).await;
    }

    /// What the run was given, in order (`to`).
    fn to(&self, run: &AgentRun) -> Vec<String> {
        prompts_to(&self.s.runtime, run)
    }

    /// The run as the registry holds it now.
    fn run(&self, run: &AgentRun) -> AgentRun {
        self.s.registry.get(&run.id).unwrap()
    }

    fn removed(&self) -> Vec<RemoveArgs> {
        self.git.lock().removed.clone()
    }

    /// `fleet.land(run.id, action)`.
    async fn land(
        &self,
        run: &AgentRun,
        action: LandAction,
    ) -> Result<AgentRun, OrchestratorError> {
        self.land_with(run, action, &[]).await
    }

    /// `fleet.land(run.id, action, { comments })`.
    async fn land_with(
        &self,
        run: &AgentRun,
        action: LandAction,
        comments: &[LineComment],
    ) -> Result<AgentRun, OrchestratorError> {
        self.s
            .fleet
            .land(&run.id, action, comments, None, &CancellationToken::new())
            .await
    }

    async fn start_project(&self, task: &str) -> AgentRun {
        self.s
            .fleet
            .start_project(task, Some("/repo"), None, &CancellationToken::new())
            .await
            .unwrap()
    }

    /// `fleet.startThread({ title, task: "t", cwd: "/repo", callerRun })`.
    async fn start_thread(&self, title: &str, coordinator: &AgentRun) -> AgentRun {
        self.s
            .fleet
            .start_thread(
                ThreadRequest {
                    title: title.to_owned(),
                    task: Some("t".to_owned()),
                    cwd: Some("/repo".to_owned()),
                    caller_run: Some(coordinator.id.clone()),
                    ..ThreadRequest::default()
                },
                &CancellationToken::new(),
            )
            .await
            .unwrap()
    }

    /// A coordinator, and a thread of its that ended a turn reporting ready (`ready`).
    async fn ready(&self) -> (AgentRun, AgentRun) {
        let coordinator = self.start_project("fix the retry").await;
        self.turn(&coordinator, AgentState::Idle).await;
        let thread = self.start_thread("Fix", &coordinator).await;
        write_report(&self.s.root, &thread.id, "ready", "bun test: 12 pass");
        self.turn(&thread, AgentState::Idle).await;
        (coordinator, thread)
    }
}

fn prompts_to(runtime: &FakeRuntime, run: &AgentRun) -> Vec<String> {
    runtime
        .prompts()
        .into_iter()
        .filter(|prompt| prompt.name == run.herdr_name)
        .map(|prompt| prompt.text)
        .collect()
}

fn code(result: Result<AgentRun, OrchestratorError>) -> String {
    result.unwrap_err().code().to_owned()
}

/// The thread's worktree and branch as `removeThread` is asked to remove them.
fn removal(thread: &AgentRun, force: bool, branch_merged: bool) -> RemoveArgs {
    (
        PathBuf::from("/repo"),
        PathBuf::from(format!("/repo/.herdr-fleet/worktrees/{}", thread.id)),
        thread.branch.clone().unwrap(),
        RemoveOptions {
            force,
            branch_merged,
        },
    )
}

/// The merge step the coordinator is handed for `thread` onto `base` (orchestrator.test.ts:2495).
fn merge_step(thread: &AgentRun, base: &str) -> String {
    let branch = thread.branch.as_deref().unwrap();
    format!(
        "- Merge into {base} for thread \"{}\" ({}, {branch}): when this checkout is clean and on {base}, git merge --no-ff {branch}. On a conflict, git merge --abort and tell the person.",
        thread.name, thread.id
    )
}

/// The orchestrator a restart builds over the same folder (orchestrator.test.ts:2525-2529), with
/// git and GitHub as `landing` answers.
fn restart(p: &Project, landing: Arc<FakeLanding>) -> Orchestrator {
    let registry = Arc::new(RunRegistry::open(
        Some(p.s.root.join("runs.json")),
        p.s.clock.as_ref(),
    ));
    let mut deps = deps(
        p.s.runtime.clone(),
        registry,
        &p.s.root,
        p.s.clock.clone(),
        config(None),
        agents(),
    );
    deps.landing = landing;
    deps.timings = Timings {
        pre_visual_grace: GRACE,
        ..Timings::default()
    };
    Orchestrator::new(deps).unwrap()
}

/// The runs as runs.json holds them now.
fn saved(p: &Project) -> RunRegistry {
    RunRegistry::open(Some(p.s.root.join("runs.json")), p.s.clock.as_ref())
}

/// runs.json with each run changed by `change`, as a server from before would have left it.
fn rewrite_runs(root: &Path, change: impl Fn(&mut Value) -> bool) {
    let file = root.join("runs.json");
    let mut runs: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    runs.as_array_mut().unwrap().retain_mut(|run| change(run));
    fs::write(&file, runs.to_string()).unwrap();
}

// orchestrator.test.ts: "start a thread on the branch the main checkout is on, and measure its change from there"
#[tokio::test(start_paused = true)]
async fn start_a_thread_on_the_branch_the_main_checkout_is_on_and_measure_its_change_from_there() {
    let bases = Arc::new(Mutex::new(Vec::new()));
    let landing = FakeLanding::new();
    {
        let mut answers = landing.answers();
        answers.git_root = answer(|_: PathBuf| async { Some(PathBuf::from("/repo")) });
        answers.git_head = answer(|_: PathBuf| async { Some("abc1234".to_owned()) });
        answers.git_branch = answer(|_: PathBuf| async { Some("main".to_owned()) });
        let seen = bases.clone();
        answers.diff_stat = answer(move |(_, base): (PathBuf, String)| {
            seen.lock().unwrap().push(base);
            std::future::ready(Some(DiffStat {
                added: 1,
                removed: 0,
                files: 1,
            }))
        });
    }
    let s = setup(SetupOptions {
        agents: Some(agents()),
        landing: Some(landing),
        ..SetupOptions::default()
    });
    let thread = s
        .fleet
        .start_thread(
            ThreadRequest {
                title: "Fix".to_owned(),
                task: Some("t".to_owned()),
                cwd: Some("/repo".to_owned()),
                ..ThreadRequest::default()
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(thread.base.as_deref(), Some("abc1234"));
    assert_eq!(thread.base_branch.as_deref(), Some("main"));
    s.runtime.set_get_status(AgentState::Idle);
    sleep_ms(GRACE.as_millis() as u64 + 5).await;
    s.fleet.on_pane_status(&thread.pane_id);
    sleep_ms(30).await;
    assert_eq!(*bases.lock().unwrap(), vec!["main".to_owned()]);
    assert_eq!(
        s.registry.get(&thread.id).unwrap().diff,
        Some(DiffStat {
            added: 1,
            removed: 0,
            files: 1
        })
    );
}

// orchestrator.test.ts: "hand Create PR to the lead as the person's approval to push and open it, and keep the pull request it opened"
#[tokio::test(start_paused = true)]
async fn hand_create_pr_to_the_lead_as_the_persons_approval_to_push_and_open_it_and_keep_the_pull_request_it_opened()
 {
    let p = project();
    let (_, thread) = p.ready().await;
    p.land(&thread, LandAction::Pr).await.unwrap();
    let message = p.to(&thread).pop().unwrap();
    let branch = thread.branch.clone().unwrap();
    assert!(
        message.starts_with(
            "[fleet] The person pressed Create PR on the Fleet screen: they approve pushing fleet/"
        ),
        "{message}"
    );
    assert!(message.contains(&format!(
        "pushing {branch} to origin and opening a pull request from it against main"
    )));
    assert!(message.contains("never force"));
    assert!(message.contains("Do not merge it."));
    let landing = p.run(&thread).landing.unwrap();
    assert_eq!((landing.action, landing.sent), (LandAction::Pr, Some(true)));
    // a second step waits for the lead's turn to end
    assert_eq!(
        code(p.land(&thread, LandAction::Update).await),
        "landing_busy"
    );
    p.git.lock().pr = Some(reading(
        PullRequestState::Open,
        ChecksState::Pending,
        "c0ffee",
    ));
    write_report(&p.s.root, &thread.id, "ready", "Opened #70.");
    p.turn(&thread, AgentState::Idle).await;
    let landed = p.run(&thread);
    assert_eq!(
        landed.pr,
        Some(pr(PullRequestState::Open, ChecksState::Pending))
    );
    assert_eq!(landed.landing, None);
    assert_eq!(thread_state(&landed), ThreadState::Landing);
}

// orchestrator.test.ts: "say on the thread when the step did not happen, and let the person press it again"
#[tokio::test(start_paused = true)]
async fn say_on_the_thread_when_the_step_did_not_happen_and_let_the_person_press_it_again() {
    let p = project();
    let (_, thread) = p.ready().await;
    let branch = thread.branch.clone().unwrap();
    p.land(&thread, LandAction::Pr).await.unwrap();
    p.turn(&thread, AgentState::Idle).await;
    let landing = p.run(&thread).landing.unwrap();
    assert_eq!(landing.action, LandAction::Pr);
    assert_eq!(
        landing.error.as_deref(),
        Some(format!("The lead's turn ended without an open pull request for {branch}.").as_str())
    );
    assert_eq!(thread_state(&p.run(&thread)), ThreadState::Waiting);
    p.git.lock().behind = 3;
    p.land(&thread, LandAction::Update).await.unwrap();
    p.turn(&thread, AgentState::Idle).await;
    assert_eq!(
        p.run(&thread).landing.unwrap().error.as_deref(),
        Some(format!("{branch} is still 3 commits behind main.").as_str())
    );
}

// orchestrator.test.ts: "send the person's comments together, and Fix CI with the failing checks, each asking to push to the open pull request"
#[tokio::test(start_paused = true)]
async fn send_the_persons_comments_together_and_fix_ci_with_the_failing_checks_each_asking_to_push_to_the_open_pull_request()
 {
    let p = project();
    let (_, thread) = p.ready().await;
    let branch = thread.branch.clone().unwrap();
    let comments = [
        LineComment {
            file: "src/retry.ts".to_owned(),
            line: 12,
            removed: None,
            text: "Keep the\nold name.".to_owned(),
        },
        LineComment {
            file: "README.md".to_owned(),
            line: 3,
            removed: Some(true),
            text: "Typo".to_owned(),
        },
    ];
    p.land_with(&thread, LandAction::Comments, &comments)
        .await
        .unwrap();
    assert_eq!(
        p.to(&thread).pop().unwrap(),
        [
            "[fleet] The person reviewed this thread's change on the Fleet screen and left these comments:",
            "- src/retry.ts:12 — Keep the old name.",
            "- README.md:3 (a removed line) — Typo",
            "Address each one and commit. Where you disagree, say why in your HANDOFF instead of changing the code.",
        ]
        .join("\n")
    );
    p.turn(&thread, AgentState::Idle).await;
    assert_eq!(p.run(&thread).landing, None);
    assert_eq!(
        code(p.land(&thread, LandAction::FixCi).await),
        "no_pull_request"
    );
    assert_eq!(
        code(p.land_with(&thread, LandAction::Comments, &[]).await),
        "missing_comments"
    );
    let failing = PullRequest {
        failing: Some(vec!["test".to_owned(), "lint".to_owned()]),
        ..pr(PullRequestState::Open, ChecksState::Fail)
    };
    let kept = failing.clone();
    p.s.registry
        .update(&thread.id, |run| run.pr = Some(kept))
        .unwrap();
    p.git.lock().pr = Some(PullRequestReading {
        pr: failing,
        head: "c0ffee".to_owned(),
    });
    assert_eq!(thread_state(&p.run(&thread)), ThreadState::Waiting);
    p.land(&thread, LandAction::FixCi).await.unwrap();
    assert_eq!(
        p.to(&thread).pop().unwrap(),
        format!(
            "[fleet] The person pressed Fix CI on the Fleet screen: checks failed on pull request #70 (test, lint). Read their logs (gh pr checks 70, gh run view --log-failed), fix the cause, commit, and push {branch} to its pull request #70."
        )
    );
    // the lead is at work: nothing more goes to it until its turn ends
    let more = [LineComment {
        file: "a".to_owned(),
        line: 1,
        removed: None,
        text: "b".to_owned(),
    }];
    assert_eq!(
        code(p.land_with(&thread, LandAction::Comments, &more).await),
        "landing_busy"
    );
}

// orchestrator.test.ts: "hand Merge into main to the coordinator once it is free, then close the merged thread: its panes, worktree and branch"
#[tokio::test(start_paused = true)]
async fn hand_merge_into_main_to_the_coordinator_once_it_is_free_then_close_the_merged_thread_its_panes_worktree_and_branch()
 {
    let p = project();
    let (coordinator, thread) = p.ready().await;
    let helper = spawn(
        &p.s.fleet,
        SpawnRequest {
            role: "reviewer".to_owned(),
            task: Some("review".to_owned()),
            group: Some(thread.group.clone()),
            cwd: Some("/repo".to_owned()),
            ..SpawnRequest::default()
        },
    )
    .await
    .unwrap();
    // the person talks with the coordinator: the merge waits for its turn to end
    p.turn(&coordinator, AgentState::Working).await;
    p.land(&thread, LandAction::Merge).await.unwrap();
    let landing = p.run(&thread).landing.unwrap();
    assert_eq!(
        (landing.action, landing.sent),
        (LandAction::Merge, Some(false))
    );
    assert_eq!(p.to(&coordinator), vec!["fix the retry".to_owned()]);
    p.turn(&coordinator, AgentState::Idle).await;
    assert_eq!(
        p.to(&coordinator).pop().unwrap(),
        [STEPS_HEADER, &merge_step(&thread, "main")].join("\n")
    );
    let landing = p.run(&thread).landing.unwrap();
    assert_eq!(
        (landing.action, landing.sent),
        (LandAction::Merge, Some(true))
    );
    p.git.lock().merged = true;
    p.turn(&coordinator, AgentState::Idle).await;
    let closed = p.s.runtime.closed();
    assert!(closed.contains(&thread.pane_id), "{closed:?}");
    assert!(closed.contains(&helper.pane_id), "{closed:?}");
    assert_eq!(p.removed(), vec![removal(&thread, false, false)]);
    let closed = p.run(&thread);
    assert_eq!(
        (closed.landed, closed.state),
        (Some(Landed::Merged), AgentState::Stopped)
    );
    assert_eq!(closed.landing, None);
    assert_eq!(thread_state(&closed), ThreadState::Resolved);
    assert_eq!(p.run(&helper).state, AgentState::Stopped);
    assert_eq!(
        code(p.land(&thread, LandAction::Merge).await),
        "thread_landed"
    );
}

// orchestrator.test.ts: "keep Merge into main for the coordinator across a restart, and drop it once the person threw the thread away"
#[tokio::test(start_paused = true)]
async fn keep_merge_into_main_for_the_coordinator_across_a_restart_and_drop_it_once_the_person_threw_the_thread_away()
 {
    let p = project();
    let (coordinator, thread) = p.ready().await;
    let other = p.start_thread("Other", &coordinator).await;
    p.turn(&coordinator, AgentState::Working).await;
    p.land(&thread, LandAction::Merge).await.unwrap();
    p.land(&other, LandAction::Merge).await.unwrap();
    p.s.fleet.stop();
    let landing = FakeLanding::new();
    {
        let mut answers = landing.answers();
        answers.git_branch = answer(|_: PathBuf| async { Some("main".to_owned()) });
        answers.remove_thread = answer(|_: RemoveArgs| async { Ok(()) });
    }
    let restarted = restart(&p, landing);
    restarted
        .land(
            &other.id,
            LandAction::Discard,
            &[],
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    p.states.set(&coordinator, AgentState::Idle);
    restarted.reconcile_all().await;
    until(
        || p.to(&coordinator).len() == 2,
        "the merge after the restart",
    )
    .await;
    let message = &p.to(&coordinator)[1];
    assert!(
        message.contains(&format!(
            "Merge into main for thread \"Fix\" ({}",
            thread.id
        )),
        "{message}"
    );
    assert!(!message.contains(&other.id), "{message}");
    until(
        || {
            saved(&p)
                .get(&thread.id)
                .unwrap()
                .landing
                .is_some_and(|landing| landing.sent == Some(true))
        },
        "the merge marked sent",
    )
    .await;
    assert_eq!(
        saved(&p).get(&thread.id).unwrap().landing.unwrap().action,
        LandAction::Merge
    );
    restarted.stop();
}

// orchestrator.test.ts: "leave out a merge the person threw away while the coordinator was being read"
#[tokio::test(start_paused = true)]
async fn leave_out_a_merge_the_person_threw_away_while_the_coordinator_was_being_read() {
    let p = project();
    let (coordinator, thread) = p.ready().await;
    p.turn(&coordinator, AgentState::Working).await;
    let gate = Arc::new(Semaphore::new(0));
    let (held, name) = (gate.clone(), coordinator.herdr_name.clone());
    p.s.runtime.on_get(move |asked| {
        let (held, name) = (held.clone(), name.clone());
        async move {
            if asked == name {
                let _ = held.acquire().await;
            }
            Ok(AgentState::Idle)
        }
    });
    let (fleet, id) = (p.s.fleet.clone(), thread.id.clone());
    let merging = tokio::spawn(async move {
        fleet
            .land(&id, LandAction::Merge, &[], None, &CancellationToken::new())
            .await
    });
    sleep_ms(10).await;
    p.land(&thread, LandAction::Discard).await.unwrap();
    gate.close();
    merging.await.unwrap().unwrap();
    sleep_ms(30).await;
    assert_eq!(p.to(&coordinator), vec!["fix the retry".to_owned()]);
}

// orchestrator.test.ts: "send a merge marked sent once, though the server stopped before it left the outbox"
#[tokio::test(start_paused = true)]
async fn send_a_merge_marked_sent_once_though_the_server_stopped_before_it_left_the_outbox() {
    let p = project();
    let (coordinator, thread) = p.ready().await;
    p.turn(&coordinator, AgentState::Working).await;
    p.land(&thread, LandAction::Merge).await.unwrap();
    let outbox = p.s.root.join("fleet-outbox.json");
    let queued = fs::read_to_string(&outbox).unwrap();
    p.turn(&coordinator, AgentState::Idle).await;
    assert_eq!(p.to(&coordinator).len(), 2);
    p.s.fleet.stop();
    // the outbox as it stood when the server stopped: the step marked sent in the registry, still
    // in the file
    fs::write(&outbox, queued).unwrap();
    let restarted = restart(&p, FakeLanding::new());
    p.states.set(&coordinator, AgentState::Idle);
    restarted.reconcile_all().await;
    sleep_ms(30).await;
    assert_eq!(p.to(&coordinator).len(), 2);
    restarted.stop();
}

// orchestrator.test.ts: "hand on merge steps a run saved before the outbox kept in the order pressed, onto the branch each thread recorded"
#[tokio::test(start_paused = true)]
async fn hand_on_merge_steps_a_run_saved_before_the_outbox_kept_in_the_order_pressed_onto_the_branch_each_thread_recorded()
 {
    let p = project();
    let (coordinator, first) = p.ready().await;
    let second = p.start_thread("Second", &coordinator).await;
    p.turn(&coordinator, AgentState::Working).await;
    p.s.fleet.stop();
    // pressed on the second thread first; both started from release, while the checkout is on main
    let pressed = HashMap::from([(first.id.clone(), 20), (second.id.clone(), 10)]);
    rewrite_runs(&p.s.root, |run| {
        if let Some(at) = run["id"].as_str().and_then(|id| pressed.get(id)) {
            run["baseBranch"] = json!("release");
            run["landing"] = json!({ "action": "merge", "at": at, "sent": false });
        }
        true
    });
    let landing = FakeLanding::new();
    landing.answers().git_branch = answer(|_: PathBuf| async { Some("main".to_owned()) });
    let restarted = restart(&p, landing);
    p.states.set(&coordinator, AgentState::Idle);
    restarted.reconcile_all().await;
    until(
        || p.to(&coordinator).len() == 2,
        "the saved merges after the restart",
    )
    .await;
    let message = p.to(&coordinator)[1].clone();
    let steps: Vec<&str> = message.split('\n').skip(1).collect();
    assert_eq!(
        steps,
        vec![
            merge_step(&second, "release"),
            merge_step(&first, "release")
        ]
    );
    restarted.stop();
}

// orchestrator.test.ts: "hand on a merge step and a question a run saved before the outbox kept, once, and drop news about a run no longer kept"
#[tokio::test(start_paused = true)]
async fn hand_on_a_merge_step_and_a_question_a_run_saved_before_the_outbox_kept_once_and_drop_news_about_a_run_no_longer_kept()
 {
    let p = project();
    let (coordinator, thread) = p.ready().await;
    let gone = p.start_thread("Gone", &coordinator).await;
    p.turn(&coordinator, AgentState::Working).await;
    fs::write(
        p.s.result_dir(&gone.id).join("handoff.md"),
        "BLOCKED — still there?",
    )
    .unwrap();
    p.turn(&gone, AgentState::Idle).await;
    p.s.fleet.stop();
    // the registry as the fleet wrote it before: the news and an unsent merge on the thread; the
    // other thread gone
    rewrite_runs(&p.s.root, |run| {
        if run["id"] == gone.id.as_str() {
            return false;
        }
        if run["id"] == thread.id.as_str() {
            run["notice"] = json!("an old question");
            run["landing"] = json!({ "action": "merge", "at": 1, "sent": false });
        }
        true
    });
    let restarted = restart(&p, FakeLanding::new());
    p.states.set(&coordinator, AgentState::Idle);
    restarted.reconcile_all().await;
    until(
        || p.to(&coordinator).len() == 2,
        "the kept notices after the restart",
    )
    .await;
    let message = p.to(&coordinator)[1].clone();
    assert_eq!(
        message,
        [
            QUESTIONS_HEADER,
            "- an old question",
            STEPS_HEADER,
            &merge_step(&thread, "main"),
        ]
        .join("\n")
    );
    assert!(!message.contains("still there?"));
    assert_eq!(saved(&p).get(&thread.id).unwrap().notice, None);
    sleep_ms(GRACE.as_millis() as u64 + 5).await;
    restarted.on_pane_status(&coordinator.pane_id);
    sleep_ms(30).await;
    restarted.stop();
    let again = restart(&p, FakeLanding::new());
    again.reconcile_all().await;
    sleep_ms(30).await;
    assert_eq!(p.to(&coordinator).len(), 2);
    again.stop();
}

// orchestrator.test.ts: "say what git kept, and that a merge did not happen"
#[tokio::test(start_paused = true)]
async fn say_what_git_kept_and_that_a_merge_did_not_happen() {
    let p = project();
    let (coordinator, thread) = p.ready().await;
    let branch = thread.branch.clone().unwrap();
    p.land(&thread, LandAction::Merge).await.unwrap();
    p.turn(&coordinator, AgentState::Idle).await;
    assert_eq!(
        p.run(&thread).landing.unwrap().error.as_deref(),
        Some(
            format!("{branch} is not in main after the coordinator's turn; its reply says why.")
                .as_str()
        )
    );
    assert_eq!(p.run(&thread).landed, None);
    let kept = "The worktree /repo/.herdr-fleet/worktrees/x was kept: contains modified or untracked files";
    {
        let mut git = p.git.lock();
        git.merged = true;
        git.kept = Some(kept.to_owned());
    }
    p.land(&thread, LandAction::Merge).await.unwrap();
    p.turn(&coordinator, AgentState::Idle).await;
    let closed = p.run(&thread);
    assert_eq!(closed.landed, Some(Landed::Merged));
    assert_eq!(closed.landing.unwrap().error.as_deref(), Some(kept));
}

// orchestrator.test.ts: "start a coordinator for a merge when none lives"
#[tokio::test(start_paused = true)]
async fn start_a_coordinator_for_a_merge_when_none_lives() {
    let p = project();
    let (coordinator, thread) = p.ready().await;
    p.s.registry
        .update(&coordinator.id, |run| run.state = AgentState::Stopped)
        .unwrap();
    p.land(&thread, LandAction::Merge).await.unwrap();
    let started =
        p.s.registry
            .all()
            .into_iter()
            .find(|run| run.role == "coordinator" && run.id != coordinator.id)
            .unwrap();
    assert!(
        p.to(&started)[0].contains("Merge into main for thread \"Fix\""),
        "{:?}",
        p.to(&started)
    );
    assert_eq!(p.run(&thread).landing.unwrap().sent, Some(true));
    assert_eq!(p.s.runtime.locations().last().unwrap().cwd, "/repo");
}

// orchestrator.test.ts: "hand Merge PR to the coordinator, and delete the branch once GitHub merged the commit it is at here"
#[tokio::test(start_paused = true)]
async fn hand_merge_pr_to_the_coordinator_and_delete_the_branch_once_github_merged_the_commit_it_is_at_here()
 {
    let p = project();
    let (coordinator, thread) = p.ready().await;
    assert_eq!(
        code(p.land(&thread, LandAction::MergePr).await),
        "no_pull_request"
    );
    p.s.registry
        .update(&thread.id, |run| {
            run.pr = Some(pr(PullRequestState::Open, ChecksState::Pass));
        })
        .unwrap();
    p.land(&thread, LandAction::MergePr).await.unwrap();
    let message = p.to(&coordinator).pop().unwrap();
    assert!(message.contains("Merge PR for thread \"Fix\""), "{message}");
    assert!(message.contains("gh pr merge 70 --merge"), "{message}");
    p.git.lock().pr = Some(reading(
        PullRequestState::Merged,
        ChecksState::None,
        "c0ffee",
    ));
    p.turn(&coordinator, AgentState::Idle).await;
    assert_eq!(
        p.removed().last().unwrap().3,
        RemoveOptions {
            force: false,
            branch_merged: true
        }
    );
    let closed = p.run(&thread);
    assert_eq!(closed.landed, Some(Landed::Merged));
    assert_eq!(closed.pr.unwrap().state, PullRequestState::Merged);
}

// orchestrator.test.ts: "throw a thread away at once: its panes, worktree and branch whatever they hold"
#[tokio::test(start_paused = true)]
async fn throw_a_thread_away_at_once_its_panes_worktree_and_branch_whatever_they_hold() {
    let p = project();
    let (_, thread) = p.ready().await;
    p.land(&thread, LandAction::Discard).await.unwrap();
    assert!(p.s.runtime.closed().contains(&thread.pane_id));
    assert_eq!(p.removed(), vec![removal(&thread, true, false)]);
    let thrown = p.run(&thread);
    assert_eq!(
        (thrown.landed, thrown.state),
        (Some(Landed::Discarded), AgentState::Stopped)
    );
    assert_eq!(thread_state(&thrown), ThreadState::Resolved);
}

// orchestrator.test.ts: "read the open pull requests again, and close a thread the person merged on GitHub"
#[tokio::test(start_paused = true)]
async fn read_the_open_pull_requests_again_and_close_a_thread_the_person_merged_on_github() {
    let p = project();
    let (_, thread) = p.ready().await;
    p.s.registry
        .update(&thread.id, |run| {
            run.pr = Some(pr(PullRequestState::Open, ChecksState::Pending));
        })
        .unwrap();
    p.git.lock().pr = Some(reading(PullRequestState::Open, ChecksState::Pass, "c0ffee"));
    p.s.fleet.refresh_pull_requests().await;
    assert_eq!(p.run(&thread).pr.unwrap().checks, ChecksState::Pass);
    p.git.lock().pr = Some(reading(
        PullRequestState::Merged,
        ChecksState::Pass,
        "older",
    ));
    p.s.fleet.refresh_pull_requests().await;
    // GitHub merged another commit than the branch is at here: the branch stays
    assert_eq!(
        p.removed().last().unwrap().3,
        RemoveOptions {
            force: false,
            branch_merged: false
        }
    );
    assert_eq!(p.run(&thread).landed, Some(Landed::Merged));
}

// orchestrator.test.ts: "answer the checks: the worktree, the branch beside its base, and the pull request, or why GitHub could not say"
#[tokio::test(start_paused = true)]
async fn answer_the_checks_the_worktree_the_branch_beside_its_base_and_the_pull_request_or_why_github_could_not_say()
 {
    let p = project();
    let (_, thread) = p.ready().await;
    {
        let mut git = p.git.lock();
        git.behind = 2;
        git.pr = Some(reading(
            PullRequestState::Open,
            ChecksState::Pending,
            "c0ffee",
        ));
    }
    assert_eq!(
        p.s.fleet.checks(&thread.id, None).await.unwrap(),
        LandingChecks {
            base_branch: "main".to_owned(),
            uncommitted: Vec::new(),
            ahead: 2,
            behind: 2,
            pr: Some(pr(PullRequestState::Open, ChecksState::Pending)),
            pr_error: None,
        }
    );
    assert_eq!(p.run(&thread).pr.unwrap().number, 70);
    let signed_out = "gh: To get started with GitHub CLI, please run: gh auth login";
    p.git.lock().pr_error = Some(signed_out.to_owned());
    let checks = p.s.fleet.checks(&thread.id, None).await.unwrap();
    assert_eq!(checks.pr_error.as_deref(), Some(signed_out));
    assert_eq!(checks.pr.unwrap().number, 70);
    assert_eq!(
        p.s.fleet.diff(&thread.id, None).await.unwrap(),
        DiffText {
            diff: "diff --git a/x b/x".to_owned(),
            truncated: false,
        }
    );
    let helper = spawn(
        &p.s.fleet,
        SpawnRequest {
            role: "reviewer".to_owned(),
            ..request()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        p.s.fleet
            .checks(&helper.id, Some(&helper.group))
            .await
            .unwrap_err()
            .code,
        "not_a_thread"
    );
}

// Issue #266's acceptance: of the landing steps, only Discard has the server itself close the
// thread's panes and remove its worktree and branch as the step is pressed. Every other step is a
// message to the lead or the coordinator (orchestrator.ts's `land` doc comment, and CLAUDE.md:
// "サーバー自身が手を下すのは、取り消せない確認を経た Discard だけ"); a merge that did not happen
// closes nothing.
#[tokio::test(start_paused = true)]
async fn only_discard_has_the_server_close_panes_and_remove_the_worktree_and_branch_itself() {
    let p = project();
    let (coordinator, thread) = p.ready().await;
    p.s.registry
        .update(&thread.id, |run| {
            run.pr = Some(pr(PullRequestState::Open, ChecksState::Fail));
        })
        .unwrap();
    p.git.lock().pr = Some(reading(PullRequestState::Open, ChecksState::Fail, "c0ffee"));
    let comment = [LineComment {
        file: "a".to_owned(),
        line: 1,
        removed: None,
        text: "b".to_owned(),
    }];
    for action in [
        LandAction::Update,
        LandAction::Pr,
        LandAction::FixCi,
        LandAction::Comments,
    ] {
        p.land_with(&thread, action, &comment).await.unwrap();
        p.turn(&thread, AgentState::Idle).await;
    }
    for action in [LandAction::Merge, LandAction::MergePr] {
        p.land(&thread, action).await.unwrap();
        p.turn(&coordinator, AgentState::Idle).await;
    }
    p.s.fleet.refresh_pull_requests().await;
    assert_eq!(p.removed(), Vec::<RemoveArgs>::new());
    assert_eq!(p.s.runtime.closed(), Vec::<String>::new());
    assert_eq!(p.run(&thread).landed, None);
    // the steps went to the agents: the lead got its four, the coordinator its two merges
    assert_eq!(p.to(&thread).len(), 5, "{:?}", p.to(&thread));
    assert_eq!(p.to(&coordinator).len(), 3, "{:?}", p.to(&coordinator));
    p.land(&thread, LandAction::Discard).await.unwrap();
    assert_eq!(p.removed(), vec![removal(&thread, true, false)]);
    assert_eq!(p.s.runtime.closed(), vec![thread.pane_id.clone()]);
    assert_eq!(p.run(&thread).landed, Some(Landed::Discarded));
}

// main's defect #240's 2 (ADR 0242-phase-3-split, ADR 0256-orchestrator-foundation): a landing step
// pressed while the lead's turn settles must not delete the report the settlement has not read.
// TypeScript's `finalize` drops the turn and then awaits the screen before it reads report.json,
// and `land`'s Create PR clears that file as its own turn starts, so the turn reads as one without
// a report. Here the settlement holds the files it read with the turn, and the step it did not
// carry stays with the new turn: the expected values are the report the agent wrote and the step
// as `land` sent it.
#[tokio::test(start_paused = true)]
async fn a_landing_step_sent_while_the_leads_turn_settles_keeps_the_report_the_settlement_reads() {
    let p = project();
    // the thread starts with no base branch recorded: `land` reads the checkout's
    p.landing.answers().git_branch = answer(|_: PathBuf| async { None });
    let (_, thread) = p.ready().await;
    p.s.fleet
        .send(&thread.id, "go on", None, &CancellationToken::new())
        .await
        .unwrap();
    write_report(&p.s.root, &thread.id, "ready", "the second turn");
    // `land` stops at the base branch, after it waited for the settlements under way (none)
    let branch_gate = Arc::new(Semaphore::new(0));
    let held = branch_gate.clone();
    p.landing.answers().git_branch = answer(move |_: PathBuf| {
        let held = held.clone();
        async move {
            let _ = held.acquire().await;
            Some("main".to_owned())
        }
    });
    let (fleet, id) = (p.s.fleet.clone(), thread.id.clone());
    let landing = tokio::spawn(async move {
        fleet
            .land(&id, LandAction::Pr, &[], None, &CancellationToken::new())
            .await
    });
    settle().await;
    // the settlement stops at the screen, after it read the turn's files
    let read_gate = Arc::new(Semaphore::new(0));
    let reading = Arc::new(AtomicBool::new(false));
    let (held, seen, name) = (
        read_gate.clone(),
        reading.clone(),
        thread.herdr_name.clone(),
    );
    p.s.runtime.on_read(move |asked| {
        let (held, seen, name) = (held.clone(), seen.clone(), name.clone());
        async move {
            if asked == name {
                seen.store(true, Ordering::SeqCst);
                let _ = held.acquire().await;
            }
            Ok("the second screen".to_owned())
        }
    });
    p.turn(&thread, AgentState::Idle).await;
    until(
        || reading.load(Ordering::SeqCst),
        "the settlement reads the screen",
    )
    .await;
    branch_gate.close();
    landing.await.unwrap().unwrap();
    assert!(
        p.to(&thread)
            .last()
            .unwrap()
            .starts_with("[fleet] The person pressed Create PR"),
        "{:?}",
        p.to(&thread)
    );
    read_gate.close();
    until(
        || p.run(&thread).last_output.as_deref() == Some("the second screen"),
        "the settlement ends",
    )
    .await;
    let run = p.run(&thread);
    match run.outcome {
        Some(TurnOutcome::Report(report)) => assert_eq!(report.summary, "the second turn"),
        other => panic!("{other:?}"),
    }
    let step = run.landing.unwrap();
    assert_eq!(
        (step.action, step.sent, step.error),
        (LandAction::Pr, Some(true), None)
    );
}

// main's defect #176's 7: in a project run without the person, the end of a turn of a thread with
// no pull request asks GitHub whether one was opened and merged, and TypeScript's `finalize` awaits
// `gh pr view` before the coordinator's news and the waiters. Here neither waits on GitHub: the
// read still happens. The news is orchestrator.ts's `threadTurnEnded` for a ready report.
#[tokio::test(start_paused = true)]
async fn a_thread_without_a_pull_request_tells_its_coordinator_and_waiters_without_waiting_on_github()
 {
    let p = project_with(SetupOptions {
        config: Some(json!({ "autonomous": true })),
        ..SetupOptions::default()
    });
    let gh = Arc::new(Semaphore::new(0));
    let held = gh.clone();
    p.landing.answers().read_pull_request = answer(move |_: (PathBuf, String)| {
        let held = held.clone();
        async move {
            let _ = held.acquire().await;
            Ok(None)
        }
    });
    let coordinator = p.start_project("fix the retry").await;
    p.turn(&coordinator, AgentState::Idle).await;
    let thread = p.start_thread("Fix", &coordinator).await;
    let waiting = start_wait(&p.s.fleet, &thread.id, 60_000, &thread.group).await;
    write_report(&p.s.root, &thread.id, "ready", "bun test: 12 pass");
    p.turn(&thread, AgentState::Idle).await;
    assert!(waiting.is_finished(), "the wait waits on GitHub");
    assert_eq!(waiting.await.unwrap().unwrap().state, AgentState::Idle);
    until(
        || p.to(&coordinator).len() == 2,
        "the news while GitHub has not answered",
    )
    .await;
    assert_eq!(
        p.to(&coordinator)[1],
        [
            NEWS_HEADER,
            &format!(
                "- \"Fix\" ({}, {}) ended its turn: ready — bun test: 12 pass",
                thread.id,
                thread.branch.as_deref().unwrap()
            ),
        ]
        .join("\n")
    );
    let asked = p
        .landing
        .calls()
        .into_iter()
        .filter(|call| call.method == "read_pull_request")
        .count();
    assert_eq!(asked, 1, "GitHub is still asked");
    gh.close();
}
