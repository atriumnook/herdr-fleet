//! Role discovery: from `server/fleet/agents.test.ts`, each test naming its `it`, and the
//! frontmatter cases whose expected values are what TypeScript's `discoverAgents` (Bun 1.4.4's
//! `Bun.YAML.parse`) read from the same files. Every test reads the role folders of a temporary
//! root, the bundled folder of the repository, and never the person's `~/.config/herdr-fleet`.

use std::fs;
use std::hash::{BuildHasher, Hasher, RandomState};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use herdr_fleet_orchestrator::agents::{
    AgentDefinition, AgentDirs, RoleSource, RoleVersion, bundled_agents_dir, content_hash,
    discover_agents, find_agent, role_version,
};
use herdr_fleet_orchestrator::config::RoleOverride;
use protocol::{FleetAgentKind, ThinkingLevel};

/// A new folder no other test uses, removed when the test ends however it ends.
struct Root(PathBuf);

impl Root {
    fn new() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        loop {
            let mut hasher = RandomState::new().build_hasher();
            hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
            let root = std::env::temp_dir().join(format!("fleet-agents-{:016x}", hasher.finish()));
            match fs::create_dir(&root) {
                Ok(()) => return Root(root),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("{}: {error}", root.display()),
            }
        }
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A user role folder and a repository with `.herdr-fleet/agents`, as agents.test.ts's `fixture`.
struct Fixture {
    root: Root,
    cwd: PathBuf,
    dirs: AgentDirs,
}

fn fixture(project: &[(&str, &str)], user: &[(&str, &str)]) -> Fixture {
    let root = Root::new();
    let user_dir = root.0.join("user-agents");
    let project_dir = root.0.join("repo").join(".herdr-fleet").join("agents");
    fs::create_dir_all(&user_dir).unwrap();
    fs::create_dir_all(&project_dir).unwrap();
    for (name, text) in user {
        fs::write(user_dir.join(name), text).unwrap();
    }
    for (name, text) in project {
        fs::write(project_dir.join(name), text).unwrap();
    }
    let cwd = root.0.join("repo");
    Fixture {
        root,
        cwd,
        dirs: AgentDirs {
            bundled: bundled_agents_dir(),
            user: user_dir,
        },
    }
}

impl Fixture {
    fn discover(&self) -> Vec<AgentDefinition> {
        discover_agents(&self.cwd, &mut Vec::new(), &self.dirs)
    }
}

fn find<'a>(agents: &'a [AgentDefinition], role: &str) -> &'a AgentDefinition {
    find_agent(agents, role).unwrap_or_else(|| panic!("no role {role}"))
}

fn strings(items: &[&str]) -> Option<Vec<String>> {
    Some(items.iter().map(|item| item.to_string()).collect())
}

// agents.test.ts: "loads the bundled scout, planner, worker and reviewer as pi roles, a thread's lead on claude then codex, a project's coordinator and a lead's architect on claude, editing nothing"
#[test]
fn loads_the_bundled_roles() {
    let fixture = fixture(&[], &[]);
    let agents = fixture.discover();
    let mut names: Vec<&str> = agents.iter().map(|agent| agent.name.as_str()).collect();
    names.sort();
    assert_eq!(
        names,
        [
            "architect",
            "coordinator",
            "lead",
            "planner",
            "reviewer",
            "scout",
            "worker"
        ]
    );

    let coordinator = find(&agents, "coordinator");
    assert_eq!(coordinator.agent, FleetAgentKind::Claude);
    assert_eq!(
        (
            coordinator.interactive,
            coordinator.spawning,
            coordinator.edits
        ),
        (Some(true), Some(true), Some(false))
    );
    assert_eq!(coordinator.fallback_models, None);

    let architect = find(&agents, "architect");
    assert_eq!(architect.agent, FleetAgentKind::Claude);
    assert_eq!(
        (architect.interactive, architect.spawning, architect.edits),
        (Some(false), Some(false), Some(false))
    );

    let lead = find(&agents, "lead");
    assert_eq!(lead.agent, FleetAgentKind::Claude);
    assert_eq!(lead.fallback_models, strings(&["codex:"]));
    assert_eq!((lead.interactive, lead.spawning), (Some(true), Some(true)));

    let worker = find(&agents, "Worker");
    assert_eq!(worker.agent, FleetAgentKind::Pi);
    assert_eq!(worker.source, RoleSource::Bundled);
    assert_eq!(worker.interactive, Some(false));
    assert_eq!(worker.thinking, Some(ThinkingLevel::High));
    assert!(
        find(&agents, "worker")
            .tools
            .as_ref()
            .unwrap()
            .iter()
            .any(|tool| tool == "bash")
    );
}

// agents.test.ts: "lets the user's role, then the project's, replace a bundled one of the same name"
#[test]
fn lets_the_users_role_then_the_projects_replace_a_bundled_one_of_the_same_name() {
    let role = |who: &str| format!("---\nname: worker\ndescription: {who}\n---\n{who} worker");
    let fixture = fixture(
        &[("worker.md", &role("project"))],
        &[("worker.md", &role("user"))],
    );
    let agents = fixture.discover();
    let worker = find(&agents, "worker");
    assert_eq!(worker.source, RoleSource::Project);
    assert_eq!(worker.description, "project");
    assert_eq!(worker.system_prompt, "project worker");
}

// agents.test.ts: "skips a broken role file with a warning and keeps the rest"
#[test]
fn skips_a_broken_role_file_with_a_warning_and_keeps_the_rest() {
    let fixture = fixture(
        &[
            // an unquoted colon inside a value is invalid YAML
            (
                "scout.md",
                "---\nname: scout\ndescription: Fast: locate files\n---\nbroken",
            ),
            ("odd.md", "---\nname: odd\nagent: vim\n---\nunknown agent"),
            (
                "helper.md",
                "---\nname: helper\ndescription: \"A valid project role\"\nfallbackModels: p/a, p/b\n---\nYou are a helper.",
            ),
        ],
        &[],
    );
    let mut warnings = Vec::new();
    let agents = discover_agents(&fixture.cwd, &mut warnings, &fixture.dirs);
    assert_eq!(find(&agents, "scout").source, RoleSource::Bundled);
    let helper = find(&agents, "helper");
    assert_eq!(helper.fallback_models, strings(&["p/a", "p/b"]));
    assert_eq!(helper.system_prompt, "You are a helper.");
    assert!(find_agent(&agents, "odd").is_none());
    let skipped: Vec<bool> = warnings
        .iter()
        .filter(|warning| warning.starts_with("fleet: skipping invalid role file"))
        .map(|warning| warning.contains("scout.md") || warning.contains("odd.md"))
        .collect();
    assert_eq!(skipped, [true, true], "{warnings:?}");
}

// agents.test.ts: "reads whether a role edits files"
#[test]
fn reads_whether_a_role_edits_files() {
    let fixture = fixture(
        &[(
            "watcher.md",
            "---\nname: watcher\nagent: claude\nedits: false\n---\nYou read.",
        )],
        &[],
    );
    let agents = fixture.discover();
    assert_eq!(find(&agents, "watcher").edits, Some(false));
    assert_eq!(find(&agents, "worker").edits, None);
}

// agents.test.ts: "versions each role by the sha256 of its file's bytes, an override by its own file"
#[test]
fn versions_each_role_by_the_sha256_of_its_files_bytes_an_override_by_its_own_file() {
    // expected values: `printf -- '<the file>' | sha256sum`, first 12 hex digits
    let fixture = fixture(
        &[("helper.md", "---\nname: helper\n---\nYou are a helper.")],
        &[("Helper2.md", "---\nname: helper\n---\nYou are a helper!")],
    );
    let agents = fixture.discover();
    assert_eq!(
        role_version(find(&agents, "helper")),
        RoleVersion {
            role: "helper".into(),
            source: RoleSource::Project,
            file: fixture
                .cwd
                .join(".herdr-fleet")
                .join("agents")
                .join("helper.md"),
            hash: "bc0cbd7ea75e".into(),
        }
    );
    let user_only = self::fixture(
        &[],
        &[("helper.md", "---\nname: helper\n---\nYou are a helper!")],
    );
    let version = role_version(find(&user_only.discover(), "helper"));
    assert_eq!(
        (version.source, version.hash.as_str()),
        (RoleSource::User, "d4b14c1421bc")
    );
    assert_eq!(content_hash("Always commit."), "3ccec6fa91ae");
    for agent in &agents {
        let hash = role_version(agent).hash;
        assert!(
            hash.len() == 12
                && hash
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')),
            "{hash}"
        );
    }
}

// agents.test.ts: "reads a file without frontmatter as all body". `parseFrontmatter` is not public in
// Rust (ADR 0247-roles-and-config), so the two files go through discovery: the first is all body,
// the second has the frontmatter `{ name: "x" }` and the body "body".
#[test]
fn reads_a_file_without_frontmatter_as_all_body() {
    let fixture = fixture(
        &[
            ("plain.md", "just text"),
            ("named.md", "---\nname: x\n---\nbody"),
        ],
        &[],
    );
    let agents = fixture.discover();
    let plain = find(&agents, "plain");
    assert_eq!(
        (plain.description.as_str(), plain.system_prompt.as_str()),
        ("plain", "just text")
    );
    let named = find(&agents, "x");
    assert_eq!(
        (named.description.as_str(), named.system_prompt.as_str()),
        ("x", "body")
    );
}

/// One role file's fields as TypeScript's `discoverAgents` printed them (filePath left out).
struct Read {
    name: &'static str,
    description: &'static str,
    agent: FleetAgentKind,
    model: Option<&'static str>,
    tools: Option<Vec<String>>,
    edits: Option<bool>,
    system_prompt: &'static str,
    hash: &'static str,
}

// Not in agents.test.ts: frontmatter read as Bun 1.4.4's YAML reads it. Each expected value is the
// line TypeScript's `discoverAgents` printed for the same file (YAML 1.2's core schema: `False` is
// a boolean, `no` a string, `Null` a null; a folded scalar keeps its last line break; a repeated
// key keeps its last value; a list item that is not a string is dropped).
#[test]
fn reads_frontmatter_as_bun_reads_yaml() {
    let files = [
        (
            "caps.md",
            "---\nname: caps\nedits: False\nmodel: Null\n---\nx",
        ),
        (
            "yesno.md",
            "---\nname: yesno\nedits: no\nmodel: 1.5\n---\nx",
        ),
        (
            "folded.md",
            "---\nname: folded\ndescription: >\n  folded\n  text\ntools:\n  - read\n  - bash\n---\nx",
        ),
        ("dup.md", "---\nname: dup\nmodel: a\nmodel: b\n---\nx"),
        ("empty.md", "---\n\n---\n  body  \n"),
        (
            "mixed.md",
            "---\nname: mixed\ntools: [read, 3, \" bash \", \"\"]\nfallbackModels: []\nthinking: turbo\nagent: codex\n---\nx",
        ),
        ("noname.md", "---\ndescription: d\n---\nx"),
        ("crlf.md", "---\r\nname: crlf\r\n---\r\nbody\r\n"),
    ];
    let fixture = fixture(&files, &[]);
    let dirs = AgentDirs {
        bundled: "/nonexistent".into(),
        user: "/nonexistent".into(),
    };
    let mut warnings = Vec::new();
    let agents = discover_agents(&fixture.cwd, &mut warnings, &dirs);
    assert_eq!(warnings, Vec::<String>::new());
    let expected = [
        Read {
            name: "caps",
            description: "caps",
            agent: FleetAgentKind::Pi,
            model: None,
            tools: None,
            edits: Some(false),
            system_prompt: "x",
            hash: "672fe4c8ca2a",
        },
        Read {
            name: "yesno",
            description: "yesno",
            agent: FleetAgentKind::Pi,
            model: None,
            tools: None,
            edits: None,
            system_prompt: "x",
            hash: "d6341b668d70",
        },
        Read {
            name: "folded",
            description: "folded text\n",
            agent: FleetAgentKind::Pi,
            model: None,
            tools: strings(&["read", "bash"]),
            edits: None,
            system_prompt: "x",
            hash: "5fb8f05c91b0",
        },
        Read {
            name: "dup",
            description: "dup",
            agent: FleetAgentKind::Pi,
            model: Some("b"),
            tools: None,
            edits: None,
            system_prompt: "x",
            hash: "0564b9d70c83",
        },
        Read {
            name: "empty",
            description: "empty",
            agent: FleetAgentKind::Pi,
            model: None,
            tools: None,
            edits: None,
            system_prompt: "body",
            hash: "ea4b20e7def5",
        },
        Read {
            name: "mixed",
            description: "mixed",
            agent: FleetAgentKind::Codex,
            model: None,
            tools: strings(&["read", "bash"]),
            edits: None,
            system_prompt: "x",
            hash: "b3596fd9fa15",
        },
        Read {
            name: "noname",
            description: "d",
            agent: FleetAgentKind::Pi,
            model: None,
            tools: None,
            edits: None,
            system_prompt: "x",
            hash: "c51aa82eec72",
        },
        Read {
            name: "crlf",
            description: "crlf",
            agent: FleetAgentKind::Pi,
            model: None,
            tools: None,
            edits: None,
            system_prompt: "body",
            hash: "0eac9db14f19",
        },
    ];
    assert_eq!(agents.len(), expected.len());
    for want in expected {
        let got = find(&agents, want.name);
        assert_eq!(got.description, want.description, "{}", want.name);
        assert_eq!(got.agent, want.agent, "{}", want.name);
        assert_eq!(got.model.as_deref(), want.model, "{}", want.name);
        assert_eq!(got.tools, want.tools, "{}", want.name);
        assert_eq!(got.edits, want.edits, "{}", want.name);
        assert_eq!(got.thinking, None, "{}", want.name);
        assert_eq!(got.fallback_models, None, "{}", want.name);
        assert_eq!(got.system_prompt, want.system_prompt, "{}", want.name);
        assert_eq!(got.hash.as_deref(), Some(want.hash), "{}", want.name);
        assert_eq!(got.source, RoleSource::Project, "{}", want.name);
    }
}

// Not in agents.test.ts: the files TypeScript skipped, with its reasons (`frontmatter must be a
// mapping`, `unknown agent null`), are skipped with a warning naming each file.
#[test]
fn skips_frontmatter_that_is_not_a_mapping_and_an_agent_of_null() {
    let fixture = fixture(
        &[
            ("list.md", "---\n- a\n- b\n---\nx"),
            ("scalar.md", "---\njust a string\n---\nx"),
            ("nullagent.md", "---\nname: nullagent\nagent: null\n---\nx"),
        ],
        &[],
    );
    let dirs = AgentDirs {
        bundled: "/nonexistent".into(),
        user: "/nonexistent".into(),
    };
    let mut warnings = Vec::new();
    let agents = discover_agents(&fixture.cwd, &mut warnings, &dirs);
    assert!(
        agents.is_empty(),
        "{:?}",
        agents.iter().map(|agent| &agent.name).collect::<Vec<_>>()
    );
    let folder = fixture.cwd.join(".herdr-fleet").join("agents");
    warnings.sort();
    assert_eq!(
        warnings,
        [
            format!(
                "fleet: skipping invalid role file {}: frontmatter must be a mapping",
                folder.join("list.md").display()
            ),
            format!(
                "fleet: skipping invalid role file {}: unknown agent null",
                folder.join("nullagent.md").display()
            ),
            format!(
                "fleet: skipping invalid role file {}: frontmatter must be a mapping",
                folder.join("scalar.md").display()
            ),
        ]
    );
}

// Not in agents.test.ts: the project's roles come from the nearest `.herdr-fleet/agents` above the
// folder (`findProjectPath`), as for a thread working in a subfolder of the repository.
#[test]
fn finds_the_projects_roles_from_a_subfolder() {
    let fixture = fixture(
        &[("helper.md", "---\nname: helper\n---\nYou are a helper.")],
        &[],
    );
    let deep = fixture.cwd.join("src").join("deep");
    fs::create_dir_all(&deep).unwrap();
    let agents = discover_agents(&deep, &mut Vec::new(), &fixture.dirs);
    assert_eq!(find(&agents, "helper").source, RoleSource::Project);
}

// Not in agents.test.ts: the user's roles live in `<the user's fleet folder>/agents`
// (`agents.ts:64`), and the bundled ones in the repository's `agents/`.
#[test]
fn places_the_users_roles_in_the_fleet_folder() {
    let dirs = AgentDirs::new(Path::new("/home/someone/.config/herdr-fleet"));
    assert_eq!(
        dirs.user,
        Path::new("/home/someone/.config/herdr-fleet/agents")
    );
    assert_eq!(dirs.bundled, bundled_agents_dir());
    assert!(bundled_agents_dir().join("lead.md").is_file());
}

// Not in agents.test.ts: whether a run may start agents (`orchestrator.ts:500`'s `canSpawn`
// before the depth check): fleet.json's `roles.<name>.spawning`, else the role file's, else false.
#[test]
fn may_spawn_by_the_override_then_the_role_file() {
    let fixture = fixture(&[], &[]);
    let agents = fixture.discover();
    let none = RoleOverride::default();
    let off = RoleOverride {
        spawning: Some(false),
        ..RoleOverride::default()
    };
    let on = RoleOverride {
        spawning: Some(true),
        ..RoleOverride::default()
    };
    assert!(find(&agents, "lead").may_spawn(&none));
    assert!(!find(&agents, "lead").may_spawn(&off));
    assert!(!find(&agents, "worker").may_spawn(&none));
    assert!(find(&agents, "worker").may_spawn(&on));
    let plain = self::fixture(&[("plain.md", "just text")], &[]);
    assert!(!find(&plain.discover(), "plain").may_spawn(&none));
    drop(fixture.root);
}

// Not in agents.test.ts: merge keys and tags read as Bun 1.4.4 reads them. Each expected value is
// what TypeScript's `discoverAgents` printed for the same file: `<<` (quoted or not, or through an
// alias) is expanded, the mapping's own keys and an earlier merged mapping winning; a quoted scalar
// is a string whatever its tag; `!!str` and tags outside the core schema make a plain scalar a string.
#[test]
fn expands_merge_keys_and_reads_tags_as_bun_does() {
    let fixture = fixture(
        &[
            ("merge.md", "---\nname: merge\n<<: {edits: false}\n---\nx"),
            (
                "mergelist.md",
                "---\nname: mergelist\n<<: [{model: a, interactive: true}, {model: b, edits: false}]\nmodel: c\n---\nx",
            ),
            (
                "quotedmerge.md",
                "---\nname: quotedmerge\n\"<<\": {edits: false}\n---\nx",
            ),
            (
                "anchor.md",
                "---\nname: anchor\nbase: &b {edits: false}\n<<: *b\n---\nx",
            ),
            (
                "tags.md",
                "---\nname: tags\nedits: !!bool \"false\"\nmodel: !!str 1\ninteractive: !foo true\nspawning: !!bool true\ndescription: !!bool yes\nworktree: !!str false\n---\nx",
            ),
        ],
        &[],
    );
    let dirs = AgentDirs {
        bundled: "/nonexistent".into(),
        user: "/nonexistent".into(),
    };
    let mut warnings = Vec::new();
    let agents = discover_agents(&fixture.cwd, &mut warnings, &dirs);
    assert_eq!(warnings, Vec::<String>::new());
    for name in ["merge", "quotedmerge", "anchor"] {
        let role = find(&agents, name);
        assert_eq!(
            (role.edits, role.hash.is_some()),
            (Some(false), true),
            "{name}"
        );
    }
    let list = find(&agents, "mergelist");
    assert_eq!(
        (list.model.as_deref(), list.interactive, list.edits),
        (Some("c"), Some(true), Some(false))
    );
    let tags = find(&agents, "tags");
    assert_eq!(tags.description, "yes");
    assert_eq!(tags.model.as_deref(), Some("1"));
    assert_eq!(
        (tags.edits, tags.interactive, tags.spawning, tags.worktree),
        (None, None, Some(true), None)
    );
    let hashes: Vec<(&str, &str)> = ["merge", "mergelist", "quotedmerge", "anchor", "tags"]
        .into_iter()
        .map(|name| (name, find(&agents, name).hash.as_deref().unwrap()))
        .collect();
    assert_eq!(
        hashes,
        [
            ("merge", "5e8d22b435b3"),
            ("mergelist", "0cec5a60eab6"),
            ("quotedmerge", "4584b2ae91fb"),
            ("anchor", "28d52e536d41"),
            ("tags", "1e1f57332af7"),
        ]
    );
}

// Review regression: Bun 1.4.4 reads the sequence key `[<<]` as the ordinary object key `"<<"`,
// not as YAML's scalar merge key. `discoverAgents` therefore leaves `spawning` unset.
#[test]
fn does_not_expand_a_sequence_key_that_stringifies_to_merge() {
    let fixture = fixture(
        &[(
            "sequence-merge.md",
            "---\nname: sequence-merge\n? [<<]\n: {spawning: true}\n---\nx",
        )],
        &[],
    );
    let agents = fixture.discover();
    let role = find(&agents, "sequence-merge");
    assert_eq!(role.spawning, None);
    assert!(!role.may_spawn(&RoleOverride::default()));
}

// Review regression (codex review aa300c3c): each expected value is what TypeScript's
// `discoverAgents` printed under Bun 1.4.4 for the same file, with no warning. A merge sequence
// drops the items that are not mappings and expands the rest; every merge key of a mapping is
// expanded, an earlier one winning, though saphyr's own mapping keeps only the last of equal keys;
// a merge key reached through an alias counts as one; a merge key whose value is neither a mapping
// nor a sequence stays the ordinary key "<<". Bun printed these frontmatters as
// {"name":"mergescalar","edits":false}, {"name":"mergetwice","model":"a","edits":false,
// "interactive":true}, {"name":"mergealias","k":"<<","edits":false,"interactive":true,
// "worktree":true} and {"name":"mergeplain","<<":5,"edits":false}.
#[test]
fn expands_every_merge_key_and_the_mappings_of_a_merge_sequence_as_bun_does() {
    let fixture = fixture(
        &[
            (
                "mergescalar.md",
                "---\nname: mergescalar\n<<: [1, {edits: false}, [2], null]\n---\nx",
            ),
            (
                "mergetwice.md",
                "---\nname: mergetwice\n<<: {edits: false, model: a}\n<<: {interactive: true, model: b}\n---\nx",
            ),
            (
                "mergealias.md",
                "---\nname: mergealias\nk: &k <<\n*k : {edits: false}\n<<: {interactive: true}\n\"<<\": {worktree: true}\n---\nx",
            ),
            (
                "mergeplain.md",
                "---\nname: mergeplain\n<<: 5\n<<: {edits: false}\n<<: [3]\n---\nx",
            ),
        ],
        &[],
    );
    let dirs = AgentDirs {
        bundled: "/nonexistent".into(),
        user: "/nonexistent".into(),
    };
    let mut warnings = Vec::new();
    let agents = discover_agents(&fixture.cwd, &mut warnings, &dirs);
    assert_eq!(warnings, Vec::<String>::new());
    let read = |name: &str| {
        let role = find(&agents, name);
        (
            role.edits,
            role.interactive,
            role.model.as_deref(),
            role.worktree,
        )
    };
    assert_eq!(read("mergescalar"), (Some(false), None, None, None));
    assert_eq!(
        read("mergetwice"),
        (Some(false), Some(true), Some("a"), None)
    );
    assert_eq!(
        read("mergealias"),
        (Some(false), Some(true), None, Some(true))
    );
    assert_eq!(read("mergeplain"), (Some(false), None, None, None));
}

// Not in ADR 0247's Bun tests: an alias expanding past 100000 nodes (six levels of ten) fails to
// read, as ADR 0279's table says saphyr's loader does, so the file is skipped with a warning and
// the bundled role of the same name, if any, stays. Bun reads it by sharing the objects.
#[test]
fn skips_a_role_file_whose_aliases_expand_past_the_node_budget() {
    let mut yaml = String::from("---\nname: laughs\nl0: &l0 [x, x, x, x, x, x, x, x, x, x]\n");
    for level in 1..=6 {
        let below = format!("*l{}", level - 1);
        let items = [below.as_str(); 10].join(", ");
        yaml.push_str(&format!("l{level}: &l{level} [{items}]\n"));
    }
    yaml.push_str("---\nx");
    let fixture = fixture(&[("laughs.md", &yaml)], &[]);
    let dirs = AgentDirs {
        bundled: "/nonexistent".into(),
        user: "/nonexistent".into(),
    };
    let mut warnings = Vec::new();
    let agents = discover_agents(&fixture.cwd, &mut warnings, &dirs);
    assert!(agents.iter().all(|role| role.name != "laughs"));
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(
        warnings[0].starts_with("fleet: skipping invalid role file ")
            && warnings[0].contains("laughs.md: "),
        "{warnings:?}"
    );
}

// Review regression (codex review adc180a8): a repeated key counts once toward the alias budget,
// as saphyr's `YamlLoader` keeps one entry of equal keys. Five hundred aliases of a mapping that
// repeats one key a hundred times stay far within it; TypeScript's `discoverAgents` under Bun
// 1.4.4 read this file with no warning and `edits: false`.
#[test]
fn counts_a_repeated_key_once_toward_the_alias_budget() {
    let repeated = ["k: x"; 100].join(", ");
    let aliases = ["*d"; 500].join(", ");
    let text =
        format!("---\nname: dupanchor\nedits: false\nd: &d {{{repeated}}}\nl: [{aliases}]\n---\nx");
    let fixture = fixture(&[("dupanchor.md", &text)], &[]);
    let dirs = AgentDirs {
        bundled: "/nonexistent".into(),
        user: "/nonexistent".into(),
    };
    let mut warnings = Vec::new();
    let agents = discover_agents(&fixture.cwd, &mut warnings, &dirs);
    assert_eq!(warnings, Vec::<String>::new());
    assert_eq!(find(&agents, "dupanchor").edits, Some(false));
}

// Review regression (codex review fd7a2909): a mapping's merge keys are expanded when the mapping
// ends, so an alias copies and counts only the keys Bun reads. Six levels that each merge the level
// below ten times hold one key each; kept unexpanded they would be a million nodes. TypeScript's
// `discoverAgents` under Bun 1.4.4 read this file with no warning and `edits: false`.
#[test]
fn counts_the_expanded_mapping_of_repeated_merge_keys_toward_the_alias_budget() {
    let mut text = String::from("---\nname: nested\nm0: &m0 {edits: false}\n");
    for level in 1..=6 {
        let below = format!("<<: *m{}", level - 1);
        let merges = [below.as_str(); 10].join(", ");
        text.push_str(&format!("m{level}: &m{level} {{{merges}}}\n"));
    }
    text.push_str("<<: *m6\n---\nx");
    let fixture = fixture(&[("nested.md", &text)], &[]);
    let dirs = AgentDirs {
        bundled: "/nonexistent".into(),
        user: "/nonexistent".into(),
    };
    let mut warnings = Vec::new();
    let agents = discover_agents(&fixture.cwd, &mut warnings, &dirs);
    assert_eq!(warnings, Vec::<String>::new());
    assert_eq!(find(&agents, "nested").edits, Some(false));
}

// Review regression (codex review fd6b8681): a mapping keeps a key written as a sequence as its
// JavaScript string, so a thousand aliases of a mapping whose key is a thousand scalars copy one
// string each, not a thousand nodes the budget does not count. Before the fix the same file was
// read too, by copying about a million nodes, so this test only pins what Bun reads: TypeScript's
// `discoverAgents` under Bun 1.4.4 read it with no warning and `edits: false`.
#[test]
fn reads_aliases_of_a_mapping_with_a_sequence_key_as_bun_does() {
    let key = ["x"; 1000].join(", ");
    let aliases = ["*d"; 1000].join(", ");
    let text = format!(
        "---\nname: seqkeyanchor\nd: &d {{? [{key}] : y, edits: false}}\n<<: *d\nl: [{aliases}]\n---\nx"
    );
    let fixture = fixture(&[("seqkeyanchor.md", &text)], &[]);
    let dirs = AgentDirs {
        bundled: "/nonexistent".into(),
        user: "/nonexistent".into(),
    };
    let mut warnings = Vec::new();
    let agents = discover_agents(&fixture.cwd, &mut warnings, &dirs);
    assert_eq!(warnings, Vec::<String>::new());
    assert_eq!(find(&agents, "seqkeyanchor").edits, Some(false));
}

// Not in agents.test.ts: a key that is not a string becomes JavaScript's `String()` of it, as in
// Bun 1.4.4 (ADR 0279's "文字列でないキー"): a sequence is its items joined with `,`, a null item
// written as nothing, a nested sequence flattened the same way, a mapping `[object Object]`. Bun
// parsed this frontmatter as {"name":"seqkey","edits":false,"interactive":true,"model,":"a",
// ",worktree":true,"[object Object]":true,"description,x,[object Object]":"d"}, so `? [edits]`
// keeps the role from editing. The file is not named seqkey, so the name comes from `? [name]`.
#[test]
fn reads_a_key_that_is_not_a_string_as_javascripts_string_of_it() {
    let fixture = fixture(
        &[(
            "file.md",
            "---\n? [name]\n: seqkey\n? [edits]\n: false\n? [[interactive]]\n: true\n? [model, ~]\n: a\n? [~, worktree]\n: true\n? {spawning: true}\n: true\n? [description, [x, {a: 1}]]\n: d\n---\nx",
        )],
        &[],
    );
    let dirs = AgentDirs {
        bundled: "/nonexistent".into(),
        user: "/nonexistent".into(),
    };
    let mut warnings = Vec::new();
    let agents = discover_agents(&fixture.cwd, &mut warnings, &dirs);
    assert_eq!(warnings, Vec::<String>::new());
    let role = find(&agents, "seqkey");
    assert_eq!(
        (role.edits, role.interactive, role.model.as_deref()),
        (Some(false), Some(true), None)
    );
    assert_eq!((role.worktree, role.spawning), (None, None));
    // the key is "description,x,[object Object]", so the description is the name (`agents.ts:40`)
    assert_eq!(role.description, "seqkey");
}

// Not in agents.test.ts: TypeScript's `BUNDLED_AGENTS_DIR` is `path.resolve`'s result, so the
// role files' paths (`role_version`'s `file`, which the run records keep) have no `..` in them.
#[test]
fn names_the_bundled_folder_without_parent_steps() {
    let dir = bundled_agents_dir();
    assert!(
        !dir.components()
            .any(|part| part == std::path::Component::ParentDir),
        "{}",
        dir.display()
    );
    assert!(dir.join("lead.md").is_file());
    assert_eq!(
        dir.file_name().and_then(|name| name.to_str()),
        Some("agents")
    );
}
