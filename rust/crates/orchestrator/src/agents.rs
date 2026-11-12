//! Roles: the bundled, the person's and the project's role files; from `server/fleet/agents.ts`.
//!
//! A role file is `---\n<YAML>\n---\n<body>`: the frontmatter says how the role runs, the body is
//! what its agent is told to be. The frontmatter is read as Bun 1.4.4's `Bun.YAML.parse` reads it
//! (YAML 1.2's core schema), with saphyr (ADR 0247-roles-and-config).

use std::borrow::Cow;
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::LazyLock;

use indexmap::IndexMap;
use protocol::{FleetAgentKind, ThinkingLevel};
use regex::Regex;
use saphyr::{Scalar, ScalarStyle, Tag};
use saphyr_parser::Event;
use serde::Serialize;
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

use crate::config::{RoleOverride, agent_kind, find_project_path, parse_thinking_level};
use crate::launch::RoleFit;

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

    /// What the role asks of the CLI it runs on, with `over` from fleet.json (ADR 0248-launch-adapters,
    /// "断る役割"): it edits no file (`edits: false`), it runs the fleet command (`may_spawn`), and it
    /// reads files outside its folders, which only the reviewer does: the role file has no key for that
    /// yet, so the role is known by its name. The settings store and the choice of candidates both ask
    /// this, so the rule lives here once.
    pub fn role_fit(&self, over: &RoleOverride) -> RoleFit {
        RoleFit {
            read_only: self.edits == Some(false),
            spawning: self.may_spawn(over),
            reads_outside_folders: self.name == "reviewer",
        }
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
/// read, so another YAML crate changes this function and [`Tree`] alone.
fn parse_yaml(text: &str) -> Result<Value, String> {
    let mut tree = Tree::default();
    // events are pulled, not pushed through `Parser::load`, which recurses once per nested
    // collection and overflows the stack on deep block nesting before the tree can stop it
    for event in saphyr_parser::Parser::new_from_str(text) {
        let (event, _) = event.map_err(|error| error.to_string())?;
        tree.on_event(event);
        // the tree's documents are partial once it fails
        if let Some(error) = tree.error {
            return Err(error);
        }
    }
    let mut documents: Vec<Value> = tree.documents.iter().map(to_json).collect();
    Ok(match documents.len() {
        0 => Value::Null,
        1 => documents.remove(0),
        _ => Value::Array(documents),
    })
}

/// A YAML node before Bun's rules make it JSON. saphyr's own `Yaml` keeps one entry of equal keys,
/// but Bun expands every merge key of a mapping (`<<: {a: 1}` then `<<: {b: 2}` gives both), so a
/// mapping here is built from all its entries ([`mapping`]). A collection's tag is dropped: Bun
/// reads a tagged collection as its value. A collection is shared, not copied, by the anchor that
/// names it and by each alias that reads it again, so neither takes memory for its items; only
/// [`to_json`] writes an alias's items out, within the alias budget.
#[derive(Clone)]
enum Node<'a> {
    /// The scalar's text, untyped: it is typed as Bun types it from its style and tag.
    Scalar(Cow<'a, str>, ScalarStyle, Option<Cow<'a, Tag>>),
    Sequence(Rc<Vec<Node<'a>>>),
    /// Each key as JavaScript's object key, set when the mapping ends ([`mapping`]), so a merge
    /// copies a key as one string, never the collection it was written as.
    Mapping(Rc<Vec<(String, Node<'a>)>>),
    /// An empty document.
    Null,
}

impl Node<'_> {
    /// The collections nested in the node, itself included.
    fn depth(&self) -> usize {
        match self {
            Node::Sequence(items) => 1 + items.iter().map(Node::depth).max().unwrap_or(0),
            Node::Mapping(entries) => {
                1 + entries
                    .iter()
                    .map(|(_, value)| value.depth())
                    .max()
                    .unwrap_or(0)
            }
            Node::Scalar(..) | Node::Null => 0,
        }
    }

    /// Takes the node's size from `budget` as saphyr's loader counts it (one for the node and one
    /// for each entry of a mapping, its key included); false once the budget runs out. A mapping
    /// holds its keys as Bun reads them ([`mapping`]): strings, a repeated key once, merge keys
    /// expanded. Without merge keys the count is no larger than saphyr's, and it is every node an
    /// alias adds to [`to_json`]'s value. A scalar counts as one node whatever its length, as in
    /// saphyr.
    fn take_size(&self, budget: &mut usize) -> bool {
        let Some(left) = budget.checked_sub(1) else {
            return false;
        };
        *budget = left;
        match self {
            Node::Sequence(items) => items.iter().all(|item| item.take_size(budget)),
            Node::Mapping(entries) => entries
                .iter()
                .all(|(_, value)| Node::Null.take_size(budget) && value.take_size(budget)),
            Node::Scalar(..) | Node::Null => true,
        }
    }
}

/// The collections one node may sit in, itself included. Every function on [`Node`] recurses,
/// so a deeper file (block nesting has no limit in saphyr-parser, flow nesting stops at 255)
/// would overflow the stack and abort the process instead of failing to read.
const MAX_DEPTH: usize = 256;

fn too_deep() -> String {
    format!("collections nested deeper than {MAX_DEPTH} levels")
}

/// The nodes aliases may add to the JSON value in one load, as saphyr's loader allows by default:
/// each alias writes out the anchored node again, so nested anchors can grow exponentially (ADR
/// 0279's table).
const ALIAS_BUDGET: usize = 100_000;

/// Builds [`Node`]s from saphyr-parser's events, as saphyr's `YamlLoader` builds its `Yaml` but
/// keeping a mapping's repeated keys.
struct Tree<'a> {
    open: Vec<(Open<'a>, usize)>,
    anchors: HashMap<usize, Node<'a>>,
    documents: Vec<Node<'a>>,
    /// The document's root once its last event is in.
    root: Option<Node<'a>>,
    alias_budget: usize,
    error: Option<String>,
}

/// A collection whose end event has not come yet.
enum Open<'a> {
    Sequence(Vec<Node<'a>>),
    /// The entries so far and a key waiting for its value.
    Mapping(Vec<(Node<'a>, Node<'a>)>, Option<Node<'a>>),
}

impl Default for Tree<'_> {
    fn default() -> Self {
        Tree {
            open: Vec::new(),
            anchors: HashMap::new(),
            documents: Vec::new(),
            root: None,
            alias_budget: ALIAS_BUDGET,
            error: None,
        }
    }
}

impl<'a> Tree<'a> {
    /// Takes the parser's next event; on a failure it sets `error` and the tree is not to be read.
    fn on_event(&mut self, event: Event<'a>) {
        match event {
            Event::Scalar(text, style, anchor, tag) => {
                self.add(Node::Scalar(text, style, tag), anchor)
            }
            Event::SequenceStart(..) | Event::MappingStart(..) if self.open.len() >= MAX_DEPTH => {
                self.error = Some(too_deep());
            }
            Event::SequenceStart(anchor, _) => self.open.push((Open::Sequence(Vec::new()), anchor)),
            Event::MappingStart(anchor, _) => {
                self.open.push((Open::Mapping(Vec::new(), None), anchor));
            }
            Event::SequenceEnd | Event::MappingEnd => {
                let (open, anchor) = self
                    .open
                    .pop()
                    .expect("the parser ends only what it started");
                let node = match open {
                    Open::Sequence(items) => Node::Sequence(Rc::new(items)),
                    Open::Mapping(entries, _) => mapping(entries),
                };
                self.add(node, anchor);
            }
            Event::Alias(anchor) => {
                // the parser fails on an unknown anchor, so a missing one is not reached
                let node = match self.anchors.get(&anchor) {
                    // measured before it is read again, so `to_json` never writes out more than the budget
                    Some(node) if !node.take_size(&mut self.alias_budget) => {
                        self.error = Some(
                            "alias expansion exceeded the maximum node budget (possible billion-laughs attack)"
                                .to_owned(),
                        );
                        return;
                    }
                    Some(node) if self.open.len() + node.depth() > MAX_DEPTH => {
                        self.error = Some(too_deep());
                        return;
                    }
                    Some(node) => node.clone(),
                    None => Node::Null,
                };
                self.add(node, 0);
            }
            Event::DocumentEnd => {
                let root = self.root.take().unwrap_or(Node::Null);
                self.documents.push(root);
            }
            Event::Nothing | Event::StreamStart | Event::StreamEnd | Event::DocumentStart(_) => {}
        }
    }
}

/// A mapping as Bun reads it, built when the mapping ends so that an alias copies and counts only
/// what Bun reads. A repeated key (by its JavaScript string) keeps its first place and its last
/// value. Each merge key (`<<`, quoted or not, or through an alias) whose value is a mapping or a
/// sequence is expanded, the sequence's items that are not mappings dropped, with the mapping's own
/// keys winning and an earlier merged mapping winning over a later one; with any other value it is
/// the ordinary key `<<`. The mappings merged were built the same way, so the result holds no merge
/// key to expand.
fn mapping<'a>(entries: Vec<(Node<'a>, Node<'a>)>) -> Node<'a> {
    let mut kept: Vec<(String, Node<'a>)> = Vec::with_capacity(entries.len());
    let mut places: HashMap<String, usize> = HashMap::new();
    let mut merged = Vec::new();
    for (key, value) in entries {
        let value = match (is_merge_key(&key), value) {
            (true, Node::Mapping(items)) => {
                merged.extend(items.iter().cloned());
                continue;
            }
            (true, Node::Sequence(items)) => {
                for item in items.iter() {
                    if let Node::Mapping(items) = item {
                        merged.extend(items.iter().cloned());
                    }
                }
                continue;
            }
            (_, value) => value,
        };
        let key = key_text(&key).into_owned();
        match places.entry(key.clone()) {
            Entry::Occupied(place) => kept[*place.get()].1 = value,
            Entry::Vacant(place) => {
                place.insert(kept.len());
                kept.push((key, value));
            }
        }
    }
    for (key, value) in merged {
        if let Entry::Vacant(place) = places.entry(key.clone()) {
            place.insert(kept.len());
            kept.push((key, value));
        }
    }
    Node::Mapping(Rc::new(kept))
}

impl<'a> Tree<'a> {
    /// Puts a finished node in its collection, or makes it the document's root.
    fn add(&mut self, node: Node<'a>, anchor: usize) {
        // the parser numbers anchors from 1
        if anchor > 0 {
            self.anchors.insert(anchor, node.clone());
        }
        match self.open.last_mut() {
            None => self.root = Some(node),
            Some((Open::Sequence(items), _)) => items.push(node),
            Some((Open::Mapping(_, key @ None), _)) => *key = Some(node),
            Some((Open::Mapping(entries, key @ Some(_)), _)) => {
                let key = key.take().expect("matched as some");
                entries.push((key, node));
            }
        }
    }
}

/// A YAML node as the JSON value Bun gives: keys as strings, numbers JSON cannot hold (`.inf`,
/// `.nan`) as null. A mapping's merge keys and repeated keys were settled when it was built
/// ([`mapping`]). No role file field reads a number, so the numbers' exact text does not matter.
fn to_json(node: &Node<'_>) -> Value {
    match node {
        Node::Scalar(text, style, tag) => scalar_to_json(&scalar(text, *style, tag.as_deref())),
        Node::Sequence(items) => Value::Array(items.iter().map(to_json).collect()),
        Node::Mapping(entries) => Value::Object(
            entries
                .iter()
                .map(|(key, value)| (key.clone(), to_json(value)))
                .collect(),
        ),
        Node::Null => Value::Null,
    }
}

/// Whether the YAML key itself is the scalar `<<`, whatever its style and tag. A collection such as
/// `[<<]` becomes the same JavaScript object key after string conversion, but Bun treats it as an
/// ordinary key.
fn is_merge_key(key: &Node<'_>) -> bool {
    matches!(key, Node::Scalar(text, _, _) if text == "<<")
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
fn key_text<'a>(key: &'a Node<'_>) -> Cow<'a, str> {
    match key {
        Node::Scalar(text, _, _) => Cow::Borrowed(text),
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
