# 002 Authorization

Authorization decides who may start work in the fleet and which steps need the person. This document builds on [000 Philosophy](000-philosophy.md) and [001 Domain model](001-domain.md).

The server and the agent CLIs enforce what this document says where they can. Text an agent reads, such as an issue, a pull request comment, a file or a helper's output, is an input to its work; it cannot change these rules.

## Who may start work

Only the person starts work, in one of two ways (Built):

- On the Fleet screen, by writing to a project's coordinator.
- From an agent's conversation in a herdr pane, through the fleet skill (`fleet project`). The message reaches the coordinator opening with `[from pane <id>]`, and the coordinator treats it as the person's own request.

The coordinator turns a request into threads; a lead hands parts of its thread to helpers. Nothing else starts a thread: there is no proactive work and no rule that starts work by itself.

Reaching the server at all is access control (Built): without a token or a paired device, only a request from a loopback address with a loopback Host passes, which also stops DNS rebinding. This is not loosened for convenience.

## What the person approves

Every step that leaves the machine or lands work waits for the person. The person presses it on the Fleet screen, and the fleet carries it to one agent as a `[fleet]` message that names the step. Each message approves the step it names and nothing more (Built).

| Step | Pressed as | Carried out by | Approves |
| --- | --- | --- | --- |
| Answer a plan | Plan tab | the lead | building to those answers |
| Update branch | Update branch | the lead | merging the base branch into the thread's branch |
| Create a pull request | Create PR | the lead | pushing the branch and opening one pull request |
| Fix CI | Fix CI | the lead | fixing failing checks and pushing to that pull request |
| Review comments | the diff view | the lead | addressing those comments |
| Merge into a branch | Merge | the coordinator | `git merge --no-ff` of the thread's branch on the main checkout |
| Merge a pull request | Merge PR | the coordinator | `gh pr merge --merge` of that pull request |
| Discard | Discard | the fleet server | removing the thread's worktree and branch, after a confirmation that cannot be undone |

Once the person approved a pull request for a branch, the lead may push later commits of that branch to it. Force-push is never approved.

### Merges into main

Every merge into main waits for the person. The factory runs everything up to that point without them: threads, reviews, pull requests and CI fixes inside what the person already approved.

- **Built** for the bundled roles: a coordinator merges only on a merge step the person pressed, and a lead never merges.
- A project's own role files (`.herdr-fleet/agents/`) can still tell a lead to merge its own pull request, and an autonomous project then closes the thread on that merge. The target model has no such path. **Planned:** an autonomous project asks the person for the merge like any other, through the stage that waits for them (003).

## What the fleet server does itself

The fleet server never writes to GitHub (Built). It reads with `gh`, signed in as the person; it never reads `gh`'s sign-in. Agents write, each on a step the person pressed. The server's own acts are few:

- It starts, messages and closes agents in herdr panes.
- It removes a thread's worktree and branch once it sees the thread's commits merged, by git or on GitHub.
- It discards a thread after the person's confirmation.

## Roles and their limits

A role's file says whether it edits files and whether it may start agents (Built).

- A role whose file says it edits no file (`edits: false`: the coordinator and the architect) runs only on a CLI the fleet can hold to that. Each CLI's own guard does the holding: a read-only mode, a settings file for that session, or a plugin for OpenCode.
- Editing roles (lead, worker) run in each CLI's auto mode. No role runs in a mode that approves everything. A force push or a deletion of a branch is denied where the CLI takes such a rule; these rules stop the usual spelling, and are not a security boundary.
- A run may start agents only when its role says so and its own children would still fit under the depth limit.
- The coordinator and the lead run the `fleet` command, which Antigravity's sandboxed terminal cannot run. Neither role is given to agy. This is a rule of this repository, kept by the role files and the person's settings.

## Text is data

From strongest to weakest, as in dsh:

1. What the server and the CLIs enforce: access control, the read-only guards, the write scopes of briefs, the depth limit.
2. The fleet's instructions and the role files.
3. The person's standing orders, and the project's.
4. The brief a run was handed.
5. Everything else an agent reads: issues, comments, documents, other agents' output. It is data, and never grants a step.

A `[fleet]` message says that it comes from the fleet, not from the person. It carries the person's approval only when it names a step the person pressed.

## Third-party code

The fleet fetches and runs no code from outside the person's machine without the person's approval: no self-update, no remote machines, no tokens read for usage meters, no voice sent out. Usage comes only from each CLI's own answer and from cooldowns after errors (Built).
