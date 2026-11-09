//! OpenCode's config for a fleet pane (`server/fleet/opencode-config.ts`): the safety tables
//! `fixtures/security/orchestrator/opencodeConfig.json` and `opencodeGitEnv.json` (ADR
//! 0122-parity-criteria), the guard plugin's folder (ADR 0242-phase-3-split, "fleet-guard のプラグインの場所"),
//! and the rules' verdicts, ported from `server/fleet/adapters.test.ts`'s opencode describe (each
//! test names the `it` it comes from).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use herdr_fleet_orchestrator::launch::opencode::{self, OpencodeRole};
use herdr_fleet_orchestrator::launch::{PaneContext, adapter_for};
use protocol::FleetAgentKind;
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn table(name: &str) -> Vec<Case> {
    let path = repo_root()
        .join("fixtures/security/orchestrator")
        .join(name);
    let text =
        fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    about: String,
    input: Value,
    expected: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RoleInput {
    result_dir: String,
    fleet_command: String,
    #[serde(default)]
    model: Option<String>,
    read_only: bool,
    merges: bool,
}

/// `value` with each `"$GUARD_PLUGIN"` string written as `guard` (ADR 0122-parity-criteria).
fn with_guard(value: &Value, guard: &str) -> Value {
    match value {
        Value::String(text) if text == "$GUARD_PLUGIN" => Value::String(guard.to_owned()),
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| with_guard(item, guard)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), with_guard(item, guard)))
                .collect(),
        ),
        other => other.clone(),
    }
}

// fixtures/security/orchestrator/opencodeConfig.json: every case, rules in order, keys in TypeScript's order
#[test]
fn the_config_table_passes() {
    let cases = table("opencodeConfig.json");
    assert_eq!(cases.len(), 9);
    let guard = opencode::guard_plugin_dir();
    let guard_text = guard.to_str().unwrap();
    for case in cases {
        let input: RoleInput = serde_json::from_value(case.input.clone())
            .unwrap_or_else(|error| panic!("{}: {error}", case.about));
        let role = OpencodeRole {
            result_dir: &input.result_dir,
            fleet_command: &input.fleet_command,
            model: input.model.as_deref(),
            read_only: input.read_only,
            merges: input.merges,
        };
        let actual = opencode::config(&role, &guard);
        let expected = with_guard(&case.expected, guard_text);
        assert_eq!(actual, expected, "{}", case.about);
        // OPENCODE_CONFIG_CONTENT is this JSON as text: the same keys in the same order as JSON.stringify writes them
        assert_eq!(
            serde_json::to_string(&actual).unwrap(),
            serde_json::to_string(&expected).unwrap(),
            "{}",
            case.about
        );
    }
}

// fixtures/security/orchestrator/opencodeGitEnv.json: every case
#[test]
fn the_git_env_table_passes() {
    let cases = table("opencodeGitEnv.json");
    assert_eq!(cases.len(), 10);
    for case in cases {
        let base: BTreeMap<String, String> = serde_json::from_value(case.input.clone())
            .unwrap_or_else(|error| panic!("{}: {error}", case.about));
        let expected: BTreeMap<String, String> = serde_json::from_value(case.expected.clone())
            .unwrap_or_else(|error| panic!("{}: {error}", case.about));
        assert_eq!(opencode::git_env(&base), expected, "{}", case.about);
    }
}

// --- the guard plugin's folder (ADR 0242-phase-3-split) ---

// added: three folders above the orchestrator crate's, where the checkout keeps opencode/fleet-guard
#[test]
fn the_guard_plugin_is_the_checkouts_opencode_fleet_guard() {
    let guard = opencode::guard_plugin_dir();
    assert_eq!(
        fs::canonicalize(&guard).unwrap(),
        fs::canonicalize(repo_root().join("opencode/fleet-guard")).unwrap()
    );
    assert!(guard.is_absolute());
    assert!(guard.join("index.js").is_file());
}

fn no_env() -> BTreeMap<String, String> {
    BTreeMap::new()
}

fn pane<'a>(server_env: &'a BTreeMap<String, String>, guard: &'a Path) -> PaneContext<'a> {
    PaneContext {
        result_dir: "/state/fleet-results/r1",
        fleet_command: FLEET,
        model: None,
        read_only: true,
        merges: false,
        server_env,
        guard_plugin: guard,
    }
}

// added: a role that edits nothing does not start without its guard: the error names the folder looked in
#[test]
fn a_read_only_run_does_not_start_without_the_guard() {
    let server_env = no_env();
    let scratch =
        std::env::temp_dir().join(format!("herdr-fleet-guard-test-{}", std::process::id()));
    let empty = scratch.join("fleet-guard");
    fs::create_dir_all(&empty).unwrap();
    let opencode = adapter_for(FleetAgentKind::Opencode);
    for merges in [false, true] {
        let error = opencode
            .env(&PaneContext {
                merges,
                ..pane(&server_env, &empty)
            })
            .unwrap_err();
        assert!(
            error.message.contains(empty.to_str().unwrap()),
            "{}",
            error.message
        );
        assert!(error.message.contains("index.js"), "{}", error.message);
    }
    // a folder that is not there at all, too
    let missing = scratch.join("not-there");
    let error = opencode.env(&pane(&server_env, &missing)).unwrap_err();
    assert!(
        error.message.contains(missing.to_str().unwrap()),
        "{}",
        error.message
    );
    // a role that edits loads no plugin, so it starts
    assert!(
        opencode
            .env(&PaneContext {
                read_only: false,
                ..pane(&server_env, &missing)
            })
            .is_ok()
    );
    // with the guard there, the config names it
    fs::write(empty.join("index.js"), "").unwrap();
    let env = opencode.env(&pane(&server_env, &empty)).unwrap();
    let config: Value = serde_json::from_str(&env["OPENCODE_CONFIG_CONTENT"]).unwrap();
    assert_eq!(config["plugins"][0]["package"], empty.to_str().unwrap());
    fs::remove_dir_all(&scratch).unwrap();
}

// --- the rules' verdicts (adapters.test.ts: opencode adapter) ---

const FLEET: &str = "/usr/bin/bun /opt/fleet/bin/fleet.ts";
const RESULT_DIR: &str = "/state/fleet-results/r1";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
struct Rule {
    action: String,
    resource: String,
    effect: String,
}

fn rule(action: &str, resource: &str, effect: &str) -> Rule {
    Rule {
        action: action.to_owned(),
        resource: resource.to_owned(),
        effect: effect.to_owned(),
    }
}

fn config_of(read_only: bool, merges: bool) -> Value {
    let role = OpencodeRole {
        result_dir: RESULT_DIR,
        fleet_command: FLEET,
        model: None,
        read_only,
        merges,
    };
    opencode::config(&role, &opencode::guard_plugin_dir())
}

fn rules_in(value: &Value) -> Vec<Rule> {
    serde_json::from_value(value.clone()).unwrap()
}

/// OpenCode 2.0.26, packages/core/src: `Wildcard.match` (util/wildcard.ts), as adapters.test.ts writes it.
fn wildcard(input: &str, pattern: &str) -> bool {
    let mut source = String::new();
    for c in pattern.replace('\\', "/").chars() {
        match c {
            '*' => source.push_str(".*"),
            '?' => source.push('.'),
            '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                source.push('\\');
                source.push(c);
            }
            _ => source.push(c),
        }
    }
    if let Some(stem) = source.strip_suffix(" .*") {
        source = format!("{stem}( .*)?");
    }
    Regex::new(&format!("(?s)^{source}$"))
        .unwrap()
        .is_match(&input.replace('\\', "/"))
}

/// `Permission.evaluate` (permission.ts): the last rule that matches.
fn evaluate(action: &str, resource: &str, rules: &[Rule]) -> String {
    rules
        .iter()
        .rev()
        .find(|rule| wildcard(action, &rule.action) && wildcard(resource, &rule.resource))
        .map_or_else(|| "ask".to_owned(), |rule| rule.effect.clone())
}

/// Denied when any resource is denied; else asked when any resource has no allow as its last match.
fn decide(rules: &[Rule], action: &str, resources: &[&str]) -> &'static str {
    if resources
        .iter()
        .any(|resource| evaluate(action, resource, rules) == "deny")
    {
        "deny"
    } else if resources
        .iter()
        .any(|resource| evaluate(action, resource, rules) == "ask")
    {
        "ask"
    } else {
        "allow"
    }
}

/// What OpenCode puts before a config's rules for a primary agent of the config (read from /api/agent of the real binary).
fn schema_default() -> Vec<Rule> {
    vec![
        rule("*", "*", "allow"),
        rule("read", "*.env", "ask"),
        rule("read", "*.env.*", "ask"),
        rule("read", "*.env.example", "allow"),
    ]
}

fn read_only_rules(merges: bool) -> Vec<Rule> {
    let mut rules = schema_default();
    rules.extend(rules_in(
        &config_of(true, merges)["agents"]["fleet-readonly"]["permissions"],
    ));
    rules
}

fn editor_rules(before: &[Rule]) -> Vec<Rule> {
    let mut rules = schema_default();
    rules.extend_from_slice(before);
    rules.extend(rules_in(&config_of(false, false)["permissions"]));
    rules
}

/// The verdict for a shell line, given the commands the scanner finds in it.
fn shell(rules: &[Rule], commands: &[&str]) -> &'static str {
    decide(rules, "shell", commands)
}

// adapters.test.ts: opencode adapter > never writes an ask, and never allows everything
#[test]
fn never_writes_an_ask_and_never_allows_everything() {
    for (read_only, merges) in [(false, false), (true, false), (true, true)] {
        let config = config_of(read_only, merges);
        let mut rules = config.get("permissions").map(rules_in).unwrap_or_default();
        if let Some(Value::Object(agents)) = config.get("agents") {
            for agent in agents.values() {
                rules.extend(rules_in(&agent["permissions"]));
            }
        }
        assert!(!rules.is_empty());
        assert!(!rules.iter().any(|rule| rule.effect == "ask"));
        assert!(
            !rules
                .iter()
                .any(|rule| rule.effect == "allow" && rule.action == "*")
        );
    }
}

// adapters.test.ts: opencode adapter > a role that edits nothing > is the default agent, with its rules and the guard plugin of this pane alone
#[test]
fn a_read_only_role_is_the_default_agent_with_its_rules_and_the_guard_plugin_alone() {
    let config = config_of(true, false);
    assert_eq!(config["default_agent"], "fleet-readonly");
    assert_eq!(opencode::READ_ONLY_AGENT, "fleet-readonly");
    assert_eq!(config["agents"]["fleet-readonly"]["mode"], "primary");
    assert_eq!(config.get("permissions"), None);
    assert_eq!(
        rules_in(&config["agents"]["fleet-readonly"]["permissions"])[0],
        rule("*", "*", "deny")
    );
    let plugins = config["plugins"].as_array().unwrap();
    assert_eq!(plugins.len(), 1);
    let package = plugins[0]["package"].as_str().unwrap();
    assert!(package.ends_with("/opencode/fleet-guard"), "{package}");
    assert!(Path::new(package).join("index.js").exists());
    // the guard is told the fleet command, and whether this role merges
    assert_eq!(
        plugins[0]["options"],
        serde_json::json!({ "fleetCommand": FLEET, "merges": false })
    );
    assert_eq!(
        config_of(true, true)["plugins"][0]["options"],
        serde_json::json!({ "fleetCommand": FLEET, "merges": true })
    );
    let editing = config_of(false, false);
    assert_eq!(editing.get("default_agent"), None);
    assert_eq!(editing.get("agents"), None);
    assert_eq!(editing.get("plugins"), None);
}

// adapters.test.ts: opencode adapter > a role that edits nothing > reads, searches and runs the short list of read-only commands and the fleet command
#[test]
fn a_read_only_role_reads_searches_and_runs_the_short_list() {
    let rules = read_only_rules(false);
    for action in ["read", "glob", "grep"] {
        assert_eq!(decide(&rules, action, &["src/a.ts"]), "allow", "{action}");
    }
    let list = format!("{FLEET} list");
    let send = format!("{FLEET} send lead \"go\"");
    let quoted = format!("{FLEET} send lead 'a; b'");
    for text in [
        "ls",
        "pwd",
        "git status",
        "git ls-files",
        &list,
        &send,
        &quoted,
        "gh pr view 5 --json title",
        "gh pr list",
        "gh pr checks 5",
        "gh run view 99 --log-failed",
    ] {
        assert_eq!(shell(&rules, &[text]), "allow", "{text}");
    }
    for command in ["diff", "log", "show"] {
        let text = format!("git {command} --no-ext-diff --no-textconv HEAD~1 -- src/a.ts");
        assert_eq!(shell(&rules, &[&text]), "allow", "{text}");
    }
}

// adapters.test.ts: opencode adapter > a role that edits nothing > refuses what it does not list, the web, a subagent, and a .env file
#[test]
fn a_read_only_role_refuses_what_it_does_not_list() {
    let rules = read_only_rules(false);
    for text in [
        "rm -rf build",
        "cat src/a.ts",
        "ls -la",
        "git status --short",
        "git push",
        "git commit -m x",
        "git diff",
        "git log",
        "git show HEAD",
        "git diff HEAD~1",
        "git log -1",
        "bun test",
        "FOO=1 ls",
        "env ls",
        "bash -c ls",
        "eval ls",
        "xargs rm",
        "git -C /etc status",
        "gh pr merge 5 --merge",
        "gh pr create",
        "gh api /user",
    ] {
        assert_eq!(shell(&rules, &[text]), "deny", "{text}");
    }
    for action in [
        "webfetch",
        "websearch",
        "subagent",
        "skill",
        "execute",
        "task",
        "lsp",
    ] {
        assert_eq!(decide(&rules, action, &["*"]), "deny", "{action}");
    }
    assert_eq!(decide(&rules, "read", &[".env"]), "deny");
    assert_eq!(decide(&rules, "read", &["config/.env.local"]), "deny");
    assert_eq!(decide(&rules, "read", &[".env.example"]), "allow");
    // a file outside the work folder is asked as an external directory first
    assert_eq!(decide(&rules, "external_directory", &["/etc/*"]), "deny");
}

// adapters.test.ts: opencode adapter > a role that edits nothing > refuses a second command, a substitution or a redirect that comes with a listed one
#[test]
fn a_read_only_role_refuses_a_second_command_a_substitution_or_a_redirect() {
    let rules = read_only_rules(false);
    assert_eq!(shell(&rules, &["ls", "rm -rf ~"]), "deny");
    assert_eq!(shell(&rules, &["ls $(rm x)", "rm x"]), "deny");
    for text in [
        "ls > ~/y",
        "ls >> f",
        "ls >| f",
        "ls 3>f",
        "ls 2>&1",
        "git status > f",
        "git show HEAD:f > ~/.bashrc",
        "cat < /etc/passwd",
        "gh pr view 5 --json a > f",
        "git log --no-ext-diff --no-textconv > f",
    ] {
        assert_eq!(shell(&rules, &[text]), "deny", "{text}");
    }
    // the fleet command takes quoted text that may hold < and >, so the rules let it through; the guard parses its quotes
    let arrow = format!("{FLEET} send lead \"a -> b\"");
    assert_eq!(shell(&rules, &[&arrow]), "allow");
}

// adapters.test.ts: opencode adapter > a role that edits nothing > lets git history through only in the form that runs no helper and writes no file
#[test]
fn a_read_only_role_runs_git_history_only_in_the_form_that_runs_no_helper() {
    let rules = read_only_rules(false);
    let history = |tail: &str| {
        shell(
            &rules,
            &[&format!("git diff --no-ext-diff --no-textconv {tail}")],
        )
    };
    assert_eq!(history("main...HEAD"), "allow");
    assert_eq!(history("HEAD~3 -- src"), "allow");
    // two paths outside the repository make git diff an implicit --no-index
    for tail in [
        "/dev/null /etc/passwd",
        "~/.ssh/id_ed25519",
        "../outside",
        "..",
        "--stat=/x",
        "HEAD -- ../x",
    ] {
        assert_eq!(history(tail), "deny", "{tail}");
    }
    for flag in [
        "--output=/tmp/x",
        "--output /tmp/x",
        "--no-index a b",
        "--ext-diff",
        "--textconv",
    ] {
        assert_eq!(history(flag), "deny", "{flag}");
    }
    // the shell drops quotes, backslashes and expansions before git reads the line
    for tail in [
        r#"--ex""t-diff"#,
        "--ex''t-diff",
        "--ext$X-diff",
        "--ext`true`-diff",
        "--ext{-diff,}",
        r#""--output=/tmp/x""#,
    ] {
        assert_eq!(history(tail), "deny", "{tail}");
    }
    assert_eq!(
        shell(
            &rules,
            &["git log --no-ext-diff --no-textconv --oneline -n 20"]
        ),
        "allow"
    );
    assert_eq!(
        shell(
            &rules,
            &["git show --no-ext-diff --no-textconv HEAD:src/a.ts"]
        ),
        "allow"
    );
}

// adapters.test.ts: opencode adapter > a role that edits nothing > edits only its result file: that path, and its folder as an external directory
#[test]
fn a_read_only_role_edits_only_its_result_file() {
    let rules = read_only_rules(false);
    assert_eq!(
        decide(&rules, "edit", &[&format!("{RESULT_DIR}/handoff.md")]),
        "allow"
    );
    assert_eq!(
        decide(&rules, "external_directory", &[&format!("{RESULT_DIR}/*")]),
        "allow"
    );
    assert_eq!(decide(&rules, "edit", &["src/a.ts"]), "deny");
    assert_eq!(decide(&rules, "edit", &["/etc/passwd"]), "deny");
    // the folder of another run
    assert_eq!(
        decide(&rules, "edit", &["/state/fleet-results/r10/handoff.md"]),
        "deny"
    );
    assert_eq!(
        decide(
            &rules,
            "external_directory",
            &["/state/fleet-results/r10/*"]
        ),
        "deny"
    );
}

// adapters.test.ts: opencode adapter > a role that edits nothing > merges only when it is the project's coordinator, and only the forms the fleet asks for
#[test]
fn a_read_only_role_merges_only_as_the_coordinator_and_only_in_the_fleets_forms() {
    let merges = [
        "gh pr merge 12 --merge",
        "git pull --ff-only",
        "git merge --no-ff fleet/ab12cd",
        "git merge --no-ff agents/worker-ab12",
        "git merge --abort",
    ];
    for text in merges {
        assert_eq!(shell(&read_only_rules(true), &[text]), "allow", "{text}");
        assert_eq!(shell(&read_only_rules(false), &[text]), "deny", "{text}");
    }
    let rules = read_only_rules(true);
    for text in [
        "gh pr merge 12 --merge --admin",
        "gh pr merge --admin --merge",
        "gh pr merge -d --merge",
        "gh pr merge 12 -d --merge",
        "gh pr merge 12 --squash",
        "gh pr merge 12",
        "git pull",
        "git pull --ff-only origin x",
        "git merge main",
        "git merge --no-ff main",
        "git merge --no-ff fleet/x main",
        "git merge --no-ff fleet/x -s ours",
        "git merge --no-ff fleet/x -F /etc/passwd",
        "git push",
        "git merge --no-ff fleet/x > f",
        r#"git merge --no-ff fleet/x"y""#,
        "git checkout main",
    ] {
        assert_eq!(shell(&rules, &[text]), "deny", "{text}");
    }
}

// adapters.test.ts: opencode adapter > a role that edits > keeps the defaults, and the person's own denies
#[test]
fn an_editing_role_keeps_the_defaults_and_the_persons_own_denies() {
    let rules = editor_rules(&[]);
    for text in [
        "bun test",
        "git commit -m x",
        "git push origin feat/x",
        "git push -u origin feat/x",
        "rm -rf build",
    ] {
        assert_eq!(shell(&rules, &[text]), "allow", "{text}");
    }
    let personal = [rule("shell", "*", "ask"), rule("shell", "rm *", "deny")];
    assert_eq!(shell(&editor_rules(&personal), &["rm -rf x"]), "deny");
    assert_eq!(shell(&editor_rules(&personal), &["bun test"]), "ask");
    // its fleet command still gets through a shell that asks
    assert_eq!(
        shell(
            &editor_rules(&personal),
            &[&format!("{FLEET} send architect \"q\"")]
        ),
        "allow"
    );
}

// adapters.test.ts: opencode adapter > a role that edits > refuses a push that overwrites the remote, in the forms git takes it
#[test]
fn an_editing_role_refuses_a_push_that_overwrites_the_remote() {
    let rules = editor_rules(&[]);
    for text in [
        "git push --force",
        "git push --force origin main",
        "git push origin main --force",
        "git push --force-with-lease",
        "git push --force-if-includes origin x",
        "git push origin x --force-with-lease=x:abc",
        "git push -f",
        "git push -f origin main",
        "git push origin main -f",
        "git push -fu origin main",
        "git push -uf origin main",
        "git push -nf origin x",
        "git push -vuf origin x",
        "git push -nvf origin x",
        "git push --mir",
        "git push --pru origin",
        "git push --prun origin",
        "git push --mirror",
        "git push --del origin main",
        "git push --delete origin main",
        "git push -d origin main",
        "git push origin :main",
        "git push --prune origin",
        "git push origin +main",
        "git push +main",
        "git push origin +HEAD:main",
        "git -C ../wt push -f",
        "git -c push.default=current push --force",
    ] {
        assert_eq!(shell(&rules, &[text]), "deny", "{text}");
    }
    for text in [
        "git push",
        "git push origin main",
        "git push -u origin fix-foo",
        "git push origin HEAD:refs/heads/a-f",
        "git push --follow-tags",
        "git push origin feat/x-fix",
        "git stash push",
        "git push -u origin feat/x",
        "git push --dry-run origin x",
        "git push -u fork feat/x",
        "git push -u fork",
        "git push -v fork main",
        "git push -n fork main",
    ] {
        assert_eq!(shell(&rules, &[text]), "allow", "{text}");
    }
}

// adapters.test.ts: opencode adapter > a role that edits > edits inside its work folder and its result folder, and nowhere else
#[test]
fn an_editing_role_edits_inside_its_work_folder_and_its_result_folder_only() {
    let rules = editor_rules(&[]);
    assert_eq!(decide(&rules, "edit", &["src/a.ts"]), "allow");
    assert_eq!(decide(&rules, "edit", &["a/b/c.ts"]), "allow");
    assert_eq!(decide(&rules, "edit", &["/etc/passwd"]), "deny");
    assert_eq!(decide(&rules, "edit", &["/home/x/other/a.ts"]), "deny");
    assert_eq!(decide(&rules, "edit", &["../other.ts"]), "deny");
    assert_eq!(
        decide(&rules, "edit", &[&format!("{RESULT_DIR}/handoff.md")]),
        "allow"
    );
    assert_eq!(
        decide(&rules, "edit", &["/state/fleet-results/r10/handoff.md"]),
        "deny"
    );
    // a person's external_directory ask does not stop the result file
    let asked = editor_rules(&[rule("external_directory", "*", "ask")]);
    assert_eq!(
        decide(&asked, "external_directory", &[&format!("{RESULT_DIR}/*")]),
        "allow"
    );
}

// adapters.test.ts: opencode adapter > tells a role that edits nothing what its shell allows (the note as opencodeReadOnlyNote writes it)
#[test]
fn the_read_only_note_lists_the_forms_and_the_merges_only_for_the_coordinator() {
    let note = opencode::read_only_note(false, FLEET);
    assert!(note.starts_with("Your shell accepts only these command lines"));
    assert!(note.contains(&format!("- {FLEET} ... (arguments are plain words")));
    assert!(!note.contains("gh pr merge"));
    assert_eq!(note.lines().count(), 8);
    let merging = opencode::read_only_note(true, FLEET);
    assert_eq!(merging.lines().count(), 9);
    assert!(merging.contains("- for a merge the fleet asks you for: gh pr merge <number> --merge, git pull --ff-only, git merge --no-ff <branch>, git merge --abort"));
    assert_eq!(
        adapter_for(FleetAgentKind::Opencode).read_only_note(true, FLEET),
        Some(merging)
    );
}
