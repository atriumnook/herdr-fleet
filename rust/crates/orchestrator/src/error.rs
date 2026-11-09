//! `FleetError` (`server/fleet/runtime.ts`): a refusal or failure of the fleet with a code that
//! callers and the `/api/fleet` error body carry, such as `run_not_found` or `invalid_plan`.

use std::fmt;

/// An error of the fleet: `code` names it for callers (the error body's `code`), `message` says it
/// for a person. Codes are strings, as in TypeScript, because the API and the CLI pass them on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FleetError {
    pub code: String,
    pub message: String,
}

impl FleetError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        FleetError {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for FleetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FleetError {}

/// The body `/api/fleet` answers a `FleetError` with: `{ error: { code, message } }`.
impl From<FleetError> for protocol::ErrorBody {
    fn from(error: FleetError) -> Self {
        protocol::ErrorBody {
            error: protocol::ErrorDetail {
                code: error.code,
                message: error.message,
            },
            run: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::FleetError;
    use serde_json::json;

    #[test]
    fn keeps_its_code_and_says_its_message() {
        let error = FleetError::new("run_not_found", "no agent named w1.");
        assert_eq!(error.code, "run_not_found");
        assert_eq!(error.message, "no agent named w1.");
        // TypeScript's Error: `String(error)` is "FleetError: …", `error.message` the message alone;
        // the CLI and the API show the message.
        assert_eq!(error.to_string(), "no agent named w1.");
    }

    #[test]
    fn becomes_the_error_body() {
        let body = protocol::ErrorBody::from(FleetError::new("invalid_plan", "title is required"));
        // the shape of `server/fleet/api.ts`'s error responses, as fixtures/fleet-cli/spawn-error.json holds one
        assert_eq!(
            serde_json::to_value(body).unwrap(),
            json!({ "error": { "code": "invalid_plan", "message": "title is required" } })
        );
    }
}
