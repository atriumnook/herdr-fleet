//! Claude Code: `--effort` has no off; an unknown model starts anyway and fails at its first request.
//! It starts in its auto mode (`--permission-mode auto`): what it judges safe runs, the rest is asked
//! and the run blocks for a person.

use protocol::{FleetAgentKind, ThinkingLevel};

use super::{Adapter, LaunchOptions, effort_for, no_env, split_thinking};

pub(super) static ADAPTER: Adapter = Adapter {
    kind: FleetAgentKind::Claude,
    instructions_in_prompt: false,
    // codex is not held so: its --approve-for-me overrides a read-only sandbox
    read_only_args: Some(&["--disallowedTools", "Edit,Write,NotebookEdit"]),
    read_only_edits_result: false,
    note: None,
    usage_command: None,
    runs_fleet_command: true,
    asks_before_outside_reads: false,
    launch_args,
    env: no_env,
    read_only_note: None,
};

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
        args.extend(["--effort".to_owned(), effort.to_owned()]);
    }
    args.extend(
        [
            "--permission-mode",
            "auto",
            "--name",
            &format!("fleet:{}", options.name),
            "--append-system-prompt-file",
            options.system_prompt_file,
            "--add-dir",
            options.result_dir,
        ]
        .map(str::to_owned),
    );
    args
}
