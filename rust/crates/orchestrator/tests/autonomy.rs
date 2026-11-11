//! A project run without the person (fleet.json's `autonomous`): every turn a thread ends reaches
//! its coordinator, a project that stood still is called once, and a thread whose pull request was
//! merged on GitHub is closed. The tests named after an `it` are `server/fleet/orchestrator.test.ts`'s
//! describe `a project run without the person`, with their expected values; where the Rust version
//! differs (main's defects #176 and #189, and #266's read after a PR-less turn), the comment says why
//! and where the value comes from. The others pin the Rust version's behaviour on those defects, as
//! issue #268 states it.

mod common;

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use common::{
    FakeLanding, FakeRuntime, Folder, GRACE, SetupOptions, TestClock, answer, config, deps, role,
    settle, setup, sleep_ms, spawn, until,
};
use herdr_fleet_orchestrator::Clock;
use herdr_fleet_orchestrator::agents::AgentDefinition;
use herdr_fleet_orchestrator::events::{
    FleetEvent, PersonEvent, ReconciledEvent, StandstillEvent, TurnReport,
};
use herdr_fleet_orchestrator::fleet::{Orchestrator, SpawnRequest, ThreadRequest, Timings};
use herdr_fleet_orchestrator::github::PullRequestReading;
use herdr_fleet_orchestrator::outbox::Outbox;
use herdr_fleet_orchestrator::registry::RunRegistry;
use herdr_fleet_orchestrator::runtime::{
    AgentMetadata, AgentRuntime, CreateLocationOptions, RuntimeFuture, RuntimeLocation,
    StartOptions,
};
use protocol::{
    AgentRun, AgentState, ChecksState, ContractState, FleetAgentKind, Landed, PullRequest,
    PullRequestState,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

/// How the coordinator of a project run without the person hears its threads
/// (orchestrator.test.ts:2110, `NEWS`).
const NEWS: &str = "[fleet] Threads ended a turn. These come from the fleet, not from the person.";
/// The quiet period the describe runs with, in ms (orchestrator.test.ts:2111, `QUIET`).
const QUIET: u64 = 120;
/// How a standstill call starts (orchestrator.test.ts:2112, `ANDON`).
const ANDON: &str = "[fleet] Nothing in this project has moved";

/// `role(name, { interactive: true, spawning: true })`.
fn talking(name: &str) -> AgentDefinition {
    AgentDefinition {
        interactive: Some(true),
        spawning: Some(true),
        ..role(name)
    }
}

/// The describe's roles: a coordinator and a lead that talk, and a reviewer
/// (orchestrator.test.ts:2109). TypeScript's reviewer runs on agy; the Rust fleet refuses a reviewer
/// on agy, which stops to ask before each file it reads outside its folders (main's #190, ADR
/// 0248-launch-adapters), so it runs on pi here. No test of the describe depends on the CLI.
fn agents() -> Vec<AgentDefinition> {
    vec![talking("coordinator"), talking("lead"), role("reviewer")]
}

/// What herdr says for each pane, by its agent's name; `working` when unsaid
/// (orchestrator.test.ts:2115, `states`).
#[derive(Clone, Default)]
struct States(Arc<Mutex<HashMap<String, AgentState>>>);

impl States {
    fn set(&self, run: &AgentRun, state: AgentState) {
        lock(&self.0).insert(run.herdr_name.clone(), state);
    }

    fn of(&self, name: &str) -> AgentState {
        lock(&self.0)
            .get(name)
            .copied()
            .unwrap_or(AgentState::Working)
    }
}

/// What GitHub and git answer, and what they were asked (orchestrator.test.ts:2116-2118: `git`,
/// `removed`).
#[derive(Default)]
struct Git {
    pr: Option<PullRequestReading>,
    reads: usize,
    removed: Vec<String>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A pull request as GitHub shows it, at the commit `c0ffee` the branch is at here.
fn pull_request(number: u64, state: PullRequestState, checks: ChecksState) -> PullRequestReading {
    PullRequestReading {
        pr: PullRequest {
            number,
            url: format!("https://github.com/o/r/pull/{number}"),
            state,
            checks,
            failing: None,
        },
        head: "c0ffee".to_owned(),
    }
}

fn merged(number: u64) -> PullRequestReading {
    pull_request(number, PullRequestState::Merged, ChecksState::Pass)
}

/// The describe's `project()` (orchestrator.test.ts:2114-2142): a setup in /repo with
/// `autonomous` on, the quiet period shortened, herdr saying what `states` holds, and git and
/// GitHub answering from `git`.
struct Project {
    s: common::Setup,
    states: States,
    git: Arc<Mutex<Git>>,
}

fn project() -> Project {
    project_with(json!({}), agents())
}

fn project_with(config: Value, agents: Vec<AgentDefinition>) -> Project {
    let mut merged_config = json!({ "autonomous": true });
    for (key, value) in config.as_object().unwrap() {
        merged_config[key] = value.clone();
    }
    let s = setup(SetupOptions {
        agents: Some(agents),
        config: Some(merged_config),
        quiet: Some(Duration::from_millis(QUIET)),
        ..SetupOptions::default()
    });
    let git = Arc::new(Mutex::new(Git::default()));
    {
        let mut answers = s.landing.answers();
        answers.git_root = answer(|_: PathBuf| async { Some(PathBuf::from("/repo")) });
        answers.git_branch = answer(|_: PathBuf| async { Some("rust".to_owned()) });
        answers.branch_head = answer(|_: (PathBuf, String)| async { Some("c0ffee".to_owned()) });
        let read = git.clone();
        answers.read_pull_request = answer(move |_: (PathBuf, String)| {
            let read = read.clone();
            async move {
                let mut git = lock(&read);
                git.reads += 1;
                Ok(git.pr.clone())
            }
        });
        let removed = git.clone();
        answers.remove_thread = answer(move |(_, _, branch, _): common::RemoveArgs| {
            let removed = removed.clone();
            async move {
                lock(&removed).removed.push(branch);
                Ok(())
            }
        });
    }
    let states = States::default();
    let read = states.clone();
    s.runtime
        .on_get(move |name| std::future::ready(Ok(read.of(&name))));
    Project { s, states, git }
}

impl Project {
    /// herdr says `state` for the run's pane, and sends the event (`turn`).
    async fn turn(&self, run: &AgentRun, state: AgentState) {
        self.states.set(run, state);
        sleep_ms(GRACE.as_millis() as u64 + 5).await;
        self.s.fleet.on_pane_status(&run.pane_id);
        sleep_ms(30).await;
    }

    /// What the coordinator was given, in order (`toCoordinator`).
    fn to(&self, coordinator: &AgentRun) -> Vec<String> {
        prompts_to(&self.s.runtime, coordinator)
    }

    fn handoff(&self, run: &AgentRun, text: &str, contract: Option<&str>) {
        let dir = self.s.result_dir(&run.id);
        fs::write(dir.join("handoff.md"), text).unwrap();
        if let Some(contract) = contract {
            fs::write(dir.join("contract.md"), contract).unwrap();
        }
    }

    fn report(&self, run: &AgentRun, state: &str, summary: &str) {
        let report = json!({ "state": state, "summary": summary, "evidence": [] });
        fs::write(
            self.s.result_dir(&run.id).join("report.json"),
            report.to_string(),
        )
        .unwrap();
    }

    fn run(&self, run: &AgentRun) -> AgentRun {
        self.s.registry.get(&run.id).unwrap()
    }

    fn set_pr(&self, pr: Option<PullRequestReading>) {
        lock(&self.git).pr = pr;
    }

    fn removed(&self) -> Vec<String> {
        lock(&self.git).removed.clone()
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

    /// `fleet.spawn({ role: "reviewer", task: "review", group, cwd: "/repo" })`.
    async fn review(&self, group: &str) -> AgentRun {
        spawn(
            &self.s.fleet,
            SpawnRequest {
                role: "reviewer".to_owned(),
                task: Some("review".to_owned()),
                group: Some(group.to_owned()),
                cwd: Some("/repo".to_owned()),
                ..SpawnRequest::default()
            },
        )
        .await
        .unwrap()
    }

    /// The fleet sends the run `text` as a turn of its own (`fleet.send`).
    async fn send(&self, run: &AgentRun, text: &str) {
        self.s
            .fleet
            .send(&run.id, text, None, &CancellationToken::new())
            .await
            .unwrap();
    }

    /// The news about `run` still waiting in the outbox, in the order written.
    fn waiting_about(&self, run: &AgentRun) -> Vec<String> {
        Outbox::open(
            Some(self.s.root.join("fleet-outbox.json")),
            self.s.clock.clone(),
        )
        .unwrap()
        .pending_where(|notice| notice.about == run.id)
        .into_iter()
        .map(|notice| notice.text)
        .collect()
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

/// A thread as its coordinator reads it: title, id and branch (orchestrator.ts's `threadLabel`,
/// the branch spelled as the TypeScript tests spell it).
fn label(run: &AgentRun) -> String {
    format!("\"{}\" ({}, fleet/{})", run.name, run.id, run.id)
}

/// What the coordinator hears of a merge the fleet read after a thread's turn ended, when the lead's
/// last report says it finished: the thread closed (ADR 0268-autonomy, decision 2).
fn closed_on_merge(run: &AgentRun, number: u64, state: &str) -> String {
    format!(
        "- {}: GitHub shows pull request #{number} merged and its lead's last report says {state}, so the fleet closed the thread. Close its issue if it is still open.",
        label(run)
    )
}

/// What the coordinator hears of a merge the polling found while the lead is not done
/// (orchestrator.ts's `threadMerged`).
fn merged_news(run: &AgentRun, number: u64) -> String {
    format!(
        "- {} merged pull request #{number}; the thread closes once its lead's turn ends",
        label(run)
    )
}

fn state_name(state: AgentState) -> &'static str {
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

// orchestrator.test.ts: "tells the coordinator every turn a thread ends, with its report and contract, not only its questions"
#[tokio::test(start_paused = true)]
async fn tells_the_coordinator_every_turn_a_thread_ends_with_its_report_and_contract_not_only_its_questions()
 {
    let p = project();
    // the coordinator's own turn is still running while both threads end
    let coordinator = p.start_project("port the parser").await;
    let done = p.start_thread("Done", &coordinator).await;
    let issues = p.start_thread("Issues", &coordinator).await;
    p.handoff(
        &done,
        "## HANDOFF\nOutcome: parses",
        Some("- [x] A1 parses — evidence: test\n- [!] A2 fast — evidence: none"),
    );
    p.report(&done, "ready", "cargo test: 40 pass");
    p.report(&issues, "failed", "2 cases fail");
    p.turn(&done, AgentState::Idle).await;
    p.turn(&issues, AgentState::Idle).await;
    p.turn(&coordinator, AgentState::Idle).await;
    assert_eq!(
        p.to(&coordinator)[1],
        [
            NEWS,
            &format!(
                "- {} ended its turn: ready — cargo test: 40 pass\n  Contract: A1 ✓ A2 ✗",
                label(&done)
            ),
            &format!("- {} ended its turn: failed — 2 cases fail", label(&issues)),
        ]
        .join("\n")
    );
    for run in [&done, &issues] {
        assert_eq!(p.waiting_about(run), Vec::<String>::new());
    }
}

// orchestrator.test.ts: "closes a thread whose lead merged its own pull request as the lead's turn ends, and says so"
//
// The thread closes as in TypeScript. What the coordinator hears differs: the thread had no pull
// request recorded, so #266 reads GitHub after the turn's news is queued (main's defect #176's 7,
// ADR 0266-landing), and the news quotes no pull request. The merge reaches the coordinator in a
// line of its own, as ADR 0268-autonomy (decision 2) says; the turn's line is TypeScript's without
// its pull request.
#[tokio::test(start_paused = true)]
async fn closes_a_thread_whose_lead_merged_its_own_pull_request_as_the_leads_turn_ends_and_says_so()
{
    let p = project();
    let coordinator = p.start_project("go").await;
    p.turn(&coordinator, AgentState::Idle).await;
    let thread = p.start_thread("Port", &coordinator).await;
    p.set_pr(Some(merged(7)));
    p.report(&thread, "ready", "Merged #7 into rust.");
    p.turn(&thread, AgentState::Idle).await;
    until(
        || p.run(&thread).landed == Some(Landed::Merged),
        "the thread closed",
    )
    .await;
    assert_eq!(p.removed(), vec![thread.branch.clone().unwrap()]);
    p.turn(&coordinator, AgentState::Idle).await;
    until(
        || p.to(&coordinator).len() >= 2 && p.to(&coordinator).concat().contains("#7 merged"),
        "the coordinator hears of the merge",
    )
    .await;
    let heard = p.to(&coordinator)[1..].join("\n");
    assert!(
        heard.contains(&format!(
            "- {} ended its turn: ready — Merged #7 into rust.",
            label(&thread)
        )),
        "{heard}"
    );
    assert!(
        heard.contains(&closed_on_merge(&thread, 7, "ready")),
        "{heard}"
    );
}

// orchestrator.test.ts: "tells the coordinator of a turn the thread's agent started itself, as its helpers' results woke it"
//
// As above, the merge reaches the coordinator in a line of its own (#176's 7, ADR 0266-landing; ADR
// 0268-autonomy, decision 2).
#[tokio::test(start_paused = true)]
#[ignore = "#267 settles a turn the fleet did not send (settle_unsent_turn is its stub)"]
async fn tells_the_coordinator_of_a_turn_the_threads_agent_started_itself_as_its_helpers_results_woke_it()
 {
    let p = project();
    let coordinator = p.start_project("go").await;
    p.turn(&coordinator, AgentState::Idle).await;
    let thread = p.start_thread("Split", &coordinator).await;
    // the lead's turn breaks off while it waits for its helpers: it reports waiting
    p.report(&thread, "waiting", "Waiting for the helpers.");
    p.turn(&thread, AgentState::Idle).await;
    assert_eq!(
        p.to(&coordinator)[1],
        [
            NEWS,
            &format!(
                "- {} ended its turn: waiting — Waiting for the helpers.",
                label(&thread)
            ),
        ]
        .join("\n")
    );
    p.turn(&coordinator, AgentState::Idle).await;
    // the helpers' results start the next turn: the fleet sent nothing
    p.turn(&thread, AgentState::Working).await;
    p.set_pr(Some(merged(9)));
    p.handoff(
        &thread,
        "## HANDOFF\nOutcome: split",
        Some("- [x] A1 split — evidence: #9"),
    );
    p.report(&thread, "ready", "Merged #9 into rust.");
    p.turn(&thread, AgentState::Idle).await;
    until(
        || p.run(&thread).landed == Some(Landed::Merged),
        "the thread closed",
    )
    .await;
    let run = p.run(&thread);
    let contract = run.contract.unwrap();
    assert_eq!(
        (contract[0].id.as_str(), contract[0].state),
        ("A1", ContractState::Met)
    );
    assert_eq!(p.removed(), vec![thread.branch.clone().unwrap()]);
    until(
        || p.to(&coordinator).concat().contains("#9 merged"),
        "the coordinator hears of the merge",
    )
    .await;
    let heard = p.to(&coordinator)[2..].join("\n");
    assert!(
        heard.contains(&format!(
            "- {} ended its turn: ready — Merged #9 into rust.\n  Contract: A1 ✓",
            label(&thread)
        )),
        "{heard}"
    );
    assert!(
        heard.contains(&closed_on_merge(&thread, 9, "ready")),
        "{heard}"
    );
}

// orchestrator.test.ts: "does not tell the coordinator again while a thread stays settled"
#[tokio::test(start_paused = true)]
async fn does_not_tell_the_coordinator_again_while_a_thread_stays_settled() {
    let p = project();
    let coordinator = p.start_project("go").await;
    p.turn(&coordinator, AgentState::Idle).await;
    let thread = p.start_thread("Port", &coordinator).await;
    p.report(&thread, "failed", "1 case fails");
    p.turn(&thread, AgentState::Idle).await;
    p.turn(&coordinator, AgentState::Idle).await;
    p.turn(&thread, AgentState::Idle).await;
    p.s.fleet.reconcile_all().await;
    sleep_ms(30).await;
    assert_eq!(p.to(&coordinator).len(), 2);
}

// orchestrator.test.ts: "tells the coordinator once when it and every thread stayed settled through the quiet period, and again only after a thread moved"
#[tokio::test(start_paused = true)]
async fn tells_the_coordinator_once_when_it_and_every_thread_stayed_settled_through_the_quiet_period_and_again_only_after_a_thread_moved()
 {
    let p = project();
    let fleet = &p.s.fleet;
    let coordinator = p.start_project("go").await;
    p.turn(&coordinator, AgentState::Idle).await;
    let thread = p.start_thread("Port", &coordinator).await;
    p.handoff(&thread, "ISSUES — 1 case fails", None);
    p.turn(&thread, AgentState::Idle).await;
    p.turn(&coordinator, AgentState::Idle).await;
    let told = p.to(&coordinator).len();
    fleet.supervise_projects().await;
    // not before the quiet period is over
    fleet.supervise_projects().await;
    assert_eq!(p.to(&coordinator).len(), told);
    sleep_ms(QUIET + 20).await;
    fleet.supervise_projects().await;
    let andon = p.to(&coordinator)[told].clone();
    assert!(
        andon.starts_with(&format!(
            "{ANDON} for 0 minutes: you and every thread are settled. This comes from the fleet, not from the person."
        )),
        "{andon}"
    );
    assert!(
        andon.contains(&format!("- {}: idle", label(&thread))),
        "{andon}"
    );
    // the coordinator answers and does nothing: no second call for the same quiet period
    p.turn(&coordinator, AgentState::Idle).await;
    sleep_ms(QUIET + 20).await;
    fleet.supervise_projects().await;
    assert_eq!(p.to(&coordinator).len(), told + 1);
    // a thread moves, then settles: the next quiet period calls again
    p.turn(&thread, AgentState::Working).await;
    fleet.supervise_projects().await;
    p.turn(&thread, AgentState::Idle).await;
    p.turn(&coordinator, AgentState::Idle).await;
    let before = p.to(&coordinator).len();
    fleet.supervise_projects().await;
    sleep_ms(QUIET + 20).await;
    fleet.supervise_projects().await;
    assert_eq!(p.to(&coordinator).len(), before + 1);
    assert!(p.to(&coordinator).last().unwrap().starts_with(ANDON));
}

// orchestrator.test.ts: "records each change of a run's state once, whether the fleet sent the turn, the person's messages, a standstill and a thread closed against GitHub"
#[tokio::test(start_paused = true)]
async fn records_each_change_of_a_runs_state_once_whether_the_fleet_sent_the_turn_the_persons_messages_a_standstill_and_a_thread_closed_against_github()
 {
    let p = project();
    let fleet = &p.s.fleet;
    let coordinator = p.start_project("go").await;
    p.turn(&coordinator, AgentState::Idle).await;
    p.start_project("and this too").await;
    p.turn(&coordinator, AgentState::Idle).await;
    let thread = p.start_thread("Port", &coordinator).await;
    p.handoff(&thread, "ISSUES", None);
    p.turn(&thread, AgentState::Idle).await;
    p.turn(&coordinator, AgentState::Idle).await;
    // a turn the fleet did not send: the lead's own
    p.turn(&thread, AgentState::Working).await;
    p.turn(&thread, AgentState::Idle).await;
    p.turn(&coordinator, AgentState::Idle).await;
    let states: Vec<String> =
        p.s.events()
            .into_iter()
            .filter_map(|event| match event {
                FleetEvent::State(state) if state.run == thread.id => Some(format!(
                    "{}>{}{}",
                    state.from.map_or("-", state_name),
                    state_name(state.to),
                    if state.sent { " sent" } else { "" }
                )),
                _ => None,
            })
            .collect();
    // ready, the task sent, that turn ended; then a turn of its own, which the fleet did not send
    assert_eq!(
        states,
        [
            "->starting",
            "starting>idle",
            "idle>working sent",
            "working>idle sent",
            "idle>working",
            "working>idle"
        ]
    );
    let people: Vec<PersonEvent> =
        p.s.events()
            .into_iter()
            .filter_map(|event| match event {
                FleetEvent::Person(person) => Some(person),
                _ => None,
            })
            .collect();
    assert_eq!(
        people,
        [PersonEvent {
            run: coordinator.id.clone(),
            project: "/repo".to_owned()
        }]
    );
    let first =
        p.s.events()
            .into_iter()
            .find_map(|event| match event {
                FleetEvent::State(state) if state.run == thread.id => Some(state),
                _ => None,
            })
            .unwrap();
    assert_eq!(
        (
            first.role.as_str(),
            first.agent,
            first.project.as_deref(),
            first.group.as_str()
        ),
        (
            "lead",
            FleetAgentKind::Pi,
            Some("/repo"),
            thread.group.as_str()
        )
    );
    p.set_pr(Some(merged(12)));
    fleet.supervise_projects().await;
    sleep_ms(QUIET + 20).await;
    fleet.supervise_projects().await;
    let reconciled: Vec<ReconciledEvent> =
        p.s.events()
            .into_iter()
            .filter_map(|event| match event {
                FleetEvent::Reconciled(reconciled) => Some(reconciled),
                _ => None,
            })
            .collect();
    assert_eq!(
        reconciled,
        [ReconciledEvent {
            run: thread.id.clone(),
            project: "/repo".to_owned(),
            pr: Some(12)
        }]
    );
    p.turn(&coordinator, AgentState::Idle).await;
    fleet.supervise_projects().await;
    sleep_ms(QUIET + 20).await;
    fleet.supervise_projects().await;
    let standstills: Vec<(String, String)> = p
        .s
        .events()
        .into_iter()
        .filter_map(|event| match event {
            FleetEvent::Standstill(StandstillEvent { run, project, .. }) => Some((run, project)),
            _ => None,
        })
        .collect();
    assert_eq!(standstills, [(coordinator.id.clone(), "/repo".to_owned())]);
}

// orchestrator.test.ts: "no longer tells the coordinator of an agent whose runs end without a report, as #184 did"
//
// The Rust fleet has no anomaly event at all (`FleetEvent` has no such kind), so TypeScript's check
// that none was recorded becomes: the supervision records nothing.
#[tokio::test(start_paused = true)]
async fn no_longer_tells_the_coordinator_of_an_agent_whose_runs_end_without_a_report_as_184_did() {
    let p = project();
    let coordinator = p.start_project("go").await;
    p.turn(&coordinator, AgentState::Idle).await;
    let thread = p.start_thread("Port", &coordinator).await;
    p.report(&thread, "waiting", "Waiting for the review.");
    p.turn(&thread, AgentState::Idle).await;
    p.turn(&coordinator, AgentState::Idle).await;
    // two reviews whose panes closed before they wrote anything, and one that did its work
    let mut lost = Vec::new();
    for _ in 0..3 {
        lost.push(p.review(&thread.group).await);
    }
    p.handoff(&lost[2], "no findings", None);
    p.report(&lost[2], "ready", "No findings.");
    p.turn(&lost[2], AgentState::Idle).await;
    p.s.fleet.on_pane_ended(&lost[0].pane_id);
    p.s.fleet.on_pane_ended(&lost[1].pane_id);
    p.turn(&coordinator, AgentState::Idle).await;
    let told = p.to(&coordinator).len();
    let recorded = p.s.events().len();
    p.s.fleet.supervise_projects().await;
    assert_eq!(p.to(&coordinator)[told..].to_vec(), Vec::<String>::new());
    assert_eq!(p.s.events().len(), recorded);
}

// orchestrator.test.ts: "records each turn's end with the report read, and keeps the pane of a helper whose turn settled without one"
#[tokio::test(start_paused = true)]
async fn records_each_turns_end_with_the_report_read_and_keeps_the_pane_of_a_helper_whose_turn_settled_without_one()
 {
    let p = project_with(json!({ "closeOnSettle": false }), agents());
    let coordinator = p.start_project("go").await;
    p.turn(&coordinator, AgentState::Idle).await;
    let thread = p.start_thread("Port", &coordinator).await;
    p.report(&thread, "waiting", "Waiting for the review.");
    p.turn(&thread, AgentState::Idle).await;
    let mut reviews = Vec::new();
    for _ in 0..2 {
        reviews.push(p.review(&thread.group).await);
    }
    p.report(&reviews[0], "ready", "No findings.");
    for review in &reviews {
        p.turn(review, AgentState::Idle).await;
    }
    let turns: Vec<(String, Option<TurnReport>, bool)> =
        p.s.events()
            .into_iter()
            .filter_map(|event| match event {
                FleetEvent::Turn(turn) if turn.role == "reviewer" => {
                    Some((turn.run, turn.report, turn.interactive))
                }
                _ => None,
            })
            .collect();
    assert_eq!(
        turns,
        [
            (reviews[0].id.clone(), Some(TurnReport::Ready), false),
            (reviews[1].id.clone(), Some(TurnReport::None), false),
        ]
    );
    assert_eq!(
        p.s.fleet.get(&reviews[1].id, None).unwrap().state,
        AgentState::Idle
    );
}

// orchestrator.test.ts: "leaves a project run with the person alone: no standstill call and no closing against GitHub"
#[tokio::test(start_paused = true)]
async fn leaves_a_project_run_with_the_person_alone_no_standstill_call_and_no_closing_against_github()
 {
    let s = setup(SetupOptions {
        agents: Some(agents()),
        quiet: Some(Duration::from_millis(QUIET)),
        ..SetupOptions::default()
    });
    let removed = Arc::new(Mutex::new(Vec::<String>::new()));
    {
        let mut answers = s.landing.answers();
        answers.git_root = answer(|_: PathBuf| async { Some(PathBuf::from("/repo")) });
        answers.git_branch = answer(|_: PathBuf| async { Some("main".to_owned()) });
        answers.branch_head = answer(|_: (PathBuf, String)| async { Some("c0ffee".to_owned()) });
        let kept = removed.clone();
        answers.remove_thread = answer(move |(_, _, branch, _): common::RemoveArgs| {
            let kept = kept.clone();
            async move {
                lock(&kept).push(branch);
                Ok(())
            }
        });
        answers.read_pull_request = answer(|_: (PathBuf, String)| async { Ok(Some(merged(3))) });
    }
    s.runtime.set_get_status(AgentState::Idle);
    let coordinator = s
        .fleet
        .start_project("go", Some("/repo"), None, &CancellationToken::new())
        .await
        .unwrap();
    let thread = s
        .fleet
        .start_thread(
            ThreadRequest {
                title: "Port".to_owned(),
                task: Some("t".to_owned()),
                cwd: Some("/repo".to_owned()),
                caller_run: Some(coordinator.id.clone()),
                ..ThreadRequest::default()
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    fs::write(s.result_dir(&thread.id).join("handoff.md"), "PASS").unwrap();
    sleep_ms(GRACE.as_millis() as u64 + 5).await;
    s.fleet.on_pane_status(&thread.pane_id);
    s.fleet.on_pane_status(&coordinator.pane_id);
    sleep_ms(30).await;
    let told = prompts_to(&s.runtime, &coordinator).len();
    s.fleet.supervise_projects().await;
    sleep_ms(QUIET + 20).await;
    s.fleet.supervise_projects().await;
    assert_eq!(prompts_to(&s.runtime, &coordinator).len(), told);
    assert_eq!(s.registry.get(&thread.id).unwrap().landed, None);
    assert_eq!(*lock(&removed), Vec::<String>::new());
}

// orchestrator.test.ts: "closes a thread GitHub shows merged once its lead stayed settled through the quiet period, and tells the coordinator"
#[tokio::test(start_paused = true)]
async fn closes_a_thread_github_shows_merged_once_its_lead_stayed_settled_through_the_quiet_period_and_tells_the_coordinator()
 {
    let p = project();
    let fleet = &p.s.fleet;
    let coordinator = p.start_project("go").await;
    p.turn(&coordinator, AgentState::Idle).await;
    let thread = p.start_thread("Port", &coordinator).await;
    // its turn ended before the fleet saw a pull request; the merge came after, and no turn ended since
    p.handoff(&thread, "ISSUES — waiting for the review", None);
    p.turn(&thread, AgentState::Idle).await;
    p.turn(&coordinator, AgentState::Idle).await;
    assert_eq!(p.run(&thread).pr, None);
    p.set_pr(Some(merged(11)));
    fleet.supervise_projects().await;
    fleet.supervise_projects().await;
    // a lead that settled just now may be between two turns of its own: not yet
    assert_eq!(p.run(&thread).landed, None);
    sleep_ms(QUIET + 20).await;
    fleet.supervise_projects().await;
    let run = p.run(&thread);
    assert_eq!(run.landed, Some(Landed::Merged));
    let pr = run.pr.unwrap();
    assert_eq!((pr.number, pr.state), (11, PullRequestState::Merged));
    assert_eq!(p.removed(), vec![thread.branch.clone().unwrap()]);
    until(
        || {
            p.to(&coordinator)
                .iter()
                .any(|text| text.contains("pull request #11"))
        },
        "the coordinator hears of it",
    )
    .await;
    assert_eq!(
        p.to(&coordinator).last().unwrap(),
        &[
            NEWS,
            &format!(
                "- {}: GitHub shows pull request #11 merged and its lead stayed settled 0 minutes, so the fleet closed the thread. Close its issue if it is still open.",
                label(&thread)
            ),
        ]
        .join("\n")
    );
}

// orchestrator.test.ts: "leaves a thread whose pull request the polling finds merged open for its lead to finish, tells the coordinator, and closes it as the lead's turn ends"
#[tokio::test(start_paused = true)]
#[ignore = "#267 settles a turn the fleet did not send (settle_unsent_turn is its stub)"]
async fn leaves_a_thread_whose_pull_request_the_polling_finds_merged_open_for_its_lead_to_finish_tells_the_coordinator_and_closes_it_as_the_leads_turn_ends()
 {
    let p = project();
    let (coordinator, thread) = polled_merge(&p).await;
    // the lead's own next turn ends: the thread closes
    p.turn(&thread, AgentState::Working).await;
    p.handoff(&thread, "PASS — merged #8, closed the issue", None);
    p.turn(&thread, AgentState::Idle).await;
    assert_eq!(p.run(&thread).landed, Some(Landed::Merged));
    assert_eq!(p.removed(), vec![thread.branch.clone().unwrap()]);
    drop(coordinator);
}

/// The steps of the `it` above up to the lead's next turn (orchestrator.test.ts:2367-2390): a
/// thread opens pull request #8, the polling finds it merged, and the coordinator hears of it once.
async fn polled_merge(p: &Project) -> (AgentRun, AgentRun) {
    let coordinator = p.start_project("go").await;
    p.turn(&coordinator, AgentState::Idle).await;
    let thread = p.start_thread("Port", &coordinator).await;
    p.set_pr(Some(pull_request(
        8,
        PullRequestState::Open,
        ChecksState::Pending,
    )));
    p.handoff(&thread, "PASS — opened #8", None);
    p.turn(&thread, AgentState::Idle).await;
    p.turn(&coordinator, AgentState::Idle).await;
    let pr = p.run(&thread).pr.unwrap();
    assert_eq!((pr.number, pr.state), (8, PullRequestState::Open));
    // the lead merged it in a turn that broke off to wait: it has the issue to close yet
    p.set_pr(Some(pull_request(
        8,
        PullRequestState::Merged,
        ChecksState::Pending,
    )));
    p.s.fleet.refresh_pull_requests().await;
    sleep_ms(30).await;
    let run = p.run(&thread);
    let pr = run.pr.unwrap();
    assert_eq!((pr.number, pr.state), (8, PullRequestState::Merged));
    assert_eq!(run.landed, None);
    assert_eq!(p.removed(), Vec::<String>::new());
    assert_eq!(
        p.to(&coordinator)[2],
        [NEWS, &merged_news(&thread, 8)].join("\n")
    );
    // told once, however often the polling runs
    p.turn(&coordinator, AgentState::Idle).await;
    p.s.fleet.refresh_pull_requests().await;
    sleep_ms(30).await;
    assert_eq!(p.to(&coordinator).len(), 3);
    (coordinator, thread)
}

// The `it` above with the lead's next turn one the fleet sent, which settles before #267 lands: the
// same expected values (orchestrator.test.ts:2367-2398).
#[tokio::test(start_paused = true)]
async fn a_thread_the_polling_found_merged_closes_as_the_next_turn_the_fleet_sent_its_lead_ends() {
    let p = project();
    let (_coordinator, thread) = polled_merge(&p).await;
    p.send(&thread, "go on").await;
    p.handoff(&thread, "PASS — merged #8, closed the issue", None);
    p.turn(&thread, AgentState::Idle).await;
    assert_eq!(p.run(&thread).landed, Some(Landed::Merged));
    assert_eq!(p.removed(), vec![thread.branch.clone().unwrap()]);
}

// main's defect #176's 1: the lead merged its pull request and broke off its turn to wait for a
// helper, and TypeScript closed the thread as that turn ended, before the lead closed its issue.
// Issue #268's expected behaviour: the thread waits. A lead that reports it goes on (waiting or
// progress) keeps its thread open; the coordinator hears the turn with the merge; the thread closes
// as a later turn ends with a report that does not go on (ADR 0268-autonomy, decision 1). The
// lines are orchestrator.ts's `threadTurnEnded`.
#[tokio::test(start_paused = true)]
async fn a_lead_that_merged_and_waits_for_a_helper_keeps_its_thread_open_until_a_later_turn_ends() {
    let p = project();
    let coordinator = p.start_project("go").await;
    p.turn(&coordinator, AgentState::Idle).await;
    let thread = p.start_thread("Port", &coordinator).await;
    p.set_pr(Some(pull_request(
        8,
        PullRequestState::Open,
        ChecksState::Pass,
    )));
    p.report(&thread, "ready", "Opened #8.");
    p.turn(&thread, AgentState::Idle).await;
    p.turn(&coordinator, AgentState::Idle).await;
    assert!(p.run(&thread).pr.is_some());
    // the lead merges, then breaks off its turn to wait for a helper
    p.send(&thread, "merge it").await;
    p.set_pr(Some(merged(8)));
    p.report(&thread, "waiting", "Merged #8; waiting for the helper.");
    p.turn(&thread, AgentState::Idle).await;
    assert_eq!(p.run(&thread).landed, None);
    assert_eq!(p.removed(), Vec::<String>::new());
    until(
        || p.to(&coordinator).len() == 3,
        "the coordinator hears of the turn",
    )
    .await;
    assert_eq!(
        p.to(&coordinator)[2],
        [
            NEWS,
            &format!(
                "- {} ended its turn: waiting — Merged #8; waiting for the helper.\n  Pull request #8: MERGED",
                label(&thread)
            ),
        ]
        .join("\n")
    );
    // the polling finds nothing more to say: the pull request is no longer open
    p.turn(&coordinator, AgentState::Idle).await;
    p.s.fleet.refresh_pull_requests().await;
    sleep_ms(30).await;
    assert_eq!(p.to(&coordinator).len(), 3);
    // the helper's result came, and the lead closed the issue
    p.send(&thread, "the helper is done").await;
    p.report(&thread, "ready", "Closed the issue.");
    p.turn(&thread, AgentState::Idle).await;
    assert_eq!(p.run(&thread).landed, Some(Landed::Merged));
    assert_eq!(p.removed(), vec![thread.branch.clone().unwrap()]);
    until(
        || p.to(&coordinator).len() == 4,
        "the coordinator hears of the turn",
    )
    .await;
    assert_eq!(
        p.to(&coordinator)[3],
        [
            NEWS,
            &format!(
                "- {} ended its turn: ready — Closed the issue.\n  Pull request #8: MERGED, and the thread is closed",
                label(&thread)
            ),
        ]
        .join("\n")
    );
}

// main's defect #176's 1, where #266 reads GitHub after a PR-less thread's turn (#176's 7): the
// lead opened and merged its pull request in one turn, then broke off to wait. The thread stays
// open, and the coordinator hears TypeScript's `threadMerged` (ADR 0268-autonomy, decision 2).
// While a helper of the thread is at work, the quiet period does not close it either; once
// everything in the thread stayed settled through it, the thread closes and the coordinator hears
// TypeScript's `threadClosedAfterMerge` (decision 3).
#[tokio::test(start_paused = true)]
async fn a_lead_that_merged_in_its_first_turn_and_waits_for_a_helper_keeps_its_thread_open_while_the_helper_works()
 {
    let p = project();
    let fleet = &p.s.fleet;
    let coordinator = p.start_project("go").await;
    p.turn(&coordinator, AgentState::Idle).await;
    let thread = p.start_thread("Port", &coordinator).await;
    let helper = p.review(&thread.group).await;
    p.states.set(&helper, AgentState::Working);
    p.set_pr(Some(merged(5)));
    p.report(&thread, "waiting", "Merged #5; waiting for the review.");
    p.turn(&thread, AgentState::Idle).await;
    until(
        || {
            p.to(&coordinator)
                .concat()
                .contains("merged pull request #5")
        },
        "the coordinator hears of the merge",
    )
    .await;
    assert_eq!(p.run(&thread).landed, None);
    let heard = p.to(&coordinator)[1..].join("\n");
    assert!(heard.contains(&merged_news(&thread, 5)), "{heard}");
    // the helper works through three quiet periods: the thread stays open
    for _ in 0..3 {
        fleet.supervise_projects().await;
        sleep_ms(QUIET + 20).await;
    }
    assert_eq!(p.run(&thread).landed, None);
    assert_eq!(p.removed(), Vec::<String>::new());
    // the helper settles and nothing moves through the quiet period
    p.turn(&helper, AgentState::Idle).await;
    fleet.supervise_projects().await;
    sleep_ms(QUIET + 20).await;
    fleet.supervise_projects().await;
    assert_eq!(p.run(&thread).landed, Some(Landed::Merged));
    assert_eq!(p.removed(), vec![thread.branch.clone().unwrap()]);
}

// main's defect #176's 2: the polling's merge news took the place of news the coordinator had not
// heard yet (a thread's question). Issue #268's expected behaviour: both reach the coordinator, in
// one message once it is free. The question's line is orchestrator.ts's `threadQuestion`, the
// merge's `threadMerged`.
#[tokio::test(start_paused = true)]
async fn a_merge_the_polling_finds_reaches_the_coordinator_with_the_threads_question_it_has_not_heard_yet()
 {
    let p = project();
    // the coordinator's own turn is still running
    let coordinator = p.start_project("go").await;
    let thread = p.start_thread("Port", &coordinator).await;
    p.set_pr(Some(pull_request(
        8,
        PullRequestState::Open,
        ChecksState::Pass,
    )));
    let report = json!({ "state": "blocked", "summary": "Keep the old API?", "evidence": [], "human_action": "Keep the old API?" });
    fs::write(
        p.s.result_dir(&thread.id).join("report.json"),
        report.to_string(),
    )
    .unwrap();
    p.handoff(&thread, "## HANDOFF\nKeep the old API?", None);
    p.turn(&thread, AgentState::Idle).await;
    until(|| p.run(&thread).pr.is_some(), "the pull request is read").await;
    p.set_pr(Some(merged(8)));
    p.s.fleet.refresh_pull_requests().await;
    sleep_ms(30).await;
    assert_eq!(p.to(&coordinator).len(), 1, "the coordinator is not free");
    assert_eq!(p.waiting_about(&thread).len(), 2);
    p.turn(&coordinator, AgentState::Idle).await;
    assert_eq!(
        p.to(&coordinator)[1],
        [
            NEWS,
            &format!(
                "- {} asks the person: Keep the old API?\n  ## HANDOFF\n  Keep the old API?",
                label(&thread)
            ),
            &merged_news(&thread, 8),
        ]
        .join("\n")
    );
    // the lead waits for the person: a merge seen outside its turn does not close the thread
    assert_eq!(p.run(&thread).landed, None);
}

// main's defect #176's 3: a thread read merged was closed only by a live coordinator's supervision,
// so with the coordinator gone its thread, worktree and branch stayed. Issue #268's expected
// behaviour: the thread closes all the same, and its news waits in the outbox for the project's
// next coordinator. The news is orchestrator.ts's `threadClosedAfterMerge`.
#[tokio::test(start_paused = true)]
async fn a_thread_read_merged_closes_after_its_coordinator_ended() {
    let p = project();
    let fleet = &p.s.fleet;
    let coordinator = p.start_project("go").await;
    p.turn(&coordinator, AgentState::Idle).await;
    let thread = p.start_thread("Port", &coordinator).await;
    p.report(&thread, "waiting", "Waiting for the review.");
    p.turn(&thread, AgentState::Idle).await;
    p.turn(&coordinator, AgentState::Idle).await;
    fleet.on_pane_ended(&coordinator.pane_id);
    settle().await;
    assert!(matches!(
        p.run(&coordinator).state,
        AgentState::Stopped | AgentState::Failed
    ));
    p.set_pr(Some(merged(4)));
    fleet.supervise_projects().await;
    sleep_ms(QUIET + 20).await;
    fleet.supervise_projects().await;
    assert_eq!(p.run(&thread).landed, Some(Landed::Merged));
    assert_eq!(p.removed(), vec![thread.branch.clone().unwrap()]);
    assert_eq!(
        p.waiting_about(&thread),
        vec![format!(
            "{}: GitHub shows pull request #4 merged and its lead stayed settled 0 minutes, so the fleet closed the thread. Close its issue if it is still open.",
            label(&thread)
        )]
    );
}

/// The fake runtime, with herdr slow to show one agent's screen once `slow` names it: the real
/// runtime reads the screen over herdr's socket, and the standstill call reads it last, to look for
/// the person's draft (as `tests/notices.rs`'s `SlowScreen`).
struct SlowScreen {
    inner: Arc<FakeRuntime>,
    slow: Mutex<Option<String>>,
}

impl AgentRuntime for SlowScreen {
    fn create_location<'a>(
        &'a self,
        options: CreateLocationOptions,
        cancel: &'a CancellationToken,
    ) -> RuntimeFuture<'a, RuntimeLocation> {
        self.inner.create_location(options, cancel)
    }

    fn start(&self, options: StartOptions) -> RuntimeFuture<'_, AgentState> {
        self.inner.start(options)
    }

    fn close_pane<'a>(&'a self, pane_id: &'a str) -> RuntimeFuture<'a, ()> {
        self.inner.close_pane(pane_id)
    }

    fn prompt<'a>(
        &'a self,
        name: &'a str,
        text: &'a str,
        cancel: &'a CancellationToken,
    ) -> RuntimeFuture<'a, AgentState> {
        self.inner.prompt(name, text, cancel)
    }

    fn get<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, AgentState> {
        self.inner.get(name)
    }

    fn read<'a>(&'a self, name: &'a str, lines: u32) -> RuntimeFuture<'a, String> {
        self.inner.read(name, lines)
    }

    fn screen<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, String> {
        // slow once: the next read of that screen answers at once
        let slow = {
            let mut slow = lock(&self.slow);
            let hit = slow.as_deref() == Some(name);
            if hit {
                *slow = None;
            }
            hit
        };
        Box::pin(async move {
            if slow {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            self.inner.screen(name).await
        })
    }

    fn interrupt<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, ()> {
        self.inner.interrupt(name)
    }

    fn focus<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, ()> {
        self.inner.focus(name)
    }

    fn report_metadata(&self, metadata: AgentMetadata) -> RuntimeFuture<'_, ()> {
        self.inner.report_metadata(metadata)
    }
}

// main's defect #176's 5: the standstill call neither claimed the coordinator's delivery nor looked
// for a turn sent during its last await, so two messages could reach one coordinator's pane while
// its turn ran. Issue #268's expected behaviour: one at a time. Here herdr is slow to show the
// coordinator's screen as the standstill call looks for the person's draft, and meanwhile the
// polling finds a merge to tell the same coordinator. The standstill goes out alone; the merge
// waits in the outbox and goes out once the coordinator answered.
#[tokio::test(start_paused = true)]
async fn a_standstill_call_and_a_delivery_never_reach_one_coordinator_at_once() {
    let folder = Folder::new();
    let root = folder.path();
    let clock: Arc<dyn Clock> = TestClock::new();
    let runtime = FakeRuntime::new();
    let screens = Arc::new(SlowScreen {
        inner: runtime.clone(),
        slow: Mutex::new(None),
    });
    let registry = Arc::new(RunRegistry::open(
        Some(root.join("runs.json")),
        clock.as_ref(),
    ));
    // a coordinator whose CLI shows a draft in its input, so the call reads its screen
    let roles = vec![
        AgentDefinition {
            agent: FleetAgentKind::Claude,
            ..talking("coordinator")
        },
        talking("lead"),
    ];
    let mut deps = deps(
        runtime.clone(),
        registry.clone(),
        root,
        clock,
        config(Some(&json!({ "autonomous": true }))),
        roles,
    );
    deps.runtime = screens.clone();
    let landing = FakeLanding::new();
    let git = Arc::new(Mutex::new(Git::default()));
    {
        let mut answers = landing.answers();
        answers.git_root = answer(|_: PathBuf| async { Some(PathBuf::from("/repo")) });
        answers.git_branch = answer(|_: PathBuf| async { Some("rust".to_owned()) });
        let read = git.clone();
        answers.read_pull_request = answer(move |_: (PathBuf, String)| {
            let read = read.clone();
            async move { Ok(lock(&read).pr.clone()) }
        });
    }
    deps.landing = landing;
    deps.timings = Timings {
        pre_visual_grace: GRACE,
        ready_screen: Duration::from_millis(300),
        usage_screen: Duration::from_millis(300),
        quiet: Duration::from_millis(QUIET),
        ..Timings::default()
    };
    let fleet = Orchestrator::new(deps).unwrap();
    let states = States::default();
    let read = states.clone();
    runtime.on_get(move |name| std::future::ready(Ok(read.of(&name))));
    let turn = async |run: &AgentRun, state: AgentState| {
        states.set(run, state);
        sleep_ms(GRACE.as_millis() as u64 + 5).await;
        fleet.on_pane_status(&run.pane_id);
        sleep_ms(30).await;
    };
    let coordinator = fleet
        .start_project("go", Some("/repo"), None, &CancellationToken::new())
        .await
        .unwrap();
    turn(&coordinator, AgentState::Idle).await;
    let thread = fleet
        .start_thread(
            ThreadRequest {
                title: "Port".to_owned(),
                task: Some("t".to_owned()),
                cwd: Some("/repo".to_owned()),
                caller_run: Some(coordinator.id.clone()),
                ..ThreadRequest::default()
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    lock(&git).pr = Some(pull_request(8, PullRequestState::Open, ChecksState::Pass));
    let report = json!({ "state": "waiting", "summary": "Opened #8; waiting for the review.", "evidence": [] });
    fs::write(
        root.join("results").join(&thread.id).join("report.json"),
        report.to_string(),
    )
    .unwrap();
    turn(&thread, AgentState::Idle).await;
    turn(&coordinator, AgentState::Idle).await;
    until(
        || registry.get(&thread.id).unwrap().pr.is_some(),
        "the pull request is read",
    )
    .await;
    let told = prompts_to(&runtime, &coordinator).len();
    fleet.supervise_projects().await;
    sleep_ms(QUIET + 20).await;
    *lock(&screens.slow) = Some(coordinator.herdr_name.clone());
    let supervising = {
        let fleet = fleet.clone();
        tokio::spawn(async move { fleet.supervise_projects().await })
    };
    sleep_ms(10).await;
    lock(&git).pr = Some(merged(8));
    fleet.refresh_pull_requests().await;
    supervising.await.unwrap();
    sleep_ms(30).await;
    let heard = prompts_to(&runtime, &coordinator)[told..].to_vec();
    assert_eq!(heard.len(), 1, "{heard:?}");
    assert!(heard[0].starts_with(ANDON), "{}", heard[0]);
    // the merge goes out once the coordinator answered the standstill call
    turn(&coordinator, AgentState::Idle).await;
    until(
        || prompts_to(&runtime, &coordinator).len() == told + 2,
        "the merge goes out",
    )
    .await;
    assert_eq!(
        prompts_to(&runtime, &coordinator)[told + 1],
        [NEWS, &merged_news(&thread, 8)].join("\n")
    );
    fleet.stop();
}

// main's defect #189's 3 (fixed on main by #238, which took the anomaly notice away): until a
// notice reached the coordinator, every supervision asked herdr about each agent and read its
// screen. Issue #268's expected behaviour, as main behaves since #238: the supervision asks herdr
// nothing about the threads and their helpers, and about the coordinator only when it calls a
// standstill, once per supervision, here while the person's draft keeps the call from going out.
// The draft is Claude's input with text in it (tests/notices.rs).
#[tokio::test(start_paused = true)]
async fn the_supervision_asks_herdr_about_no_agent_but_the_coordinator_it_calls() {
    let p = project_with(
        json!({}),
        vec![
            AgentDefinition {
                agent: FleetAgentKind::Claude,
                ..talking("coordinator")
            },
            talking("lead"),
            role("reviewer"),
        ],
    );
    let fleet = &p.s.fleet;
    let coordinator = p.start_project("go").await;
    p.turn(&coordinator, AgentState::Idle).await;
    let first = p.start_thread("One", &coordinator).await;
    let second = p.start_thread("Two", &coordinator).await;
    let helper = p.review(&first.group).await;
    for run in [&first, &second] {
        p.report(run, "waiting", "Waiting.");
        p.turn(run, AgentState::Idle).await;
    }
    p.turn(&helper, AgentState::Idle).await;
    // the coordinator hears the threads' news, and answers
    for _ in 0..3 {
        p.turn(&coordinator, AgentState::Idle).await;
    }
    p.s.runtime.recorded().screens.insert(
        coordinator.herdr_name.clone(),
        "❯\u{a0}and also the do".to_owned(),
    );
    let asked = Arc::new(Mutex::new(Vec::<String>::new()));
    {
        let (states, asked) = (p.states.clone(), asked.clone());
        p.s.runtime.on_get(move |name| {
            lock(&asked).push(name.clone());
            std::future::ready(Ok(states.of(&name)))
        });
    }
    let told = p.to(&coordinator).len();
    for _ in 0..3 {
        fleet.supervise_projects().await;
    }
    assert_eq!(
        *lock(&asked),
        Vec::<String>::new(),
        "before the quiet period"
    );
    sleep_ms(QUIET + 20).await;
    for _ in 0..3 {
        fleet.supervise_projects().await;
    }
    assert_eq!(
        *lock(&asked),
        vec![coordinator.herdr_name.clone(); 3],
        "once per supervision, and only the coordinator"
    );
    assert_eq!(p.to(&coordinator).len(), told, "the draft keeps it back");
}
