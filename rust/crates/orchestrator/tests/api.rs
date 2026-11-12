//! The `/api/fleet` router (`server/fleet/api.ts`), called with tower's `oneshot` and no port, as
//! the core will mount it (ADR 0242-phase-3-split, ADR 0269-fleet-api). Each test moved from
//! `server/fleet/api.test.ts` names its `it`. The router does not look at `X-Herdr-Fleet` (the
//! core's access control does, #270), so no request here carries it, and the lines of api.test.ts
//! that expect a 403 without it are left to #270.

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use axum::body::Body;
use axum::http::Request;
use common::{FakeRuntime, Folder, SetupOptions, TestClock, config, deps, role, setup};
use herdr_fleet_orchestrator::Clock;
use herdr_fleet_orchestrator::agents::AgentDefinition;
use herdr_fleet_orchestrator::api::{FactoryReporter, FleetApiDeps, router};
use herdr_fleet_orchestrator::entrances::{EntranceDeps, EntranceStore};
use herdr_fleet_orchestrator::events::EventLog;
use herdr_fleet_orchestrator::fleet::{BoxFuture, LandingTools, Orchestrator};
use herdr_fleet_orchestrator::github::{GhError, GitHub, PullRequestReading};
use herdr_fleet_orchestrator::launch::Host;
use herdr_fleet_orchestrator::models::{CatalogOptions, ListOptions, ModelCatalog, ModelSource};
use herdr_fleet_orchestrator::registry::RunRegistry;
use herdr_fleet_orchestrator::runtime::RuntimeError;
use herdr_fleet_orchestrator::settings::{FleetSettingsDeps, FleetSettingsStore};
use herdr_fleet_orchestrator::thread::{self, BranchState, DiffText, RemoveOptions, SetupOutcome};
use herdr_fleet_orchestrator::usage::{UsageProbe, UsageTracker, UsageTrackerOptions};
use http_body_util::BodyExt;
use jiff::tz::TimeZone;
use protocol::{AgentState, DiffStat, FleetAgentKind, ListedModel, UsageReading, UsageWindow};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

// ---------------------------------------------------------------------------------------------
// The fleet the tests call (`fleet()` of api.test.ts)

/// api.test.ts's three roles.
fn roles() -> Vec<AgentDefinition> {
    vec![
        AgentDefinition {
            description: "implements".to_owned(),
            ..role("worker")
        },
        AgentDefinition {
            description: "coordinates".to_owned(),
            agent: FleetAgentKind::Claude,
            interactive: Some(true),
            edits: Some(false),
            ..role("coordinator")
        },
        AgentDefinition {
            description: "leads a thread".to_owned(),
            agent: FleetAgentKind::Claude,
            interactive: Some(true),
            ..role("lead")
        },
    ]
}

/// `git` in `cwd` with a name and address of its own, which must succeed.
fn git(cwd: &Path, args: &[&str]) {
    let status = StdCommand::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["-c", "user.email=t@example.invalid", "-c", "user.name=t"])
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} in {}", cwd.display());
}

/// A repository at `path` on branch main with one empty commit; its path as git reports it.
fn repository(path: &Path) -> PathBuf {
    fs::create_dir_all(path).unwrap();
    git(path, &["init", "-q", "-b", "main"]);
    git(path, &["commit", "-q", "--allow-empty", "-m", "base"]);
    path.canonicalize().unwrap()
}

/// A `gh` standing in for GitHub's: it notes the folder and arguments of each call, and answers
/// `pr list` and `issue list` with what the test set (an empty list unless told otherwise).
struct FakeGh {
    dir: Folder,
}

impl FakeGh {
    fn new() -> FakeGh {
        let dir = Folder::new();
        let d = dir.path().display().to_string().replace('\'', r"'\''");
        let body = format!(
            r#"d='{d}'
printf '%s|%s\n' "$PWD" "$*" >> "$d/calls"
case "$1 $2" in
  "pr list") f=prlist ;;
  "issue list") f=issues ;;
  *) f=other ;;
esac
if [ -f "$d/$f.out" ]; then cat "$d/$f.out"; else echo '[]'; fi
[ -f "$d/$f.err" ] && cat "$d/$f.err" >&2
[ -f "$d/$f.code" ] && exit "$(cat "$d/$f.code")"
exit 0"#
        );
        // a shell writes the script, not this process (ETXTBSY: see child-process's tests/common)
        let status = StdCommand::new("/bin/sh")
            .args([
                "-c",
                r#"printf '#!/bin/sh\n%s\n' "$2" > "$1" && chmod 755 "$1""#,
                "sh",
            ])
            .arg(dir.path().join("gh"))
            .arg(&body)
            .status()
            .unwrap();
        assert!(status.success());
        FakeGh { dir }
    }

    fn github(&self) -> GitHub {
        GitHub::with_program(self.dir.path().join("gh"))
    }

    /// Each call as `<folder>|<arguments>`.
    fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.dir.path().join("calls"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    /// `gh issue list` fails with `stderr`.
    fn fail_issues(&self, stderr: &str) {
        fs::write(self.dir.path().join("issues.out"), "").unwrap();
        fs::write(self.dir.path().join("issues.err"), stderr).unwrap();
        fs::write(self.dir.path().join("issues.code"), "1").unwrap();
    }
}

/// git as the server runs it (thread.ts's functions), with no pull request on GitHub: what
/// api.test.ts hands its orchestrator (`landing: { readPullRequest: async () => null }`).
struct Git;

impl LandingTools for Git {
    fn git_root<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<PathBuf>> {
        Box::pin(thread::git_root(cwd))
    }
    fn git_head<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<String>> {
        Box::pin(thread::git_head(cwd))
    }
    fn diff_stat<'a>(&'a self, cwd: &'a Path, base: &'a str) -> BoxFuture<'a, Option<DiffStat>> {
        Box::pin(thread::diff_stat(cwd, base))
    }
    fn exclude_worktrees<'a>(&'a self, repo: &'a Path) -> BoxFuture<'a, std::io::Result<()>> {
        Box::pin(thread::exclude_worktrees(repo))
    }
    fn run_setup<'a>(
        &'a self,
        cwd: &'a Path,
        command: &'a str,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, SetupOutcome> {
        Box::pin(thread::run_setup(cwd, command, cancel))
    }
    fn git_branch<'a>(&'a self, repo: &'a Path) -> BoxFuture<'a, Option<String>> {
        Box::pin(thread::git_branch(repo))
    }
    fn branch_state<'a>(
        &'a self,
        cwd: &'a Path,
        base: &'a str,
    ) -> BoxFuture<'a, Option<BranchState>> {
        Box::pin(thread::branch_state(cwd, base))
    }
    fn diff_text<'a>(&'a self, cwd: &'a Path, base: &'a str) -> BoxFuture<'a, Option<DiffText>> {
        Box::pin(thread::diff_text(cwd, base))
    }
    fn branch_head<'a>(&'a self, repo: &'a Path, branch: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(thread::branch_head(repo, branch))
    }
    fn is_merged<'a>(
        &'a self,
        repo: &'a Path,
        branch: &'a str,
        into: &'a str,
    ) -> BoxFuture<'a, bool> {
        Box::pin(thread::is_merged(repo, branch, into))
    }
    fn remove_thread<'a>(
        &'a self,
        repo: &'a Path,
        worktree: &'a Path,
        branch: &'a str,
        options: RemoveOptions,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(thread::remove_thread(repo, worktree, branch, options))
    }
    fn read_pull_request<'a>(
        &'a self,
        _repo: &'a Path,
        _branch: &'a str,
    ) -> BoxFuture<'a, Result<Option<PullRequestReading>, GhError>> {
        Box::pin(async { Ok(None) })
    }
}

/// The codex reading api.test.ts's probe answers: `{ readAt: 1, windows: [{ name: "5h",
/// usedPercent: 20 }] }`.
fn codex_reading() -> UsageReading {
    UsageReading {
        windows: vec![UsageWindow {
            name: "5h".to_owned(),
            used_percent: 20.0,
            resets_at: None,
        }],
        read_at: 1.0,
    }
}

/// The router over an orchestrator, usage, settings, skill folders, models and a factory report,
/// and what the tests read back.
struct Api {
    router: axum::Router,
    runtime: Arc<FakeRuntime>,
    usage: UsageTracker,
    probes: Arc<AtomicU32>,
    gh: FakeGh,
    /// the results, plans and the folder api.test.ts calls `resultsRoot`
    root: PathBuf,
    _setup: common::Setup,
    _folders: Vec<Folder>,
}

impl Api {
    /// `fleet()` of api.test.ts; `git` when the test needs real repositories.
    fn new(git: bool) -> Api {
        let landing: Option<Arc<dyn LandingTools>> = if git { Some(Arc::new(Git)) } else { None };
        let set = setup(SetupOptions {
            agents: Some(roles()),
            landing,
            ..SetupOptions::default()
        });
        Api::over(
            set.fleet.clone(),
            set.runtime.clone(),
            set.root.clone(),
            set.clock.clone(),
            set,
        )
    }

    fn over(
        fleet: Orchestrator,
        runtime: Arc<FakeRuntime>,
        root: PathBuf,
        clock: Arc<dyn Clock>,
        set: common::Setup,
    ) -> Api {
        let probes = Arc::new(AtomicU32::new(0));
        let mut options = UsageTrackerOptions::new(None, clock.clone());
        let counted = probes.clone();
        let probe: UsageProbe = Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(BTreeMap::from([("codex".to_owned(), codex_reading())])) })
        });
        options.probes.insert(FleetAgentKind::Codex, probe);
        let usage = UsageTracker::new(options);
        let (config_dir, home) = (Folder::new(), Folder::new());
        let settings = FleetSettingsStore::new(FleetSettingsDeps {
            agents: Arc::new(|_: &Path| roles()),
            usage: None,
            user_dir: config_dir.path().to_path_buf(),
        });
        let entrances = EntranceStore::new(EntranceDeps {
            command: "fleet".to_owned(),
            url: Box::new(|| "http://127.0.0.1:7317".to_owned()),
            token_required: false,
            home: home.path().to_path_buf(),
        });
        let mut catalog = CatalogOptions::new("/nonexistent", BTreeMap::new());
        catalog.clock = clock.clone();
        catalog.sources = Arc::new(|kind| {
            (kind == FleetAgentKind::Codex).then(|| ModelSource {
                complete: true,
                list: Arc::new(|_: ListOptions| {
                    Box::pin(async {
                        Ok(vec![ListedModel {
                            id: "gpt-6".to_owned(),
                            label: None,
                        }])
                    })
                }),
            })
        });
        let gh = FakeGh::new();
        let report = FactoryReporter {
            events: Arc::new(EventLog::new(root.join("fleet-events.jsonl"), clock)),
            github: gh.github(),
            time_zone: TimeZone::UTC,
        };
        let router = router(FleetApiDeps {
            fleet,
            usage: Some(usage.clone()),
            settings: Some(settings),
            entrances: Some(entrances),
            models: Some(ModelCatalog::new(catalog)),
            report: Some(report),
        });
        Api {
            router,
            runtime,
            usage,
            probes,
            gh,
            root,
            _setup: set,
            _folders: vec![config_dir, home],
        }
    }

    fn probes(&self) -> u32 {
        self.probes.load(Ordering::SeqCst)
    }

    /// `call(method, path, body)` of api.test.ts, without `X-Herdr-Fleet`: the status and the
    /// body read as JSON.
    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        call(&self.router, method, path, body).await
    }
}

/// `method path` with `body` as JSON (none: an empty body), the status and the body read as JSON.
async fn call(
    router: &axum::Router,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (u16, Value) {
    let bytes = body.map(|body| serde_json::to_vec(&body).unwrap());
    call_with_bytes(router, method, path, bytes).await
}

/// `method path` with `bytes` as they are (none: an empty body), the status and the body read as
/// JSON.
async fn call_with_bytes(
    router: &axum::Router,
    method: &str,
    path: &str,
    bytes: Option<Vec<u8>>,
) -> (u16, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .body(bytes.map_or_else(Body::empty, Body::from))
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .map(|value| value.to_str().unwrap().to_owned());
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body = serde_json::from_slice(&bytes).unwrap_or_else(|_| {
        panic!(
            "{method} {path}: {status}, not JSON: {}",
            String::from_utf8_lossy(&bytes)
        )
    });
    assert_eq!(
        content_type.as_deref(),
        Some("application/json; charset=utf-8"),
        "{method} {path}"
    );
    (status, body)
}

/// The error code of a body, `{ error: { code } }`.
fn code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or("")
}

/// `encodeURIComponent` of a path, for a query.
fn encoded(path: &Path) -> String {
    let mut out = String::new();
    for byte in path.display().to_string().bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// The routes

/// Every method and path of api.ts's doc comment (`server/fleet/api.ts:22-52`), written from it by
/// hand; `:target` is `t1`.
const ROUTES: [(&str, &str); 29] = [
    ("GET", "/roles"),
    ("GET", "/runs"),
    ("POST", "/spawn"),
    ("POST", "/threads"),
    ("GET", "/threads"),
    ("POST", "/projects"),
    ("GET", "/runs/t1"),
    ("POST", "/runs/t1/send"),
    ("POST", "/runs/t1/wait"),
    ("GET", "/runs/t1/read"),
    ("POST", "/runs/t1/interrupt"),
    ("POST", "/runs/t1/focus"),
    ("POST", "/runs/t1/resolve"),
    ("GET", "/runs/t1/diff"),
    ("GET", "/runs/t1/landing"),
    ("POST", "/runs/t1/land"),
    ("GET", "/runs/t1/plan"),
    ("POST", "/runs/t1/plan"),
    ("POST", "/runs/t1/plan/answer"),
    ("POST", "/close-done"),
    ("GET", "/usage"),
    ("POST", "/usage/refresh"),
    ("POST", "/usage/clear"),
    ("GET", "/settings"),
    ("POST", "/settings"),
    ("GET", "/models"),
    ("GET", "/entrances"),
    ("POST", "/entrances"),
    ("GET", "/report"),
];

const METHODS: [&str; 7] = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];

/// `notFound()` of api.ts.
fn not_found() -> Value {
    json!({ "error": { "code": "not_found", "message": "Unknown fleet endpoint" } })
}

/// A HEAD has no body to read: its status alone.
async fn status(router: &axum::Router, method: &str, path: &str) -> u16 {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .body(Body::empty())
        .unwrap();
    router
        .clone()
        .oneshot(request)
        .await
        .unwrap()
        .status()
        .as_u16()
}

#[tokio::test(start_paused = true)]
async fn answers_the_methods_and_paths_of_api_ts_and_not_found_for_any_other() {
    let api = Api::new(false);
    for (method, path) in ROUTES {
        let (_, body) = api.call(method, path, None).await;
        assert_ne!(code(&body), "not_found", "{method} {path}: {body}");
    }
    let mut paths: Vec<&str> = ROUTES.iter().map(|(_, path)| *path).collect();
    paths.dedup();
    for path in &paths {
        for method in METHODS {
            if ROUTES.contains(&(method, path)) {
                continue;
            }
            if method == "HEAD" {
                // every branch of api.ts asks for GET, so HEAD finds none
                assert_eq!(status(&api.router, method, path).await, 404, "HEAD {path}");
                continue;
            }
            // a body api.ts can read: it reads the body of a POST to /runs/:target/<step> first
            let (status, body) = api.call(method, path, Some(json!({}))).await;
            assert_eq!((status, body), (404, not_found()), "{method} {path}");
        }
    }
    // so such a POST without a JSON object is refused for its body (api.ts:173-174)
    for path in [
        "/runs/t1/diff",
        "/runs/t1/landing",
        "/runs/t1/read",
        "/runs/t1/nowhere",
    ] {
        let (status, body) = api.call("POST", path, None).await;
        assert_eq!((status, code(&body)), (400, "invalid_json"), "POST {path}");
    }
    for path in [
        "/",
        "/nowhere",
        "/runs/t1/nowhere",
        "/runs/t1/plan/nowhere",
        "/usage/nowhere",
    ] {
        assert_eq!(
            api.call("GET", path, None).await,
            (404, not_found()),
            "GET {path}"
        );
        assert_eq!(
            api.call("POST", path, Some(json!({}))).await,
            (404, not_found()),
            "POST {path}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn answers_not_found_for_the_routes_of_a_part_it_was_not_given() {
    let set = setup(SetupOptions {
        agents: Some(roles()),
        ..SetupOptions::default()
    });
    let router = router(FleetApiDeps {
        fleet: set.fleet.clone(),
        usage: None,
        settings: None,
        entrances: None,
        models: None,
        report: None,
    });
    for (method, path) in [
        ("GET", "/usage"),
        ("POST", "/usage/refresh"),
        ("POST", "/usage/clear"),
        ("GET", "/settings"),
        ("POST", "/settings"),
        ("GET", "/models"),
        ("GET", "/entrances"),
        ("POST", "/entrances"),
        ("GET", "/report?cwd=%2Frepo"),
    ] {
        assert_eq!(
            call(&router, method, path, Some(json!({}))).await,
            (404, not_found()),
            "{method} {path}"
        );
    }
    assert_eq!(
        call(&router, "GET", "/runs", None).await,
        (200, json!({ "runs": [] }))
    );
}

#[tokio::test(start_paused = true)]
async fn reads_a_body_as_json_whatever_its_content_type_says_and_wants_an_object() {
    let api = Api::new(false);
    // api.ts's readBody: `request.json()`, which reads the bytes as JSON with no Content-Type
    assert_eq!(
        api.call("POST", "/close-done", Some(json!({}))).await,
        (200, json!({ "runs": [] }))
    );
    let (status, body) = api.call("POST", "/close-done", None).await;
    assert_eq!((status, code(&body)), (400, "invalid_json"));
    // the Fetch standard's `json()` decodes the bytes as UTF-8, dropping a byte order mark
    let request = Request::builder()
        .method("POST")
        .uri("/close-done")
        .body(Body::from(b"\xEF\xBB\xBF{}".to_vec()))
        .unwrap();
    let response = api.router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let (status, body) = api.call("POST", "/close-done", Some(json!([1]))).await;
    assert_eq!((status, code(&body)), (400, "invalid_body"));
    assert_eq!(
        body["error"]["message"],
        "request body must be a JSON object"
    );
}

// ---------------------------------------------------------------------------------------------
// X-Herdr-Fleet

/// api.test.ts: "refuses a change without X-Herdr-Fleet: 1, which a page on another site cannot
/// send" stays with the core's access control (#270, ADR 0107-crate-split): the router lets a
/// change through without the header.
#[tokio::test(start_paused = true)]
async fn leaves_the_fleet_header_to_the_cores_access_control() {
    let api = Api::new(false);
    let (status, body) = api
        .call(
            "POST",
            "/spawn",
            Some(json!({ "role": "worker", "task": "t" })),
        )
        .await;
    assert_eq!(status, 201, "{body}");
}

// ---------------------------------------------------------------------------------------------
// api.test.ts

/// api.test.ts: "spawns, lists within the caller's fleet, reads, sends and waits"
#[tokio::test(start_paused = true)]
async fn spawns_lists_within_the_callers_fleet_reads_sends_and_waits() {
    let api = Api::new(false);
    api.runtime.set_output("recent output");
    let (status, spawned) = api
        .call(
            "POST",
            "/spawn",
            Some(json!({ "role": "worker", "task": "build it", "group": "g1", "cwd": "/w", "caller_pane_id": "w0:p1", "depth": 0 })),
        )
        .await;
    assert_eq!(status, 201, "{spawned}");
    let run = &spawned["run"];
    assert_eq!(
        (&run["role"], &run["group"], &run["state"], &run["depth"]),
        (&json!("worker"), &json!("g1"), &json!("working"), &json!(1))
    );
    let id = run["id"].as_str().unwrap().to_owned();
    assert_eq!(
        api.call("GET", "/runs?group=g1", None).await.1["runs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        api.call("GET", "/runs?group=g2", None).await.1["runs"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        api.call("GET", "/runs/worker?group=g1", None).await.1["run"]["id"],
        json!(id)
    );
    assert_eq!(
        api.call("GET", &format!("/runs/{id}/read?group=g1&lines=5"), None)
            .await,
        (200, json!({ "text": "recent output" }))
    );
    let (status, timed_out) = api
        .call(
            "POST",
            &format!("/runs/{id}/wait"),
            Some(json!({ "group": "g1", "timeout_ms": 20 })),
        )
        .await;
    assert_eq!(status, 408);
    assert_eq!(code(&timed_out), "wait_timeout");
    assert_eq!(
        (&timed_out["run"]["id"], &timed_out["run"]["state"]),
        (&json!(id), &json!("working"))
    );
    let (_, sent) = api
        .call(
            "POST",
            &format!("/runs/{id}/send"),
            Some(json!({ "group": "g1", "message": "and test it" })),
        )
        .await;
    assert_eq!(sent["run"]["state"], "working");
    let (_, roles) = api.call("GET", "/roles", None).await;
    assert!(
        roles["roles"]
            .as_array()
            .unwrap()
            .contains(&json!({ "name": "worker", "description": "implements", "agent": "pi", "source": "bundled" })),
        "{roles}"
    );
}

/// api.test.ts: "lists usage without running a CLI, refreshes stale probes (all with all: true)
/// only on a POST, and clears cooldowns"
#[tokio::test(start_paused = true)]
async fn lists_usage_without_running_a_cli_refreshes_stale_probes_and_clears_cooldowns() {
    let api = Api::new(false);
    assert_eq!(
        api.call("GET", "/usage", None).await,
        (200, json!({ "usage": [] }))
    );
    assert_eq!(api.probes(), 0);
    // `readAt: 1` and `usedPercent: 20`: a JavaScript number, which serde writes `1.0` and `20.0`
    let entry = json!([{ "key": "codex", "reading": { "readAt": 1.0, "windows": [{ "name": "5h", "usedPercent": 20.0 }] } }]);
    assert_eq!(
        api.call("POST", "/usage/refresh", Some(json!({}))).await,
        (200, json!({ "usage": entry }))
    );
    api.call("POST", "/usage/refresh", Some(json!({}))).await;
    assert_eq!(api.probes(), 1);
    // the Fleet screen's own refresh (no `all`) leaves a reading tried minutes ago alone; the button forces
    api.call("POST", "/usage/refresh", Some(json!({ "all": false })))
        .await;
    assert_eq!(api.probes(), 1);
    api.call("POST", "/usage/refresh", Some(json!({ "all": true })))
        .await;
    assert_eq!(api.probes(), 2);
    // without `all` the age limit is AUTO_REFRESH (5 minutes), not the spawns' PROBE_TTL (1 minute):
    // 2 minutes on nothing is asked, past 5 the probe runs again
    tokio::time::advance(Duration::from_secs(2 * 60)).await;
    api.call("POST", "/usage/refresh", Some(json!({ "all": false })))
        .await;
    api.call("POST", "/usage/refresh", Some(json!({}))).await;
    assert_eq!(api.probes(), 2);
    tokio::time::advance(Duration::from_secs(3 * 60 + 1)).await;
    api.call("POST", "/usage/refresh", Some(json!({}))).await;
    assert_eq!(api.probes(), 3);
    assert_eq!(
        api.call("GET", "/usage", None).await.1["usage"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    api.usage
        .note_failure(FleetAgentKind::Cursor, None, "rate limit", 60.0);
    assert_eq!(
        api.call("POST", "/usage/clear", Some(json!({ "key": "cursor" })))
            .await,
        (200, json!({ "cleared": ["cursor"] }))
    );
    let (status, body) = api
        .call("POST", "/usage/clear", Some(json!({ "key": 3 })))
        .await;
    assert_eq!((status, code(&body)), (400, "invalid_body"));
}

/// api.test.ts: "starts a project's coordinator once, and lists the project's threads"
#[tokio::test]
async fn starts_a_projects_coordinator_once_and_lists_the_projects_threads() {
    let api = Api::new(true);
    // outside a repository, the folder is the project
    let root = api.root.display().to_string();
    let (status, started) = api
        .call(
            "POST",
            "/projects",
            Some(json!({ "task": "hello", "cwd": root })),
        )
        .await;
    assert_eq!(status, 201, "{started}");
    assert_eq!(
        (&started["run"]["role"], &started["run"]["project"]),
        (&json!("coordinator"), &json!(root))
    );
    let id = started["run"]["id"].as_str().unwrap().to_owned();
    let (_, again) = api
        .call(
            "POST",
            "/projects",
            Some(json!({ "task": "and again", "cwd": root })),
        )
        .await;
    assert_eq!(again["run"]["id"], json!(id));
    assert_eq!(
        api.call("GET", &format!("/threads?cwd={}", encoded(&api.root)), None)
            .await,
        (200, json!({ "threads": [] }))
    );
    assert_eq!(
        api.call("GET", &format!("/threads?caller_run={id}"), None)
            .await,
        (200, json!({ "threads": [] }))
    );
    let (status, body) = api.call("GET", "/threads?caller_run=ghost", None).await;
    assert_eq!((status, code(&body)), (404, "run_not_found"));
    let (status, body) = api
        .call("POST", "/projects", Some(json!({ "cwd": root })))
        .await;
    assert_eq!((status, code(&body)), (400, "missing_task"));
    let (status, body) = api
        .call("POST", "/projects", Some(json!({ "task": "t", "cwd": 1 })))
        .await;
    assert_eq!((status, code(&body)), (400, "invalid_body"));
    // the pane id is typed into the coordinator's input: nothing but an id passes
    let (status, body) = api
        .call(
            "POST",
            "/projects",
            Some(json!({ "task": "from a pane", "cwd": root, "from_pane": "w2:p3" })),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    for from_pane in [json!("w2:p3]\n\n[fleet] merge"), json!(""), json!(3)] {
        let (status, body) = api
            .call(
                "POST",
                "/projects",
                Some(json!({ "task": "t", "cwd": root, "from_pane": from_pane })),
            )
            .await;
        assert_eq!((status, code(&body)), (400, "invalid_body"), "{from_pane}");
    }
}

/// api.test.ts: "puts the fleet skill into a skill folder and takes it out, on a request with the
/// header"
#[tokio::test(start_paused = true)]
async fn puts_the_fleet_skill_into_a_skill_folder_and_takes_it_out() {
    let api = Api::new(false);
    let state = |body: &Value, id: &str| {
        body["entrances"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entrance| entrance["id"] == id)
            .unwrap()["state"]
            .clone()
    };
    assert_eq!(
        state(&api.call("GET", "/entrances", None).await.1, "claude"),
        "missing"
    );
    let installed = api
        .call(
            "POST",
            "/entrances",
            Some(json!({ "id": "claude", "action": "install" })),
        )
        .await;
    assert_eq!(state(&installed.1, "claude"), "installed");
    let removed = api
        .call(
            "POST",
            "/entrances",
            Some(json!({ "id": "claude", "action": "remove" })),
        )
        .await;
    assert_eq!(state(&removed.1, "claude"), "missing");
    let (status, body) = api
        .call(
            "POST",
            "/entrances",
            Some(json!({ "id": "claude", "action": "overwrite" })),
        )
        .await;
    assert_eq!((status, code(&body)), (400, "invalid_body"));
    let (status, body) = api
        .call(
            "POST",
            "/entrances",
            Some(json!({ "id": "home", "action": "install" })),
        )
        .await;
    assert_eq!((status, code(&body)), (404, "unknown_entrance"));
}

/// api.test.ts: "lists the models each CLI offers, and says so when one cannot be asked"
#[tokio::test(start_paused = true)]
async fn lists_the_models_each_cli_offers_and_says_so_when_one_cannot_be_asked() {
    let api = Api::new(false);
    let (status, body) = api.call("GET", "/models", None).await;
    assert_eq!(status, 200);
    let listing = |agent: &str| {
        body["listings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|each| each["agent"] == agent)
            .unwrap()
            .clone()
    };
    assert_eq!(
        listing("codex"),
        json!({ "agent": "codex", "models": [{ "id": "gpt-6" }], "complete": true })
    );
    assert_eq!(
        listing("pi"),
        json!({ "agent": "pi", "models": [], "complete": false })
    );
}

/// api.test.ts: "marks a thread done and opens it again, and refuses a run that is no thread's lead"
#[tokio::test]
async fn marks_a_thread_done_and_opens_it_again_and_refuses_a_run_that_is_no_threads_lead() {
    let api = Api::new(true);
    let repo = api.root.join("repo");
    fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    let (status, body) = api
        .call(
            "POST",
            "/threads",
            Some(json!({ "title": "Fix", "task": "t", "cwd": repo })),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    let thread = &body["run"];
    let (id, group) = (thread["id"].as_str().unwrap(), &thread["group"]);
    let resolve_path = format!("/runs/{id}/resolve");
    let resolve = |body: Value| api.call("POST", &resolve_path, Some(body));
    assert!(resolve(json!({ "group": group })).await.1["run"]["resolvedAt"].is_number());
    assert!(
        resolve(json!({ "resolved": false, "group": group }))
            .await
            .1["run"]
            .get("resolvedAt")
            .is_none()
    );
    let (status, body) = resolve(json!({ "resolved": "yes", "group": group })).await;
    assert_eq!((status, code(&body)), (400, "invalid_body"));
    let (_, worker) = api
        .call(
            "POST",
            "/spawn",
            Some(json!({ "role": "worker", "task": "t", "group": "g9" })),
        )
        .await;
    let worker = worker["run"]["id"].as_str().unwrap();
    let (status, body) = api
        .call(
            "POST",
            &format!("/runs/{worker}/resolve"),
            Some(json!({ "group": "g9" })),
        )
        .await;
    assert_eq!((status, code(&body)), (409, "not_a_thread"));
}

/// api.test.ts: "shows a thread's change and checks, and takes the landing steps the person presses"
#[tokio::test]
async fn shows_a_threads_change_and_checks_and_takes_the_landing_steps_the_person_presses() {
    let api = Api::new(true);
    let repo = api.root.join("landing");
    repository(&repo);
    let (status, body) = api
        .call(
            "POST",
            "/threads",
            Some(json!({ "title": "Fix", "task": "t", "cwd": repo })),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    let thread = body["run"].clone();
    assert_eq!(thread["baseBranch"], "main");
    let (id, group) = (
        thread["id"].as_str().unwrap(),
        thread["group"].as_str().unwrap(),
    );
    let (_, checks) = api
        .call("GET", &format!("/runs/{id}/landing?group={group}"), None)
        .await;
    assert_eq!(
        (&checks["checks"]["baseBranch"], &checks["checks"]["behind"]),
        (&json!("main"), &json!(0))
    );
    assert_eq!(
        api.call("GET", &format!("/runs/{id}/diff?group={group}"), None)
            .await
            .0,
        200
    );
    let land_path = format!("/runs/{id}/land");
    let land = |body: Value| api.call("POST", &land_path, Some(body));
    // the lead is still at work on its task
    let (status, body) = land(json!({ "action": "pr", "group": group })).await;
    assert_eq!((status, code(&body)), (409, "run_busy"));
    let (status, body) = land(json!({ "action": "push", "group": group })).await;
    assert_eq!((status, code(&body)), (400, "invalid_action"));
    let (status, body) = land(json!({ "action": "comments", "comments": [{ "file": "a", "line": 0, "text": "x" }], "group": group })).await;
    assert_eq!((status, code(&body)), (400, "invalid_body"));
    let (status, body) = land(json!({ "action": "merge-pr", "group": group })).await;
    assert_eq!((status, code(&body)), (409, "no_pull_request"));
    api.runtime.set_get_status(AgentState::Idle);
    let (status, body) = land(json!({ "action": "discard", "group": group })).await;
    assert_eq!(
        (status, &body["run"]["landed"]),
        (200, &json!("discarded")),
        "{body}"
    );
    let branches = StdCommand::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["branch", "--list", thread["branch"].as_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&branches.stdout), "");
    let (status, body) = land(json!({ "action": "merge", "group": group })).await;
    assert_eq!((status, code(&body)), (409, "thread_landed"));
}

/// api.test.ts: "takes a thread lead's plan and shows it; the person's answers wait for the lead's
/// turn to end"
#[tokio::test]
async fn takes_a_thread_leads_plan_and_shows_it_the_persons_answers_wait_for_the_leads_turn() {
    let api = Api::new(true);
    let repo = api.root.join("plan");
    repository(&repo);
    let (_, body) = api
        .call(
            "POST",
            "/threads",
            Some(json!({ "title": "Fix", "task": "t", "cwd": repo })),
        )
        .await;
    let id = body["run"]["id"].as_str().unwrap().to_owned();
    let at = |path: &str| format!("/runs/{id}/plan{path}");
    let (status, body) = api.call("GET", &at(""), None).await;
    assert_eq!((status, code(&body)), (404, "no_plan"));
    let plan = json!({ "title": "Retry limit", "claims": [{ "text": "A failed send is tried three times.", "exhibit": { "kind": "list", "items": ["three tries"] },
        "ask": { "id": "limit", "question": "How many?", "options": [{ "value": "three", "label": "3" }, { "value": "five", "label": "5" }], "recommended": "three" } }] });
    let (status, body) = api
        .call("POST", &at(""), Some(json!({ "plan": { "title": "t" } })))
        .await;
    assert_eq!((status, code(&body)), (400, "invalid_plan"));
    // counted in bytes: 30,000 characters of Japanese are 90,000 bytes
    let mut large = plan.clone();
    large["filler"] = json!("あ".repeat(30_000));
    let (status, body) = api
        .call("POST", &at(""), Some(json!({ "plan": large })))
        .await;
    assert_eq!(
        (status, body["error"].clone()),
        (
            400,
            json!({ "code": "invalid_plan", "message": "The plan is larger than 65536 bytes." })
        )
    );
    let (status, body) = api
        .call("POST", &at(""), Some(json!({ "plan": plan })))
        .await;
    assert_eq!(
        (status, &body["plan"]["version"], &body["plan"]["title"]),
        (201, &json!(1), &json!("Retry limit")),
        "{body}"
    );
    assert_eq!(
        api.call("GET", &at(""), None).await.1["plan"]["version"],
        json!(1)
    );
    assert_eq!(
        api.call("GET", &format!("/runs/{id}"), None).await.1["run"]["plan"],
        json!({ "version": 1, "asks": 1 })
    );
    // the lead is still at work on its task
    let (status, body) = api
        .call(
            "POST",
            &at("/answer"),
            Some(json!({ "answer": { "version": 1 } })),
        )
        .await;
    assert_eq!((status, code(&body)), (409, "run_busy"));
    let (status, body) = api
        .call(
            "POST",
            &at("/answer"),
            Some(json!({ "answer": { "version": 0 } })),
        )
        .await;
    assert_eq!((status, code(&body)), (409, "plan_outdated"));
    let (status, body) = api
        .call(
            "POST",
            &at("/answer"),
            Some(json!({ "answer": { "version": 1, "choices": { "limit": "ten" } } })),
        )
        .await;
    assert_eq!((status, code(&body)), (400, "invalid_answer"));
    // a kept plan that does not hold together is answered as such, not as a server error
    fs::write(
        api.root.join("fleet-plans").join(format!("{id}.json")),
        json!({ "version": 1, "writtenAt": 1, "title": "t", "claims": [{ "text": 5 }] })
            .to_string(),
    )
    .unwrap();
    let (status, body) = api.call("GET", &at(""), None).await;
    assert_eq!((status, code(&body)), (409, "plan_unreadable"));
}

/// api.ts measures a plan as `Buffer.byteLength(JSON.stringify(plan))`: the length of the plan as
/// JavaScript writes it again, not as it was sent
#[tokio::test]
async fn measures_a_plan_as_javascript_writes_it() {
    let api = Api::new(true);
    let repo = api.root.join("plan");
    repository(&repo);
    let (_, body) = api
        .call(
            "POST",
            "/threads",
            Some(json!({ "title": "Fix", "task": "t", "cwd": repo })),
        )
        .await;
    let id = body["run"]["id"].as_str().unwrap().to_owned();
    // 20,000 times `1.0`, which JavaScript writes as `1`: 40,012 bytes in Bun for the filler alone
    let filler = vec!["1.0"; 20_000].join(",");
    let plan = format!(
        r#"{{ "plan": {{ "title": "Retry limit", "claims": [{{ "text": "A failed send is tried three times." }}], "filler": [{filler}] }} }}"#
    );
    let (status, body) = call_with_bytes(
        &api.router,
        "POST",
        &format!("/runs/{id}/plan"),
        Some(plan.into_bytes()),
    )
    .await;
    assert_eq!(
        (status, &body["plan"]["version"]),
        (201, &json!(1)),
        "{body}"
    );
}

/// api.test.ts: "reads the settings, and writes a change only with the fleet header"
#[tokio::test(start_paused = true)]
async fn reads_the_settings_and_writes_a_change() {
    let api = Api::new(false);
    let (_, read) = api
        .call(
            "GET",
            &format!("/settings?cwd={}", encoded(&api.root)),
            None,
        )
        .await;
    let names: Vec<&str> = read["settings"]["roles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|each| each["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["coordinator", "lead", "worker"]);
    let (_, written) = api
        .call(
            "POST",
            "/settings",
            Some(json!({ "patch": { "maxConcurrent": 3 } })),
        )
        .await;
    assert_eq!(
        written["settings"]["maxConcurrent"].as_f64(),
        Some(3.0),
        "{written}"
    );
    let (status, body) = api
        .call("POST", "/settings", Some(json!({ "patch": { "roles": { "coordinator": { "candidates": [{ "agent": "cursor" }] } } } })))
        .await;
    assert_eq!((status, code(&body)), (400, "invalid_settings"));
    let (status, body) = api
        .call("POST", "/settings", Some(json!({ "patch": 3 })))
        .await;
    assert_eq!((status, code(&body)), (400, "invalid_body"));
}

/// api.test.ts: "answers bad requests with the reason"
#[tokio::test(start_paused = true)]
async fn answers_bad_requests_with_the_reason() {
    let api = Api::new(false);
    let spawn = |body: Value| api.call("POST", "/spawn", Some(body));
    let refused = |answer: (u16, Value)| (answer.0, code(&answer.1).to_owned());
    assert_eq!(
        refused(spawn(json!({ "task": "t" })).await),
        (400, "missing_role".to_owned())
    );
    assert_eq!(
        refused(spawn(json!({ "role": "nobody", "task": "t" })).await),
        (404, "unknown_role".to_owned())
    );
    assert_eq!(
        refused(spawn(json!({ "role": "worker", "task": "t", "worktree": "yes" })).await),
        (400, "invalid_body".to_owned())
    );
    assert_eq!(
        refused(spawn(json!({ "role": "worker", "brief": "fix it" })).await),
        (400, "invalid_body".to_owned())
    );
    assert_eq!(
        refused(spawn(json!({ "role": "worker", "brief": { "goal": "g", "write": "src" } })).await),
        (400, "invalid_body".to_owned())
    );
    assert_eq!(
        refused(spawn(json!({ "role": "worker", "brief": { "goal": "g" } })).await),
        (400, "incomplete_brief".to_owned())
    );
    assert_eq!(
        spawn(json!({ "role": "worker", "brief": { "goal": "g", "write": [], "context": "none", "done": "d", "verify": "v" } })).await.0,
        201
    );
    assert_eq!(
        refused(spawn(json!({ "role": "worker", "task": "t", "avoid": ["gemini"] })).await),
        (400, "invalid_body".to_owned())
    );
    assert_eq!(
        refused(spawn(json!({ "role": "worker", "task": "t", "avoid": "codex" })).await),
        (400, "invalid_body".to_owned())
    );
    let (status, body) = spawn(json!({ "role": "worker", "task": "t", "avoid": ["codex"] })).await;
    assert_eq!((status, &body["run"]["agent"]), (201, &json!("pi")));
    assert_eq!(
        refused(spawn(json!({ "role": "worker", "task": "t", "depth": 5 })).await),
        (409, "depth_limit".to_owned())
    );
    assert_eq!(
        refused(api.call("GET", "/runs/ghost", None).await),
        (404, "run_not_found".to_owned())
    );
    assert_eq!(
        refused(
            api.call("POST", "/runs/ghost/send", Some(json!({ "message": "" })))
                .await
        ),
        (400, "missing_message".to_owned())
    );
    assert_eq!(api.call("GET", "/nowhere", None).await.0, 404);
}

// ---------------------------------------------------------------------------------------------
// The factory report

/// The report's lines as a `Vec` of `&str`.
fn report_lines(body: &Value) -> Vec<String> {
    body["report"]
        .as_str()
        .unwrap_or_else(|| panic!("no report: {body}"))
        .lines()
        .map(str::to_owned)
        .collect()
}

/// api.test.ts: "reports a project's factory metrics for the hours and planned label asked, and
/// refuses a request it cannot answer". TypeScript hands the route a fake reporter and checks what
/// it was given; here the route makes the report itself (ADR 0269-fleet-api), so the hours and the
/// label are read from the report's text (metrics.ts's `renderMetrics`), and a refused request
/// leaves `gh` unasked (`expect(reports).toHaveLength(2)`).
#[tokio::test]
async fn reports_a_projects_factory_metrics_for_the_hours_and_planned_label_asked() {
    let api = Api::new(false);
    let repo = repository(&api.root.join("repo"));
    let q = encoded(&repo);
    let (status, body) = api
        .call(
            "GET",
            &format!("/report?cwd={q}&hours=6&planned_label=%5Ephase%3A"),
            None,
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let lines = report_lines(&body);
    assert_eq!(
        lines[0],
        format!("# Factory metrics: {} (main)", repo.display())
    );
    // the tests' clock starts at 2026-11-01T00:00:00Z; 6 hours before it, in UTC
    // metrics.ts's renderMetrics notes an empty event log after the window (metrics.ts:185)
    assert_eq!(
        lines[2],
        "2026-10-31 18:00 to 2026-11-01 00:00 (no events for this project)"
    );
    assert!(
        lines.contains(&"- Issues opened without a planned label (^phase:): 0".to_owned()),
        "{lines:#?}"
    );
    let (status, body) = api.call("GET", &format!("/report?cwd={q}"), None).await;
    assert_eq!(status, 200, "{body}");
    let lines = report_lines(&body);
    // 24 hours unless asked, and no planned label
    assert_eq!(
        lines[2],
        "2026-10-31 00:00 to 2026-11-01 00:00 (no events for this project)"
    );
    assert!(
        lines.contains(&"- Issues opened: 0".to_owned()),
        "{lines:#?}"
    );
    let asked = api.gh.calls().len();
    assert_eq!(asked, 4, "{:?}", api.gh.calls());
    for (path, refusal) in [
        ("/report".to_owned(), "missing_cwd"),
        (format!("/report?cwd={q}&hours=0"), "invalid_hours"),
        (format!("/report?cwd={q}&hours=6h"), "invalid_hours"),
        (
            format!("/report?cwd={q}&planned_label=%28"),
            "invalid_planned_label",
        ),
        // a lookahead, which JavaScript reads and Rust's regex does not (ADR 0269-fleet-api)
        (
            format!("/report?cwd={q}&planned_label=%5E(%3F!tracking%24).*"),
            "invalid_planned_label",
        ),
    ] {
        let (status, body) = api.call("GET", &path, None).await;
        assert_eq!((status, code(&body)), (400, refusal), "{path}");
    }
    assert_eq!(api.gh.calls().len(), asked);
}

#[tokio::test]
async fn reports_on_the_repository_itself_from_a_threads_worktree() {
    let api = Api::new(false);
    let repo = repository(&api.root.join("repo"));
    let worktree = repo.join(".herdr-fleet/worktrees/t1");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            worktree.to_str().unwrap(),
            "-b",
            "fleet/t1",
        ],
    );
    let (status, body) = api
        .call("GET", &format!("/report?cwd={}", encoded(&worktree)), None)
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        report_lines(&body)[0],
        format!("# Factory metrics: {} (main)", repo.display())
    );
    let calls = api.gh.calls();
    assert_eq!(calls.len(), 2, "{calls:?}");
    for call in calls {
        assert_eq!(
            call.split('|').next(),
            Some(repo.to_str().unwrap()),
            "{call}"
        );
    }
}

#[tokio::test]
async fn refuses_a_report_outside_a_repository_and_answers_a_failing_gh_as_a_server_error() {
    let api = Api::new(false);
    let outside = Folder::new();
    let (status, body) = api
        .call(
            "GET",
            &format!("/report?cwd={}", encoded(outside.path())),
            None,
        )
        .await;
    assert_eq!(
        (status, body["error"].clone()),
        (
            400,
            json!({ "code": "not_a_repository", "message": format!("{} is not in a git repository", outside.path().display()) })
        )
    );
    let repo = repository(&api.root.join("repo"));
    api.gh.fail_issues("HTTP 401: Bad credentials");
    let (status, body) = api
        .call("GET", &format!("/report?cwd={}", encoded(&repo)), None)
        .await;
    assert_eq!((status, code(&body)), (500, "internal_error"), "{body}");
}

// ---------------------------------------------------------------------------------------------
// Cancelling, and the errors herdr gives

/// ADR 0242-phase-3-split, "取り消し": a spawn whose request goes away while the agent starts
/// closes the pane it opened (TypeScript's `abandonSpawn` on `request.signal`).
#[tokio::test(start_paused = true)]
async fn closes_the_pane_of_a_spawn_whose_request_went_away() {
    let api = Api::new(false);
    let (started, mut start) = tokio::sync::mpsc::unbounded_channel::<String>();
    api.runtime.on_start(move |options| {
        let started = started.clone();
        async move {
            let _ = started.send(options.pane_id.clone());
            // herdr never answers: only a cancel ends the start
            options.cancel.cancelled().await;
            Err(RuntimeError::Cancelled)
        }
    });
    let request = Request::builder()
        .method("POST")
        .uri("/spawn")
        .body(Body::from(
            json!({ "role": "worker", "task": "t" }).to_string(),
        ))
        .unwrap();
    let pane = {
        let answer = api.router.clone().oneshot(request);
        tokio::select! {
            answer = answer => panic!("the spawn answered: {:?}", answer.map(|a| a.status())),
            pane = start.recv() => pane.unwrap(),
        }
        // the request's future is dropped here, as axum drops it when the connection closes
    };
    for _ in 0..100 {
        if api.runtime.closed().contains(&pane) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("{pane} was not closed: {:?}", api.runtime.closed());
}

#[tokio::test(start_paused = true)]
async fn answers_herdrs_errors_with_their_code_and_a_cancel_with_499() {
    let api = Api::new(false);
    let (_, spawned) = api
        .call(
            "POST",
            "/spawn",
            Some(json!({ "role": "worker", "task": "t" })),
        )
        .await;
    let id = spawned["run"]["id"].as_str().unwrap().to_owned();
    let group = spawned["run"]["group"].clone();
    // focus hands herdr's error back as it is (orchestrator.ts's `focus`); a send would mark the run
    // failed instead
    let focus_path = format!("/runs/{id}/focus");
    let focus = || api.call("POST", &focus_path, Some(json!({ "group": group })));
    api.runtime.on_focus(|_| async {
        Err(RuntimeError::Herdr {
            code: "pane_closed".to_owned(),
            message: "the pane is gone".to_owned(),
        })
    });
    assert_eq!(
        focus().await,
        (
            502,
            json!({ "error": { "code": "pane_closed", "message": "the pane is gone" } })
        )
    );
    api.runtime
        .on_focus(|_| async { Err(RuntimeError::Cancelled) });
    assert_eq!(
        focus().await,
        (
            499,
            json!({ "error": { "code": "aborted", "message": "request cancelled" } })
        )
    );
    api.runtime
        .on_focus(|_| async { Err(RuntimeError::NotReady("not ready in time".to_owned())) });
    assert_eq!(
        focus().await,
        (
            504,
            json!({ "error": { "code": "agent_not_ready", "message": "not ready in time" } })
        )
    );
    // herdr's agent_blocked was a HerdrError in TypeScript, 502; only the fleet's own
    // FleetError("agent_blocked") is 409 (api.ts:295, :302)
    api.runtime
        .on_focus(|_| async { Err(RuntimeError::Blocked) });
    let (status, body) = focus().await;
    assert_eq!((status, code(&body)), (502, "agent_blocked"));
    // a failure herdr_runtime builds for TypeScript's plain Error is 500 (api.ts:304)
    api.runtime.on_focus(|_| async {
        Err(RuntimeError::Herdr {
            code: "internal_error".to_owned(),
            message: "A worktree run needs a branch name.".to_owned(),
        })
    });
    assert_eq!(
        focus().await,
        (
            500,
            json!({ "error": { "code": "internal_error", "message": "A worktree run needs a branch name." } })
        )
    );
}

/// Issue #269's first comment (from #248): the opencode guard plugin missing from the install is
/// the server's fault, 500, where TypeScript's table would have said 400.
#[tokio::test(start_paused = true)]
async fn answers_a_missing_guard_plugin_as_a_server_error() {
    let set = setup(SetupOptions::default());
    let reviewer = AgentDefinition {
        agent: FleetAgentKind::Opencode,
        edits: Some(false),
        ..role("reviewer")
    };
    let clock: Arc<dyn Clock> = TestClock::new();
    let registry = Arc::new(RunRegistry::open(None, clock.as_ref()));
    let runtime = FakeRuntime::new();
    let mut deps = deps(
        runtime.clone(),
        registry,
        &set.root,
        clock.clone(),
        config(None),
        vec![reviewer],
    );
    deps.host = Host::new(BTreeMap::new(), set.root.join("no-guard-plugin"));
    let fleet = Orchestrator::new(deps).unwrap();
    let root = set.root.clone();
    let api = Api::over(fleet, runtime, root, clock, set);
    let (status, body) = api
        .call(
            "POST",
            "/spawn",
            Some(json!({ "role": "reviewer", "task": "t" })),
        )
        .await;
    assert_eq!(
        (status, code(&body)),
        (500, "guard_plugin_missing"),
        "{body}"
    );
}
