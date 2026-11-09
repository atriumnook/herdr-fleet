//! Each agent CLI's own list of the models it offers (`server/fleet/model-lists.ts`). Every
//! command here answers from the CLI's catalog or its account, none calls a model: `codex
//! app-server` `model/list`, `agy models`, `cursor-agent models`, `pi --list-models`, the running
//! `opencode` service. Claude Code has no such command, so its aliases are the list (`claude
//! --help` names them).
//!
//! Each CLI runs through child-process's runner, in its own folder emptied before the run, with
//! only the environment it needs (`child_env`), as a usage probe does: an API key there would make
//! the CLI list another account's models. The parsers sit next to the commands whose output they
//! read (ADR 0107-crate-split).

use std::ffi::OsString;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use child_process::opencode::{OpencodeCliOptions, opencode_api_get};
use child_process::{Command, Env, EnvPolicy, RunError, Runner, Session, StreamLimit, child_env};
use protocol::{FleetAgentKind, ListedModel};
use regex::Regex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

/// How long a listing CLI may run (`TIMEOUT_MS`, `server/fleet/model-lists.ts:14`).
const TIMEOUT: Duration = Duration::from_secs(20);

/// How long opencode waits before it asks a service again that answered an empty list
/// (`retryAfterMs ?? 2000`, `server/fleet/model-lists.ts:115`).
const RETRY_AFTER: Duration = Duration::from_secs(2);

/// codex's `model/list` is followed no further than the answer with this id
/// (`message.id > 50`, `server/fleet/model-lists.ts:153`).
const LAST_CODEX_PAGE_ID: i64 = 50;

/// Where a listing runs and what it starts (`ListOptions`, `server/fleet/model-lists.ts:23`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListOptions {
    /// the CLI's own folder, emptied before each run
    pub work_dir: PathBuf,
    /// the CLI's program; its usual name when `None`
    pub command: Option<OsString>,
    /// the server's environment, of which the CLI gets [`child_env`] and what it needs besides
    pub env: Env,
    /// how long opencode waits before it asks a service again that answered an empty list
    pub retry_after: Duration,
}

impl ListOptions {
    /// A listing in `work_dir`, given the server's `env`, with the CLI's usual name and a wait of 2
    /// seconds before opencode asks again.
    pub fn new(work_dir: impl Into<PathBuf>, env: Env) -> Self {
        Self {
            work_dir: work_dir.into(),
            command: None,
            env,
            retry_after: RETRY_AFTER,
        }
    }

    fn program(&self, name: &str) -> OsString {
        self.command.clone().unwrap_or_else(|| name.into())
    }
}

/// What a listing gives: the models, or why the CLI could not be asked (the text a
/// [`ModelListing`](protocol::ModelListing)'s `error` shows, as TypeScript's `Error.message`).
pub type ListFuture = Pin<Box<dyn Future<Output = Result<Vec<ListedModel>, String>> + Send>>;

/// A CLI's own list of its models (`models` of an adapter, `server/fleet/adapters.ts:83`, which
/// ADR 0242-phase-3-split moved here). `complete`: the list is all the CLI takes, so a model it
/// lacks will not run.
#[derive(Clone)]
pub struct ModelSource {
    pub complete: bool,
    /// Starts a listing. The catalog calls it at once, when it starts the ask, and then awaits the
    /// future in a task of its own.
    pub list: Arc<dyn Fn(ListOptions) -> ListFuture + Send + Sync>,
}

impl std::fmt::Debug for ModelSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ModelSource")
            .field("complete", &self.complete)
            .finish_non_exhaustive()
    }
}

/// Each CLI's list, as its adapter names it (`server/fleet/adapters.ts:150, 182, 223, 256, 354,
/// 438`): complete for codex, cursor and agy; pi takes patterns besides the names it lists, claude
/// full model names besides its aliases, and opencode any `provider/model`.
pub fn source_for(kind: FleetAgentKind) -> ModelSource {
    fn source<F, Fut>(complete: bool, list: F) -> ModelSource
    where
        F: Fn(ListOptions) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Vec<ListedModel>, String>> + Send + 'static,
    {
        ModelSource {
            complete,
            list: Arc::new(move |options| Box::pin(list(options))),
        }
    }
    match kind {
        FleetAgentKind::Pi => source(
            false,
            |options| async move { list_pi_models(&options).await },
        ),
        FleetAgentKind::Claude => source(false, |_options| async { Ok(claude_aliases()) }),
        FleetAgentKind::Codex => {
            source(
                true,
                |options| async move { list_codex_models(&options).await },
            )
        }
        FleetAgentKind::Cursor => {
            source(
                true,
                |options| async move { list_cursor_models(&options).await },
            )
        }
        FleetAgentKind::Agy => source(
            true,
            |options| async move { list_agy_models(&options).await },
        ),
        FleetAgentKind::Opencode => source(false, |options| async move {
            list_opencode_models(&options).await
        }),
    }
}

/// What `claude --model` takes by name (see `claude --help`); full model names work too
/// (`CLAUDE_ALIASES`, `server/fleet/model-lists.ts:44`).
const CLAUDE_ALIASES: [&str; 4] = ["fable", "opus", "sonnet", "haiku"];

fn claude_aliases() -> Vec<ListedModel> {
    CLAUDE_ALIASES
        .iter()
        .map(|alias| unlabelled(alias))
        .collect()
}

fn unlabelled(id: &str) -> ListedModel {
    ListedModel {
        id: id.to_owned(),
        label: None,
    }
}

fn labelled(id: &str, label: &str) -> ListedModel {
    ListedModel {
        id: id.to_owned(),
        label: Some(label.to_owned()),
    }
}

/// The zero-width characters cursor's and agy's names may carry (`invisible`,
/// `server/fleet/model-lists.ts:46`: U+200B to U+200F, U+2060 and U+FEFF).
fn visible(line: &str) -> String {
    line.chars()
        .filter(|c| !matches!(c, '\u{200b}'..='\u{200f}' | '\u{2060}' | '\u{feff}'))
        .collect()
}

/// JavaScript's white space (`\s`, and what `String.prototype.trim` removes): Unicode's
/// White_Space without U+0085, and U+FEFF.
fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

/// `agy models`: `<id>\t<name>` per line after a progress line (`parseAgyModels`,
/// `server/fleet/model-lists.ts:49`).
pub fn parse_agy_models(output: &str) -> Vec<ListedModel> {
    output
        .split('\n')
        .filter_map(|line| {
            let line = visible(line);
            let mut parts = line.split('\t');
            let (id, label) = (parts.next()?, parts.next()?);
            // `^[\w.-]+$`, with JavaScript's ASCII `\w`
            let named = !id.is_empty()
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
            (named && !label.is_empty()).then(|| labelled(id, js_trim(label)))
        })
        .collect()
}

/// `cursor-agent models`: `<id> - <name>` per line under a heading (`parseCursorModels`,
/// `server/fleet/model-lists.ts:62`).
pub fn parse_cursor_models(output: &str) -> Vec<ListedModel> {
    // JavaScript's ASCII `\w`, and its `.`, which stops at any line terminator
    static LINE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^([A-Za-z0-9_.\[\]=,-]+) - ([^\n\r\u{2028}\u{2029}]+)$").unwrap()
    });
    output
        .split('\n')
        .filter_map(|line| {
            let line = visible(line);
            let found = LINE.captures(js_trim(&line))?;
            Some(labelled(&found[1], js_trim(&found[2])))
        })
        .collect()
}

/// `pi --list-models`: a table of `provider model ...` (`parsePiModels`,
/// `server/fleet/model-lists.ts:78`). pi takes `provider/model` and also patterns (`sonnet:high`),
/// so this is a list of names it accepts, not all of them.
pub fn parse_pi_models(output: &str) -> Vec<ListedModel> {
    output
        .split('\n')
        .skip(1)
        .filter_map(|line| {
            let mut words = js_trim(line)
                .split(js_space)
                .filter(|word| !word.is_empty());
            let (provider, model) = (words.next()?, words.next()?);
            Some(unlabelled(&format!("{provider}/{model}")))
        })
        .collect()
}

/// OpenCode 2's `GET /api/model`: the models of the providers that are signed in,
/// `provider/model` each (`parseOpencodeModels`, `server/fleet/model-lists.ts:97`). A `#variant`
/// after a model name runs it and is not listed here. Not a complete list: it is what the service
/// has loaded when it is asked, and the TUI accepts any `provider/model` text.
pub fn parse_opencode_models(body: &Value) -> Vec<ListedModel> {
    let Some(data) = body.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    data.iter()
        .filter_map(|model| {
            let provider = model.get("providerID")?.as_str()?;
            let id = model.get("id")?.as_str()?;
            // `^[^\s/#]+$` and `^\S+$` without `#`
            let provider_ok = !provider.is_empty()
                && !provider
                    .chars()
                    .any(|c| js_space(c) || c == '/' || c == '#');
            let id_ok = !id.is_empty() && !id.chars().any(|c| js_space(c) || c == '#');
            (provider_ok && id_ok).then(|| unlabelled(&format!("{provider}/{id}")))
        })
        .collect()
}

/// One page of codex's `model/list`: its models, and where the next begins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexPage {
    pub models: Vec<ListedModel>,
    pub next: Option<String>,
}

/// codex's `model/list` result (`parseCodexModels`, `server/fleet/model-lists.ts:116`). A
/// model's `model` is its slug, what `--model` takes; `displayName` is its label.
pub fn parse_codex_models(result: &Value) -> CodexPage {
    fn non_empty(value: Option<&Value>) -> Option<&str> {
        value?.as_str().filter(|text| !text.is_empty())
    }
    let models = result
        .get("data")
        .and_then(Value::as_array)
        .map(|data| {
            data.iter()
                .filter_map(|each| {
                    let id = non_empty(each.get("model"))?;
                    Some(match non_empty(each.get("displayName")) {
                        Some(label) => labelled(id, label),
                        None => unlabelled(id),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    CodexPage {
        models,
        next: non_empty(result.get("nextCursor")).map(str::to_owned),
    }
}

/// Makes the CLI's folder (0700) or empties it, off the async threads.
async fn prepare(work_dir: &Path) -> Result<(), String> {
    let dir = work_dir.to_owned();
    tokio::task::spawn_blocking(move || child_process::empty_work_dir(&dir))
        .await
        .unwrap_or_else(|error| Err(io::Error::other(error)))
        .map_err(|error| error.to_string())
}

/// Runs `<program> <verb>` in the listing's folder, emptied first, with `env` and nothing else,
/// and returns what it wrote (`run`, `server/fleet/model-lists.ts:30`). The standard error is read
/// and dropped. A CLI that exits with an error, or is stopped at the time limit, fails the listing
/// as `<program> <verb> failed`, as TypeScript's kill makes it exit with one.
async fn run(name: &str, verb: &str, options: &ListOptions, env: Env) -> Result<String, String> {
    prepare(&options.work_dir).await?;
    let program = options.program(name);
    let failed = format!("{} {verb} failed", program.to_string_lossy());
    let command = Command::new(&program, &options.work_dir, EnvPolicy::Only(env), TIMEOUT)
        .arg(verb)
        .stderr_limit(StreamLimit::Head(0));
    match Runner::new(1).run(command, &CancellationToken::new()).await {
        Ok(output) if output.code == Some(0) => {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        Ok(_) | Err(RunError::TimedOut) => Err(failed),
        Err(error) => Err(format!("{} {verb}: {error}", program.to_string_lossy())),
    }
}

/// `agy models`, with its self-update held off (`true`, not `1`), as for agy's usage probe
/// (`listAgyModels`, `server/fleet/model-lists.ts:57`).
async fn list_agy_models(options: &ListOptions) -> Result<Vec<ListedModel>, String> {
    let mut env = child_env(&options.env, &[]);
    env.insert("AGY_CLI_DISABLE_AUTO_UPDATE".into(), "true".into());
    Ok(parse_agy_models(&run("agy", "models", options, env).await?))
}

/// `cursor-agent models` (`listCursorModels`, `server/fleet/model-lists.ts:69`).
async fn list_cursor_models(options: &ListOptions) -> Result<Vec<ListedModel>, String> {
    let env = child_env(&options.env, &[]);
    Ok(parse_cursor_models(
        &run("cursor-agent", "models", options, env).await?,
    ))
}

/// `pi --list-models`; pi keeps its sign-in under `PI_CODING_AGENT_DIR`, which passes when set
/// (`listPiModels`, `server/fleet/model-lists.ts:84`).
async fn list_pi_models(options: &ListOptions) -> Result<Vec<ListedModel>, String> {
    let env = child_env(&options.env, &["PI_CODING_AGENT_DIR"]);
    Ok(parse_pi_models(
        &run("pi", "--list-models", options, env).await?,
    ))
}

/// Asks the person's running background service, through C2's `opencode api` client, which
/// starts no server of ours: no service running is no list, and a 1.x opencode, which does not
/// know the `service` command, fails the same way (`listOpencodeModels`,
/// `server/fleet/model-lists.ts:108`). A place the service has not loaded yet answers `[]` to the
/// first question (seen on 2.0.26: 0 models, then 56 three seconds later), so an empty list is
/// asked again once after [`ListOptions::retry_after`]; a second empty list is no list for now,
/// and the catalog asks again after its failure interval.
async fn list_opencode_models(options: &ListOptions) -> Result<Vec<ListedModel>, String> {
    let mut cli = OpencodeCliOptions::new(&options.work_dir, options.env.clone());
    cli.command = options.program("opencode");
    let ask = |cli: OpencodeCliOptions| async move {
        opencode_api_get(cli, "/api/model")
            .await
            .map(|body| parse_opencode_models(&body))
            .map_err(|error| error.to_string())
    };
    let first = ask(cli.clone()).await?;
    if !first.is_empty() {
        return Ok(first);
    }
    tokio::time::sleep(options.retry_after).await;
    ask(cli).await
}

/// `codex app-server` over stdio: initialize, then `model/list` page by page, hidden models too
/// (they run); codex keeps its sign-in under `CODEX_HOME`, which passes when set
/// (`listCodexModels`, `server/fleet/model-lists.ts:127`). The session ends with SIGTERM once the
/// last page is read, as TypeScript's `finally` kills the child.
async fn list_codex_models(options: &ListOptions) -> Result<Vec<ListedModel>, String> {
    prepare(&options.work_dir).await?;
    let env = child_env(&options.env, &["CODEX_HOME"]);
    let command = Command::new(
        options.program("codex"),
        &options.work_dir,
        EnvPolicy::Only(env),
        TIMEOUT,
    )
    .arg("app-server");
    let mut session = Runner::new(1)
        .session(command, &CancellationToken::new())
        .await
        .map_err(|error| format!("codex app-server: {error}"))?;
    let listed = codex_exchange(&mut session).await;
    session.close().await;
    listed
}

/// The JSON-RPC exchange of [`list_codex_models`].
async fn codex_exchange(session: &mut Session) -> Result<Vec<ListedModel>, String> {
    let broken = |error: RunError| format!("codex app-server: {error}");
    let send = |message: Value| {
        let mut line = json!({ "jsonrpc": "2.0" });
        if let (Some(line), Value::Object(message)) = (line.as_object_mut(), message) {
            line.extend(message);
        }
        line.to_string()
    };
    session
        .send_line(&send(json!({
            "id": 1,
            "method": "initialize",
            "params": { "clientInfo": { "name": "herdr-fleet", "version": "0" } },
        })))
        .await
        .map_err(broken)?;
    let mut models = Vec::new();
    loop {
        let Some(line) = session.next_line().await.map_err(broken)? else {
            return Err("codex app-server closed before it answered".to_owned());
        };
        // a line that is not JSON, or JSON that is not an object, is no answer
        let Ok(Value::Object(message)) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        // a notification or a request of the server's own is not an answer to ours
        if message.contains_key("method")
            || (!message.contains_key("result") && !message.contains_key("error"))
        {
            continue;
        }
        let id = message.get("id").and_then(Value::as_i64);
        if id == Some(1) {
            session
                .send_line(&send(json!({ "method": "initialized" })))
                .await
                .map_err(broken)?;
            session
                .send_line(&send(json!({
                    "id": 2,
                    "method": "model/list",
                    "params": { "includeHidden": true },
                })))
                .await
                .map_err(broken)?;
        } else if let Some(id) = id.filter(|id| *id >= 2) {
            if let Some(error) = message.get("error").filter(|error| truthy(error)) {
                let said = match error.get("message") {
                    None | Some(Value::Null) => "models unavailable".to_owned(),
                    Some(Value::String(text)) => text.clone(),
                    Some(other) => other.to_string(),
                };
                return Err(format!("codex: {said}"));
            }
            let page = parse_codex_models(message.get("result").unwrap_or(&Value::Null));
            models.extend(page.models);
            match page.next {
                Some(next) if id <= LAST_CODEX_PAGE_ID => {
                    session
                        .send_line(&send(json!({
                            "id": id + 1,
                            "method": "model/list",
                            "params": { "includeHidden": true, "cursor": next },
                        })))
                        .await
                        .map_err(broken)?;
                }
                _ => return Ok(models),
            }
        }
    }
}

/// JavaScript's truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
