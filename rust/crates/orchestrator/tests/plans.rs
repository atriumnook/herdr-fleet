//! A thread's plan for the person: handed over by its lead, kept by the fleet, answered on the
//! Fleet screen, and closed once the lead went on without the answers. The tests named after an
//! `it` are `server/fleet/orchestrator.test.ts`'s describe `plans`, with their expected values, and
//! one `it` of its describe `threads` that calls `submitPlan` (ADR 0242-phase-3-split).

mod common;

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use common::{
    FakeLanding, Folder, GRACE, SetupOptions, answer, request, role, setup, sleep_ms, spawn,
};
use herdr_fleet_orchestrator::agents::AgentDefinition;
use herdr_fleet_orchestrator::fleet::{
    LandingTools, Orchestrator, OrchestratorError, ThreadRequest,
};
use herdr_fleet_orchestrator::outbox::Outbox;
use herdr_fleet_orchestrator::registry::RunRegistry;
use herdr_fleet_orchestrator::runtime::{RuntimeError, RuntimeLocation};
use protocol::{AgentRun, AgentState, PlanExhibit, PlanMark, ThreadState, thread_state};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

/// `role(name, { interactive: true, spawning: true })`.
fn talking(name: &str) -> AgentDefinition {
    AgentDefinition {
        interactive: Some(true),
        spawning: Some(true),
        ..role(name)
    }
}

/// The roles of the describe: a coordinator, a lead and a reviewer (orchestrator.test.ts:2745).
fn agents() -> Vec<AgentDefinition> {
    vec![talking("coordinator"), talking("lead"), role("reviewer")]
}

/// The describe's `PLAN` (orchestrator.test.ts:2746-2750): one claim on the code of
/// src/retry.ts, with one decision.
fn plan_value() -> Value {
    json!({ "title": "Retry limit", "claims": [{
        "text": "A failed send is tried three times.",
        "exhibit": { "kind": "code", "path": "src/retry.ts", "start": 1 },
        "ask": { "id": "limit", "question": "How many?", "recommended": "three",
            "options": [{ "value": "three", "label": "3" }, { "value": "five", "label": "5" }] }
    }] })
}

/// `{ title: "Fix", task: "t", cwd: "/repo", callerRun }`.
fn fix(caller: Option<&AgentRun>) -> ThreadRequest {
    ThreadRequest {
        title: "Fix".to_owned(),
        task: Some("t".to_owned()),
        cwd: Some("/repo".to_owned()),
        caller_run: caller.map(|run| run.id.clone()),
        ..ThreadRequest::default()
    }
}

/// `gitRoot: async () => "/repo"`.
fn in_repo() -> Option<Arc<dyn LandingTools>> {
    let landing = FakeLanding::new();
    landing.answers().git_root = answer(|_: PathBuf| async { Some(PathBuf::from("/repo")) });
    Some(landing)
}

/// What herdr says for each pane, by its agent's name (`states`); `working` when unsaid.
type States = Arc<Mutex<HashMap<String, AgentState>>>;

/// The describe's `project()` (orchestrator.test.ts:2752-2777): a setup in the repository /repo,
/// whose threads' worktree is a real folder holding src/retry.ts (the plan's code is read from it),
/// and where herdr says what `states` holds.
struct Project {
    s: common::Setup,
    states: States,
    _tree: Folder,
}

fn project() -> Project {
    let tree = Folder::new();
    fs::create_dir(tree.path().join("src")).unwrap();
    fs::write(
        tree.path().join("src").join("retry.ts"),
        "export const RETRIES = 3;\n",
    )
    .unwrap();
    let s = setup(SetupOptions {
        agents: Some(agents()),
        landing: in_repo(),
        ..SetupOptions::default()
    });
    let worktree = tree.path().to_string_lossy().into_owned();
    let panes = Arc::new(AtomicUsize::new(0));
    s.runtime.on_create_location(move |options, _| {
        let pane = panes.fetch_add(1, Ordering::SeqCst) + 1;
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
    let states = States::default();
    let read = states.clone();
    s.runtime.on_get(move |name| {
        let states = read.lock().unwrap_or_else(PoisonError::into_inner);
        std::future::ready(Ok(*states.get(&name).unwrap_or(&AgentState::Working)))
    });
    Project {
        s,
        states,
        _tree: tree,
    }
}

impl Project {
    fn fleet(&self) -> &Orchestrator {
        &self.s.fleet
    }

    /// herdr says `state` for the run's pane, and sends the event (`turn`).
    async fn turn(&self, run: &AgentRun, state: AgentState) {
        (self.states.lock().unwrap_or_else(PoisonError::into_inner))
            .insert(run.herdr_name.clone(), state);
        sleep_ms(GRACE.as_millis() as u64 + 5).await;
        self.s.fleet.on_pane_status(&run.pane_id);
        sleep_ms(30).await;
    }

    /// What the run was given, in order (`to`).
    fn to(&self, run: &AgentRun) -> Vec<String> {
        self.s
            .runtime
            .prompts()
            .into_iter()
            .filter(|prompt| prompt.name == run.herdr_name)
            .map(|prompt| prompt.text)
            .collect()
    }

    /// The run's report for its turn (`writeReport`, orchestrator.test.ts:110-114), with the
    /// question for the person when it has one.
    fn report(&self, run: &AgentRun, state: &str, summary: &str, human_action: Option<&str>) {
        let mut report = json!({ "state": state, "summary": summary, "evidence": [] });
        if let Some(human_action) = human_action {
            report["human_action"] = json!(human_action);
        }
        fs::write(
            self.s.result_dir(&run.id).join("report.json"),
            report.to_string(),
        )
        .unwrap();
    }

    /// The lead's turn ends blocked on its plan (orchestrator.test.ts:2775).
    fn ask_plan(&self, run: &AgentRun) {
        let action = Some("Answer the plan in the Plan tab.");
        self.report(run, "blocked", "The plan waits for the person.", action);
    }

    /// The describe's `PLAN` handed over by the lead of `run`.
    fn submit(&self, run: &AgentRun) -> protocol::Plan {
        self.fleet()
            .submit_plan(&run.id, &plan_value(), None)
            .unwrap()
    }

    /// The code `answer_plan` refuses `value` with.
    async fn refused(&self, run: &AgentRun, value: Value) -> String {
        code(self.answer(run, value).await)
    }

    /// The plan file the fleet keeps for the run, as JSON.
    fn kept(&self, run: &AgentRun) -> Value {
        serde_json::from_str(&fs::read_to_string(self.plan_file(run)).unwrap()).unwrap()
    }

    fn plan_file(&self, run: &AgentRun) -> PathBuf {
        self.s.root.join(format!("fleet-plans/{}.json", run.id))
    }

    fn run(&self, run: &AgentRun) -> AgentRun {
        self.s.registry.get(&run.id).unwrap()
    }

    /// `fleet.startProject({ task, cwd: "/repo" })`.
    async fn start_project(&self, task: &str) -> AgentRun {
        self.s
            .fleet
            .start_project(task, Some("/repo"), None, &CancellationToken::new())
            .await
            .unwrap()
    }

    /// `fleet.startThread({ title: "Fix", task: "t", cwd: "/repo", callerRun })`.
    async fn start_thread(&self, coordinator: &AgentRun) -> AgentRun {
        let cancel = CancellationToken::new();
        let started = self.s.fleet.start_thread(fix(Some(coordinator)), &cancel);
        started.await.unwrap()
    }

    async fn send(&self, run: &AgentRun, message: &str) -> Result<AgentRun, OrchestratorError> {
        self.s
            .fleet
            .send(&run.id, message, None, &CancellationToken::new())
            .await
    }

    async fn answer(&self, run: &AgentRun, value: Value) -> Result<AgentRun, OrchestratorError> {
        self.s
            .fleet
            .answer_plan(&run.id, &value, None, &CancellationToken::new())
            .await
    }

    /// The last news about `run` waiting in the outbox (`noticeOf`, orchestrator.test.ts:106).
    fn notice_of(&self, run: &AgentRun) -> Option<String> {
        Outbox::open(
            Some(self.s.root.join("fleet-outbox.json")),
            self.s.clock.clone(),
        )
        .unwrap()
        .pending_where(|notice| notice.about == run.id && notice.slot == "news")
        .pop()
        .map(|notice| notice.text)
    }

    /// A coordinator, and a thread whose lead handed over a plan and ended its turn blocked
    /// (`planned`, orchestrator.test.ts:2767-2775).
    async fn planned(&self) -> (AgentRun, AgentRun, protocol::Plan) {
        let coordinator = self.start_project("fix the retry").await;
        self.turn(&coordinator, AgentState::Idle).await;
        let thread = self.start_thread(&coordinator).await;
        let plan = self.submit(&thread);
        self.ask_plan(&thread);
        self.turn(&thread, AgentState::Idle).await;
        (coordinator, thread, plan)
    }
}

/// Five retries picked on version 1, the decision opened (orchestrator.test.ts:2888, :2908).
fn five() -> Value {
    json!({ "version": 1, "choices": { "limit": "five" }, "seen": ["limit"] })
}

/// An open plan's mark: version `version`, with the one decision of `PLAN`.
fn open_mark(version: u32) -> PlanMark {
    PlanMark {
        version,
        asks: 1,
        answered_at: None,
        closed_at: None,
    }
}

/// The code of the error `result` holds.
fn code<T: std::fmt::Debug>(result: Result<T, OrchestratorError>) -> String {
    result.unwrap_err().code().to_owned()
}

// orchestrator.test.ts: "are kept beside the lead's result file with the code read from its worktree, and the thread waits on the person"
#[tokio::test(start_paused = true)]
async fn are_kept_beside_the_leads_result_file_with_the_code_read_from_its_worktree_and_the_thread_waits_on_the_person()
 {
    let p = project();
    let (_, thread, plan) = p.planned().await;
    assert_eq!(plan.version, 1);
    match &plan.claims[0].exhibit {
        Some(PlanExhibit::Code { lines, .. }) => assert_eq!(
            lines.as_deref(),
            Some(&["export const RETRIES = 3;".to_owned()][..])
        ),
        other => panic!("not a code exhibit: {other:?}"),
    }
    assert_eq!(p.kept(&thread), serde_json::to_value(&plan).unwrap());
    assert_eq!(p.fleet().plan(&thread.id, None).unwrap(), plan);
    assert_eq!(p.run(&thread).plan, Some(open_mark(1)));
    assert_eq!(thread_state(&p.run(&thread)), ThreadState::Waiting);
    assert_eq!(p.submit(&thread).version, 2);
    p.fleet().stop();
}

// orchestrator.test.ts: "send the coordinator to the Plan tab rather than have it answer"
#[tokio::test(start_paused = true)]
async fn send_the_coordinator_to_the_plan_tab_rather_than_have_it_answer() {
    let p = project();
    let (coordinator, _, _) = p.planned().await;
    assert!(p.to(&coordinator)[1].contains("waits for the person in the thread's Plan tab on the Fleet screen: point them there, and do not answer it yourself."));
    p.fleet().stop();
}

// orchestrator.test.ts: "reach the lead as its next task once answered, and only once"
#[tokio::test(start_paused = true)]
async fn reach_the_lead_as_its_next_task_once_answered_and_only_once() {
    let p = project();
    let (_, thread, _) = p.planned().await;
    p.answer(
        &thread,
        json!({ "version": 1, "choices": { "limit": "five" }, "seen": ["limit"], "comments": [] }),
    )
    .await
    .unwrap();
    assert!(p.to(&thread).last().unwrap().contains(
        "- D1 (on claim 1) How many? → 5 [limit=five] (instead of your recommendation, 3)"
    ));
    assert!(p.run(&thread).plan.unwrap().answered_at.is_some());
    let kept = p.kept(&thread);
    assert!(kept["answeredAt"].is_number());
    assert_eq!(kept["answer"]["version"], json!(1));
    assert_eq!(kept["answer"]["choices"], json!({ "limit": "five" }));
    assert_eq!(kept["answer"]["seen"], json!(["limit"]));
    assert_eq!(thread_state(&p.run(&thread)), ThreadState::Working);
    assert_eq!(
        p.refused(&thread, json!({ "version": 1 })).await,
        "plan_answered"
    );
    p.fleet().stop();
}

// orchestrator.test.ts: "wait for the lead's turn to end, and refuse an answer to an older version"
#[tokio::test(start_paused = true)]
async fn wait_for_the_leads_turn_to_end_and_refuse_an_answer_to_an_older_version() {
    let p = project();
    let (_, thread, _) = p.planned().await;
    p.submit(&thread);
    assert_eq!(
        p.refused(&thread, json!({ "version": 1 })).await,
        "plan_outdated"
    );
    p.send(&thread, "one more thing").await.unwrap();
    assert_eq!(
        p.refused(&thread, json!({ "version": 2 })).await,
        "run_busy"
    );
    // in that turn the lead writes version 3, which then waits for the person
    p.submit(&thread);
    p.turn(&thread, AgentState::Idle).await;
    let prompts = p.s.runtime.prompts().len();
    p.answer(&thread, json!({ "version": 3 })).await.unwrap();
    assert_eq!(p.s.runtime.prompts().len(), prompts + 1);
    p.fleet().stop();
}

// orchestrator.test.ts: "hold the thread waiting only through the blocked turn: a lead that did not stop is ready for review"
#[tokio::test(start_paused = true)]
async fn hold_the_thread_waiting_only_through_the_blocked_turn_a_lead_that_did_not_stop_is_ready_for_review()
 {
    let p = project();
    let coordinator = p.start_project("go").await;
    p.turn(&coordinator, AgentState::Idle).await;
    let thread = p.start_thread(&coordinator).await;
    p.submit(&thread);
    p.report(&thread, "ready", "Built without waiting.", None);
    p.turn(&thread, AgentState::Idle).await;
    assert_eq!(thread_state(&p.run(&thread)), ThreadState::Review);
    // the plan was written in that turn: it still takes answers
    assert_eq!(p.run(&thread).plan.unwrap().closed_at, None);
    p.fleet().stop();
}

// orchestrator.test.ts: "close when the lead's next turn ends without the answers, and take none then"
#[tokio::test(start_paused = true)]
async fn close_when_the_leads_next_turn_ends_without_the_answers_and_take_none_then() {
    let p = project();
    let (coordinator, thread, _) = p.planned().await;
    // the coordinator passes on a decision the person made in its conversation instead
    p.send(&thread, "The person chose five retries.")
        .await
        .unwrap();
    p.report(&thread, "ready", "Five retries.", None);
    p.turn(&thread, AgentState::Idle).await;
    let run = p.run(&thread);
    assert!(run.plan.as_ref().unwrap().closed_at.is_some());
    assert!(p.kept(&thread)["closedAt"].is_number());
    assert_eq!(thread_state(&run), ThreadState::Review);
    assert_eq!(
        p.refused(&thread, json!({ "version": 1 })).await,
        "plan_closed"
    );
    // a blocked turn after it asks about something else: the closed plan is not pointed to again
    p.send(&thread, "go on").await.unwrap();
    p.report(&thread, "blocked", "Which branch?", Some("Which branch?"));
    p.turn(&thread, AgentState::Idle).await;
    // the coordinator, still on the first question's turn, hears it once that turn ends
    p.turn(&coordinator, AgentState::Idle).await;
    let last = p.to(&coordinator).last().cloned().unwrap();
    assert!(last.contains("asks the person: Which branch?"), "{last}");
    assert!(!last.contains("Plan tab"), "{last}");
    p.fleet().stop();
}

// orchestrator.test.ts: "answered before the coordinator heard of them, are not passed on to it afterwards"
#[tokio::test(start_paused = true)]
async fn answered_before_the_coordinator_heard_of_them_are_not_passed_on_to_it_afterwards() {
    let p = project();
    let coordinator = p.start_project("go").await;
    // the coordinator is at work, so the thread's question waits for it
    let thread = p.start_thread(&coordinator).await;
    p.submit(&thread);
    p.ask_plan(&thread);
    p.turn(&thread, AgentState::Idle).await;
    assert!(
        p.notice_of(&thread)
            .is_some_and(|notice| notice.contains("Plan tab"))
    );
    p.answer(&thread, json!({ "version": 1 })).await.unwrap();
    assert_eq!(p.notice_of(&thread), None);
    p.turn(&coordinator, AgentState::Idle).await;
    assert_eq!(p.to(&coordinator), vec!["go".to_owned()]);
    p.fleet().stop();
}

// orchestrator.test.ts: "stay unanswered when the answers do not reach the lead: on its approval screen, or a prompt that failed"
#[tokio::test(start_paused = true)]
async fn stay_unanswered_when_the_answers_do_not_reach_the_lead_on_its_approval_screen_or_a_prompt_that_failed()
 {
    let p = project();
    let (_, thread, _) = p.planned().await;
    p.s.runtime
        .on_prompt(|_, _, _| std::future::ready(Err(RuntimeError::Blocked)));
    assert_eq!(p.refused(&thread, five()).await, "agent_blocked");
    assert_eq!(p.kept(&thread).get("answeredAt"), None);
    assert_eq!(p.run(&thread).plan.unwrap().answered_at, None);
    // the person answered the approval: the same answers go now
    p.s.registry
        .update(&thread.id, |run| run.state = AgentState::Idle)
        .unwrap();
    p.s.runtime
        .on_prompt(|_, _, _| std::future::ready(Err(RuntimeError::NotFound)));
    assert_eq!(
        p.refused(&thread, json!({ "version": 1 })).await,
        "answer_not_delivered"
    );
    assert_eq!(p.kept(&thread).get("answeredAt"), None);
    p.fleet().stop();
}

// orchestrator.test.ts: "leave a newer plan the lead handed over while the answers went out as it is"
#[tokio::test(start_paused = true)]
async fn leave_a_newer_plan_the_lead_handed_over_while_the_answers_went_out_as_it_is() {
    let p = project();
    let (_, thread, _) = p.planned().await;
    // the lead writes version 2 while the answers to version 1 are being typed into its pane
    let (fleet, id) = (p.fleet().clone(), thread.id.clone());
    p.s.runtime.on_prompt(move |_, _, _| {
        let mut again = plan_value();
        again["title"] = json!("Retry limit, again");
        fleet.submit_plan(&id, &again, None).unwrap();
        std::future::ready(Ok(AgentState::Working))
    });
    p.answer(&thread, five()).await.unwrap();
    let kept = p.kept(&thread);
    assert_eq!(kept["version"], json!(2));
    assert_eq!(kept["title"], json!("Retry limit, again"));
    assert_eq!(kept.get("answeredAt"), None);
    assert_eq!(p.run(&thread).plan, Some(open_mark(2)));
    p.fleet().stop();
}

// orchestrator.test.ts: "are kept where the lead does not write, and one that does not hold together is refused, not drawn"
#[tokio::test(start_paused = true)]
async fn are_kept_where_the_lead_does_not_write_and_one_that_does_not_hold_together_is_refused_not_drawn()
 {
    let p = project();
    let (coordinator, thread, _) = p.planned().await;
    // a plan.json the lead wrote into its own result folder is not the fleet's
    fs::write(
        p.s.result_dir(&thread.id).join("plan.json"),
        json!({ "version": 9, "writtenAt": 1, "title": "Mine", "claims": [{ "text": "x", "children": [] }], "why": [], "scope": [] }).to_string(),
    )
    .unwrap();
    assert_eq!(
        p.fleet().plan(&thread.id, None).unwrap().title,
        "Retry limit"
    );
    // the kept file, broken: refused as unreadable, and the rest of the fleet reads on
    fs::write(
        p.plan_file(&thread),
        json!({ "version": 1, "writtenAt": 1, "title": "t", "claims": [{ "text": { "html": "<b>" } }] }).to_string(),
    )
    .unwrap();
    assert_eq!(
        p.fleet().plan(&thread.id, None).unwrap_err().code,
        "plan_unreadable"
    );
    assert_eq!(
        p.refused(&thread, json!({ "version": 1 })).await,
        "plan_unreadable"
    );
    let threads = p
        .fleet()
        .threads(Some(&coordinator.id), None)
        .await
        .unwrap();
    let ids: Vec<&String> = threads.iter().map(|each| &each.run.id).collect();
    assert_eq!(ids, [&thread.id]);
    // the lead hands it over again: the next version
    assert_eq!(p.submit(&thread).version, 2);
    p.fleet().stop();
}

// orchestrator.test.ts: "come only from a thread's lead, and only plans that hold together"
#[tokio::test(start_paused = true)]
async fn come_only_from_a_threads_lead_and_only_plans_that_hold_together() {
    let p = project();
    let (_, thread, _) = p.planned().await;
    let mut asked = request();
    asked.role = "reviewer".to_owned();
    let helper = spawn(p.fleet(), asked).await.unwrap();
    let refused = code(
        p.fleet()
            .submit_plan(&helper.id, &plan_value(), Some(&helper.group)),
    );
    assert_eq!(refused, "not_a_thread");
    let outside = p.fleet().submit_plan(
        &thread.id,
        &json!({ "title": "Retry limit", "claims": [{ "text": "x", "exhibit": { "kind": "code", "path": "../../etc/passwd", "start": 1 } }] }),
        None,
    );
    let message = outside.unwrap_err().to_string();
    assert!(
        message.contains("../../etc/passwd is not a file in the thread's worktree"),
        "{message}"
    );
    let refused = code(p.fleet().submit_plan(
        &thread.id,
        &json!({ "title": "t", "claims": [] }),
        None,
    ));
    assert_eq!(refused, "invalid_plan");
    assert_eq!(p.fleet().plan(&thread.id, None).unwrap().version, 1);
    p.fleet().stop();
}

// codex's review of #265: a plan past the last u32 version would reuse it; refused, the kept stays
#[tokio::test(start_paused = true)]
async fn refuse_a_plan_past_the_last_version_rather_than_count_one_twice() {
    let p = project();
    let (_, thread, _) = p.planned().await;
    let mut kept = p.kept(&thread);
    kept["version"] = json!(4_294_967_295_u32);
    fs::write(p.plan_file(&thread), kept.to_string()).unwrap();
    let refused = code(p.fleet().submit_plan(&thread.id, &plan_value(), None));
    assert_eq!(refused, "invalid_plan");
    assert_eq!(p.kept(&thread), kept);
    p.fleet().stop();
}

// ---- describe "threads" ----

/// herdr's states as run 4bff4935 showed them on 2026-11-08: done, then working and done again
/// (`flicker`, orchestrator.test.ts).
async fn flicker(fleet: &Orchestrator, runtime: &common::FakeRuntime) {
    for state in [AgentState::Done, AgentState::Working, AgentState::Done] {
        runtime.set_get_status(state);
        fleet.reconcile_all().await;
    }
}

/// `restartAfterSend()` (orchestrator.test.ts:1121-1138): a thread whose task the fleet sent, the
/// server stopped.
async fn restart_after_send() -> (common::Setup, AgentRun) {
    let s = setup(SetupOptions {
        agents: Some(vec![talking("lead")]),
        landing: in_repo(),
        ..SetupOptions::default()
    });
    s.runtime.set_prompt_status(AgentState::Working);
    let cancel = CancellationToken::new();
    let thread = s.fleet.start_thread(fix(None), &cancel).await.unwrap();
    s.fleet.stop();
    (s, thread)
}

/// Its `restart()`: a new server over a new registry read from the same runs file, with no
/// repository, head, change, branch or pull request, the lead role and the shortened grace.
fn restarted(s: &common::Setup) -> (Orchestrator, Arc<RunRegistry>) {
    let registry = Arc::new(RunRegistry::open(
        Some(s.root.join("runs.json")),
        s.clock.as_ref(),
    ));
    let mut deps = common::deps(
        s.runtime.clone(),
        registry.clone(),
        &s.root,
        s.clock.clone(),
        common::config(None),
        vec![talking("lead")],
    );
    deps.timings.pre_visual_grace = GRACE;
    (Orchestrator::new(deps).unwrap(), registry)
}

// orchestrator.test.ts: "and keep the plan that turn wrote before the restart open for the person's answers"
#[tokio::test(start_paused = true)]
async fn and_keep_the_plan_that_turn_wrote_before_the_restart_open_for_the_persons_answers() {
    let (s, thread) = restart_after_send().await;
    s.fleet
        .submit_plan(
            &thread.id,
            &json!({ "title": "Retry limit", "claims": [{ "text": "A failed send is tried three times.", "exhibit": { "kind": "list", "items": ["three"] } }] }),
            None,
        )
        .unwrap();
    sleep_ms(5).await;
    let (fleet, registry) = restarted(&s);
    fs::write(
        s.result_dir(&thread.id).join("handoff.md"),
        "## HANDOFF\nBLOCKED — the plan waits for the person",
    )
    .unwrap();
    flicker(&fleet, &s.runtime).await;
    let plan = registry.get(&thread.id).unwrap().plan.unwrap();
    assert_eq!(plan.version, 1);
    assert_eq!(plan.closed_at, None);
    fleet.stop();
}
