//! Fleet.json, the standing orders and the spawn candidates (`parse_candidate`); from
//! `server/fleet/config.ts`, `parseCandidate` (`server/fleet/orchestrator.ts:191`) and the thinking
//! levels of `server/fleet/types.ts`.
//!
//! Where the person's files are is passed in (`user_fleet_dir`'s arguments, the `user_dir` of
//! each loader): nothing here reads the process's environment or home folder, so a test points
//! every loader at a folder of its own (ADR 0242-phase-3-split, "隔離").

use std::ffi::OsStr;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use indexmap::IndexMap;
use protocol::{FleetAgentKind, ThinkingLevel};
use regex::Regex;
use serde_json::{Map, Value};

use crate::FleetError;

/// The fleet's settings: built-in defaults, then the person's fleet.json, then the project's.
///
/// The counts are JavaScript numbers, as in `protocol::FleetSettings` (ADR 0244-phase-3-dependencies,
/// "数の型"): fleet.json's values are floored and bounded below only, so they may pass `u32`.
#[derive(Debug, Clone, PartialEq)]
pub struct FleetConfig {
    pub default_model: Option<String>,
    pub default_thinking: Option<ThinkingLevel>,
    /// Runs starting or working at once; idle, done and blocked ones do not count.
    pub max_concurrent: f64,
    /// How deep agents may spawn agents: the caller is depth 0.
    pub max_depth: f64,
    pub recent_read_lines: f64,
    pub default_wait_timeout_ms: f64,
    /// Close a non-interactive agent's pane once its turn settles.
    pub close_on_settle: bool,
    /// The project runs without the person: its coordinator hears each turn its threads end, not
    /// only their questions, and a thread whose pull request is merged closes as its lead's turn ends.
    pub autonomous: bool,
    /// The language the person reads, such as Japanese; unset, the agents choose.
    pub language: Option<String>,
    /// A spawn candidate is skipped while any limit window of its account is used this much (percent).
    pub max_used_percent: f64,
    /// How long an account sits out after a rate limit whose message names no time.
    pub rate_limit_cooldown_minutes: f64,
    /// Kept in the order fleet.json names them, as a JavaScript object keeps its keys except that
    /// JavaScript puts keys that read as integers (`"10"`) first, in ascending order.
    pub roles: IndexMap<String, RoleOverride>,
    pub models: IndexMap<String, ModelPolicy>,
    /// Only from the person's own fleet.json: a repository must not name commands the fleet runs.
    pub projects: IndexMap<String, ProjectConfig>,
}

/// `DEFAULT_CONFIG` (`config.ts:7`).
impl Default for FleetConfig {
    fn default() -> Self {
        FleetConfig {
            default_model: None,
            default_thinking: None,
            max_concurrent: 6.0,
            // you, a project's coordinator, a thread's lead, the helpers it hands parts to
            max_depth: 3.0,
            recent_read_lines: 160.0,
            default_wait_timeout_ms: 120_000.0,
            close_on_settle: true,
            autonomous: false,
            language: None,
            max_used_percent: 90.0,
            rate_limit_cooldown_minutes: 60.0,
            roles: IndexMap::new(),
            models: IndexMap::new(),
            projects: IndexMap::new(),
        }
    }
}

/// What `config.roles.<name>` changes about a role.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RoleOverride {
    pub agent: Option<FleetAgentKind>,
    pub model: Option<String>,
    pub thinking: Option<ThinkingLevel>,
    /// Candidates to try, in order, when the primary one cannot start, fails its first turn or has
    /// no usage left: a model of the role's CLI, or `<agent>:<model>` for another CLI's.
    pub fallback_models: Option<Vec<String>>,
    pub worktree: Option<bool>,
    pub interactive: Option<bool>,
    pub spawning: Option<bool>,
}

/// `config.models.<model>`: the thinking levels the model takes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelPolicy {
    pub thinking: Option<Vec<ThinkingLevel>>,
}

/// `config.projects.<absolute path>`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectConfig {
    /// The command a new thread's worktree runs before its lead starts.
    pub setup: Option<String>,
}

/// A candidate entry read: the CLI, and the model, if any, as the entry gives it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub agent: FleetAgentKind,
    pub model: Option<String>,
}

/// One of a role's candidates: the entry as configured (none: the CLI's default model) and how it reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateEntry {
    pub entry: Option<String>,
    pub agent: FleetAgentKind,
    pub model: Option<String>,
}

/// Where the person's fleet config and roles live: `$XDG_CONFIG_HOME/herdr-fleet`, or
/// `<home>/.config/herdr-fleet` when XDG_CONFIG_HOME is unset or empty. The caller passes the
/// variable's value and the home folder.
pub fn user_fleet_dir(xdg_config_home: Option<&OsStr>, home: &Path) -> PathBuf {
    match xdg_config_home.filter(|value| !value.is_empty()) {
        Some(config) => normalize(&Path::new(config).join("herdr-fleet")),
        None => normalize(&home.join(".config").join("herdr-fleet")),
    }
}

/// Node's `path.normalize` on POSIX, which `path.join` ends with: `.` dropped, repeated `/`
/// collapsed, `..` folded into the folder before it, never above the root, and kept at the start
/// of a relative path, which stays relative (unlike `resolve`).
pub(crate) fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    // folders in `out` that a `..` may fold
    let mut depth = 0usize;
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir if depth > 0 => {
                out.pop();
                depth -= 1;
            }
            Component::ParentDir if path.is_absolute() => {}
            Component::Normal(_) => {
                out.push(component);
                depth += 1;
            }
            other => out.push(other),
        }
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    out
}

/// The nearest `.herdr-fleet/<name>` from `cwd` up, the project's own.
pub fn find_project_path(cwd: &Path, name: &str) -> Option<PathBuf> {
    let mut current = resolve(cwd, "");
    loop {
        let candidate = current.join(".herdr-fleet").join(name);
        if candidate.exists() {
            return Some(candidate);
        }
        if !current.pop() {
            return None;
        }
    }
}

/// `raw` over `base`: known keys only, each checked; what does not parse keeps the base's value.
pub fn merge_config(base: &FleetConfig, raw: &Map<String, Value>) -> FleetConfig {
    let mut models = base.models.clone();
    if let Some(Value::Object(given)) = raw.get("models") {
        for (name, value) in given {
            let policy = models.entry(name.clone()).or_default();
            // config.ts spreads `{ thinking: undefined }` over the lower one: an object replaces it
            if let Value::Object(value) = value {
                policy.thinking = parse_model_thinking(value);
            }
        }
    }
    let mut roles = base.roles.clone();
    if let Some(Value::Object(given)) = raw.get("roles") {
        for (name, value) in given {
            merge_role(roles.entry(name.clone()).or_default(), value);
        }
    }
    let mut projects = base.projects.clone();
    if let Some(Value::Object(given)) = raw.get("projects") {
        for (path, value) in given
            .iter()
            .filter(|(path, _)| Path::new(path).is_absolute())
        {
            let project = projects
                .entry(resolve(Path::new("/"), path).to_string_lossy().into_owned())
                .or_default();
            if let Some(setup) = parse_setup(value) {
                project.setup = Some(setup);
            }
        }
    }
    let count = |key: &str, min: f64, fallback: f64| {
        raw.get(key)
            .and_then(Value::as_f64)
            // `+ 0.0` makes -0 +0, as `Math.max` does; `f64::max` may return either zero
            .map_or(fallback, |n| n.floor().max(min) + 0.0)
    };
    FleetConfig {
        default_model: raw
            .get("defaultModel")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| base.default_model.clone()),
        default_thinking: raw
            .get("defaultThinking")
            .and_then(parse_thinking_level)
            .or(base.default_thinking),
        max_concurrent: count("maxConcurrent", 1.0, base.max_concurrent),
        max_depth: count("maxDepth", 0.0, base.max_depth),
        recent_read_lines: count("recentReadLines", 20.0, base.recent_read_lines),
        default_wait_timeout_ms: count("defaultWaitTimeoutMs", 1.0, base.default_wait_timeout_ms),
        close_on_settle: raw
            .get("closeOnSettle")
            .and_then(Value::as_bool)
            .unwrap_or(base.close_on_settle),
        autonomous: raw
            .get("autonomous")
            .and_then(Value::as_bool)
            .unwrap_or(base.autonomous),
        language: raw
            .get("language")
            .and_then(Value::as_str)
            .filter(|text| is_language_name(text))
            .map(|text| protocol::js::trim(text).to_owned())
            .or_else(|| base.language.clone()),
        max_used_percent: raw
            .get("maxUsedPercent")
            .and_then(Value::as_f64)
            .map_or(base.max_used_percent, |n| n.clamp(1.0, 100.0)),
        rate_limit_cooldown_minutes: count(
            "rateLimitCooldownMinutes",
            1.0,
            base.rate_limit_cooldown_minutes,
        ),
        roles,
        models,
        projects,
    }
}

/// Built-in defaults, then the person's `<user_dir>/fleet.json`, then the project's nearest
/// `.herdr-fleet/fleet.json`. A file that cannot be read or is not a JSON object is skipped with
/// a warning; a missing one silently.
pub fn load_config(cwd: &Path, warnings: &mut Vec<String>, user_dir: &Path) -> FleetConfig {
    // the project's file is read first, as in TypeScript, so its warning comes first
    let mut project = find_project_path(cwd, "fleet.json")
        .map(|file| read_json(&file, warnings))
        .unwrap_or_default();
    let user = read_json(&user_dir.join("fleet.json"), warnings);
    // the project's file comes with the repository: it may tune roles, never name a command to run
    project.remove("projects");
    merge_config(&merge_config(&FleetConfig::default(), &user), &project)
}

/// Orders every agent gets with its role, whatever it is asked: the person's
/// `<user_dir>/standing.md`, then the project's nearest `.herdr-fleet/standing.md`, each trimmed,
/// empty ones and unreadable ones left out. A rule given once at spawn fades as work is handed on.
pub fn load_standing_orders(cwd: &Path, user_dir: &Path) -> String {
    [
        Some(user_dir.join("standing.md")),
        find_project_path(cwd, "standing.md"),
    ]
    .into_iter()
    .flatten()
    .filter_map(|file| fs::read(file).ok())
    .map(|bytes| protocol::js::trim(&String::from_utf8_lossy(&bytes)).to_owned())
    .filter(|text| !text.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n")
}

/// A language's name, such as Japanese or 日本語: letters, spaces, hyphens and parentheses, up to
/// 40 characters, on one line (after trimming).
pub fn is_language_name(text: &str) -> bool {
    static NAME: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[\p{L}\p{M}][\p{L}\p{M} ()-]{0,39}$").expect("the language pattern compiles")
    });
    NAME.is_match(protocol::js::trim(text))
}

/// A candidate entry: `<agent>:<model>` names another CLI, anything else is a model of the role's
/// own CLI `kind`. A model's `:level` suffix stays with the model (`codex:gpt-6:high`). An empty
/// model after a CLI's name is none (the CLI's default); an entry without a CLI's name is the
/// model as given, even empty.
pub fn parse_candidate(entry: Option<&str>, kind: FleetAgentKind) -> Candidate {
    if let Some((prefix, model)) = entry
        .and_then(|entry| entry.split_once(':'))
        .filter(|(prefix, _)| !prefix.is_empty())
        && let Some(agent) = agent_kind(prefix)
    {
        return Candidate {
            agent,
            model: Some(model.to_owned()).filter(|model| !model.is_empty()),
        };
    }
    Candidate {
        agent: kind,
        model: entry.map(str::to_owned),
    }
}

/// A role's candidates in the order the orchestrator tries them: the primary model, then the
/// fallbacks other than it, each read with the role's CLI `kind` as the default
/// (`orchestrator.ts:451`, `settings.ts:116`). Which model is the primary is the caller's choice.
pub fn role_candidates(
    kind: FleetAgentKind,
    primary: Option<&str>,
    fallbacks: &[String],
) -> Vec<CandidateEntry> {
    std::iter::once(primary)
        .chain(
            fallbacks
                .iter()
                .map(|entry| Some(entry.as_str()))
                .filter(|entry| *entry != primary),
        )
        .map(|entry| {
            let Candidate { agent, model } = parse_candidate(entry, kind);
            CandidateEntry {
                entry: entry.map(str::to_owned),
                agent,
                model,
            }
        })
        .collect()
}

/// A thinking level in a config or a role file: an unknown value is dropped, not an error.
pub fn parse_thinking_level(value: &Value) -> Option<ThinkingLevel> {
    value.as_str().and_then(thinking_level)
}

/// A thinking level a spawn request gives explicitly: it has to be a known one. TypeScript throws
/// a plain `Error` here, which `/api/fleet` answers as `internal_error` (`api.ts:304`); the code
/// keeps that answer.
pub fn require_thinking_level(value: Option<&str>) -> Result<Option<ThinkingLevel>, FleetError> {
    match value {
        None => Ok(None),
        Some(text) => thinking_level(text).map(Some).ok_or_else(|| {
            FleetError::new(
                "internal_error",
                format!(
                    "Invalid thinking level {}. Use one of: off, minimal, low, medium, high, xhigh, max.",
                    Value::from(text)
                ),
            )
        }),
    }
}

/// The agent CLI a name stands for, as `isAgentKind` reads it: exactly one of the kinds' names.
pub(crate) fn agent_kind(name: &str) -> Option<FleetAgentKind> {
    serde_json::from_value(Value::from(name)).ok()
}

fn thinking_level(name: &str) -> Option<ThinkingLevel> {
    serde_json::from_value(Value::from(name)).ok()
}

/// The keys a role entry sets with a usable value; an absent or unusable key keeps the lower one's.
fn merge_role(role: &mut RoleOverride, value: &Value) {
    let Value::Object(value) = value else { return };
    if let Some(agent) = value
        .get("agent")
        .and_then(Value::as_str)
        .and_then(agent_kind)
    {
        role.agent = Some(agent);
    }
    if let Some(model) = value.get("model").and_then(Value::as_str) {
        role.model = Some(model.to_owned());
    }
    if let Some(thinking) = value.get("thinking").and_then(parse_thinking_level) {
        role.thinking = Some(thinking);
    }
    if let Some(Value::Array(models)) = value.get("fallbackModels") {
        let names = models
            .iter()
            .filter_map(Value::as_str)
            .filter(|name| !name.is_empty());
        role.fallback_models = Some(names.map(str::to_owned).collect());
    }
    for (key, field) in [
        ("worktree", &mut role.worktree),
        ("interactive", &mut role.interactive),
        ("spawning", &mut role.spawning),
    ] {
        if let Some(flag) = value.get(key).and_then(Value::as_bool) {
            *field = Some(flag);
        }
    }
}

/// A model policy's thinking levels: the known ones, none when none is known.
fn parse_model_thinking(value: &Map<String, Value>) -> Option<Vec<ThinkingLevel>> {
    let Some(Value::Array(levels)) = value.get("thinking") else {
        return None;
    };
    Some(
        levels
            .iter()
            .filter_map(parse_thinking_level)
            .collect::<Vec<_>>(),
    )
    .filter(|levels| !levels.is_empty())
}

/// A project's setup command, trimmed, when it has one.
fn parse_setup(value: &Value) -> Option<String> {
    let setup = protocol::js::trim(value.get("setup")?.as_str()?);
    (!setup.is_empty()).then(|| setup.to_owned())
}

/// A JSON object file: none when it is missing, and a warning naming the file when it cannot be
/// read, does not parse or is not an object.
fn read_json(file: &Path, warnings: &mut Vec<String>) -> Map<String, Value> {
    let bytes = match fs::read(file) {
        Ok(bytes) => bytes,
        Err(error) => {
            if error.kind() != ErrorKind::NotFound {
                warnings.push(format!(
                    "fleet: ignoring unreadable {}: {error}",
                    file.display()
                ));
            }
            return Map::new();
        }
    };
    match serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)) {
        Ok(Value::Object(map)) => map,
        Ok(_) => {
            warnings.push(format!(
                "fleet: ignoring {}: expected a JSON object",
                file.display()
            ));
            Map::new()
        }
        Err(error) => {
            warnings.push(format!(
                "fleet: ignoring invalid JSON in {}: {error}",
                file.display()
            ));
            Map::new()
        }
    }
}

/// `path` resolved against `base` as Node's `path.resolve(base, path)` does on Unix: an absolute
/// `path` starts over, a relative `base` starts from the process's folder, `.` and empty parts
/// drop, `..` climbs (never above the root), and no slash ends it. Only the text is read; a
/// symbolic link is not followed.
pub(crate) fn resolve(base: &Path, path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    let start = if path.is_absolute() || base.is_absolute() {
        PathBuf::new()
    } else {
        std::env::current_dir().unwrap_or_default()
    };
    let mut out = PathBuf::from("/");
    for component in start
        .components()
        .chain(base.components())
        .chain(path.components())
    {
        match component {
            Component::RootDir => out = PathBuf::from("/"),
            Component::Prefix(prefix) => out = PathBuf::from(prefix.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}
