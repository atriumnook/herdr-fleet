//! The agent adapters: each CLI's arguments, environment and settings; from `server/fleet/adapters.ts`, `server/fleet/opencode-config.ts`.
//!
//! What differs between agent CLIs at launch lives here, so the orchestrator stays apart from the
//! kind: the argv after the executable for herdr's `agent.start`, the pane's environment, the
//! arguments and note for a role that edits nothing, and the roles a CLI cannot take. How each CLI
//! looks on its screen is the screen crate's (`screen::screen_checks`); the adapter only carries it.
//! The CLIs' model lists are not here: the models module holds them (ADR 0242-phase-3-split).

pub mod agy;
mod claude;
mod codex;
mod cursor;
pub mod opencode;
mod pi;

use std::collections::BTreeMap;
use std::path::Path;

use protocol::{FleetAgentKind, ThinkingLevel};
use screen::ScreenChecks;

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
    /// the fleet server's own environment, whose `GIT_CONFIG_*` a pane keeps (TypeScript reads `process.env`)
    pub server_env: &'a BTreeMap<String, String>,
    /// the guard plugin's folder for a role that edits nothing on OpenCode: `opencode::guard_plugin_dir()`
    pub guard_plugin: &'a Path,
}

/// What a role asks of the CLI it runs on, for the roles a CLI cannot take.
#[derive(Debug, Clone, Copy)]
pub struct RoleFit<'a> {
    /// the role's name
    pub name: &'a str,
    /// the role may start agents (lead, coordinator): it runs the fleet command
    pub spawning: bool,
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
    launch_args: fn(&LaunchOptions<'_>) -> Vec<String>,
    env: fn(&PaneContext<'_>) -> Result<BTreeMap<String, String>, FleetError>,
    read_only_note: Option<fn(bool, &str) -> String>,
    refusal: fn(&RoleFit<'_>) -> Option<String>,
}

impl Adapter {
    /// how the CLI looks on its screen: the screen crate's checks for this kind
    pub fn screen(&self) -> ScreenChecks {
        screen::screen_checks(self.kind)
    }

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

    /// why this CLI cannot take the role, if it cannot
    pub fn refusal(&self, role: &RoleFit<'_>) -> Option<String> {
        (self.refusal)(role)
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

/// The CLI takes every role.
fn takes_every_role(_: &RoleFit<'_>) -> Option<String> {
    None
}
