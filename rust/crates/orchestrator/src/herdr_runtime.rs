//! `HerdrRuntime`, the [`AgentRuntime`] on herdr's socket API; from `server/fleet/runtime.ts`.
//! It is the one place that turns herdr's error codes into [`RuntimeError`] (ADR 0107-crate-split,
//! ADR 0242-phase-3-split), and the one that knows herdr's quirks at an agent's start:
//! `agent.start` answers at once (`launch_pending`), so readiness is `agent.get`'s
//! `interactive_ready`, polled here (CLAUDE.md, "Herdr の socket API の癖"). The interface:
//! docs/rust-migration/adr/0261-herdr-runtime.md.

use std::collections::BTreeMap;
use std::time::Duration;

use herdr::herdr_api::{
    self, AgentPromptParams, AgentReadParams, AgentSendKeysParams, AgentStartParams, AgentStatus,
    AgentTarget, PaneReadParams, PaneReportMetadataParams, PaneSplitParams, PaneTarget, ReadFormat,
    ReadSource, TabCreateParams, WorkspaceCreateParams, WorktreeCreateParams, methods,
};
use herdr::{Herdr, HerdrError};
use protocol::AgentState;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::runtime::{
    AgentMetadata, AgentRuntime, CreateLocationOptions, RuntimeError, RuntimeFuture,
    RuntimeLocation, SplitDirection, StartOptions,
};

/// How long an agent's start waits, and how often it looks (`START_TIMEOUT_MS`, `READY_POLL_MS`,
/// `FAILURE_POLL_MS` and the retry's `300 * (attempt + 1)` in `server/fleet/runtime.ts`). The
/// default is TypeScript's; tests pass shorter ones, since they run on the real clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartTimings {
    /// how long `start` waits for the agent to take input or stop at a question
    pub timeout: Duration,
    /// how often `agent.get` is asked whether the agent is ready
    pub ready_poll: Duration,
    /// how often the pane is looked at for an agent CLI that gave up at startup
    pub failure_poll: Duration,
    /// the wait before the n-th retry of a pane with no shell yet is n times this
    pub retry_step: Duration,
}

impl Default for StartTimings {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(30),
            ready_poll: Duration::from_millis(250),
            failure_poll: Duration::from_millis(500),
            retry_step: Duration::from_millis(300),
        }
    }
}

/// How many times `agent.start` is tried again on a pane that has not reached its shell yet.
const START_RETRIES: u32 = 4;
/// How many lines of the pane an agent's start reads for a CLI that gave up.
const STARTUP_SCREEN_LINES: u32 = 40;
/// The source the fleet reports a pane's metadata as.
const METADATA_SOURCE: &str = "herdr-fleet";

/// The runtime on herdr: each call is one request on a connection of its own (`Herdr`), so the
/// methods may run from several tasks at once.
#[derive(Debug, Clone)]
pub struct HerdrRuntime {
    herdr: Herdr,
    timings: StartTimings,
}

impl HerdrRuntime {
    /// The runtime on this herdr, with TypeScript's start timings.
    pub fn new(herdr: Herdr) -> Self {
        Self {
            herdr,
            timings: StartTimings::default(),
        }
    }

    /// The same runtime, whose agent starts wait and look as `timings` says.
    #[must_use]
    pub fn with_start_timings(self, timings: StartTimings) -> Self {
        Self { timings, ..self }
    }

    async fn locate(
        &self,
        options: CreateLocationOptions,
    ) -> Result<RuntimeLocation, RuntimeError> {
        let CreateLocationOptions {
            cwd,
            label,
            worktree,
            branch,
            path,
            direction,
            caller_pane_id,
            env,
        } = options;
        // an empty name is no name, as TypeScript's truthiness tests have it
        let given = |value: Option<String>| value.filter(|value| !value.is_empty());
        let (branch, path, caller_pane_id) = (given(branch), given(path), given(caller_pane_id));
        if worktree {
            let Some(branch) = branch else {
                return Err(internal("A worktree run needs a branch name."));
            };
            let created = self
                .herdr
                .call::<methods::WorktreeCreate>(WorktreeCreateParams {
                    base: None,
                    branch: Some(branch),
                    cwd: Some(cwd),
                    focus: Some(false),
                    label: Some(label),
                    path,
                    trust_repository: None,
                    workspace_id: None,
                })
                .await
                .map_err(runtime_error)?;
            let root = created.root_pane.pane_id;
            let cwd = created.worktree.path;
            // worktree.create takes no env: the agent gets a pane split off the root, which then
            // goes
            let split = self
                .split(&root, direction.unwrap_or(SplitDirection::Right), &cwd, env)
                .await?;
            self.close(&root).await?;
            return Ok(RuntimeLocation {
                pane_id: split.pane_id,
                workspace_id: Some(created.workspace.workspace_id),
                cwd,
            });
        }
        if let (Some(caller), Some(direction)) = (&caller_pane_id, direction) {
            let split = self.split(caller, direction, &cwd, env).await?;
            return Ok(RuntimeLocation {
                pane_id: split.pane_id,
                workspace_id: Some(split.workspace_id),
                cwd,
            });
        }
        if let Some(caller) = caller_pane_id {
            // a tab each: splitting the caller's pane again and again leaves every agent a sliver
            let workspace_id = self
                .herdr
                .call::<methods::PaneGet>(PaneTarget {
                    pane_id: caller.clone(),
                })
                .await
                .map_err(runtime_error)?
                .pane
                .workspace_id;
            if workspace_id.is_empty() {
                return Err(internal(&format!(
                    "herdr knows no workspace for pane {caller}."
                )));
            }
            let created = self
                .herdr
                .call::<methods::TabCreate>(TabCreateParams {
                    cwd: Some(cwd.clone()),
                    env: Some(env),
                    focus: Some(false),
                    label: Some(label),
                    workspace_id: Some(workspace_id.clone()),
                })
                .await
                .map_err(runtime_error)?;
            return Ok(RuntimeLocation {
                pane_id: created.root_pane.pane_id,
                workspace_id: Some(workspace_id),
                cwd,
            });
        }
        let created = self
            .herdr
            .call::<methods::WorkspaceCreate>(WorkspaceCreateParams {
                cwd: Some(cwd.clone()),
                env: Some(env),
                focus: Some(false),
                label: Some(label),
                source_workspace_id: None,
            })
            .await
            .map_err(runtime_error)?;
        Ok(RuntimeLocation {
            pane_id: created.root_pane.pane_id,
            workspace_id: Some(created.workspace.workspace_id),
            cwd,
        })
    }

    async fn split(
        &self,
        target: &str,
        direction: SplitDirection,
        cwd: &str,
        env: BTreeMap<String, String>,
    ) -> Result<herdr_api::PaneInfo, RuntimeError> {
        let direction = match direction {
            SplitDirection::Right => herdr_api::SplitDirection::Right,
            SplitDirection::Down => herdr_api::SplitDirection::Down,
        };
        let split = self
            .herdr
            .call::<methods::PaneSplit>(PaneSplitParams {
                cwd: Some(cwd.to_owned()),
                direction,
                env: Some(env),
                focus: Some(false),
                ratio: None,
                right_click: None,
                target_pane_id: Some(target.to_owned()),
                workspace_id: None,
            })
            .await
            .map_err(runtime_error)?;
        Ok(split.pane)
    }

    /// `pane.close`; its answer is not read, as TypeScript reads none.
    async fn close(&self, pane_id: &str) -> Result<(), RuntimeError> {
        self.herdr
            .rpc::<methods::PaneClose>(PaneTarget {
                pane_id: pane_id.to_owned(),
            })
            .await
            .map(drop)
            .map_err(runtime_error)
    }

    async fn launch(&self, options: StartOptions) -> Result<AgentState, RuntimeError> {
        let StartOptions {
            kind,
            name,
            pane_id,
            args,
            startup_error,
            cancel,
        } = options;
        // a freshly split pane takes a moment to reach its shell prompt; herdr refuses to start an
        // agent before
        let mut retries = 0;
        loop {
            if cancel.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            let started = self
                .herdr
                .rpc::<methods::AgentStart>(AgentStartParams {
                    args: Some(args.clone()),
                    kind: kind.name().to_owned(),
                    name: name.clone(),
                    pane_id: pane_id.clone(),
                    timeout_ms: None,
                })
                .await;
            match started {
                Ok(_) => break,
                Err(error) if retries < START_RETRIES && no_shell_yet(&error) => {
                    retries += 1;
                    pause(self.timings.retry_step * retries, &cancel).await?;
                }
                Err(error) => return Err(runtime_error(error)),
            }
        }
        // agent.start answers at once (launch_pending); readiness is ours to wait for, and a CLI
        // that prints an error and exits would otherwise keep us waiting the whole timeout
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(RuntimeError::Cancelled),
            ready = self.wait_ready(&name) => ready,
            message = self.watch_startup_failure(&pane_id, startup_error) => {
                Err(RuntimeError::StartFailed(message))
            }
        }
    }

    /// Asks `agent.get` until the agent takes input or stops at a question; a failed ask is asked
    /// again. The deadline is looked at before each ask, as TypeScript does, so an ask begun just
    /// before it still counts.
    async fn wait_ready(&self, name: &str) -> Result<AgentState, RuntimeError> {
        let deadline = Instant::now() + self.timings.timeout;
        while Instant::now() < deadline {
            let info = self
                .herdr
                .call::<methods::AgentGet>(AgentTarget {
                    target: name.to_owned(),
                })
                .await;
            if let Ok(info) = info {
                if info.agent.interactive_ready == Some(true) {
                    return Ok(agent_state(&info.agent.agent_status));
                }
                // a question before the first prompt (a trust dialog): the caller decides, never
                // the fleet
                if info.agent.agent_status == AgentStatus::Blocked {
                    return Ok(AgentState::Blocked);
                }
            }
            tokio::time::sleep(self.timings.ready_poll).await;
        }
        Err(RuntimeError::NotReady(format!(
            "{name} did not become ready within {}s",
            self.timings.timeout.as_secs_f64()
        )))
    }

    /// Looks at the pane until the agent CLI is gone from it and its screen shows why
    /// (`startup_error`): that message. Failed reads are looked at again.
    async fn watch_startup_failure(
        &self,
        pane_id: &str,
        startup_error: fn(&str) -> Option<String>,
    ) -> String {
        loop {
            tokio::time::sleep(self.timings.failure_poll).await;
            let pane = self
                .herdr
                .call::<methods::PaneGet>(PaneTarget {
                    pane_id: pane_id.to_owned(),
                })
                .await;
            let Ok(pane) = pane else { continue };
            if pane.pane.agent.is_some_and(|agent| !agent.is_empty()) {
                continue;
            }
            let screen = self
                .herdr
                .call::<methods::PaneRead>(PaneReadParams {
                    format: None,
                    lines: Some(STARTUP_SCREEN_LINES),
                    pane_id: pane_id.to_owned(),
                    source: ReadSource::Recent,
                    strip_ansi: None,
                })
                .await
                .map(|read| read.read.text)
                .unwrap_or_default();
            if let Some(message) = startup_error(&screen) {
                return message;
            }
        }
    }

    async fn agent_state(&self, name: &str) -> Result<AgentState, RuntimeError> {
        let info = self
            .herdr
            .call::<methods::AgentGet>(AgentTarget {
                target: name.to_owned(),
            })
            .await
            .map_err(runtime_error)?;
        Ok(agent_state(&info.agent.agent_status))
    }

    /// The live screen with its colors, for a draft in the input (dim placeholder or typed text).
    /// herdr's live-screen read gives text only, so this is the viewport, unless the pane is
    /// scrolled up into its history (a drag or the wheel in the web terminal): then the bottom of
    /// the output, as many lines as the viewport shows. Only a CLI on the normal screen keeps a
    /// history to scroll into; an alternate screen (Claude Code, opencode) never scrolls, and the
    /// output's bottom read does not show it.
    async fn live_screen(&self, name: &str) -> Result<String, RuntimeError> {
        // where the viewport sits only picks the read: a failed lookup reads the viewport
        let scroll = async {
            let agent = self
                .herdr
                .call::<methods::AgentGet>(AgentTarget {
                    target: name.to_owned(),
                })
                .await
                .ok()?
                .agent;
            if agent.pane_id.is_empty() {
                return None;
            }
            self.herdr
                .call::<methods::PaneGet>(PaneTarget {
                    pane_id: agent.pane_id,
                })
                .await
                .ok()?
                .pane
                .scroll
        }
        .await;
        let (source, lines) = match scroll {
            Some(scroll) if scroll.offset_from_bottom > 0 => (
                ReadSource::Recent,
                Some(u32::try_from(scroll.viewport_rows).unwrap_or(u32::MAX)),
            ),
            _ => (ReadSource::Visible, None),
        };
        let read = self
            .herdr
            .call::<methods::AgentRead>(AgentReadParams {
                format: Some(ReadFormat::Ansi),
                lines,
                source,
                strip_ansi: Some(false),
                target: name.to_owned(),
            })
            .await
            .map_err(runtime_error)?;
        Ok(read.read.text)
    }
}

impl AgentRuntime for HerdrRuntime {
    /// Herdr's state-changing calls run to their end: the token is looked at only before the
    /// first, and a pane made before a cancel is closed by the spawn that sees it next
    /// (`abandon_spawn`).
    fn create_location<'a>(
        &'a self,
        options: CreateLocationOptions,
        cancel: &'a CancellationToken,
    ) -> RuntimeFuture<'a, RuntimeLocation> {
        Box::pin(async move {
            if cancel.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            self.locate(options).await
        })
    }

    fn start(&self, options: StartOptions) -> RuntimeFuture<'_, AgentState> {
        Box::pin(self.launch(options))
    }

    fn close_pane<'a>(&'a self, pane_id: &'a str) -> RuntimeFuture<'a, ()> {
        Box::pin(self.close(pane_id))
    }

    /// `agent.prompt`, whose answer is not read: a prompt herdr took is never reported failed
    /// (and sent again) for the shape of its answer.
    fn prompt<'a>(
        &'a self,
        name: &'a str,
        text: &'a str,
        cancel: &'a CancellationToken,
    ) -> RuntimeFuture<'a, AgentState> {
        Box::pin(async move {
            if cancel.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            self.herdr
                .rpc::<methods::AgentPrompt>(AgentPromptParams {
                    target: name.to_owned(),
                    text: text.to_owned(),
                    wait: None,
                })
                .await
                .map_err(runtime_error)?;
            self.agent_state(name).await
        })
    }

    fn get<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, AgentState> {
        Box::pin(self.agent_state(name))
    }

    fn read<'a>(&'a self, name: &'a str, lines: u32) -> RuntimeFuture<'a, String> {
        Box::pin(async move {
            let read = self
                .herdr
                .call::<methods::AgentRead>(AgentReadParams {
                    format: None,
                    lines: Some(lines),
                    source: ReadSource::RecentUnwrapped,
                    strip_ansi: None,
                    target: name.to_owned(),
                })
                .await
                .map_err(runtime_error)?;
            Ok(read.read.text)
        })
    }

    fn screen<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, String> {
        Box::pin(self.live_screen(name))
    }

    fn interrupt<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, ()> {
        Box::pin(async move {
            self.herdr
                .rpc::<methods::AgentSendKeys>(AgentSendKeysParams {
                    keys: vec!["esc".to_owned()],
                    target: name.to_owned(),
                })
                .await
                .map(drop)
                .map_err(runtime_error)
        })
    }

    fn focus<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, ()> {
        Box::pin(async move {
            self.herdr
                .rpc::<methods::AgentFocus>(AgentTarget {
                    target: name.to_owned(),
                })
                .await
                .map(drop)
                .map_err(runtime_error)
        })
    }

    fn report_metadata(&self, metadata: AgentMetadata) -> RuntimeFuture<'_, ()> {
        Box::pin(async move {
            let AgentMetadata {
                pane_id,
                title,
                display_agent,
                tokens,
            } = metadata;
            self.herdr
                .rpc::<methods::PaneReportMetadata>(PaneReportMetadataParams {
                    agent: None,
                    applies_to_source: None,
                    clear_display_agent: None,
                    clear_state_labels: None,
                    clear_title: None,
                    display_agent: Some(display_agent),
                    pane_id,
                    seq: None,
                    source: METADATA_SOURCE.to_owned(),
                    state_labels: None,
                    title: Some(title),
                    tokens: Some(
                        tokens
                            .into_iter()
                            .map(|(key, value)| (key, Some(value)))
                            .collect(),
                    ),
                    ttl_ms: None,
                })
                .await
                .map(drop)
                .map_err(runtime_error)
        })
    }
}

/// What the orchestrator sees of a failed call to herdr. The one place herdr's codes are read
/// (ADR 0242-phase-3-split, "orchestrator の状態の持ち方"): `agent_blocked` and the three codes
/// of a missing agent or pane have a meaning of their own, any other code is kept as it is.
fn runtime_error(error: HerdrError) -> RuntimeError {
    match error.code() {
        "agent_blocked" => RuntimeError::Blocked,
        "agent_not_found" | "not_found" | "pane_not_found" => RuntimeError::NotFound,
        code => RuntimeError::Herdr {
            code: code.to_owned(),
            message: error.message().to_owned(),
        },
    }
}

/// A failure TypeScript throws as a plain `Error`, which `/api/fleet` answers as `internal_error`.
fn internal(message: &str) -> RuntimeError {
    RuntimeError::Herdr {
        code: "internal_error".to_owned(),
        message: message.to_owned(),
    }
}

/// herdr refused `agent.start` because the pane has not reached its shell yet (any failure whose
/// message says so, as TypeScript's `/not an available shell/i` on every `HerdrError`).
fn no_shell_yet(error: &HerdrError) -> bool {
    error
        .message()
        .to_lowercase()
        .contains("not an available shell")
}

/// herdr's status words as the fleet keeps them; anything else is unknown (`toAgentState`).
fn agent_state(status: &AgentStatus) -> AgentState {
    match status {
        AgentStatus::Working => AgentState::Working,
        AgentStatus::Idle => AgentState::Idle,
        AgentStatus::Done => AgentState::Done,
        AgentStatus::Blocked => AgentState::Blocked,
        AgentStatus::Unknown | AgentStatus::Other(_) => AgentState::Unknown,
    }
}

/// Waits `duration`, or until the token is cancelled.
async fn pause(duration: Duration, cancel: &CancellationToken) -> Result<(), RuntimeError> {
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(RuntimeError::Cancelled),
        () = tokio::time::sleep(duration) => Ok(()),
    }
}
