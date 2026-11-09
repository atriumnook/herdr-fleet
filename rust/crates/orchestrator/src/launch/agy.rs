//! Antigravity CLI: no instruction option. Its settings for the session go in `--settings`, kept for
//! the session and never saved to the person's settings.json (which agy also writes):
//! - `trustedWorkspaces`: agy trusts a folder only by its exact path, a subfolder of a trusted one
//!   included, and asks for each new one, so a thread's new worktree would stop at that question.
//! - `agentMode: "auto"`: edits and safe commands go through, commands that leave the terminal
//!   sandbox are reviewed by a separate agent, irreversible ones are asked. `--mode auto` is decided
//!   before the sign-in is read and falls back to the default mode (agy 1.5.3); the setting is not.
//! - `enableTerminalSandbox`: commands run in agy's terminal sandbox, which hides git's data and the
//!   person's tools (`SANDBOX_NOTE`). The fleet keeps it: what agy may reach stays its workspace.
//!
//! Checked against the real CLI by scripts/agy-live-check.ts.

use std::collections::BTreeMap;

use protocol::{FleetAgentKind, ThinkingLevel};
use serde_json::json;

use super::{Adapter, LaunchOptions, PaneContext, RoleFit, dirname, effort_for, split_thinking};
use crate::FleetError;

/// What agy is told to refuse in every mode (`permissions.deny`, which wins over its auto mode's
/// approvals): a force push and a push that deletes a remote branch, as the opencode rules refuse
/// them (`AGY_DENY`). Best effort, like those: the shell stays open, and only the usual spellings are
/// matched. A rule is a prefix of the command line, matched word by word, so a flag is refused only
/// right after `git push` (`git push origin x --force` goes through). A `regex:` rule refused nothing
/// in agy 1.5.3; a prefix did.
pub const DENY: [&str; 8] = [
    "command(git push --force)",
    "command(git push --force-with-lease)",
    "command(git push --force-if-includes)",
    "command(git push -f)",
    "command(git push --mirror)",
    "command(git push --delete)",
    "command(git push -d)",
    "command(git push --prune)",
];

/// agy's terminal sandbox hides what lies outside the workspace and the --add-dir folders: a
/// worktree's git data in the repository, and tools installed under the home folder (mise), the bun
/// that runs the fleet command among them (agy 1.5.3; --add-dir does not reach the sandbox). The
/// sandbox stays; the agent is told, so it neither retries nor asks to leave it (`AGY_SANDBOX_NOTE`).
const SANDBOX_NOTE: &str = "Your terminal runs in Antigravity CLI's sandbox, which hides the repository's git data and the tools installed under the home folder: git, the project's test runner and build, and the fleet command fail there. Do not look for ways around it or ask to run outside the sandbox. Read files with your file tools, work from the diff and the check output your caller gives you, and say in your HANDOFF which checks you could not run, so your caller runs them.";

/// The session settings agy is started with in `cwd` (`agySettings`).
pub fn settings(cwd: &str) -> serde_json::Value {
    json!({
        "trustedWorkspaces": [cwd],
        "agentMode": "auto",
        "enableTerminalSandbox": true,
        "permissions": { "deny": DENY },
    })
}

pub(super) static ADAPTER: Adapter = Adapter {
    kind: FleetAgentKind::Agy,
    instructions_in_prompt: true,
    read_only_args: None,
    read_only_edits_result: false,
    note: Some(SANDBOX_NOTE),
    usage_command: None,
    launch_args,
    env,
    read_only_note: None,
    refusal,
};

const EFFORTS: [(ThinkingLevel, &str); 4] = [
    (ThinkingLevel::Low, "low"),
    (ThinkingLevel::Medium, "medium"),
    (ThinkingLevel::High, "high"),
    (ThinkingLevel::Max, "max"),
];

/// An agy model id that names its level, as all in its model list do (`AGY_MODEL_LEVEL`).
fn names_its_level(model: &str) -> bool {
    model
        .rsplit_once('-')
        .is_some_and(|(_, level)| ["low", "medium", "high", "xhigh", "max"].contains(&level))
}

fn launch_args(options: &LaunchOptions<'_>) -> Vec<String> {
    let (model, thinking) = split_thinking(options.model, options.thinking);
    let model = model.filter(|model| !model.is_empty());
    // agy's model ids name their level (`gemini-4-argon-medium`): with --effort as well, agy drops the
    // model for its default one (agy 1.5.3), so the id's level stands and the role's goes
    let effort = match model {
        Some(model) if names_its_level(model) => None,
        _ => effort_for(thinking, &EFFORTS),
    };
    let mut args = Vec::new();
    if let Some(model) = model {
        args.extend(["--model".to_owned(), model.to_owned()]);
    }
    if let Some(effort) = effort {
        args.extend(["--effort".to_owned(), effort.to_owned()]);
    }
    args.extend([
        // every run's results folder, not only its own: a reviewer reads the lead's contract and the
        // files passed with --context there, and agy asks before it reads a file outside its folders
        "--add-dir".to_owned(),
        dirname(options.result_dir),
        "--settings".to_owned(),
        settings(options.cwd).to_string(),
    ]);
    args
}

/// agy updates itself when it starts unless told not to, and only `true` tells it (CLAUDE.md, "CLI
/// を実機で起動する検証の副作用"; scripts/agy-live-check.ts starts its pane so).
fn env(_: &PaneContext<'_>) -> Result<BTreeMap<String, String>, FleetError> {
    Ok(BTreeMap::from([(
        "AGY_CLI_DISABLE_AUTO_UPDATE".to_owned(),
        "true".to_owned(),
    )]))
}

/// The roles agy cannot take: one that starts agents runs the fleet command, which the sandbox hides
/// (#189's 8: the sandbox note would contradict its instructions), and the reviewer, which stops at
/// agy's question before it reads the files outside its folders that a review is asked to read (#190).
fn refusal(role: &RoleFit<'_>) -> Option<String> {
    if role.spawning {
        Some(
            "agy cannot run the fleet command, which this role uses: its terminal sandbox hides it"
                .to_owned(),
        )
    } else if role.name == "reviewer" {
        Some("agy stops at its question before it reads a file outside its folders, which a review reads".to_owned())
    } else {
        None
    }
}
