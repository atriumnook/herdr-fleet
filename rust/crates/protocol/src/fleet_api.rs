//! What the fleet CLI, the Web UI and the core share about `/api/fleet` (`server/fleet/api.ts`,
//! `bin/fleet.ts`): where it is mounted, its routes, the header a change carries, and the error
//! body every route answers a failure with.

use serde::{Deserialize, Serialize};

use crate::AgentRun;

/// Where the core mounts the fleet's router.
pub const FLEET_API: &str = "/api/fleet";

/// The header every request to `/api/fleet` but a GET must carry, `X-Herdr-Fleet: 1`: a page on
/// another site cannot send it without a preflight. Lower case, as HTTP/2 writes header names and
/// `http::HeaderName::from_static` takes them.
pub const FLEET_HEADER: &str = "x-herdr-fleet";

/// The value of [`FLEET_HEADER`].
pub const FLEET_HEADER_VALUE: &str = "1";

/// The routes of `/api/fleet`, relative to [`FLEET_API`], in axum's path syntax: `{target}` is a
/// run's name, role, id or pane id, percent-encoded by the caller (`encodeURIComponent`).
pub mod fleet_routes {
    /// GET: the roles the project can spawn.
    pub const ROLES: &str = "/roles";
    /// POST: start a thread. GET: the threads of a project.
    pub const THREADS: &str = "/threads";
    /// POST: hand a task to a project's coordinator.
    pub const PROJECTS: &str = "/projects";
    /// POST: spawn a helper.
    pub const SPAWN: &str = "/spawn";
    /// GET: the factory metrics.
    pub const REPORT: &str = "/report";
    /// GET: the usage the fleet knows.
    pub const USAGE: &str = "/usage";
    /// POST: read the usage again.
    pub const USAGE_REFRESH: &str = "/usage/refresh";
    /// POST: end a cooldown.
    pub const USAGE_CLEAR: &str = "/usage/clear";
    /// GET: the settings. POST: change them.
    pub const SETTINGS: &str = "/settings";
    /// GET: the model listings.
    pub const MODELS: &str = "/models";
    /// GET: the fleet skill's folders. POST: install or remove the skill in one.
    pub const ENTRANCES: &str = "/entrances";
    /// POST: close the panes of the group's settled helpers.
    pub const CLOSE_DONE: &str = "/close-done";
    /// GET: the runs, of one group with `?group=`.
    pub const RUNS: &str = "/runs";
    /// GET: one run.
    pub const RUN: &str = "/runs/{target}";
    /// GET: what a thread changed.
    pub const RUN_DIFF: &str = "/runs/{target}/diff";
    /// GET: what stands between a thread and landing.
    pub const RUN_LANDING: &str = "/runs/{target}/landing";
    /// GET: a thread's plan. POST: hand a plan over.
    pub const RUN_PLAN: &str = "/runs/{target}/plan";
    /// POST: the person's answers to a plan.
    pub const RUN_PLAN_ANSWER: &str = "/runs/{target}/plan/answer";
    /// GET: the run's screen.
    pub const RUN_READ: &str = "/runs/{target}/read";
    /// POST: send the run a message.
    pub const RUN_SEND: &str = "/runs/{target}/send";
    /// POST: wait for the run's turn to settle.
    pub const RUN_WAIT: &str = "/runs/{target}/wait";
    /// POST: interrupt the run.
    pub const RUN_INTERRUPT: &str = "/runs/{target}/interrupt";
    /// POST: focus the run's pane.
    pub const RUN_FOCUS: &str = "/runs/{target}/focus";
    /// POST: mark a thread done, or take that back.
    pub const RUN_RESOLVE: &str = "/runs/{target}/resolve";
    /// POST: a landing step.
    pub const RUN_LAND: &str = "/runs/{target}/land";

    /// Every route above.
    pub const ALL: [&str; 25] = [
        ROLES,
        THREADS,
        PROJECTS,
        SPAWN,
        REPORT,
        USAGE,
        USAGE_REFRESH,
        USAGE_CLEAR,
        SETTINGS,
        MODELS,
        ENTRANCES,
        CLOSE_DONE,
        RUNS,
        RUN,
        RUN_DIFF,
        RUN_LANDING,
        RUN_PLAN,
        RUN_PLAN_ANSWER,
        RUN_READ,
        RUN_SEND,
        RUN_WAIT,
        RUN_INTERRUPT,
        RUN_FOCUS,
        RUN_RESOLVE,
        RUN_LAND,
    ];
}

/// The body a route answers a failure with: `{ error: { code, message } }`, and the run on a
/// `wait` that timed out (`wait_timeout`, which the CLI shows and exits 124 on).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorBody {
    pub error: ErrorDetail,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<AgentRun>,
}

/// What failed: `code` for callers (`run_not_found`, `wait_timeout`, a herdr error's code, …),
/// `message` for a person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
}
