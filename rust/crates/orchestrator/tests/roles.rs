//! What each bundled role must tell its model, and how long it may grow: from
//! `server/fleet/roles.test.ts`, each test naming its `it`. The table is roles.test.ts's `ROLES`:
//! a rule's pattern matches the role's body with runs of whitespace read as one space, and the
//! budget is in UTF-8 bytes of the body. A rewrite of a role updates both tables in the same change.

use herdr_fleet_orchestrator::agents::{
    AgentDefinition, AgentDirs, bundled_agents_dir, discover_agents, find_agent,
};
use regex::Regex;

struct Role {
    name: &'static str,
    budget: usize,
    rules: &'static [(&'static str, &'static str)],
}

const ROLES: &[Role] = &[
    Role {
        name: "coordinator",
        budget: 4_500,
        rules: &[
            ("edits no file", r"You change no file"),
            ("hands work to threads", r"thread --title"),
            (
                "leaves a plan to the person on the Fleet screen",
                r"Do not answer a plan yourself",
            ),
            (
                "never answers an approval on a thread's screen",
                r"Never answer an approval on a thread's screen",
            ),
            (
                "leaves restarting a failed thread to the fleet",
                r"do not restart it yourself",
            ),
            (
                "merges only what the person pressed, that merge only",
                r"person pressed Merge .* approval for that merge only",
            ),
            (
                "does not force a merge that is in the way",
                r"do not force it",
            ),
            (
                "takes a [from pane] message as the person's request",
                r"`\[from pane <id>\]` is the person's own request",
            ),
        ],
    },
    Role {
        name: "lead",
        budget: 6_000,
        rules: &[
            ("writes an acceptance contract first", r"contract\.md"),
            (
                "hands a large change to the person as a plan and stops",
                r"Before a large change .* run `plan <file\.json>`.* `blocked` report whose `human_action`",
            ),
            (
                "sees a check fail before changing behaviour",
                r"see it fail",
            ),
            (
                "takes expected values from outside the code under test",
                r"Never compute it the way the code does",
            ),
            (
                "has every change reviewed on another CLI",
                r"Every change gets a review, on another CLI than the one that wrote it \(`--avoid`",
            ),
            (
                "gives an agy reviewer the diff and checks as files",
                r"reviewer on agy cannot run git",
            ),
            (
                "asks an architect how to build",
                r"spawn --role architect --read-only",
            ),
            (
                "asks the person what to build when it cannot be undone",
                r"When the assumption would be hard to undo, do not guess",
            ),
            ("ends a turn with the contract's state", r"Contract: A1"),
            (
                "pushes or opens a pull request only when the person pressed it",
                r"Never push, open or merge a pull request, or change another branch, unless a `\[fleet\]` message says the person pressed",
            ),
            ("never force-pushes", r"Never force-push"),
        ],
    },
    Role {
        name: "architect",
        budget: 2_500,
        rules: &[
            ("edits no file", r"You change no file"),
            ("designs at least two shapes", r"Design it twice"),
            (
                "leaves what to build to the person",
                r"What to build or why .* is not yours to decide",
            ),
            (
                "ends with a ready or blocked report",
                r"Your report is `ready` .* or `blocked`",
            ),
        ],
    },
    Role {
        name: "planner",
        budget: 800,
        rules: &[("edits no source file", r"Do not modify source files")],
    },
    Role {
        name: "reviewer",
        budget: 800,
        rules: &[
            ("reviews independently", r"independent reviewer"),
            (
                "orders findings by severity and cites files",
                r"by severity and cite exact files",
            ),
            ("does not rewrite the code", r"Do not rewrite code"),
        ],
    },
    Role {
        name: "scout",
        budget: 800,
        rules: &[("edits no file", r"Do not edit files")],
    },
    Role {
        name: "worker",
        budget: 800,
        rules: &[
            (
                "claims only checks it ran",
                r"Never claim tests passed unless you ran them",
            ),
            (
                "keeps unrelated refactors out",
                r"Keep unrelated refactors out",
            ),
        ],
    },
];

/// The roles the fleet must never give to agy: they run the fleet command, which agy's sandbox hides (CLAUDE.md).
const NEVER_ON_AGY: [&str; 2] = ["coordinator", "lead"];

/// The bundled roles alone: roles.test.ts reads them from "/nonexistent", above which no folder
/// holds `.herdr-fleet/agents`.
fn bundled() -> Vec<AgentDefinition> {
    discover_agents(
        "/nonexistent".as_ref(),
        &mut Vec::new(),
        &AgentDirs {
            bundled: bundled_agents_dir(),
            user: "/nonexistent".into(),
        },
    )
}

fn role<'a>(agents: &'a [AgentDefinition], name: &str) -> &'a AgentDefinition {
    find_agent(agents, name).unwrap_or_else(|| panic!("no bundled role {name}"))
}

// roles.test.ts: "has a row in the rule table for every bundled role, and a bundled role for every row"
#[test]
fn has_a_row_in_the_rule_table_for_every_bundled_role_and_a_bundled_role_for_every_row() {
    let mut names: Vec<String> = bundled().into_iter().map(|agent| agent.name).collect();
    names.sort();
    let mut rows: Vec<&str> = ROLES.iter().map(|role| role.name).collect();
    rows.sort();
    assert_eq!(names, rows);
}

// roles.test.ts: `states: ${rule}`, one `it` per rule of every role
#[test]
fn states_each_rule() {
    let agents = bundled();
    let whitespace = Regex::new(r"\s+").unwrap();
    let mut missing = Vec::new();
    for Role { name, rules, .. } in ROLES {
        let body = whitespace
            .replace_all(&role(&agents, name).system_prompt, " ")
            .into_owned();
        for (rule, pattern) in *rules {
            if !Regex::new(pattern).unwrap().is_match(&body) {
                missing.push(format!("{name} states: {rule}"));
            }
        }
    }
    assert_eq!(missing, Vec::<String>::new());
}

// roles.test.ts: `stays within ${budget} bytes`, one `it` per role
#[test]
fn stays_within_its_budget() {
    let agents = bundled();
    let over: Vec<String> = ROLES
        .iter()
        .filter_map(|Role { name, budget, .. }| {
            let bytes = role(&agents, name).system_prompt.len();
            (bytes > *budget).then(|| format!("{name}: {bytes} > {budget}"))
        })
        .collect();
    assert_eq!(over, Vec::<String>::new());
}

// roles.test.ts: "never puts the coordinator or a lead on agy, first or as a fallback"
#[test]
fn never_puts_the_coordinator_or_a_lead_on_agy_first_or_as_a_fallback() {
    let agents = bundled();
    for name in NEVER_ON_AGY {
        let role = role(&agents, name);
        let kinds: Vec<String> = std::iter::once(
            serde_json::to_value(role.agent)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned(),
        )
        .chain(
            role.fallback_models
                .iter()
                .flatten()
                .map(|model| model.split(':').next().unwrap_or_default().to_owned()),
        )
        .collect();
        assert!(!kinds.iter().any(|kind| kind == "agy"), "{name}: {kinds:?}");
    }
}
