//! Threads: a lead in a workspace (and worktree) of its own, named by its title; `startThread`,
//! `threads`, `resolve` and `readThreadWork` of `server/fleet/orchestrator.ts`.

use std::path::Path;

use protocol::{AgentRun, ThreadSummary, contract_items, js, outcome_line, thread_state};
use tokio_util::sync::CancellationToken;

use super::spawn::{SpawnRequest, ThreadPlace, absolute};
use super::{Orchestrator, OrchestratorError, THREAD_ROLE, is_thread, read_result};
use crate::brief::BriefDraft;
use crate::error::FleetError;
use crate::registry::make_group_id;

/// The file a thread's lead keeps its acceptance contract in, in its result folder.
pub(crate) const CONTRACT_FILE: &str = "contract.md";
/// The longest title a thread may have, in UTF-16 code units as JavaScript counts a string.
const TITLE_MAX: usize = 120;

/// A thread to start: its lead gets the task, in a workspace (and worktree) of its own named by
/// the title (`ThreadRequest`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ThreadRequest {
    pub title: String,
    /// what to do; with a brief, notes after it
    pub task: Option<String>,
    pub brief: Option<BriefDraft>,
    pub cwd: Option<String>,
    /// the caller's depth: 0 for a person, the screen, or a top-level agent
    pub depth: Option<u32>,
    /// the run that starts the thread (`HERDR_FLEET_RUN`), which then owns it
    pub caller_run: Option<String>,
}

/// What the threads keep while this server runs.
#[derive(Debug, Default)]
pub(crate) struct State {}

/// `value` unless it is empty: JavaScript's `value ? … : …` on an optional string.
fn given(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.is_empty())
}

impl Orchestrator {
    /// A thread: a fleet of its own, whose lead starts in a new workspace named by its title, on a
    /// worktree of its own when the folder lies in a repository (after the user's setup command
    /// for it). The lead stays when its turn ends, so the thread can be asked again
    /// (`startThread`).
    pub async fn start_thread(
        &self,
        request: ThreadRequest,
        cancel: &CancellationToken,
    ) -> Result<AgentRun, OrchestratorError> {
        let title = js::trim(&request.title);
        if title.is_empty() || js::utf16_len(title) > TITLE_MAX {
            return Err(FleetError::new(
                "invalid_title",
                "A thread needs a title of up to 120 characters.",
            )
            .into());
        }
        let cwd = absolute(request.cwd.as_deref());
        let owner = match given(request.caller_run.as_deref()) {
            Some(id) => Some(self.calling_run(id)?.id),
            None => None,
        };
        let landing = &self.deps().landing;
        let repo = landing.git_root(Path::new(&cwd)).await;
        let (base, base_branch) = match &repo {
            Some(repo) => {
                landing.exclude_worktrees(repo).await?;
                (landing.git_head(repo).await, landing.git_branch(repo).await)
            }
            None => (None, None),
        };
        let request = SpawnRequest {
            role: THREAD_ROLE.to_owned(),
            name: Some(title.to_owned()),
            task: request.task,
            brief: request.brief,
            cwd: Some(cwd),
            depth: request.depth,
            group: Some(make_group_id()),
            worktree: Some(repo.is_some()),
            interactive: Some(true),
            ..SpawnRequest::default()
        };
        let place = ThreadPlace {
            repo,
            owner,
            base: base.filter(|base| !base.is_empty()),
            base_branch: base_branch.filter(|branch| !branch.is_empty()),
            takeover: None,
        };
        self.launch(request, cancel, Some(place)).await
    }

    /// The threads of the caller's project, oldest first: the project of `caller_run`, or the
    /// repository `cwd` lies in, or `cwd` itself. A thread's earlier lead runs are not listed, its
    /// latest is (`threads`).
    pub async fn threads(
        &self,
        caller_run: Option<&str>,
        cwd: Option<&str>,
    ) -> Result<Vec<ThreadSummary>, FleetError> {
        let caller = match given(caller_run) {
            Some(id) => Some(self.calling_run(id)?),
            None => None,
        };
        let cwd = absolute(cwd);
        let project = match caller.and_then(|caller| caller.project) {
            Some(project) => project,
            None => self
                .deps()
                .landing
                .git_root(Path::new(&cwd))
                .await
                .map_or(cwd, |repo| repo.to_string_lossy().into_owned()),
        };
        let threads = self
            .list(None)
            .into_iter()
            .filter(|run| {
                run.role == THREAD_ROLE
                    && run.project.as_deref() == Some(project.as_str())
                    && run.replaced_by.is_none()
            })
            .map(|run| {
                let contract = read_result(&self.result_dir(&run.id).join(CONTRACT_FILE));
                ThreadSummary {
                    state: thread_state(&run),
                    status: run.outcome.as_ref().map(outcome_line),
                    contract: contract.map(|contract| contract_items(&contract)),
                    run,
                }
            })
            .collect();
        Ok(threads)
    }

    /// Marks a thread done for the person, or open again; its lead's next turn opens it again too
    /// (`resolve`).
    pub fn resolve(
        &self,
        target: &str,
        resolved: bool,
        group: Option<&str>,
    ) -> Result<AgentRun, FleetError> {
        let run = self.get(target, group)?;
        if !is_thread(&run) {
            return Err(FleetError::new(
                "not_a_thread",
                format!("{} is not a thread's lead.", run.name),
            ));
        }
        let now = self.now();
        self.change(&run.id, |run| {
            run.resolved_at = resolved.then_some(now);
            run.updated_at = now;
        })
        .ok_or_else(|| FleetError::new("run_not_found", format!("Unknown fleet agent: {target}")))
    }

    /// What a thread's lead left in its worktree as its turn settled: its contract and its change
    /// since the base, kept on the run `id` (`readThreadWork`).
    pub(crate) async fn read_thread_work(&self, id: &str) {
        let Some(run) = self.registry().get(id) else {
            return;
        };
        let contract = read_result(&self.result_dir(id).join(CONTRACT_FILE))
            .map(|contract| contract_items(&contract));
        let base = run.base_branch.or(run.base).filter(|base| !base.is_empty());
        let diff = match base {
            Some(base) => {
                self.deps()
                    .landing
                    .diff_stat(Path::new(&run.cwd), &base)
                    .await
            }
            None => None,
        };
        // read again after the await: only the two fields this read owns change
        self.change(id, |run| {
            run.contract = contract;
            run.diff = diff;
        });
    }

    /// The run `id` that calls, as a thread's or a listing's caller names it.
    fn calling_run(&self, id: &str) -> Result<AgentRun, FleetError> {
        self.registry()
            .get(id)
            .ok_or_else(|| FleetError::new("run_not_found", format!("Unknown calling run: {id}")))
    }
}
