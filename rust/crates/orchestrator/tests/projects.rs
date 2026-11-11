//! Projects: one coordinator per repository, in its main checkout. The tests named after an `it`
//! are `server/fleet/orchestrator.test.ts`'s describes `projects` and `owners`, with their
//! expected values.

mod common;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use common::{FakeLanding, SetupOptions, answer, role, setup};
use herdr_fleet_orchestrator::agents::AgentDefinition;
use herdr_fleet_orchestrator::fleet::{
    LandingTools, Orchestrator, OrchestratorError, ThreadRequest,
};
use herdr_fleet_orchestrator::runtime::RuntimeLocation;
use protocol::{AgentRun, AgentState, FleetAgentKind};
use tokio_util::sync::CancellationToken;

/// `role("coordinator", { model: "claude:sonnet", interactive: true, spawning: true, edits: false })`
/// (orchestrator.test.ts:1846).
fn coordinator() -> AgentDefinition {
    AgentDefinition {
        model: Some("claude:sonnet".to_owned()),
        interactive: Some(true),
        spawning: Some(true),
        edits: Some(false),
        ..role("coordinator")
    }
}

/// `fleet.startProject({ task, cwd, fromPane })`.
async fn start_project(
    fleet: &Orchestrator,
    task: &str,
    cwd: Option<&str>,
    from_pane: Option<&str>,
) -> Result<AgentRun, OrchestratorError> {
    fleet
        .start_project(task, cwd, from_pane, &CancellationToken::new())
        .await
}

/// `fleet.startThread({ title, task, cwd, callerRun })`.
async fn start_thread(
    fleet: &Orchestrator,
    title: &str,
    cwd: &str,
    caller_run: Option<&str>,
) -> Result<AgentRun, OrchestratorError> {
    let request = ThreadRequest {
        title: title.to_owned(),
        task: Some("t".to_owned()),
        cwd: Some(cwd.to_owned()),
        caller_run: caller_run.map(str::to_owned),
        ..ThreadRequest::default()
    };
    fleet.start_thread(request, &CancellationToken::new()).await
}

/// `gitRoot: async () => root`.
fn git_root_always(root: &'static str) -> Option<Arc<dyn LandingTools>> {
    let landing = FakeLanding::new();
    landing.answers().git_root = answer(move |_: PathBuf| async move { Some(PathBuf::from(root)) });
    Some(landing)
}

fn texts(s: &common::Setup) -> Vec<String> {
    s.runtime.prompts().into_iter().map(|p| p.text).collect()
}

// orchestrator.test.ts: "start the coordinator in the repository's main checkout, in a workspace named after it, editing nothing"
#[tokio::test(start_paused = true)]
async fn start_the_coordinator_in_the_repositorys_main_checkout_in_a_workspace_named_after_it_editing_nothing()
 {
    let s = setup(SetupOptions {
        agents: Some(vec![coordinator()]),
        landing: git_root_always("/home/me/app"),
        ..SetupOptions::default()
    });
    let run = start_project(
        &s.fleet,
        "What is left to do?",
        Some("/home/me/app/src"),
        None,
    )
    .await
    .unwrap();
    assert_eq!(run.role, "coordinator");
    assert_eq!(run.name, "app · fleet");
    assert_eq!(run.agent, FleetAgentKind::Claude);
    assert_eq!(run.project.as_deref(), Some("/home/me/app"));
    assert!(run.interactive);
    assert!(!run.worktree);
    assert_eq!(run.depth, 1);
    assert_eq!(run.owner, None);
    let location = s.runtime.locations()[0].clone();
    assert_eq!(location.cwd, "/home/me/app");
    assert_eq!(location.label, "app · fleet");
    assert!(!location.worktree);
    assert_eq!(location.caller_pane_id, None);
    assert!(
        s.runtime.starts()[0]
            .args
            .join(" ")
            .contains("--disallowedTools Edit,Write,NotebookEdit")
    );
    assert_eq!(s.runtime.prompts()[0].text, "What is left to do?");
    // the person reads its reply: it writes no handoff
    let instructions = s.runtime.instructions()[0].clone();
    assert!(!instructions.contains("result file"));
    assert!(!instructions.contains("HANDOFF"));
}

// orchestrator.test.ts: "keep one coordinator per project: a second start hands it the task, even when both come at once"
#[tokio::test(start_paused = true)]
async fn keep_one_coordinator_per_project_a_second_start_hands_it_the_task_even_when_both_come_at_once()
 {
    let landing = FakeLanding::new();
    landing.answers().git_root = answer(|cwd: PathBuf| async move {
        cwd.to_string_lossy()
            .starts_with("/repo")
            .then(|| PathBuf::from("/repo"))
    });
    let s = setup(SetupOptions {
        agents: Some(vec![coordinator()]),
        landing: Some(landing),
        ..SetupOptions::default()
    });
    // TypeScript's fake answers each call with a promise, so the first start lets the second run
    // between its look for a live coordinator and its run's first save; the Rust fake answers at
    // once, and yields here to open the same window
    let panes = Arc::new(AtomicUsize::new(0));
    s.runtime.on_create_location(move |options, _| {
        let pane = panes.fetch_add(1, Ordering::Relaxed) + 1;
        async move {
            tokio::task::yield_now().await;
            Ok(RuntimeLocation {
                pane_id: format!("w1:p{pane}"),
                workspace_id: None,
                cwd: options.cwd,
            })
        }
    });
    let (first, again) = tokio::join!(
        start_project(&s.fleet, "one", Some("/repo"), None),
        start_project(&s.fleet, "two", Some("/repo/src"), None),
    );
    let (first, again) = (first.unwrap(), again.unwrap());
    assert_eq!(again.id, first.id);
    assert_eq!(s.runtime.locations().len(), 1);
    assert_eq!(texts(&s), vec!["one", "two"]);
    // another folder is another project; a coordinator that ended is replaced
    let notes = start_project(&s.fleet, "three", Some("/notes"), None)
        .await
        .unwrap();
    assert_eq!(notes.project.as_deref(), Some("/notes"));
    assert_eq!(notes.name, "notes · fleet");
    s.registry
        .update(&first.id, |run| run.state = AgentState::Stopped)
        .unwrap();
    let fourth = start_project(&s.fleet, "four", Some("/repo"), None)
        .await
        .unwrap();
    assert_ne!(fourth.id, first.id);
}

// orchestrator.test.ts: "need a task"
#[tokio::test(start_paused = true)]
async fn need_a_task() {
    let s = setup(SetupOptions {
        agents: Some(vec![coordinator()]),
        ..SetupOptions::default()
    });
    let error = start_project(&s.fleet, " ", None, None).await.unwrap_err();
    assert_eq!(error.code(), "missing_task");
}

// orchestrator.test.ts: "open a task sent from a pane's conversation with that pane, for the coordinator and the Fleet screen"
#[tokio::test(start_paused = true)]
async fn open_a_task_sent_from_a_panes_conversation_with_that_pane_for_the_coordinator_and_the_fleet_screen()
 {
    let s = setup(SetupOptions {
        agents: Some(vec![coordinator()]),
        landing: git_root_always("/repo"),
        ..SetupOptions::default()
    });
    start_project(
        &s.fleet,
        "Fix the doubled login error.",
        Some("/repo"),
        Some("w2:p3"),
    )
    .await
    .unwrap();
    start_project(
        &s.fleet,
        "And the logout one.",
        Some("/repo"),
        Some("w2:p3"),
    )
    .await
    .unwrap();
    assert_eq!(
        texts(&s),
        vec![
            "[from pane w2:p3]\n\nFix the doubled login error.",
            "[from pane w2:p3]\n\nAnd the logout one.",
        ]
    );
}

// orchestrator.test.ts (describe "owners"): "reach a thread they started from their own fleet, and no one else's"
#[tokio::test(start_paused = true)]
async fn reach_a_thread_they_started_from_their_own_fleet_and_no_one_elses() {
    let s = setup(SetupOptions {
        agents: Some(vec![
            AgentDefinition {
                interactive: Some(true),
                spawning: Some(true),
                ..role("coordinator")
            },
            AgentDefinition {
                interactive: Some(true),
                ..role("lead")
            },
        ]),
        landing: git_root_always("/repo"),
        ..SetupOptions::default()
    });
    let coordinator = start_project(&s.fleet, "go", Some("/repo"), None)
        .await
        .unwrap();
    let thread = start_thread(&s.fleet, "Fix", "/repo", Some(&coordinator.id))
        .await
        .unwrap();
    let loose = start_thread(&s.fleet, "Other", "/repo", None)
        .await
        .unwrap();
    s.runtime.set_get_status(AgentState::Idle);
    s.fleet
        .send(
            &thread.id,
            "keep the old API",
            Some(&coordinator.group),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let last = s.runtime.prompts().last().cloned().unwrap();
    assert_eq!(last.name, thread.herdr_name);
    assert_eq!(last.text, "keep the old API");
    let error = s
        .fleet
        .get(&loose.id, Some(&coordinator.group))
        .unwrap_err();
    assert!(error.to_string().contains("Unknown fleet agent"), "{error}");
    let error = s.fleet.get(&thread.id, Some("elsewhere")).unwrap_err();
    assert!(error.to_string().contains("Unknown fleet agent"), "{error}");
}

// ADR 0256-orchestrator-foundation: `/api/fleet` runs a method that starts agents in a task of its
// own, so its future must be Send
#[test]
fn the_starts_the_api_spawns_are_send() {
    fn send<T: Send>(_: &T) {}
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(true)
        .build()
        .unwrap();
    runtime.block_on(async {
        let s = setup(SetupOptions::default());
        let none = CancellationToken::new();
        send(&s.fleet.start_project("t", None, None, &none));
        send(&s.fleet.start_thread(ThreadRequest::default(), &none));
        send(&s.fleet.threads(None, None));
    });
}
