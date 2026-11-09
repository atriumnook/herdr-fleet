//! OpenCode 2 (`@opencode/cli`; herdr starts the executable named `opencode`, so that must be
//! version 2), and the configuration a fleet pane gives it (`server/fleet/opencode-config.ts`).
//!
//! `--standalone` runs its server inside the pane's process, so the pane's environment reaches it
//! (without it the TUI talks to the person's shared background service, started once with whatever
//! environment it had). The TUI has no `--model` or `--agent`: the model, the agent, the rules and
//! the switches come in `OPENCODE_CONFIG_CONTENT`, read last, so its rules come after the person's
//! own and the last rule that matches wins. The facts the rules rest on are in v2.0.26's source
//! (packages/core/src/permission.ts, util/wildcard.ts, tool/plugin/shell.ts, shell/parse.ts,
//! file-access.ts):
//! - A rule is `{action, resource, effect}`. A request is denied when ANY of its resources has a
//!   `deny` as its last match; otherwise a missing match asks. A saved "Always allow" is appended
//!   after the config as an allow, so it overrides an `ask` but never a `deny`.
//! - `*` matches anything, `?` one character; a trailing ` *` also matches the bare command.
//! - The shell tool matches each command node of the line on its own (`;`, `&&`, `|`, `$(...)` give
//!   several), and a command with a redirect by the text of the whole statement.
//! - A line with no command node (`> ~/x`, `x=1`, `export A=1`) is not checked at all. A role that
//!   edits nothing is therefore held by the guard plugin (opencode/fleet-guard), which accepts a
//!   shell line only in a few exact forms; the rules are its second layer.
//! - A file inside the work folder is matched by its relative path, one outside by its absolute path.
//!
//! The fleet writes no `ask`: the prompt's "Always allow" saves a broad `<prefix> *` allow for the
//! project, shared with the person's own use of OpenCode, so no run may depend on a prompt. Version
//! 2 has no `OPENCODE_PERMISSION`, `OPENCODE_DISABLE_SHARE` or `OPENCODE_DISABLE_LSP_DOWNLOAD`, and the
//! config sets no `lsp` (2.0.26 has no code that uses a language server).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use protocol::FleetAgentKind;
use serde_json::{Map, Value, json};

use super::{Adapter, LaunchOptions, PaneContext, split_thinking};
use crate::FleetError;

/// The agent a role that edits nothing runs as (`OPENCODE_READ_ONLY_AGENT`).
pub const READ_ONLY_AGENT: &str = "fleet-readonly";

/// What a run's OpenCode config is made from (`OpencodeRole`).
#[derive(Debug, Clone, Copy)]
pub struct OpencodeRole<'a> {
    /// this run's result folder, outside the workspace
    pub result_dir: &'a str,
    /// the shell command that runs the fleet CLI
    pub fleet_command: &'a str,
    /// the model as `provider/model[#variant]`
    pub model: Option<&'a str>,
    /// the role edits no file
    pub read_only: bool,
    /// the role merges for the person: the project's coordinator
    pub merges: bool,
}

/// The guard plugin's folder (`OPENCODE_GUARD_PLUGIN`; a folder, since OpenCode loads no single file
/// from its config): the checkout's `opencode/fleet-guard`, three folders above this crate's (ADR
/// 0242-phase-3-split, "fleet-guard のプラグインの場所"). The crate's folder is fixed when it is built,
/// so a binary built in a worktree that is moved or removed points at the old place.
pub fn guard_plugin_dir() -> PathBuf {
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = crate_dir.ancestors().nth(3).unwrap_or(crate_dir);
    root.join("opencode").join("fleet-guard")
}

/// git config for every git the agent runs, through the pane's environment (`opencodeGitEnv`):
/// `-c`-level config beats the repository's own (checked on git 2.55). `core.fsmonitor` names a
/// program that `git status`, `git diff` and `git ls-files` would run. Config the fleet server's own
/// environment (`base`) already carries is kept, and this is appended after it.
pub fn git_env(base: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    // `/^[0-9]{1,3}$/`
    let count = base
        .get("GIT_CONFIG_COUNT")
        .filter(|count| (1..=3).contains(&count.len()) && count.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|count| count.parse::<usize>().ok())
        .unwrap_or(0);
    let mut env = BTreeMap::new();
    for i in 0..count {
        let key = format!("GIT_CONFIG_KEY_{i}");
        let value = format!("GIT_CONFIG_VALUE_{i}");
        if let (Some(k), Some(v)) = (base.get(&key), base.get(&value)) {
            env.insert(key, k.clone());
            env.insert(value, v.clone());
        }
    }
    env.insert("GIT_CONFIG_COUNT".to_owned(), (count + 1).to_string());
    env.insert(
        format!("GIT_CONFIG_KEY_{count}"),
        "core.fsmonitor".to_owned(),
    );
    env.insert(format!("GIT_CONFIG_VALUE_{count}"), "false".to_owned());
    env
}

fn rule(action: &str, resource: &str, effect: &str) -> Value {
    json!({ "action": action, "resource": resource, "effect": effect })
}

fn allow(action: &str, resource: &str) -> Value {
    rule(action, resource, "allow")
}

fn deny(action: &str, resource: &str) -> Value {
    rule(action, resource, "deny")
}

/// commands a read-only role runs unasked, each exactly as written
const READ_ONLY_COMMANDS: [&str; 4] = ["git status", "git ls-files", "ls", "pwd"];

/// git's history commands in the one form that runs no diff helper; the guard accepts only plain
/// arguments after it. A flag later in the line could turn the helpers back on, so those are denied after.
const HISTORY_COMMANDS: [&str; 3] = [
    "git diff --no-ext-diff --no-textconv *",
    "git log --no-ext-diff --no-textconv *",
    "git show --no-ext-diff --no-textconv *",
];

/// read-only queries of GitHub, the pull request and the checks a lead's work is judged by
const GITHUB_QUERIES: [&str; 4] = [
    "gh pr view *",
    "gh pr checks *",
    "gh pr list *",
    "gh run view *",
];

/// A merge the person pressed. A pattern has no digit class, so the number of `gh pr merge` is one
/// to six characters; the guard accepts digits only.
const MERGE_COMMANDS: [&str; 10] = [
    "gh pr merge ? --merge",
    "gh pr merge ?? --merge",
    "gh pr merge ??? --merge",
    "gh pr merge ???? --merge",
    "gh pr merge ????? --merge",
    "gh pr merge ?????? --merge",
    "git pull --ff-only",
    "git merge --no-ff fleet/*",
    "git merge --no-ff agents/*",
    "git merge --abort",
];

/// Text that turns an allowed command into a refusal, whatever allowed it. A redirect makes the shell
/// tool match the whole statement, so `git log ... > ~/x` would meet the allow for `git log ... *`.
const DENIED_AFTER_ALLOWS: [&str; 2] = ["*>*", "*<*"];

/// The characters after `git` are the ones a shell drops before git reads the line: `git diff
/// --ex""t-diff` is `--ext-diff` to git and not to a pattern. A path outside the repository given to
/// `git diff` is an implicit --no-index. (A backslash cannot be denied here: OpenCode turns it into
/// `/` before matching. The guard refuses it.)
const DENIED_AFTER_FLEET: [&str; 18] = [
    "git *--output*",
    "git *--no-index*",
    "git *--ext-diff*",
    "git *--textconv*",
    "git *\"*",
    "git *'*",
    "git *`*",
    "git *$*",
    "git *{*",
    "git * /*",
    "git * ~*",
    "git * ../*",
    "git * ..",
    "git *=/*",
    "git merge --no-ff * ?*",
    "gh *--web*",
    "gh *--watch*",
    "gh pr merge *-* --merge",
];

fn read_only_rules(role: &OpencodeRole<'_>) -> Vec<Value> {
    let merges: &[&str] = if role.merges { &MERGE_COMMANDS } else { &[] };
    // everything off, then only what a role that edits nothing needs
    let mut rules = vec![deny("*", "*")];
    rules.extend(["read", "glob", "grep", "question"].map(|action| allow(action, "*")));
    // OpenCode asks before it reads a .env file; with no ask, it is denied (.env.example is not a secret)
    rules.extend([
        deny("read", "*.env"),
        deny("read", "*.env.*"),
        allow("read", "*.env.example"),
    ]);
    rules.extend(
        READ_ONLY_COMMANDS
            .iter()
            .chain(&HISTORY_COMMANDS)
            .chain(&GITHUB_QUERIES)
            .chain(merges)
            .map(|command| allow("shell", command)),
    );
    rules.extend(DENIED_AFTER_ALLOWS.map(|pattern| deny("shell", pattern)));
    // the fleet command takes quoted text, which may hold < and >; the guard checks its arguments
    rules.push(allow("shell", &format!("{} *", role.fleet_command)));
    rules.extend(DENIED_AFTER_FLEET.map(|pattern| deny("shell", pattern)));
    // the result file is outside the workspace: both the path and the folder need the allowance
    rules.extend(result_folder_rules(role.result_dir));
    rules
}

fn result_folder_rules(result_dir: &str) -> [Value; 2] {
    let inside = format!("{result_dir}/*");
    [allow("edit", &inside), allow("external_directory", &inside)]
}

/// The flags with which a push overwrites or deletes on the remote, as patterns on the text after
/// `git *push*`: `--force*` (also `--force-with-lease`; git takes no shorter prefix of it), `--mi*`
/// and `--de*` (git takes `--mir` and `--del` for `--mirror` and `--delete`), `--pru*` (`--prun`,
/// `--prune`), `-d*`, `-f*`, up to two flags of push before an `f` (`-vf`, `-vuf`; `-vunf` is not
/// caught), a `:ref` (delete) and a `+ref` (force).
fn push_flags() -> Vec<String> {
    const LETTERS: [char; 7] = ['u', 'n', 'v', 'q', 'd', '4', '6'];
    let mut flags: Vec<String> = [
        "--force*", "--mi*", "--de*", "--pru*", "-d*", "-f*", ":*", "+*",
    ]
    .map(str::to_owned)
    .to_vec();
    // a bundle of up to two other flags before the f; spelled out, since a `?` between would also take the space of `-u fork`
    for first in LETTERS {
        flags.push(format!("-{first}f*"));
        flags.extend(LETTERS.map(|second| format!("-{first}{second}f*")));
    }
    flags
}

/// A role that edits is treated as pi is: no approval gate. `* * allow` is not added, since it would
/// override the person's own denies; only what must not happen by accident is denied on top of the
/// defaults. These are best-effort, as pi's: an agent that edits and runs tests can run anything
/// (`env git push -f`, `bash -c`, an alias), and a rule only stops the usual spelling.
/// - a push that overwrites or deletes on the remote (above). Matched on the text, so `git *push*`
///   also covers `git -C <dir> push`. (It refuses `git commit -m "no push -f"` too.)
/// - a file outside the work folder, except the result folder. A path outside is absolute, and one in
///   the repository above a worktree is `../...`.
fn editor_rules(role: &OpencodeRole<'_>) -> Vec<Value> {
    // another config's ask or deny on shell would stop the fleet's own commands
    let mut rules = vec![allow("shell", &format!("{} *", role.fleet_command))];
    rules.extend(
        push_flags()
            .iter()
            .map(|flag| deny("shell", &format!("git *push* {flag}"))),
    );
    rules.extend([deny("edit", "/*"), deny("edit", "../*")]);
    rules.extend(result_folder_rules(role.result_dir));
    rules
}

/// The config of a run's pane (`opencodeConfig`), with the guard plugin at `guard`. An empty model
/// sets none.
pub fn config(role: &OpencodeRole<'_>, guard: &Path) -> Value {
    let mut config = Map::new();
    if let Some(model) = role.model.filter(|model| !model.is_empty()) {
        config.insert("model".to_owned(), json!(model));
    }
    config.insert("share".to_owned(), json!("disabled"));
    config.insert("update".to_owned(), json!("disable"));
    if role.read_only {
        // the TUI takes no --agent: the agent is the default one. The rules are the agent's own, not
        // the top level's, so the person's other agents are left as they are
        config.insert("default_agent".to_owned(), json!(READ_ONLY_AGENT));
        config.insert(
            "agents".to_owned(),
            json!({ READ_ONLY_AGENT: {
                "mode": "primary",
                "description": "Reads the repository and edits no file.",
                "permissions": read_only_rules(role),
            } }),
        );
        config.insert(
            "plugins".to_owned(),
            json!([{
                "package": guard.to_string_lossy(),
                "options": { "fleetCommand": role.fleet_command, "merges": role.merges },
            }]),
        );
    } else {
        config.insert("permissions".to_owned(), Value::Array(editor_rules(role)));
    }
    Value::Object(config)
}

/// What a read-only role is told about the commands it may run, since a refused one only says no
/// (`opencodeReadOnlyNote`).
pub fn read_only_note(merges: bool, fleet_command: &str) -> String {
    let mut lines = vec![
        "Your shell accepts only these command lines, each whole and written exactly like this; any other is refused, and so is the web:".to_owned(),
        format!("- {fleet_command} ... (arguments are plain words, 'single-quoted' text, or \"double-quoted\" text without $, backticks or backslashes)"),
        "- git status, git ls-files, ls, pwd, each alone".to_owned(),
        "- git diff, git log, git show only as `git diff --no-ext-diff --no-textconv <arguments>` (the same for log and show), the arguments being plain flags (--stat, --name-only, --oneline, -n 20, --format=%h ...), revisions, and relative paths inside the repository after `--`; no quotes, no absolute or ~ or .. paths, no .env files".to_owned(),
        "- gh pr view [<number>], gh pr checks [<number>] (no number: the checked-out branch's pull request), gh pr list, gh run view <number>, with flags such as --json <fields>".to_owned(),
    ];
    if merges {
        lines.push("- for a merge the fleet asks you for: gh pr merge <number> --merge, git pull --ff-only, git merge --no-ff <branch>, git merge --abort".to_owned());
    }
    lines.extend([
        "In the fleet command, quote any text that holds a `#`, a space or other punctuation: 'single quotes' keep it literal; to put a single quote inside, close the quotes around it: 'don'\"'\"'t'.".to_owned(),
        "No `;`, `&&`, `|`, `$`, redirect (`<`, `>`), variable assignment or `export` outside the quotes of the fleet command. Read files with the read tool and search with grep and glob, not with cat or find.".to_owned(),
        "Do not try other forms of a refused command. If you need one, say so in your reply to the person or your lead, who can run it or widen what you may do.".to_owned(),
    ]);
    lines.join("\n")
}

pub(super) static ADAPTER: Adapter = Adapter {
    kind: FleetAgentKind::Opencode,
    instructions_in_prompt: true,
    // held to it by the config's default agent, not by an argument
    read_only_args: Some(&[]),
    read_only_edits_result: true,
    note: None,
    usage_command: None,
    runs_fleet_command: true,
    asks_before_outside_reads: false,
    launch_args,
    env,
    read_only_note: Some(read_only_note),
};

fn launch_args(_: &LaunchOptions<'_>) -> Vec<String> {
    vec!["--standalone".to_owned()]
}

/// The model (its `:level` suffix dropped: variants differ per model, so the level is not passed; a
/// `#variant` stays), no self-update, the git config and the config. A role that edits nothing does
/// not start without its guard plugin: its shell would be open with the rules alone (ADR
/// 0242-phase-3-split; TypeScript does not look).
fn env(context: &PaneContext<'_>) -> Result<BTreeMap<String, String>, FleetError> {
    if context.read_only {
        let entry = context.host.guard_plugin.join("index.js");
        if !entry.is_file() {
            // a broken install, not a model failure: the code keeps the model from a cooldown and the
            // spawn from trying the next candidate (ADR 0248-launch-adapters)
            return Err(FleetError::new(
                "guard_plugin_missing",
                format!(
                    "The guard plugin of a role that edits nothing on OpenCode is missing: no {} found.",
                    entry.display()
                ),
            ));
        }
    }
    // a suffix that leaves nothing before it (`:low`) leaves the model as the setting names it, as in TypeScript
    let model = match split_thinking(context.model, None) {
        (Some(stem), _) if !stem.is_empty() => Some(stem),
        _ => context.model,
    };
    let role = OpencodeRole {
        result_dir: context.result_dir,
        fleet_command: context.fleet_command,
        model,
        read_only: context.read_only,
        merges: context.merges,
    };
    let mut env = git_env(&context.host.git_config);
    env.insert("OPENCODE_DISABLE_AUTOUPDATE".to_owned(), "true".to_owned());
    env.insert(
        "OPENCODE_CONFIG_CONTENT".to_owned(),
        config(&role, &context.host.guard_plugin).to_string(),
    );
    Ok(env)
}
