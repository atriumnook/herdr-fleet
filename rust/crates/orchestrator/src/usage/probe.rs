//! What a usage probe is, where it runs and what it starts with; the probes the server runs
//! (`server/fleet/usage.ts:399-438`).
//!
//! Every probe starts its CLI through a [`Runner`] of its own, which lets one child run at a time
//! (the tracker asks one probe of a CLI at a time; ADR 0246-child-process-interface: a runner per
//! use). Past its time limit the CLI gets
//! SIGTERM, then SIGKILL, and its output is read up to 8 MiB (ADR 0242-phase-3-split, "子プロセス").
//! TypeScript sends SIGTERM once and reads without a limit, so a CLI that ignores SIGTERM stays,
//! and so does the read (`server/opencode-cli.ts:119-122`). The time limits are TypeScript's.

use std::collections::{BTreeMap, HashMap};
use std::ffi::{OsStr, OsString};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use child_process::{Command, Env, EnvPolicy, Output, RunError, Runner, empty_work_dir};
use jiff::tz::TimeZone;
use protocol::js::number_to_string;
use protocol::{FleetAgentKind, UsageReading};
use tokio_util::sync::CancellationToken;

use super::{agy_probe, claude_probe, codex_probe};
use crate::Clock;

/// What a probe answers: a reading per account (`usage_key`), TypeScript's
/// `Record<string, UsageReading>`.
pub type Readings = BTreeMap<String, UsageReading>;

/// A probe's run: the readings, or the text a failure leaves in the accounts' `error`.
pub type ProbeFuture = Pin<Box<dyn Future<Output = Result<Readings, String>> + Send>>;

/// Reads the readings a CLI can give on demand: what it returns replaces everything known of that
/// CLI but cooldowns.
pub type UsageProbe = Arc<dyn Fn() -> ProbeFuture + Send + Sync>;

/// Where a probe runs and what it starts. The folder is the probe's own, emptied before each run
/// ([`empty_work_dir`]); the tracker asks one probe of a kind at a time, so a kind's runs share it.
/// The CLI gets only the environment it needs from `env` (`child_env`, `claude_env`): an API key
/// there would make the CLI answer for the API, not the person's plan.
#[derive(Clone)]
pub struct ProbeOptions {
    pub work_dir: PathBuf,
    /// The CLI to start; its own name (`codex`, `agy`, `claude`) looked up in `env`'s `PATH` when
    /// `None`.
    pub command: Option<OsString>,
    /// The server's environment, which the probe filters.
    pub env: Env,
    /// Where a reading's `readAt` and the year of claude's reset come from.
    pub clock: Arc<dyn Clock>,
    /// The zone `Date.parse` reads a time without an offset in (agy's `reset_time`); the server's.
    pub time_zone: TimeZone,
}

impl ProbeOptions {
    /// A probe in `work_dir` that starts the CLI by its own name, in the server's zone.
    pub fn new(work_dir: impl Into<PathBuf>, env: Env, clock: Arc<dyn Clock>) -> Self {
        Self {
            work_dir: work_dir.into(),
            command: None,
            env,
            clock,
            time_zone: TimeZone::system(),
        }
    }

    pub(crate) fn command_or<'a>(&'a self, name: &'a str) -> &'a OsStr {
        self.command.as_deref().unwrap_or(OsStr::new(name))
    }
}

/// The probes the server runs, each in `<state_dir>/usage-probe/<kind>`: codex, agy and claude.
/// cursor has none: its `/usage` is typed into a live pane, so it is never refreshed
/// automatically.
pub fn default_probes(
    state_dir: &Path,
    env: &Env,
    clock: Arc<dyn Clock>,
) -> HashMap<FleetAgentKind, UsageProbe> {
    let options = |kind: &str| {
        ProbeOptions::new(
            state_dir.join("usage-probe").join(kind),
            env.clone(),
            Arc::clone(&clock),
        )
    };
    HashMap::from([
        (FleetAgentKind::Codex, codex_probe(options("codex"))),
        (FleetAgentKind::Agy, agy_probe(options("agy"))),
        (FleetAgentKind::Claude, claude_probe(options("claude"))),
    ])
}

/// The text of a probe that did not answer within its time limit.
pub(crate) fn did_not_answer(name: &str, timeout: Duration) -> String {
    format!(
        "{name} did not answer within {}s",
        number_to_string(timeout.as_secs_f64())
    )
}

/// Runs `program args` in the probe's emptied folder with `env` alone, and returns what it wrote
/// when it exits with 0 (TypeScript's `run`, `server/fleet/usage.ts:403`).
pub(crate) async fn run_cli(
    options: &ProbeOptions,
    runner: &Runner,
    program: &OsStr,
    args: &[&str],
    env: Env,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    empty_work_dir(&options.work_dir).map_err(|error| error.to_string())?;
    let name = program.to_string_lossy();
    let command =
        Command::new(program, &options.work_dir, EnvPolicy::Only(env), timeout).args(args);
    match runner.run(command, &CancellationToken::new()).await {
        Ok(Output {
            code: Some(0),
            stdout,
            ..
        }) => Ok(stdout),
        Ok(Output {
            code: Some(code), ..
        }) => Err(format!("{name} exited with {code}")),
        Ok(Output { code: None, .. }) => Err(format!("{name} was ended by a signal")),
        Err(RunError::TimedOut) => Err(did_not_answer(&name, timeout)),
        Err(error) => Err(format!("{name}: {error}")),
    }
}

/// JavaScript's truthiness of a JSON value (`output.is_error`, `message.error`).
pub(crate) fn truthy(value: &serde_json::Value) -> bool {
    use serde_json::Value;
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
