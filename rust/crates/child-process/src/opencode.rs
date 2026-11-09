//! Reads of the person's running OpenCode 2 background service through the CLI's own
//! `opencode api`, which finds the service and signs in to it, so this process holds no credential
//! (`server/opencode-cli.ts`). The one place the CLI is run from, for the model list and the
//! conversation.
//!
//! `opencode api` starts the service when none runs: `opencode service status` (a read) asks
//! first, and no service means no read. A 1.x `opencode` does not know `service`, exits with an
//! error, and counts as no service.
//!
//! The signatures are final (ADR 0246-child-process-interface); issue #253 (C2) writes the bodies
//! with the runner. There is no trait here: the conversation reader takes transcript's
//! `OpencodeApi`, which the core implements by wrapping [`OpencodeCli`] (ADR 0107-crate-split).
//! transcript's trait is synchronous: the core calls these functions with tokio's
//! `Handle::block_on` from inside `spawn_blocking` only (from an async task it panics).

use std::ffi::OsString;
use std::fmt;
use std::io;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use crate::{
    Command, Env, EnvPolicy, KILL_GRACE, Output, RunError, Runner, Stream, StreamLimit, child_env,
    empty_work_dir,
};

/// `CLI_TIMEOUT_MS`, `server/opencode-cli.ts:14`.
const CLI_TIMEOUT: Duration = Duration::from_secs(20);

/// A reply larger than this is no reply: 100 messages with a few large outputs is a few MB
/// (`MAX_REPLY_BYTES`, `server/opencode-cli.ts:18`). [`OpencodeCli`]'s limit when the options name
/// none.
const MAX_REPLY_BYTES: usize = 32 * 1024 * 1024;

/// A model list is tens of KB: far less than a page of messages (`MODEL_REPLY_BYTES`,
/// `server/opencode-cli.ts:175`). [`opencode_api_get`]'s limit when the options name none.
const MODEL_REPLY_BYTES: usize = 8 * 1024 * 1024;

/// `MAX_CHILDREN`, `server/opencode-cli.ts:19`.
const MAX_CHILDREN: usize = 4;

/// `opencode service status` is asked at most this often: under the chat's own poll interval
/// (`SERVICE_TTL_MS`, `server/opencode-cli.ts:21`).
const SERVICE_TTL: Duration = Duration::from_secs(1);

/// What is kept of the CLI's standard error: its first 4096 bytes (`readUpTo(child.stderr, 4096)`,
/// `server/opencode-cli.ts:128`). TypeScript keeps nothing of a longer one; the head is kept here,
/// where the start of a failure is said (the runner's `Head`, ADR 0246-child-process-interface).
const STDERR_BYTES: usize = 4096;

/// A GET that did not answer with a body: the same two cases as transcript's `OpencodeError`, so
/// the core's conversion copies the fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpencodeError {
    /// The CLI answered with an HTTP error: its status code (0 when it named none), and the body's
    /// `_tag` ("" when it had none).
    Http { status: u16, tag: String },
    /// The read failed some other way: no service, no JSON, a time-out, a reply too large.
    Other(String),
}

impl fmt::Display for OpencodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http { status, tag } if tag.is_empty() => {
                write!(formatter, "opencode api answered {status}")
            }
            Self::Http { status, tag } => write!(formatter, "opencode api answered {status} {tag}"),
            Self::Other(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for OpencodeError {}

/// Where and how the CLI runs (`OpencodeCliOptions`, `server/opencode-cli.ts:38`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodeCliOptions {
    /// the CLI's own folder, emptied before the first run; the CLI runs nowhere else
    pub work_dir: PathBuf,
    /// `opencode` unless told otherwise
    pub command: OsString,
    /// the server's environment, of which the CLI gets `child_env` and
    /// `OPENCODE_DISABLE_AUTOUPDATE=true`
    pub env: Env,
    /// how often a reply that exited 0 but is not JSON is read in all (3)
    pub attempts: u32,
    /// 20 seconds
    pub timeout: Duration,
    /// [`KILL_GRACE`](crate::KILL_GRACE)
    pub kill_grace: Duration,
    /// a reply larger than this is no reply; `None`: 32 MiB for [`OpencodeCli`], 8 MiB for
    /// [`opencode_api_get`] (a model list), as `server/opencode-cli.ts:179` puts it in when the
    /// caller names none
    pub max_reply_bytes: Option<usize>,
    /// CLIs running at once, whatever the number of panels and panes asking (4)
    pub max_children: usize,
}

impl OpencodeCliOptions {
    /// The options of `server/opencode-cli.ts` for a CLI in `work_dir`, given the server's `env`.
    pub fn new(work_dir: impl Into<PathBuf>, env: Env) -> Self {
        Self {
            work_dir: work_dir.into(),
            command: "opencode".into(),
            env,
            attempts: 3,
            timeout: CLI_TIMEOUT,
            kill_grace: KILL_GRACE,
            max_reply_bytes: None,
            max_children: MAX_CHILDREN,
        }
    }
}

/// `opencode api GET <path>` and `opencode service status` (`opencodeCli`,
/// `server/opencode-cli.ts:85`), run as a usage probe is: in a folder of ours, with only the
/// environment the CLI needs to find its service (HOME, XDG_*). Not OPENCODE_*: a person who moves
/// OpenCode's state with those would have this look at another service than their pane uses, and
/// read "stopped" (the pane stays on its scrollback).
///
/// The CLI writes its reply and exits without waiting for the pipe to drain, so a large reply to a
/// pipe can arrive cut. A reply that exited 0 and is not JSON is read again. A CLI that timed out,
/// exited with an error, or answered too much is not: the same call would take as long again.
///
/// A reply is JSON as serde_json reads it: a lone surrogate escape or a number past f64, which
/// `JSON.parse` reads, is no JSON here (ADR 0193-phase-2-dependencies), and so is one nested deeper
/// than serde_json's 128 levels, which `JSON.parse` also reads (the `unbounded_depth` feature is
/// not in the manifest). Each of these exits 0 and is read `attempts` times before it fails.
#[derive(Debug)]
pub struct OpencodeCli {
    work_dir: PathBuf,
    command: OsString,
    /// what the CLI gets: `child_env` of the server's, and no self-update
    env: Env,
    attempts: u32,
    timeout: Duration,
    kill_grace: Duration,
    max_reply_bytes: usize,
    runner: Runner,
    /// set once the folder is emptied: once per client, so a second read of this client does not
    /// empty it under a first one still running. Another client given the same folder empties it
    /// again, as in TypeScript: `opencode_api_get` makes a client per call, and its caller (the
    /// model list) reads one list at a time
    prepared: tokio::sync::OnceCell<()>,
    /// the last answer of `service status`; held while a question is out, so callers asking at
    /// once wait for it and share its answer
    service: tokio::sync::Mutex<Option<ServiceAnswer>>,
}

#[derive(Debug, Clone, Copy)]
struct ServiceAnswer {
    at: Instant,
    running: bool,
}

impl OpencodeCli {
    /// # Panics
    ///
    /// When `options.max_children` is 0: nothing would ever run ([`Runner::new`]).
    pub fn new(options: OpencodeCliOptions) -> Self {
        let mut env = child_env(&options.env, &[]);
        env.insert("OPENCODE_DISABLE_AUTOUPDATE".into(), "true".into());
        Self {
            work_dir: options.work_dir,
            command: options.command,
            env,
            attempts: options.attempts,
            timeout: options.timeout,
            kill_grace: options.kill_grace,
            max_reply_bytes: options.max_reply_bytes.unwrap_or(MAX_REPLY_BYTES),
            runner: Runner::new(options.max_children),
            prepared: tokio::sync::OnceCell::new(),
            service: tokio::sync::Mutex::new(None),
        }
    }

    /// The parsed JSON body of a GET.
    pub async fn get(&self, path: &str) -> Result<serde_json::Value, OpencodeError> {
        let mut attempt = 1;
        loop {
            let output = self.run(&["api", "GET", path]).await?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let body: serde_json::Value = match serde_json::from_str(&stdout) {
                Ok(body) => body,
                Err(_) if output.code == Some(0) && attempt < self.attempts => {
                    attempt += 1;
                    continue;
                }
                Err(_) => {
                    let exit = output
                        .code
                        .map_or_else(|| "by a signal".to_owned(), |code| code.to_string());
                    let said = if js_trim(&stderr).is_empty() {
                        String::new()
                    } else {
                        format!(": {}", head(&stderr))
                    };
                    return Err(OpencodeError::Other(format!(
                        "opencode api returned no JSON (exit {exit}{said})"
                    )));
                }
            };
            if output.code == Some(0) {
                return Ok(body);
            }
            return Err(OpencodeError::Http {
                status: http_status(&stderr),
                tag: tag(&body),
            });
        }
    }

    /// Whether the background service answers; never starts it. The answer is kept for a second,
    /// and callers asking at once share one question.
    pub async fn service_running(&self) -> bool {
        let asked = Instant::now();
        let mut service = self.service.lock().await;
        // an answer given after this call asked is the question it waited on
        if let Some(answer) = *service
            && (answer.at >= asked || answer.at.elapsed() < SERVICE_TTL)
        {
            return answer.running;
        }
        // a status that cannot be asked is a service not known to run
        let running = self
            .run(&["service", "status"])
            .await
            .is_ok_and(|output| output.code == Some(0) && names_a_url(&output.stdout));
        *service = Some(ServiceAnswer {
            at: Instant::now(),
            running,
        });
        running
    }

    /// Runs the CLI with `args` in its folder, emptied before its first run.
    async fn run(&self, args: &[&str]) -> Result<Output, OpencodeError> {
        let verb = args[0];
        // off the async threads: removing what a run before left is file system work
        self.prepared
            .get_or_try_init(|| async {
                let dir = self.work_dir.clone();
                tokio::task::spawn_blocking(move || empty_work_dir(&dir))
                    .await
                    .unwrap_or_else(|error| Err(io::Error::other(error)))
            })
            .await
            .map_err(|error| {
                OpencodeError::Other(format!(
                    "opencode {verb}: {}: {error}",
                    self.work_dir.display()
                ))
            })?;
        let command = Command::new(
            &self.command,
            &self.work_dir,
            EnvPolicy::Only(self.env.clone()),
            self.timeout,
        )
        .args(args)
        .kill_grace(self.kill_grace)
        .stdout_limit(StreamLimit::Fail(self.max_reply_bytes))
        .stderr_limit(StreamLimit::Head(STDERR_BYTES));
        self.runner
            .run(command, &CancellationToken::new())
            .await
            .map_err(|error| {
                OpencodeError::Other(match error {
                    RunError::TimedOut => format!("opencode {verb} timed out"),
                    RunError::TooLarge {
                        stream: Stream::Stdout,
                        limit,
                    } => format!("opencode {verb} answered more than {limit} bytes"),
                    error => format!("opencode {verb}: {error}"),
                })
            })
    }
}

/// The JSON body of `opencode api GET <path>` on the running service, in a folder emptied for the
/// call; fails when no service runs, or it answers with an error or no JSON (`opencodeApiGet`,
/// `server/opencode-cli.ts:178`). With no `max_reply_bytes`, a reply is at most 8 MiB.
pub async fn opencode_api_get(
    mut options: OpencodeCliOptions,
    path: &str,
) -> Result<serde_json::Value, OpencodeError> {
    options.max_reply_bytes.get_or_insert(MODEL_REPLY_BYTES);
    let cli = OpencodeCli::new(options);
    if !cli.service_running().await {
        return Err(OpencodeError::Other(
            "no OpenCode service is running".into(),
        ));
    }
    cli.get(path).await
}

/// Whether `service status` printed the service's URL (`/^https?:\/\//` on the trimmed output).
fn names_a_url(stdout: &[u8]) -> bool {
    let text = String::from_utf8_lossy(stdout);
    let text = js_trim(&text);
    text.starts_with("http://") || text.starts_with("https://")
}

/// The status code of `HTTP <3 digits>` in what the CLI said, or 0 when it names none
/// (`/HTTP (\d{3})/`, `server/opencode-cli.ts:151`).
fn http_status(stderr: &str) -> u16 {
    stderr
        .match_indices("HTTP ")
        .find_map(|(at, found)| {
            let digits = stderr.get(at + found.len()..at + found.len() + 3)?;
            if digits.bytes().all(|byte| byte.is_ascii_digit()) {
                digits.parse().ok()
            } else {
                None
            }
        })
        .unwrap_or(0)
}

/// The body's `_tag`, or "" when it is not an object or has none (`String(record(body)["_tag"] ??
/// "")`, `server/opencode-cli.ts:152`). A tag that is not a string is written as `String` writes
/// it.
fn tag(body: &serde_json::Value) -> String {
    match body.get("_tag") {
        None | Some(serde_json::Value::Null) => String::new(),
        Some(tag) => js_string(tag),
    }
}

/// JavaScript's `String(value)` of what `JSON.parse` gives: an array is its items joined with `,`
/// (null as ""), an object `[object Object]`, a number as `Number.prototype.toString` writes it.
fn js_string(value: &serde_json::Value) -> String {
    use serde_json::Value;
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(number) => js_number(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                item => js_string(item),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `Number.prototype.toString()` of a finite number: the shortest digits that read back as it, in
/// plain notation from 1e-6 up to 1e21 and in exponent notation (`1e+21`, `1e-7`) outside.
fn js_number(number: f64) -> String {
    if number == 0.0 {
        // -0 too
        return "0".to_owned();
    }
    let size = number.abs();
    if (1e-6..1e21).contains(&size) {
        return number.to_string();
    }
    let written = format!("{number:e}");
    match written.split_once('e') {
        Some((digits, exponent)) if !exponent.starts_with('-') => format!("{digits}e+{exponent}"),
        _ => written,
    }
}

/// The head of what a CLI said on stderr, as one printable line: each run of characters outside
/// printable ASCII made one space, trimmed, at most 200 characters (`head`,
/// `server/opencode-cli.ts:54`).
fn head(text: &str) -> String {
    let mut line = String::with_capacity(text.len().min(1024));
    let mut in_run = false;
    for c in text.chars() {
        if (' '..='~').contains(&c) {
            line.push(c);
            in_run = false;
        } else if !in_run {
            line.push(' ');
            in_run = true;
        }
    }
    line.trim_matches(' ').chars().take(200).collect()
}

/// `String.prototype.trim`: JavaScript's white space and line terminators, which are Unicode's
/// White_Space without U+0085, and U+FEFF.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}
