//! The agent adapters: each CLI's arguments, environment and settings; from `server/fleet/adapters.ts`, `server/fleet/opencode-config.ts`.
//!
//! What differs between agent CLIs at launch lives here, so the orchestrator stays apart from the
//! kind: the argv after the executable for herdr's `agent.start`, the pane's environment, the
//! arguments and note for a role that edits nothing, and the roles a CLI cannot take. How each CLI
//! looks on its screen is the screen crate's: callers use `screen::screen_checks(kind)`. The adapter
//! knows no role by name: the orchestrator turns a role into the facts of `RoleFit`.
//! The CLIs' model lists are not here: the models module holds them (ADR 0242-phase-3-split).

pub mod agy;
mod claude;
mod codex;
mod cursor;
pub mod opencode;
mod pi;

use std::collections::BTreeMap;
use std::path::PathBuf;

use protocol::{FleetAgentKind, ThinkingLevel};

use crate::FleetError;

/// How an agent is launched (`LaunchOptions`).
#[derive(Debug, Clone, Copy)]
pub struct LaunchOptions<'a> {
    pub model: Option<&'a str>,
    pub thinking: Option<ThinkingLevel>,
    /// the role's tool list, in this CLI's own tool names
    pub tools: &'a [String],
    /// shown as the session's name where the CLI has one
    pub name: &'a str,
    /// a file holding the role and fleet instructions: herdr refuses multiline argv, so it never goes inline
    pub system_prompt_file: &'a str,
    /// the same instructions as text, for a CLI that takes them in a config value (codex)
    pub system_prompt: &'a str,
    /// the run's result folder: outside the workspace, so a CLI that confines writes is told it may write there
    pub result_dir: &'a str,
    /// the folder the agent works in (a thread's worktree), for a CLI that trusts folders one path at a time
    pub cwd: &'a str,
}

/// What the fleet knows when it creates a pane, before the agent starts in it (`PaneContext`).
#[derive(Debug, Clone, Copy)]
pub struct PaneContext<'a> {
    /// this run's result folder
    pub result_dir: &'a str,
    /// the shell command that runs the fleet CLI
    pub fleet_command: &'a str,
    /// the model as the setting names it, a `:level` suffix included
    pub model: Option<&'a str>,
    /// the role edits no file
    pub read_only: bool,
    /// the role merges for the person (the project's coordinator)
    pub merges: bool,
    /// what the adapters read from the fleet server's process
    pub host: &'a Host,
}

/// What the adapters read from the fleet server's process rather than from a run: the server's own
/// `GIT_CONFIG_*` (TypeScript reads `process.env`) and the guard plugin's folder. Built once at
/// startup with `from_process`; nothing else of the environment is kept, so it holds no secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Host {
    git_config: BTreeMap<String, String>,
    guard_plugin: PathBuf,
}

impl Host {
    /// `git_config`: the server's `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`
    /// (other variables are ignored); `guard_plugin`: the guard plugin's folder.
    pub fn new(git_config: BTreeMap<String, String>, guard_plugin: PathBuf) -> Self {
        let git_config = git_config
            .into_iter()
            .filter(|(name, _)| is_git_config(name))
            .collect();
        Host {
            git_config,
            guard_plugin,
        }
    }

    /// This process's `GIT_CONFIG_*` (a value that is not UTF-8 is left out, as if unset) and
    /// `opencode::guard_plugin_dir()`, the checkout the crate was built in: a binary moved to another
    /// machine, or built in a worktree since removed, finds no guard there (where a packaged build
    /// keeps it is phase 6's, ADR 0242-phase-3-split).
    pub fn from_process() -> Self {
        let git_config = std::env::vars_os()
            .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
            .collect();
        Host::new(git_config, opencode::guard_plugin_dir())
    }
}

fn is_git_config(name: &str) -> bool {
    name == "GIT_CONFIG_COUNT"
        || name.starts_with("GIT_CONFIG_KEY_")
        || name.starts_with("GIT_CONFIG_VALUE_")
}

/// What a role asks of the CLI it runs on, for the roles a CLI cannot take. The orchestrator fills it
/// from the role's definition.
#[derive(Debug, Clone, Copy, Default)]
pub struct RoleFit {
    /// the role edits no file (`edits: false`)
    pub read_only: bool,
    /// the role may start agents (lead, coordinator): it runs the fleet command
    pub spawning: bool,
    /// the role is asked to read files outside its folders, such as the standing orders' skills (the
    /// reviewer, #190)
    pub reads_outside_folders: bool,
}

/// What differs between agent CLIs at launch (`AgentAdapter`, its launch part); one per kind.
#[derive(Clone, Copy)]
pub struct Adapter {
    pub kind: FleetAgentKind,
    /// the CLI takes no instructions at launch: they lead the first prompt instead
    pub instructions_in_prompt: bool,
    /// argv that takes the CLI's file-editing tools away, for a role that edits nothing; `None` where
    /// the CLI cannot be held to that
    pub read_only_args: Option<&'static [&'static str]>,
    /// under `read_only_args` the CLI's editing tool stays on for the result file alone, so a shell
    /// command to write it is not needed (and would be asked)
    pub read_only_edits_result: bool,
    /// what to tell every agent on this CLI, whatever its role: a limit of the CLI the agent would
    /// otherwise spend its turn finding out
    pub note: Option<&'static str>,
    /// what to type into a settled CLI to show its usage, for a CLI that tells it no other way (cursor)
    pub usage_command: Option<&'static str>,
    /// the agent can run the fleet command (agy's terminal sandbox hides it)
    pub runs_fleet_command: bool,
    /// the CLI stops at a question before it reads a file outside its folders, whatever its mode (agy)
    pub asks_before_outside_reads: bool,
    launch_args: fn(&LaunchOptions<'_>) -> Vec<String>,
    env: fn(&PaneContext<'_>) -> Result<BTreeMap<String, String>, FleetError>,
    read_only_note: Option<fn(bool, &str) -> String>,
}

impl Adapter {
    /// argv after the executable, for herdr's `agent.start`
    pub fn launch_args(&self, options: &LaunchOptions<'_>) -> Vec<String> {
        (self.launch_args)(options)
    }

    /// environment variables for the pane the CLI starts in (herdr's `agent.start` takes none);
    /// empty for a CLI configured otherwise. An error is a start that must not happen.
    pub fn env(&self, context: &PaneContext<'_>) -> Result<BTreeMap<String, String>, FleetError> {
        (self.env)(context)
    }

    /// what to tell a role that edits nothing, for a CLI that refuses the commands it may not run
    /// without saying which it may
    pub fn read_only_note(&self, merges: bool, fleet_command: &str) -> Option<String> {
        self.read_only_note.map(|note| note(merges, fleet_command))
    }

    /// Why this CLI cannot take the role, if it cannot: a role that edits nothing on a CLI that cannot
    /// be held to it (worded as TypeScript's candidate loop words it, orchestrator.ts:461), a role
    /// that runs the fleet command where the agent cannot (#189's 8), and a role asked to read files
    /// outside its folders on a CLI that stops to ask before each (#190).
    pub fn refusal(&self, role: &RoleFit) -> Option<String> {
        let kind = kind_name(self.kind);
        if role.read_only && self.read_only_args.is_none() {
            Some(format!("{kind} cannot be kept from editing files"))
        } else if role.spawning && !self.runs_fleet_command {
            Some(format!(
                "{kind} cannot run the fleet command, which this role uses"
            ))
        } else if role.reads_outside_folders && self.asks_before_outside_reads {
            Some(format!(
                "{kind} asks before it reads each file outside its folders, which this role reads"
            ))
        } else {
            None
        }
    }
}

/// The adapter of `kind` (`adapterFor`).
pub fn adapter_for(kind: FleetAgentKind) -> &'static Adapter {
    match kind {
        FleetAgentKind::Pi => &pi::ADAPTER,
        FleetAgentKind::Claude => &claude::ADAPTER,
        FleetAgentKind::Codex => &codex::ADAPTER,
        FleetAgentKind::Cursor => &cursor::ADAPTER,
        FleetAgentKind::Agy => &agy::ADAPTER,
        FleetAgentKind::Opencode => &opencode::ADAPTER,
    }
}

/// The kind as herdr and the settings name it: `FleetAgentKind`'s own serde name.
fn kind_name(kind: FleetAgentKind) -> String {
    match serde_json::to_value(kind) {
        Ok(serde_json::Value::String(name)) => name,
        _ => format!("{kind:?}"),
    }
}

/// A level as a `:level` suffix spells it; the match keeps every level of `ThinkingLevel` named.
fn name_of(level: ThinkingLevel) -> &'static str {
    match level {
        ThinkingLevel::Off => "off",
        ThinkingLevel::Minimal => "minimal",
        ThinkingLevel::Low => "low",
        ThinkingLevel::Medium => "medium",
        ThinkingLevel::High => "high",
        ThinkingLevel::Xhigh => "xhigh",
        ThinkingLevel::Max => "max",
    }
}

/// Where a level stands from the lowest (`LOWEST_FIRST`).
fn rank(level: ThinkingLevel) -> u8 {
    match level {
        ThinkingLevel::Off => 0,
        ThinkingLevel::Minimal => 1,
        ThinkingLevel::Low => 2,
        ThinkingLevel::Medium => 3,
        ThinkingLevel::High => 4,
        ThinkingLevel::Xhigh => 5,
        ThinkingLevel::Max => 6,
    }
}

fn level_named(word: &str) -> Option<ThinkingLevel> {
    serde_json::from_value(serde_json::Value::from(word)).ok()
}

/// `model` as pi takes it: a `:level` suffix sets thinking; one already there wins (`withThinking`).
pub fn with_thinking(model: &str, thinking: Option<ThinkingLevel>) -> String {
    match thinking {
        Some(level) if level_suffix(model).is_none() => format!("{model}:{}", name_of(level)),
        _ => model.to_owned(),
    }
}

/// The other CLIs take the level apart from the model: a `:level` suffix is split off and wins
/// (`splitThinking`).
pub fn split_thinking(
    model: Option<&str>,
    thinking: Option<ThinkingLevel>,
) -> (Option<&str>, Option<ThinkingLevel>) {
    // `/^(.*):(level)$/`: JavaScript's `.` takes no line terminator, so a model holding one is kept whole
    let split = model
        .filter(|model| !model.contains(['\n', '\r', '\u{2028}', '\u{2029}']))
        .and_then(|model| level_suffix(model).map(|(stem, level)| (Some(stem), Some(level))));
    split.unwrap_or((model, thinking))
}

/// The model without its `:level` suffix, and the level, if it ends in one (`/:(level)$/`).
fn level_suffix(model: &str) -> Option<(&str, ThinkingLevel)> {
    let (stem, word) = model.rsplit_once(':')?;
    level_named(word).map(|level| (stem, level))
}

/// The CLI's own word for a level: the nearest one it has that is not higher, else its lowest
/// (`effortFor`). `words` lists the CLI's levels from the lowest.
fn effort_for(
    thinking: Option<ThinkingLevel>,
    words: &[(ThinkingLevel, &'static str)],
) -> Option<&'static str> {
    let thinking = thinking?;
    words
        .iter()
        .rev()
        .find(|(level, _)| rank(*level) <= rank(thinking))
        .or_else(|| words.first())
        .map(|(_, word)| *word)
}

/// A TOML basic string on one line: `-c key=<value>` is how codex takes a config value (`tomlString`):
/// the text as `JSON.stringify` writes it, with DEL escaped as well.
pub fn toml_string(text: &str) -> String {
    serde_json::Value::from(text)
        .to_string()
        .replace('\u{7f}', "\\u007F")
}

/// `dirname` of node:path for a POSIX path, as node writes it (lib/path.js, `posix.dirname`): a
/// root of two slashes stays (`//x` → `//`), and so does a doubled slash before the last name
/// (`a//b` → `a/`).
fn dirname(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.is_empty() {
        return ".".to_owned();
    }
    let has_root = bytes[0] == b'/';
    let mut end = None;
    let mut matched_slash = true;
    for i in (1..bytes.len()).rev() {
        if bytes[i] == b'/' {
            if !matched_slash {
                end = Some(i);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    match end {
        None if has_root => "/".to_owned(),
        None => ".".to_owned(),
        Some(1) if has_root => "//".to_owned(),
        Some(end) => path[..end].to_owned(),
    }
}

/// No environment: the CLI is configured by its arguments.
fn no_env(_: &PaneContext<'_>) -> Result<BTreeMap<String, String>, FleetError> {
    Ok(BTreeMap::new())
}
