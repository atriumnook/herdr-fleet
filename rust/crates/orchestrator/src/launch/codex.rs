//! Codex: instructions go in as `developer_instructions`, added to its own rather than replacing them.
//! Approvals go to its automatic review (`--approve-for-me`); commands stay in the workspace-write
//! sandbox, which `--approve-for-me` sets (it takes no `--sandbox`, and overrides `sandbox_mode`).

use protocol::{FleetAgentKind, ThinkingLevel};

use super::{Adapter, LaunchOptions, effort_for, no_env, split_thinking, toml_string};

/// The workspace-write sandbox blocks the network, the loopback the fleet server listens on too.
/// Codex is told to ask for that one command outside the sandbox, which its automatic review then
/// judges, rather than the network being opened for every command (`CODEX_FLEET_NOTE`).
const FLEET_NOTE: &str = "If a fleet command fails because it cannot reach the fleet server, your sandbox is blocking the local network: request to run that same command outside the sandbox, giving as the reason that it reaches the fleet server on this machine.";

pub(super) static ADAPTER: Adapter = Adapter {
    kind: FleetAgentKind::Codex,
    instructions_in_prompt: false,
    read_only_args: None,
    read_only_edits_result: false,
    note: None,
    usage_command: None,
    runs_fleet_command: true,
    asks_before_outside_reads: false,
    launch_args,
    env: no_env,
    read_only_note: None,
};

/// what codex's models list (model/list) as their efforts: low is the lowest, max only on some
const EFFORTS: [(ThinkingLevel, &str); 5] = [
    (ThinkingLevel::Low, "low"),
    (ThinkingLevel::Medium, "medium"),
    (ThinkingLevel::High, "high"),
    (ThinkingLevel::Xhigh, "xhigh"),
    (ThinkingLevel::Max, "max"),
];

fn launch_args(options: &LaunchOptions<'_>) -> Vec<String> {
    let (model, thinking) = split_thinking(options.model, options.thinking);
    let mut args = Vec::new();
    if let Some(model) = model.filter(|model| !model.is_empty()) {
        args.extend(["--model".to_owned(), model.to_owned()]);
    }
    if let Some(effort) = effort_for(thinking, &EFFORTS) {
        args.extend([
            "-c".to_owned(),
            format!("model_reasoning_effort={}", toml_string(effort)),
        ]);
    }
    let instructions = format!("{}\n\n{FLEET_NOTE}", options.system_prompt);
    args.extend([
        "-c".to_owned(),
        format!("developer_instructions={}", toml_string(&instructions)),
        "--approve-for-me".to_owned(),
        "--add-dir".to_owned(),
        options.result_dir.to_owned(),
    ]);
    args
}
