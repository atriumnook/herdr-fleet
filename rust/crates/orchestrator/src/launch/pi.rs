//! pi: the model takes the level as a `:level` suffix; the instructions are appended from a file.

use protocol::FleetAgentKind;

use super::{Adapter, LaunchOptions, no_env, takes_every_role, with_thinking};

pub(super) static ADAPTER: Adapter = Adapter {
    kind: FleetAgentKind::Pi,
    instructions_in_prompt: false,
    // pi's own denylist: it wins over a --tools list, so a role's tools cannot bring edit or write back;
    // codemode (off unless enabled) runs scripts that call other tools, so it goes too
    read_only_args: Some(&["--exclude-tools", "edit,write,codemode"]),
    read_only_edits_result: false,
    note: None,
    usage_command: None,
    launch_args,
    env: no_env,
    read_only_note: None,
    refusal: takes_every_role,
};

fn launch_args(options: &LaunchOptions<'_>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(model) = options.model.filter(|model| !model.is_empty()) {
        args.extend(["--model".to_owned(), with_thinking(model, options.thinking)]);
    }
    if !options.tools.is_empty() {
        args.extend(["--tools".to_owned(), options.tools.join(",")]);
    }
    args.extend([
        "--name".to_owned(),
        format!("fleet:{}", options.name),
        "--append-system-prompt".to_owned(),
        options.system_prompt_file.to_owned(),
    ]);
    args
}
