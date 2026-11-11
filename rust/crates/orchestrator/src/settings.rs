//! The Settings page's side of the person's fleet.json (`server/fleet/settings.ts`): what it holds,
//! drawn per role with what the role's file and the project's own fleet.json make of it, and
//! changes written back into it. Keys the page does not know stay as they are. The interface:
//! docs/rust-migration/adr/0260-settings-store.md.

use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex, PoisonError};

use protocol::js::locale_compare;
use protocol::{
    FleetAgentKind, FleetSettings, FleetSettingsPatch, ProjectPatch, ProjectSetup, RoleCandidate,
    RoleCandidateSetting, RoleCandidates, RolePatch, RoleSettings,
};
use serde_json::{Map, Value};

use crate::FleetError;
use crate::agents::AgentDefinition;
use crate::config::{
    FleetConfig, RoleOverride, find_project_path, is_language_name, merge_config, normalize,
    resolve, role_candidates,
};
use crate::fleet::RoleSource;
use crate::launch::{RoleFit, adapter_for};

const MAX_CANDIDATES: usize = 8;
/// The CLIs in the order the page lists them (`KINDS`, settings.ts:20).
const KINDS: [FleetAgentKind; 6] = [
    FleetAgentKind::Claude,
    FleetAgentKind::Codex,
    FleetAgentKind::Cursor,
    FleetAgentKind::Agy,
    FleetAgentKind::Opencode,
    FleetAgentKind::Pi,
];
const MAX_SETUP_CHARS: usize = 2000;
const MAX_MODEL_CHARS: usize = 200;
/// The bundled roles in the order work passes between them: the coordinator starts threads, a
/// thread's lead asks an architect how to build, and hands an investigation to a scout, a part to a
/// worker and every change to a reviewer. The planner, which neither asks for, comes after them, and
/// the person's own roles follow by name.
const ROLE_FLOW: [&str; 7] = [
    "coordinator",
    "lead",
    "architect",
    "scout",
    "worker",
    "reviewer",
    "planner",
];
/// The whole numbers a patch may set, with their bounds (`LIMITS`, settings.ts:30).
const LIMITS: [(&str, f64, f64); 3] = [
    ("maxUsedPercent", 1.0, 100.0),
    ("rateLimitCooldownMinutes", 1.0, 24.0 * 60.0),
    ("maxConcurrent", 1.0, 32.0),
];
/// A role's keys the page sets; the others stay as the file has them.
const ROLE_KEYS: [&str; 4] = ["agent", "model", "fallbackModels", "thinking"];

/// What is known of an account's usage, asking no CLI: `UsageTracker::known` (ADR
/// 0254-usage-interface), called with the CLI, the model and the limit in percent.
pub type UsageKnown =
    Arc<dyn Fn(FleetAgentKind, Option<&str>, f64) -> Option<String> + Send + Sync>;

/// What the store is built from (`FleetSettingsDeps`).
pub struct FleetSettingsDeps {
    /// the roles that exist in a folder
    pub agents: RoleSource,
    /// why a candidate would be passed over now for its usage; none: nothing is known
    pub usage: Option<UsageKnown>,
    /// where the person's fleet.json lives (`config::user_fleet_dir`)
    pub user_dir: PathBuf,
}

/// The person's fleet.json read and written for the Settings page; changes go one at a time.
///
/// Errors: `settings_unreadable` when fleet.json cannot be read or is not a JSON object,
/// `invalid_settings` and `unknown_role` for a patch the fleet could not use, and `internal_error`
/// when fleet.json cannot be written (TypeScript throws the file system's own error there, which
/// `/api/fleet` answers as `internal_error`, `api.ts:304`).
pub struct FleetSettingsStore {
    deps: FleetSettingsDeps,
    /// held while a change reads, changes and writes the file (TypeScript's `queue`)
    writing: Mutex<()>,
}

impl FleetSettingsStore {
    pub fn new(deps: FleetSettingsDeps) -> Self {
        FleetSettingsStore {
            deps,
            writing: Mutex::new(()),
        }
    }

    /// The person's fleet.json, where every change is saved.
    fn file(&self) -> PathBuf {
        normalize(&self.deps.user_dir.join("fleet.json"))
    }

    /// The settings as the fleet uses them in `cwd`'s project.
    pub fn read(&self, cwd: &Path) -> Result<FleetSettings, FleetError> {
        let file = self.file();
        let raw = read_user_file(&file)?;
        let defaults = FleetConfig::default();
        let user = merge_config(&defaults, &raw);
        let project_roles = find_project_path(cwd, "fleet.json")
            .map(|file| read_roles(&file))
            .unwrap_or_default();
        let project_config = merge_config(
            &user,
            &Map::from_iter([("roles".to_owned(), Value::Object(project_roles.clone()))]),
        );
        let user_roles = match raw.get("roles") {
            Some(Value::Object(roles)) => roles.clone(),
            _ => Map::new(),
        };
        let read_only_agents = read_only_agents();
        let no_override = RoleOverride::default();
        let roles = by_flow((self.deps.agents)(cwd))
            .into_iter()
            .map(|definition| {
                let read_only = definition.edits == Some(false);
                let over = user.roles.get(&definition.name).unwrap_or(&no_override);
                let project_over = project_config
                    .roles
                    .get(&definition.name)
                    .unwrap_or(&no_override);
                let fit = role_fit(&definition, project_over);
                let own = candidates_of(&definition, &no_override, &defaults);
                let chosen = candidates_of(&definition, over, &user);
                let candidates = chosen
                    .candidates
                    .into_iter()
                    .map(|RoleCandidate { agent, model }| {
                        let skip = adapter_for(agent).refusal(&fit).or_else(|| {
                            self.deps.usage.as_ref().and_then(|known| {
                                known(agent, model.as_deref(), user.max_used_percent)
                            })
                        });
                        RoleCandidateSetting {
                            agent,
                            model,
                            skip: skip.filter(|skip| !skip.is_empty()),
                        }
                    })
                    .collect();
                let project = sets_role(project_roles.get(&definition.name))
                    .then(|| candidates_of(&definition, project_over, &project_config));
                RoleSettings {
                    changed: sets_role(user_roles.get(&definition.name)),
                    name: definition.name,
                    description: definition.description,
                    read_only,
                    candidates,
                    thinking: chosen.thinking,
                    defaults: own,
                    project,
                }
            })
            .collect();
        Ok(FleetSettings {
            file: file.to_string_lossy().into_owned(),
            roles,
            max_used_percent: user.max_used_percent,
            rate_limit_cooldown_minutes: user.rate_limit_cooldown_minutes,
            max_concurrent: user.max_concurrent,
            close_on_settle: user.close_on_settle,
            language: user.language.unwrap_or_default(),
            projects: user
                .projects
                .into_iter()
                .filter_map(|(path, project)| {
                    project.setup.map(|setup| ProjectSetup { path, setup })
                })
                .collect(),
            read_only_agents,
        })
    }

    /// Writes `patch` into the person's fleet.json and answers the settings after it. Nothing is
    /// written when the patch is refused.
    pub fn update(
        &self,
        cwd: &Path,
        patch: &FleetSettingsPatch,
    ) -> Result<FleetSettings, FleetError> {
        let _writing = self.writing.lock().unwrap_or_else(PoisonError::into_inner);
        let file = self.file();
        let raw = read_user_file(&file)?;
        let next = apply_patch(&raw, patch, &(self.deps.agents)(cwd))?;
        write_user_file(&file, &next).map_err(|error| {
            FleetError::new("internal_error", format!("{}: {error}", file.display()))
        })?;
        self.read(cwd)
    }
}

/// `patch` checked and laid over the file's content. A role's first candidate goes to `agent` and
/// `model`, the rest to `fallbackModels`, each as `<agent>:<model>` so the CLI is named even with no
/// model (`parse_candidate` reads `codex:` as codex's default model).
///
/// What TypeScript checks of the patch's types (a candidate's CLI, a boolean, a thinking level,
/// objects) is checked as the patch is read into its protocol type.
fn apply_patch(
    raw: &Map<String, Value>,
    patch: &FleetSettingsPatch,
    definitions: &[AgentDefinition],
) -> Result<Map<String, Value>, FleetError> {
    let mut next = raw.clone();
    let numbers = [
        patch.max_used_percent,
        patch.rate_limit_cooldown_minutes,
        patch.max_concurrent,
    ];
    for ((key, min, max), value) in LIMITS.into_iter().zip(numbers) {
        let Some(value) = value else { continue };
        if value.fract() != 0.0 || !(min..=max).contains(&value) {
            return Err(invalid(format!(
                "{key} must be a whole number from {min} to {max}"
            )));
        }
        next.insert(key.to_owned(), Value::from(value as i64));
    }
    if let Some(close) = patch.close_on_settle {
        next.insert("closeOnSettle".to_owned(), Value::Bool(close));
    }
    if let Some(language) = &patch.language {
        let language = protocol::js::trim(language);
        if !language.is_empty() && !is_language_name(language) {
            return Err(invalid(
                "language must be a language's name: letters, spaces, hyphens and parentheses, up to 40 characters",
            ));
        }
        if language.is_empty() {
            next.shift_remove("language");
        } else {
            next.insert("language".to_owned(), Value::from(language));
        }
    }
    if let Some(changes) = &patch.roles {
        let mut roles = object(raw.get("roles"));
        for (name, change) in changes {
            let Some(definition) = definitions.iter().find(|each| &each.name == name) else {
                return Err(FleetError::new(
                    "unknown_role",
                    format!("Unknown agent role: {name}"),
                ));
            };
            let mut kept = object(roles.get(name));
            let mut thinking = None;
            for key in ROLE_KEYS {
                let value = kept.shift_remove(key);
                if key == "thinking" {
                    thinking = value;
                }
            }
            let Some(change) = change else {
                if kept.is_empty() {
                    roles.shift_remove(name);
                } else {
                    roles.insert(name.clone(), Value::Object(kept));
                }
                continue;
            };
            // a change that leaves the thinking level out keeps the one set
            if change.thinking.is_none()
                && let Some(thinking) = thinking
            {
                kept.insert("thinking".to_owned(), thinking);
            }
            // the role's other keys, such as `spawning`, stay as the file has them
            let over = RoleOverride {
                spawning: kept.get("spawning").and_then(Value::as_bool),
                ..RoleOverride::default()
            };
            kept.extend(role_entry(
                definition,
                &role_fit(definition, &over),
                change,
            )?);
            roles.insert(name.clone(), Value::Object(kept));
        }
        next.insert("roles".to_owned(), Value::Object(roles));
    }
    if let Some(changes) = &patch.projects {
        let mut projects = object(raw.get("projects"));
        for (path, ProjectPatch { setup }) in changes {
            if !Path::new(path).is_absolute() {
                return Err(invalid(format!(
                    "A project is named by its absolute path: {path}"
                )));
            }
            let setup = protocol::js::trim(setup);
            if protocol::js::utf16_len(setup) > MAX_SETUP_CHARS {
                return Err(invalid(format!(
                    "A setup command is text of up to {MAX_SETUP_CHARS} characters"
                )));
            }
            let key = resolve(Path::new("/"), path).to_string_lossy().into_owned();
            let mut kept = object(projects.get(&key));
            kept.shift_remove("setup");
            if !setup.is_empty() {
                kept.insert("setup".to_owned(), Value::from(setup));
                projects.insert(key, Value::Object(kept));
            } else if !kept.is_empty() {
                projects.insert(key, Value::Object(kept));
            } else {
                projects.shift_remove(&key);
            }
        }
        next.insert("projects".to_owned(), Value::Object(projects));
    }
    Ok(next)
}

/// The keys a role's change writes: its CLI, its first candidate, the rest, and its thinking level.
fn role_entry(
    definition: &AgentDefinition,
    fit: &RoleFit,
    change: &RolePatch,
) -> Result<Map<String, Value>, FleetError> {
    let name = &definition.name;
    if change.candidates.is_empty() || change.candidates.len() > MAX_CANDIDATES {
        return Err(invalid(format!(
            "{name} needs from 1 to {MAX_CANDIDATES} candidates"
        )));
    }
    let mut entries: Vec<String> = Vec::with_capacity(change.candidates.len());
    for RoleCandidate { agent, model } in &change.candidates {
        let model = model.as_deref().unwrap_or("");
        if protocol::js::utf16_len(model) > MAX_MODEL_CHARS
            || model.chars().any(protocol::js::is_whitespace)
        {
            return Err(invalid(format!(
                "A model is a name without spaces, up to {MAX_MODEL_CHARS} characters"
            )));
        }
        // a role that edits no file runs only on a CLI the fleet can keep from editing, and a
        // role that runs the fleet command or reads outside its folders only where it can
        // (ADR 0247-roles-and-config, 0248-launch-adapters)
        let adapter = adapter_for(*agent);
        if let Some(reason) = adapter.refusal(fit) {
            return Err(invalid(
                if fit.read_only && adapter.read_only_args.is_none() {
                    format!("{name} edits no file, and {reason}")
                } else {
                    format!("{name} cannot run on {}: {reason}", agent.name())
                },
            ));
        }
        entries.push(format!("{}:{model}", agent.name()));
    }
    if (1..entries.len()).any(|at| entries[..at].contains(&entries[at])) {
        return Err(invalid("Each candidate may appear once"));
    }
    let mut entry = Map::new();
    entry.insert(
        "agent".to_owned(),
        Value::from(change.candidates[0].agent.name()),
    );
    entry.insert("model".to_owned(), Value::from(entries[0].clone()));
    entry.insert(
        "fallbackModels".to_owned(),
        Value::from(entries[1..].to_vec()),
    );
    if let Some(Some(thinking)) = change.thinking {
        entry.insert(
            "thinking".to_owned(),
            serde_json::to_value(thinking).unwrap_or(Value::Null),
        );
    }
    Ok(entry)
}

fn invalid(message: impl Into<String>) -> FleetError {
    FleetError::new("invalid_settings", message)
}

/// `value` when it is a JSON object, else an empty one.
fn object(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

/// A role entry of a fleet.json sets the candidates or the thinking level.
fn sets_role(entry: Option<&Value>) -> bool {
    matches!(entry, Some(Value::Object(role)) if ROLE_KEYS.iter().any(|key| role.contains_key(*key)))
}

/// What the role asks of the CLI it runs on, with `over` from the person's fleet.json: it edits no
/// file, it runs the fleet command (`may_spawn`), and it reads files outside its folders, which
/// only the reviewer does (ADR 0248-launch-adapters, "断る役割").
fn role_fit(definition: &AgentDefinition, over: &RoleOverride) -> RoleFit {
    RoleFit {
        read_only: definition.edits == Some(false),
        spawning: definition.may_spawn(over),
        reads_outside_folders: definition.name == "reviewer",
    }
}

/// The CLIs a role that edits no file can run on: those the fleet can keep from editing.
fn read_only_agents() -> Vec<FleetAgentKind> {
    KINDS
        .into_iter()
        .filter(|kind| adapter_for(*kind).read_only_args.is_some())
        .collect()
}

/// The roles in `ROLE_FLOW`'s order, then the others by name: the folders are read in no fixed order.
fn by_flow(mut definitions: Vec<AgentDefinition>) -> Vec<AgentDefinition> {
    let rank = |name: &str| {
        ROLE_FLOW
            .iter()
            .position(|each| *each == name)
            .unwrap_or(ROLE_FLOW.len())
    };
    definitions.sort_by(|a, b| {
        rank(&a.name)
            .cmp(&rank(&b.name))
            .then_with(|| locale_compare(&a.name, &b.name))
    });
    definitions
}

/// A role's candidates in the order the orchestrator tries them (its `spawn_with_fallbacks`): the
/// primary model, then the fallbacks other than it, each read with the role's CLI as the default.
fn candidates_of(
    definition: &AgentDefinition,
    over: &RoleOverride,
    config: &FleetConfig,
) -> RoleCandidates {
    let kind = over.agent.unwrap_or(definition.agent);
    let primary = over
        .model
        .as_deref()
        .or(definition.model.as_deref())
        .or(config.default_model.as_deref());
    let fallbacks = over
        .fallback_models
        .as_deref()
        .or(definition.fallback_models.as_deref())
        .unwrap_or_default();
    let candidates = role_candidates(kind, primary, fallbacks)
        .into_iter()
        .map(|each| RoleCandidate {
            agent: each.agent,
            model: each.model.filter(|model| !model.is_empty()),
        })
        .collect();
    RoleCandidates {
        candidates,
        thinking: over
            .thinking
            .or(definition.thinking)
            .or(config.default_thinking),
    }
}

/// The person's fleet.json as written; none yet is an empty one. One that is not a JSON object is
/// not overwritten. Unlike `JSON.parse`, serde_json refuses a number past f64 and an unpaired
/// surrogate escape, and such a file is unreadable here (ADR 0260-settings-store, "読む形").
fn read_user_file(file: &Path) -> Result<Map<String, Value>, FleetError> {
    let unreadable = |message: String| FleetError::new("settings_unreadable", message);
    let bytes = match fs::read(file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => {
            return Err(unreadable(format!(
                "Cannot read {}: {error}",
                file.display()
            )));
        }
    };
    match serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(unreadable(format!(
            "{} is not a JSON object. Fix it by hand, then change settings here.",
            file.display()
        ))),
        Err(error) => Err(unreadable(format!(
            "{} is not valid JSON ({error}). Fix it by hand, then change settings here.",
            file.display()
        ))),
    }
}

/// The project's fleet.json's roles; one that cannot be read sets none.
fn read_roles(file: &Path) -> Map<String, Value> {
    let parsed = fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)).ok());
    match parsed {
        Some(Value::Object(mut map)) => match map.shift_remove("roles") {
            Some(Value::Object(roles)) => roles,
            _ => Map::new(),
        },
        _ => Map::new(),
    }
}

/// Written to a file beside it and renamed over it: a crash leaves the old file or the new, never
/// half of one. The text is `JSON.stringify(raw, null, 2)` and a newline, as TypeScript writes it.
fn write_user_file(file: &Path, raw: &Map<String, Value>) -> io::Result<()> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let mut temp = file.as_os_str().to_owned();
    temp.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, AtomicOrdering::Relaxed)
    ));
    let temp = PathBuf::from(temp);
    let text = format!(
        "{}\n",
        protocol::js::stringify_pretty(&Value::Object(raw.clone()))
    );
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options
        .open(&temp)
        .and_then(|mut opened| opened.write_all(text.as_bytes()))
        .and_then(|()| fs::rename(&temp, file));
    // each write names its own temporary file, so a failed one would stay
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}
