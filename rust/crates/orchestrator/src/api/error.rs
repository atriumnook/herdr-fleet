//! The HTTP status and body each failure is answered with (`STATUS` and `fleetError`,
//! `server/fleet/api.ts:285-305`).

use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use protocol::{ErrorBody, ErrorDetail};
use serde::Serialize;

use crate::FleetError;
use crate::fleet::OrchestratorError;
use crate::github::GhError;
use crate::runtime::RuntimeError;

/// `jsonResponse`: `value` as JSON with api.ts's content type.
pub(super) fn json_response<T: Serialize>(status: StatusCode, value: &T) -> Response {
    match serde_json::to_vec(value) {
        Ok(bytes) => {
            let mut response = (status, bytes).into_response();
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json; charset=utf-8"),
            );
            response
        }
        Err(error) => ApiError::Internal(error.to_string()).into_response(),
    }
}

/// The status of a fleet error's code; a code the table does not name is the caller's fault, 400.
fn status_of(code: &str) -> u16 {
    match code {
        "run_not_found" | "unknown_role" | "no_plan" | "unknown_entrance" => 404,
        "plan_unreadable"
        | "agent_blocked"
        | "plan_outdated"
        | "plan_answered"
        | "plan_closed"
        | "not_a_thread"
        | "thread_landed"
        | "landing_busy"
        | "run_busy"
        | "no_pull_request"
        | "diff_unavailable"
        | "settings_unreadable"
        | "entrance_taken"
        | "entrance_unreadable"
        | "depth_limit"
        | "run_ended"
        | "scope_conflict" => 409,
        "concurrency_limit" | "usage_exhausted" => 429,
        "answer_not_delivered" | "agent_start_failed" | "fallbacks_exhausted" | "setup_failed" => {
            502
        }
        "agent_not_ready" => 504,
        // not in TypeScript's table: the opencode guard plugin missing from the install is the
        // server's fault (issue #269, from #248), and a file of the server's own that could not be
        // written is TypeScript's plain Error (`api.ts:304`)
        "guard_plugin_missing" | "internal_error" => 500,
        _ => 400,
    }
}

/// A failure of a route, answered with its status and `{ error: { code, message } }`.
#[derive(Debug)]
pub(crate) enum ApiError {
    Fleet(FleetError),
    Orchestrator(OrchestratorError),
    /// No route for the method and path (`notFound`).
    NotFound,
    /// GitHub could not be asked: TypeScript's plain Error from `ghJson`.
    Gh(GhError),
    /// The task running the operation panicked: TypeScript's plain Error.
    Internal(String),
}

impl From<GhError> for ApiError {
    fn from(error: GhError) -> Self {
        ApiError::Gh(error)
    }
}

impl From<FleetError> for ApiError {
    fn from(error: FleetError) -> Self {
        ApiError::Fleet(error)
    }
}

impl From<OrchestratorError> for ApiError {
    fn from(error: OrchestratorError) -> Self {
        ApiError::Orchestrator(error)
    }
}

fn answer(status: u16, code: &str, message: String, run: Option<protocol::AgentRun>) -> Response {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let body = ErrorBody {
        error: ErrorDetail {
            code: code.to_owned(),
            message,
        },
        run,
    };
    json_response(status, &body)
}

fn fleet(error: FleetError) -> Response {
    answer(status_of(&error.code), &error.code, error.message, None)
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            ApiError::Fleet(error) | ApiError::Orchestrator(OrchestratorError::Fleet(error)) => {
                fleet(error)
            }
            ApiError::Orchestrator(OrchestratorError::WaitTimeout { run, timeout_ms }) => {
                let message = OrchestratorError::WaitTimeout {
                    run: run.clone(),
                    timeout_ms,
                }
                .to_string();
                answer(408, "wait_timeout", message, Some(*run))
            }
            ApiError::Orchestrator(OrchestratorError::Runtime(error)) => runtime(error),
            ApiError::Orchestrator(OrchestratorError::Io(error)) => {
                answer(500, "internal_error", error.to_string(), None)
            }
            ApiError::NotFound => {
                answer(404, "not_found", "Unknown fleet endpoint".to_owned(), None)
            }
            ApiError::Gh(error) => answer(500, "internal_error", error.0, None),
            ApiError::Internal(message) => answer(500, "internal_error", message, None),
        }
    }
}

/// What the runtime said, as TypeScript answers the error it stands for: the fleet's own codes
/// through the table, a cancel as 499 `aborted`, and any other herdr error with its code as 502.
fn runtime(error: RuntimeError) -> Response {
    let code = error.code().to_owned();
    match error {
        RuntimeError::Cancelled => answer(499, "aborted", "request cancelled".to_owned(), None),
        RuntimeError::Blocked | RuntimeError::StartFailed(_) | RuntimeError::NotReady(_) => {
            answer(status_of(&code), &code, error.to_string(), None)
        }
        RuntimeError::NotFound | RuntimeError::Herdr { .. } => {
            answer(502, &code, error.to_string(), None)
        }
    }
}
