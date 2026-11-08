# 004 Prompts

This document says what the agents read, where each part comes from, and how a change to it is checked. It builds on [000 Philosophy](000-philosophy.md) through [003 Lifecycle](003-lifecycle.md). Prompt text is written in English.

## What an agent reads

Built: when the fleet starts a run, it assembles the agent's instructions in this order (`instructions` in `server/fleet/orchestrator.ts`):

1. The role file's body.
2. **Fleet coordination:** the run's name and group, the `fleet` commands it may use, how to hand work on with a brief when its role may start agents, and that a question or an approval on another agent's screen goes to the person.
3. The CLI's note, when its adapter has one: agy's says that its sandboxed terminal runs no git, project tool or `fleet` command.
4. For a role that edits no file, the CLI's read-only note, when it has one: OpenCode's lists the commands it may run, and says to ask rather than try another form.
5. The result file and the report it writes at the end of each turn, for every role but the coordinator, which has no result file.
6. **Standing orders:** the person's `~/.config/herdr-fleet/standing.md`, then the project's nearest `.herdr-fleet/standing.md`.

The task follows, as the first prompt: the brief, under the headings Goal, You may change, Context, Done when and Verify, then Forbidden, Timebox and Notes when given. Later prompts are `[fleet]` messages (002) and what the person types in the pane.

How the instructions reach the agent depends on its CLI (`instructionsInPrompt` and `launchArgs` in its adapter): as a system-prompt file its CLI reads at startup (herdr refuses a multi-line argument), as Codex's developer instructions, or, for Cursor, agy and OpenCode, at the head of the first prompt, kept in `<stateDir>/fleet-instructions/` until that prompt is sent.

## What the person and a project write

| Part | Where | Holds |
| --- | --- | --- |
| Roles | `agents/*.md` bundled, `~/.config/herdr-fleet/agents/`, `.herdr-fleet/agents/` | A role's frontmatter (CLI, model, thinking, whether it edits, spawns and talks in its pane) and its body. A later file replaces a role of the same name |
| Role settings | the person's `fleet.json`, the project's `.herdr-fleet/fleet.json` | Candidates and thinking per role, set on the Settings page |
| Standing orders | `standing.md`, the person's and the project's | Rules every agent follows in every turn, so a rule given once does not fade as work is handed on |
| Setup | the person's `fleet.json` only | The command a fresh worktree runs; a repository cannot name commands the fleet runs |

The fleet's own text, the coordination section, the CLI notes and the notices, lives in code and is not edited through these files.

## Principles of the bundled roles

These apply [000 Philosophy](000-philosophy.md) to the agents (Built, in `agents/*.md`):

- **Separate roles.** The coordinator talks with the person, splits requests into threads and edits no file. A lead owns one thread end to end. An architect answers how to build, and leaves what to build to the person. Helpers do one part each.
- **The coordinator does not wait.** It tells the person which threads it started and ends its turn; the fleet brings their questions back as notices.
- **Cut threads vertically.** Each thread delivers one behaviour through every layer it touches. A change that breaks many callers goes in three threads: expand, migrate, contract.
- **Ask one concrete question,** with the options, the recommended one and the architect's view, and only what is the person's to decide.
- **Show that checks can fail,** with expected values from a source other than the code under test.
- **One executor per part,** and a review on another CLI than the writer's.
- **Honest reports.** A status line with the evidence for it, every issue that can be proved, and the contract's state.

The status line, the first line opening with PASS, ISSUES or BLOCKED, is what the fleet reads today (Built). Slice A, in progress, replaces it with the structured report of 001: the roles then ask for `report.json`, and no rule asks for a status line.

## Versions and tests of what models read

- **Built:** none. Role files and standing orders are read when a run starts; what a run read is not recorded, and nothing checks that a role still holds the rules the fleet depends on.
- **Planned (slice B, in progress):**
  - Each role carries the hash of its file's bytes, and a user or project override its own. A run's start records the role's name, source, file and hash, and the standing orders' hash, in the event log.
  - `fleet report` counts starts, failed starts and lost runs per role version, so a change to a role can be judged by its effect.
  - A test checks a table of required rules for every bundled role, fails when a role has no row or loses a rule, and keeps each role under a size budget.
