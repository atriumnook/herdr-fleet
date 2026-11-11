//! The frames the pane-status subscription reads (`parseStatusFrame`, `parseStructureFrame`,
//! `parseFocusFrame` in `server/collector.ts`): status frames are flat
//! (`{event: "pane.agent_status_changed", data: {pane_id, agent_status, agent?}}`), structure and
//! focus frames carry a snake_case `data.type`. Only what the live server sends is read; anything
//! else is no frame of theirs.

use crate::events::EventFrame;
use herdr_api::AgentStatus;
use serde_json::Value;

/// A status frame's payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StatusChange {
    pub pane: String,
    pub status: AgentStatus,
    pub agent: Option<String>,
}

/// What a structure frame tells.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Structure {
    /// `pane_exited`
    Ended(String),
    /// `pane_created`, or `pane_closed` with the pane it names (`closed`)
    Changed { closed: Option<String> },
}

fn text<'a>(data: &'a Value, key: &str) -> Option<&'a str> {
    data.get(key).and_then(Value::as_str)
}

pub(super) fn status(frame: &EventFrame) -> Option<StatusChange> {
    if frame.event.as_deref() != Some("pane.agent_status_changed") {
        return None;
    }
    Some(StatusChange {
        pane: text(&frame.data, "pane_id")?.to_owned(),
        status: AgentStatus::from(text(&frame.data, "agent_status")?.to_owned()),
        agent: text(&frame.data, "agent").map(str::to_owned),
    })
}

pub(super) fn structure(frame: &EventFrame) -> Option<Structure> {
    let pane = text(&frame.data, "pane_id").map(str::to_owned);
    match text(&frame.data, "type")? {
        "pane_exited" => pane.map(Structure::Ended),
        "pane_closed" => Some(Structure::Changed { closed: pane }),
        "pane_created" => Some(Structure::Changed { closed: None }),
        _ => None,
    }
}

/// The pane a focus frame (`{data: {type: "pane_focused", pane_id}}`) brought to the front.
pub(super) fn focus(frame: &EventFrame) -> Option<String> {
    if text(&frame.data, "type")? != "pane_focused" {
        return None;
    }
    text(&frame.data, "pane_id").map(str::to_owned)
}
