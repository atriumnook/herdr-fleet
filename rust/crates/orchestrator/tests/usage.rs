//! The usage the fleet knows of (`server/fleet/usage.ts`): the account keys, each CLI's probe and
//! the parser of its answer, cooldowns, `UsageTracker` and its file.
//!
//! The tests whose comment names an `it` are `server/fleet/usage.test.ts`'s, with its expected
//! values. The others are this crate's own; their expected values are worked out by hand from the
//! TypeScript code's rules and written down as such. Times written as ISO strings are turned into
//! epoch milliseconds by jiff's parser (`ms`), which the code under test does not use for that.
//! The probes run fake executables written into a temporary folder: never a real agent CLI, which
//! may call a model, read the usage or update itself (issue #254).

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use child_process::Env;
use herdr_fleet_orchestrator::Clock;
use herdr_fleet_orchestrator::usage::{
    AGY_TIMEOUT, AUTO_REFRESH, BACKOFF_CAP, CLAUDE_TIMEOUT, CODEX_TIMEOUT, PROBE_TIMEOUT,
    PROBE_TTL, ProbeOptions, RateLimit, Readings, SCREEN_TTL, UNDATED_WINDOW, UsageProbe,
    UsageTracker, UsageTrackerOptions, agy_probe, claude_probe, codex_probe, default_probes,
    parse_agy_usage, parse_claude_usage, parse_codex_rate_limits, rate_limit_until, usage_key,
};
use jiff::tz::TimeZone;
use protocol::{Cooldown, FleetAgentKind, UsageEntry, UsageReading, UsageWindow};
use serde_json::{Value, json};

use FleetAgentKind::{Agy, Claude, Codex, Cursor, Opencode, Pi};

/// `Date.parse` of an ISO time with its offset, by jiff (not by the code under test).
fn ms(iso: &str) -> f64 {
    iso.parse::<jiff::Timestamp>().unwrap().as_millisecond() as f64
}

/// `const NOW = Date.parse("2026-10-04T07:00:00Z")`
fn now() -> f64 {
    ms("2026-10-04T07:00:00Z")
}

/// NOW as a `Clock` reads it, which the parsers take.
fn now_ms() -> i64 {
    now() as i64
}

/// `ms`, as a `Clock` reads it.
fn ms_i(iso: &str) -> i64 {
    ms(iso) as i64
}

const HOUR: f64 = 3_600_000.0;
const MINUTE: f64 = 60_000.0;

fn tz(name: &str) -> TimeZone {
    TimeZone::get(name).unwrap()
}

/// A clock that reads what the test set.
struct TestClock(AtomicI64);

impl TestClock {
    fn at(ms: f64) -> Arc<TestClock> {
        Arc::new(TestClock(AtomicI64::new(ms as i64)))
    }

    fn set(&self, ms: f64) {
        self.0.store(ms as i64, Ordering::SeqCst);
    }

    fn advance(&self, by: f64) {
        self.0.fetch_add(by as i64, Ordering::SeqCst);
    }

    fn get(&self) -> f64 {
        self.0.load(Ordering::SeqCst) as f64
    }
}

impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// A new empty folder under the system's temporary folder, removed with what it holds when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> TempDir {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "fleet-usage-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        TempDir(fs::canonicalize(&dir).unwrap())
    }

    fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Writes `body` as a `/bin/sh` script named `name` in `dir`, executable, and returns its path.
/// A shell writes it, not this process: a file this process held open for writing would be
/// inherited by a child another test forks at that moment, and running it would fail with
/// ETXTBSY (the same helper as child-process's tests).
fn fake(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    let status = std::process::Command::new("/bin/sh")
        .args([
            "-c",
            r#"printf '#!/bin/sh\n%s\n' "$2" > "$1" && chmod 755 "$1""#,
            "sh",
        ])
        .arg(&path)
        .arg(body)
        .status()
        .unwrap();
    assert!(status.success());
    path
}

fn read(path: impl AsRef<Path>) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt as _;
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

/// The test process's own environment, as TypeScript's probes read `process.env`.
fn process_env() -> Env {
    std::env::vars_os().collect()
}

fn probe_options(work_dir: &Path, command: &Path, env: Env) -> ProbeOptions {
    let mut options = ProbeOptions::new(work_dir, env, TestClock::at(now()));
    options.command = Some(command.as_os_str().to_owned());
    options
}

fn window(name: &str, used_percent: f64, resets_at: Option<f64>) -> UsageWindow {
    UsageWindow {
        name: name.to_owned(),
        used_percent,
        resets_at,
    }
}

/// `reading(usedPercent, resetsAt?)` of usage.test.ts: one 5h window read at NOW.
fn reading(used_percent: f64, resets_at: Option<f64>) -> UsageReading {
    UsageReading {
        windows: vec![window("5h", used_percent, resets_at)],
        read_at: now(),
    }
}

fn entry(key: &str) -> UsageEntry {
    UsageEntry {
        key: key.to_owned(),
        reading: None,
        cooldown: None,
        error: None,
    }
}

fn probe<F, Fut>(f: F) -> UsageProbe
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Readings, String>> + Send + 'static,
{
    Arc::new(move || Box::pin(f()))
}

fn readings(pairs: &[(&str, UsageReading)]) -> Readings {
    pairs
        .iter()
        .map(|(key, reading)| ((*key).to_owned(), reading.clone()))
        .collect()
}

fn options(clock: &Arc<TestClock>) -> UsageTrackerOptions {
    let clock: Arc<dyn Clock> = clock.clone();
    UsageTrackerOptions::new(None, clock)
}

fn find(usage: &UsageTracker, key: &str) -> UsageEntry {
    usage
        .list()
        .into_iter()
        .find(|entry| entry.key == key)
        .unwrap_or_else(|| panic!("no entry {key}"))
}

// ---- usageKey ---------------------------------------------------------------------------------

/// usage.test.ts, `usageKey`: "splits agy by model group, and pi and opencode by provider; the
/// other CLIs are one account each"
#[test]
fn splits_agy_by_model_group_and_pi_and_opencode_by_provider() {
    assert_eq!(usage_key(Codex, Some("gpt-6")), "codex");
    assert_eq!(usage_key(Claude, None), "claude");
    assert_eq!(usage_key(Agy, Some("gemini-3.8-flash-low")), "agy:gemini");
    assert_eq!(usage_key(Agy, None), "agy:gemini");
    assert_eq!(usage_key(Agy, Some("claude-sonnet-5-5")), "agy:3p");
    assert_eq!(
        usage_key(Pi, Some("opencode-go/space-bunny-free")),
        "pi:opencode-go"
    );
    assert_eq!(usage_key(Pi, None), "pi");
    assert_eq!(
        usage_key(Opencode, Some("anthropic/claude-sonnet-5-5")),
        "opencode:anthropic"
    );
    assert_eq!(usage_key(Opencode, None), "opencode");
}

/// This crate's own: the edges of the TypeScript rules, by hand. `!model` is true for "" (agy's
/// Gemini account), `/gemini/i` ignores case, and `indexOf("/") > 0` wants a provider before the
/// first slash.
#[test]
fn reads_the_edges_of_the_account_rules_as_typescript_does() {
    assert_eq!(usage_key(Agy, Some("")), "agy:gemini");
    assert_eq!(usage_key(Agy, Some("Gemini-Pro")), "agy:gemini");
    assert_eq!(usage_key(Pi, Some("/model")), "pi");
    assert_eq!(usage_key(Pi, Some("a/b/c")), "pi:a");
    assert_eq!(usage_key(Cursor, Some("x/y")), "cursor");
}

// ---- readings ---------------------------------------------------------------------------------

/// usage.test.ts, `readings`: "reads codex app-server's primary and secondary windows (codex-cli
/// 0.157.0)"
#[test]
fn reads_codex_app_servers_primary_and_secondary_windows() {
    let result = json!({
        "ordinaryUsageAllowed": true,
        "rateLimits": {
            "limitId": "codex", "primary": { "usedPercent": 12, "windowDurationMins": 300, "resetsAt": 1791103555u64 },
            "secondary": { "usedPercent": 40, "windowDurationMins": 10080, "resetsAt": 1791648524u64 }, "planType": "plus", "rateLimitReachedType": null,
        },
    });
    assert_eq!(
        parse_codex_rate_limits(&result, now_ms()),
        Some(UsageReading {
            read_at: now(),
            windows: vec![
                window("5h", 12.0, Some(1_791_103_555_000.0)),
                window("weekly", 40.0, Some(1_791_648_524_000.0)),
            ],
        })
    );
    assert_eq!(parse_codex_rate_limits(&json!({}), now_ms()), None);
}

/// This crate's own: `windowName` by hand. 10080 minutes is "weekly", whole hours are `<n>h`,
/// other minutes `<n>m`, and a window without a finite length is "window".
#[test]
fn names_codex_windows_by_their_length() {
    let result = json!({ "rateLimits": {
        "primary": { "usedPercent": 1, "windowDurationMins": 90 },
        "secondary": { "usedPercent": 2 },
    } });
    let reading = parse_codex_rate_limits(&result, now_ms()).unwrap();
    assert_eq!(
        reading.windows,
        vec![window("90m", 1.0, None), window("window", 2.0, None)]
    );
    // a window without a numeric share is left out, and none left is no reading
    let none = json!({ "rateLimits": { "primary": { "usedPercent": "12" } } });
    assert_eq!(parse_codex_rate_limits(&none, now_ms()), None);
}

/// usage.test.ts, `readings`: "reads agy's /usage buckets per model group as used shares (agy
/// 1.2.16)"
#[test]
fn reads_agys_usage_buckets_per_model_group_as_used_shares() {
    let output = json!({
        "status": "SUCCESS", "usage": { "total_tokens": 0 },
        "command": { "name": "usage", "data": { "groups": [
            { "name": "Gemini Models", "buckets": [
                { "id": "gemini-weekly", "window": "weekly", "remaining_fraction": 0.75, "reset_time": "2026-10-11T03:46:16Z" },
                { "id": "gemini-5h", "window": "5h", "remaining_fraction": 0.05, "reset_time": "2026-10-04T08:46:16Z" },
            ] },
            { "name": "Claude and GPT models", "buckets": [{ "id": "3p-5h", "window": "5h", "remaining_fraction": 1, "reset_time": "2026-10-04T12:37:27Z" }] },
        ] } },
    });
    let utc = TimeZone::UTC;
    assert_eq!(
        parse_agy_usage(&output, now_ms(), &utc),
        readings(&[
            (
                "agy:gemini",
                UsageReading {
                    read_at: now(),
                    windows: vec![
                        window("weekly", 25.0, Some(ms("2026-10-11T03:46:16Z"))),
                        window("5h", 95.0, Some(ms("2026-10-04T08:46:16Z"))),
                    ],
                }
            ),
            (
                "agy:3p",
                UsageReading {
                    read_at: now(),
                    windows: vec![window("5h", 0.0, Some(ms("2026-10-04T12:37:27Z")))],
                }
            ),
        ])
    );
    assert_eq!(
        parse_agy_usage(&json!({ "status": "ERROR" }), now_ms(), &utc),
        Readings::new()
    );
}

/// This crate's own: `Math.round((1 - remaining) * 1000) / 10` and `Date.parse`, by hand. 0.3333
/// left is 66.67% used, rounded to 66.7; a bucket without a `window` is named by its id; a reset
/// time `Date.parse` cannot read leaves the window without one; a time without an offset is the
/// local time (here Asia/Tokyo, +09:00); a date alone is UTC.
#[test]
fn rounds_agy_shares_and_reads_its_reset_times_as_date_parse_does() {
    let output = json!({ "command": { "data": { "groups": [{ "buckets": [
        { "id": "gemini-a", "remaining_fraction": 0.3333, "reset_time": "soon" },
        { "id": "3p-b", "window": "5h", "remaining_fraction": 0.5, "reset_time": "2026-10-04T18:00:00" },
        { "id": "3p-c", "window": "weekly", "remaining_fraction": 0, "reset_time": "2026-10-11" },
        { "id": "3p-d", "window": "x", "remaining_fraction": "0.5" },
    ] }] } } });
    assert_eq!(
        parse_agy_usage(&output, now_ms(), &tz("Asia/Tokyo")),
        readings(&[
            (
                "agy:gemini",
                UsageReading {
                    read_at: now(),
                    windows: vec![window("gemini-a", 66.7, None)],
                }
            ),
            (
                "agy:3p",
                UsageReading {
                    read_at: now(),
                    windows: vec![
                        window("5h", 50.0, Some(ms("2026-10-04T09:00:00Z"))),
                        window("weekly", 100.0, Some(ms("2026-10-11T00:00:00Z"))),
                    ],
                }
            ),
        ])
    );
}

/// `claude -p /usage --output-format json`, `result` as Claude Code 2.1.289 printed it (no model
/// turn, 0 tokens); usage.test.ts's `CLAUDE_USAGE`.
const CLAUDE_USAGE: &str =
    "You are currently using your subscription to power your Claude Code usage

Current session: 7% used · resets Oct 4, 9:50pm (Asia/Tokyo)
Current week (all models): 27% used · resets Oct 8, 12am (Asia/Tokyo)
Current week (Fable): 95% used · resets Oct 8, 12am (Asia/Tokyo)

What's contributing to your limits usage?
Last 24h · 1285 requests · 14 sessions
  90% of your usage was at >150k context";

/// usage.test.ts, `readings`: "reads Claude Code's /usage: the shared windows, not a per-model
/// one, with their reset in the named zone"
#[test]
fn reads_claude_codes_usage_the_shared_windows_with_their_reset_in_the_named_zone() {
    assert_eq!(
        parse_claude_usage(CLAUDE_USAGE, now_ms()),
        Some(UsageReading {
            read_at: now(),
            windows: vec![
                window("5h", 7.0, Some(ms("2026-10-04T12:50:00Z"))),
                window("weekly", 27.0, Some(ms("2026-10-07T15:00:00Z"))),
            ],
        })
    );
}

/// usage.test.ts, `readings`: "takes a reset with no year as the next one, keeps a window whose
/// reset it cannot read, and reads nothing from an API-key session"
#[test]
fn takes_a_reset_with_no_year_as_the_next_one_and_reads_nothing_from_an_api_key_session() {
    let new_year = parse_claude_usage(
        "Current session: 50% used · resets Jan 1, 9am (UTC)",
        ms_i("2026-12-31T20:00:00Z"),
    )
    .unwrap();
    assert_eq!(
        new_year.windows,
        vec![window("5h", 50.0, Some(ms("2027-01-01T09:00:00Z")))]
    );
    assert_eq!(
        parse_claude_usage(
            "Current session: 3% used · resets soon (Mars/Base)",
            now_ms()
        )
        .unwrap()
        .windows,
        vec![window("5h", 3.0, None)]
    );
    assert_eq!(
        parse_claude_usage("You are currently using an API key", now_ms()),
        None
    );
}

/// This crate's own: the zone is read as `zonedTime` reads it (`server/fleet/usage.ts:75`): the
/// zone's offset at the instant the wall time names in UTC, subtracted once. Worked out by hand
/// for America/New_York, where 2026's summer time starts on Mar 8 at 07:00Z (2am EST) and ends on
/// Nov 1 at 06:00Z (2am EDT):
/// - `Mar 8, 3:30am`: 03:30Z is before the change, so EST (-5h): 08:30Z, which TypeScript gives
///   too (the wall time 3:30 EDT would be 07:30Z)
/// - `Mar 8, 9pm`: 21:00Z is after it, EDT (-4h): Mar 9 01:00Z
/// - `Nov 1, 1:30am`: 01:30Z is before the end, EDT: 05:30Z, the first of the two 1:30s
/// - `Oct 4, 9:50PM` in any case, with minutes left out, and a zone written in lower case
#[test]
fn reads_a_reset_in_a_zone_with_summer_time_as_typescript_does() {
    let reset = |text: &str| {
        parse_claude_usage(
            &format!("Current session: 1% used · resets {text}"),
            now_ms(),
        )
        .unwrap()
        .windows[0]
            .resets_at
    };
    assert_eq!(
        reset("Mar 8, 3:30am (America/New_York)"),
        Some(ms("2027-03-08T08:30:00Z")),
        "a March reset seen in October is next year's"
    );
    let in_march = |text: &str| {
        parse_claude_usage(
            &format!("Current session: 1% used · resets {text}"),
            ms_i("2026-03-01T00:00:00Z"),
        )
        .unwrap()
        .windows[0]
            .resets_at
    };
    assert_eq!(
        in_march("Mar 8, 3:30am (America/New_York)"),
        Some(ms("2026-03-08T08:30:00Z"))
    );
    assert_eq!(
        in_march("Mar 8, 9pm (America/New_York)"),
        Some(ms("2026-03-09T01:00:00Z"))
    );
    assert_eq!(
        reset("Nov 1, 1:30am (America/New_York)"),
        Some(ms("2026-11-01T05:30:00Z"))
    );
    assert_eq!(
        reset("OCT 4, 9:50PM (asia/tokyo)"),
        Some(ms("2026-10-04T12:50:00Z"))
    );
    assert_eq!(reset("Oct 5, 7am (UTC)"), Some(ms("2026-10-05T07:00:00Z")));
    // at most a day in the past is still this year's: Oct 3 08:00Z is 23 hours before NOW
    assert_eq!(reset("Oct 3, 8am (UTC)"), Some(ms("2026-10-03T08:00:00Z")));
    assert_eq!(reset("Oct 3, 6am (UTC)"), Some(ms("2027-10-03T06:00:00Z")));
}

/// usage.test.ts, `readings`: "asks claude for /usage without keeping a session or loading the
/// person's settings, and fails on an error answer"
#[tokio::test]
async fn asks_claude_for_usage_without_keeping_a_session_or_loading_the_persons_settings() {
    let dir = TempDir::new();
    let answer = |name: &str, answer: Value| {
        let file = dir.join(name);
        let args = with_suffix(&file, ".args");
        fake(
            &dir.0,
            name,
            &format!(
                "echo \"$@\" > '{}'\ncat <<'JSON'\n{answer}\nJSON",
                args.display()
            ),
        )
    };
    let ok = answer(
        "claude-ok",
        json!({ "is_error": false, "num_turns": 0, "result": CLAUDE_USAGE }),
    );
    let work_dir = dir.join("probe");
    let readings = claude_probe(probe_options(&work_dir, &ok, process_env()))()
        .await
        .unwrap();
    let windows: Vec<(String, f64)> = readings["claude"]
        .windows
        .iter()
        .map(|window| (window.name.clone(), window.used_percent))
        .collect();
    assert_eq!(
        windows,
        vec![("5h".to_owned(), 7.0), ("weekly".to_owned(), 27.0)]
    );
    assert_eq!(
        read(with_suffix(&ok, ".args")).trim(),
        "-p /usage --no-session-persistence --setting-sources project --output-format json"
    );
    let error = answer(
        "claude-error",
        json!({ "is_error": true, "result": "Not logged in" }),
    );
    let failed = claude_probe(probe_options(&work_dir, &error, process_env()))().await;
    assert!(
        failed
            .as_ref()
            .is_err_and(|error| error.contains("/usage gave no answer")),
        "{failed:?}"
    );
}

// ---- what a probe's CLI gets -----------------------------------------------------------------

/// The server's environment as a probe sees it: API keys and the person's herdr session among the
/// rest (usage.test.ts's `SERVER_ENV`).
fn server_env() -> Env {
    let mut env = Env::new();
    if let Some(path) = std::env::var_os("PATH") {
        env.insert("PATH".into(), path);
    }
    for (name, value) in [
        ("HOME", "/home/u"),
        ("LANG", "ja_JP.UTF-8"),
        ("CODEX_HOME", "/home/u/.codex-alt"),
        ("CLAUDE_CONFIG_DIR", "/home/u/.claude-alt"),
        ("ANTHROPIC_API_KEY", "sk-ant"),
        ("OPENAI_API_KEY", "sk-openai"),
        ("GEMINI_API_KEY", "g-key"),
        ("HERDR_SOCKET", "/run/herdr.sock"),
        ("HERDR_FLEET_TOKEN", "t"),
    ] {
        env.insert(OsString::from(name), OsString::from(value));
    }
    env
}

const FORBIDDEN: [&str; 5] = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "HERDR_SOCKET",
    "HERDR_FLEET_TOKEN",
];

/// A CLI that notes its environment, its folder and what it found there, then answers.
fn recorder(dir: &TempDir, name: &str, answer: &str) -> PathBuf {
    let file = dir.join(name);
    let note = |suffix: &str| with_suffix(&file, suffix).display().to_string();
    fake(
        &dir.0,
        name,
        &format!(
            "/usr/bin/env > '{}'\npwd > '{}'\nls -A > '{}'\n{answer}",
            note(".env"),
            note(".cwd"),
            note(".ls")
        ),
    )
}

fn env_names(file: &Path) -> Vec<String> {
    read(with_suffix(file, ".env"))
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| line.split('=').next().unwrap().to_owned())
        .collect()
}

/// What another run, or another user, could leave in the folder for the next CLI to read.
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
        read(with_suffix(file, ".cwd")).trim(),
        fs::canonicalize(work_dir).unwrap().display().to_string()
    );
    assert_eq!(read(with_suffix(file, ".ls")), "");
    assert_eq!(mode(work_dir), 0o700);
}

fn expect_none_forbidden(names: &[String]) {
    for name in FORBIDDEN {
        assert!(!names.iter().any(|n| n == name), "{name} passed: {names:?}");
    }
}

fn expect_all(names: &[String], wanted: &[&str]) {
    for name in wanted {
        assert!(names.iter().any(|n| n == name), "{name} missing: {names:?}");
    }
}

/// usage.test.ts, `what a probe's CLI gets`: "claude runs in its own emptied folder, with its own
/// folder's setting, no API key or herdr session, and no self-update"
#[tokio::test]
async fn claude_runs_in_its_own_emptied_folder_with_no_api_key_or_herdr_session() {
    let dir = TempDir::new();
    let work_dir = dir.join("usage-probe").join("claude");
    plant(&work_dir);
    let answer = json!({ "is_error": false, "result": "Current session: 7% used" });
    let claude = recorder(&dir, "claude", &format!("cat <<'JSON'\n{answer}\nJSON"));
    claude_probe(probe_options(&work_dir, &claude, server_env()))()
        .await
        .unwrap();
    expect_own_empty_folder(&claude, &work_dir);
    let names = env_names(&claude);
    expect_none_forbidden(&names);
    expect_all(
        &names,
        &[
            "PATH",
            "HOME",
            "LANG",
            "CLAUDE_CONFIG_DIR",
            "DISABLE_AUTOUPDATER",
        ],
    );
    assert!(!names.iter().any(|n| n == "CODEX_HOME"));
}

/// usage.test.ts, `what a probe's CLI gets`: "codex app-server runs in its own emptied folder,
/// with CODEX_HOME and no API key or herdr session"
#[tokio::test]
async fn codex_app_server_runs_in_its_own_emptied_folder_with_codex_home_and_no_api_key() {
    let dir = TempDir::new();
    let work_dir = dir.join("usage-probe").join("codex");
    plant(&work_dir);
    let limits = json!({ "rateLimits": { "primary": { "usedPercent": 12, "windowDurationMins": 300 }, "secondary": { "usedPercent": 40, "windowDurationMins": 10080 } } });
    let codex = recorder(
        &dir,
        "codex",
        &format!(
            "read a\necho '{{\"id\":1,\"result\":{{}}}}'\nread b\nread c\necho '{}'",
            json!({ "id": 2, "result": limits })
        ),
    );
    let readings = codex_probe(probe_options(&work_dir, &codex, server_env()))()
        .await
        .unwrap();
    let shares: Vec<f64> = readings["codex"]
        .windows
        .iter()
        .map(|window| window.used_percent)
        .collect();
    assert_eq!(shares, vec![12.0, 40.0]);
    expect_own_empty_folder(&codex, &work_dir);
    let names = env_names(&codex);
    expect_none_forbidden(&names);
    expect_all(&names, &["PATH", "HOME", "CODEX_HOME"]);
    assert!(!names.iter().any(|n| n == "CLAUDE_CONFIG_DIR"));
}

/// usage.test.ts, `what a probe's CLI gets`: "agy runs in its own emptied folder, without an API
/// key or herdr session, and with its self-update held off"
#[tokio::test]
async fn agy_runs_in_its_own_emptied_folder_without_an_api_key_and_with_its_self_update_held_off() {
    let dir = TempDir::new();
    let work_dir = dir.join("usage-probe").join("agy");
    plant(&work_dir);
    let answer = json!({ "status": "SUCCESS", "command": { "data": { "groups": [] } } });
    let agy = recorder(&dir, "agy", &format!("echo '{answer}'"));
    agy_probe(probe_options(&work_dir, &agy, server_env()))()
        .await
        .unwrap();
    expect_own_empty_folder(&agy, &work_dir);
    expect_none_forbidden(&env_names(&agy));
    assert!(read(with_suffix(&agy, ".env")).contains("AGY_CLI_DISABLE_AUTO_UPDATE=true\n"));
}

/// usage.test.ts, `what a probe's CLI gets`: "refuses a link in place of the folder, and leaves
/// what it points at alone"
#[tokio::test]
async fn refuses_a_link_in_place_of_the_folder_and_leaves_what_it_points_at_alone() {
    let dir = TempDir::new();
    fs::create_dir(dir.join("elsewhere")).unwrap();
    fs::write(dir.join("elsewhere").join("keep.txt"), "x").unwrap();
    std::os::unix::fs::symlink(dir.join("elsewhere"), dir.join("claude")).unwrap();
    let claude = recorder(&dir, "claude-cli", "echo '{}'");
    let failed = claude_probe(probe_options(&dir.join("claude"), &claude, server_env()))().await;
    assert!(
        failed
            .as_ref()
            .is_err_and(|error| error.contains("is not a folder")),
        "{failed:?}"
    );
    let left: Vec<_> = fs::read_dir(dir.join("elsewhere"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(left, vec![OsString::from("keep.txt")]);
}

/// This crate's own: the time limits each probe runs under (issue #254: codex 15 s, agy and
/// claude 30 s, `server/fleet/usage.ts:428, 466, 480`), and the command a probe starts when none
/// is given.
#[test]
fn each_probe_has_the_time_limit_of_typescript() {
    assert_eq!(CODEX_TIMEOUT, Duration::from_secs(15));
    assert_eq!(AGY_TIMEOUT, Duration::from_secs(30));
    assert_eq!(CLAUDE_TIMEOUT, Duration::from_secs(30));
    let options = ProbeOptions::new("/nowhere", Env::new(), TestClock::at(now()));
    assert_eq!(options.command, None);
}

/// This crate's own: a probe's CLI that fails is a probe that fails, with the exit code in the
/// text (`${argv[0]} exited with ${code}`), and one that writes no JSON fails too.
#[tokio::test]
async fn a_probe_fails_on_an_exit_code_or_an_answer_that_is_not_json() {
    let dir = TempDir::new();
    let work_dir = dir.join("probe");
    let exits = fake(&dir.0, "agy-exits", "echo '{}'\nexit 3");
    let failed = agy_probe(probe_options(&work_dir, &exits, server_env()))().await;
    assert_eq!(failed, Err(format!("{} exited with 3", exits.display())));
    let garbled = fake(&dir.0, "claude-garbled", "echo 'not json'");
    assert!(
        claude_probe(probe_options(&work_dir, &garbled, server_env()))()
            .await
            .is_err()
    );
    // codex app-server that closes before it answers
    let closes = fake(&dir.0, "codex-closes", "read a\nexit 0");
    assert_eq!(
        codex_probe(probe_options(&work_dir, &closes, server_env()))().await,
        Err("codex app-server closed before it answered".to_owned())
    );
    // and one that answers the rate limits with an error
    let refuses = fake(
        &dir.0,
        "codex-refuses",
        "read a\necho '{\"id\":1,\"result\":{}}'\nread b\nread c\necho '{\"id\":2,\"error\":{\"message\":\"not signed in\"}}'",
    );
    assert_eq!(
        codex_probe(probe_options(&work_dir, &refuses, server_env()))().await,
        Err("codex: not signed in".to_owned())
    );
}

// ---- rateLimitUntil ---------------------------------------------------------------------------

/// usage.test.ts, `rateLimitUntil`: "is null for other failures and undefined for a rate limit
/// that names no time"
#[test]
fn is_not_one_for_other_failures_and_one_without_a_time_for_a_rate_limit_that_names_none() {
    let local = TimeZone::system();
    assert_eq!(
        rate_limit_until("model not found", now_ms(), &local),
        RateLimit::NotOne
    );
    assert_eq!(
        rate_limit_until("429 Too Many Requests", now_ms(), &local),
        RateLimit::Until(None)
    );
    assert_eq!(
        rate_limit_until("You've hit your usage limit.", now_ms(), &local),
        RateLimit::Until(None)
    );
}

/// usage.test.ts, `rateLimitUntil`: "takes an ISO time, a relative one or the next clock time"
#[test]
fn takes_an_iso_time_a_relative_one_or_the_next_clock_time() {
    let local = TimeZone::system();
    assert_eq!(
        rate_limit_until(
            "rate limit exceeded; resets 2026-10-04T09:30:00Z",
            now_ms(),
            &local
        ),
        RateLimit::Until(Some(ms("2026-10-04T09:30:00Z")))
    );
    assert_eq!(
        rate_limit_until("Rate limit reached. Try again in 2h 5m.", now_ms(), &local),
        RateLimit::Until(Some(now() + 2.0 * HOUR + 5.0 * MINUTE))
    );
    assert_eq!(
        rate_limit_until("quota exhausted, retry in 30 minutes", now_ms(), &local),
        RateLimit::Until(Some(now() + 30.0 * MINUTE))
    );
    let RateLimit::Until(Some(clock)) = rate_limit_until(
        "usage limit reached, try again at 3:45 PM",
        now_ms(),
        &local,
    ) else {
        panic!("no time read");
    };
    // `new Date(clock).getHours()` and `getMinutes()`: the local time
    let at = jiff::Timestamp::from_millisecond(clock as i64)
        .unwrap()
        .to_zoned(local);
    assert_eq!((at.hour(), at.minute()), (15, 45));
    assert!(clock > now());
    assert!(clock - now() <= 24.0 * HOUR);
}

/// This crate's own: every phrase of `RATE_LIMITED`, by hand, and `\b429\b` as a word only.
#[test]
fn knows_every_phrase_of_a_rate_limit() {
    let utc = TimeZone::UTC;
    for message in [
        "rate limit",
        "Rate-Limit hit",
        "ratelimited",
        "Usage limit",
        "LIMIT REACHED",
        "over quota",
        "too many requests",
        "HTTP 429",
        "RESOURCE_EXHAUSTED",
        "resource exhausted",
        "out of credits",
    ] {
        assert_eq!(
            rate_limit_until(message, now_ms(), &utc),
            RateLimit::Until(None),
            "{message}"
        );
    }
    for message in ["error 4290", "model not found", "rate of 3 limits"] {
        assert_eq!(
            rate_limit_until(message, now_ms(), &utc),
            RateLimit::NotOne,
            "{message}"
        );
    }
}

/// This crate's own: the other forms TypeScript reads, by hand. An ISO time already past is no
/// time (and nothing else in the text names one); days, hours, minutes and seconds add up, with
/// "and" and commas between them; the clock time is the next one in the given zone: NOW is 16:00
/// in Asia/Tokyo, so 3:45 PM is tomorrow's (Oct 5 06:45Z), 17:30 today's (08:30Z) and 12:15 am
/// tomorrow's (Oct 4 15:15Z).
#[test]
fn reads_the_other_forms_of_a_time_by_hand() {
    let tokyo = tz("Asia/Tokyo");
    let until = |message: &str| rate_limit_until(message, now_ms(), &tokyo);
    assert_eq!(
        until("rate limit; resets 2026-10-04T06:00:00Z"),
        RateLimit::Until(None)
    );
    assert_eq!(
        until("rate limit; resets 2026-10-04T18:30:00+09:00"),
        RateLimit::Until(Some(ms("2026-10-04T09:30:00Z")))
    );
    assert_eq!(
        until("rate limit, try again in 1 day, 2 hours and 3 mins 4s"),
        RateLimit::Until(Some(
            now() + 24.0 * HOUR + 2.0 * HOUR + 3.0 * MINUTE + 4_000.0
        ))
    );
    assert_eq!(
        until("quota: in 2 hrs"),
        RateLimit::Until(Some(now() + 2.0 * HOUR))
    );
    assert_eq!(
        until("usage limit reached, try again at 3:45 PM"),
        RateLimit::Until(Some(ms("2026-10-05T06:45:00Z")))
    );
    assert_eq!(
        until("usage limit reached, try again at 17:30"),
        RateLimit::Until(Some(ms("2026-10-04T08:30:00Z")))
    );
    assert_eq!(
        until("usage limit reached, try again at 12:15 am"),
        RateLimit::Until(Some(ms("2026-10-04T15:15:00Z")))
    );
}

/// This crate's own: a clock time on the night summer time starts, worked out by hand as
/// `setHours` and `setDate` do it in America/New_York. At 2026-03-07T12:00Z (7am EST) "at 2:30
/// am" has passed today, so it is tomorrow's; 2:30 does not exist on Mar 8, and JavaScript reads
/// it with the offset before the change (EST): 07:30Z.
#[test]
fn reads_a_clock_time_that_summer_time_skips_as_javascript_does() {
    assert_eq!(
        rate_limit_until(
            "rate limit, try again at 2:30 am",
            ms_i("2026-03-07T12:00:00Z"),
            &tz("America/New_York")
        ),
        RateLimit::Until(Some(ms("2026-03-08T07:30:00Z")))
    );
}

// ---- UsageTracker -----------------------------------------------------------------------------

/// This crate's own: the constants of `server/fleet/usage.ts:186-199` and `:166`, by value, and
/// the defaults a tracker is built with.
#[test]
fn keeps_the_constants_of_typescript() {
    assert_eq!(PROBE_TTL, Duration::from_secs(60));
    assert_eq!(AUTO_REFRESH, Duration::from_secs(5 * 60));
    assert_eq!(BACKOFF_CAP, Duration::from_secs(60 * 60));
    assert_eq!(PROBE_TIMEOUT, Duration::from_secs(35));
    assert_eq!(SCREEN_TTL, Duration::from_secs(10 * 60));
    assert_eq!(UNDATED_WINDOW, Duration::from_secs(24 * 60 * 60));
    let options = options(&TestClock::at(now()));
    assert_eq!(options.probe_ttl, Duration::from_secs(60));
    assert_eq!(options.probe_timeout, Duration::from_secs(35));
    assert!(options.probes.is_empty());
    assert_eq!(options.file, None);
}

/// This crate's own: the futures O2's `UsageGate` and the API's handlers box are `Send`, and the
/// tracker is shared across tasks (architect run 04110847). A compile-time check: it never runs.
#[allow(dead_code)]
fn the_futures_callers_box_are_send(usage: &UsageTracker) {
    fn send<T: Send>(_: T) {}
    fn shared<T: Send + Sync + Clone + 'static>() {}
    send(usage.unavailable(Codex, None, 90.0));
    send(usage.refresh(false, None));
    shared::<UsageTracker>();
    let clock: Arc<dyn Clock> = TestClock::at(now());
    for probe in default_probes(Path::new("/nowhere"), &Env::new(), clock).values() {
        send(probe());
    }
}

/// This crate's own: `list()` in the order Bun 1.4.4's `localeCompare` gives the same keys (run
/// with `bun -e` under en-US: `[...keys].sort((a, b) => a.localeCompare(b))`).
#[test]
fn lists_the_accounts_in_the_order_of_locale_compare() {
    let usage = UsageTracker::new(options(&TestClock::at(now())));
    let providers = [
        "aB",
        "ab",
        "a1",
        "a.b",
        "a-b",
        "a_b",
        "Zed",
        "anthropic",
        "OpenAI",
        "openrouter",
        "a",
        "A",
        "a b",
        "a:b",
        "a@b",
        "a+b",
        "a~b",
        "a$b",
    ];
    for provider in providers {
        usage.record(Pi, Some(&format!("{provider}/model")), reading(1.0, None));
    }
    for (kind, model) in [
        (Opencode, Some("anthropic/m")),
        (Opencode, None),
        (Cursor, None),
        (Codex, None),
        (Claude, None),
        (Agy, Some("gemini-pro")),
        (Agy, Some("claude-sonnet")),
        (Pi, None),
    ] {
        usage.record(kind, model, reading(1.0, None));
    }
    let keys: Vec<String> = usage.list().into_iter().map(|entry| entry.key).collect();
    assert_eq!(
        keys,
        [
            "agy:3p",
            "agy:gemini",
            "claude",
            "codex",
            "cursor",
            "opencode",
            "opencode:anthropic",
            "pi",
            "pi:a",
            "pi:A",
            "pi:a b",
            "pi:a_b",
            "pi:a-b",
            "pi:a:b",
            "pi:a.b",
            "pi:a@b",
            "pi:a+b",
            "pi:a~b",
            "pi:a$b",
            "pi:a1",
            "pi:ab",
            "pi:aB",
            "pi:anthropic",
            "pi:OpenAI",
            "pi:openrouter",
            "pi:Zed",
        ]
    );
}

/// usage.test.ts, `UsageTracker`: "refuses a candidate whose window is at the threshold until
/// that window resets"
#[tokio::test]
async fn refuses_a_candidate_whose_window_is_at_the_threshold_until_that_window_resets() {
    let clock = TestClock::at(now());
    let usage = UsageTracker::new(options(&clock));
    usage.record(Codex, None, reading(90.0, Some(now() + HOUR)));
    let refused = usage.unavailable(Codex, Some("gpt-6"), 90.0).await.unwrap();
    assert!(
        refused.contains("codex has used 90% of its 5h limit"),
        "{refused}"
    );
    assert_eq!(usage.unavailable(Codex, Some("gpt-6"), 95.0).await, None);
    clock.set(now() + HOUR + 1.0);
    assert_eq!(usage.unavailable(Codex, Some("gpt-6"), 90.0).await, None);
    // nothing known is no reason to refuse
    assert_eq!(usage.unavailable(Claude, None, 90.0).await, None);
}

/// This crate's own: the whole text of a refusal, by hand: the share as JavaScript writes a
/// number, the reset as `toISOString`, and no reset part when the window has no reset time.
#[test]
fn writes_a_refusal_as_typescript_does() {
    let clock = TestClock::at(now());
    let usage = UsageTracker::new(options(&clock));
    usage.record(
        Codex,
        None,
        reading(92.5, Some(ms("2026-10-04T08:00:00.250Z"))),
    );
    assert_eq!(
        usage.known(Codex, None, 90.0).as_deref(),
        Some("codex has used 92.5% of its 5h limit (resets 2026-10-04T08:00:00.250Z)")
    );
    usage.record(Cursor, None, reading(100.0, None));
    assert_eq!(
        usage.known(Cursor, None, 90.0).as_deref(),
        Some("cursor has used 100% of its 5h limit")
    );
}

/// usage.test.ts, `UsageTracker`: "counts a window read without its reset time for a day only"
#[tokio::test]
async fn counts_a_window_read_without_its_reset_time_for_a_day_only() {
    let clock = TestClock::at(now());
    let usage = UsageTracker::new(options(&clock));
    usage.record(Cursor, None, reading(95.0, None));
    let refused = usage.unavailable(Cursor, None, 90.0).await.unwrap();
    assert!(refused.contains("95%"), "{refused}");
    clock.set(now() + 24.0 * HOUR - 1.0);
    assert!(usage.unavailable(Cursor, None, 90.0).await.is_some());
    clock.set(now() + 24.0 * HOUR);
    assert_eq!(usage.unavailable(Cursor, None, 90.0).await, None);
}

/// usage.test.ts, `UsageTracker`: "cools an account down on a rate limit, for the time named,
/// else a full window's reset, else the default"
#[tokio::test]
async fn cools_an_account_down_for_the_time_named_else_a_full_windows_reset_else_the_default() {
    let clock = TestClock::at(now());
    let usage = UsageTracker::new(options(&clock));
    assert!(!usage.note_failure(Cursor, None, "Error: model not found", 60.0));
    assert!(usage.note_failure(Cursor, None, "Error: rate limit exceeded", 60.0));
    let refused = usage.unavailable(Cursor, Some("gpt"), 90.0).await.unwrap();
    assert!(
        refused.contains("cursor is cooling down until 2026-10-04T08:00:00.000Z"),
        "{refused}"
    );
    usage.record(Codex, None, reading(100.0, Some(now() + 3.0 * HOUR)));
    usage.note_failure(Codex, None, "You've hit your usage limit", 60.0);
    assert_eq!(
        find(&usage, "codex").cooldown.unwrap().until,
        now() + 3.0 * HOUR
    );
    usage.note_failure(
        Agy,
        Some("gemini-pro"),
        "RESOURCE_EXHAUSTED, retry in 10m",
        60.0,
    );
    assert_eq!(
        find(&usage, "agy:gemini").cooldown.unwrap().until,
        now() + 10.0 * MINUTE
    );
    clock.set(now() + HOUR);
    assert_eq!(usage.unavailable(Cursor, Some("gpt"), 90.0).await, None);
}

/// This crate's own: the cooldown's record, by hand: the reason is the message's first 200
/// UTF-16 code units (`message.slice(0, 200)`), `since` is now, the whole refusal names the
/// reason, and the latest of several full windows' resets wins.
#[test]
fn records_a_cooldown_as_typescript_does() {
    let clock = TestClock::at(now());
    let usage = UsageTracker::new(options(&clock));
    let message = format!("rate limit {}", "é".repeat(250));
    assert!(usage.note_failure(Pi, Some("openai/gpt-6"), &message, 2.0));
    let cooldown = find(&usage, "pi:openai").cooldown.unwrap();
    assert_eq!(
        cooldown,
        Cooldown {
            until: now() + 2.0 * MINUTE,
            reason: format!("rate limit {}", "é".repeat(189)),
            since: now(),
        }
    );
    assert_eq!(
        usage.known(Pi, Some("openai/gpt-6"), 90.0),
        Some(format!(
            "pi:openai is cooling down until 2026-10-04T07:02:00.000Z ({})",
            cooldown.reason
        ))
    );
    usage.record(
        Claude,
        None,
        UsageReading {
            read_at: now(),
            windows: vec![
                window("5h", 100.0, Some(now() + HOUR)),
                window("weekly", 100.0, Some(now() + 5.0 * HOUR)),
                window("other", 99.0, Some(now() + 9.0 * HOUR)),
            ],
        },
    );
    usage.note_failure(Claude, None, "429", 60.0);
    assert_eq!(
        find(&usage, "claude").cooldown.unwrap().until,
        now() + 5.0 * HOUR
    );
}

/// usage.test.ts, `UsageTracker`: "clears one account's cooldown, a CLI's or all"
#[test]
fn clears_one_accounts_cooldown_a_clis_or_all() {
    let usage = UsageTracker::new(options(&TestClock::at(now())));
    for model in ["gemini-pro", "claude-sonnet"] {
        usage.note_failure(Agy, Some(model), "rate limit", 60.0);
    }
    usage.note_failure(Cursor, None, "rate limit", 60.0);
    assert_eq!(usage.clear_cooldown(Some("agy:3p")), vec!["agy:3p"]);
    assert_eq!(usage.clear_cooldown(Some("agy")), vec!["agy:gemini"]);
    assert_eq!(usage.clear_cooldown(None), vec!["cursor"]);
    assert_eq!(usage.clear_cooldown(None), Vec::<String>::new());
}

/// usage.test.ts, `UsageTracker`: "asks a probe once per TTL, keeps the last reading when it
/// fails, and survives a restart"
#[tokio::test]
async fn asks_a_probe_once_per_ttl_keeps_the_last_reading_when_it_fails_and_survives_a_restart() {
    let dir = TempDir::new();
    let file = dir.join("fleet-usage.json");
    let clock = TestClock::at(now());
    let calls = Arc::new(AtomicU32::new(0));
    let fail = Arc::new(Mutex::new(false));
    let mut options = options(&clock);
    options.file = Some(file.clone());
    options.probe_ttl = Duration::from_secs(60);
    let (counted, failing) = (calls.clone(), fail.clone());
    options.probes.insert(
        Codex,
        probe(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            let fail = *failing.lock().unwrap();
            async move {
                if fail {
                    Err("codex exited with 1".to_owned())
                } else {
                    Ok(readings(&[("codex", reading(50.0, None))]))
                }
            }
        }),
    );
    let usage = UsageTracker::new(options);
    tokio::join!(
        usage.unavailable(Codex, None, 90.0),
        usage.unavailable(Codex, None, 90.0)
    );
    usage.unavailable(Codex, None, 90.0).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    clock.advance(60_000.0);
    *fail.lock().unwrap() = true;
    assert_eq!(usage.unavailable(Codex, None, 90.0).await, None);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let codex = find(&usage, "codex");
    assert_eq!(codex.error.as_deref(), Some("codex exited with 1"));
    assert_eq!(codex.reading, Some(reading(50.0, None)));
    usage.refresh(true, None).await;
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    usage.note_failure(Cursor, None, "rate limit", 60.0);
    assert_eq!(mode(&file), 0o600);
    let mut restarted = UsageTrackerOptions::new(Some(file.clone()), clock.clone());
    restarted.probe_ttl = Duration::from_secs(60);
    let restarted = UsageTracker::new(restarted);
    let refused = restarted.unavailable(Cursor, None, 90.0).await.unwrap();
    assert!(refused.contains("cooling down"), "{refused}");
    assert_eq!(find(&restarted, "codex").reading, Some(reading(50.0, None)));
}

/// This crate's own: a tracker built with the default TTL asks again exactly 60 s after the last
/// try, not a millisecond sooner (`PROBE_TTL_MS`, `server/fleet/usage.ts:186`).
#[tokio::test]
async fn asks_again_when_the_default_ttl_has_passed() {
    let clock = TestClock::at(now());
    let calls = Arc::new(AtomicU32::new(0));
    let mut options = options(&clock);
    let counted = calls.clone();
    options.probes.insert(
        Claude,
        probe(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            async { Ok(readings(&[("claude", reading(1.0, None))])) }
        }),
    );
    let usage = UsageTracker::new(options);
    usage.unavailable(Claude, None, 90.0).await;
    clock.advance(59_999.0);
    usage.unavailable(Claude, None, 90.0).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    clock.advance(1.0);
    usage.unavailable(Claude, None, 90.0).await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

/// This crate's own: the stored file, as `persist` writes it (`server/fleet/usage.ts:383-396`): a
/// JSON array of the entries, written whole into a `<file>.<pid>.tmp` (0600) renamed over the
/// file, in a folder made for it (0700) when missing.
#[test]
fn stores_a_json_array_written_whole_into_a_private_file() {
    let dir = TempDir::new();
    let file = dir.join("state").join("fleet-usage.json");
    let mut options = options(&TestClock::at(now()));
    options.file = Some(file.clone());
    let usage = UsageTracker::new(options);
    usage.record(Codex, None, reading(10.0, Some(now() + HOUR)));
    usage.note_failure(Cursor, None, "rate limit", 1.0);
    let stored: Value = serde_json::from_str(&read(&file)).unwrap();
    let keys: Vec<&str> = stored
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, vec!["codex", "cursor"]);
    assert_eq!(stored[0]["reading"]["windows"][0]["usedPercent"], 10.0);
    assert_eq!(stored[1]["cooldown"]["until"], now() + MINUTE);
    assert_eq!(mode(&file), 0o600);
    assert_eq!(mode(&dir.join("state")), 0o700);
    let left: Vec<_> = fs::read_dir(dir.join("state"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(left, vec![OsString::from("fleet-usage.json")]);
}

/// usage.test.ts, `UsageTracker`: "refreshes by itself the CLIs that have a probe (codex, claude,
/// agy) once their last try is old, and never cursor"
#[tokio::test]
async fn refreshes_by_itself_the_clis_that_have_a_probe_once_their_last_try_is_old() {
    let clock = TestClock::at(now());
    let asked = Arc::new(Mutex::new(Vec::<&'static str>::new()));
    let mut options = options(&clock);
    for (kind, name) in [(Codex, "codex"), (Claude, "claude"), (Agy, "agy")] {
        let asked = asked.clone();
        options.probes.insert(
            kind,
            probe(move || {
                asked.lock().unwrap().push(name);
                async move { Ok(readings(&[(name, reading(10.0, None))])) }
            }),
        );
    }
    // the probes the server is built with: cursor has none, its `/usage` is typed into a live pane
    let usage = UsageTracker::new(options);
    usage.record(Cursor, None, reading(30.0, None));
    usage.refresh(false, Some(AUTO_REFRESH)).await;
    let mut sorted = asked.lock().unwrap().clone();
    sorted.sort_unstable();
    assert_eq!(sorted, vec!["agy", "claude", "codex"]);
    clock.advance(AUTO_REFRESH.as_millis() as f64 - 1.0);
    usage.refresh(false, Some(AUTO_REFRESH)).await;
    assert_eq!(asked.lock().unwrap().len(), 3);
    clock.advance(1.0);
    usage.refresh(false, Some(AUTO_REFRESH)).await;
    assert_eq!(asked.lock().unwrap().len(), 6);
    assert_eq!(find(&usage, "cursor").reading, Some(reading(30.0, None)));
}

/// usage.test.ts, `UsageTracker`: "never runs two probes of one CLI at once, however many
/// refreshes ask"
#[tokio::test]
async fn never_runs_two_probes_of_one_cli_at_once_however_many_refreshes_ask() {
    let running = Arc::new(AtomicU32::new(0));
    let peak = Arc::new(AtomicU32::new(0));
    let calls = Arc::new(AtomicU32::new(0));
    let release = Arc::new(Mutex::new(Vec::<tokio::sync::oneshot::Sender<()>>::new()));
    let mut options = options(&TestClock::at(now()));
    let (r, p, c, waiting) = (
        running.clone(),
        peak.clone(),
        calls.clone(),
        release.clone(),
    );
    options.probes.insert(
        Claude,
        probe(move || {
            c.fetch_add(1, Ordering::SeqCst);
            let now_running = r.fetch_add(1, Ordering::SeqCst) + 1;
            p.fetch_max(now_running, Ordering::SeqCst);
            let (sender, receiver) = tokio::sync::oneshot::channel();
            waiting.lock().unwrap().push(sender);
            let r = r.clone();
            async move {
                let _ = receiver.await;
                r.fetch_sub(1, Ordering::SeqCst);
                Ok(readings(&[("claude", reading(10.0, None))]))
            }
        }),
    );
    let usage = UsageTracker::new(options);
    let asks = vec![
        tokio::spawn({
            let usage = usage.clone();
            async move { usage.refresh(false, Some(AUTO_REFRESH)).await }
        }),
        tokio::spawn({
            let usage = usage.clone();
            async move { usage.refresh(true, None).await }
        }),
        tokio::spawn({
            let usage = usage.clone();
            async move { usage.refresh(false, Some(AUTO_REFRESH)).await }
        }),
        tokio::spawn({
            let usage = usage.clone();
            async move {
                usage.unavailable(Claude, None, 90.0).await;
            }
        }),
    ];
    while release.lock().unwrap().is_empty() {
        tokio::task::yield_now().await;
    }
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    for sender in release.lock().unwrap().drain(..) {
        let _ = sender.send(());
    }
    for ask in asks {
        ask.await.unwrap();
    }
    assert_eq!(
        (calls.load(Ordering::SeqCst), peak.load(Ordering::SeqCst)),
        (1, 1)
    );
}

/// usage.test.ts, `UsageTracker`: "backs off a CLI that keeps failing (not installed, not signed
/// in), up to hourly, until it answers or a person presses refresh"
#[tokio::test]
async fn backs_off_a_cli_that_keeps_failing_up_to_hourly_until_it_answers_or_a_person_presses_refresh()
 {
    let clock = TestClock::at(now());
    let calls = Arc::new(AtomicU32::new(0));
    let fail = Arc::new(Mutex::new(true));
    let mut options = options(&clock);
    let (counted, failing) = (calls.clone(), fail.clone());
    options.probes.insert(
        Agy,
        probe(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            let fail = *failing.lock().unwrap();
            async move {
                if fail {
                    Err("spawn agy ENOENT".to_owned())
                } else {
                    Ok(readings(&[("agy:gemini", reading(5.0, None))]))
                }
            }
        }),
    );
    let usage = UsageTracker::new(options);
    let mut gaps = Vec::new();
    let mut last: Option<u32> = None;
    for minute in 0..24 * 60 {
        if gaps.len() >= 8 {
            break;
        }
        clock.set(now() + f64::from(minute) * MINUTE);
        let before = calls.load(Ordering::SeqCst);
        usage.refresh(false, Some(AUTO_REFRESH)).await;
        if calls.load(Ordering::SeqCst) > before {
            if let Some(last) = last {
                gaps.push(minute - last);
            }
            last = Some(minute);
        }
    }
    // the wait doubles with each failure and stops at the cap
    assert_eq!(gaps[..4], [10, 20, 40, 60]);
    assert_eq!(gaps[4..], [60, 60, 60, 60]);
    assert_eq!(BACKOFF_CAP, Duration::from_secs(60 * 60));
    let before = calls.load(Ordering::SeqCst);
    usage.refresh(true, None).await;
    assert_eq!(calls.load(Ordering::SeqCst), before + 1);
    *fail.lock().unwrap() = false;
    usage.refresh(true, None).await;
    // an answer ends the back-off: the next automatic try is on the ordinary schedule again
    clock.advance(AUTO_REFRESH.as_millis() as f64);
    usage.refresh(false, Some(AUTO_REFRESH)).await;
    assert_eq!(calls.load(Ordering::SeqCst), before + 3);
}

/// usage.test.ts, `UsageTracker`: "keeps a spawn's own probe at the plain TTL however often the
/// CLI failed"
#[tokio::test]
async fn keeps_a_spawns_own_probe_at_the_plain_ttl_however_often_the_cli_failed() {
    let clock = TestClock::at(now());
    let calls = Arc::new(AtomicU32::new(0));
    let mut options = options(&clock);
    options.probe_ttl = Duration::from_secs(60);
    let counted = calls.clone();
    options.probes.insert(
        Agy,
        probe(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            async { Err("agy exited with 1".to_owned()) }
        }),
    );
    let usage = UsageTracker::new(options);
    for _ in 0..4 {
        clock.advance(60_000.0);
        usage.refresh(false, Some(AUTO_REFRESH)).await;
        clock.advance(24.0 * HOUR);
        usage.refresh(false, Some(AUTO_REFRESH)).await;
    }
    let before = calls.load(Ordering::SeqCst);
    // the automatic refresh is backed off now, but a spawn one minute later still asks
    clock.advance(60_000.0);
    usage.refresh(false, Some(AUTO_REFRESH)).await;
    assert_eq!(calls.load(Ordering::SeqCst), before);
    usage.unavailable(Agy, Some("gemini-pro"), 90.0).await;
    assert_eq!(calls.load(Ordering::SeqCst), before + 1);
    usage.unavailable(Agy, Some("gemini-pro"), 90.0).await;
    assert_eq!(calls.load(Ordering::SeqCst), before + 1);
    clock.advance(60_000.0);
    usage.unavailable(Agy, Some("gemini-pro"), 90.0).await;
    assert_eq!(calls.load(Ordering::SeqCst), before + 2);
}

/// usage.test.ts, `UsageTracker`: "is built with probes for codex, claude and agy only: never
/// cursor"
#[test]
fn is_built_with_probes_for_codex_claude_and_agy_only() {
    let dir = TempDir::new();
    let clock: Arc<dyn Clock> = TestClock::at(now());
    let probes: HashMap<FleetAgentKind, UsageProbe> = default_probes(&dir.0, &Env::new(), clock);
    let mut kinds: Vec<String> = probes
        .keys()
        .map(|kind| {
            serde_json::to_value(kind)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    kinds.sort_unstable();
    assert_eq!(kinds, vec!["agy", "claude", "codex"]);
}

/// This crate's own: the server's probes run in `<stateDir>/usage-probe/<kind>`
/// (`server/fleet/usage.ts:401`): an agy found on the `PATH` it is given writes where it ran.
#[tokio::test]
async fn the_servers_probes_run_in_their_own_folder_under_the_state_folder() {
    let dir = TempDir::new();
    let bin = dir.join("bin");
    fs::create_dir(&bin).unwrap();
    let cwd_note = dir.join("agy.cwd");
    fake(
        &bin,
        "agy",
        &format!(
            "pwd > '{}'\necho '{{\"command\":{{\"data\":{{\"groups\":[]}}}}}}'",
            cwd_note.display()
        ),
    );
    let mut env = Env::new();
    let path = std::env::var_os("PATH").unwrap_or_default();
    let mut joined = bin.as_os_str().to_owned();
    joined.push(":");
    joined.push(path);
    env.insert("PATH".into(), joined);
    let state = dir.join("state");
    let clock: Arc<dyn Clock> = TestClock::at(now());
    let probes = default_probes(&state, &env, clock);
    assert_eq!(probes[&Agy]().await, Ok(Readings::new()));
    assert_eq!(
        read(&cwd_note).trim(),
        state.join("usage-probe").join("agy").display().to_string()
    );
}

/// usage.test.ts, `UsageTracker`: "has cursor's screen read only when neither its last reading
/// nor its last try is recent"
#[test]
fn has_cursors_screen_read_only_when_neither_its_last_reading_nor_its_last_try_is_recent() {
    let clock = TestClock::at(now());
    let usage = UsageTracker::new(options(&clock));
    assert!(usage.claim_screen(Cursor, None));
    // the try found nothing: the next turn does not pay for another one yet
    assert!(!usage.claim_screen(Cursor, None));
    clock.advance(10.0 * MINUTE);
    usage.record(
        Cursor,
        None,
        UsageReading {
            read_at: clock.get(),
            windows: vec![],
        },
    );
    assert!(!usage.claim_screen(Cursor, None));
    clock.advance(10.0 * MINUTE);
    assert!(usage.claim_screen(Cursor, None));
}

/// usage.test.ts, `UsageTracker`: "gives up on a probe that never answers, so spawns go on"
#[tokio::test]
async fn gives_up_on_a_probe_that_never_answers_so_spawns_go_on() {
    let mut options = options(&TestClock::at(now()));
    options.probe_timeout = Duration::from_millis(20);
    options
        .probes
        .insert(Agy, probe(std::future::pending::<Result<Readings, String>>));
    let usage = UsageTracker::new(options);
    assert_eq!(usage.unavailable(Agy, Some("gemini-pro"), 90.0).await, None);
    assert_eq!(
        usage.list(),
        vec![UsageEntry {
            error: Some("agy did not answer within 0.02s".to_owned()),
            ..entry("agy")
        }]
    );
}

/// This crate's own: a probe that panics is a probe that failed, and the CLI is asked again
/// later: the tracker is not left waiting for it.
#[tokio::test]
async fn a_probe_that_panics_is_a_failed_probe() {
    let calls = Arc::new(AtomicU64::new(0));
    let mut options = options(&TestClock::at(now()));
    options.probe_ttl = Duration::ZERO;
    let counted = calls.clone();
    options.probes.insert(
        Codex,
        probe(move || {
            let call = counted.fetch_add(1, Ordering::SeqCst);
            async move {
                assert!(call > 0, "the first probe panics");
                Ok(readings(&[("codex", reading(5.0, None))]))
            }
        }),
    );
    let usage = UsageTracker::new(options);
    usage.refresh(false, None).await;
    assert!(find(&usage, "codex").error.is_some());
    usage.refresh(false, None).await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        find(&usage, "codex"),
        UsageEntry {
            reading: Some(reading(5.0, None)),
            ..entry("codex")
        }
    );
}

/// This crate's own: a probe whose closure panics before it hands out its future is a failed
/// probe too, and the CLI is asked again later (architect run 04110847 found the tracker left
/// waiting on it for good).
#[tokio::test]
async fn a_probe_that_panics_before_its_future_is_asked_again() {
    let calls = Arc::new(AtomicU64::new(0));
    let mut options = options(&TestClock::at(now()));
    options.probe_ttl = Duration::ZERO;
    let counted = calls.clone();
    let panicking: UsageProbe = Arc::new(move || {
        let call = counted.fetch_add(1, Ordering::SeqCst);
        assert!(call > 0, "the first call panics before its future");
        Box::pin(async { Ok(readings(&[("codex", reading(5.0, None))])) })
    });
    options.probes.insert(Codex, panicking);
    let usage = UsageTracker::new(options);
    usage.refresh(false, None).await;
    assert!(find(&usage, "codex").error.is_some());
    usage.refresh(false, None).await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(find(&usage, "codex").reading, Some(reading(5.0, None)));
}

/// usage.test.ts, `UsageTracker`: "replaces what it knew of a CLI with what the probe answers,
/// clearing an earlier failure but not a cooldown"
#[tokio::test]
async fn replaces_what_it_knew_of_a_cli_with_what_the_probe_answers_but_not_a_cooldown() {
    let answer: Arc<Mutex<Result<Readings, String>>> =
        Arc::new(Mutex::new(Err("agy exited with 1".to_owned())));
    let mut options = options(&TestClock::at(now()));
    options.probe_ttl = Duration::ZERO;
    let answering = answer.clone();
    options.probes.insert(
        Agy,
        probe(move || {
            let answer = answering.lock().unwrap().clone();
            async move { answer }
        }),
    );
    let usage = UsageTracker::new(options);
    usage.refresh(false, None).await;
    assert_eq!(
        usage.list(),
        vec![UsageEntry {
            error: Some("agy exited with 1".to_owned()),
            ..entry("agy")
        }]
    );
    *answer.lock().unwrap() = Ok(readings(&[
        ("agy:gemini", reading(10.0, None)),
        ("agy:3p", reading(20.0, None)),
    ]));
    usage.refresh(false, None).await;
    let keys: Vec<String> = usage.list().into_iter().map(|entry| entry.key).collect();
    assert_eq!(keys, vec!["agy:3p", "agy:gemini"]);
    *answer.lock().unwrap() = Err("agy exited with 2".to_owned());
    usage.refresh(false, None).await;
    let errors: Vec<(String, Option<String>)> = usage
        .list()
        .into_iter()
        .map(|entry| (entry.key, entry.error))
        .collect();
    assert_eq!(
        errors,
        vec![
            ("agy:3p".to_owned(), Some("agy exited with 2".to_owned())),
            (
                "agy:gemini".to_owned(),
                Some("agy exited with 2".to_owned())
            ),
        ]
    );
    usage.note_failure(Agy, Some("claude-sonnet"), "rate limit", 60.0);
    *answer.lock().unwrap() = Ok(readings(&[("agy:gemini", reading(30.0, None))]));
    usage.refresh(false, None).await;
    let list = usage.list();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].key, "agy:3p");
    assert_eq!(list[0].reading, None);
    assert_eq!(list[0].error, None);
    assert_eq!(list[0].cooldown.as_ref().unwrap().reason, "rate limit");
    assert_eq!(
        list[1],
        UsageEntry {
            reading: Some(reading(30.0, None)),
            ..entry("agy:gemini")
        }
    );
}

/// usage.test.ts, `UsageTracker`: "drops what a stored file holds in a shape it cannot read"
#[tokio::test]
async fn drops_what_a_stored_file_holds_in_a_shape_it_cannot_read() {
    let dir = TempDir::new();
    let file = dir.join("fleet-usage.json");
    let clock = TestClock::at(now());
    let open = |file: &Path| {
        let clock: Arc<dyn Clock> = clock.clone();
        UsageTracker::new(UsageTrackerOptions::new(Some(file.to_path_buf()), clock))
    };
    fs::write(&file, r#"{"not":"a list"}"#).unwrap();
    assert_eq!(open(&file).list(), vec![]);
    let stored = json!([
        { "key": "codex", "reading": { "readAt": 1 } },
        { "key": "claude", "reading": serde_json::to_value(reading(95.0, None)).unwrap(), "cooldown": { "until": "soon" } },
        { "nokey": true },
    ]);
    fs::write(&file, stored.to_string()).unwrap();
    let usage = open(&file);
    assert_eq!(
        usage.list(),
        vec![
            UsageEntry {
                reading: Some(reading(95.0, None)),
                ..entry("claude")
            },
            entry("codex"),
        ]
    );
    assert_eq!(usage.unavailable(Codex, None, 90.0).await, None);
    let refused = usage.unavailable(Claude, None, 90.0).await.unwrap();
    assert!(refused.contains("95%"), "{refused}");
}

/// This crate's own: a window whose `resetsAt` is not a number (`null` here) is not a window this
/// code reads (`validWindow`), so the reading that holds it is dropped, and the other parts of the
/// entry stay.
#[test]
fn drops_a_stored_reading_with_a_window_it_cannot_read() {
    let dir = TempDir::new();
    let file = dir.join("fleet-usage.json");
    let stored = json!([
        { "key": "codex", "reading": { "readAt": 1, "windows": [{ "name": "5h", "usedPercent": 5, "resetsAt": null }] }, "error": "e" },
        { "key": "agy:3p", "cooldown": { "until": 2, "since": 1, "reason": "r" } },
    ]);
    fs::write(&file, stored.to_string()).unwrap();
    let clock: Arc<dyn Clock> = TestClock::at(now());
    let usage = UsageTracker::new(UsageTrackerOptions::new(Some(file), clock));
    assert_eq!(
        usage.list(),
        vec![
            UsageEntry {
                cooldown: Some(Cooldown {
                    until: 2.0,
                    since: 1.0,
                    reason: "r".to_owned()
                }),
                ..entry("agy:3p")
            },
            UsageEntry {
                error: Some("e".to_owned()),
                ..entry("codex")
            },
        ]
    );
}

/// usage.test.ts, `UsageTracker`: "still notes a cooldown when its file cannot be written"
#[test]
fn still_notes_a_cooldown_when_its_file_cannot_be_written() {
    let dir = TempDir::new();
    fs::write(dir.join("blocker"), "").unwrap();
    let mut options = options(&TestClock::at(now()));
    options.file = Some(dir.join("blocker").join("fleet-usage.json"));
    let usage = UsageTracker::new(options);
    assert!(usage.note_failure(Cursor, None, "rate limit", 60.0));
    assert!(usage.list()[0].cooldown.is_some());
}
