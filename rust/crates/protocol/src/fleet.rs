//! The fleet's agent kinds and the usage it knows (`shared/fleet.ts`).

use serde::{Deserialize, Serialize};

/// The agent CLIs the fleet can start: herdr's `agent start --kind` values it has an adapter for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FleetAgentKind {
    Pi,
    Claude,
    Codex,
    Cursor,
    Agy,
    Opencode,
}

/// One limit window: a share of it used, until it resets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageWindow {
    /// `5h`, `weekly`, `monthly`, …
    pub name: String,
    #[serde(rename = "usedPercent")]
    pub used_percent: f64,
    /// Epoch milliseconds; unknown for some sources.
    #[serde(rename = "resetsAt", default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageReading {
    pub windows: Vec<UsageWindow>,
    /// Epoch milliseconds.
    #[serde(rename = "readAt")]
    pub read_at: i64,
}
