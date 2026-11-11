//! The `AgentRuntime` port and `RuntimeError`; from `server/fleet/runtime.ts`. What the
//! orchestrator asks of herdr: panes, agent starts, prompts and reads. The orchestrator sees no
//! herdr type and no herdr error code; `HerdrRuntime` (#261) turns herdr's codes into
//! [`RuntimeError`], and the tests stand in a fake (ADR 0242-phase-3-split, "orchestrator の状態の持ち方").

use std::collections::BTreeMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;

use protocol::{AgentState, FleetAgentKind};
use tokio_util::sync::CancellationToken;

/// What an [`AgentRuntime`] method returns: a boxed future, so the trait can be used as `dyn`.
pub type RuntimeFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, RuntimeError>> + Send + 'a>>;

/// Why the runtime could not do what it was asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeError {
    /// herdr refused because the agent waits on a question (`agent_blocked`).
    Blocked,
    /// herdr knows no such agent or pane (`agent_not_found`, `not_found`, `pane_not_found`).
    NotFound,
    /// The agent CLI quit while it started, with this message (`agent_start_failed`).
    StartFailed(String),
    /// The agent started but did not become ready for prompts in time (`agent_not_ready`).
    NotReady(String),
    /// The caller cancelled the operation (TypeScript's AbortError).
    Cancelled,
    /// Any other herdr error, with its code: `/api/fleet` answers it with the code, and the CLI
    /// prints `code: message`.
    Herdr { code: String, message: String },
}

impl RuntimeError {
    /// The code the API and the CLI name this error by (TypeScript's `FleetError.code`,
    /// `HerdrError.code`, or `aborted` for a cancel).
    pub fn code(&self) -> &str {
        match self {
            RuntimeError::Blocked => "agent_blocked",
            RuntimeError::NotFound => "agent_not_found",
            RuntimeError::StartFailed(_) => "agent_start_failed",
            RuntimeError::NotReady(_) => "agent_not_ready",
            RuntimeError::Cancelled => "aborted",
            RuntimeError::Herdr { code, .. } => code,
        }
    }
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RuntimeError::Blocked => f.write_str("The agent is blocked on a question."),
            RuntimeError::NotFound => f.write_str("herdr knows no such agent or pane."),
            RuntimeError::StartFailed(message)
            | RuntimeError::NotReady(message)
            | RuntimeError::Herdr { message, .. } => f.write_str(message),
            RuntimeError::Cancelled => f.write_str("The operation was aborted"),
        }
    }
}

impl std::error::Error for RuntimeError {}

/// Where a new agent runs: its pane, the pane's workspace, and the folder it starts in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeLocation {
    pub pane_id: String,
    pub workspace_id: Option<String>,
    pub cwd: String,
}

/// Which way the caller's pane is split for a new agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitDirection {
    Right,
    Down,
}

/// The pane to create for a new agent (`CreateLocationOptions`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateLocationOptions {
    pub cwd: String,
    pub label: String,
    pub worktree: bool,
    pub branch: Option<String>,
    /// where the worktree goes, absolute; herdr's `worktrees.directory` when absent
    pub path: Option<String>,
    /// split the caller's pane this way instead of opening a tab
    pub direction: Option<SplitDirection>,
    /// the caller's pane: the agent opens in a new tab of its workspace; without one, in a
    /// workspace of its own
    pub caller_pane_id: Option<String>,
    pub env: BTreeMap<String, String>,
}

/// What the pane shows about its agent (`AgentMetadata`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentMetadata {
    pub pane_id: String,
    pub title: String,
    pub display_agent: String,
    pub tokens: BTreeMap<String, String>,
}

/// An agent to start in a pane (`StartOptions`).
#[derive(Debug, Clone)]
pub struct StartOptions {
    pub kind: FleetAgentKind,
    pub name: String,
    pub pane_id: String,
    pub args: Vec<String>,
    /// a line the agent CLI prints when it gives up at startup (an unknown model): its message
    pub startup_error: fn(&str) -> Option<String>,
    pub cancel: CancellationToken,
}

/// What the orchestrator asks of herdr (`AgentRuntime`). Every method may be called from several
/// tasks at once.
pub trait AgentRuntime: Send + Sync + 'static {
    fn create_location<'a>(
        &'a self,
        options: CreateLocationOptions,
        cancel: &'a CancellationToken,
    ) -> RuntimeFuture<'a, RuntimeLocation>;
    /// starts the agent and resolves once it takes input (idle) or stops at a question first
    /// (blocked)
    fn start(&self, options: StartOptions) -> RuntimeFuture<'_, AgentState>;
    fn close_pane<'a>(&'a self, pane_id: &'a str) -> RuntimeFuture<'a, ()>;
    fn prompt<'a>(
        &'a self,
        name: &'a str,
        text: &'a str,
        cancel: &'a CancellationToken,
    ) -> RuntimeFuture<'a, AgentState>;
    fn get<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, AgentState>;
    fn read<'a>(&'a self, name: &'a str, lines: u32) -> RuntimeFuture<'a, String>;
    /// what the pane shows now, with its colors
    fn screen<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, String>;
    fn interrupt<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, ()>;
    fn focus<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, ()>;
    fn report_metadata(&self, metadata: AgentMetadata) -> RuntimeFuture<'_, ()>;
}
