//! Which shape of [`ResponseResult`] each method herdr-fleet calls answers with.
//!
//! herdr's schema does not say: a request names its method and params, and every success carries
//! one union of 63 shapes, many methods sharing one (`ok`). So the table is written by hand
//! (ADR 0242-phase-3-split, "herdr-api の生成"), one line per method the phase-3 crates call
//! (herdr's client, the orchestrator's `HerdrRuntime`), and the `#[ignore]` test
//! `live::herdr_answers_each_method_in_the_tables_shape` checks every line against a real herdr.
//! A later issue that calls another method adds its line here.

use crate::error::HerdrError;
use herdr_api::{Method, ResponseResult, methods};

/// A method of the table: the shape its success has, and the value [`crate::Herdr::call`]
/// returns.
pub trait Answer: Method {
    /// The fields of the method's shape; `()` for `ok`.
    type Output;

    /// The method's answer out of herdr's result; another shape is a `bad_frame`.
    fn answer(result: ResponseResult) -> Result<Self::Output, HerdrError>;
}

/// `bad_frame`: herdr answered `method` with another shape than the table's.
fn unexpected(method: &str, expected: &str, result: &ResponseResult) -> HerdrError {
    let actual = serde_json::to_value(result)
        .ok()
        .and_then(|value| {
            value
                .get("type")
                .and_then(|t| t.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "an untyped result".to_owned());
    HerdrError::BadFrame(format!(
        "herdr answered {method} with {actual}, where herdr-fleet expects {expected}"
    ))
}

macro_rules! answers {
    (
        payload { $($marker:ident => $variant:ident($output:ty) = $tag:literal,)* }
        unit { $($unit_marker:ident => $unit_variant:ident = $unit_tag:literal,)* }
    ) => {
        /// The table: each method's name and the `type` of the shape it answers with.
        pub const ANSWERS: &[(&str, &str)] = &[
            $((<methods::$marker as Method>::NAME, $tag),)*
            $((<methods::$unit_marker as Method>::NAME, $unit_tag),)*
        ];

        $(
            impl Answer for methods::$marker {
                type Output = $output;

                fn answer(result: ResponseResult) -> Result<Self::Output, HerdrError> {
                    match result {
                        ResponseResult::$variant(output) => Ok(output),
                        other => Err(unexpected(Self::NAME, $tag, &other)),
                    }
                }
            }
        )*

        $(
            impl Answer for methods::$unit_marker {
                type Output = ();

                fn answer(result: ResponseResult) -> Result<Self::Output, HerdrError> {
                    match result {
                        ResponseResult::$unit_variant => Ok(()),
                        other => Err(unexpected(Self::NAME, $unit_tag, &other)),
                    }
                }
            }
        )*
    };
}

// Checked against herdr 0.9.1 (protocol 22). `events.subscribe` has no line: its answers go
// through [`crate::EventStream`], never through `rpc`.
answers! {
    payload {
        Ping => Pong(herdr_api::ResponseResultPong) = "pong",
        SessionSnapshot => SessionSnapshot(herdr_api::ResponseResultSessionSnapshot) = "session_snapshot",
        WorkspaceCreate => WorkspaceCreated(herdr_api::ResponseResultWorkspaceCreated) = "workspace_created",
        WorktreeCreate => WorktreeCreated(herdr_api::ResponseResultWorktreeCreated) = "worktree_created",
        TabCreate => TabCreated(herdr_api::ResponseResultTabCreated) = "tab_created",
        PaneSplit => PaneInfo(herdr_api::ResponseResultPaneInfo) = "pane_info",
        PaneGet => PaneInfo(herdr_api::ResponseResultPaneInfo) = "pane_info",
        PaneRead => PaneRead(herdr_api::ResponseResultPaneRead) = "pane_read",
        AgentStart => AgentStarted(herdr_api::ResponseResultAgentStarted) = "agent_started",
        AgentGet => AgentInfo(herdr_api::ResponseResultAgentInfo) = "agent_info",
        AgentFocus => AgentInfo(herdr_api::ResponseResultAgentInfo) = "agent_info",
        AgentPrompt => AgentPrompted(herdr_api::ResponseResultAgentPrompted) = "agent_prompted",
        AgentRead => PaneRead(herdr_api::ResponseResultPaneRead) = "pane_read",
    }
    unit {
        PaneClose => Ok = "ok",
        PaneReportMetadata => Ok = "ok",
        AgentSendKeys => Ok = "ok",
    }
}
