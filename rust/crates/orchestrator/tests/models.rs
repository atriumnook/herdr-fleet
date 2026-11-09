//! The model lists and the catalog (`models/`), ported from `server/fleet/models.test.ts`: each
//! test that comes from there names its `describe` and `it` in its comment, and its expected
//! values are the TypeScript test's own (all 24 `it`s, the 2 the security table also holds among
//! them). The other tests check what issue #258 asks and the TypeScript test does not pin: each
//! time value of `server/fleet/models.ts` and `model-lists.ts` at its edge, one read per CLI, the
//! lines `codex app-server` is sent, and which CLI's list is complete (`server/fleet/adapters.ts`);
//! their expected values are worked out by hand from that code.
//!
//! No real agent CLI is started: each listing runs a fake executable in a temporary folder of its
//! own, which notes what it was started with and answers as the real CLI does (issue #258).

#![cfg(unix)]

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use child_process::Env;
use child_process::opencode::{OpencodeCliOptions, opencode_api_get};
use herdr_fleet_orchestrator::Clock;
use herdr_fleet_orchestrator::models::{
    CatalogOptions, CodexPage, ListFuture, ListOptions, ModelCatalog, ModelSource,
    parse_agy_models, parse_codex_models, parse_cursor_models, parse_opencode_models,
    parse_pi_models, source_for,
};
use protocol::{FleetAgentKind, ListedModel, ModelListing, model_listed};
use serde_json::json;

/// `AGENT_KINDS` of `server/fleet/adapters.ts`, in its order.
const AGENT_KINDS: [FleetAgentKind; 6] = [
    FleetAgentKind::Pi,
    FleetAgentKind::Claude,
    FleetAgentKind::Codex,
    FleetAgentKind::Cursor,
    FleetAgentKind::Agy,
    FleetAgentKind::Opencode,
];

fn model(id: &str) -> ListedModel {
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

// ---------------------------------------------------------------------------------------------
// describe("model lists, as each CLI prints them")
// ---------------------------------------------------------------------------------------------

/// models.test.ts: model lists, as each CLI prints them > reads agy's tab-separated lines and
/// skips its progress line
#[test]
fn reads_agys_tab_separated_lines_and_skips_its_progress_line() {
    assert_eq!(
        parse_agy_models(
            "Fetching available models...\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n\n"
        ),
        vec![labelled("gemini-3.1-pro-high", "Gemini 3.1 Pro (High)")]
    );
}

/// models.test.ts: model lists, as each CLI prints them > reads cursor's `id - name` lines, and
/// drops the zero-width characters its names carry
#[test]
fn reads_cursors_id_name_lines_and_drops_the_zero_width_characters_its_names_carry() {
    let output = "Available models\n\nauto - Auto (default)\ngrok-4.7-low-fast - Grok 4.7  Low Fast\u{200b}\u{200b}\n";
    assert_eq!(
        parse_cursor_models(output),
        vec![
            labelled("auto", "Auto (default)"),
            labelled("grok-4.7-low-fast", "Grok 4.7  Low Fast"),
        ]
    );
}

/// models.test.ts: model lists, as each CLI prints them > reads pi's table as provider/model
#[test]
fn reads_pis_table_as_provider_model() {
    let output = "provider  model    context  max-out  thinking  images\nopenai    gpt-4.1  1.0M     32.8K    no        yes\n";
    assert_eq!(parse_pi_models(output), vec![model("openai/gpt-4.1")]);
}

/// models.test.ts: model lists, as each CLI prints them > reads opencode's GET /api/model as
/// provider/model, and leaves out what is not one
#[test]
fn reads_opencodes_get_api_model_as_provider_model_and_leaves_out_what_is_not_one() {
    let body = json!({ "data": [
        { "providerID": "github-copilot", "id": "claude-opus-5.5", "variants": [] },
        { "providerID": "opencode", "id": "big-pickle" },
        { "providerID": "x", "id": "y#high" },
        { "providerID": "a b", "id": "c" },
        { "id": "no-provider" },
        null,
    ] });
    assert_eq!(
        parse_opencode_models(&body),
        vec![
            model("github-copilot/claude-opus-5.5"),
            model("opencode/big-pickle")
        ]
    );
    assert_eq!(parse_opencode_models(&json!({ "data": [] })), vec![]);
    assert_eq!(parse_opencode_models(&json!("html")), vec![]);
}

/// models.test.ts: model lists, as each CLI prints them > reads one page of codex's model/list
/// and where the next begins
#[test]
fn reads_one_page_of_codexs_model_list_and_where_the_next_begins() {
    assert_eq!(
        parse_codex_models(&json!({
            "data": [{ "model": "gpt-6", "displayName": "GPT-6" }, { "id": "no-model-field" }],
            "nextCursor": "c2",
        })),
        CodexPage {
            models: vec![labelled("gpt-6", "GPT-6")],
            next: Some("c2".to_owned()),
        }
    );
    assert_eq!(
        parse_codex_models(&json!({ "data": [], "nextCursor": null })),
        CodexPage {
            models: vec![],
            next: None,
        }
    );
}

// ---------------------------------------------------------------------------------------------
// The catalog, with stand-in sources (models.test.ts `catalog`)
// ---------------------------------------------------------------------------------------------

/// A clock the test sets, as models.test.ts passes `now = () => at`.
#[derive(Default)]
struct TestClock(AtomicI64);

impl TestClock {
    fn set(&self, at: i64) {
        self.0.store(at, Ordering::SeqCst);
    }
}

impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// A source whose list each call of `list` makes.
fn source<F>(complete: bool, list: F) -> ModelSource
where
    F: Fn() -> ListFuture + Send + Sync + 'static,
{
    ModelSource {
        complete,
        list: Arc::new(move |_options: ListOptions| list()),
    }
}

/// A source that counts its asks in `asked` and answers `answer` each time.
fn counting(
    complete: bool,
    asked: &Arc<AtomicUsize>,
    answer: Result<Vec<ListedModel>, String>,
) -> ModelSource {
    let asked = Arc::clone(asked);
    source(complete, move || {
        asked.fetch_add(1, Ordering::SeqCst);
        let answer = answer.clone();
        Box::pin(async move { answer })
    })
}

/// `catalog` of models.test.ts: every kind gets `source`, and the time is the clock's.
fn catalog(source: Option<ModelSource>, clock: &Arc<TestClock>) -> ModelCatalog {
    let mut options = CatalogOptions::new("/nonexistent", Env::new());
    options.clock = Arc::clone(clock) as Arc<dyn Clock>;
    options.sources = Arc::new(move |_kind| source.clone());
    ModelCatalog::new(options)
}

// describe("the model catalog")

/// models.test.ts: the model catalog > asks a CLI once and keeps the answer for minutes
#[tokio::test]
async fn asks_a_cli_once_and_keeps_the_answer_for_minutes() {
    let asked = Arc::new(AtomicUsize::new(0));
    let clock = Arc::new(TestClock::default());
    let models = catalog(Some(counting(true, &asked, Ok(vec![model("a")]))), &clock);
    models.list(FleetAgentKind::Codex, false).await;
    models.list(FleetAgentKind::Codex, false).await;
    assert_eq!(asked.load(Ordering::SeqCst), 1);
    clock.set(11 * 60_000);
    models.list(FleetAgentKind::Codex, false).await;
    assert_eq!(asked.load(Ordering::SeqCst), 2);
}

/// models.test.ts: the model catalog > answers a failed ask with the reason, and asks again once
/// the minute is over
#[tokio::test]
async fn answers_a_failed_ask_with_the_reason_and_asks_again_once_the_minute_is_over() {
    let fail = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let clock = Arc::new(TestClock::default());
    let failing = Arc::clone(&fail);
    let models = catalog(
        Some(source(true, move || {
            let fail = failing.load(Ordering::SeqCst);
            Box::pin(async move {
                if fail {
                    Err("offline".to_owned())
                } else {
                    Ok(vec![model("a")])
                }
            })
        })),
        &clock,
    );
    assert_eq!(
        models.list(FleetAgentKind::Codex, false).await,
        ModelListing {
            agent: FleetAgentKind::Codex,
            models: vec![],
            complete: false,
            error: Some("offline".to_owned()),
        }
    );
    fail.store(false, Ordering::SeqCst);
    clock.set(61_000);
    let listing = models.list(FleetAgentKind::Codex, false).await;
    assert_eq!(listing.models, vec![model("a")]);
    assert!(listing.complete);
}

/// models.test.ts: the model catalog > refuses a model a complete list lacks, after asking again
/// once
#[tokio::test]
async fn refuses_a_model_a_complete_list_lacks_after_asking_again_once() {
    let asked = Arc::new(AtomicUsize::new(0));
    let clock = Arc::new(TestClock::default());
    let models = catalog(
        Some(counting(
            true,
            &asked,
            Ok(vec![model("gpt-6"), model("gpt-7[effort=high]")]),
        )),
        &clock,
    );
    assert_eq!(
        models.unknown(FleetAgentKind::Codex, Some("gpt-6")).await,
        None
    );
    assert_eq!(asked.load(Ordering::SeqCst), 1);
    assert_eq!(
        models
            .unknown(FleetAgentKind::Codex, Some("gpt-6:high"))
            .await,
        None
    );
    assert_eq!(
        models.unknown(FleetAgentKind::Codex, Some("gpt-7")).await,
        None
    );
    assert_eq!(
        models.unknown(FleetAgentKind::Codex, Some("gpt-9")).await,
        Some("codex does not offer a model named gpt-9".to_owned())
    );
    assert_eq!(asked.load(Ordering::SeqCst), 2);
}

/// models.test.ts: the model catalog > refuses nothing when the list is not complete, when there
/// is no model, or when the CLI cannot be asked
#[tokio::test]
async fn refuses_nothing_when_the_list_is_not_complete_when_there_is_no_model_or_when_the_cli_cannot_be_asked()
 {
    let clock = Arc::new(TestClock::default());
    let asked = Arc::new(AtomicUsize::new(0));
    assert_eq!(
        catalog(Some(counting(false, &asked, Ok(vec![model("a")]))), &clock)
            .unknown(FleetAgentKind::Claude, Some("claude-opus-9"))
            .await,
        None
    );
    assert_eq!(
        catalog(Some(counting(true, &asked, Ok(vec![model("a")]))), &clock)
            .unknown(FleetAgentKind::Codex, None)
            .await,
        None
    );
    assert_eq!(
        catalog(
            Some(counting(true, &asked, Err("offline".to_owned()))),
            &clock
        )
        .unknown(FleetAgentKind::Codex, Some("x"))
        .await,
        None
    );
    assert_eq!(
        catalog(None, &clock)
            .unknown(FleetAgentKind::Codex, Some("x"))
            .await,
        None
    );
}

/// The catalog's two time values at their edges (`TTL_MS` and `FAILURE_TTL_MS`,
/// `server/fleet/models.ts:7-9`): a list is kept while `now - at < TTL`, so it is asked again at
/// exactly 10 minutes, and a failure at exactly 1 minute.
#[tokio::test]
async fn keeps_a_list_for_ten_minutes_and_a_failure_for_one() {
    let clock = Arc::new(TestClock::default());
    let asked = Arc::new(AtomicUsize::new(0));
    let models = catalog(Some(counting(true, &asked, Ok(vec![model("a")]))), &clock);
    models.list(FleetAgentKind::Codex, false).await;
    clock.set(599_999);
    models.list(FleetAgentKind::Codex, false).await;
    assert_eq!(asked.load(Ordering::SeqCst), 1, "kept until 10 minutes");
    clock.set(600_000);
    models.list(FleetAgentKind::Codex, false).await;
    assert_eq!(asked.load(Ordering::SeqCst), 2, "asked again at 10 minutes");

    let clock = Arc::new(TestClock::default());
    let failed = Arc::new(AtomicUsize::new(0));
    let models = catalog(
        Some(counting(true, &failed, Err("down".to_owned()))),
        &clock,
    );
    models.list(FleetAgentKind::Codex, false).await;
    clock.set(59_999);
    models.list(FleetAgentKind::Codex, false).await;
    assert_eq!(
        failed.load(Ordering::SeqCst),
        1,
        "a failure kept until 1 minute"
    );
    clock.set(60_000);
    models.list(FleetAgentKind::Codex, false).await;
    assert_eq!(failed.load(Ordering::SeqCst), 2, "asked again at 1 minute");
}

/// A CLI that answers an empty list has listed nothing: the listing is not complete, says why,
/// and is kept as a failure (`server/fleet/models.ts:38`).
#[tokio::test]
async fn an_empty_list_is_a_failure() {
    let clock = Arc::new(TestClock::default());
    let asked = Arc::new(AtomicUsize::new(0));
    let models = catalog(Some(counting(true, &asked, Ok(vec![]))), &clock);
    assert_eq!(
        models.list(FleetAgentKind::Cursor, false).await,
        ModelListing {
            agent: FleetAgentKind::Cursor,
            models: vec![],
            complete: false,
            error: Some("cursor listed no models".to_owned()),
        }
    );
    clock.set(60_000);
    models.list(FleetAgentKind::Cursor, false).await;
    assert_eq!(asked.load(Ordering::SeqCst), 2);
}

/// A kind with no source has an empty listing that is not complete and is no failure
/// (`server/fleet/models.ts:36`).
#[tokio::test]
async fn a_kind_without_a_source_lists_nothing() {
    let clock = Arc::new(TestClock::default());
    assert_eq!(
        catalog(None, &clock).list(FleetAgentKind::Pi, false).await,
        ModelListing {
            agent: FleetAgentKind::Pi,
            models: vec![],
            complete: false,
            error: None,
        }
    );
}

/// One read per CLI: lookups made while a read is under way wait for it and share its answer
/// (`asking`, `server/fleet/models.ts:30-31`).
#[tokio::test]
async fn lookups_under_way_share_one_read() {
    let clock = Arc::new(TestClock::default());
    let asked = Arc::new(AtomicUsize::new(0));
    let (send, receive) = tokio::sync::oneshot::channel::<Vec<ListedModel>>();
    let receive = Arc::new(Mutex::new(Some(receive)));
    let counter = Arc::clone(&asked);
    let models = catalog(
        Some(source(true, move || {
            counter.fetch_add(1, Ordering::SeqCst);
            let receive = receive.lock().unwrap().take();
            Box::pin(async move {
                match receive {
                    Some(receive) => Ok(receive.await.unwrap()),
                    None => Err("asked twice".to_owned()),
                }
            })
        })),
        &clock,
    );
    let first = models.list(FleetAgentKind::Agy, false);
    let second = models.list(FleetAgentKind::Agy, false);
    let third = models.unknown(FleetAgentKind::Agy, Some("gemini-3.1-pro-high"));
    send.send(vec![model("gemini-3.1-pro-high")]).unwrap();
    let (first, second, third) = tokio::join!(first, second, third);
    assert_eq!(asked.load(Ordering::SeqCst), 1);
    assert_eq!(first.models, vec![model("gemini-3.1-pro-high")]);
    assert_eq!(second, first);
    assert_eq!(third, None);
}

/// The catalog runs each CLI in its own folder under the catalog's (`join(workDir, agent)`,
/// `server/fleet/models.ts:37`) with the server's environment it was given.
#[tokio::test]
async fn runs_each_cli_in_its_own_folder_under_the_catalogs() {
    let seen: Arc<Mutex<Vec<(PathBuf, Env)>>> = Arc::default();
    let noted = Arc::clone(&seen);
    let env: Env = BTreeMap::from([(OsString::from("HOME"), OsString::from("/home/u"))]);
    let mut options = CatalogOptions::new("/state/model-list", env.clone());
    options.sources = Arc::new(move |_kind| {
        let noted = Arc::clone(&noted);
        Some(ModelSource {
            complete: true,
            list: Arc::new(move |options: ListOptions| {
                noted
                    .lock()
                    .unwrap()
                    .push((options.work_dir.clone(), options.env.clone()));
                Box::pin(async { Ok(vec![model("m")]) })
            }),
        })
    });
    let models = ModelCatalog::new(options);
    models.list_all().await;
    let seen = seen.lock().unwrap();
    let folders: Vec<&Path> = seen.iter().map(|(dir, _)| dir.as_path()).collect();
    assert_eq!(
        folders,
        [
            "/state/model-list/pi",
            "/state/model-list/claude",
            "/state/model-list/codex",
            "/state/model-list/cursor",
            "/state/model-list/agy",
            "/state/model-list/opencode",
        ]
        .map(Path::new)
    );
    assert!(seen.iter().all(|(_, given)| *given == env));
}

/// What O2 (`ModelGate`) and the API need of the catalog: one shared value moved between tasks,
/// whose lookups can be boxed as `Send` futures (ADR 0258-model-catalog).
#[test]
fn the_catalog_and_its_lookups_can_move_between_tasks() {
    fn send<T: Send>(_: &T) {}
    fn shared<T: Clone + Send + Sync + 'static>(_: &T) {}
    let models = ModelCatalog::new(CatalogOptions::new("/nonexistent", Env::new()));
    shared(&models);
    // none of these is polled, so nothing starts
    send(&models.unknown(FleetAgentKind::Codex, Some("m")));
    send(&models.list_all());
}

/// adapters.test.ts: opencode adapter > leaves a model its list lacks to the TUI: the list holds
/// what the catalog knows, but not every text the TUI accepts (the opencode part).
///
/// Which CLI's list is complete (`models` of each adapter, `server/fleet/adapters.ts:150, 182,
/// 223, 256, 354, 438`): codex, cursor and agy; claude and pi accept names their lists leave out,
/// and opencode accepts any `provider/model`.
#[test]
fn only_codex_cursor_and_agy_give_a_complete_list() {
    let complete: Vec<(FleetAgentKind, bool)> = AGENT_KINDS
        .iter()
        .map(|&kind| (kind, source_for(kind).complete))
        .collect();
    assert_eq!(
        complete,
        [
            (FleetAgentKind::Pi, false),
            (FleetAgentKind::Claude, false),
            (FleetAgentKind::Codex, true),
            (FleetAgentKind::Cursor, true),
            (FleetAgentKind::Agy, true),
            (FleetAgentKind::Opencode, false),
        ]
    );
}

/// claude has no listing command: its list is the aliases `claude --help` names, given without
/// starting anything (`CLAUDE_ALIASES`, `server/fleet/model-lists.ts:44`).
#[tokio::test]
async fn claude_lists_its_aliases_without_starting_anything() {
    // a folder that cannot be made: anything that ran would have to fail
    let models = ModelCatalog::new(CatalogOptions::new("/nonexistent/model-list", Env::new()));
    assert_eq!(
        models.list(FleetAgentKind::Claude, false).await,
        ModelListing {
            agent: FleetAgentKind::Claude,
            models: vec![
                model("fable"),
                model("opus"),
                model("sonnet"),
                model("haiku")
            ],
            complete: false,
            error: None,
        }
    );
    // not complete: a full model name passes
    assert_eq!(
        models
            .unknown(FleetAgentKind::Claude, Some("claude-opus-5-5"))
            .await,
        None
    );
}

// describe("agy's models, listed once per effort")

/// models.test.ts: agy's models, listed once per effort > accepts a listed id and the same model
/// without its effort, and nothing else
#[test]
fn accepts_a_listed_id_and_the_same_model_without_its_effort_and_nothing_else() {
    // as `agy models` prints them; the adapter passes `--effort` apart from `--model`
    let listing = ModelListing {
        agent: FleetAgentKind::Agy,
        complete: true,
        models: parse_agy_models(
            "Fetching available models...\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\ngemini-3.1-pro-low\tGemini 3.1 Pro (Low)\nclaude-opus-5-5-medium\tClaude Opus 5.5 (Medium)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n",
        ),
        error: None,
    };
    assert!(model_listed(&listing, "gemini-3.1-pro-high"));
    assert!(model_listed(&listing, "gemini-3.1-pro"));
    assert!(model_listed(&listing, "claude-opus-5-5"));
    assert!(!model_listed(&listing, "gemini-3.1-pro-xhigh"));
    assert!(!model_listed(&listing, "gemini-9"));
    // another CLI's names keep their ending
    let cursor = ModelListing {
        agent: FleetAgentKind::Cursor,
        ..listing
    };
    assert!(!model_listed(&cursor, "gemini-3.1-pro"));
}

// describe("opencode's models, run with a #variant")

/// models.test.ts: opencode's models, run with a #variant > accepts a listed id with or without
/// its variant, and nothing else
#[test]
fn accepts_a_listed_id_with_or_without_its_variant_and_nothing_else() {
    let listing = ModelListing {
        agent: FleetAgentKind::Opencode,
        complete: false,
        models: parse_opencode_models(&json!({ "data": [
            { "providerID": "github-copilot", "id": "claude-opus-5.5" },
            { "providerID": "opencode", "id": "big-pickle" },
        ] })),
        error: None,
    };
    assert!(model_listed(&listing, "github-copilot/claude-opus-5.5"));
    assert!(model_listed(
        &listing,
        "github-copilot/claude-opus-5.5#high"
    ));
    assert!(model_listed(
        &listing,
        "github-copilot/claude-opus-5.5#high:low"
    ));
    assert!(!model_listed(&listing, "github-copilot/claude-opus-9#high"));
    // only opencode names a variant that way
    let pi = ModelListing {
        agent: FleetAgentKind::Pi,
        ..listing
    };
    assert!(!model_listed(&pi, "github-copilot/claude-opus-5.5#high"));
}

// describe("a CLI that fails or hangs")

/// models.test.ts: a CLI that fails or hangs > is not asked again for a minute, then is
#[tokio::test]
async fn is_not_asked_again_for_a_minute_then_is() {
    let asked = Arc::new(AtomicUsize::new(0));
    let clock = Arc::new(TestClock::default());
    let models = catalog(Some(counting(true, &asked, Err("down".to_owned()))), &clock);
    models.list(FleetAgentKind::Codex, false).await;
    models.list(FleetAgentKind::Codex, false).await;
    models.list_all().await;
    // codex once, and every other kind once: they share the stub
    assert_eq!(asked.load(Ordering::SeqCst), AGENT_KINDS.len());
    clock.set(61_000);
    models.list(FleetAgentKind::Codex, false).await;
    assert_eq!(asked.load(Ordering::SeqCst), AGENT_KINDS.len() + 1);
}

/// A source that never answers.
fn hanging() -> ModelSource {
    source(true, || Box::pin(std::future::pending()))
}

/// models.test.ts: a CLI that fails or hangs > holds a spawn up for no longer than the wait, then
/// lets the model through
#[tokio::test]
async fn holds_a_spawn_up_for_no_longer_than_the_wait_then_lets_the_model_through() {
    let mut options = CatalogOptions::new("/nonexistent", Env::new());
    options.spawn_wait = Duration::from_millis(30);
    options.sources = Arc::new(|_kind| Some(hanging()));
    let models = ModelCatalog::new(options);
    let started = Instant::now();
    assert_eq!(
        models
            .unknown(FleetAgentKind::Codex, Some("anything"))
            .await,
        None
    );
    assert!(started.elapsed() < Duration::from_secs(1));
}

/// The spawn's wait when the options name none is 3 seconds (`SPAWN_WAIT_MS`,
/// `server/fleet/models.ts:11`), one deadline for both asks: on tokio's paused clock, which moves
/// only to the next timer, the lookup ends exactly 3 seconds after it began.
#[tokio::test(start_paused = true)]
async fn a_spawn_waits_three_seconds_when_the_options_name_no_wait() {
    let mut options = CatalogOptions::new("/nonexistent", Env::new());
    options.sources = Arc::new(|_kind| Some(hanging()));
    let models = ModelCatalog::new(options);
    let started = tokio::time::Instant::now();
    assert_eq!(
        models.unknown(FleetAgentKind::Agy, Some("anything")).await,
        None
    );
    assert_eq!(started.elapsed(), Duration::from_secs(3));
}

/// After the first ask answered in time without the model, the fresh ask shares what is left of
/// the same 3 seconds, not 3 more (`deadline`, `server/fleet/models.ts:63-64`).
#[tokio::test(start_paused = true)]
async fn the_fresh_ask_shares_the_first_asks_wait() {
    let asks = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&asks);
    let mut options = CatalogOptions::new("/nonexistent", Env::new());
    options.sources = Arc::new(move |_kind| {
        let counter = Arc::clone(&counter);
        Some(source(true, move || {
            let n = counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                if n == 0 {
                    // the first ask answers after a second, without the model
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    Ok(vec![model("other")])
                } else {
                    std::future::pending().await
                }
            })
        }))
    });
    let models = ModelCatalog::new(options);
    let started = tokio::time::Instant::now();
    assert_eq!(
        models.unknown(FleetAgentKind::Codex, Some("wanted")).await,
        None
    );
    assert_eq!(asks.load(Ordering::SeqCst), 2);
    assert_eq!(started.elapsed(), Duration::from_secs(3));
}

/// models.test.ts: a CLI that fails or hangs > is asked anew by a fresh lookup, not answered by
/// an older one still under way
#[tokio::test]
async fn is_asked_anew_by_a_fresh_lookup_not_answered_by_an_older_one_still_under_way() {
    type Answer = tokio::sync::oneshot::Sender<Vec<ListedModel>>;
    let answers: Arc<Mutex<Vec<Answer>>> = Arc::default();
    let pending = Arc::clone(&answers);
    let clock = Arc::new(TestClock::default());
    let models = catalog(
        Some(source(true, move || {
            let (send, receive) = tokio::sync::oneshot::channel();
            pending.lock().unwrap().push(send);
            Box::pin(async move { Ok(receive.await.unwrap_or_default()) })
        })),
        &clock,
    );
    let older = models.list(FleetAgentKind::Codex, false);
    let fresh = models.list(FleetAgentKind::Codex, true);
    let (first, second) = {
        let mut answers = answers.lock().unwrap();
        assert_eq!(answers.len(), 2);
        let second = answers.pop().unwrap();
        (answers.pop().unwrap(), second)
    };
    second.send(vec![model("new")]).unwrap();
    assert_eq!(fresh.await.models, vec![model("new")]);
    first.send(vec![model("old")]).unwrap();
    older.await;
}

// ---------------------------------------------------------------------------------------------
// The listings, with fake CLIs
// ---------------------------------------------------------------------------------------------

/// A new empty folder under the system's temporary folder (its real path), removed with what it
/// holds when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        use std::hash::{BuildHasher as _, Hasher as _};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(n);
        let dir = std::env::temp_dir().join(format!(
            "herdr-fleet-models-{label}-{}-{n}-{:016x}",
            std::process::id(),
            hasher.finish()
        ));
        fs::create_dir(&dir).unwrap_or_else(|error| panic!("{}: {error}", dir.display()));
        Self(dir.canonicalize().unwrap())
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn sh_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', r"'\''"))
}

fn write_script(file: &Path, body: &str) {
    fs::write(file, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(file, fs::Permissions::from_mode(0o755)).unwrap();
}

fn read(file: impl AsRef<Path>) -> String {
    let file = file.as_ref();
    fs::read_to_string(file).unwrap_or_else(|error| panic!("{}: {error}", file.display()))
}

/// `<file>.<ending>`: where a fake notes what it saw.
fn noted(file: &Path, ending: &str) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(".");
    name.push(ending);
    PathBuf::from(name)
}

/// `SERVER_ENV` of models.test.ts: the server's environment as a listing sees it, API keys and
/// the person's herdr session among the rest.
fn server_env() -> Env {
    let mut env: Env = [
        ("HOME", "/home/u"),
        ("LANG", "ja_JP.UTF-8"),
        ("CODEX_HOME", "/home/u/.codex-alt"),
        ("PI_CODING_AGENT_DIR", "/home/u/.pi-alt"),
        ("CLAUDE_CONFIG_DIR", "/home/u/.claude-alt"),
        ("ANTHROPIC_API_KEY", "sk-ant"),
        ("OPENAI_API_KEY", "sk-openai"),
        ("GEMINI_API_KEY", "g-key"),
        ("CURSOR_API_KEY", "c-key"),
        ("HERDR_SOCKET", "/run/herdr.sock"),
        ("HERDR_FLEET_TOKEN", "t"),
    ]
    .into_iter()
    .map(|(name, value)| (OsString::from(name), OsString::from(value)))
    .collect();
    if let Some(path) = std::env::var_os("PATH") {
        env.insert("PATH".into(), path);
    }
    env
}

const FORBIDDEN: [&str; 6] = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "CURSOR_API_KEY",
    "HERDR_SOCKET",
    "HERDR_FLEET_TOKEN",
];

/// A listing through the kind's own source, as the catalog starts it.
async fn listed(kind: FleetAgentKind, options: ListOptions) -> Result<Vec<ListedModel>, String> {
    (source_for(kind).list)(options).await
}

fn options(work_dir: &Path, command: &Path) -> ListOptions {
    let mut options = ListOptions::new(work_dir, server_env());
    options.command = Some(command.into());
    options
}

/// `recorder` of models.test.ts: a CLI that notes its environment, its folder and what it found
/// there, then answers.
fn recorder(dir: &Path, name: &str, answer: &str) -> PathBuf {
    let file = dir.join(name);
    let q = |ending: &str| sh_quote(&noted(&file, ending));
    write_script(
        &file,
        &format!(
            "/usr/bin/env > {}\npwd > {}\nls -A > {}\n{answer}",
            q("env"),
            q("cwd"),
            q("ls")
        ),
    );
    file
}

fn env_names(file: &Path) -> Vec<String> {
    read(noted(file, "env"))
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| line.split('=').next().unwrap().to_owned())
        .collect()
}

/// `plant` of models.test.ts: what another run, or another user, could leave in the folder for
/// the next CLI to read.
fn plant(work_dir: &Path) {
    fs::create_dir_all(work_dir.join(".claude")).unwrap();
    fs::write(
        work_dir.join(".claude").join("settings.json"),
        r#"{"hooks":{}}"#,
    )
    .unwrap();
    fs::write(work_dir.join("CLAUDE.md"), "planted").unwrap();
}

fn expect_own_empty_folder(file: &Path, work_dir: &Path) {
    assert_eq!(
        read(noted(file, "cwd")).trim(),
        work_dir.canonicalize().unwrap().to_str().unwrap()
    );
    assert_eq!(read(noted(file, "ls")), "");
    assert_eq!(
        fs::metadata(work_dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

fn no_secrets(file: &Path) {
    let names = env_names(file);
    for name in FORBIDDEN {
        assert!(!names.iter().any(|each| each == name), "{name} passed");
    }
}

/// A fake `codex app-server` in sh, answering as models.test.ts's recorded one does: a
/// notification before the answers, a request of the server's own with no result, two pages.
/// It notes each line it is sent in `<file>.sent`.
fn fake_codex(dir: &Path) -> PathBuf {
    let file = dir.join("codex");
    let sent = sh_quote(&noted(&file, "sent"));
    write_script(
        &file,
        &format!(
            r#"while IFS= read -r line; do
  printf '%s\n' "$line" >> {sent}
  case "$line" in
    *'"method":"initialize"'*)
      echo '{{"jsonrpc":"2.0","method":"remoteControl/status/changed","params":{{"status":"disabled"}}}}'
      echo '{{"jsonrpc":"2.0","id":1,"result":{{"userAgent":"codex"}}}}';;
    *'"method":"model/list"'*)
      id=$(printf '%s' "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
      echo '{{"jsonrpc":"2.0","id":3,"method":"item/tool/requestUserInput","params":{{}}}}'
      case "$line" in
        *'"cursor":"p2"'*) echo '{{"jsonrpc":"2.0","id":'"$id"',"result":{{"data":[{{"id":"gpt-reserve","model":"gpt-reserve","displayName":"GPT-Reserve","hidden":true}}],"nextCursor":null}}}}';;
        *) echo '{{"jsonrpc":"2.0","id":'"$id"',"result":{{"data":[{{"id":"gpt-6-sol","model":"gpt-6-sol","displayName":"GPT-6-Sol","hidden":false}}],"nextCursor":"p2"}}}}';;
      esac;;
  esac
done"#
        ),
    );
    file
}

// describe("codex app-server's model/list")

/// models.test.ts: codex app-server's model/list > reads every page, skipping what is not an
/// answer
#[tokio::test]
async fn reads_every_page_skipping_what_is_not_an_answer() {
    let dir = TempDir::new("codex-fake");
    let fake = fake_codex(dir.path());
    assert_eq!(
        listed(
            FleetAgentKind::Codex,
            options(&dir.path().join("work"), &fake)
        )
        .await,
        Ok(vec![
            labelled("gpt-6-sol", "GPT-6-Sol"),
            labelled("gpt-reserve", "GPT-Reserve"),
        ])
    );
}

/// What `codex app-server` is sent, as `listCodexModels` writes it
/// (`server/fleet/model-lists.ts:130, 148-149, 154`): initialize, initialized, then `model/list`
/// with hidden models too, page by page with the cursor of the page before.
#[tokio::test]
async fn sends_codex_what_typescript_sends() {
    let dir = TempDir::new("codex-sent");
    let fake = fake_codex(dir.path());
    listed(
        FleetAgentKind::Codex,
        options(&dir.path().join("work"), &fake),
    )
    .await
    .unwrap();
    assert_eq!(
        read(noted(&fake, "sent")),
        concat!(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"herdr-fleet","version":"0"}}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","method":"initialized"}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":2,"method":"model/list","params":{"includeHidden":true}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":3,"method":"model/list","params":{"includeHidden":true,"cursor":"p2"}}"#,
            "\n",
        )
    );
}

/// An error answer to `model/list` fails the listing with codex's message, and an app-server that
/// closes before it answered fails it too (`server/fleet/model-lists.ts:140, 151`).
#[tokio::test]
async fn codex_fails_on_an_error_answer_and_on_an_early_close() {
    let dir = TempDir::new("codex-error");
    let fake = dir.path().join("codex");
    write_script(
        &fake,
        r#"read a; echo '{"id":1,"result":{}}'; read b; read c; echo '{"id":2,"error":{"message":"not signed in"}}'"#,
    );
    assert_eq!(
        listed(
            FleetAgentKind::Codex,
            options(&dir.path().join("work"), &fake)
        )
        .await,
        Err("codex: not signed in".to_owned())
    );
    let early = dir.path().join("codex-early");
    write_script(&early, "read a; exit 0");
    assert_eq!(
        listed(
            FleetAgentKind::Codex,
            options(&dir.path().join("work2"), &early)
        )
        .await,
        Err("codex app-server closed before it answered".to_owned())
    );
}

// describe("what a model listing's CLI gets")

/// models.test.ts: what a model listing's CLI gets > agy lists in its own emptied folder, without
/// an API key or herdr session, and with its self-update held off
#[tokio::test]
async fn agy_lists_in_its_own_emptied_folder_without_an_api_key_or_herdr_session_and_with_its_self_update_held_off()
 {
    let dir = TempDir::new("agy");
    let work_dir = dir.path().join("model-list").join("agy");
    plant(&work_dir);
    let agy = recorder(
        dir.path(),
        "agy",
        "printf 'gemini-3.1-pro-high\\tGemini 3.1 Pro (High)\\n'",
    );
    assert_eq!(
        listed(FleetAgentKind::Agy, options(&work_dir, &agy)).await,
        Ok(vec![labelled(
            "gemini-3.1-pro-high",
            "Gemini 3.1 Pro (High)"
        )])
    );
    expect_own_empty_folder(&agy, &work_dir);
    no_secrets(&agy);
    assert!(read(noted(&agy, "env")).contains("AGY_CLI_DISABLE_AUTO_UPDATE=true\n"));
}

/// models.test.ts: what a model listing's CLI gets > cursor lists in its own emptied folder,
/// without an API key or herdr session
#[tokio::test]
async fn cursor_lists_in_its_own_emptied_folder_without_an_api_key_or_herdr_session() {
    let dir = TempDir::new("cursor");
    let work_dir = dir.path().join("model-list").join("cursor");
    plant(&work_dir);
    let cursor = recorder(dir.path(), "cursor-agent", "echo 'auto - Auto (default)'");
    assert_eq!(
        listed(FleetAgentKind::Cursor, options(&work_dir, &cursor)).await,
        Ok(vec![labelled("auto", "Auto (default)")])
    );
    expect_own_empty_folder(&cursor, &work_dir);
    no_secrets(&cursor);
    let names = env_names(&cursor);
    for name in ["PATH", "HOME", "LANG"] {
        assert!(names.iter().any(|each| each == name), "{name} missing");
    }
}

/// models.test.ts: what a model listing's CLI gets > pi lists in its own emptied folder, with its
/// own folder's setting and no API key or herdr session
#[tokio::test]
async fn pi_lists_in_its_own_emptied_folder_with_its_own_folders_setting_and_no_api_key_or_herdr_session()
 {
    let dir = TempDir::new("pi");
    let work_dir = dir.path().join("model-list").join("pi");
    plant(&work_dir);
    let pi = recorder(
        dir.path(),
        "pi",
        "printf 'provider model\\nopenai gpt-4.1\\n'",
    );
    assert_eq!(
        listed(FleetAgentKind::Pi, options(&work_dir, &pi)).await,
        Ok(vec![model("openai/gpt-4.1")])
    );
    expect_own_empty_folder(&pi, &work_dir);
    no_secrets(&pi);
    let names = env_names(&pi);
    assert!(names.iter().any(|name| name == "PI_CODING_AGENT_DIR"));
    assert!(!names.iter().any(|name| name == "CODEX_HOME"));
}

/// Each listing passes the listing command's own arguments (`agy models`, `cursor-agent models`,
/// `pi --list-models`, `server/fleet/model-lists.ts:58, 70, 85`), and a CLI that exits with an
/// error fails the listing with the command's name (`run`, `:36`).
#[tokio::test]
async fn each_listing_passes_its_arguments_and_fails_on_an_error_exit() {
    let dir = TempDir::new("args");
    let args = |name: &str| {
        let file = dir.path().join(name);
        let q = sh_quote(&noted(&file, "args"));
        write_script(&file, &format!("printf '%s\\n' \"$*\" > {q}\nexit 3"));
        file
    };
    let agy = args("agy");
    let cursor = args("cursor-agent");
    let pi = args("pi");
    let work = |name: &str| dir.path().join("model-list").join(name);
    let failed = |file: &Path, verb: &str| format!("{} {verb} failed", file.display());
    assert_eq!(
        listed(FleetAgentKind::Agy, options(&work("agy"), &agy)).await,
        Err(failed(&agy, "models"))
    );
    assert_eq!(
        listed(FleetAgentKind::Cursor, options(&work("cursor"), &cursor)).await,
        Err(failed(&cursor, "models"))
    );
    assert_eq!(
        listed(FleetAgentKind::Pi, options(&work("pi"), &pi)).await,
        Err(failed(&pi, "--list-models"))
    );
    assert_eq!(read(noted(&agy, "args")), "models\n");
    assert_eq!(read(noted(&cursor, "args")), "models\n");
    assert_eq!(read(noted(&pi, "args")), "--list-models\n");
}

/// `fakeOpencode` of models.test.ts: `service status` says where the service is (or nothing, or
/// fails as 1.x does for a command it does not know), `api GET` answers an empty list the first
/// time and the models after, like a place the service has not loaded.
fn fake_opencode(dir: &Path, behaviour: &str) -> PathBuf {
    let file = dir.join("opencode");
    let q = |ending: &str| sh_quote(&noted(&file, ending));
    let status = match behaviour {
        "running" => "echo http://127.0.0.1:49374; exit 0",
        "stopped" => "exit 0",
        _ => "echo 'opencode [project]  start opencode tui'; exit 1",
    };
    let n = q("n");
    write_script(
        &file,
        &format!(
            r#"/usr/bin/env > {env}
pwd > {cwd}
ls -A > {ls}
printf '%s\n' "$*" >> {args}
if [ "$1" = service ]; then {status}; fi
if [ "$1" = api ]; then n=$(cat {n} 2>/dev/null || echo 0); echo $((n+1)) > {n}; if [ "$n" = 0 ]; then echo '{{"data":[]}}'; else echo '{{"data":[{{"providerID":"anthropic","id":"claude-sonnet-5-5"}},{{"providerID":"opencode","id":"big-pickle"}}]}}'; fi; exit 0; fi
exit 1"#,
            env = q("env"),
            cwd = q("cwd"),
            ls = q("ls"),
            args = q("args"),
        ),
    );
    file
}

/// models.test.ts: what a model listing's CLI gets > opencode lists from the running service by
/// `opencode api`, asking again once for a place the service has not loaded, in its own emptied
/// folder
#[tokio::test]
async fn opencode_lists_from_the_running_service_by_opencode_api_asking_again_once_for_a_place_the_service_has_not_loaded_in_its_own_emptied_folder()
 {
    let dir = TempDir::new("opencode");
    let work_dir = dir.path().join("model-list").join("opencode");
    plant(&work_dir);
    let opencode = fake_opencode(dir.path(), "running");
    let mut quick = options(&work_dir, &opencode);
    quick.retry_after = Duration::from_millis(1);
    assert_eq!(
        listed(FleetAgentKind::Opencode, quick).await,
        Ok(vec![
            model("anthropic/claude-sonnet-5-5"),
            model("opencode/big-pickle")
        ])
    );
    // the status is a read; no `serve`, no `models`, nothing that would start a server
    assert_eq!(
        read(noted(&opencode, "args")),
        "service status\napi GET /api/model\nservice status\napi GET /api/model\n"
    );
    assert_eq!(
        read(noted(&opencode, "cwd")).trim(),
        work_dir.canonicalize().unwrap().to_str().unwrap()
    );
    no_secrets(&opencode);
    let names = env_names(&opencode);
    for name in ["PATH", "HOME", "LANG"] {
        assert!(names.iter().any(|each| each == name), "{name} missing");
    }
    assert!(read(noted(&opencode, "env")).contains("OPENCODE_DISABLE_AUTOUPDATE=true\n"));
    assert_eq!(
        fs::metadata(&work_dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

/// opencode asks again 2 seconds after an empty list when the options name no other wait
/// (`retryAfterMs ?? 2000`, `server/fleet/model-lists.ts:115`), and only once: a second empty
/// list is no list.
#[tokio::test]
async fn opencode_asks_again_once_two_seconds_after_an_empty_list() {
    let dir = TempDir::new("opencode-wait");
    let opencode = fake_opencode(dir.path(), "running");
    let first = options(&dir.path().join("model-list").join("opencode"), &opencode);
    assert_eq!(first.retry_after, Duration::from_secs(2));
    let started = Instant::now();
    assert_eq!(
        listed(FleetAgentKind::Opencode, first)
            .await
            .map(|m| m.len()),
        Ok(2)
    );
    let waited = started.elapsed();
    assert!(waited >= Duration::from_secs(2), "{waited:?}");
    assert!(waited < Duration::from_secs(10), "{waited:?}");

    // a service that answers [] twice: asked twice, and no list
    let empty = dir.path().join("opencode-empty");
    let args = sh_quote(&noted(&empty, "args"));
    write_script(
        &empty,
        &format!(
            r#"printf '%s\n' "$*" >> {args}
if [ "$1" = service ]; then echo http://127.0.0.1:1; exit 0; fi
echo '{{"data":[]}}'"#
        ),
    );
    let mut twice = options(&dir.path().join("model-list").join("opencode2"), &empty);
    twice.retry_after = Duration::from_millis(1);
    assert_eq!(listed(FleetAgentKind::Opencode, twice).await, Ok(vec![]));
    assert_eq!(
        read(noted(&empty, "args")),
        "service status\napi GET /api/model\nservice status\napi GET /api/model\n"
    );
}

/// models.test.ts: what a model listing's CLI gets > opencode with no service running gives no
/// list and starts nothing: `api` is never run
#[tokio::test]
async fn opencode_with_no_service_running_gives_no_list_and_starts_nothing_api_is_never_run() {
    let dir = TempDir::new("opencode-stopped");
    let opencode = fake_opencode(dir.path(), "stopped");
    let error = listed(
        FleetAgentKind::Opencode,
        options(&dir.path().join("model-list").join("opencode"), &opencode),
    )
    .await
    .unwrap_err();
    assert!(error.contains("no OpenCode service is running"), "{error}");
    assert_eq!(read(noted(&opencode, "args")), "service status\n");
}

/// models.test.ts: what a model listing's CLI gets > opencode 1.x, which does not know
/// `service`, fails the same way before anything else is run
#[tokio::test]
async fn opencode_1x_which_does_not_know_service_fails_the_same_way_before_anything_else_is_run() {
    let dir = TempDir::new("opencode-v1");
    let old = fake_opencode(dir.path(), "v1");
    let error = listed(
        FleetAgentKind::Opencode,
        options(&dir.path().join("model-list").join("opencode"), &old),
    )
    .await
    .unwrap_err();
    assert!(error.contains("no OpenCode service is running"), "{error}");
    assert_eq!(read(noted(&old, "args")), "service status\n");
}

/// models.test.ts: what a model listing's CLI gets > opencode's reply is bounded in size and in
/// time (`opencodeApiGet` is C2's `opencode_api_get`, which the listing calls)
#[tokio::test]
async fn opencodes_reply_is_bounded_in_size_and_in_time() {
    let dir = TempDir::new("opencode-bounds");
    let opencode = fake_opencode(dir.path(), "running");
    fs::write(noted(&opencode, "n"), "1\n").unwrap();
    let mut options = OpencodeCliOptions::new(dir.path().join("w"), server_env());
    options.command = opencode.into();
    options.max_reply_bytes = Some(30);
    let error = opencode_api_get(options, "/api/model").await.unwrap_err();
    assert!(error.to_string().contains("more than 30 bytes"), "{error}");
    let slow = dir.path().join("slow");
    write_script(
        &slow,
        "if [ \"$1\" = service ]; then echo http://127.0.0.1:1; exit 0; fi\nexec sleep 30",
    );
    let mut options = OpencodeCliOptions::new(dir.path().join("w2"), server_env());
    options.command = slow.into();
    options.timeout = Duration::from_millis(300);
    assert!(opencode_api_get(options, "/api/model").await.is_err());
}

/// models.test.ts: what a model listing's CLI gets > codex app-server runs in its own emptied
/// folder, with CODEX_HOME and no API key or herdr session
#[tokio::test]
async fn codex_app_server_runs_in_its_own_emptied_folder_with_codex_home_and_no_api_key_or_herdr_session()
 {
    let dir = TempDir::new("codex");
    let work_dir = dir.path().join("model-list").join("codex");
    plant(&work_dir);
    let result = json!({ "id": 2, "result": { "data": [{ "id": "gpt-6", "model": "gpt-6", "displayName": "GPT-6" }], "nextCursor": null } });
    let codex = recorder(
        dir.path(),
        "codex",
        &format!("read a\necho '{{\"id\":1,\"result\":{{}}}}'\nread b\nread c\necho '{result}'"),
    );
    assert_eq!(
        listed(FleetAgentKind::Codex, options(&work_dir, &codex)).await,
        Ok(vec![labelled("gpt-6", "GPT-6")])
    );
    expect_own_empty_folder(&codex, &work_dir);
    no_secrets(&codex);
    assert!(env_names(&codex).iter().any(|name| name == "CODEX_HOME"));
}

/// models.test.ts: what a model listing's CLI gets > refuses a link in place of the folder
#[tokio::test]
async fn refuses_a_link_in_place_of_the_folder() {
    let dir = TempDir::new("link");
    fs::create_dir(dir.path().join("elsewhere")).unwrap();
    std::os::unix::fs::symlink(dir.path().join("elsewhere"), dir.path().join("agy")).unwrap();
    let agy = recorder(dir.path(), "agy-cli", "echo x");
    let error = listed(FleetAgentKind::Agy, options(&dir.path().join("agy"), &agy))
        .await
        .unwrap_err();
    assert!(error.contains("is not a folder"), "{error}");
}
