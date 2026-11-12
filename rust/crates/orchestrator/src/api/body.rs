//! The checks `server/fleet/api.ts` makes of a request's body and query before it calls the fleet:
//! each field's type, in TypeScript's order, so the first fault found is the one TypeScript names.

use std::sync::LazyLock;

use protocol::js::trim;
use protocol::{FleetAgentKind, FleetSettingsPatch, LandAction, LineComment};
use regex::Regex;
use serde_json::{Map, Value};

use crate::FleetError;
use crate::brief::BriefDraft;
use crate::fleet::{SpawnRequest, ThreadRequest};
use crate::runtime::SplitDirection;

/// A request's body, a JSON object (`readBody`).
pub(crate) type Body = Map<String, Value>;

/// The most line comments one landing step takes (`COMMENTS_MAX`).
const COMMENTS_MAX: usize = 200;

/// The longest wait a timer of JavaScript's keeps, 2^31 - 1 ms (`TIMEOUT_MAX` of Node, which Bun
/// follows: `setTimeout` waits 1 ms for one past it).
const TIMER_MAX_MS: f64 = 2_147_483_647.0;

/// `readBody`: the body as a JSON object. Neither the content type nor the method is looked at. A
/// UTF-8 byte order mark before it is dropped, as the Fetch standard's `json()` decodes the bytes.
pub(crate) fn read_body(bytes: &[u8]) -> Result<Body, FleetError> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let parsed: Value = serde_json::from_slice(bytes)
        .map_err(|_| FleetError::new("invalid_json", "request body must be JSON"))?;
    match parsed {
        Value::Object(body) => Ok(body),
        _ => Err(invalid_body("request body must be a JSON object")),
    }
}

fn invalid_body(message: impl Into<String>) -> FleetError {
    FleetError::new("invalid_body", message)
}

/// `group(body)`: the body's `group` unless it is absent or null, else the query's; a group only
/// when it is a string that is not empty.
pub(crate) fn group(body: Option<&Body>, query: Option<&str>) -> Option<String> {
    match body.and_then(|body| body.get("group")) {
        Some(Value::Null) | None => query.filter(|value| !value.is_empty()).map(str::to_owned),
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        Some(_) => None,
    }
}

/// `text(key)` of `spawnRequest` and `threadRequest`: absent or null is none; anything else must be
/// a string.
fn text(body: &Body, key: &str) -> Result<Option<String>, FleetError> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(invalid_body(format!("{key} must be a string"))),
    }
}

/// `flag(key)` of `spawnRequest`: absent or null is none; anything else must be a boolean.
fn flag(body: &Body, key: &str) -> Result<Option<bool>, FleetError> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(invalid_body(format!("{key} must be true or false"))),
    }
}

/// A JSON number that `Number.isInteger` takes (`1.0` is one).
fn integer(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|number| number.is_finite() && number.fract() == 0.0)
}

/// `depth`: absent, or a whole number of at least 0 (null is refused, as `depth !== undefined`
/// lets it through to the type check). A depth past `u32::MAX` is kept as `u32::MAX`: the
/// fleet's depth limit refuses both alike.
fn depth(body: &Body) -> Result<Option<u32>, FleetError> {
    let Some(value) = body.get("depth") else {
        return Ok(None);
    };
    match integer(value) {
        Some(depth) if depth >= 0.0 => Ok(Some(depth.min(u32::MAX as f64) as u32)),
        _ => Err(invalid_body("depth must be a whole number")),
    }
}

/// `trim()` of JavaScript, then whether anything is left.
fn blank(text: &str) -> bool {
    trim(text).is_empty()
}

/// `spawnRequest`.
pub(crate) fn spawn_request(body: &Body) -> Result<SpawnRequest, FleetError> {
    let role = text(body, "role")?;
    let task = text(body, "task")?;
    let role = match role {
        Some(role) if !role.is_empty() => role,
        _ => return Err(FleetError::new("missing_role", "role is required")),
    };
    let brief = brief(body.get("brief"))?;
    if brief.is_none() && task.as_deref().is_none_or(blank) {
        return Err(FleetError::new("missing_task", "task is required"));
    }
    let direction = match text(body, "direction")?.as_deref() {
        None => None,
        Some("right") => Some(SplitDirection::Right),
        Some("down") => Some(SplitDirection::Down),
        Some(_) => return Err(invalid_body("direction must be right or down")),
    };
    let avoid = match body.get("avoid") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .map(|item| serde_json::from_value::<FleetAgentKind>(item.clone()).ok())
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| invalid_body("avoid must be a list of agent CLIs"))?,
        ),
        Some(_) => return Err(invalid_body("avoid must be a list of agent CLIs")),
    };
    let depth = depth(body)?;
    Ok(SpawnRequest {
        role,
        task,
        name: text(body, "name")?,
        model: text(body, "model")?,
        thinking: text(body, "thinking")?,
        cwd: text(body, "cwd")?,
        group: text(body, "group")?,
        caller_pane_id: text(body, "caller_pane_id")?,
        worktree: flag(body, "worktree")?,
        interactive: flag(body, "interactive")?,
        direction,
        depth,
        brief,
        avoid: avoid.filter(|avoid| !avoid.is_empty()),
    })
}

/// `threadRequest`.
pub(crate) fn thread_request(body: &Body) -> Result<ThreadRequest, FleetError> {
    let title = match text(body, "title")? {
        Some(title) if !blank(&title) => title,
        _ => return Err(FleetError::new("invalid_title", "title is required")),
    };
    let brief = brief(body.get("brief"))?;
    let task = text(body, "task")?;
    if brief.is_none() && task.as_deref().is_none_or(blank) {
        return Err(FleetError::new("missing_task", "task is required"));
    }
    let depth = depth(body)?;
    let caller_run = text(body, "caller_run")?.filter(|run| !run.is_empty());
    Ok(ThreadRequest {
        title,
        task,
        cwd: text(body, "cwd")?,
        brief,
        depth,
        caller_run,
    })
}

/// `briefOf`: the brief's fields as given, each checked for its type; which are missing is the
/// orchestrator's to say. An object with none of them is still a brief.
fn brief(value: Option<&Value>) -> Result<Option<BriefDraft>, FleetError> {
    let object = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(object)) => object,
        Some(_) => return Err(invalid_body("brief must be an object")),
    };
    let field = |key: &str| -> Result<Option<String>, FleetError> {
        match object.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value)) => Ok(Some(value.clone())),
            Some(_) => Err(invalid_body(format!("brief.{key} must be a string"))),
        }
    };
    let mut draft = BriefDraft {
        goal: field("goal")?,
        context: field("context")?,
        done: field("done")?,
        verify: field("verify")?,
        forbidden: field("forbidden")?,
        timebox: field("timebox")?,
        write: None,
    };
    draft.write = match object.get("write") {
        None | Some(Value::Null) => None,
        Some(Value::Array(paths)) => Some(
            paths
                .iter()
                .map(|path| path.as_str().filter(|path| !blank(path)).map(str::to_owned))
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| invalid_body("brief.write must be a list of paths"))?,
        ),
        Some(_) => return Err(invalid_body("brief.write must be a list of paths")),
    };
    Ok(Some(draft))
}

/// A herdr pane id, as the coordinator's input may carry it: nothing but an id's characters.
static PANE_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_:.-]{1,64}$").expect("the pane id pattern"));

/// What `POST /projects` takes: the task, and the folder and pane it came from when given.
pub(crate) struct ProjectRequest {
    pub task: String,
    pub cwd: Option<String>,
    pub from_pane: Option<String>,
}

/// The body of `POST /projects`.
pub(crate) fn project_request(body: &Body) -> Result<ProjectRequest, FleetError> {
    let task = match body.get("task") {
        Some(Value::String(task)) if !blank(task) => task.clone(),
        _ => return Err(FleetError::new("missing_task", "task is required")),
    };
    let cwd = match body.get("cwd") {
        None => None,
        Some(Value::String(cwd)) => Some(cwd.clone()).filter(|cwd| !cwd.is_empty()),
        Some(_) => return Err(invalid_body("cwd must be a string")),
    };
    let from_pane = match body.get("from_pane") {
        None => None,
        Some(Value::String(pane)) if PANE_ID.is_match(pane) => Some(pane.clone()),
        Some(_) => return Err(invalid_body("from_pane must be a herdr pane id")),
    };
    Ok(ProjectRequest {
        task,
        cwd,
        from_pane,
    })
}

/// `cwd` of `POST /settings`: absent, or a string (empty is the server's own folder).
pub(crate) fn optional_string(body: &Body, key: &str) -> Result<Option<String>, FleetError> {
    match body.get(key) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone()).filter(|value| !value.is_empty())),
        Some(_) => Err(invalid_body(format!("{key} must be a string"))),
    }
}

/// `all` of `POST /usage/refresh`, `resolved` of `POST /runs/:target/resolve`: absent, or a
/// boolean.
pub(crate) fn optional_bool(body: &Body, key: &str) -> Result<Option<bool>, FleetError> {
    match body.get(key) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(invalid_body(format!("{key} must be true or false"))),
    }
}

/// `key` of `POST /usage/clear`: absent, or a string that is not empty.
pub(crate) fn cooldown_key(body: &Body) -> Result<Option<String>, FleetError> {
    match body.get("key") {
        None => Ok(None),
        Some(Value::String(key)) if !key.is_empty() => Ok(Some(key.clone())),
        Some(_) => Err(invalid_body("key must be a non-empty string")),
    }
}

/// `message` of `POST /runs/:target/send`.
pub(crate) fn message(body: &Body) -> Result<String, FleetError> {
    match body.get("message") {
        Some(Value::String(message)) if !blank(message) => Ok(message.clone()),
        _ => Err(FleetError::new("missing_message", "message is required")),
    }
}

/// `timeout_ms` of `POST /runs/:target/wait`: absent, or a finite number of at least 1, in whole
/// milliseconds (a fraction is dropped; a timer of JavaScript's fires on the next millisecond too).
/// One past [`TIMER_MAX_MS`] waits 1 ms, as TypeScript's `setTimeout` does with it.
pub(crate) fn timeout_ms(body: &Body) -> Result<Option<u64>, FleetError> {
    match body.get("timeout_ms") {
        None => Ok(None),
        Some(value) => match value.as_f64() {
            Some(timeout) if timeout.is_finite() && timeout >= 1.0 => {
                Ok(Some(if timeout > TIMER_MAX_MS {
                    1
                } else {
                    timeout as u64
                }))
            }
            _ => Err(FleetError::new(
                "invalid_timeout",
                "timeout_ms must be a positive number",
            )),
        },
    }
}

/// `action` of `POST /runs/:target/land`.
pub(crate) fn land_action(body: &Body) -> Result<LandAction, FleetError> {
    body.get("action")
        .filter(|action| action.is_string())
        .and_then(|action| serde_json::from_value::<LandAction>(action.clone()).ok())
        .ok_or_else(|| {
            FleetError::new(
                "invalid_action",
                "action must be one of update, pr, fix-ci, comments, merge, merge-pr, discard",
            )
        })
}

/// `lineComments`: absent or null is none; else up to [`COMMENTS_MAX`] of `{ file, line,
/// removed?, text }`, `removed` kept only when true. A line past `u32::MAX` is refused: no file
/// the fleet diffs has that many.
pub(crate) fn line_comments(body: &Body) -> Result<Vec<LineComment>, FleetError> {
    let refused = || {
        invalid_body(format!(
            "comments must be up to {COMMENTS_MAX} of {{ file, line, removed?, text }}"
        ))
    };
    let items = match body.get("comments") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) if items.len() <= COMMENTS_MAX => items,
        Some(_) => return Err(refused()),
    };
    items
        .iter()
        .map(|item| {
            let comment = item.as_object()?;
            let file = comment
                .get("file")?
                .as_str()
                .filter(|file| !file.is_empty())?;
            let line = integer(comment.get("line")?)
                .filter(|line| *line > 0.0 && *line <= u32::MAX as f64)?;
            let removed = match comment.get("removed") {
                None => false,
                Some(Value::Bool(removed)) => *removed,
                Some(_) => return None,
            };
            let text = comment.get("text")?.as_str().filter(|text| !blank(text))?;
            Some(LineComment {
                file: file.to_owned(),
                line: line as u32,
                removed: removed.then_some(true),
                text: text.to_owned(),
            })
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(refused)
}

/// `patch` of `POST /settings`: an object, read as the settings store takes it. What the store's
/// types cannot hold (a number given as text) is refused as `invalid_settings`, as the store
/// refuses a value it cannot use.
pub(crate) fn settings_patch(body: &Body) -> Result<FleetSettingsPatch, FleetError> {
    let Some(patch @ Value::Object(_)) = body.get("patch") else {
        return Err(invalid_body("patch must be an object"));
    };
    serde_json::from_value(patch.clone())
        .map_err(|error| FleetError::new("invalid_settings", error.to_string()))
}

/// The body of `POST /entrances`: the folder's id, and whether to install (else remove).
pub(crate) fn entrance_change(body: &Body) -> Result<(String, bool), FleetError> {
    let Some(Value::String(id)) = body.get("id") else {
        return Err(invalid_body("id must be a string"));
    };
    match body.get("action").and_then(Value::as_str) {
        Some("install") => Ok((id.clone(), true)),
        Some("remove") => Ok((id.clone(), false)),
        _ => Err(invalid_body("action must be install or remove")),
    }
}
