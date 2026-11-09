//! GENERATED FILE - DO NOT EDIT.
//!
//! Source: herdr API schema `scripts/herdr-schema.json`, protocol 22, schema_version 1.
//! Regenerate with: HERDR_API_UPDATE=1 cargo test -p herdr-fleet-herdr-api --test generated
//! How each shape is mapped: docs/rust-migration/adr/0245-herdr-api-generation.md
//!
//! Fields and types of any JSON value (`serde_json::Value`):
//! - `ResponseResultAgentExplain.explain`: the schema allows any value

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session: Option<AgentSessionInfo>,
    pub agent_status: AgentStatus,
    /// The current idle transition completed work, independently of who has viewed it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_agent: Option<String>,
    pub focused: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground_cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interactive_ready: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_pending: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub pane_id: String,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_detection_skipped: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_change_seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_labels: Option<BTreeMap<String, String>>,
    pub tab_id: String,
    pub terminal_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_title_stripped: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<BTreeMap<String, String>>,
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentManifestInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_version: Option<String>,
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_remote_version: Option<String>,
    pub local_override_shadowing_remote: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_last_checked_unix: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_update_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_update_result: Option<String>,
    pub source: String,
    pub source_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentPromptParams {
    pub target: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<AgentPromptWaitOptions>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentPromptWaitOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<Vec<AgentStatus>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<ReadFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<u32>,
    pub source: ReadSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strip_ansi: Option<bool>,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentRenameParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentSendKeysParams {
    pub keys: Vec<String>,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentSessionInfo {
    pub agent: String,
    pub kind: AgentSessionRefKind,
    pub source: String,
    pub value: String,
}

open_enum! {
    AgentSessionRefKind {
        Id = "id",
        Path = "path",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentStartParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    pub kind: String,
    pub name: String,
    pub pane_id: String,
    /// Startup timeout in milliseconds. Values must be greater than 3000 and at most 300000.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

open_enum! {
    AgentStatus {
        Blocked = "blocked",
        Done = "done",
        Idle = "idle",
        Unknown = "unknown",
        Working = "working",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentTarget {
    pub target: String,
}

open_enum! {
    AgentViewBuiltinField {
        Agent = "agent",
        PaneId = "pane_id",
        Seen = "seen",
        StateChangeSeq = "state_change_seq",
        Status = "status",
        TabId = "tab_id",
        WorkspaceId = "workspace_id",
    }
}

open_enum! {
    AgentViewBuiltinSortField {
        Agent = "agent",
        Attention = "attention",
        PaneOrder = "pane_order",
        Seen = "seen",
        StateChangeSeq = "state_change_seq",
        Status = "status",
        TabOrder = "tab_order",
        WorkspaceOrder = "workspace_order",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentViewClearParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

open_enum! {
    AgentViewContext {
        CurrentTabId = "current_tab_id",
        CurrentWorkspaceId = "current_workspace_id",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentViewField {
    AgentViewBuiltinField(AgentViewBuiltinField),
    Token(AgentViewFieldToken),
}

/// A shape of [`AgentViewField`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentViewFieldToken {
    pub token: String,
}

tagged_union! {
    AgentViewFilter, "op",
    unit {
    }
    payload {
        All(AgentViewFilterAll) = "all",
        Any(AgentViewFilterAny) = "any",
        Eq(AgentViewFilterEq) = "eq",
        Exists(AgentViewFilterExists) = "exists",
        In(AgentViewFilterIn) = "in",
        Not(AgentViewFilterNot) = "not",
    }
}

/// The fields of [`AgentViewFilter::All`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentViewFilterAll {
    pub filters: Vec<AgentViewFilter>,
}

/// The fields of [`AgentViewFilter::Any`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentViewFilterAny {
    pub filters: Vec<AgentViewFilter>,
}

/// The fields of [`AgentViewFilter::Eq`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentViewFilterEq {
    pub field: AgentViewField,
    pub value: AgentViewValue,
}

/// The fields of [`AgentViewFilter::Exists`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentViewFilterExists {
    pub field: AgentViewField,
}

/// The fields of [`AgentViewFilter::In`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentViewFilterIn {
    pub field: AgentViewField,
    pub values: Vec<AgentViewValue>,
}

/// The fields of [`AgentViewFilter::Not`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentViewFilterNot {
    pub filter: Box<AgentViewFilter>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentViewSetParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<AgentViewFilter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort: Option<Vec<AgentViewSort>>,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentViewSort {
    pub field: AgentViewSortField,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<AgentViewSortOrder>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentViewSortField {
    AgentViewBuiltinSortField(AgentViewBuiltinSortField),
    Token(AgentViewSortFieldToken),
}

/// A shape of [`AgentViewSortField`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentViewSortFieldToken {
    pub token: String,
}

open_enum! {
    AgentViewSortOrder {
        Asc = "asc",
        Desc = "desc",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentViewValue {
    String(String),
    Bool(bool),
    Integer(u64),
    Context(AgentViewValueContext),
}

/// A shape of [`AgentViewValue`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentViewValueContext {
    pub context: AgentViewContext,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentWaitParams {
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<Vec<AgentStatus>>,
}

/// Updates whether the requesting client shell receives and controls pane presentation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClientShellSurfaceSetParams {
    pub active: bool,
}

open_enum! {
    ClientWindowTitleReason {
        Cleared = "cleared",
        NoForegroundClient = "no_foreground_client",
        Set = "set",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClientWindowTitleSetParams {
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandInvokeParams {
    /// Opaque endpoint-issued command identifier from the client-shell projection.
    pub command_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    /// Client-owned selection coordinates, validated against the pane's content revision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<PaneSelectionReadParams>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

open_enum! {
    ConfigReloadStatus {
        Applied = "applied",
        Failed = "failed",
        Partial = "partial",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EmptyParams {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: ErrorBody,
    pub id: String,
}

tagged_union! {
    EventData, "type",
    unit {
    }
    payload {
        LayoutUpdated(EventDataLayoutUpdated) = "layout_updated",
        PaneAgentDetected(EventDataPaneAgentDetected) = "pane_agent_detected",
        PaneAgentStatusChanged(EventDataPaneAgentStatusChanged) = "pane_agent_status_changed",
        PaneClosed(EventDataPaneClosed) = "pane_closed",
        PaneCreated(EventDataPaneCreated) = "pane_created",
        PaneExited(EventDataPaneExited) = "pane_exited",
        PaneFocused(EventDataPaneFocused) = "pane_focused",
        PaneMoved(EventDataPaneMoved) = "pane_moved",
        PaneOutputChanged(EventDataPaneOutputChanged) = "pane_output_changed",
        PaneUpdated(EventDataPaneUpdated) = "pane_updated",
        TabClosed(EventDataTabClosed) = "tab_closed",
        TabCreated(EventDataTabCreated) = "tab_created",
        TabFocused(EventDataTabFocused) = "tab_focused",
        TabMoved(EventDataTabMoved) = "tab_moved",
        TabRenamed(EventDataTabRenamed) = "tab_renamed",
        WorkspaceClosed(EventDataWorkspaceClosed) = "workspace_closed",
        WorkspaceCreated(EventDataWorkspaceCreated) = "workspace_created",
        WorkspaceFocused(EventDataWorkspaceFocused) = "workspace_focused",
        WorkspaceMetadataUpdated(EventDataWorkspaceMetadataUpdated) = "workspace_metadata_updated",
        WorkspaceMoved(EventDataWorkspaceMoved) = "workspace_moved",
        WorkspaceRenamed(EventDataWorkspaceRenamed) = "workspace_renamed",
        WorkspaceReordered(EventDataWorkspaceReordered) = "workspace_reordered",
        WorkspaceUpdated(EventDataWorkspaceUpdated) = "workspace_updated",
        WorktreeCreated(EventDataWorktreeCreated) = "worktree_created",
        WorktreeOpened(EventDataWorktreeOpened) = "worktree_opened",
        WorktreeRemoved(EventDataWorktreeRemoved) = "worktree_removed",
    }
}

/// The fields of [`EventData::LayoutUpdated`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataLayoutUpdated {
    pub layout: PaneLayoutSnapshot,
}

/// The fields of [`EventData::PaneAgentDetected`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataPaneAgentDetected {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_status: Option<AgentStatus>,
    pub pane_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released: Option<bool>,
    pub workspace_id: String,
}

/// The fields of [`EventData::PaneAgentStatusChanged`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataPaneAgentStatusChanged {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub agent_status: AgentStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_agent: Option<String>,
    pub pane_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_labels: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub workspace_id: String,
}

/// The fields of [`EventData::PaneClosed`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataPaneClosed {
    pub pane_id: String,
    pub workspace_id: String,
}

/// The fields of [`EventData::PaneCreated`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataPaneCreated {
    pub pane: PaneInfo,
}

/// The fields of [`EventData::PaneExited`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataPaneExited {
    pub pane_id: String,
    pub workspace_id: String,
}

/// The fields of [`EventData::PaneFocused`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataPaneFocused {
    pub pane_id: String,
    pub workspace_id: String,
}

/// The fields of [`EventData::PaneMoved`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataPaneMoved {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_tab: Option<TabInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_workspace: Option<WorkspaceInfo>,
    pub pane: PaneInfo,
    pub previous_pane_id: String,
    pub previous_tab_id: String,
    pub previous_workspace_id: String,
}

/// The fields of [`EventData::PaneOutputChanged`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataPaneOutputChanged {
    pub pane_id: String,
    pub revision: u64,
    pub workspace_id: String,
}

/// The fields of [`EventData::PaneUpdated`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataPaneUpdated {
    pub pane: PaneInfo,
}

/// The fields of [`EventData::TabClosed`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataTabClosed {
    pub tab_id: String,
    pub workspace_id: String,
}

/// The fields of [`EventData::TabCreated`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataTabCreated {
    pub tab: TabInfo,
}

/// The fields of [`EventData::TabFocused`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataTabFocused {
    pub tab_id: String,
    pub workspace_id: String,
}

/// The fields of [`EventData::TabMoved`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataTabMoved {
    pub insert_index: u64,
    pub tab_id: String,
    pub tabs: Vec<TabInfo>,
    pub workspace_id: String,
}

/// The fields of [`EventData::TabRenamed`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataTabRenamed {
    pub label: String,
    pub tab_id: String,
    pub workspace_id: String,
}

/// The fields of [`EventData::WorkspaceClosed`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataWorkspaceClosed {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<WorkspaceInfo>,
    pub workspace_id: String,
}

/// The fields of [`EventData::WorkspaceCreated`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataWorkspaceCreated {
    pub workspace: WorkspaceInfo,
}

/// The fields of [`EventData::WorkspaceFocused`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataWorkspaceFocused {
    pub workspace_id: String,
}

/// The fields of [`EventData::WorkspaceMetadataUpdated`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataWorkspaceMetadataUpdated {
    pub workspace: WorkspaceInfo,
}

/// The fields of [`EventData::WorkspaceMoved`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataWorkspaceMoved {
    pub insert_index: u64,
    pub workspace_id: String,
    pub workspaces: Vec<WorkspaceInfo>,
}

/// The fields of [`EventData::WorkspaceRenamed`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataWorkspaceRenamed {
    pub label: String,
    pub workspace_id: String,
}

/// The fields of [`EventData::WorkspaceReordered`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataWorkspaceReordered {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_workspace_id: Option<String>,
    pub workspace_ids: Vec<String>,
    pub workspaces: Vec<WorkspaceInfo>,
}

/// The fields of [`EventData::WorkspaceUpdated`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataWorkspaceUpdated {
    pub workspace: WorkspaceInfo,
}

/// The fields of [`EventData::WorktreeCreated`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataWorktreeCreated {
    pub workspace: WorkspaceInfo,
    pub worktree: WorktreeInfo,
}

/// The fields of [`EventData::WorktreeOpened`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataWorktreeOpened {
    pub already_open: bool,
    pub workspace: WorkspaceInfo,
    pub worktree: WorktreeInfo,
}

/// The fields of [`EventData::WorktreeRemoved`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventDataWorktreeRemoved {
    pub forced: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<WorkspaceInfo>,
    pub workspace_id: String,
    pub worktree: WorktreeInfo,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub data: EventData,
    pub event: EventKind,
}

open_enum! {
    EventKind {
        LayoutUpdated = "layout_updated",
        PaneAgentDetected = "pane_agent_detected",
        PaneAgentStatusChanged = "pane_agent_status_changed",
        PaneClosed = "pane_closed",
        PaneCreated = "pane_created",
        PaneExited = "pane_exited",
        PaneFocused = "pane_focused",
        PaneMoved = "pane_moved",
        PaneOutputChanged = "pane_output_changed",
        PaneUpdated = "pane_updated",
        TabClosed = "tab_closed",
        TabCreated = "tab_created",
        TabFocused = "tab_focused",
        TabMoved = "tab_moved",
        TabRenamed = "tab_renamed",
        WorkspaceClosed = "workspace_closed",
        WorkspaceCreated = "workspace_created",
        WorkspaceFocused = "workspace_focused",
        WorkspaceMetadataUpdated = "workspace_metadata_updated",
        WorkspaceMoved = "workspace_moved",
        WorkspaceRenamed = "workspace_renamed",
        WorkspaceReordered = "workspace_reordered",
        WorkspaceUpdated = "workspace_updated",
        WorktreeCreated = "worktree_created",
        WorktreeOpened = "worktree_opened",
        WorktreeRemoved = "worktree_removed",
    }
}

tagged_union! {
    EventMatch, "event",
    unit {
    }
    payload {
        PaneAgentDetected(EventMatchPaneAgentDetected) = "pane_agent_detected",
        PaneAgentStatusChanged(EventMatchPaneAgentStatusChanged) = "pane_agent_status_changed",
        PaneClosed(EventMatchPaneClosed) = "pane_closed",
        PaneCreated(EventMatchPaneCreated) = "pane_created",
        PaneExited(EventMatchPaneExited) = "pane_exited",
        PaneFocused(EventMatchPaneFocused) = "pane_focused",
        PaneMoved(EventMatchPaneMoved) = "pane_moved",
        PaneOutputChanged(EventMatchPaneOutputChanged) = "pane_output_changed",
        TabClosed(EventMatchTabClosed) = "tab_closed",
        TabCreated(EventMatchTabCreated) = "tab_created",
        TabFocused(EventMatchTabFocused) = "tab_focused",
        TabMoved(EventMatchTabMoved) = "tab_moved",
        TabRenamed(EventMatchTabRenamed) = "tab_renamed",
        WorkspaceClosed(EventMatchWorkspaceClosed) = "workspace_closed",
        WorkspaceCreated(EventMatchWorkspaceCreated) = "workspace_created",
        WorkspaceFocused(EventMatchWorkspaceFocused) = "workspace_focused",
        WorkspaceMoved(EventMatchWorkspaceMoved) = "workspace_moved",
        WorkspaceRenamed(EventMatchWorkspaceRenamed) = "workspace_renamed",
        WorkspaceUpdated(EventMatchWorkspaceUpdated) = "workspace_updated",
    }
}

/// The fields of [`EventMatch::PaneAgentDetected`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventMatchPaneAgentDetected {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub pane_id: String,
}

/// The fields of [`EventMatch::PaneAgentStatusChanged`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventMatchPaneAgentStatusChanged {
    pub agent_status: AgentStatus,
    pub pane_id: String,
}

/// The fields of [`EventMatch::PaneClosed`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventMatchPaneClosed {
    pub pane_id: String,
}

/// The fields of [`EventMatch::PaneCreated`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventMatchPaneCreated {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

/// The fields of [`EventMatch::PaneExited`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventMatchPaneExited {
    pub pane_id: String,
}

/// The fields of [`EventMatch::PaneFocused`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventMatchPaneFocused {
    pub pane_id: String,
}

/// The fields of [`EventMatch::PaneMoved`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventMatchPaneMoved {
    pub pane_id: String,
}

/// The fields of [`EventMatch::PaneOutputChanged`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventMatchPaneOutputChanged {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_revision: Option<u64>,
    pub pane_id: String,
}

/// The fields of [`EventMatch::TabClosed`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventMatchTabClosed {
    pub tab_id: String,
}

/// The fields of [`EventMatch::TabCreated`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventMatchTabCreated {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

/// The fields of [`EventMatch::TabFocused`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventMatchTabFocused {
    pub tab_id: String,
}

/// The fields of [`EventMatch::TabMoved`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventMatchTabMoved {
    pub tab_id: String,
}

/// The fields of [`EventMatch::TabRenamed`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventMatchTabRenamed {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub tab_id: String,
}

/// The fields of [`EventMatch::WorkspaceClosed`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventMatchWorkspaceClosed {
    pub workspace_id: String,
}

/// The fields of [`EventMatch::WorkspaceCreated`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventMatchWorkspaceCreated {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

/// The fields of [`EventMatch::WorkspaceFocused`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventMatchWorkspaceFocused {
    pub workspace_id: String,
}

/// The fields of [`EventMatch::WorkspaceMoved`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventMatchWorkspaceMoved {
    pub workspace_id: String,
}

/// The fields of [`EventMatch::WorkspaceRenamed`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventMatchWorkspaceRenamed {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub workspace_id: String,
}

/// The fields of [`EventMatch::WorkspaceUpdated`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventMatchWorkspaceUpdated {
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventsSubscribeParams {
    pub subscriptions: Vec<Subscription>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventsWaitParams {
    pub match_event: EventMatch,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InstalledPluginInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<PluginManifestAction>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<Vec<PluginManifestBuild>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<PluginManifestEventHook>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_handlers: Option<Vec<PluginManifestLinkHandler>>,
    pub manifest_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_herdr_version: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panes: Option<Vec<PluginManifestPane>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<PluginPlatform>>,
    pub plugin_id: String,
    pub plugin_root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<PluginSourceInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup: Option<Vec<PluginManifestStartup>>,
    pub version: String,
    /// Warnings collected at link time or on registry load (e.g. unknown event names,
    /// missing manifest file). Non-fatal — the entry is kept and surfaced by plugin.list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IntegrationInfo {
    pub available: bool,
    pub command: String,
    pub label: String,
    pub state: IntegrationState,
    pub target: IntegrationTarget,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IntegrationInstallParams {
    pub target: IntegrationTarget,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IntegrationInstallResult {
    pub messages: Vec<String>,
}

open_enum! {
    IntegrationState {
        Current = "current",
        NotInstalled = "not_installed",
        Outdated = "outdated",
    }
}

open_enum! {
    IntegrationTarget {
        AntigravityCli = "antigravity_cli",
        Claude = "claude",
        Codex = "codex",
        Copilot = "copilot",
        Cursor = "cursor",
        Devin = "devin",
        Droid = "droid",
        Grok = "grok",
        Hermes = "hermes",
        Kilo = "kilo",
        Kimi = "kimi",
        Mastracode = "mastracode",
        Omp = "omp",
        Opencode = "opencode",
        Pi = "pi",
        Qodercli = "qodercli",
        Qwen = "qwen",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IntegrationUninstallParams {
    pub target: IntegrationTarget,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IntegrationUninstallResult {
    pub messages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayoutApplyParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<bool>,
    pub root: LayoutNode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayoutDescription {
    pub focused_pane_id: String,
    pub root: LayoutNode,
    pub tab_id: String,
    pub workspace_id: String,
    pub zoomed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayoutExportParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
}

tagged_union! {
    LayoutNode, "type",
    unit {
    }
    payload {
        Pane(LayoutNodePane) = "pane",
        Split(LayoutNodeSplit) = "split",
    }
}

/// The fields of [`LayoutNode::Pane`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayoutNodePane {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
}

/// The fields of [`LayoutNode::Split`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayoutNodeSplit {
    pub direction: SplitDirection,
    pub first: Box<LayoutNode>,
    pub ratio: f64,
    pub second: Box<LayoutNode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayoutSetSplitRatioParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    pub path: Vec<bool>,
    pub ratio: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NotificationShowParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<ToastHerdrPosition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sound: Option<NotificationShowSound>,
    pub title: String,
}

open_enum! {
    NotificationShowReason {
        Busy = "busy",
        Disabled = "disabled",
        NoForegroundClient = "no_foreground_client",
        RateLimited = "rate_limited",
        Shown = "shown",
    }
}

open_enum! {
    NotificationShowSound {
        Done = "done",
        None = "none",
        Request = "request",
    }
}

tagged_union! {
    OutputMatch, "type",
    unit {
    }
    payload {
        Regex(OutputMatchRegex) = "regex",
        Substring(OutputMatchSubstring) = "substring",
    }
}

/// The fields of [`OutputMatch::Regex`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutputMatchRegex {
    pub value: String,
}

/// The fields of [`OutputMatch::Substring`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutputMatchSubstring {
    pub value: String,
}

open_enum! {
    PaneAgentState {
        Blocked = "blocked",
        Idle = "idle",
        Unknown = "unknown",
        Working = "working",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneAgentStatusChangedEvent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub agent_status: AgentStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_agent: Option<String>,
    pub pane_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_labels: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneClearAgentAuthorityParams {
    pub pane_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

open_enum! {
    PaneCopyMotion {
        FirstNonBlank = "first_non_blank",
        LineEnd = "line_end",
        NextBigWordEnd = "next_big_word_end",
        NextBigWordStart = "next_big_word_start",
        NextParagraph = "next_paragraph",
        NextWordEnd = "next_word_end",
        NextWordStart = "next_word_start",
        PreviousBigWordStart = "previous_big_word_start",
        PreviousParagraph = "previous_paragraph",
        PreviousWordStart = "previous_word_start",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneCopyMotionParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_revision: Option<u64>,
    pub cursor: PaneTextPoint,
    pub motion: PaneCopyMotion,
    pub pane_id: String,
}

open_enum! {
    PaneCopySearchDirection {
        Backward = "backward",
        Forward = "forward",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneCopySearchParams {
    pub content_revision: u64,
    pub cursor: PaneTextPoint,
    pub direction: PaneCopySearchDirection,
    pub pane_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<PaneTextRange>,
    pub query: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneCurrentParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller_pane_id: Option<String>,
}

open_enum! {
    PaneDirection {
        Down = "down",
        Left = "left",
        Right = "right",
        Up = "up",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneEdgesParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneEdgesResult {
    pub down: bool,
    pub layout: PaneLayoutSnapshot,
    pub left: bool,
    pub pane_id: String,
    pub right: bool,
    pub up: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneFocusDirectionParams {
    pub direction: PaneDirection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
}

open_enum! {
    PaneFocusDirectionReason {
        NoNeighbor = "no_neighbor",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneFocusDirectionResult {
    pub changed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_pane_id: Option<String>,
    pub layout: PaneLayoutSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<PaneFocusDirectionReason>,
    pub source_pane_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session: Option<AgentSessionInfo>,
    pub agent_status: AgentStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_agent: Option<String>,
    pub focused: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground_cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub pane_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_error: Option<String>,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scroll: Option<PaneScrollInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_labels: Option<BTreeMap<String, String>>,
    pub tab_id: String,
    pub terminal_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_title_stripped: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<BTreeMap<String, String>>,
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneInputSetParams {
    pub pane_id: String,
    pub right_click: PaneRightClickTarget,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneLayoutPane {
    pub focused: bool,
    pub pane_id: String,
    pub rect: PaneLayoutRect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneLayoutParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneLayoutRect {
    pub height: u16,
    pub width: u16,
    pub x: u16,
    pub y: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneLayoutSnapshot {
    pub area: PaneLayoutRect,
    pub focused_pane_id: String,
    pub panes: Vec<PaneLayoutPane>,
    pub splits: Vec<PaneLayoutSplit>,
    pub tab_id: String,
    pub workspace_id: String,
    pub zoomed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneLayoutSplit {
    pub direction: SplitDirection,
    pub id: String,
    pub ratio: f64,
    pub rect: PaneLayoutRect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneLinkActivateParams {
    pub col: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset_from_bottom: Option<u64>,
    pub pane_id: String,
    pub viewport_row: u16,
}

/// Inclusive display-cell columns on a pane's current viewport.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneLinkRegion {
    pub end_col: u16,
    pub row: u16,
    pub start_col: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

tagged_union! {
    PaneMoveDestination, "type",
    unit {
    }
    payload {
        NewTab(PaneMoveDestinationNewTab) = "new_tab",
        NewWorkspace(PaneMoveDestinationNewWorkspace) = "new_workspace",
        Tab(PaneMoveDestinationTab) = "tab",
    }
}

/// The fields of [`PaneMoveDestination::NewTab`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneMoveDestinationNewTab {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

/// The fields of [`PaneMoveDestination::NewWorkspace`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneMoveDestinationNewWorkspace {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_label: Option<String>,
}

/// The fields of [`PaneMoveDestination::Tab`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneMoveDestinationTab {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ratio: Option<f64>,
    pub split: SplitDirection,
    pub tab_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_pane_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneMoveParams {
    pub destination: PaneMoveDestination,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<bool>,
    pub pane_id: String,
}

open_enum! {
    PaneMoveReason {
        SameTab = "same_tab",
        ZoomedTab = "zoomed_tab",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneMoveResult {
    pub changed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_tab: Option<TabInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_workspace: Option<WorkspaceInfo>,
    pub focused_pane_id: String,
    pub pane: PaneInfo,
    pub previous_pane_id: String,
    pub previous_tab_id: String,
    pub previous_workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<PaneMoveReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_layout: Option<PaneLayoutSnapshot>,
    pub target_layout: PaneLayoutSnapshot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneNeighborParams {
    pub direction: PaneDirection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneNeighborResult {
    pub direction: PaneDirection,
    pub layout: PaneLayoutSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub neighbor_pane_id: Option<String>,
    pub pane_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneOutputMatchedEvent {
    pub matched_line: String,
    pub pane_id: String,
    pub read: PaneReadResult,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneProcessInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground_process_group_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground_processes: Option<Vec<PaneProcessInfoProcess>>,
    pub pane_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tty: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneProcessInfoParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneProcessInfoProcess {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argv: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argv0: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cmdline: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub name: String,
    pub pid: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<ReadFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<u32>,
    pub pane_id: String,
    pub source: ReadSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strip_ansi: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneReadResult {
    pub format: ReadFormat,
    pub pane_id: String,
    pub revision: u64,
    pub source: ReadSource,
    pub tab_id: String,
    pub text: String,
    pub truncated: bool,
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneReleaseAgentParams {
    pub agent: String,
    pub pane_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneRenameParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub pane_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneReportAgentParams {
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub pane_id: String,
    /// Command that resumes this agent's session after a Herdr restart. The
    /// first element must be a plain command name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_argv: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    pub source: String,
    pub state: PaneAgentState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneReportAgentSessionParams {
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_path: Option<String>,
    pub pane_id: String,
    /// Command that resumes this agent's session after a Herdr restart. The
    /// first element must be a plain command name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_argv: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_start_source: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneReportMetadataParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applies_to_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear_display_agent: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear_state_labels: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear_title: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_agent: Option<String>,
    pub pane_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_labels: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<BTreeMap<String, Option<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneResizeParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<f64>,
    pub direction: PaneDirection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
}

open_enum! {
    PaneResizeReason {
        Unchanged = "unchanged",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneResizeResult {
    pub changed: bool,
    pub focused_pane_id: String,
    pub layout: PaneLayoutSnapshot,
    pub pane_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<PaneResizeReason>,
}

open_enum! {
    PaneRightClickTarget {
        Herdr = "herdr",
        Pane = "pane",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneScrollChangedEvent {
    pub pane_id: String,
    pub scroll: PaneScrollInfo,
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneScrollInfo {
    pub max_offset_from_bottom: u64,
    pub offset_from_bottom: u64,
    pub viewport_rows: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneScrollParams {
    pub offset_from_bottom: u64,
    pub pane_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneSelectionReadParams {
    pub anchor: PaneTextPoint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_revision: Option<u64>,
    pub cursor: PaneTextPoint,
    pub pane_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneSendInputParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys: Option<Vec<String>>,
    pub pane_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneSendKeysParams {
    pub keys: Vec<String>,
    pub pane_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneSendTextParams {
    pub pane_id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneSplitParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub direction: SplitDirection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ratio: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right_click: Option<PaneRightClickTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneSwapParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<PaneDirection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_pane_id: Option<String>,
}

open_enum! {
    PaneSwapReason {
        CrossTab = "cross_tab",
        NoNeighbor = "no_neighbor",
        NotFound = "not_found",
        SamePane = "same_pane",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneSwapResult {
    pub changed: bool,
    pub focused_pane_id: String,
    pub layout: PaneLayoutSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<PaneSwapReason>,
    pub source_pane_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_pane_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneTarget {
    pub pane_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneTextPoint {
    pub col: u16,
    pub row: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneTextRange {
    pub end: PaneTextPoint,
    pub start: PaneTextPoint,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneWaitForOutputParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<u32>,
    pub r#match: OutputMatch,
    pub pane_id: String,
    pub source: ReadSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strip_ansi: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

open_enum! {
    PaneZoomMode {
        Off = "off",
        On = "on",
        Toggle = "toggle",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneZoomParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<PaneZoomMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
}

open_enum! {
    PaneZoomReason {
        AlreadyUnzoomed = "already_unzoomed",
        AlreadyZoomed = "already_zoomed",
        SinglePane = "single_pane",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneZoomResult {
    pub changed: bool,
    pub focus_changed: bool,
    pub focused_pane_id: String,
    pub layout: PaneLayoutSnapshot,
    pub pane_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<PaneZoomReason>,
    pub zoom_changed: bool,
    pub zoomed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PingParams {}

open_enum! {
    PluginActionContext {
        Global = "global",
        Pane = "pane",
        Selection = "selection",
        Tab = "tab",
        Workspace = "workspace",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginActionInfo {
    pub action_id: String,
    pub command: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contexts: Option<Vec<PluginActionContext>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<PluginPlatform>>,
    pub plugin_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginActionInvokeParams {
    pub action_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<PluginInvocationContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginActionListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginCommandLogInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    pub command: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_unix_ms: Option<u64>,
    pub log_id: String,
    pub plugin_id: String,
    pub started_unix_ms: u64,
    pub status: PluginCommandStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
}

open_enum! {
    PluginCommandStatus {
        Failed = "failed",
        Running = "running",
        Succeeded = "succeeded",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginInvocationContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clicked_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_pane_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_pane_cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_pane_status: Option<AgentStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invocation_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_handler_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorkspaceWorktreeInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginLinkParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<PluginSourceInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginLogListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginManifestAction {
    pub command: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contexts: Option<Vec<PluginActionContext>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<PluginPlatform>>,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginManifestBuild {
    pub command: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<PluginPlatform>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginManifestEventHook {
    pub command: Vec<String>,
    pub on: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<PluginPlatform>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginManifestLinkHandler {
    pub action: String,
    pub id: String,
    pub pattern: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<PluginPlatform>>,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginManifestPane {
    pub command: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<PopupSize>,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement: Option<PluginPanePlacement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<PluginPlatform>>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<PopupSize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginManifestStartup {
    pub command: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<PluginPlatform>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginPaneCloseParams {
    pub pane_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginPaneFocusParams {
    pub pane_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginPaneInfo {
    pub entrypoint: String,
    pub pane: PaneInfo,
    pub plugin_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginPaneOpenParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<SplitDirection>,
    pub entrypoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<PopupSize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement: Option<PluginPanePlacement>,
    pub plugin_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<PopupSize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

open_enum! {
    PluginPanePlacement {
        Overlay = "overlay",
        Popup = "popup",
        Split = "split",
        Tab = "tab",
        Zoomed = "zoomed",
    }
}

open_enum! {
    PluginPlatform {
        Linux = "linux",
        Macos = "macos",
        Windows = "windows",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginSetEnabledParams {
    pub plugin_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginSourceInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_unix_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<PluginSourceKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subdir: Option<String>,
}

open_enum! {
    PluginSourceKind {
        Github = "github",
        Local = "local",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginUnlinkParams {
    pub plugin_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PopupSize {
    /// Outer popup size in terminal cells, including the border.
    Integer(i64),
    /// Outer popup size as a percentage of the terminal area, for example 80%.
    String(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProductAnnouncementDismissParams {
    pub id: String,
    pub version: String,
}

open_enum! {
    ReadFormat {
        Ansi = "ansi",
        Text = "text",
    }
}

open_enum! {
    ReadSource {
        Detection = "detection",
        Recent = "recent",
        RecentUnwrapped = "recent_unwrapped",
        Visible = "visible",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReleaseNotesDismissParams {
    pub version: String,
}

tagged_union! {
    ResponseResult, "type",
    unit {
        Ok = "ok",
        SubscriptionStarted = "subscription_started",
    }
    payload {
        AgentExplain(ResponseResultAgentExplain) = "agent_explain",
        AgentInfo(ResponseResultAgentInfo) = "agent_info",
        AgentList(ResponseResultAgentList) = "agent_list",
        AgentManifestReload(ResponseResultAgentManifestReload) = "agent_manifest_reload",
        AgentManifestStatus(ResponseResultAgentManifestStatus) = "agent_manifest_status",
        AgentPrompted(ResponseResultAgentPrompted) = "agent_prompted",
        AgentStarted(ResponseResultAgentStarted) = "agent_started",
        AgentView(ResponseResultAgentView) = "agent_view",
        ClientShellSurfaceSet(ResponseResultClientShellSurfaceSet) = "client_shell_surface_set",
        ClientWindowTitle(ResponseResultClientWindowTitle) = "client_window_title",
        ConfigReload(ResponseResultConfigReload) = "config_reload",
        IntegrationInstall(ResponseResultIntegrationInstall) = "integration_install",
        IntegrationList(ResponseResultIntegrationList) = "integration_list",
        IntegrationUninstall(ResponseResultIntegrationUninstall) = "integration_uninstall",
        LayoutApply(ResponseResultLayoutApply) = "layout_apply",
        LayoutExport(ResponseResultLayoutExport) = "layout_export",
        LayoutSplitRatioSet(ResponseResultLayoutSplitRatioSet) = "layout_split_ratio_set",
        NotificationShow(ResponseResultNotificationShow) = "notification_show",
        OutputMatched(ResponseResultOutputMatched) = "output_matched",
        PaneCopyMotion(ResponseResultPaneCopyMotion) = "pane_copy_motion",
        PaneCopySearch(ResponseResultPaneCopySearch) = "pane_copy_search",
        PaneCurrent(ResponseResultPaneCurrent) = "pane_current",
        PaneEdges(ResponseResultPaneEdges) = "pane_edges",
        PaneFocusDirection(ResponseResultPaneFocusDirection) = "pane_focus_direction",
        PaneInfo(ResponseResultPaneInfo) = "pane_info",
        PaneLayout(ResponseResultPaneLayout) = "pane_layout",
        PaneLinkActivated(ResponseResultPaneLinkActivated) = "pane_link_activated",
        PaneLinkResolved(ResponseResultPaneLinkResolved) = "pane_link_resolved",
        PaneList(ResponseResultPaneList) = "pane_list",
        PaneMove(ResponseResultPaneMove) = "pane_move",
        PaneNeighbor(ResponseResultPaneNeighbor) = "pane_neighbor",
        PaneProcessInfo(ResponseResultPaneProcessInfo) = "pane_process_info",
        PaneRead(ResponseResultPaneRead) = "pane_read",
        PaneResize(ResponseResultPaneResize) = "pane_resize",
        PaneSelection(ResponseResultPaneSelection) = "pane_selection",
        PaneSwap(ResponseResultPaneSwap) = "pane_swap",
        PaneZoom(ResponseResultPaneZoom) = "pane_zoom",
        PluginActionInvoked(ResponseResultPluginActionInvoked) = "plugin_action_invoked",
        PluginActionList(ResponseResultPluginActionList) = "plugin_action_list",
        PluginDisabled(ResponseResultPluginDisabled) = "plugin_disabled",
        PluginEnabled(ResponseResultPluginEnabled) = "plugin_enabled",
        PluginLinked(ResponseResultPluginLinked) = "plugin_linked",
        PluginList(ResponseResultPluginList) = "plugin_list",
        PluginLogList(ResponseResultPluginLogList) = "plugin_log_list",
        PluginPaneClosed(ResponseResultPluginPaneClosed) = "plugin_pane_closed",
        PluginPaneFocused(ResponseResultPluginPaneFocused) = "plugin_pane_focused",
        PluginPaneOpened(ResponseResultPluginPaneOpened) = "plugin_pane_opened",
        PluginUnlinked(ResponseResultPluginUnlinked) = "plugin_unlinked",
        Pong(ResponseResultPong) = "pong",
        SessionSnapshot(ResponseResultSessionSnapshot) = "session_snapshot",
        TabCreated(ResponseResultTabCreated) = "tab_created",
        TabInfo(ResponseResultTabInfo) = "tab_info",
        TabList(ResponseResultTabList) = "tab_list",
        WaitMatched(ResponseResultWaitMatched) = "wait_matched",
        WorkspaceCreated(ResponseResultWorkspaceCreated) = "workspace_created",
        WorkspaceInfo(ResponseResultWorkspaceInfo) = "workspace_info",
        WorkspaceList(ResponseResultWorkspaceList) = "workspace_list",
        WorktreeCreated(ResponseResultWorktreeCreated) = "worktree_created",
        WorktreeList(ResponseResultWorktreeList) = "worktree_list",
        WorktreeOpened(ResponseResultWorktreeOpened) = "worktree_opened",
        WorktreeRemoved(ResponseResultWorktreeRemoved) = "worktree_removed",
    }
}

/// The fields of [`ResponseResult::AgentExplain`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultAgentExplain {
    pub explain: Value,
}

/// The fields of [`ResponseResult::AgentInfo`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultAgentInfo {
    pub agent: AgentInfo,
}

/// The fields of [`ResponseResult::AgentList`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultAgentList {
    pub agents: Vec<AgentInfo>,
}

/// The fields of [`ResponseResult::AgentManifestReload`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultAgentManifestReload {
    pub manifests: Vec<AgentManifestInfo>,
}

/// The fields of [`ResponseResult::AgentManifestStatus`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultAgentManifestStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_check_unix: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_result: Option<String>,
    pub manifests: Vec<AgentManifestInfo>,
}

/// The fields of [`ResponseResult::AgentPrompted`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultAgentPrompted {
    pub agent: AgentInfo,
}

/// The fields of [`ResponseResult::AgentStarted`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultAgentStarted {
    pub agent: AgentInfo,
    pub argv: Vec<String>,
}

/// The fields of [`ResponseResult::AgentView`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultAgentView {
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// The fields of [`ResponseResult::ClientShellSurfaceSet`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultClientShellSurfaceSet {
    pub active: bool,
    pub projection_revision: u64,
}

/// The fields of [`ResponseResult::ClientWindowTitle`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultClientWindowTitle {
    pub changed: bool,
    pub reason: ClientWindowTitleReason,
}

/// The fields of [`ResponseResult::ConfigReload`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultConfigReload {
    pub diagnostics: Vec<String>,
    pub status: ConfigReloadStatus,
}

/// The fields of [`ResponseResult::IntegrationInstall`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultIntegrationInstall {
    pub details: IntegrationInstallResult,
    pub target: IntegrationTarget,
}

/// The fields of [`ResponseResult::IntegrationList`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultIntegrationList {
    pub integrations: Vec<IntegrationInfo>,
}

/// The fields of [`ResponseResult::IntegrationUninstall`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultIntegrationUninstall {
    pub details: IntegrationUninstallResult,
    pub target: IntegrationTarget,
}

/// The fields of [`ResponseResult::LayoutApply`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultLayoutApply {
    pub layout: LayoutDescription,
}

/// The fields of [`ResponseResult::LayoutExport`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultLayoutExport {
    pub layout: LayoutDescription,
}

/// The fields of [`ResponseResult::LayoutSplitRatioSet`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultLayoutSplitRatioSet {
    pub layout: LayoutDescription,
}

/// The fields of [`ResponseResult::NotificationShow`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultNotificationShow {
    pub reason: NotificationShowReason,
    pub shown: bool,
}

/// The fields of [`ResponseResult::OutputMatched`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultOutputMatched {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_line: Option<String>,
    pub pane_id: String,
    pub read: PaneReadResult,
    pub revision: u64,
}

/// The fields of [`ResponseResult::PaneCopyMotion`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPaneCopyMotion {
    pub content_revision: u64,
    pub cursor: PaneTextPoint,
    pub pane_id: String,
}

/// The fields of [`ResponseResult::PaneCopySearch`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPaneCopySearch {
    pub content_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_global: Option<u64>,
    pub matches: Vec<PaneTextRange>,
    pub pane_id: String,
    pub total: u64,
}

/// The fields of [`ResponseResult::PaneCurrent`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPaneCurrent {
    pub pane: PaneInfo,
}

/// The fields of [`ResponseResult::PaneEdges`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPaneEdges {
    pub edges: PaneEdgesResult,
}

/// The fields of [`ResponseResult::PaneFocusDirection`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPaneFocusDirection {
    pub focus: PaneFocusDirectionResult,
}

/// The fields of [`ResponseResult::PaneInfo`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPaneInfo {
    pub pane: PaneInfo,
}

/// The fields of [`ResponseResult::PaneLayout`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPaneLayout {
    pub layout: PaneLayoutSnapshot,
}

/// The fields of [`ResponseResult::PaneLinkActivated`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPaneLinkActivated {
    pub handled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// The fields of [`ResponseResult::PaneLinkResolved`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPaneLinkResolved {
    pub regions: Vec<PaneLinkRegion>,
}

/// The fields of [`ResponseResult::PaneList`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPaneList {
    pub panes: Vec<PaneInfo>,
}

/// The fields of [`ResponseResult::PaneMove`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPaneMove {
    pub move_result: PaneMoveResult,
}

/// The fields of [`ResponseResult::PaneNeighbor`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPaneNeighbor {
    pub neighbor: PaneNeighborResult,
}

/// The fields of [`ResponseResult::PaneProcessInfo`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPaneProcessInfo {
    pub process_info: PaneProcessInfo,
}

/// The fields of [`ResponseResult::PaneRead`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPaneRead {
    pub read: PaneReadResult,
}

/// The fields of [`ResponseResult::PaneResize`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPaneResize {
    pub resize: PaneResizeResult,
}

/// The fields of [`ResponseResult::PaneSelection`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPaneSelection {
    pub pane_id: String,
    pub text: String,
}

/// The fields of [`ResponseResult::PaneSwap`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPaneSwap {
    pub swap: PaneSwapResult,
}

/// The fields of [`ResponseResult::PaneZoom`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPaneZoom {
    pub zoom: PaneZoomResult,
}

/// The fields of [`ResponseResult::PluginActionInvoked`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPluginActionInvoked {
    pub action: PluginActionInfo,
    pub context: PluginInvocationContext,
    pub log: PluginCommandLogInfo,
}

/// The fields of [`ResponseResult::PluginActionList`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPluginActionList {
    pub actions: Vec<PluginActionInfo>,
}

/// The fields of [`ResponseResult::PluginDisabled`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPluginDisabled {
    pub plugin: InstalledPluginInfo,
}

/// The fields of [`ResponseResult::PluginEnabled`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPluginEnabled {
    pub plugin: InstalledPluginInfo,
}

/// The fields of [`ResponseResult::PluginLinked`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPluginLinked {
    pub plugin: InstalledPluginInfo,
}

/// The fields of [`ResponseResult::PluginList`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPluginList {
    pub plugins: Vec<InstalledPluginInfo>,
}

/// The fields of [`ResponseResult::PluginLogList`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPluginLogList {
    pub logs: Vec<PluginCommandLogInfo>,
}

/// The fields of [`ResponseResult::PluginPaneClosed`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPluginPaneClosed {
    pub pane_id: String,
}

/// The fields of [`ResponseResult::PluginPaneFocused`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPluginPaneFocused {
    pub plugin_pane: PluginPaneInfo,
}

/// The fields of [`ResponseResult::PluginPaneOpened`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPluginPaneOpened {
    pub plugin_pane: PluginPaneInfo,
}

/// The fields of [`ResponseResult::PluginUnlinked`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPluginUnlinked {
    pub plugin_id: String,
    pub removed: bool,
}

/// The fields of [`ResponseResult::Pong`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultPong {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ServerCapabilities>,
    pub protocol: u32,
    pub version: String,
}

/// The fields of [`ResponseResult::SessionSnapshot`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultSessionSnapshot {
    pub snapshot: SessionSnapshot,
}

/// The fields of [`ResponseResult::TabCreated`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultTabCreated {
    pub root_pane: PaneInfo,
    pub tab: TabInfo,
}

/// The fields of [`ResponseResult::TabInfo`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultTabInfo {
    pub tab: TabInfo,
}

/// The fields of [`ResponseResult::TabList`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultTabList {
    pub tabs: Vec<TabInfo>,
}

/// The fields of [`ResponseResult::WaitMatched`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultWaitMatched {
    pub event: EventEnvelope,
}

/// The fields of [`ResponseResult::WorkspaceCreated`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultWorkspaceCreated {
    pub root_pane: PaneInfo,
    pub tab: TabInfo,
    pub workspace: WorkspaceInfo,
}

/// The fields of [`ResponseResult::WorkspaceInfo`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultWorkspaceInfo {
    pub workspace: WorkspaceInfo,
}

/// The fields of [`ResponseResult::WorkspaceList`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultWorkspaceList {
    pub workspaces: Vec<WorkspaceInfo>,
}

/// The fields of [`ResponseResult::WorktreeCreated`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultWorktreeCreated {
    pub root_pane: PaneInfo,
    pub tab: TabInfo,
    pub workspace: WorkspaceInfo,
    pub worktree: WorktreeInfo,
}

/// The fields of [`ResponseResult::WorktreeList`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultWorktreeList {
    pub source: WorktreeSourceInfo,
    pub worktrees: Vec<WorktreeInfo>,
}

/// The fields of [`ResponseResult::WorktreeOpened`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultWorktreeOpened {
    pub already_open: bool,
    pub root_pane: PaneInfo,
    pub tab: TabInfo,
    pub workspace: WorkspaceInfo,
    pub worktree: WorktreeInfo,
}

/// The fields of [`ResponseResult::WorktreeRemoved`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseResultWorktreeRemoved {
    pub forced: bool,
    pub path: String,
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detached_server_daemon: Option<bool>,
    /// Stable client-owned endpoint generation supported by this server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_protocol_generation: Option<u32>,
    /// Whether this server supports endpoint health probes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_check: Option<bool>,
    pub live_handoff: bool,
    /// Supports connection-scoped `server.ssh_agent.register` on the local JSON API.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_agent_registration: Option<bool>,
    /// Whether this server supports explicit client-shell surface interest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface_interest: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerLiveHandoffParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_protocol: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import_exe: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerSshAgentRegisterParams {
    /// Absolute remote-host agent socket. Registration lasts until this API connection closes.
    pub socket_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub agents: Vec<AgentInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_workspace_id: Option<String>,
    pub layouts: Vec<PaneLayoutSnapshot>,
    pub panes: Vec<PaneInfo>,
    pub protocol: u32,
    pub tabs: Vec<TabInfo>,
    pub version: String,
    pub workspaces: Vec<WorkspaceInfo>,
}

open_enum! {
    SplitDirection {
        Down = "down",
        Right = "right",
    }
}

tagged_union! {
    Subscription, "type",
    unit {
        LayoutUpdated = "layout.updated",
        PaneAgentDetected = "pane.agent_detected",
        PaneClosed = "pane.closed",
        PaneCreated = "pane.created",
        PaneExited = "pane.exited",
        PaneFocused = "pane.focused",
        PaneMoved = "pane.moved",
        PaneUpdated = "pane.updated",
        TabClosed = "tab.closed",
        TabCreated = "tab.created",
        TabFocused = "tab.focused",
        TabMoved = "tab.moved",
        TabRenamed = "tab.renamed",
        WorkspaceClosed = "workspace.closed",
        WorkspaceCreated = "workspace.created",
        WorkspaceFocused = "workspace.focused",
        WorkspaceMetadataUpdated = "workspace.metadata_updated",
        WorkspaceMoved = "workspace.moved",
        WorkspaceRenamed = "workspace.renamed",
        WorkspaceReordered = "workspace.reordered",
        WorkspaceUpdated = "workspace.updated",
        WorktreeCreated = "worktree.created",
        WorktreeOpened = "worktree.opened",
        WorktreeRemoved = "worktree.removed",
    }
    payload {
        PaneAgentStatusChanged(SubscriptionPaneAgentStatusChanged) = "pane.agent_status_changed",
        PaneOutputMatched(SubscriptionPaneOutputMatched) = "pane.output_matched",
        PaneScrollChanged(SubscriptionPaneScrollChanged) = "pane.scroll_changed",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SubscriptionEventData {
    PaneOutputMatchedEvent(PaneOutputMatchedEvent),
    PaneAgentStatusChangedEvent(PaneAgentStatusChangedEvent),
    PaneScrollChangedEvent(PaneScrollChangedEvent),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionEventEnvelope {
    pub data: SubscriptionEventData,
    pub event: SubscriptionEventKind,
}

open_enum! {
    SubscriptionEventKind {
        PaneAgentStatusChanged = "pane.agent_status_changed",
        PaneOutputMatched = "pane.output_matched",
        PaneScrollChanged = "pane.scroll_changed",
    }
}

/// The fields of [`Subscription::PaneAgentStatusChanged`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionPaneAgentStatusChanged {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_status: Option<AgentStatus>,
    pub pane_id: String,
}

/// The fields of [`Subscription::PaneOutputMatched`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionPaneOutputMatched {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<u32>,
    pub r#match: OutputMatch,
    pub pane_id: String,
    pub source: ReadSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strip_ansi: Option<bool>,
}

/// The fields of [`Subscription::PaneScrollChanged`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionPaneScrollChanged {
    pub pane_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SuccessResponse {
    pub id: String,
    pub result: ResponseResult,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TabCreateParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TabInfo {
    pub agent_status: AgentStatus,
    pub focused: bool,
    pub label: String,
    pub number: u64,
    pub pane_count: u64,
    pub tab_id: String,
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TabListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TabMoveParams {
    pub insert_index: u64,
    pub tab_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TabRenameParams {
    pub label: String,
    pub tab_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TabTarget {
    pub tab_id: String,
}

open_enum! {
    ToastHerdrPosition {
        BottomLeft = "bottom-left",
        BottomRight = "bottom-right",
        TopLeft = "top-left",
        TopRight = "top-right",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceCloseParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_group: Option<bool>,
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceCreateParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Workspace whose focused pane supplies the `follow` cwd policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_workspace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub active_tab_id: String,
    pub agent_status: AgentStatus,
    pub focused: bool,
    pub label: String,
    pub number: u64,
    pub pane_count: u64,
    pub tab_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<BTreeMap<String, String>>,
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorkspaceWorktreeInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceMoveBlockParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_workspace_id: Option<String>,
    pub workspace_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceMoveParams {
    pub insert_index: u64,
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceRenameParams {
    pub label: String,
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceReportMetadataParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    pub source: String,
    pub tokens: BTreeMap<String, Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_ms: Option<u64>,
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceTarget {
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceWorktreeInfo {
    pub checkout_path: String,
    pub is_linked_worktree: bool,
    pub repo_key: String,
    pub repo_name: String,
    pub repo_root: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorktreeCreateParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_repository: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorktreeInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub is_bare: bool,
    pub is_detached: bool,
    pub is_linked_worktree: bool,
    pub is_prunable: bool,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_workspace_id: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorktreeListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_repository: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorktreeOpenParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_repository: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorktreeRemoveParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_repository: Option<bool>,
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorktreeSourceInfo {
    pub repo_key: String,
    pub repo_name: String,
    pub repo_root: String,
    pub source_checkout_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_workspace_id: Option<String>,
}

methods! {
    AgentExplain = "agent.explain", AgentTarget;
    AgentFocus = "agent.focus", AgentTarget;
    AgentGet = "agent.get", AgentTarget;
    AgentList = "agent.list", EmptyParams;
    AgentPrompt = "agent.prompt", AgentPromptParams;
    AgentRead = "agent.read", AgentReadParams;
    AgentRename = "agent.rename", AgentRenameParams;
    AgentSendKeys = "agent.send_keys", AgentSendKeysParams;
    AgentStart = "agent.start", AgentStartParams;
    AgentViewClear = "agent.view.clear", AgentViewClearParams;
    AgentViewSet = "agent.view.set", AgentViewSetParams;
    AgentWait = "agent.wait", AgentWaitParams;
    ClientWindowTitleClear = "client.window_title.clear", EmptyParams;
    ClientWindowTitleSet = "client.window_title.set", ClientWindowTitleSetParams;
    ClientShellSurfaceSet = "client_shell.surface.set", ClientShellSurfaceSetParams;
    CommandInvoke = "command.invoke", CommandInvokeParams;
    EventsSubscribe = "events.subscribe", EventsSubscribeParams;
    EventsWait = "events.wait", EventsWaitParams;
    IntegrationInstall = "integration.install", IntegrationInstallParams;
    IntegrationList = "integration.list", EmptyParams;
    IntegrationUninstall = "integration.uninstall", IntegrationUninstallParams;
    LayoutApply = "layout.apply", LayoutApplyParams;
    LayoutExport = "layout.export", LayoutExportParams;
    LayoutSetSplitRatio = "layout.set_split_ratio", LayoutSetSplitRatioParams;
    NotificationShow = "notification.show", NotificationShowParams;
    PaneClear = "pane.clear", PaneTarget;
    PaneClearAgentAuthority = "pane.clear_agent_authority", PaneClearAgentAuthorityParams;
    PaneClose = "pane.close", PaneTarget;
    PaneCopyMotion = "pane.copy_motion", PaneCopyMotionParams;
    PaneCopySearch = "pane.copy_search", PaneCopySearchParams;
    PaneCurrent = "pane.current", PaneCurrentParams;
    PaneEdges = "pane.edges", PaneEdgesParams;
    PaneEditScrollback = "pane.edit_scrollback", PaneTarget;
    PaneFocus = "pane.focus", PaneTarget;
    PaneFocusDirection = "pane.focus_direction", PaneFocusDirectionParams;
    PaneGet = "pane.get", PaneTarget;
    PaneInputSet = "pane.input.set", PaneInputSetParams;
    PaneLayout = "pane.layout", PaneLayoutParams;
    PaneLinkActivate = "pane.link.activate", PaneLinkActivateParams;
    PaneLinkResolve = "pane.link.resolve", PaneLinkActivateParams;
    PaneList = "pane.list", PaneListParams;
    PaneMove = "pane.move", PaneMoveParams;
    PaneNeighbor = "pane.neighbor", PaneNeighborParams;
    PaneProcessInfo = "pane.process_info", PaneProcessInfoParams;
    PaneRead = "pane.read", PaneReadParams;
    PaneReleaseAgent = "pane.release_agent", PaneReleaseAgentParams;
    PaneRename = "pane.rename", PaneRenameParams;
    PaneReportAgent = "pane.report_agent", PaneReportAgentParams;
    PaneReportAgentSession = "pane.report_agent_session", PaneReportAgentSessionParams;
    PaneReportMetadata = "pane.report_metadata", PaneReportMetadataParams;
    PaneResize = "pane.resize", PaneResizeParams;
    PaneScroll = "pane.scroll", PaneScrollParams;
    PaneSelectionRead = "pane.selection.read", PaneSelectionReadParams;
    PaneSendInput = "pane.send_input", PaneSendInputParams;
    PaneSendKeys = "pane.send_keys", PaneSendKeysParams;
    PaneSendText = "pane.send_text", PaneSendTextParams;
    PaneSplit = "pane.split", PaneSplitParams;
    PaneSwap = "pane.swap", PaneSwapParams;
    PaneWaitForOutput = "pane.wait_for_output", PaneWaitForOutputParams;
    PaneZoom = "pane.zoom", PaneZoomParams;
    Ping = "ping", PingParams;
    PluginActionInvoke = "plugin.action.invoke", PluginActionInvokeParams;
    PluginActionList = "plugin.action.list", PluginActionListParams;
    PluginDisable = "plugin.disable", PluginSetEnabledParams;
    PluginEnable = "plugin.enable", PluginSetEnabledParams;
    PluginLink = "plugin.link", PluginLinkParams;
    PluginList = "plugin.list", PluginListParams;
    PluginLogList = "plugin.log.list", PluginLogListParams;
    PluginPaneClose = "plugin.pane.close", PluginPaneCloseParams;
    PluginPaneFocus = "plugin.pane.focus", PluginPaneFocusParams;
    PluginPaneOpen = "plugin.pane.open", PluginPaneOpenParams;
    PluginUnlink = "plugin.unlink", PluginUnlinkParams;
    PopupClose = "popup.close", EmptyParams;
    ProductAnnouncementDismiss = "product_announcement.dismiss", ProductAnnouncementDismissParams;
    ReleaseNotesDismiss = "release_notes.dismiss", ReleaseNotesDismissParams;
    ServerAgentManifests = "server.agent_manifests", EmptyParams;
    ServerLiveHandoff = "server.live_handoff", ServerLiveHandoffParams;
    ServerReloadAgentManifests = "server.reload_agent_manifests", EmptyParams;
    ServerReloadConfig = "server.reload_config", EmptyParams;
    ServerSshAgentRegister = "server.ssh_agent.register", ServerSshAgentRegisterParams;
    ServerStop = "server.stop", EmptyParams;
    SessionSnapshot = "session.snapshot", EmptyParams;
    TabClose = "tab.close", TabTarget;
    TabCreate = "tab.create", TabCreateParams;
    TabFocus = "tab.focus", TabTarget;
    TabGet = "tab.get", TabTarget;
    TabList = "tab.list", TabListParams;
    TabMove = "tab.move", TabMoveParams;
    TabRename = "tab.rename", TabRenameParams;
    WorkspaceClose = "workspace.close", WorkspaceCloseParams;
    WorkspaceCreate = "workspace.create", WorkspaceCreateParams;
    WorkspaceFocus = "workspace.focus", WorkspaceTarget;
    WorkspaceGet = "workspace.get", WorkspaceTarget;
    WorkspaceList = "workspace.list", EmptyParams;
    WorkspaceMove = "workspace.move", WorkspaceMoveParams;
    WorkspaceMoveBlock = "workspace.move_block", WorkspaceMoveBlockParams;
    WorkspaceRename = "workspace.rename", WorkspaceRenameParams;
    WorkspaceReportMetadata = "workspace.report_metadata", WorkspaceReportMetadataParams;
    WorktreeCreate = "worktree.create", WorktreeCreateParams;
    WorktreeList = "worktree.list", WorktreeListParams;
    WorktreeOpen = "worktree.open", WorktreeOpenParams;
    WorktreeRemove = "worktree.remove", WorktreeRemoveParams;
}
