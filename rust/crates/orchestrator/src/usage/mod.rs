//! How much of each subscription is used, and which accounts are cooling down after a rate limit:
//! what the fleet skips a spawn candidate for (`server/fleet/usage.ts`). Every number comes from
//! the CLI's own way of telling it (codex app-server, agy's and Claude Code's `/usage` in print
//! mode, cursor's `/usage` screen, read by screen's `cursor_usage`); no credential file is ever
//! read.
//!
//! Each probe's argv and the parser of its output are in one file (`codex`, `agy`, `claude`;
//! ADR 0107-crate-split). Times are epoch milliseconds as JavaScript numbers (`f64`, as protocol's
//! `UsageReading` holds them), read from a [`Clock`](crate::Clock).

mod agy;
mod claude;
mod codex;
mod cooldown;
mod js_time;
mod probe;
mod tracker;

use protocol::FleetAgentKind;

pub use agy::{AGY_TIMEOUT, agy_probe, parse_agy_usage};
pub use claude::{CLAUDE_TIMEOUT, claude_probe, parse_claude_usage};
pub use codex::{CODEX_TIMEOUT, codex_probe, parse_codex_rate_limits};
pub use cooldown::{RateLimit, rate_limit_until};
pub use probe::{ProbeFuture, ProbeOptions, Readings, UsageProbe, default_probes};
pub use tracker::{
    AUTO_REFRESH, BACKOFF_CAP, PROBE_TIMEOUT, PROBE_TTL, SCREEN_TTL, UNDATED_WINDOW, UsageTracker,
    UsageTrackerOptions,
};

/// The account a candidate draws on. agy keeps separate limits for its Gemini models and for the
/// others it hosts; pi and opencode have none of their own, so each of their providers cools down
/// apart.
pub fn usage_key(kind: FleetAgentKind, model: Option<&str>) -> String {
    match kind {
        FleetAgentKind::Agy => {
            let gemini = model.is_none_or(|model| {
                model.is_empty() || model.to_ascii_lowercase().contains("gemini")
            });
            if gemini { "agy:gemini" } else { "agy:3p" }.to_owned()
        }
        FleetAgentKind::Pi | FleetAgentKind::Opencode => {
            // `indexOf("/") > 0`: a provider before the first slash, not an empty one
            match model.and_then(|model| {
                model
                    .find('/')
                    .filter(|&slash| slash > 0)
                    .map(|slash| &model[..slash])
            }) {
                Some(provider) => format!("{}:{provider}", kind_name(kind)),
                None => kind_name(kind),
            }
        }
        _ => kind_name(kind),
    }
}

/// The kind as herdr and the fleet's JSON name it: `FleetAgentKind`'s own serde name, as
/// `launch` reads it.
pub(crate) fn kind_name(kind: FleetAgentKind) -> String {
    match serde_json::to_value(kind) {
        Ok(serde_json::Value::String(name)) => name,
        _ => format!("{kind:?}"),
    }
}
