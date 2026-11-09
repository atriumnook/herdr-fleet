//! Roles: the bundled, the person's and the project's role files; from `server/fleet/agents.ts`.
//!
//! A role file is `---\n<YAML>\n---\n<body>`: the frontmatter says how the role runs, the body is
//! what its agent is told to be. The frontmatter is read as Bun 1.4.4's `Bun.YAML.parse` reads it
//! (YAML 1.2's core schema), with saphyr (ADR 0247-roles-and-config).

use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use indexmap::IndexMap;
use protocol::{FleetAgentKind, ThinkingLevel};
use regex::Regex;
use saphyr::{Scalar, ScalarStyle, Tag, Yaml, YamlLoader};
use serde::Serialize;
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

use crate::config::{RoleOverride, agent_kind, find_project_path, parse_thinking_level};

/// Where a role file came from; a later one of the same name replaces an earlier one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RoleSource {
    Project,
    User,
    Bundled,
}

impl RoleSource {
    /// The name `/api/fleet/roles` and the event log write: `"bundled"`, `"user"` or `"project"`.
    pub fn as_str(self) -> &'static str {
        match self {
            RoleSource::Project => "project",
            RoleSource::User => "user",
            RoleSource::Bundled => "bundled",
        }
    }
}

/// A role: what an agent is told to be (the markdown body) and how it runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentDefinition {
    pub name: String,
    pub description: String,
    /// Which agent CLI plays the role; pi when the file names none.
    pub agent: FleetAgentKind,
    pub model: Option<String>,
    pub thinking: Option<ThinkingLevel>,
    pub fallback_models: Option<Vec<String>>,
    /// The agent CLI's own tool names, for the CLIs that take a list (pi).
    pub tools: Option<Vec<String>>,
    pub system_prompt: String,
    pub worktree: Option<bool>,
    pub interactive: Option<bool>,
    pub spawning: Option<bool>,
    /// False: the role edits no file, and only a CLI that can be held to that plays it.
    pub edits: Option<bool>,
    pub source: RoleSource,
    pub file_path: PathBuf,
    /// The version of the role file: `content_hash` of its text; none on a role built in code.
    pub hash: Option<String>,
}

impl AgentDefinition {
    /// Whether a run of this role may start agents of its own, before the depth limit: fleet.json's
    /// `roles.<name>.spawning`, else the role file's, else false (`orchestrator.ts:500`). A role
    /// that may start agents is told to run the fleet command (`fleet spawn`, `fleet wait`).
    pub fn may_spawn(&self, over: &RoleOverride) -> bool {
        over.spawning.or(self.spawning).unwrap_or(false)
    }
}

/// The folders of the bundled and the person's roles; the project's is found from the work's folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentDirs {
    pub bundled: PathBuf,
    pub user: PathBuf,
}

impl AgentDirs {
    /// The bundled roles, and the person's in `<user_fleet_dir>/agents` (see `config::user_fleet_dir`).
    pub fn new(user_fleet_dir: &Path) -> Self {
        AgentDirs {
            bundled: bundled_agents_dir(),
            user: user_fleet_dir.join("agents"),
        }
    }
}

/// Which role file, in which version, a run is told to be: what the fleet records when the run starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RoleVersion {
    pub role: String,
    pub source: RoleSource,
    pub file: PathBuf,
    pub hash: String,
}

/// The roles that ship with the fleet: `agents/` at the repository's root. As ADR
/// 0242-phase-3-split places fleet-guard, the folder is found from this crate's folder when it is
/// built (`CARGO_MANIFEST_DIR`, three folders below the root); where a packaged build keeps it is
/// decided in phase 6.
pub fn bundled_agents_dir() -> PathBuf {
    // folded, as TypeScript's `path.resolve`, so the role files' paths have no `..`
    crate::config::normalize(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../agents"))
}

/// Bundled roles, then the person's, then the project's (the nearest `.herdr-fleet/agents` from
/// `cwd` up): a later one of the same name, in any case, wins and takes the earlier one's place in
/// the list. Each folder's files are read in the order of their names. A file that cannot be read
/// or parsed is skipped with a warning, so one broken role file does not hide the others.
pub fn discover_agents(
    cwd: &Path,
    warnings: &mut Vec<String>,
    dirs: &AgentDirs,
) -> Vec<AgentDefinition> {
    let mut roles: IndexMap<String, AgentDefinition> = IndexMap::new();
    let project = find_project_path(cwd, "agents");
    let folders = [
        (Some(dirs.bundled.clone()), RoleSource::Bundled),
        (Some(dirs.user.clone()), RoleSource::User),
        (project, RoleSource::Project),
    ];
    for (folder, source) in folders {
        let Some(folder) = folder else { continue };
        for role in load_dir(&folder, source, warnings) {
            roles.insert(role.name.to_lowercase(), role);
        }
    }
    roles.into_values().collect()
}

/// The first 12 hex digits of the sha256 of `text`'s UTF-8 bytes: a version of a role file or of
/// the standing orders.
pub fn content_hash(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Which role file, in which version, a run is told to be.
pub fn role_version(definition: &AgentDefinition) -> RoleVersion {
    RoleVersion {
        role: definition.name.clone(),
        source: definition.source,
        file: definition.file_path.clone(),
        hash: definition
            .hash
            .clone()
            .unwrap_or_else(|| content_hash(&definition.system_prompt)),
    }
}

/// The role of that name, in any case.
pub fn find_agent<'a>(agents: &'a [AgentDefinition], role: &str) -> Option<&'a AgentDefinition> {
    let role = role.to_lowercase();
    agents
        .iter()
        .find(|agent| agent.name.to_lowercase() == role)
}

/// The role files of one folder: the `.md` files and links, by name. A missing folder has none.
fn load_dir(folder: &Path, source: RoleSource, warnings: &mut Vec<String>) -> Vec<AgentDefinition> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut files: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter(|entry| {
            entry
                .file_type()
                .is_ok_and(|kind| kind.is_file() || kind.is_symlink())
        })
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            name.ends_with(".md").then(|| (name, entry.path()))
        })
        .collect();
    files.sort();
    files
        .into_iter()
        .filter_map(|(name, file)| match load_role(&name, &file, source) {
            Ok(role) => Some(role),
            Err(error) => {
                warnings.push(format!(
                    "fleet: skipping invalid role file {}: {error}",
                    file.display()
                ));
                None
            }
        })
        .collect()
}

fn load_role(name: &str, file: &Path, source: RoleSource) -> Result<AgentDefinition, String> {
    let bytes = fs::read(file).map_err(|error| error.to_string())?;
    // invalid UTF-8 reads as U+FFFD, as Node's `readFileSync(file, "utf8")`
    let text = String::from_utf8_lossy(&bytes);
    let (frontmatter, body) = parse_frontmatter(&text)?;
    let field = |key: &str| frontmatter.get(key);
    let text_of = |key: &str| field(key).and_then(Value::as_str).map(str::to_owned);
    let flag = |key: &str| field(key).and_then(Value::as_bool);
    let name =
        text_of("name").unwrap_or_else(|| name.strip_suffix(".md").unwrap_or(name).to_owned());
    let agent = match field("agent") {
        None => FleetAgentKind::Pi,
        Some(value) => value
            .as_str()
            .and_then(agent_kind)
            .ok_or_else(|| format!("unknown agent {value}"))?,
    };
    Ok(AgentDefinition {
        description: text_of("description").unwrap_or_else(|| name.clone()),
        agent,
        model: text_of("model"),
        thinking: field("thinking").and_then(parse_thinking_level),
        fallback_models: field("fallbackModels").and_then(parse_list),
        tools: field("tools").and_then(parse_list),
        worktree: flag("worktree"),
        interactive: flag("interactive"),
        spawning: flag("spawning"),
        edits: flag("edits"),
        system_prompt: protocol::js::trim(body).to_owned(),
        source,
        file_path: file.to_path_buf(),
        hash: Some(content_hash(&text)),
        name,
    })
}

/// A list in a role file: a YAML list, or a comma-separated string; each string trimmed, empty
/// ones and other values dropped, none when nothing is left.
fn parse_list(value: &Value) -> Option<Vec<String>> {
    let items: Vec<&str> = match value {
        Value::Array(items) => items.iter().filter_map(Value::as_str).collect(),
        Value::String(text) => text.split(',').collect(),
        _ => Vec::new(),
    };
    let items: Vec<String> = items
        .into_iter()
        .map(protocol::js::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect();
    (!items.is_empty()).then_some(items)
}

/// `---\n<yaml>\n---\n<body>`: the frontmatter as a JSON object and the body; a file without
/// frontmatter is all body. The frontmatter has to be a mapping or empty.
fn parse_frontmatter(text: &str) -> Result<(Map<String, Value>, &str), String> {
    static FENCE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\A---\r?\n((?s:.*?))\r?\n---\r?\n?").expect("the frontmatter pattern compiles")
    });
    let Some(found) = FENCE.captures(text) else {
        return Ok((Map::new(), text));
    };
    let whole = found.get(0).expect("a match has group 0");
    let yaml = found.get(1).map_or("", |group| group.as_str());
    match parse_yaml(yaml)? {
        Value::Object(map) => Ok((map, &text[whole.end()..])),
        Value::Null => Ok((Map::new(), &text[whole.end()..])),
        _ => Err("frontmatter must be a mapping".to_owned()),
    }
}

/// The YAML text's single document as JSON, as `Bun.YAML.parse` returns it: none for an empty
/// text, an array for several documents, a repeated key's last value. The one place saphyr is
/// read, so another YAML crate changes this function alone.
fn parse_yaml(text: &str) -> Result<Value, String> {
    let mut loader: YamlLoader<'_, Yaml<'_>> = YamlLoader::default();
    loader.allow_duplicate_keys(true);
    // scalars are typed below, as Bun types them, from their text, style and tag
    loader.early_parse(false);
    let mut parser = saphyr_parser::Parser::new_from_str(text);
    parser
        .load(&mut loader, true)
        .map_err(|error| error.to_string())?;
    if let Some(error) = loader.error() {
        return Err(error.to_string());
    }
    let mut documents: Vec<Value> = loader.into_documents().iter().map(to_json).collect();
    Ok(match documents.len() {
        0 => Value::Null,
        1 => documents.remove(0),
        _ => Value::Array(documents),
    })
}

/// A YAML node as the JSON value Bun gives: keys as strings, numbers JSON cannot hold (`.inf`,
/// `.nan`) as null, a tagged collection as its value, a merge key (`<<`, quoted or not) expanded
/// with the mapping's own keys winning and an earlier merged mapping winning over a later one. No
/// role file field reads a number, so the numbers' exact text does not matter.
fn to_json(node: &Yaml<'_>) -> Value {
    match node {
        Yaml::Representation(text, style, tag) => {
            scalar_to_json(&scalar(text, *style, tag.as_deref()))
        }
        Yaml::Value(value) => scalar_to_json(value),
        Yaml::Sequence(items) => Value::Array(items.iter().map(to_json).collect()),
        Yaml::Mapping(entries) => {
            let mut own = Map::new();
            let mut merged = Vec::new();
            for (key, value) in entries {
                let key = key_text(key);
                match (key.as_ref(), to_json(value)) {
                    ("<<", Value::Object(map)) => merged.push(map),
                    ("<<", Value::Array(items)) if items.iter().all(Value::is_object) => {
                        merged.extend(items.into_iter().filter_map(|item| match item {
                            Value::Object(map) => Some(map),
                            _ => None,
                        }));
                    }
                    (_, value) => {
                        own.insert(key.into_owned(), value);
                    }
                }
            }
            for (key, value) in merged.into_iter().flatten() {
                own.entry(key).or_insert(value);
            }
            Value::Object(own)
        }
        Yaml::Tagged(_, node) => to_json(node),
        Yaml::Alias(_) | Yaml::BadValue => Value::Null,
    }
}

/// A scalar typed as Bun 1.4.4 types it: a quoted or block scalar is a string whatever its tag; a
/// plain one is read by YAML 1.2's core schema when it has no tag or `!!bool`, `!!int`, `!!float`
/// or `!!null` (empty and untagged: null), and is a string under any other tag (`!!str 1` is
/// `"1"`, `!foo true` is `"true"`).
fn scalar<'a>(text: &Cow<'a, str>, style: ScalarStyle, tag: Option<&Tag>) -> Scalar<'a> {
    if style != ScalarStyle::Plain {
        return Scalar::String(text.clone());
    }
    match tag {
        None if text.is_empty() => Scalar::Null,
        None => Scalar::parse_from_cow(text.clone()),
        Some(tag)
            if tag.is_yaml_core_schema()
                && matches!(tag.suffix.as_str(), "bool" | "int" | "float" | "null") =>
        {
            Scalar::parse_from_cow(text.clone())
        }
        Some(_) => Scalar::String(text.clone()),
    }
}

fn scalar_to_json(scalar: &Scalar<'_>) -> Value {
    match scalar {
        Scalar::Null => Value::Null,
        Scalar::Boolean(flag) => Value::Bool(*flag),
        Scalar::Integer(number) => Value::from(*number),
        Scalar::FloatingPoint(number) => {
            Number::from_f64(number.into_inner()).map_or(Value::Null, Value::Number)
        }
        Scalar::String(text) => Value::String(text.to_string()),
    }
}

/// A mapping key as JavaScript's object key, `String()` of the value as Bun 1.4.4 gives it: a
/// string as it is; a sequence its items joined with `,`, a null item as nothing; a mapping
/// `[object Object]`. No role file field is named by a number, so a number's exact text does not
/// matter (JSON's is used).
fn key_text<'a>(key: &'a Yaml<'_>) -> Cow<'a, str> {
    match key {
        Yaml::Representation(text, _, _) | Yaml::Value(Scalar::String(text)) => Cow::Borrowed(text),
        other => Cow::Owned(js_string(&to_json(other))),
    }
}

/// JavaScript's `String(value)` of a JSON value.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                item => js_string(item),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
        Value::Null | Value::Bool(_) | Value::Number(_) => value.to_string(),
    }
}
