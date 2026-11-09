//! The launch part of the agent adapters, ported from `server/fleet/adapters.test.ts` (each test
//! names the `it` it comes from), and the CLIs' launch rules that CLAUDE.md's "守ること" sets.
//! The adapters' looks at a screen moved to the screen crate in phase 2 (parity.md), and the model
//! lists to the models module (ADR 0242-phase-3-split); their `it`s are not here.

use std::collections::BTreeMap;
use std::path::Path;

use herdr_fleet_orchestrator::launch::{
    self, LaunchOptions, PaneContext, RoleFit, adapter_for, agy, split_thinking, toml_string,
    with_thinking,
};
use protocol::{FleetAgentKind, ThinkingLevel};
use serde_json::{Value, json};

const ALL_KINDS: [FleetAgentKind; 6] = [
    FleetAgentKind::Pi,
    FleetAgentKind::Claude,
    FleetAgentKind::Codex,
    FleetAgentKind::Cursor,
    FleetAgentKind::Agy,
    FleetAgentKind::Opencode,
];

/// `base` of adapters.test.ts.
fn base() -> LaunchOptions<'static> {
    LaunchOptions {
        model: None,
        thinking: None,
        tools: &[],
        name: "impl",
        system_prompt_file: "/tmp/i.md",
        system_prompt: "Be brief.\nSay \"done\".",
        result_dir: "/state/results/r1",
        cwd: "/repo/.herdr-fleet/worktrees/t1",
    }
}

fn args(kind: FleetAgentKind, options: LaunchOptions<'_>) -> Vec<String> {
    adapter_for(kind).launch_args(&options)
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

const FLEET: &str = "/usr/bin/bun /opt/fleet/bin/fleet.ts";

fn no_env() -> BTreeMap<String, String> {
    BTreeMap::new()
}

/// `pane` of adapters.test.ts's opencode describe, with the server's environment and the guard.
fn pane<'a>(server_env: &'a BTreeMap<String, String>, guard: &'a Path) -> PaneContext<'a> {
    PaneContext {
        result_dir: "/state/fleet-results/r1",
        fleet_command: FLEET,
        model: None,
        read_only: false,
        merges: false,
        server_env,
        guard_plugin: guard,
    }
}

// --- pi ---

// adapters.test.ts: pi adapter > launches with the model at its thinking level, the role's tools, a fleet name and the instruction file
#[test]
fn pi_launches_with_the_model_at_its_level_the_tools_a_fleet_name_and_the_instruction_file() {
    let tools = strings(&["read", "bash"]);
    assert_eq!(
        args(
            FleetAgentKind::Pi,
            LaunchOptions {
                model: Some("p/m"),
                thinking: Some(ThinkingLevel::Low),
                tools: &tools,
                ..base()
            }
        ),
        strings(&[
            "--model",
            "p/m:low",
            "--tools",
            "read,bash",
            "--name",
            "fleet:impl",
            "--append-system-prompt",
            "/tmp/i.md"
        ])
    );
    assert_eq!(
        args(FleetAgentKind::Pi, base()),
        strings(&[
            "--name",
            "fleet:impl",
            "--append-system-prompt",
            "/tmp/i.md"
        ])
    );
    assert!(!adapter_for(FleetAgentKind::Pi).instructions_in_prompt);
}

// adapters.test.ts: pi adapter > keeps a :level the model already carries
#[test]
fn pi_keeps_a_level_the_model_already_carries() {
    assert_eq!(
        with_thinking("p/m:high", Some(ThinkingLevel::Low)),
        "p/m:high"
    );
    assert_eq!(with_thinking("p/m", None), "p/m");
}

// adapters.test.ts: pi adapter > takes edit, write and codemode away from a role that edits no file
#[test]
fn pi_takes_edit_write_and_codemode_away_from_a_role_that_edits_no_file() {
    assert_eq!(
        adapter_for(FleetAgentKind::Pi).read_only_args,
        Some(&["--exclude-tools", "edit,write,codemode"][..])
    );
}

// --- claude ---

// adapters.test.ts: claude adapter > appends the instruction file, names the session and lets the agent write its result folder
#[test]
fn claude_appends_the_instruction_file_names_the_session_and_may_write_its_result_folder() {
    let tools = strings(&["read"]);
    assert_eq!(
        args(
            FleetAgentKind::Claude,
            LaunchOptions {
                model: Some("opus"),
                thinking: Some(ThinkingLevel::High),
                tools: &tools,
                ..base()
            }
        ),
        strings(&[
            "--model",
            "opus",
            "--effort",
            "high",
            "--permission-mode",
            "auto",
            "--name",
            "fleet:impl",
            "--append-system-prompt-file",
            "/tmp/i.md",
            "--add-dir",
            "/state/results/r1"
        ])
    );
    assert!(!adapter_for(FleetAgentKind::Claude).instructions_in_prompt);
}

// adapters.test.ts: claude adapter > takes a :level suffix as the effort, and has no level below low
#[test]
fn claude_takes_a_level_suffix_as_the_effort_and_has_no_level_below_low() {
    let suffixed = args(
        FleetAgentKind::Claude,
        LaunchOptions {
            model: Some("sonnet:xhigh"),
            thinking: Some(ThinkingLevel::Low),
            ..base()
        },
    );
    assert_eq!(
        suffixed[..4],
        strings(&["--model", "sonnet", "--effort", "xhigh"])
    );
    let off = args(
        FleetAgentKind::Claude,
        LaunchOptions {
            thinking: Some(ThinkingLevel::Off),
            ..base()
        },
    );
    assert_eq!(off[..2], strings(&["--effort", "low"]));
}

// adapters.test.ts: claude adapter > (readOnlyArgs, from adapters.ts: codex is not held, its --approve-for-me overrides a read-only sandbox)
#[test]
fn claude_takes_the_editing_tools_away_from_a_role_that_edits_no_file() {
    assert_eq!(
        adapter_for(FleetAgentKind::Claude).read_only_args,
        Some(&["--disallowedTools", "Edit,Write,NotebookEdit"][..])
    );
    // CLAUDE.md: a role that edits nothing (`edits: false`) is not given to codex
    assert_eq!(adapter_for(FleetAgentKind::Codex).read_only_args, None);
    assert_eq!(adapter_for(FleetAgentKind::Cursor).read_only_args, None);
    assert_eq!(adapter_for(FleetAgentKind::Agy).read_only_args, None);
}

// --- codex ---

// adapters.test.ts: codex adapter > passes the instructions as developer_instructions on one argv line, and the level as reasoning effort
#[test]
fn codex_passes_the_instructions_as_developer_instructions_on_one_line_and_the_level_as_effort() {
    let args = args(
        FleetAgentKind::Codex,
        LaunchOptions {
            model: Some("gpt-5.5"),
            thinking: Some(ThinkingLevel::Max),
            ..base()
        },
    );
    assert_eq!(args.len(), 9);
    assert_eq!(
        args[..5],
        strings(&[
            "--model",
            "gpt-5.5",
            "-c",
            "model_reasoning_effort=\"max\"",
            "-c"
        ])
    );
    assert!(
        args[5].starts_with(r#"developer_instructions="Be brief.\nSay \"done\".\n\n"#),
        "{}",
        args[5]
    );
    assert_eq!(
        args[6..],
        strings(&["--approve-for-me", "--add-dir", "/state/results/r1"])
    );
    assert!(!args.iter().any(|arg| arg.contains('\n')));
}

// adapters.test.ts: codex adapter > tells codex to ask for a fleet command outside its sandbox when the sandbox keeps it from the fleet server
#[test]
fn codex_is_told_to_ask_for_a_fleet_command_outside_its_sandbox() {
    let args = args(FleetAgentKind::Codex, base());
    let instructions = args
        .iter()
        .find(|arg| arg.starts_with("developer_instructions="))
        .unwrap();
    assert!(instructions.contains("request to run that same command outside the sandbox"));
    // the network stays shut for every other command: no config opens it
    assert!(!args.join(" ").contains("network_access"));
}

// adapters.test.ts: codex adapter > runs the lowest level as low, the lowest effort codex's models take
#[test]
fn codex_runs_the_lowest_level_as_low() {
    for thinking in [ThinkingLevel::Off, ThinkingLevel::Minimal] {
        let args = args(
            FleetAgentKind::Codex,
            LaunchOptions {
                thinking: Some(thinking),
                ..base()
            },
        );
        assert_eq!(
            args[..2],
            strings(&["-c", "model_reasoning_effort=\"low\""])
        );
    }
}

// adapters.test.ts: codex adapter > escapes what a TOML basic string cannot hold raw
#[test]
fn toml_string_escapes_what_a_basic_string_cannot_hold_raw() {
    assert_eq!(
        toml_string("a\tb\\c\u{1}\u{7f}"),
        r#""a\tb\\c\u0001\u007F""#
    );
}

// --- cursor ---

// adapters.test.ts: cursor adapter > is given the folder of all result folders, so it asks to trust one folder once rather than one per run
#[test]
fn cursor_is_given_the_folder_of_all_result_folders() {
    assert_eq!(
        args(FleetAgentKind::Cursor, base()).last().unwrap(),
        "/state/results"
    );
}

// added: the folder above the result folder is node's `dirname` (values printed by bun 1.4.4's node:path)
#[test]
fn cursor_and_agy_take_the_folder_above_as_node_dirname_writes_it() {
    for (result_dir, expected) in [
        ("/state/results/r1", "/state/results"),
        ("/state/results/r1/", "/state/results"),
        ("//x", "//"),
        ("a//b", "a/"),
        ("r1", "."),
        ("/", "/"),
        ("", "."),
        ("//", "/"),
        ("///a", "//"),
        ("a/b/", "a"),
        ("/a", "/"),
    ] {
        let options = LaunchOptions {
            result_dir,
            ..base()
        };
        assert_eq!(
            args(FleetAgentKind::Cursor, options).last().unwrap(),
            expected,
            "{result_dir:?}"
        );
        let agy = args(FleetAgentKind::Agy, options);
        let at = agy.iter().position(|arg| arg == "--add-dir").unwrap();
        assert_eq!(agy[at + 1], expected, "{result_dir:?}");
    }
}

// adapters.test.ts: cursor adapter > has no instruction option or level: the instructions lead the first prompt
#[test]
fn cursor_has_no_instruction_option_or_level() {
    assert_eq!(
        args(
            FleetAgentKind::Cursor,
            LaunchOptions {
                model: Some("gpt-5:high"),
                thinking: Some(ThinkingLevel::Low),
                ..base()
            }
        ),
        strings(&[
            "--model",
            "gpt-5",
            "--auto-review",
            "--add-dir",
            "/state/results"
        ])
    );
    assert!(adapter_for(FleetAgentKind::Cursor).instructions_in_prompt);
}

// adapters.test.ts: cursor usage > is typed as /usage and read as the included share, until the next reset date (its first half: reading the pager is the screen crate's)
#[test]
fn cursor_usage_is_typed_as_slash_usage() {
    assert_eq!(
        adapter_for(FleetAgentKind::Cursor).usage_command,
        Some("/usage")
    );
    for kind in ALL_KINDS
        .into_iter()
        .filter(|kind| *kind != FleetAgentKind::Cursor)
    {
        assert_eq!(adapter_for(kind).usage_command, None, "{kind:?}");
    }
}

// --- agy ---

// adapters.test.ts: agy adapter > takes the model and effort, with instructions in the first prompt, and every run's results folder (a reviewer reads its lead's)
#[test]
fn agy_takes_the_model_and_effort_and_every_runs_results_folder() {
    let args = args(
        FleetAgentKind::Agy,
        LaunchOptions {
            model: Some("gemini-3.8-pro"),
            thinking: Some(ThinkingLevel::Xhigh),
            ..base()
        },
    );
    assert_eq!(
        args[..6],
        strings(&[
            "--model",
            "gemini-3.8-pro",
            "--effort",
            "high",
            "--add-dir",
            "/state/results"
        ])
    );
    assert!(adapter_for(FleetAgentKind::Agy).instructions_in_prompt);
}

// adapters.test.ts: agy adapter > leaves the level to a model id that names one, as agy drops such a model given --effort as well
// (#176's 6: --effort never meets a model id that names its level, so agy's conflict never arises from the fleet's argv)
#[test]
fn agy_leaves_the_level_to_a_model_id_that_names_one() {
    let named = args(
        FleetAgentKind::Agy,
        LaunchOptions {
            model: Some("gemini-4-argon-medium"),
            thinking: Some(ThinkingLevel::High),
            ..base()
        },
    );
    assert_eq!(
        named[..3],
        strings(&["--model", "gemini-4-argon-medium", "--add-dir"])
    );
    let suffixed = args(
        FleetAgentKind::Agy,
        LaunchOptions {
            model: Some("claude-sonnet-5-5-low:max"),
            ..base()
        },
    );
    assert_eq!(
        suffixed[..3],
        strings(&["--model", "claude-sonnet-5-5-low", "--add-dir"])
    );
    let level_only = args(
        FleetAgentKind::Agy,
        LaunchOptions {
            thinking: Some(ThinkingLevel::High),
            ..base()
        },
    );
    assert_eq!(level_only[..2], strings(&["--effort", "high"]));
    for model in ["gemini-4-argon-low", "m-xhigh", "m-max", "m-high"] {
        let args = args(
            FleetAgentKind::Agy,
            LaunchOptions {
                model: Some(model),
                thinking: Some(ThinkingLevel::Low),
                ..base()
            },
        );
        assert!(
            !args.iter().any(|arg| arg == "--effort"),
            "{model}: {args:?}"
        );
    }
}

fn agy_settings_of(args: &[String]) -> Value {
    let at = args.iter().position(|arg| arg == "--settings").unwrap();
    serde_json::from_str(&args[at + 1]).unwrap()
}

// adapters.test.ts: agy adapter > trusts the run's own folder and runs in auto mode in the sandbox, for the session only
#[test]
fn agy_trusts_the_runs_own_folder_and_runs_in_auto_mode_in_the_sandbox_for_the_session_only() {
    let args = args(FleetAgentKind::Agy, base());
    assert!(!args.iter().any(|arg| arg == "--mode"));
    let deny: Vec<&str> = agy::DENY.to_vec();
    assert_eq!(
        agy_settings_of(&args),
        json!({ "trustedWorkspaces": ["/repo/.herdr-fleet/worktrees/t1"], "agentMode": "auto", "enableTerminalSandbox": true, "permissions": { "deny": deny } })
    );
    assert_eq!(
        agy::settings("/repo/.herdr-fleet/worktrees/t1"),
        agy_settings_of(&args)
    );
}

// adapters.test.ts: agy adapter > refuses a force push and a push that deletes a remote branch, and lets an ordinary push through
#[test]
fn agy_refuses_a_force_push_and_a_deleting_push_and_lets_an_ordinary_push_through() {
    // agy matches a command rule as a prefix of the command line, word by word
    let rules: Vec<Vec<String>> = agy::DENY
        .iter()
        .map(|rule| {
            let inner = rule
                .strip_prefix("command(")
                .and_then(|rest| rest.strip_suffix(')'))
                .unwrap();
            inner.split(' ').map(str::to_owned).collect()
        })
        .collect();
    let refused = |line: &str| {
        let words: Vec<&str> = line.split_whitespace().collect();
        rules.iter().any(|rule| {
            rule.iter()
                .enumerate()
                .all(|(i, word)| words.get(i) == Some(&word.as_str()))
        })
    };
    for line in [
        "git push --force origin main",
        "git push -f origin x",
        "git push --force-with-lease",
        "git push --mirror",
        "git push --delete origin x",
        "git push -d origin x",
        "git push --prune origin",
    ] {
        assert!(refused(line), "{line}");
    }
    for line in [
        "git push",
        "git push -u origin fleet/t1",
        "git push origin HEAD:refs/heads/x",
        "git status --force",
        "git pushd -f",
    ] {
        assert!(!refused(line), "{line}");
    }
}

// added: AGY_DENY as adapters.ts lists it, in its order
#[test]
fn agy_deny_lists_the_push_flags_in_order() {
    assert_eq!(
        agy::DENY.to_vec(),
        vec![
            "command(git push --force)",
            "command(git push --force-with-lease)",
            "command(git push --force-if-includes)",
            "command(git push -f)",
            "command(git push --mirror)",
            "command(git push --delete)",
            "command(git push -d)",
            "command(git push --prune)",
        ]
    );
}

// added (CLAUDE.md "CLI を実機で起動する検証の副作用", scripts/agy-live-check.ts): agy stops updating itself only with
// AGY_CLI_DISABLE_AUTO_UPDATE=true (not 1), so its pane has it. TypeScript's agy adapter sets no pane
// environment; this is the issue's acceptance, written as the live check starts agy.
#[test]
fn agy_starts_with_its_self_update_off() {
    let server_env = no_env();
    let guard = launch::opencode::guard_plugin_dir();
    let env = adapter_for(FleetAgentKind::Agy)
        .env(&pane(&server_env, &guard))
        .unwrap();
    assert_eq!(
        env,
        BTreeMap::from([("AGY_CLI_DISABLE_AUTO_UPDATE".to_owned(), "true".to_owned())])
    );
}

// added (CLAUDE.md "エージェント CLI の癖"): the sandbox note goes to every agy agent, and agy takes no role that
// runs the fleet command (#189's 8), nor the reviewer (#190)
#[test]
fn agy_tells_its_sandbox_and_takes_no_role_that_runs_the_fleet_command() {
    let agy = adapter_for(FleetAgentKind::Agy);
    let note = agy.note.unwrap();
    assert!(note.contains("the fleet command fail there"), "{note}");
    for role in [
        RoleFit {
            name: "lead",
            spawning: true,
        },
        RoleFit {
            name: "coordinator",
            spawning: true,
        },
        RoleFit {
            name: "my-planner",
            spawning: true,
        },
        RoleFit {
            name: "reviewer",
            spawning: false,
        },
    ] {
        assert!(agy.refusal(&role).is_some(), "{role:?}");
    }
    for role in [
        RoleFit {
            name: "worker",
            spawning: false,
        },
        RoleFit {
            name: "scout",
            spawning: false,
        },
        RoleFit {
            name: "architect",
            spawning: false,
        },
    ] {
        assert_eq!(agy.refusal(&role), None, "{role:?}");
    }
    // the other CLIs take every role, and tell nothing to every agent
    for kind in ALL_KINDS
        .into_iter()
        .filter(|kind| *kind != FleetAgentKind::Agy)
    {
        for role in [
            RoleFit {
                name: "lead",
                spawning: true,
            },
            RoleFit {
                name: "reviewer",
                spawning: false,
            },
        ] {
            assert_eq!(adapter_for(kind).refusal(&role), None, "{kind:?} {role:?}");
        }
        assert_eq!(adapter_for(kind).note, None, "{kind:?}");
    }
}

// --- opencode ---

// adapters.test.ts: opencode adapter > starts the TUI standalone and takes everything else in its config: no model flag, no thinking level, instructions in the first prompt
#[test]
fn opencode_starts_the_tui_standalone_and_takes_everything_else_in_its_config() {
    assert_eq!(
        args(
            FleetAgentKind::Opencode,
            LaunchOptions {
                model: Some("anthropic/claude-sonnet-5-5"),
                thinking: Some(ThinkingLevel::High),
                ..base()
            }
        ),
        strings(&["--standalone"])
    );
    assert_eq!(
        args(FleetAgentKind::Opencode, base()),
        strings(&["--standalone"])
    );
    let opencode = adapter_for(FleetAgentKind::Opencode);
    assert!(opencode.instructions_in_prompt);
    assert_eq!(opencode.read_only_args, Some(&[][..]));
    assert!(opencode.read_only_edits_result);
}

fn config_of(env: &BTreeMap<String, String>) -> Value {
    serde_json::from_str(&env["OPENCODE_CONFIG_CONTENT"]).unwrap()
}

// adapters.test.ts: opencode adapter > gives the pane the model, no self-update and no sharing, and none of the switches version 2 dropped
#[test]
fn opencode_gives_the_pane_the_model_no_self_update_no_sharing_and_none_of_the_dropped_switches() {
    let server_env = no_env();
    let guard = launch::opencode::guard_plugin_dir();
    let opencode = adapter_for(FleetAgentKind::Opencode);
    let env = opencode
        .env(&PaneContext {
            model: Some("anthropic/claude-sonnet-5-5:low"),
            ..pane(&server_env, &guard)
        })
        .unwrap();
    assert_eq!(
        env.keys().map(String::as_str).collect::<Vec<_>>(),
        vec![
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_VALUE_0",
            "OPENCODE_CONFIG_CONTENT",
            "OPENCODE_DISABLE_AUTOUPDATE"
        ]
    );
    assert_eq!(env["OPENCODE_DISABLE_AUTOUPDATE"], "true");
    // every git of the agent runs without the repository's fsmonitor program
    assert_eq!(
        [
            env["GIT_CONFIG_COUNT"].as_str(),
            env["GIT_CONFIG_KEY_0"].as_str(),
            env["GIT_CONFIG_VALUE_0"].as_str()
        ],
        ["1", "core.fsmonitor", "false"]
    );
    // (the server's own git config and a count that is not a number: fixtures/security/orchestrator/opencodeGitEnv.json, tests/opencode_config.rs)
    let config = config_of(&env);
    assert_eq!(config["model"], "anthropic/claude-sonnet-5-5");
    assert_eq!(config["share"], "disabled");
    assert_eq!(config["update"], "disable");
    // a #variant stays with the model; none given, none set
    let variant = opencode
        .env(&PaneContext {
            model: Some("p/m#high"),
            ..pane(&server_env, &guard)
        })
        .unwrap();
    assert_eq!(config_of(&variant)["model"], "p/m#high");
    let none = opencode.env(&pane(&server_env, &guard)).unwrap();
    assert_eq!(config_of(&none).get("model"), None);
    // the config text is read with {env:...} and {file:...} substituted
    assert!(!none["OPENCODE_CONFIG_CONTENT"].contains("{env:"));
    assert!(!none["OPENCODE_CONFIG_CONTENT"].contains("{file:"));
}

// added: a model whose suffix leaves nothing before it stays as the setting names it (TypeScript's
// `{ ...context, ...(model ? { model } : {}) }`; values printed by bun from server/fleet/adapters.ts)
#[test]
fn opencode_keeps_a_model_that_is_only_a_level_as_written() {
    let server_env = no_env();
    let guard = launch::opencode::guard_plugin_dir();
    for (model, expected) in [
        (":low", Some(":low")),
        ("", None),
        ("p/m:high", Some("p/m")),
        (":", Some(":")),
    ] {
        let env = adapter_for(FleetAgentKind::Opencode)
            .env(&PaneContext {
                model: Some(model),
                ..pane(&server_env, &guard)
            })
            .unwrap();
        let config = config_of(&env);
        assert_eq!(
            config.get("model").and_then(Value::as_str),
            expected,
            "{model:?}"
        );
    }
}

// adapters.test.ts: opencode adapter > gives the pane the model ... (the server's GIT_CONFIG_* reach the pane through PaneContext)
#[test]
fn opencode_keeps_the_servers_own_git_config_before_its_own() {
    let server_env = BTreeMap::from([
        ("GIT_CONFIG_COUNT".to_owned(), "1".to_owned()),
        ("GIT_CONFIG_KEY_0".to_owned(), "a.b".to_owned()),
        ("GIT_CONFIG_VALUE_0".to_owned(), "1".to_owned()),
        ("PATH".to_owned(), "/usr/bin".to_owned()),
    ]);
    let guard = launch::opencode::guard_plugin_dir();
    let env = adapter_for(FleetAgentKind::Opencode)
        .env(&pane(&server_env, &guard))
        .unwrap();
    assert_eq!(env["GIT_CONFIG_COUNT"], "2");
    assert_eq!(env["GIT_CONFIG_KEY_0"], "a.b");
    assert_eq!(env["GIT_CONFIG_KEY_1"], "core.fsmonitor");
    assert_eq!(env["GIT_CONFIG_VALUE_1"], "false");
    assert!(!env.contains_key("PATH"));
}

// added (CLAUDE.md "opencode の癖"): OPENCODE_PERMISSION, OPENCODE_DISABLE_SHARE and OPENCODE_DISABLE_LSP_DOWNLOAD
// are not in version 2, and the config sets no `lsp`
#[test]
fn opencode_uses_none_of_the_switches_version_2_dropped() {
    let server_env = no_env();
    let guard = launch::opencode::guard_plugin_dir();
    for (read_only, merges) in [(false, false), (true, false), (true, true)] {
        let env = adapter_for(FleetAgentKind::Opencode)
            .env(&PaneContext {
                read_only,
                merges,
                ..pane(&server_env, &guard)
            })
            .unwrap();
        for dropped in [
            "OPENCODE_PERMISSION",
            "OPENCODE_DISABLE_SHARE",
            "OPENCODE_DISABLE_LSP_DOWNLOAD",
        ] {
            assert!(!env.contains_key(dropped), "{dropped}");
        }
        assert_eq!(config_of(&env).get("lsp"), None);
    }
}

// adapters.test.ts: opencode adapter > tells a role that edits nothing what its shell allows, and the coordinator what a merge is
#[test]
fn opencode_tells_a_read_only_role_what_its_shell_allows_and_the_coordinator_what_a_merge_is() {
    let opencode = adapter_for(FleetAgentKind::Opencode);
    let note = opencode.read_only_note(false, FLEET).unwrap();
    assert!(note.contains("git diff --no-ext-diff --no-textconv"));
    assert!(note.contains(FLEET));
    assert!(!note.contains("gh pr merge"));
    let merging = opencode.read_only_note(true, FLEET).unwrap();
    assert!(merging.contains("gh pr merge <number> --merge"));
    assert!(merging.contains("git merge --no-ff <branch>"));
    for kind in ALL_KINDS
        .into_iter()
        .filter(|kind| *kind != FleetAgentKind::Opencode)
    {
        assert_eq!(
            adapter_for(kind).read_only_note(false, FLEET),
            None,
            "{kind:?}"
        );
    }
}

// adapters.test.ts: opencode adapter > refuses an opencode that is not version 2 while starting, not once ready: it has no ready check (fixtures/screens: its help)
#[test]
fn opencode_has_no_ready_check() {
    assert!(
        adapter_for(FleetAgentKind::Opencode)
            .screen()
            .ready_error
            .is_none()
    );
}

// --- every CLI ---

// added (CLAUDE.md "エージェント CLI の癖"): every CLI starts in its own auto-approval mode, never in one that
// approves everything; agy's mode comes in --settings, not --mode auto (falls back to the default in agy 1.5.3)
#[test]
fn every_cli_starts_in_its_auto_mode_and_none_approves_everything() {
    let claude = args(FleetAgentKind::Claude, base());
    let at = claude
        .iter()
        .position(|arg| arg == "--permission-mode")
        .unwrap();
    assert_eq!(claude[at + 1], "auto");
    let codex = args(FleetAgentKind::Codex, base());
    assert!(codex.iter().any(|arg| arg == "--approve-for-me"));
    // --approve-for-me cannot be combined with --sandbox, and overrides sandbox_mode
    assert!(
        !codex
            .iter()
            .any(|arg| arg == "--sandbox" || arg.contains("sandbox_mode"))
    );
    assert!(
        args(FleetAgentKind::Cursor, base())
            .iter()
            .any(|arg| arg == "--auto-review")
    );
    let agy = args(FleetAgentKind::Agy, base());
    assert!(!agy.iter().any(|arg| arg == "--mode"));
    assert_eq!(agy_settings_of(&agy)["agentMode"], "auto");
    assert_eq!(agy_settings_of(&agy)["enableTerminalSandbox"], true);
    for kind in ALL_KINDS {
        // agy's settings refuse `git push --force`: the flags looked for are the CLI's own, outside that value
        let all = args(kind, base());
        let settings_at = all
            .iter()
            .position(|arg| arg == "--settings")
            .map(|at| at + 1);
        let joined = all
            .iter()
            .enumerate()
            .filter(|(at, _)| Some(*at) != settings_at)
            .map(|(_, arg)| arg.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        for everything in [
            "bypassPermissions",
            "--dangerously-skip-permissions",
            "--dangerously-bypass-approvals-and-sandbox",
            "--yolo",
            "--force",
            "danger-full-access",
        ] {
            assert!(!joined.contains(everything), "{kind:?}: {joined}");
        }
    }
}

// added: herdr refuses multiline argv, so no CLI's argv holds a line break, whatever the instructions hold
#[test]
fn no_argv_holds_a_line_break() {
    for kind in ALL_KINDS {
        for arg in args(kind, base()) {
            assert!(!arg.contains('\n'), "{kind:?}: {arg}");
        }
    }
}

// added: the CLIs configured by arguments give the pane no environment
#[test]
fn the_clis_configured_by_arguments_give_the_pane_no_environment() {
    let server_env = BTreeMap::from([("GIT_CONFIG_COUNT".to_owned(), "1".to_owned())]);
    let guard = launch::opencode::guard_plugin_dir();
    for kind in [
        FleetAgentKind::Pi,
        FleetAgentKind::Claude,
        FleetAgentKind::Codex,
        FleetAgentKind::Cursor,
    ] {
        assert_eq!(
            adapter_for(kind).env(&pane(&server_env, &guard)).unwrap(),
            BTreeMap::new(),
            "{kind:?}"
        );
    }
}

// --- kinds ---

// adapters.test.ts: kinds > splits a :level suffix off a model for the CLIs that take the level apart
#[test]
fn split_thinking_splits_a_level_suffix_off_a_model() {
    assert_eq!(
        split_thinking(Some("m:low"), Some(ThinkingLevel::High)),
        (Some("m"), Some(ThinkingLevel::Low))
    );
    assert_eq!(
        split_thinking(Some("m"), Some(ThinkingLevel::High)),
        (Some("m"), Some(ThinkingLevel::High))
    );
    assert_eq!(split_thinking(None, None), (None, None));
    // added: JavaScript's `.` takes no line terminator, so a model holding one keeps its suffix
    assert_eq!(
        split_thinking(Some("a\nb:low"), None),
        (Some("a\nb:low"), None)
    );
    // added: only the last colon starts a level
    assert_eq!(
        split_thinking(Some("p:m:max"), None),
        (Some("p:m"), Some(ThinkingLevel::Max))
    );
}

// adapters.test.ts: kinds > knows only the kinds it has an adapter for
#[test]
fn knows_only_the_kinds_it_has_an_adapter_for() {
    for kind in ALL_KINDS {
        assert_eq!(adapter_for(kind).kind, kind);
    }
    for name in ["pi", "claude", "codex", "cursor", "agy", "opencode"] {
        assert!(
            serde_json::from_value::<FleetAgentKind>(json!(name)).is_ok(),
            "{name}"
        );
    }
    for name in ["gemini", "toString"] {
        assert!(
            serde_json::from_value::<FleetAgentKind>(json!(name)).is_err(),
            "{name}"
        );
    }
}
