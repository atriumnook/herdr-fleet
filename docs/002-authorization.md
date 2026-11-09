# 002 Authorization

Authorization decides who may start work in the fleet and which steps need the person. This document builds on [000 Philosophy](000-philosophy.md) and [001 Domain model](001-domain.md).

The server and the agent CLIs enforce what this document says where they can. Text an agent reads, such as an issue, a pull request comment, a file or a helper's output, is an input to its work; it cannot change these rules.

## Who may start work

Only the person starts work, in one of two ways (Built):

- On the Fleet screen, by writing to a project's coordinator.
- From an agent's conversation in a herdr pane, through the fleet skill (`fleet project`). The message reaches the coordinator opening with `[from pane <id>]`, and the coordinator treats it as the person's own request.

The coordinator turns a request into threads; a lead hands parts of its thread to helpers. Nothing else starts a thread: there is no proactive work and no rule that starts work by itself.

Reaching the server at all is access control (Built, `server/access.ts`): without a token or a paired device, a request passes only from a loopback address with a loopback Host and no proxy headers, which also stops DNS rebinding, or through Tailscale on this machine as the machine's owner. A configured token is required whatever else holds. This is not loosened for convenience.

## What the person approves

Every step that leaves the machine or lands work waits for the person, except a merge under gated merge authority (below). The person presses it on the Fleet screen, and the fleet carries it to one agent as a `[fleet]` message that names the step. Each message approves the step it names and nothing more (Built).

| Step | Pressed as | Carried out by | Approves |
| --- | --- | --- | --- |
| Answer a plan | Plan tab | the lead | building to those answers |
| Update branch | Update branch | the lead | merging the base branch into the thread's branch |
| Create a pull request | Create PR | the lead | pushing the branch and opening one pull request |
| Fix CI | Fix CI | the lead | fixing failing checks and pushing to that pull request |
| Review comments | Send to lead, after commenting on lines in the Changes tab | the lead | addressing those comments |
| Merge into a branch | Merge into <base branch> | the coordinator | `git merge --no-ff` of the thread's branch on the main checkout |
| Merge a pull request | Merge PR | the coordinator | `gh pr merge --merge` of that pull request |
| Revert a merge | Revert, on a merged thread | the coordinator | `git revert -m 1` of the thread's merge commit on the base branch, and a push of the base branch (never force) when the merge was a pull request's |
| Discard | Discard | the fleet server | removing the thread's worktree and branch, after a confirmation that cannot be undone |

Once the person approved a pull request for a branch, the lead may push later commits of that branch to it. Force-push is never approved.

### Merge authority

Every merge waits for the person unless the person decided otherwise for that project. The factory runs everything up to the merge without them: threads, reviews, pull requests and CI fixes inside what the person already approved.

- **Built:** the fleet's own instructions, added after every role file, tell each thread's lead never to merge, and each coordinator to merge or revert only what a `[fleet]` message names, whatever a project's role files (`.herdr-fleet/agents/`) say. The fleet no longer treats a lead's own merge as a path: a merge none of its steps asked for is recorded as made outside them (`github`).

**Built: merge authority.** Who may merge is an explicit mode per project, in the person's own `fleet.json` (`projects[<path>].merge`: `mode`, `branches`, `maxLines`, `protected`; `server/fleet/merge-mode.ts`), set on the Settings page. It is never inferred from a repository's own files: the project's `.herdr-fleet/fleet.json` cannot set it, and role files come with the repository and would let it grant itself merges. As in dsh, a Mandate's strength is explicit, not inferred. An entry that does not parse is `person`.

| Mode | Who merges |
| --- | --- |
| `person` (default) | Every merge waits for the person. herdr-fleet's own main uses this |
| `gated` | For a thread that lands on one of the listed `branches`, the coordinator merges on its own only when every condition below holds; otherwise the merge waits for the person, as in `person`. Any other branch is `person`. The rust project's rust branch will use this |

Under `gated`, a thread's lead is told to push its branch and open its pull request itself once its report is ready and a review passed, and never to merge it. The fleet evaluates the conditions when the lead's turn ends, and again when the pull request's checks come to pass, reading git and `gh` only. What it measures is the commit the pull request is at, compared on GitHub with the base branch there. When all hold, it hands the coordinator Merge PR as the gate's, pinned to that commit (`gh pr merge --match-head-commit`); it evaluates the gate again just before the coordinator is free to take it, and withdraws the step when the gate no longer holds for that pull request and commit. The coordinator is handed one such merge at a time, never beside a merge the person pressed, and only while it lives: the fleet starts no coordinator for it (Built). The conditions, all of which must hold:

1. The lead's latest report is ready.
2. A reviewer whose model is from a company none of the writers' models is from reported ready, in a turn through which the branch stayed at the commit being merged and its worktree did not change. One company's models tend to miss the same things, so an Anthropic model on agy does not count for a change claude wrote. The company comes from each run's CLI and model, in one table (`shared/model-company.ts`): claude is Anthropic and codex OpenAI whatever the model; agy's model name, and the model of pi's and opencode's `provider/model`, name the family (`claude-*` Anthropic, `gpt-*` and `o<n>` OpenAI, `gemini-*` Google, and DeepSeek, Xiaomi, Moonshot AI, Zhipu AI, Alibaba, xAI, Meta, Mistral AI and MiniMax by theirs); cursor's models route across companies and are never told. When the company of any writer's model, or of the reviewer's, cannot be told, no review counts. The thread keeps its writers, each with its CLI and model: its lead runs, the helpers that could edit (recorded when each starts), and a reviewer whose turn changed the worktree or ended without the fleet reading it. A writer recorded before writers named their model holds its CLI alone, so only claude's and codex's tell a company. A reviewer counts as a writer too while it works, and after any turn the fleet did not send it, until a turn the fleet sent ends clean. Which CLI a review is started on does not change: the lead still passes the writers' CLIs over (`--avoid`), and only which reviews the gate counts follows the company.
3. The pull request targets the thread's base branch and is at the branch's latest commit, and its checks pass; where GitHub says it has none, the lead's contract is met. Checks GitHub could not be asked about do not count as none.
4. The pull request has at most `maxLines` lines, added and removed; `maxLines` defaults to 200, as dsh's delivery rule.
5. It touches none of the protected paths the person lists, nor the gate itself and what enforces it, which always wait for the person: the project's `.herdr-fleet/` and `.github/` (the folders themselves too, so a symlink in their place counts), and herdr-fleet's `server/fleet/`, `server/access.ts`, `agents/`, `opencode/` and `shared/model-company.ts` (which tells the companies of condition 2). A folder pattern also stands for the folder itself.
6. The branch has the base branch's latest commits on GitHub.

The thread keeps the result, and the Checks tab shows it. A pull request without a merge gate's pass waits for the person's Merge PR.

**Safety comes from undo, not approval.** Every merge is a merge commit (`git merge --no-ff`, `gh pr merge --merge`), so `git revert -m 1 <merge>` undoes it. Every merge goes to the event log with who made it (`person`, `gate` or `github`) and its merge commit, and `fleet report` counts the gate's merges, how many were later reverted (the change failure rate) and the time from each such merge to its revert (the time to restore, as DORA defines them, measured from the merge). A merged thread whose merge commit the fleet knows (GitHub's, or here the merge on the base branch's first-parent line whose second parent is the thread's branch) offers Revert on the Fleet screen (005); the merge and its revert are on the branch the pull request was merged into, and a revert of a pull request's merge counts once GitHub's base branch has it (all Built).

## What the fleet server does itself

The fleet server never writes to GitHub (Built). It reads with `gh`, signed in as the person; it never reads `gh`'s sign-in. Agents write, each on a step the person pressed, or, for a merge, under gated merge authority (Built). The server's own acts are few:

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
