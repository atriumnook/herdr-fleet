//! `codex app-server`'s `account/rateLimits/read`, and the reading in its answer
//! (`server/fleet/usage.ts:37-48, 420-458`).

use std::sync::Arc;
use std::time::Duration;

use child_process::{Command, EnvPolicy, RunError, Runner, Session, child_env, empty_work_dir};
use protocol::js::number_to_string;
use protocol::{UsageReading, UsageWindow};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::probe::{ProbeOptions, Readings, UsageProbe, did_not_answer, truthy};

/// How long `codex app-server` may run, from its start to its answer (`usage.ts:428`).
pub const CODEX_TIMEOUT: Duration = Duration::from_secs(15);

/// A window's name from its length: `weekly` for 10080 minutes, `<n>h` for whole hours, `<n>m`
/// otherwise, `window` without a length.
fn window_name(minutes: Option<f64>) -> String {
    match minutes {
        None => "window".to_owned(),
        Some(10_080.0) => "weekly".to_owned(),
        Some(minutes) if minutes % 60.0 == 0.0 => format!("{}h", number_to_string(minutes / 60.0)),
        Some(minutes) => format!("{}m", number_to_string(minutes)),
    }
}

/// codex app-server's `account/rateLimits/read` result: primary and secondary windows. `now` is
/// the reading's time, epoch milliseconds.
pub fn parse_codex_rate_limits(result: &Value, now: i64) -> Option<UsageReading> {
    let limits = result
        .get("rateLimits")
        .filter(|limits| limits.is_object())?;
    let windows: Vec<UsageWindow> = ["primary", "secondary"]
        .into_iter()
        .filter_map(|key| {
            let window = limits.get(key).filter(|window| window.is_object())?;
            Some(UsageWindow {
                name: window_name(window.get("windowDurationMins").and_then(Value::as_f64)),
                used_percent: window.get("usedPercent")?.as_f64()?,
                resets_at: window
                    .get("resetsAt")
                    .and_then(Value::as_f64)
                    .map(|seconds| seconds * 1000.0),
            })
        })
        .collect();
    (!windows.is_empty()).then_some(UsageReading {
        windows,
        read_at: now as f64,
    })
}

/// `codex app-server` over stdio: initialize, then `account/rateLimits/read`. The answer comes
/// back as one JSON line among others; only the rate limits are kept (it also names the account).
/// codex keeps its sign-in under `CODEX_HOME`, which passes when set.
pub fn codex_probe(options: ProbeOptions) -> UsageProbe {
    let options = Arc::new(options);
    let runner = Runner::new(1);
    Arc::new(move || {
        let options = Arc::clone(&options);
        let runner = runner.clone();
        Box::pin(async move { ask(&options, &runner).await })
    })
}

async fn ask(options: &ProbeOptions, runner: &Runner) -> Result<Readings, String> {
    empty_work_dir(&options.work_dir).map_err(|error| error.to_string())?;
    let env = child_env(&options.env, &["CODEX_HOME"]);
    let command = Command::new(
        options.command_or("codex"),
        &options.work_dir,
        EnvPolicy::Only(env),
        CODEX_TIMEOUT,
    )
    .arg("app-server");
    let mut session = runner
        .session(command, &CancellationToken::new())
        .await
        .map_err(|error| format!("codex app-server: {error}"))?;
    let answer = exchange(&mut session, options).await;
    session.close().await;
    answer.map_err(|error| match error {
        Failure::Said(text) => text,
        Failure::Run(RunError::TimedOut) => did_not_answer("codex app-server", CODEX_TIMEOUT),
        Failure::Run(error) => format!("codex app-server: {error}"),
    })
}

enum Failure {
    Said(String),
    Run(RunError),
}

impl From<RunError> for Failure {
    fn from(error: RunError) -> Self {
        Failure::Run(error)
    }
}

async fn exchange(session: &mut Session, options: &ProbeOptions) -> Result<Readings, Failure> {
    let send = |message: Value| {
        let mut line = json!({ "jsonrpc": "2.0" });
        if let (Some(line), Value::Object(message)) = (line.as_object_mut(), message) {
            line.extend(message);
        }
        line.to_string()
    };
    session
        .send_line(&send(json!({ "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "herdr-fleet", "version": "0" } } })))
        .await?;
    loop {
        let Some(line) = session.next_line().await? else {
            return Err(Failure::Said(
                "codex app-server closed before it answered".to_owned(),
            ));
        };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match message.get("id").and_then(Value::as_f64) {
            Some(1.0) => {
                session
                    .send_line(&send(json!({ "method": "initialized" })))
                    .await?;
                session
                    .send_line(&send(
                        json!({ "id": 2, "method": "account/rateLimits/read" }),
                    ))
                    .await?;
            }
            Some(2.0) => {
                if let Some(error) = message.get("error").filter(|error| truthy(error)) {
                    let said = match error.get("message") {
                        None | Some(Value::Null) => "rate limits unavailable".to_owned(),
                        Some(Value::String(text)) => text.clone(),
                        Some(other) => other.to_string(),
                    };
                    return Err(Failure::Said(format!("codex: {said}")));
                }
                // read when the answer came, as `parseCodexRateLimits`'s default `Date.now()` is
                let reading = message
                    .get("result")
                    .and_then(|result| parse_codex_rate_limits(result, options.clock.now_ms()));
                return Ok(reading
                    .map(|reading| Readings::from([("codex".to_owned(), reading)]))
                    .unwrap_or_default());
            }
            _ => {}
        }
    }
}
