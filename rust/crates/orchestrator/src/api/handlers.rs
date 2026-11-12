//! A handler per route of `server/fleet/api.ts`: it takes the request apart, checks it
//! ([`super::body`]), calls the fleet ([`super::in_task`] around every await) and answers JSON.

use std::path::PathBuf;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Value, json};

use super::body::{self, Body};
use super::error::{ApiError, json_response};
use super::{blocking, in_task, js, report};
use crate::FleetError;
use crate::plan::PLAN_MAX_BYTES;
use crate::usage::AUTO_REFRESH;

type Answer = Result<Response, ApiError>;
type Pairs = Query<Vec<(String, String)>>;

fn ok(value: Value) -> Answer {
    Ok(json_response(StatusCode::OK, &value))
}

fn created(value: Value) -> Answer {
    Ok(json_response(StatusCode::CREATED, &value))
}

/// `URLSearchParams.get`: the first value of `key`.
fn first<'a>(query: &'a Pairs, key: &str) -> Option<&'a str> {
    query
        .0
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.as_str())
}

/// `query.get(key) || undefined`: a value that is not empty.
fn given<'a>(query: &'a Pairs, key: &str) -> Option<&'a str> {
    first(query, key).filter(|value| !value.is_empty())
}

/// `process.cwd()`: the server's folder, read at each request as the orchestrator reads it. A
/// folder that cannot be read (it was removed) is a server error, as `process.cwd()` throws then.
fn server_folder() -> Result<PathBuf, ApiError> {
    std::env::current_dir().map_err(|error| ApiError::Internal(error.to_string()))
}

/// `value || process.cwd()`.
fn folder_or_servers(value: Option<&str>) -> Result<PathBuf, ApiError> {
    match value.filter(|value| !value.is_empty()) {
        Some(value) => Ok(PathBuf::from(value)),
        None => server_folder(),
    }
}

/// The group of a GET: the query's.
fn query_group(query: &Pairs) -> Option<String> {
    body::group(None, first(query, "group"))
}

/// The body's group, else the query's.
fn body_group(body: &Body, query: &Pairs) -> Option<String> {
    body::group(Some(body), first(query, "group"))
}

/// `value` itself as the answer's body.
fn ok_as<T: serde::Serialize>(value: &T) -> Answer {
    Ok(json_response(StatusCode::OK, value))
}

pub(super) async fn roles(State(api): State<super::State>, query: Pairs) -> Answer {
    let cwd = folder_or_servers(first(&query, "cwd"))?;
    // the role files are read from disk
    let roles = blocking(move || Ok(api.fleet.roles(&cwd))).await?;
    let roles: Vec<Value> = roles
        .into_iter()
        .map(|role| {
            json!({ "name": role.name, "description": role.description, "agent": role.agent, "source": role.source })
        })
        .collect();
    ok(json!({ "roles": roles }))
}

pub(super) async fn start_thread(State(api): State<super::State>, bytes: Bytes) -> Answer {
    let request = body::thread_request(&body::read_body(&bytes)?)?;
    let fleet = api.fleet.clone();
    let run = in_task(move |cancel| async move { Ok(fleet.start_thread(request, &cancel).await?) })
        .await?;
    created(json!({ "run": run }))
}

pub(super) async fn threads(State(api): State<super::State>, query: Pairs) -> Answer {
    let fleet = api.fleet.clone();
    let caller_run = given(&query, "caller_run").map(str::to_owned);
    let cwd = given(&query, "cwd").map(str::to_owned);
    let threads =
        in_task(
            move |_| async move { Ok(fleet.threads(caller_run.as_deref(), cwd.as_deref()).await?) },
        )
        .await?;
    ok(json!({ "threads": threads }))
}

pub(super) async fn start_project(State(api): State<super::State>, bytes: Bytes) -> Answer {
    let request = body::project_request(&body::read_body(&bytes)?)?;
    let fleet = api.fleet.clone();
    let run = in_task(move |cancel| async move {
        let body::ProjectRequest {
            task,
            cwd,
            from_pane,
        } = request;
        Ok(fleet
            .start_project(&task, cwd.as_deref(), from_pane.as_deref(), &cancel)
            .await?)
    })
    .await?;
    created(json!({ "run": run }))
}

pub(super) async fn spawn(State(api): State<super::State>, bytes: Bytes) -> Answer {
    let request = body::spawn_request(&body::read_body(&bytes)?)?;
    let fleet = api.fleet.clone();
    let run =
        in_task(move |cancel| async move { Ok(fleet.spawn(request, &cancel).await?) }).await?;
    created(json!({ "run": run }))
}

pub(super) async fn report(State(api): State<super::State>, query: Pairs) -> Answer {
    if api.report.is_none() {
        return Err(ApiError::NotFound);
    }
    let Some(cwd) = given(&query, "cwd") else {
        return Err(FleetError::new("missing_cwd", "cwd is required").into());
    };
    let hours = first(&query, "hours").map_or(24.0, js::number);
    if !hours.is_finite() || hours <= 0.0 {
        return Err(FleetError::new("invalid_hours", "hours must be a positive number").into());
    }
    let request = report::Request {
        cwd: PathBuf::from(cwd),
        hours,
        planned: report::planned_label(first(&query, "planned_label"))?,
    };
    let text = in_task(move |_| async move {
        let reporter = api.report.as_ref().ok_or(ApiError::NotFound)?;
        report::report(reporter, &api.fleet, request).await
    })
    .await?;
    ok(json!({ "report": text }))
}

pub(super) async fn usage(State(api): State<super::State>) -> Answer {
    let usage = api.usage.as_ref().ok_or(ApiError::NotFound)?;
    ok(json!({ "usage": usage.list() }))
}

pub(super) async fn refresh_usage(State(api): State<super::State>, bytes: Bytes) -> Answer {
    let usage = api.usage.clone().ok_or(ApiError::NotFound)?;
    let all = body::optional_bool(&body::read_body(&bytes)?, "all")?;
    let listed = usage.clone();
    in_task(move |_| async move {
        usage.refresh(all == Some(true), Some(AUTO_REFRESH)).await;
        Ok(())
    })
    .await?;
    ok(json!({ "usage": listed.list() }))
}

pub(super) async fn clear_cooldown(State(api): State<super::State>, bytes: Bytes) -> Answer {
    let usage = api.usage.as_ref().ok_or(ApiError::NotFound)?;
    let key = body::cooldown_key(&body::read_body(&bytes)?)?;
    ok(json!({ "cleared": usage.clear_cooldown(key.as_deref()) }))
}

pub(super) async fn settings(State(api): State<super::State>, query: Pairs) -> Answer {
    if api.settings.is_none() {
        return Err(ApiError::NotFound);
    }
    let cwd = folder_or_servers(first(&query, "cwd"))?;
    let read = blocking(move || Ok(settings_of(&api)?.read(&cwd)?)).await?;
    ok(json!({ "settings": read }))
}

pub(super) async fn change_settings(State(api): State<super::State>, bytes: Bytes) -> Answer {
    if api.settings.is_none() {
        return Err(ApiError::NotFound);
    }
    let body = body::read_body(&bytes)?;
    let cwd = body::optional_string(&body, "cwd")?;
    let patch = body::settings_patch(&body)?;
    // api.ts reads `process.cwd()` only once the patch was checked
    let cwd = folder_or_servers(cwd.as_deref())?;
    let changed = blocking(move || Ok(settings_of(&api)?.update(&cwd, &patch)?)).await?;
    ok(json!({ "settings": changed }))
}

fn settings_of(api: &super::State) -> Result<&crate::settings::FleetSettingsStore, ApiError> {
    api.settings.as_ref().ok_or(ApiError::NotFound)
}

fn entrances_of(api: &super::State) -> Result<&crate::entrances::EntranceStore, ApiError> {
    api.entrances.as_ref().ok_or(ApiError::NotFound)
}

pub(super) async fn models(State(api): State<super::State>) -> Answer {
    let models = api.models.clone().ok_or(ApiError::NotFound)?;
    let listings = in_task(move |_| async move { Ok(models.list_all().await) }).await?;
    ok(json!({ "listings": listings }))
}

pub(super) async fn entrances(State(api): State<super::State>) -> Answer {
    entrances_of(&api)?;
    let listed = blocking(move || Ok(entrances_of(&api)?.list()?)).await?;
    ok_as(&listed)
}

pub(super) async fn change_entrance(State(api): State<super::State>, bytes: Bytes) -> Answer {
    entrances_of(&api)?;
    let (id, install) = body::entrance_change(&body::read_body(&bytes)?)?;
    let changed = blocking(move || {
        let entrances = entrances_of(&api)?;
        Ok(if install {
            entrances.install(&id)?
        } else {
            entrances.remove(&id)?
        })
    })
    .await?;
    ok_as(&changed)
}

pub(super) async fn close_done(
    State(api): State<super::State>,
    query: Pairs,
    bytes: Bytes,
) -> Answer {
    let group = body_group(&body::read_body(&bytes)?, &query);
    let fleet = api.fleet.clone();
    let runs =
        in_task(move |_| async move { Ok(fleet.close_done(group.as_deref()).await) }).await?;
    ok(json!({ "runs": runs }))
}

pub(super) async fn runs(State(api): State<super::State>, query: Pairs) -> Answer {
    ok(json!({ "runs": api.fleet.list(query_group(&query).as_deref()) }))
}

pub(super) async fn run(
    State(api): State<super::State>,
    Path(target): Path<String>,
    query: Pairs,
) -> Answer {
    let run = api.fleet.get(&target, query_group(&query).as_deref())?;
    ok(json!({ "run": run }))
}

pub(super) async fn diff(
    State(api): State<super::State>,
    Path(target): Path<String>,
    query: Pairs,
) -> Answer {
    let (fleet, group) = (api.fleet.clone(), query_group(&query));
    let diff =
        in_task(move |_| async move { Ok(fleet.diff(&target, group.as_deref()).await?) }).await?;
    ok_as(&diff)
}

pub(super) async fn checks(
    State(api): State<super::State>,
    Path(target): Path<String>,
    query: Pairs,
) -> Answer {
    let (fleet, group) = (api.fleet.clone(), query_group(&query));
    let checks =
        in_task(move |_| async move { Ok(fleet.checks(&target, group.as_deref()).await?) }).await?;
    ok(json!({ "checks": checks }))
}

pub(super) async fn plan(
    State(api): State<super::State>,
    Path(target): Path<String>,
    query: Pairs,
) -> Answer {
    let plan = api.fleet.plan(&target, query_group(&query).as_deref())?;
    ok(json!({ "plan": plan }))
}

pub(super) async fn submit_plan(
    State(api): State<super::State>,
    Path(target): Path<String>,
    query: Pairs,
    bytes: Bytes,
) -> Answer {
    let body = body::read_body(&bytes)?;
    let plan = body.get("plan").unwrap_or(&Value::Null);
    // `Buffer.byteLength(JSON.stringify(plan ?? null))`
    if js::stringify_len(plan) > PLAN_MAX_BYTES {
        return Err(FleetError::new(
            "invalid_plan",
            format!("The plan is larger than {PLAN_MAX_BYTES} bytes."),
        )
        .into());
    }
    let submitted = api
        .fleet
        .submit_plan(&target, plan, body_group(&body, &query).as_deref())?;
    created(json!({ "plan": submitted }))
}

pub(super) async fn answer_plan(
    State(api): State<super::State>,
    Path(target): Path<String>,
    query: Pairs,
    bytes: Bytes,
) -> Answer {
    let body = body::read_body(&bytes)?;
    let answer = body.get("answer").cloned().unwrap_or(Value::Null);
    let (fleet, group) = (api.fleet.clone(), body_group(&body, &query));
    let run = in_task(move |cancel| async move {
        Ok(fleet
            .answer_plan(&target, &answer, group.as_deref(), &cancel)
            .await?)
    })
    .await?;
    ok(json!({ "run": run }))
}

pub(super) async fn read(
    State(api): State<super::State>,
    Path(target): Path<String>,
    query: Pairs,
) -> Answer {
    // `lines ? Math.max(1, Math.min(10_000, Number(lines) || 0)) : undefined`
    let lines = given(&query, "lines").map(|lines| {
        let number = js::number(lines);
        let number = if number.is_nan() { 0.0 } else { number };
        number.clamp(1.0, 10_000.0) as u32
    });
    let (fleet, group) = (api.fleet.clone(), query_group(&query));
    let text =
        in_task(move |_| async move { Ok(fleet.read(&target, lines, group.as_deref()).await?) })
            .await?;
    ok(json!({ "text": text }))
}

pub(super) async fn send(
    State(api): State<super::State>,
    Path(target): Path<String>,
    query: Pairs,
    bytes: Bytes,
) -> Answer {
    let body = body::read_body(&bytes)?;
    let message = body::message(&body)?;
    let (fleet, group) = (api.fleet.clone(), body_group(&body, &query));
    let run = in_task(move |cancel| async move {
        Ok(fleet
            .send(&target, &message, group.as_deref(), &cancel)
            .await?)
    })
    .await?;
    ok(json!({ "run": run }))
}

pub(super) async fn wait(
    State(api): State<super::State>,
    Path(target): Path<String>,
    query: Pairs,
    bytes: Bytes,
) -> Answer {
    let body = body::read_body(&bytes)?;
    let timeout = body::timeout_ms(&body)?;
    let (fleet, group) = (api.fleet.clone(), body_group(&body, &query));
    let run = in_task(move |cancel| async move {
        Ok(fleet
            .wait(&target, timeout, group.as_deref(), &cancel)
            .await?)
    })
    .await?;
    ok(json!({ "run": run }))
}

pub(super) async fn interrupt(
    State(api): State<super::State>,
    Path(target): Path<String>,
    query: Pairs,
    bytes: Bytes,
) -> Answer {
    let body = body::read_body(&bytes)?;
    let (fleet, group) = (api.fleet.clone(), body_group(&body, &query));
    let run =
        in_task(move |_| async move { Ok(fleet.interrupt(&target, group.as_deref()).await?) })
            .await?;
    ok(json!({ "run": run }))
}

pub(super) async fn focus(
    State(api): State<super::State>,
    Path(target): Path<String>,
    query: Pairs,
    bytes: Bytes,
) -> Answer {
    let body = body::read_body(&bytes)?;
    let (fleet, group) = (api.fleet.clone(), body_group(&body, &query));
    let run =
        in_task(move |_| async move { Ok(fleet.focus(&target, group.as_deref()).await?) }).await?;
    ok(json!({ "run": run }))
}

pub(super) async fn resolve(
    State(api): State<super::State>,
    Path(target): Path<String>,
    query: Pairs,
    bytes: Bytes,
) -> Answer {
    let body = body::read_body(&bytes)?;
    let resolved = body::optional_bool(&body, "resolved")?;
    let run = api.fleet.resolve(
        &target,
        resolved != Some(false),
        body_group(&body, &query).as_deref(),
    )?;
    ok(json!({ "run": run }))
}

pub(super) async fn land(
    State(api): State<super::State>,
    Path(target): Path<String>,
    query: Pairs,
    bytes: Bytes,
) -> Answer {
    let body = body::read_body(&bytes)?;
    let action = body::land_action(&body)?;
    let comments = body::line_comments(&body)?;
    let (fleet, group) = (api.fleet.clone(), body_group(&body, &query));
    let run = in_task(move |cancel| async move {
        Ok(fleet
            .land(&target, action, &comments, group.as_deref(), &cancel)
            .await?)
    })
    .await?;
    ok(json!({ "run": run }))
}

/// A POST to `/runs/:target/<step>` that names no step taking one: api.ts reads the body first,
/// so a body that is not a JSON object is refused as such, and any other finds no route.
pub(super) async fn other_step(bytes: Bytes) -> Answer {
    body::read_body(&bytes)?;
    Err(ApiError::NotFound)
}
