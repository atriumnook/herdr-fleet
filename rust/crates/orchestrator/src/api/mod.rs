//! The `/api/fleet` router; from `server/fleet/api.ts` (ADR 0269-fleet-api).
//!
//! The routes are axum's, with `server/fleet/api.ts`'s answers where axum's own differ: an unknown
//! path and a known path asked with another method both answer 404 `not_found` (no 405), a HEAD
//! finds no GET route, and a body is read as JSON whatever its Content-Type says. Every await of a
//! handler runs in a task of its own ([`in_task`]), so a request that goes away cancels the
//! operation's token but never stops it halfway.

use std::any::Any;
use std::future::Future;
use std::sync::Arc;

use axum::Router;
use axum::handler::Handler;
use axum::routing::{MethodRouter, get, post};
use jiff::tz::TimeZone;
use protocol::fleet_routes as routes;
use tokio_util::sync::CancellationToken;

use crate::entrances::EntranceStore;
use crate::events::EventLog;
use crate::fleet::Orchestrator;
use crate::github::GitHub;
use crate::models::ModelCatalog;
use crate::settings::FleetSettingsStore;
use crate::usage::UsageTracker;

mod body;
mod error;
mod handlers;
mod js;
mod report;

use error::ApiError;

/// What the `/api/fleet` router is built from (`handleFleetRequest`'s arguments). A route whose
/// part is `None` answers 404 `not_found`, as TypeScript does when that argument is absent.
pub struct FleetApiDeps {
    pub fleet: Orchestrator,
    pub usage: Option<UsageTracker>,
    pub settings: Option<FleetSettingsStore>,
    pub entrances: Option<EntranceStore>,
    pub models: Option<ModelCatalog>,
    pub report: Option<FactoryReporter>,
}

/// What `GET /report` reads besides the orchestrator (`factoryReport`, `server/index.ts:544-551`).
pub struct FactoryReporter {
    /// the log the orchestrator records to; its file is read
    pub events: Arc<EventLog>,
    /// `gh`; a test names a fake program (`GitHub::with_program`)
    pub github: GitHub,
    /// the zone the report's times are written in: the server's, `TimeZone::system()`
    pub time_zone: TimeZone,
}

type State = Arc<FleetApiDeps>;

/// The routes of `/api/fleet`, relative to `protocol::FLEET_API`. The core nests them there behind
/// its access control, which checks `X-Herdr-Fleet` (ADR 0107-crate-split).
pub fn router(deps: FleetApiDeps) -> Router {
    use handlers as h;
    Router::new()
        .route(routes::ROLES, read(h::roles))
        .route(routes::THREADS, read(h::threads).post(h::start_thread))
        .route(routes::PROJECTS, post(h::start_project))
        .route(routes::SPAWN, post(h::spawn))
        .route(routes::REPORT, read(h::report))
        .route(routes::USAGE, read(h::usage))
        .route(routes::USAGE_REFRESH, post(h::refresh_usage))
        .route(routes::USAGE_CLEAR, post(h::clear_cooldown))
        .route(routes::SETTINGS, read(h::settings).post(h::change_settings))
        .route(routes::MODELS, read(h::models))
        .route(
            routes::ENTRANCES,
            read(h::entrances).post(h::change_entrance),
        )
        .route(routes::CLOSE_DONE, post(h::close_done))
        .route(routes::RUNS, read(h::runs))
        .route(routes::RUN, read(h::run))
        .route(routes::RUN_DIFF, read(h::diff).post(h::other_step))
        .route(routes::RUN_LANDING, read(h::checks).post(h::other_step))
        .route(routes::RUN_PLAN, read(h::plan).post(h::submit_plan))
        .route(routes::RUN_PLAN_ANSWER, post(h::answer_plan))
        .route(routes::RUN_READ, read(h::read).post(h::other_step))
        .route(routes::RUN_SEND, post(h::send))
        .route(routes::RUN_WAIT, post(h::wait))
        .route(routes::RUN_INTERRUPT, post(h::interrupt))
        .route(routes::RUN_FOCUS, post(h::focus))
        .route(routes::RUN_RESOLVE, post(h::resolve))
        .route(routes::RUN_LAND, post(h::land))
        // api.ts reads the body of any POST to /runs/:target/<step> before it finds no such step
        .route("/runs/{target}/{step}", post(h::other_step))
        // after every route: it covers only the routes registered before it
        .method_not_allowed_fallback(not_found)
        .fallback(not_found)
        .with_state(Arc::new(deps))
}

/// A GET route that a HEAD does not reach: axum would hand a HEAD to the GET handler, and every
/// branch of api.ts asks for GET.
fn read<H, T>(handler: H) -> MethodRouter<State>
where
    H: Handler<T, State>,
    T: 'static,
{
    get(handler).head(not_found)
}

/// `notFound()`.
async fn not_found() -> ApiError {
    ApiError::NotFound
}

/// `work` in a task of its own, its token cancelled when the request goes away: axum drops the
/// handler's future when the connection closes, and the guard cancels then, while the task runs on
/// to its end (ADR 0242-phase-3-split, "取り消し"). A panic in the task is a server error.
async fn in_task<T, F>(work: impl FnOnce(CancellationToken) -> F) -> Result<T, ApiError>
where
    F: Future<Output = Result<T, ApiError>> + Send + 'static,
    T: Send + 'static,
{
    let cancel = CancellationToken::new();
    let _cancel_on_drop = cancel.clone().drop_guard();
    match tokio::spawn(work(cancel)).await {
        Ok(answer) => answer,
        Err(failed) => Err(ApiError::Internal(match failed.try_into_panic() {
            Ok(payload) => panic_message(payload),
            Err(_) => "The operation was cancelled.".to_owned(),
        })),
    }
}

/// `work`, which reads or writes files, on tokio's threads for blocking work, so it holds up no
/// other request (TypeScript does the same work on its event loop). A panic in it is a server
/// error.
async fn blocking<T>(
    work: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError>
where
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(answer) => answer,
        Err(failed) => Err(ApiError::Internal(match failed.try_into_panic() {
            Ok(payload) => panic_message(payload),
            Err(_) => "The operation was cancelled.".to_owned(),
        })),
    }
}

/// What a panic said, when it said it as text (TypeScript's `String(error)`).
fn panic_message(payload: Box<dyn Any + Send>) -> String {
    match payload.downcast::<String>() {
        Ok(message) => *message,
        Err(payload) => payload.downcast_ref::<&str>().map_or_else(
            || "The operation failed.".to_owned(),
            |message| (*message).to_owned(),
        ),
    }
}
