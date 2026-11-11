//! The fleet's notices to a thread's coordinator: the threads' questions, held while the coordinator
//! is not free and delivered in one message once it is. The tests named after an `it` are
//! `server/fleet/orchestrator.test.ts`'s describe `thread questions`, with their expected values; the
//! others say where theirs come from.

mod common;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use common::{
    FakeLanding, FakeRuntime, Folder, GRACE, Prompted, SetupOptions, TestClock, answer, config,
    deps, role, setup, sleep_ms, until,
};
use herdr_fleet_orchestrator::Clock;
use herdr_fleet_orchestrator::agents::AgentDefinition;
use herdr_fleet_orchestrator::fleet::{
    LandingTools, Orchestrator, OrchestratorError, ThreadRequest, Timings,
};
use herdr_fleet_orchestrator::outbox::Outbox;
use herdr_fleet_orchestrator::registry::RunRegistry;
use herdr_fleet_orchestrator::runtime::{
    AgentMetadata, AgentRuntime, CreateLocationOptions, RuntimeFuture, RuntimeLocation,
    StartOptions,
};
use protocol::{AgentRun, AgentState, FleetAgentKind};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

/// The header the threads' questions go under (orchestrator.test.ts:1919, `HEADER`).
const HEADER: &str =
    "[fleet] Threads ask the person. These come from the fleet, not from the person.";
/// The header the landing steps go under (orchestrator.test.ts:2649).
const STEPS_HEADER: &str = "[fleet] The person pressed these on the Fleet screen. Each is the person's approval for that step only.";

/// `role(name, { interactive: true, spawning: true })` (orchestrator.test.ts:1889).
fn talking(name: &str) -> AgentDefinition {
    AgentDefinition {
        interactive: Some(true),
        spawning: Some(true),
        ..role(name)
    }
}

/// The roles of the describe: a coordinator and a lead (orchestrator.test.ts:1889).
fn agents() -> Vec<AgentDefinition> {
    vec![talking("coordinator"), talking("lead")]
}

/// `gitRoot: async () => "/repo"`.
fn in_repo() -> Option<Arc<dyn LandingTools>> {
    let landing = FakeLanding::new();
    landing.answers().git_root = answer(|_: PathBuf| async { Some(PathBuf::from("/repo")) });
    Some(landing)
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

/// The describe's `project()` (orchestrator.test.ts:1891-1914): a setup in the repository /repo,
/// where herdr says what `states` holds.
struct Project {
    s: common::Setup,
    states: States,
}

fn project() -> Project {
    project_with(SetupOptions::default())
}

fn project_with(options: SetupOptions) -> Project {
    let s = setup(SetupOptions {
        agents: Some(options.agents.clone().unwrap_or_else(agents)),
        landing: in_repo(),
        ..options
    });
    let states = States::default();
    let read = states.clone();
    s.runtime
        .on_get(move |name| std::future::ready(Ok(read.of(&name))));
    Project { s, states }
}

impl Project {
    /// herdr says `state` for the run's pane, and sends the event (`turn`).
    async fn turn(&self, run: &AgentRun, state: AgentState) {
        self.states.set(run, state);
        sleep_ms(GRACE.as_millis() as u64 + 5).await;
        self.s.fleet.on_pane_status(&run.pane_id);
        sleep_ms(20).await;
    }

    /// What the coordinator was given, in order (`toCoordinator`).
    fn to(&self, coordinator: &AgentRun) -> Vec<String> {
        prompts_to(&self.s.runtime, coordinator)
    }

    fn handoff(&self, run: &AgentRun, text: &str) {
        fs::write(self.s.result_dir(&run.id).join("handoff.md"), text).unwrap();
    }

    fn report(&self, run: &AgentRun, value: &Value) {
        fs::write(
            self.s.result_dir(&run.id).join("report.json"),
            value.to_string(),
        )
        .unwrap();
    }

    /// The lead's turn ends on a question for the person: a blocked report, and its HANDOFF
    /// (`ask`).
    fn ask(&self, run: &AgentRun, question: &str) {
        self.ask_with(run, question, &format!("## HANDOFF\n{question}"));
    }

    fn ask_with(&self, run: &AgentRun, question: &str, text: &str) {
        self.report(
            run,
            &json!({ "state": "blocked", "summary": question, "evidence": [], "human_action": question }),
        );
        self.handoff(run, text);
    }

    /// `fleet.startProject({ task, cwd: "/repo" })`.
    async fn start_project(&self, task: &str) -> AgentRun {
        start_project(&self.s.fleet, task).await.unwrap()
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

    /// The last news about `run` waiting in the outbox (`noticeOf`, orchestrator.test.ts:106).
    fn notice_of(&self, run: &AgentRun) -> Option<String> {
        notice_of(&self.s.root, &self.s.clock, run)
    }
}

async fn start_project(fleet: &Orchestrator, task: &str) -> Result<AgentRun, OrchestratorError> {
    fleet
        .start_project(task, Some("/repo"), None, &CancellationToken::new())
        .await
}

fn prompts_to(runtime: &FakeRuntime, coordinator: &AgentRun) -> Vec<String> {
    runtime
        .prompts()
        .into_iter()
        .filter(|prompt| prompt.name == coordinator.herdr_name)
        .map(|prompt| prompt.text)
        .collect()
}

fn notice_of(root: &Path, clock: &Arc<dyn Clock>, run: &AgentRun) -> Option<String> {
    Outbox::open(Some(root.join("fleet-outbox.json")), clock.clone())
        .unwrap()
        .pending_where(|notice| notice.about == run.id && notice.slot == "news")
        .pop()
        .map(|notice| notice.text)
}

/// A thread's question as the coordinator reads it (`asks`, orchestrator.test.ts:1918): its
/// title, id and branch, the question, and the HANDOFF indented by two spaces.
fn asks(run: &AgentRun, question: &str) -> String {
    asks_with(run, question, &format!("## HANDOFF\n{question}"))
}

fn asks_with(run: &AgentRun, question: &str, handoff: &str) -> String {
    let quoted: Vec<String> = handoff
        .split('\n')
        .map(|line| format!("  {line}"))
        .collect();
    format!(
        "- \"{}\" ({}, fleet/{}) asks the person: {question}\n{}",
        run.name,
        run.id,
        run.id,
        quoted.join("\n")
    )
}

/// The orchestrator a restart builds over the same folder (orchestrator.test.ts:2069-2072).
fn restart(runtime: &Arc<FakeRuntime>, root: &Path, clock: &Arc<dyn Clock>) -> Orchestrator {
    let registry = Arc::new(RunRegistry::open(
        Some(root.join("runs.json")),
        clock.as_ref(),
    ));
    let mut deps = deps(
        runtime.clone(),
        registry,
        root,
        clock.clone(),
        config(None),
        agents(),
    );
    deps.timings = Timings {
        pre_visual_grace: GRACE,
        ..Timings::default()
    };
    Orchestrator::new(deps).unwrap()
}

// orchestrator.test.ts: "reach the coordinator once it is free, with the report's question and the whole HANDOFF"
#[tokio::test(start_paused = true)]
async fn reach_the_coordinator_once_it_is_free_with_the_reports_question_and_the_whole_handoff() {
    let p = project();
    let coordinator = p.start_project("fix the retry").await;
    p.turn(&coordinator, AgentState::Idle).await;
    let thread = p.start_thread("Fix", &coordinator).await;
    let text = "## HANDOFF\nKeep the old retry API?\nOptions: A keep it (recommended), B drop it\nArchitect: callers in two packages use it";
    p.ask_with(&thread, "Keep the old retry API?", text);
    p.turn(&thread, AgentState::Idle).await;
    assert_eq!(
        p.to(&coordinator),
        vec![
            "fix the retry".to_owned(),
            [HEADER, &asks_with(&thread, "Keep the old retry API?", text)].join("\n"),
        ]
    );
    assert_eq!(p.notice_of(&thread), None);
}

// orchestrator.test.ts: "are only questions: a ready or failed report, no report, a failure and a wait on the screen go to the thread list and push notifications"
#[tokio::test(start_paused = true)]
async fn are_only_questions_a_ready_or_failed_report_no_report_a_failure_and_a_wait_on_the_screen_go_to_the_thread_list_and_push_notifications()
 {
    let p = project();
    let coordinator = p.start_project("go").await;
    p.turn(&coordinator, AgentState::Idle).await;
    let done = p.start_thread("Done", &coordinator).await;
    let issues = p.start_thread("Issues", &coordinator).await;
    let silent = p.start_thread("Silent", &coordinator).await;
    let screen = p.start_thread("Screen", &coordinator).await;
    let ended = p.start_thread("Ended", &coordinator).await;
    // a HANDOFF that reads like a question is prose: only the report says the person is asked
    p.handoff(&done, "BLOCKED — or is it?");
    p.report(
        &done,
        &json!({ "state": "ready", "summary": "bun test: 12 pass", "evidence": [] }),
    );
    p.report(
        &issues,
        &json!({ "state": "failed", "summary": "2 tests fail", "evidence": [] }),
    );
    p.turn(&done, AgentState::Idle).await;
    p.turn(&issues, AgentState::Idle).await;
    p.turn(&silent, AgentState::Idle).await;
    p.turn(&screen, AgentState::Blocked).await;
    p.s.fleet.on_pane_ended(&ended.pane_id);
    p.states.set(&coordinator, AgentState::Idle);
    p.turn(&coordinator, AgentState::Idle).await;
    assert_eq!(p.to(&coordinator), vec!["go".to_owned()]);
    for run in [&done, &issues, &silent, &screen, &ended] {
        assert_eq!(p.notice_of(run), None, "{}", run.name);
    }
}

// orchestrator.test.ts: "wait while the coordinator works, its own turn or the person's, and then go out together"
#[tokio::test(start_paused = true)]
async fn wait_while_the_coordinator_works_its_own_turn_or_the_persons_and_then_go_out_together() {
    let p = project();
    let coordinator = p.start_project("two things").await;
    let first = p.start_thread("One", &coordinator).await;
    let second = p.start_thread("Two", &coordinator).await;
    p.ask(&first, "Which log format?");
    p.ask(&second, "May the old flag go?");
    p.turn(&first, AgentState::Idle).await;
    p.turn(&second, AgentState::Idle).await;
    // the fleet's own turn is still running
    assert_eq!(p.to(&coordinator), vec!["two things".to_owned()]);
    assert!(
        p.notice_of(&first)
            .is_some_and(|notice| notice.contains("Which log format?"))
    );
    p.turn(&coordinator, AgentState::Idle).await;
    assert_eq!(
        p.to(&coordinator)[1],
        [
            HEADER,
            &asks(&first, "Which log format?"),
            &asks(&second, "May the old flag go?")
        ]
        .join("\n")
    );
    p.turn(&coordinator, AgentState::Idle).await;
    // the person typed in its pane: herdr says working, with no turn of the fleet's
    p.turn(&coordinator, AgentState::Working).await;
    p.s.fleet
        .send(&first.id, "JSON", None, &CancellationToken::new())
        .await
        .unwrap();
    p.ask(&first, "One file or one per day?");
    p.turn(&first, AgentState::Idle).await;
    assert_eq!(p.to(&coordinator).len(), 2);
    p.turn(&coordinator, AgentState::Idle).await;
    let to = p.to(&coordinator);
    assert_eq!(to.len(), 3);
    assert_eq!(
        to[2],
        [HEADER, &asks(&first, "One file or one per day?")].join("\n")
    );
}

// orchestrator.test.ts: "wait while the person has a draft in the coordinator's input, and go out once it is gone"
#[tokio::test(start_paused = true)]
async fn wait_while_the_person_has_a_draft_in_the_coordinators_input_and_go_out_once_it_is_gone() {
    let p = project_with(SetupOptions {
        agents: Some(vec![
            AgentDefinition {
                agent: FleetAgentKind::Claude,
                ..talking("coordinator")
            },
            talking("lead"),
        ]),
        draft_retry: Some(Duration::from_millis(30)),
        ..SetupOptions::default()
    });
    let coordinator = p.start_project("go").await;
    p.states.set(&coordinator, AgentState::Idle);
    p.s.runtime.recorded().screens.insert(
        coordinator.herdr_name.clone(),
        "❯\u{a0}and also the do".to_owned(),
    );
    sleep_ms(GRACE.as_millis() as u64 + 5).await;
    p.s.fleet.on_pane_status(&coordinator.pane_id);
    let thread = p.start_thread("Fix", &coordinator).await;
    p.report(
        &thread,
        &json!({ "state": "blocked", "summary": "Which one?", "evidence": [], "human_action": "Which one?" }),
    );
    p.states.set(&thread, AgentState::Idle);
    sleep_ms(GRACE.as_millis() as u64 + 5).await;
    p.s.fleet.on_pane_status(&thread.pane_id);
    sleep_ms(80).await;
    assert_eq!(p.to(&coordinator), vec!["go".to_owned()]);
    p.s.runtime.recorded().screens.insert(
        coordinator.herdr_name.clone(),
        "❯\u{a0}\x1b[2mTry \"fix lint errors\"\x1b[0m".to_owned(),
    );
    sleep_ms(80).await;
    let to = p.to(&coordinator);
    assert_eq!(to.len(), 2);
    assert!(to[1].contains("asks the person: Which one?"), "{}", to[1]);
    p.s.fleet.stop();
}

// orchestrator.test.ts: "carry a long HANDOFF cut, the rest left in the result file"
#[tokio::test(start_paused = true)]
async fn carry_a_long_handoff_cut_the_rest_left_in_the_result_file() {
    let p = project();
    let coordinator = p.start_project("go").await;
    let thread = p.start_thread("Fix", &coordinator).await;
    p.ask_with(
        &thread,
        "Which one?",
        &format!("Which one?\n{}", "x".repeat(5000)),
    );
    p.turn(&thread, AgentState::Idle).await;
    let notice = p.notice_of(&thread).expect("the question waits");
    assert!(notice.ends_with("[cut at 4000 characters]"), "{notice}");
    assert!(notice.chars().count() < 4200, "{}", notice.chars().count());
}

// orchestrator.test.ts: "are kept while no coordinator lives, for the project's next one"
#[tokio::test(start_paused = true)]
async fn are_kept_while_no_coordinator_lives_for_the_projects_next_one() {
    let p = project();
    let coordinator = p.start_project("go").await;
    p.turn(&coordinator, AgentState::Idle).await;
    let thread = p.start_thread("Fix", &coordinator).await;
    p.s.fleet.on_pane_ended(&coordinator.pane_id);
    p.ask(&thread, "Which one?");
    p.turn(&thread, AgentState::Idle).await;
    assert!(
        p.notice_of(&thread)
            .is_some_and(|notice| notice.contains("Which one?"))
    );
    let next = p.start_project("and now?").await;
    assert_eq!(p.to(&next), vec!["and now?".to_owned()]);
    p.turn(&next, AgentState::Idle).await;
    assert_eq!(
        p.to(&next)[1],
        [HEADER, &asks(&thread, "Which one?")].join("\n")
    );
    assert_eq!(p.notice_of(&thread), None);
}

// orchestrator.test.ts: "are kept across a restart"
#[tokio::test(start_paused = true)]
async fn are_kept_across_a_restart() {
    let p = project();
    let coordinator = p.start_project("go").await;
    let thread = p.start_thread("Fix", &coordinator).await;
    p.ask(&thread, "Which one?");
    p.turn(&thread, AgentState::Idle).await;
    p.s.fleet.stop();
    assert!(
        p.notice_of(&thread)
            .is_some_and(|notice| notice.contains("asks the person"))
    );
    let saved = RunRegistry::open(Some(p.s.root.join("runs.json")), p.s.clock.as_ref());
    assert_eq!(saved.get(&thread.id).unwrap().notice, None);
}

// orchestrator.test.ts: "typed into a coordinator that then waits on an approval screen went out, and are not sent again"
#[tokio::test(start_paused = true)]
async fn typed_into_a_coordinator_that_then_waits_on_an_approval_screen_went_out_and_are_not_sent_again()
 {
    let p = project();
    let coordinator = p.start_project("go").await;
    p.turn(&coordinator, AgentState::Idle).await;
    let thread = p.start_thread("Fix", &coordinator).await;
    p.s.runtime.set_prompt_status(AgentState::Blocked);
    p.ask(&thread, "Which one?");
    p.turn(&thread, AgentState::Idle).await;
    assert_eq!(
        p.to(&coordinator),
        vec![
            "go".to_owned(),
            [HEADER, &asks(&thread, "Which one?")].join("\n")
        ]
    );
    p.s.runtime.set_prompt_status(AgentState::Working);
    p.turn(&coordinator, AgentState::Blocked).await;
    p.turn(&coordinator, AgentState::Idle).await;
    assert_eq!(p.to(&coordinator).len(), 2);
}

// orchestrator.test.ts: "written while the coordinator works reach it once after a restart, in the order they were written, and never again"
#[tokio::test(start_paused = true)]
async fn written_while_the_coordinator_works_reach_it_once_after_a_restart_in_the_order_they_were_written_and_never_again()
 {
    let p = project();
    let coordinator = p.start_project("two things").await;
    // started first, asks second: the order is the questions', not the threads'
    let later = p.start_thread("Two", &coordinator).await;
    let sooner = p.start_thread("One", &coordinator).await;
    p.ask(&sooner, "Which log format?");
    p.turn(&sooner, AgentState::Idle).await;
    p.ask(&later, "May the old flag go?");
    p.turn(&later, AgentState::Idle).await;
    assert_eq!(p.to(&coordinator), vec!["two things".to_owned()]);
    p.s.fleet.stop();
    let restarted = restart(&p.s.runtime, &p.s.root, &p.s.clock);
    p.states.set(&coordinator, AgentState::Idle);
    restarted.reconcile_all().await;
    until(
        || p.to(&coordinator).len() == 2,
        "the questions after the restart",
    )
    .await;
    assert_eq!(
        p.to(&coordinator)[1],
        [
            HEADER,
            &asks(&sooner, "Which log format?"),
            &asks(&later, "May the old flag go?")
        ]
        .join("\n")
    );
    // its turn ends, and the server restarts again: nothing is sent twice
    sleep_ms(GRACE.as_millis() as u64 + 5).await;
    restarted.on_pane_status(&coordinator.pane_id);
    sleep_ms(30).await;
    restarted.stop();
    let again = restart(&p.s.runtime, &p.s.root, &p.s.clock);
    again.reconcile_all().await;
    sleep_ms(30).await;
    assert_eq!(p.to(&coordinator).len(), 2);
    again.stop();
}

/// The fake runtime, with herdr slow to show the coordinator's screen once `slow` names it: the
/// real runtime reads the screen over herdr's socket, and a delivery reads it to look for the
/// person's draft after it found the coordinator free.
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
        let slow = self
            .slow
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_deref()
            == Some(name);
        Box::pin(async move {
            if slow {
                tokio::time::sleep(Duration::from_millis(40)).await;
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

// #264's acceptance: one coordinator's pane never takes two messages at once (the delivery's lock).
// Two threads settle at the same moment and each tells the coordinator, while herdr is slow to show
// the coordinator's screen: the questions go out as one message, typed alone.
#[tokio::test(start_paused = true)]
async fn one_coordinator_takes_one_message_at_a_time_when_two_threads_tell_it_at_once() {
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
    let mut deps = deps(
        runtime.clone(),
        registry,
        root,
        clock.clone(),
        config(None),
        agents(),
    );
    deps.runtime = screens.clone();
    deps.landing = in_repo().unwrap();
    deps.timings = Timings {
        pre_visual_grace: GRACE,
        ready_screen: Duration::from_millis(300),
        ..Timings::default()
    };
    let fleet = Orchestrator::new(deps).unwrap();
    let states = States::default();
    let read = states.clone();
    runtime.on_get(move |name| std::future::ready(Ok(read.of(&name))));
    // each prompt takes 30 ms to type; how many reach the coordinator at once is counted
    let typing = Arc::new(Mutex::new((0_u32, 0_u32)));
    let (counts, to) = (typing.clone(), Arc::new(Mutex::new(String::new())));
    let typed_to = to.clone();
    let log = runtime.clone();
    runtime.on_prompt(move |name, text, _cancel| {
        let (counts, to, log) = (counts.clone(), typed_to.clone(), log.clone());
        async move {
            let counted = name == *to.lock().unwrap_or_else(PoisonError::into_inner);
            if counted {
                let mut counts = counts.lock().unwrap_or_else(PoisonError::into_inner);
                counts.0 += 1;
                counts.1 = counts.1.max(counts.0);
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
            if counted {
                counts.lock().unwrap_or_else(PoisonError::into_inner).0 -= 1;
            }
            log.recorded().prompts.push(Prompted { name, text });
            Ok(AgentState::Idle)
        }
    });
    let coordinator = start_project(&fleet, "go").await.unwrap();
    *to.lock().unwrap_or_else(PoisonError::into_inner) = coordinator.herdr_name.clone();
    states.set(&coordinator, AgentState::Idle);
    sleep_ms(GRACE.as_millis() as u64 + 5).await;
    fleet.on_pane_status(&coordinator.pane_id);
    sleep_ms(100).await;
    let mut threads = Vec::new();
    for title in ["One", "Two"] {
        let request = ThreadRequest {
            title: title.to_owned(),
            task: Some("t".to_owned()),
            cwd: Some("/repo".to_owned()),
            caller_run: Some(coordinator.id.clone()),
            ..ThreadRequest::default()
        };
        threads.push(
            fleet
                .start_thread(request, &CancellationToken::new())
                .await
                .unwrap(),
        );
    }
    let (first, second) = (&threads[0], &threads[1]);
    for (run, question) in [
        (first, "Which log format?"),
        (second, "May the old flag go?"),
    ] {
        let dir = root.join("results").join(&run.id);
        fs::write(
            dir.join("report.json"),
            json!({ "state": "blocked", "summary": question, "evidence": [], "human_action": question })
                .to_string(),
        )
        .unwrap();
        fs::write(dir.join("handoff.md"), format!("## HANDOFF\n{question}")).unwrap();
        states.set(run, AgentState::Idle);
    }
    *screens.slow.lock().unwrap_or_else(PoisonError::into_inner) =
        Some(coordinator.herdr_name.clone());
    sleep_ms(GRACE.as_millis() as u64 + 5).await;
    fleet.on_pane_status(&first.pane_id);
    fleet.on_pane_status(&second.pane_id);
    sleep_ms(300).await;
    assert_eq!(
        prompts_to(&runtime, &coordinator),
        vec![
            "go".to_owned(),
            [
                HEADER,
                &asks(first, "Which log format?"),
                &asks(second, "May the old flag go?")
            ]
            .join("\n")
        ]
    );
    assert_eq!(typing.lock().unwrap_or_else(PoisonError::into_inner).1, 1);
    fleet.stop();
}

// The migration of a thread's news a server from before the outbox kept on the run
// (orchestrator.ts's constructor): its expected message is the news part of orchestrator.test.ts's
// describe `landing`, "hand on a merge step and a question a run saved before the outbox kept, once,
// and drop news about a run no longer kept" (orchestrator.test.ts:2647-2654), whose merge step is
// #266's.
#[tokio::test(start_paused = true)]
async fn hand_on_a_question_a_run_saved_before_the_outbox_kept_once() {
    let p = project();
    let coordinator = p.start_project("go").await;
    let thread = p.start_thread("Fix", &coordinator).await;
    p.turn(&coordinator, AgentState::Working).await;
    p.s.fleet.stop();
    rewrite_runs(&p.s.root, |run| {
        if run["id"] == thread.id.as_str() {
            run["notice"] = json!("an old question");
        }
    });
    let restarted = restart(&p.s.runtime, &p.s.root, &p.s.clock);
    p.states.set(&coordinator, AgentState::Idle);
    restarted.reconcile_all().await;
    until(
        || p.to(&coordinator).len() == 2,
        "the kept question after the restart",
    )
    .await;
    assert_eq!(
        p.to(&coordinator)[1],
        [HEADER, "- an old question"].join("\n")
    );
    let saved = RunRegistry::open(Some(p.s.root.join("runs.json")), p.s.clock.as_ref());
    assert_eq!(saved.get(&thread.id).unwrap().notice, None);
    sleep_ms(GRACE.as_millis() as u64 + 5).await;
    restarted.on_pane_status(&coordinator.pane_id);
    sleep_ms(30).await;
    restarted.stop();
    let again = restart(&p.s.runtime, &p.s.root, &p.s.clock);
    again.reconcile_all().await;
    sleep_ms(30).await;
    assert_eq!(p.to(&coordinator).len(), 2);
    again.stop();
}

// A merge step left in the outbox goes to the project's coordinator under its own header, and the
// thread's landing step is marked sent as it goes (orchestrator.ts's `deliverNotices` and
// `hearerOf`); the header and the step's place after the questions are orchestrator.test.ts's
// (:2647-2650). The step's text is written here by hand: #266 writes the real one.
#[tokio::test(start_paused = true)]
async fn hand_a_queued_merge_step_to_the_projects_coordinator_and_mark_it_sent() {
    let p = project();
    let coordinator = p.start_project("go").await;
    let thread = p.start_thread("Fix", &coordinator).await;
    p.turn(&coordinator, AgentState::Working).await;
    p.s.fleet.stop();
    rewrite_runs(&p.s.root, |run| {
        if run["id"] == thread.id.as_str() {
            run["landing"] = json!({ "action": "merge", "at": 1, "sent": false });
        }
    });
    let outbox = json!([
        { "about": thread.id, "slot": "news", "section": "news", "text": "a question", "seq": 1, "at": 1 },
        { "about": thread.id, "slot": "landing", "section": "steps", "text": "Merge it.", "landingAt": 1, "seq": 2, "at": 1 },
    ]);
    fs::write(p.s.root.join("fleet-outbox.json"), outbox.to_string()).unwrap();
    let restarted = restart(&p.s.runtime, &p.s.root, &p.s.clock);
    p.states.set(&coordinator, AgentState::Idle);
    restarted.reconcile_all().await;
    until(
        || p.to(&coordinator).len() == 2,
        "the queued step after the restart",
    )
    .await;
    assert_eq!(
        p.to(&coordinator)[1],
        [HEADER, "- a question", STEPS_HEADER, "- Merge it."].join("\n")
    );
    let saved = RunRegistry::open(Some(p.s.root.join("runs.json")), p.s.clock.as_ref());
    assert_eq!(
        saved
            .get(&thread.id)
            .unwrap()
            .landing
            .and_then(|landing| landing.sent),
        Some(true)
    );
    restarted.stop();
}

/// runs.json with each run changed by `change`, as a server from before would have left it.
fn rewrite_runs(root: &Path, change: impl Fn(&mut Value)) {
    let file = root.join("runs.json");
    let mut runs: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    for run in runs.as_array_mut().unwrap() {
        change(run);
    }
    fs::write(&file, runs.to_string()).unwrap();
}
