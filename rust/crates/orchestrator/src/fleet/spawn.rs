//! Starting a run: `spawn`, `launch`, `spawnAttempt`, `setUp`, `readyScreen`, `instructions` and
//! `abandonSpawn` of `server/fleet/orchestrator.ts`. The candidate loop between `launch` and
//! `spawn_attempt` is `candidates.rs`'s (#263).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use protocol::{AgentRun, AgentState, FleetAgentKind, SkippedCandidate, ThinkingLevel, js};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::{Orchestrator, OrchestratorError, PROJECT_ROLE, THREAD_ROLE};
use crate::agents::find_agent;
use crate::agents::{AgentDefinition, content_hash, role_version};
use crate::brief::{BriefDraft, check_brief, overlap, render_brief, write_scope};
use crate::config::{FleetConfig, RoleOverride, require_thinking_level};
use crate::error::FleetError;
use crate::events::{FleetEvent, RoleEvent};
use crate::launch::{Adapter, LaunchOptions, PaneContext, adapter_for};
use crate::registry::{create_private_folder, make_group_id, make_herdr_name, make_id};
use crate::report::REPORT_FILE;
use crate::runtime::{
    AgentMetadata, CreateLocationOptions, RuntimeError, SplitDirection, StartOptions,
};
use crate::thread::THREAD_WORKTREES;

/// The file an agent writes each turn's handoff to, in its result folder.
pub(crate) const RESULT_FILE: &str = "handoff.md";
/// a thread lead's task as the thread was given it, beside its result file: a later run of the
/// thread reads it
pub(crate) const TASK_FILE: &str = "task.md";
const READY_SCREEN_POLL: std::time::Duration = std::time::Duration::from_millis(250);

/// A run to start (`SpawnRequest`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SpawnRequest {
    pub name: Option<String>,
    pub role: String,
    /// what to do; with a brief, notes after it
    pub task: Option<String>,
    /// required of an agent caller (depth 1 and deeper): what its helper cannot ask back
    pub brief: Option<BriefDraft>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub cwd: Option<String>,
    pub worktree: Option<bool>,
    pub interactive: Option<bool>,
    pub direction: Option<SplitDirection>,
    /// the caller's fleet; a new one is named when absent
    pub group: Option<String>,
    /// the caller's depth: 0 for a person or a top-level agent
    pub depth: Option<u32>,
    /// the pane the caller runs in: a new agent opens beside it
    pub caller_pane_id: Option<String>,
    /// CLIs this run must not use, such as the one that wrote the change it reviews
    pub avoid: Option<Vec<FleetAgentKind>>,
}

/// A spawn with its brief turned into the task and the paths it may write, ready to try
/// candidates for (`PlannedSpawn`).
#[derive(Debug, Clone)]
pub(crate) struct PlannedSpawn {
    pub name: Option<String>,
    pub role: String,
    pub model: Option<String>,
    pub thinking: Option<String>,
    /// absolute
    pub cwd: String,
    pub worktree: Option<bool>,
    pub interactive: Option<bool>,
    pub direction: Option<SplitDirection>,
    pub group: String,
    pub depth: u32,
    pub caller_pane_id: Option<String>,
    pub avoid: Option<Vec<FleetAgentKind>>,
    pub task: String,
    pub write: Option<Vec<String>>,
    pub thread: Option<ThreadPlace>,
}

/// Where a thread works (the repository its worktree comes from, or none outside one), and the run
/// that owns it (`ThreadPlace`).
#[derive(Debug, Clone, Default)]
pub(crate) struct ThreadPlace {
    pub repo: Option<PathBuf>,
    pub owner: Option<String>,
    pub base: Option<String>,
    pub base_branch: Option<String>,
    pub takeover: Option<Takeover>,
}

/// A lead that takes a thread over from an earlier run of it: in that run's worktree and on its
/// branch, with the thread's task (`Takeover`).
#[derive(Debug, Clone)]
pub(crate) struct Takeover {
    pub from: AgentRun,
    #[allow(dead_code, reason = "#267's carry_over reads it")]
    pub thread: String,
    pub task: Option<String>,
}

/// One candidate to start, as the candidate loop chose it (`spawnAttempt`'s arguments).
#[derive(Debug, Clone)]
pub(crate) struct Attempt {
    pub config: FleetConfig,
    pub definition: AgentDefinition,
    pub over: RoleOverride,
    pub kind: FleetAgentKind,
    pub model: Option<String>,
    pub thinking: Option<ThinkingLevel>,
    /// the candidates after this one, for a failed first turn
    pub fallbacks: Vec<String>,
    pub fallback_from: Option<String>,
    pub skipped: Vec<SkippedCandidate>,
}

/// A spawn's role as the folder's config and roles resolve it, before any candidate is tried
/// (`spawnWithFallbacks`' first lines, orchestrator.ts:441-451).
#[derive(Debug, Clone)]
pub(crate) struct ResolvedRole {
    pub config: FleetConfig,
    pub definition: AgentDefinition,
    pub over: RoleOverride,
    /// the request's model, else the role override's, the role file's, the config's default
    pub primary: Option<String>,
    /// the thinking level the request, the role override or the role file chose
    pub explicit_thinking: bool,
    /// that level, else the config's default
    pub thinking: Option<ThinkingLevel>,
    /// the CLI the role runs on
    pub kind: FleetAgentKind,
    /// the configured fallbacks, as the role override or the role file lists them
    #[allow(dead_code, reason = "#263's candidate loop reads it")]
    pub fallbacks: Vec<String>,
}

/// The states in which a run may still be writing the paths its brief gave it.
fn holds_scope(state: AgentState) -> bool {
    matches!(
        state,
        AgentState::Starting | AgentState::Working | AgentState::Blocked | AgentState::Unknown
    )
}

/// A group is letters, digits, `-` and `_`, up to 48, starting with a letter or digit.
fn valid_group(group: &str) -> bool {
    let mut chars = group.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && group.len() <= 48
}

fn short_model(model: Option<&str>) -> &str {
    match model {
        None | Some("") => "default",
        Some(model) => model.rsplit_once('/').map_or(model, |(_, last)| last),
    }
}

/// `path` resolved from the server's folder.
pub(crate) fn absolute(path: Option<&str>) -> String {
    let here = std::env::current_dir().unwrap_or_default();
    crate::config::resolve(&here, path.unwrap_or("."))
        .to_string_lossy()
        .into_owned()
}

/// `text` written to `file`, private to the user (0600).
pub(crate) fn write_private(file: &Path, text: &str) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    io::Write::write_all(&mut options.open(file)?, text.as_bytes())
}

/// A folder of its own for one spawn's instruction file (`mkdtemp(<dir>/herdr-fleet-)`), removed
/// when dropped.
struct PromptFolder(PathBuf);

impl PromptFolder {
    fn new(parent: &Path) -> io::Result<PromptFolder> {
        create_private_folder(parent)?;
        loop {
            let path = parent.join(format!("herdr-fleet-{}", make_id()));
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
            match builder.create(&path) {
                Ok(()) => return Ok(PromptFolder(path)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
    }
}

impl Drop for PromptFolder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl Orchestrator {
    /// A run of `request`'s role, its task handed over once it is ready for prompts. A run that
    /// stopped at a question, or did not become ready, comes back with its task unsent.
    pub async fn spawn(
        &self,
        request: SpawnRequest,
        cancel: &CancellationToken,
    ) -> Result<AgentRun, OrchestratorError> {
        self.launch(request, cancel, None).await
    }

    /// The checks before any pane (group, depth, brief, task), then the candidates (`launch`).
    pub(crate) async fn launch(
        &self,
        request: SpawnRequest,
        cancel: &CancellationToken,
        thread: Option<ThreadPlace>,
    ) -> Result<AgentRun, OrchestratorError> {
        let group = request.group.clone().unwrap_or_else(make_group_id);
        if !valid_group(&group) {
            return Err(FleetError::new(
                "invalid_group",
                "group must be letters, digits, - and _ (up to 48)",
            )
            .into());
        }
        let depth = request.depth.unwrap_or(0);
        let cwd = absolute(request.cwd.as_deref());
        let max_depth = self.config(&cwd).max_depth;
        if f64::from(depth) >= max_depth {
            return Err(FleetError::new(
                "depth_limit",
                format!("Agent nesting limit reached: depth={depth}, maxDepth={max_depth}"),
            )
            .into());
        }
        // a person may say it in a line; an agent handing work on writes the brief its helper cannot ask back
        let brief = if request.brief.is_some() || depth >= 1 {
            Some(check_brief(request.brief.clone())?)
        } else {
            None
        };
        let task = match &brief {
            Some(brief) => render_brief(brief, request.task.as_deref()),
            None => request.task.clone().unwrap_or_default(),
        };
        if js::trim(&task).is_empty() {
            return Err(FleetError::new("missing_task", "task is required").into());
        }
        let write = brief
            .filter(|_| !request.worktree.unwrap_or(false))
            .map(|brief| write_scope(Path::new(&cwd), &brief.write));
        let planned = PlannedSpawn {
            name: request.name,
            role: request.role,
            model: request.model,
            thinking: request.thinking,
            cwd,
            worktree: request.worktree,
            interactive: request.interactive,
            direction: request.direction,
            group,
            depth,
            caller_pane_id: request.caller_pane_id,
            avoid: request.avoid,
            task,
            write,
            thread,
        };
        self.spawn_with_fallbacks(planned, cancel, None, None).await
    }

    /// The role `request` names, in the config of its folder: an unknown role and an invalid
    /// thinking level are refused here, before any candidate.
    pub(crate) fn resolve_role(
        &self,
        request: &PlannedSpawn,
    ) -> Result<ResolvedRole, OrchestratorError> {
        let config = self.config(&request.cwd);
        let agents = self.roles(Path::new(&request.cwd));
        let Some(definition) = find_agent(&agents, &request.role).cloned() else {
            let names: Vec<&str> = agents.iter().map(|agent| agent.name.as_str()).collect();
            return Err(FleetError::new(
                "unknown_role",
                format!(
                    "Unknown agent role: {}. Available: {}",
                    request.role,
                    names.join(", ")
                ),
            )
            .into());
        };
        let over = config
            .roles
            .get(&definition.name)
            .or_else(|| config.roles.get(&request.role))
            .cloned()
            .unwrap_or_default();
        let primary = request
            .model
            .clone()
            .or_else(|| over.model.clone())
            .or_else(|| definition.model.clone())
            .or_else(|| config.default_model.clone());
        let explicit = match &request.thinking {
            Some(level) => require_thinking_level(Some(level))?,
            None => over.thinking.or(definition.thinking),
        };
        let fallbacks = over
            .fallback_models
            .clone()
            .or_else(|| definition.fallback_models.clone())
            .unwrap_or_default();
        Ok(ResolvedRole {
            thinking: explicit.or(config.default_thinking),
            explicit_thinking: explicit.is_some(),
            kind: over.agent.unwrap_or(definition.agent),
            primary,
            fallbacks,
            config,
            definition,
            over,
        })
    }

    /// One candidate started: its pane, its record, its result folder and instructions, the agent
    /// CLI, and the task once it is ready (`spawnAttempt`). A cancel after the pane exists closes it.
    pub(crate) async fn spawn_attempt(
        &self,
        request: &PlannedSpawn,
        attempt: Attempt,
        cancel: &CancellationToken,
    ) -> Result<AgentRun, OrchestratorError> {
        let deps = self.deps();
        let adapter = adapter_for(attempt.kind);
        let definition = &attempt.definition;
        let depth = request.depth + 1;
        let worktree = request
            .worktree
            .or(attempt.over.worktree)
            .or(definition.worktree)
            .unwrap_or(false);
        let interactive = request
            .interactive
            .or(attempt.over.interactive)
            .or(definition.interactive)
            .unwrap_or(false);
        // a child may spawn only when its role says so and its own children would still fit under maxDepth
        let can_spawn =
            definition.may_spawn(&attempt.over) && f64::from(depth) < attempt.config.max_depth;
        let id = make_id();
        let herdr_name = make_herdr_name(&request.group, &definition.name, &id);
        let display_name = request
            .name
            .as_deref()
            .map(js::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(&definition.name)
            .to_owned();
        let takeover = request
            .thread
            .as_ref()
            .and_then(|thread| thread.takeover.as_ref());
        // a lead that takes a thread over works on the thread's branch; a thread's first lead gets one of its own
        let branch = match takeover {
            Some(takeover) => takeover.from.branch.clone(),
            None if worktree && request.thread.is_some() => Some(format!("fleet/{id}")),
            None => None,
        };
        let read_only = definition.edits == Some(false);
        let result_dir = self.result_dir(&id);
        let result_dir_text = result_dir.to_string_lossy().into_owned();
        let mut env = (deps.agent_env)();
        env.extend(adapter.env(&PaneContext {
            result_dir: &result_dir_text,
            fleet_command: &deps.fleet_command,
            model: attempt.model.as_deref(),
            read_only,
            merges: definition.name == PROJECT_ROLE,
            host: &deps.host,
        })?);
        env.insert("HERDR_FLEET_GROUP".to_owned(), request.group.clone());
        env.insert("HERDR_FLEET_DEPTH".to_owned(), depth.to_string());
        env.insert("HERDR_FLEET_RUN".to_owned(), id.clone());

        // the budget counts runs across fleets: the check and the first save must not interleave
        let run = {
            if cancel.is_cancelled() {
                return Err(RuntimeError::Cancelled.into());
            }
            let _gate = self.inner.spawn_gate.lock().await;
            if cancel.is_cancelled() {
                return Err(RuntimeError::Cancelled.into());
            }
            let all = self.registry().all();
            let active = all
                .iter()
                .filter(|run| matches!(run.state, AgentState::Starting | AgentState::Working))
                .count();
            #[expect(
                clippy::cast_precision_loss,
                reason = "a count of runs, compared as JavaScript does"
            )]
            if active as f64 >= attempt.config.max_concurrent {
                return Err(FleetError::new(
                    "concurrency_limit",
                    format!(
                        "Agent concurrency limit reached: {active}/{}",
                        attempt.config.max_concurrent
                    ),
                )
                .into());
            }
            // one writer per path: two agents changing the same files at once overwrite each other
            if let Some(write) = &request.write {
                for holder in &all {
                    let Some(held) = holder.write.as_ref().filter(|_| holds_scope(holder.state))
                    else {
                        continue;
                    };
                    if let Some(clash) = overlap(write, held) {
                        return Err(FleetError::new(
                            "scope_conflict",
                            format!(
                                "{} ({}) is still changing {}; wait for it, or give this task paths it does not hold.",
                                holder.name, holder.id, clash.theirs
                            ),
                        )
                        .into());
                    }
                }
            }
            let repo = request
                .thread
                .as_ref()
                .and_then(|thread| thread.repo.as_ref());
            let location = deps
                .runtime
                .create_location(
                    CreateLocationOptions {
                        cwd: request.cwd.clone(),
                        label: display_name.clone(),
                        worktree,
                        branch: worktree.then(|| match request.thread {
                            Some(_) => format!("fleet/{id}"),
                            None => format!("agents/{}-{id}", definition.name),
                        }),
                        path: repo.filter(|_| worktree).map(|repo| {
                            repo.join(THREAD_WORKTREES)
                                .join(&id)
                                .to_string_lossy()
                                .into_owned()
                        }),
                        direction: request.direction,
                        caller_pane_id: request.caller_pane_id.clone(),
                        env,
                    },
                    cancel,
                )
                .await?;
            let now = self.now();
            let thread = request.thread.as_ref();
            let mut run: AgentRun = serde_json::from_value(serde_json::json!({
                "id": id, "name": display_name, "role": definition.name, "agent": attempt.kind,
                "group": request.group, "herdrName": herdr_name, "paneId": location.pane_id,
                "cwd": location.cwd, "state": AgentState::Starting, "depth": depth,
                "interactive": interactive, "worktree": takeover.map_or(worktree, |t| t.from.worktree),
                "startedAt": now, "updatedAt": now,
            }))
            .map_err(|error| io::Error::other(error.to_string()))?;
            run.workspace_id = location.workspace_id;
            run.model = attempt.model.clone();
            run.thinking = attempt.thinking;
            run.fallback_from = attempt.fallback_from.clone();
            run.branch = branch.clone();
            run.project = thread
                .and_then(|thread| thread.repo.as_ref())
                .map(|repo| repo.to_string_lossy().into_owned());
            run.owner = thread.and_then(|thread| thread.owner.clone());
            run.base = thread
                .and_then(|thread| thread.base.clone())
                .filter(|_| branch.is_some());
            run.base_branch = thread
                .and_then(|thread| thread.base_branch.clone())
                .filter(|_| branch.is_some());
            if let Some(takeover) = takeover {
                self.carry_over(takeover, request.avoid.as_deref(), &mut run);
            }
            run.skipped = (!attempt.skipped.is_empty()).then(|| attempt.skipped.clone());
            run.write = request.write.clone();
            self.insert(run.clone());
            run
        };

        let prepared = self.prepare(&run, request, &attempt, adapter, can_spawn);
        let started = match prepared {
            Ok((prompt, instructions)) => {
                let started = self
                    .start_agent(
                        run.clone(),
                        request,
                        &attempt,
                        adapter,
                        &prompt,
                        &instructions,
                        cancel,
                    )
                    .await;
                drop(prompt);
                started
            }
            Err(error) => Err(error),
        };
        match started {
            Err(OrchestratorError::Runtime(RuntimeError::Cancelled)) => {
                self.abandon_spawn(&run.id).await;
                Err(RuntimeError::Cancelled.into())
            }
            other => other,
        }
    }

    /// The run's result folder, its thread's task, the role's event, and its instructions in a
    /// file the agent reads at startup (and for a CLI that takes none at launch, kept for its first
    /// prompt).
    fn prepare(
        &self,
        run: &AgentRun,
        request: &PlannedSpawn,
        attempt: &Attempt,
        adapter: &Adapter,
        can_spawn: bool,
    ) -> Result<(PromptFolder, String), OrchestratorError> {
        let deps = self.deps();
        let definition = &attempt.definition;
        // the agent writes each turn's handoff here: a folder of its own, outside any workspace
        let result_dir = self.result_dir(&run.id);
        create_private_folder(&deps.results_dir)?;
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(&result_dir)?;
        let takeover = request
            .thread
            .as_ref()
            .and_then(|thread| thread.takeover.as_ref());
        if definition.name == THREAD_ROLE && request.thread.is_some() {
            let task = match takeover {
                Some(takeover) => takeover.task.as_deref(),
                None => Some(request.task.as_str()),
            };
            if let Some(task) = task.filter(|task| !task.is_empty()) {
                write_private(&result_dir.join(TASK_FILE), task)?;
            }
            if let Some(takeover) = takeover {
                self.carry_files(&takeover.from, run);
            }
        }
        // a project's coordinator talks with the person, who reads its reply: no agent reads a handoff of it
        let result_file = (definition.name != PROJECT_ROLE).then(|| result_dir.join(RESULT_FILE));
        let standing = deps
            .standing_orders
            .as_ref()
            .map(|orders| orders(Path::new(&request.cwd)))
            .unwrap_or_default();
        let version = role_version(definition);
        self.event(FleetEvent::Role(RoleEvent {
            run: run.id.clone(),
            role: version.role,
            source: version.source.as_str().to_owned(),
            file: version.file.to_string_lossy().into_owned(),
            hash: version.hash,
            standing: (!standing.is_empty()).then(|| content_hash(&standing)),
        }));
        let instructions = self.instructions(
            definition,
            &run.name,
            &request.group,
            can_spawn,
            result_file.as_deref(),
            adapter,
            &standing,
            attempt.config.language.as_deref(),
        );
        if adapter.instructions_in_prompt {
            create_private_folder(&deps.instructions_dir)?;
            write_private(&self.undelivered_file(&run.id), &instructions)?;
        }
        // herdr refuses multiline argv: the instructions go to the agent as a file it reads at startup
        let prompt_parent = deps.prompt_dir.clone().unwrap_or_else(std::env::temp_dir);
        let prompt = PromptFolder::new(&prompt_parent)?;
        write_private(&prompt.0.join("instructions.md"), &instructions)?;
        Ok((prompt, instructions))
    }

    /// The setup command, the agent CLI, its first screen, and the task handed over.
    #[expect(
        clippy::too_many_arguments,
        reason = "spawnAttempt's own steps, split for reading"
    )]
    async fn start_agent(
        &self,
        run: AgentRun,
        request: &PlannedSpawn,
        attempt: &Attempt,
        adapter: &Adapter,
        prompt: &PromptFolder,
        instructions: &str,
        cancel: &CancellationToken,
    ) -> Result<AgentRun, OrchestratorError> {
        let deps = self.deps();
        let definition = &attempt.definition;
        let checks = screen::screen_checks(attempt.kind);
        let worktree_repo = request
            .thread
            .as_ref()
            .and_then(|thread| thread.repo.as_ref())
            .filter(|_| {
                request
                    .worktree
                    .or(attempt.over.worktree)
                    .or(definition.worktree)
                    .unwrap_or(false)
            });
        let setup = worktree_repo.and_then(|repo| {
            attempt
                .config
                .projects
                .get(repo.to_string_lossy().as_ref())
                .and_then(|project| project.setup.clone())
        });
        if let Some(command) = setup {
            self.set_up(&run, &command, cancel).await?;
        }
        let prompt_file = prompt
            .0
            .join("instructions.md")
            .to_string_lossy()
            .into_owned();
        let result_dir = self.result_dir(&run.id).to_string_lossy().into_owned();
        let tools = definition.tools.clone().unwrap_or_default();
        let mut args = adapter.launch_args(&LaunchOptions {
            model: attempt.model.as_deref(),
            thinking: attempt.thinking,
            tools: &tools,
            name: &run.name,
            system_prompt_file: &prompt_file,
            system_prompt: instructions,
            result_dir: &result_dir,
            cwd: &run.cwd,
        });
        if definition.edits == Some(false) {
            args.extend(
                adapter
                    .read_only_args
                    .unwrap_or(&[])
                    .iter()
                    .map(|arg| (*arg).to_owned()),
            );
        }
        let started: Result<(AgentState, Option<String>), OrchestratorError> = async {
            let state = deps
                .runtime
                .start(StartOptions {
                    kind: attempt.kind,
                    name: run.herdr_name.clone(),
                    pane_id: run.pane_id.clone(),
                    args,
                    startup_error: checks.startup_error,
                    cancel: cancel.clone(),
                })
                .await?;
            if state == AgentState::Blocked {
                return Ok((
                    state,
                    Some("Agent stopped at a question before its first prompt; the task has not been sent.".to_owned()),
                ));
            }
            if checks.question.is_none() && checks.ready_error.is_none() {
                return Ok((state, None));
            }
            // herdr calls some CLIs ready while they still ask something, or after they ignored the model
            let screen = self.ready_screen(&run.herdr_name, &checks, &attempt.config, cancel).await?;
            if let Some(error) = checks.ready_error.and_then(|ready_error| ready_error(&screen)) {
                return Err(RuntimeError::StartFailed(error).into());
            }
            match checks.question.and_then(|question| question(&screen)) {
                Some(question) => Ok((AgentState::Blocked, Some(format!("{question} The task has not been sent.")))),
                None => Ok((state, None)),
            }
        }
        .await;
        let mut not_ready = false;
        let (state, last_error) = match started {
            Ok(started) => started,
            Err(error @ OrchestratorError::Runtime(RuntimeError::Cancelled)) => return Err(error),
            Err(OrchestratorError::Runtime(RuntimeError::NotReady(_))) => {
                not_ready = true;
                let state = deps
                    .runtime
                    .get(&run.herdr_name)
                    .await
                    .unwrap_or(AgentState::Unknown);
                (
                    state,
                    Some(
                        "Agent started but is not ready for prompts; the task has not been sent."
                            .to_owned(),
                    ),
                )
            }
            Err(error) => {
                let now = self.now();
                let message = error.to_string();
                self.drop_undelivered(&run.id);
                self.change(&run.id, |run| {
                    run.state = AgentState::Failed;
                    run.last_error = Some(message);
                    run.updated_at = now;
                });
                // the agent never started: an empty pane left behind would be an orphan
                let _ = deps.runtime.close_pane(&run.pane_id).await;
                return Err(error);
            }
        };
        let now = self.now();
        let Some(run) = self.change(&run.id, |run| {
            run.state = state;
            if last_error.is_some() {
                run.last_error = last_error;
            }
            run.updated_at = now;
        }) else {
            return Err(FleetError::new(
                "run_not_found",
                "The run's record went away while it started.",
            )
            .into());
        };
        let fleet = request
            .group
            .strip_prefix("fleet-")
            .unwrap_or(&request.group);
        let tokens = [
            ("fleet", fleet),
            ("role", run.role.as_str()),
            ("model", short_model(run.model.as_deref())),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect();
        let _ = deps
            .runtime
            .report_metadata(AgentMetadata {
                pane_id: run.pane_id.clone(),
                title: run.name.clone(),
                display_agent: format!("{}: {}", run.role, run.name),
                tokens,
            })
            .await;
        if cancel.is_cancelled() {
            return Err(RuntimeError::Cancelled.into());
        }
        // not safely ready: the task stays unsent; the caller reads or focuses the pane, then sends it
        if not_ready || matches!(run.state, AgentState::Blocked | AgentState::Unknown) {
            return Ok(run);
        }
        if !attempt.fallbacks.is_empty() {
            self.keep_spawn_plan(&run.id, request, &attempt.fallbacks);
        }
        // returns once the task is handed over: the budget counts working runs, and a run still
        // `starting` would let the next spawn past the limit
        self.submit(&run.id, &request.task, cancel).await
    }

    /// The user's setup command in the thread's fresh worktree; a failure fails the run before its
    /// lead starts (`setUp`).
    async fn set_up(
        &self,
        run: &AgentRun,
        command: &str,
        cancel: &CancellationToken,
    ) -> Result<(), OrchestratorError> {
        let outcome = self
            .deps()
            .landing
            .run_setup(Path::new(&run.cwd), command, cancel)
            .await;
        if cancel.is_cancelled() {
            return Err(RuntimeError::Cancelled.into());
        }
        if outcome.ok {
            return Ok(());
        }
        let message = format!(
            "The setup command `{command}` failed in {}:\n{}",
            run.cwd, outcome.output
        );
        let now = self.now();
        self.drop_undelivered(&run.id);
        self.change(&run.id, |run| {
            run.state = AgentState::Failed;
            run.last_error = Some(message.clone());
            run.updated_at = now;
        });
        let _ = self.deps().runtime.close_pane(&run.pane_id).await;
        Err(FleetError::new("setup_failed", message).into())
    }

    /// The screen right after start. A CLI that draws its input or a question only after herdr
    /// called it ready is waited for: a task typed before would land in a question. Neither in time
    /// is a start not ready for prompts (`readyScreen`).
    async fn ready_screen(
        &self,
        herdr_name: &str,
        checks: &screen::ScreenChecks,
        config: &FleetConfig,
        cancel: &CancellationToken,
    ) -> Result<String, OrchestratorError> {
        let wait = self.deps().timings.ready_screen;
        let deadline = Instant::now() + wait;
        loop {
            let screen = self
                .deps()
                .runtime
                .read(herdr_name, read_lines(config))
                .await
                .unwrap_or_default();
            if checks.input_ready.is_none_or(|ready| ready(&screen))
                || checks
                    .question
                    .is_some_and(|question| question(&screen).is_some())
                || checks
                    .ready_error
                    .is_some_and(|ready_error| ready_error(&screen).is_some())
            {
                return Ok(screen);
            }
            if Instant::now() >= deadline {
                return Err(RuntimeError::NotReady(format!(
                    "{herdr_name} showed no input within {}s",
                    wait.as_secs_f64()
                ))
                .into());
            }
            tokio::select! {
                () = tokio::time::sleep(READY_SCREEN_POLL) => {}
                () = cancel.cancelled() => return Err(RuntimeError::Cancelled.into()),
            }
        }
    }

    /// The instructions an agent starts with: its role, how to reach its fleet, its result and
    /// report files, the person's language and the standing orders (`instructions`).
    #[expect(clippy::too_many_arguments, reason = "instructions' own arguments")]
    fn instructions(
        &self,
        definition: &AgentDefinition,
        name: &str,
        group: &str,
        can_spawn: bool,
        result_file: Option<&Path>,
        adapter: &Adapter,
        standing: &str,
        language: Option<&str>,
    ) -> String {
        let fleet = &self.deps().fleet_command;
        let mut lines: Vec<String> = vec![
            definition.system_prompt.clone(),
            String::new(),
            "## Fleet coordination".to_owned(),
            format!("You are '{name}' in fleet '{group}'. Other agents of this fleet run in their own herdr panes."),
            "Coordinate with them only through the fleet command in your shell; never type into another agent's terminal.".to_owned(),
            format!("- List the agents: {fleet} list"),
            format!("- Message one: {fleet} send <name-or-id> \"<message>\""),
            format!("- Read one's recent output: {fleet} read <name-or-id>"),
            if can_spawn {
                [
                    format!("- Start a helper when splitting the work materially improves the result, with a brief it can work from without asking you: {fleet} spawn --role <role> --goal \"<the outcome, one sentence>\" --write <path> (repeat; --read-only when it only reads) --context \"<files, earlier results and decisions it needs, or none>\" --done \"<a checkable condition>\" --verify \"<commands to run, and the evidence to return>\", then {fleet} wait <id>."),
                    format!("  Each part has one executor: do not work on a part you handed on, or hand it to two agents. Two agents never write the same paths at once; the fleet refuses a spawn whose paths another working agent holds. Start a review only after the writer has finished, on another CLI than the writer's: add --avoid <cli> ({fleet} list shows each agent's CLI)."),
                ]
                .join("\n")
            } else {
                "Do not start other agents.".to_owned()
            },
            "If an agent is blocked on an approval or a question, read its output and escalate to the human; never answer a blocked prompt yourself.".to_owned(),
            "Treat herdr's 'unknown' as uncertainty, not completion.".to_owned(),
        ];
        if let Some(note) = adapter.note {
            lines.push(note.to_owned());
        }
        if definition.edits == Some(false)
            && let Some(note) = adapter.read_only_note(definition.name == PROJECT_ROLE, fleet)
        {
            lines.push(note);
        }
        if let Some(result_file) = result_file {
            let report = result_file
                .parent()
                .unwrap_or(Path::new(""))
                .join(REPORT_FILE);
            lines.push(format!("Your result file is {}.", result_file.display()));
            lines.push(format!("Your report file is {}.", report.display()));
            if definition.edits == Some(false) {
                lines.push(if adapter.read_only_edits_result {
                    "You edit no file but your result file and your report file: write them with your file-editing tool, which is limited to their folder.".to_owned()
                } else {
                    "You edit no file, and your file-editing tools are off: write your result file and your report file with a shell command.".to_owned()
                });
            }
            lines.extend([
                "At the end of each turn, write your report file, replacing what it holds: one JSON object with \"state\": progress, waiting, ready, blocked, failed or dropped; \"summary\": one or two sentences; \"evidence\": a list of what you ran and what it showed; and \"human_action\": one concrete question for the person, only when the person must act.",
                "The states: progress, you are still at it and go on by yourself; waiting, your turn is done and you wait for a helper's result or a message; ready, the task is done and checked; blocked, you cannot go on without the person; failed, you tried and could not do it; dropped, there is nothing to do (it does not reproduce, or something else superseded it).",
                "The fleet takes your turn's outcome from your report file alone: a turn that ends without a valid one counts as no report, whatever your reply says.",
                "Also write a compact HANDOFF section to your result file, replacing what it holds, and end your reply with the same section: outcome, changed files, verification, unresolved questions. List every issue you can prove, not only the first.",
            ].map(str::to_owned));
        }
        if let Some(language) = language {
            lines.push(String::new());
            lines.push("## The person's language".to_owned());
            lines.push(format!("The person reads {language}. Write in {language} what the person reads: your replies to the person, a plan, a question for the person, a thread lead's HANDOFF and contract, and pull request titles and bodies. Write tasks and messages for other agents in English. Keep code, commands, paths, identifiers, quoted output and the status word PASS, ISSUES or BLOCKED as they are. Commit messages and code comments follow the repository's own conventions."));
        }
        if !standing.is_empty() {
            lines.extend([
                String::new(),
                "## Standing orders".to_owned(),
                "The person who runs this fleet gives these to every agent. Follow them in every turn. Every agent of the fleet gets them, so a task you hand on need not repeat them.".to_owned(),
                standing.to_owned(),
            ]);
        }
        lines.join("\n")
    }

    /// A spawn cancelled after its pane exists: the pane closes and the run stops (`abandonSpawn`).
    pub(crate) async fn abandon_spawn(&self, id: &str) {
        self.drop_pending(id);
        self.drop_undelivered(id);
        if let Some(run) = self.registry().get(id) {
            let _ = self.deps().runtime.close_pane(&run.pane_id).await;
        }
        let now = self.now();
        self.change(id, |run| {
            run.state = AgentState::Stopped;
            run.last_error = Some("Spawn cancelled.".to_owned());
            run.updated_at = now;
        });
    }

    /// Where a CLI that takes no instructions at launch keeps them until its first prompt.
    pub(crate) fn undelivered_file(&self, id: &str) -> PathBuf {
        self.deps().instructions_dir.join(format!("{id}.md"))
    }

    pub(crate) fn undelivered(&self, id: &str) -> Option<String> {
        fs::read_to_string(self.undelivered_file(id)).ok()
    }

    pub(crate) fn drop_undelivered(&self, id: &str) {
        let _ = fs::remove_file(self.undelivered_file(id));
    }
}

/// How many lines of a pane's screen the fleet reads (`recentReadLines`).
pub(crate) fn read_lines(config: &FleetConfig) -> u32 {
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a small positive count from the config"
    )]
    let lines = config.recent_read_lines.max(0.0) as u32;
    lines
}

#[cfg(test)]
mod tests {
    use super::{short_model, valid_group};

    #[test]
    fn names_a_model_by_its_last_part() {
        assert_eq!(short_model(None), "default");
        assert_eq!(short_model(Some("openai/gpt-5")), "gpt-5");
        assert_eq!(short_model(Some("haiku")), "haiku");
    }

    #[test]
    fn takes_a_group_of_letters_digits_dashes_and_underscores() {
        assert!(valid_group("g1"));
        assert!(valid_group("fleet-0a1b2c3d"));
        assert!(!valid_group("bad group"));
        assert!(!valid_group("-g"));
        assert!(!valid_group(&"g".repeat(49)));
        assert!(valid_group(&"g".repeat(48)));
    }
}
