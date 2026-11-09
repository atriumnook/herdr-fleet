//! The one function that sends the CLI's requests to `/api/fleet` (`call` of `bin/fleet.ts`):
//! the `x-herdr-fleet` header on every request, the token as a bearer when there is one, the
//! body as JSON, and an answer that is not JSON read as `{}`. Plain HTTP with ureq, without TLS
//! (ADR 0242-phase-3-split): the fleet server listens on the loopback.

use std::time::Duration;

use protocol::fleet_cli::ErrorBody;
use protocol::{FLEET_API, FLEET_HEADER, FLEET_HEADER_VALUE};
use serde_json::{Map, Value};

use crate::Failure;

/// What `bin/fleet.ts` falls back to without `HERDR_FLEET_URL`.
const DEFAULT_URL: &str = "http://127.0.0.1:7317";

pub struct Client {
    base: String,
    token: Option<String>,
    agent: ureq::Agent,
}

#[derive(Clone, Copy)]
pub enum Method {
    Get,
    Post,
}

impl Client {
    /// The server `HERDR_FLEET_URL` names (one trailing `/` dropped), with `HERDR_FLEET_TOKEN`.
    pub fn new(url: Option<&str>, token: Option<&str>) -> Client {
        let url = url.filter(|u| !u.is_empty()).unwrap_or(DEFAULT_URL);
        let agent = ureq::Agent::config_builder()
            // an error status is an answer to read, as with fetch
            .http_status_as_error(false)
            // never through a proxy: the server refuses what came through one
            // (`cameThroughProxy`, server/access.ts), and ureq would read the proxy variables of
            // the process, which `run` does not read
            .proxy(None)
            // as fetch, no time limit of its own: `wait` waits as long as the server lets it
            .timeout_global(None::<Duration>)
            .build()
            .new_agent();
        Client {
            base: url.strip_suffix('/').unwrap_or(url).to_string(),
            token: token.filter(|t| !t.is_empty()).map(str::to_string),
            agent,
        }
    }

    /// The headers of every request: `x-herdr-fleet: 1`, and the token as a bearer.
    fn headers<B>(&self, request: ureq::RequestBuilder<B>) -> ureq::RequestBuilder<B> {
        let request = request.header(FLEET_HEADER, FLEET_HEADER_VALUE);
        match &self.token {
            Some(token) => request.header("authorization", format!("Bearer {token}")),
            None => request,
        }
    }

    /// Sends `method` to `/api/fleet<path>` and returns the answer's JSON (an object, `{}` when
    /// it is not JSON). An error status fails with `<code>: <message>`: exit 124 for
    /// `wait_timeout`, carrying the run the answer names, else exit 1.
    pub fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value, Failure> {
        let url = format!("{}{FLEET_API}{path}", self.base);
        let unreachable = |error: ureq::Error| {
            let reason = error.to_string().replace(['\r', '\n'], " ");
            Failure::new(
                format!(
                    "cannot reach the fleet server at {}: {reason}. Start it with `bun run start` in herdr-fleet.",
                    self.base
                ),
                1,
            )
        };
        let response = match method {
            Method::Get => self.headers(self.agent.get(&url)).call(),
            Method::Post => {
                let request = self.headers(self.agent.post(&url));
                match body {
                    Some(body) => request
                        .header("content-type", "application/json")
                        .send(body.to_string()),
                    None => request.send_empty(),
                }
            }
        }
        .map_err(unreachable)?;
        let status = response.status();
        let mut response = response;
        let data = response
            .body_mut()
            .with_config()
            .limit(u64::MAX)
            .read_to_vec()
            .ok()
            .and_then(|bytes| serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)).ok())
            .unwrap_or_else(|| Value::Object(Map::new()));
        if status.is_success() {
            return Ok(data);
        }
        let error: ErrorBody<Value> = serde_json::from_value(data).unwrap_or_default();
        let detail = error.error.unwrap_or_default();
        let code = detail
            .code
            .unwrap_or_else(|| format!("http_{}", status.as_u16()));
        let message = detail
            .message
            .unwrap_or_else(|| status.canonical_reason().unwrap_or("").to_string());
        let exit = if code == "wait_timeout" { 124 } else { 1 };
        Err(Failure {
            message: format!("{code}: {message}"),
            exit,
            run: error.run,
        })
    }
}
