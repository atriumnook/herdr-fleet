//! Cursor Agent: no instruction option and no level (a model's variants carry it). It asks to trust
//! every folder it is given, after herdr already called it ready, so it is given the folder of all
//! result folders: trusted once, not once per run. It starts with `--auto-review`.

use protocol::FleetAgentKind;

use super::{Adapter, LaunchOptions, dirname, no_env, split_thinking, takes_every_role};

pub(super) static ADAPTER: Adapter = Adapter {
    kind: FleetAgentKind::Cursor,
    instructions_in_prompt: true,
    read_only_args: None,
    read_only_edits_result: false,
    note: None,
    usage_command: Some("/usage"),
    launch_args,
    env: no_env,
    read_only_note: None,
    refusal: takes_every_role,
};

fn launch_args(options: &LaunchOptions<'_>) -> Vec<String> {
    let (model, _) = split_thinking(options.model, options.thinking);
    let mut args = Vec::new();
    if let Some(model) = model.filter(|model| !model.is_empty()) {
        args.extend(["--model".to_owned(), model.to_owned()]);
    }
    args.extend([
        "--auto-review".to_owned(),
        "--add-dir".to_owned(),
        dirname(options.result_dir),
    ]);
    args
}
