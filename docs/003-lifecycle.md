# 003 Lifecycle

This document follows a thread from the request that starts it to the merge that ends it, and what happens when something fails on the way. It builds on [001 Domain model](001-domain.md) and [002 Authorization](002-authorization.md).

## Starting a thread

Built:

1. The coordinator runs `fleet thread --title "<a few words>"` with a brief. Independent pieces of work get a thread each; work on the same files goes in one thread, or waits.
2. The fleet records the commit and the branch the main checkout is on. The thread's change is measured against them, and it lands on that branch.
3. In a repository, the fleet adds a worktree at `.herdr-fleet/worktrees/<id>` on the branch `fleet/<id>`, kept out of the repository's own `git status` through its local `info/exclude`.
4. When the person's own `fleet.json` names a setup command for the project, it runs in the new worktree first, for up to ten minutes. A repository cannot name commands the fleet runs.
5. The lead starts in a herdr workspace of its own, with its role, the fleet's instructions, the standing orders and the brief.

## A lead's turn

Built, by the lead's role file:

- It writes its acceptance contract before changing anything.
- Before a large change it hands the person a plan and ends its turn waiting for the answers.
- It shows that each check can fail before it changes the behaviour the check covers.
- It hands a part to a helper only when that gains something, with a brief, and has every change reviewed on another CLI than the one that wrote it.
- It commits on its branch, and ends the turn with a report.

A question on how to build something goes to an architect; a question on what to build goes to the person, with the architect's view.

## Stages

A thread has one stage at a time, worked out from what it waits for. The stage decides where the thread appears on the Fleet screen and whether the person is called.

### Built: from the lead's run

Today the stage is `threadState` (`shared/fleet.ts`), worked out from the lead's run: herdr's state of its pane, its last report's status line, its last landing step and its pull request. The first matching row wins.

| Stage | Condition | Overview group |
| --- | --- | --- |
| resolved | The person marked the thread done, or it landed, and its lead is not working | Resolved (folded) |
| failed | The lead's run failed | Needs you |
| ended | The lead's run was stopped | Idle |
| waiting | herdr shows the lead blocked on a question on its screen | Needs you |
| working | The lead is starting or working, or herdr does not know | Working |
| waiting | The report's status line is BLOCKED, the last landing step went wrong, or the open pull request's checks fail | Needs you |
| landing | The thread's pull request is open | Landing |
| review | The report's status line is PASS | Ready for review |
| idle | Everything else | Idle |

Two parts of this table break the principles of 000: the stage follows the lead's pane, and "waiting" is read from the prose of a status line.

### Planned: a stage table from stored reports

The stage is worked out from stored facts only: the thread's reports (slice A), its plan, its last landing step, its pull request as GitHub last showed it, and whether a run of the thread is live. Never from an agent's prose, and never from one pane's state alone. A restart keeps it, since it is computed again from what is stored. The rows below adapt dsh's Ticket stages and use slice A's report states (progress, waiting, ready, blocked, failed, dropped); their exact conditions settle when they are built.

| Stage | Condition |
| --- | --- |
| person / delivery | A notice to the thread's lead could not be delivered |
| person / answer | The latest report asks the person a question, or the thread's plan waits for answers |
| person / landing | The last landing step the person pressed did not go as asked |
| person / blocked, failed | The latest report is blocked or failed, and the person has not written to the thread since |
| person / merge | The latest report is ready, the thread's pull request is open with passing checks, and the project's merge authority is `person`, or a condition of its gate fails (002) |
| person / review | The latest report is ready and the thread has no pull request |
| working / queued | No run of the thread is live, and a new lead is starting |
| idle | The latest report is waiting or dropped |
| working | Everything else, including a pull request whose checks fail while its lead fixes them, and a merge the coordinator makes under a gate whose conditions all hold |

The table drives three things that today are worked out separately:

- **Needs you:** a thread is listed for the person exactly when its stage starts with `person`. The count on the screen equals that list.
- **Standstill:** a project stands still when none of its threads is `working` and no stage changed over the quiet period.
- **Anomaly:** a structured field of a report, or a run that ended without a report, counted per agent and per role version (slice B), not a sentence the coordinator has to notice.

## Notices

The fleet tells the coordinator only what it has to act on (Built):

- A thread's question for the person: a BLOCKED report, with its plan's place on the Fleet screen when one waits. The coordinator asks the person, or passes on what the person already decided. It never answers a plan itself.
- The landing steps the person pressed that are the coordinator's to carry out: the merges. Planned: under gated merge authority, also a thread whose gate conditions all hold, for the coordinator to merge.
- In an autonomous project (`"autonomous": true` in the project's or the person's `fleet.json`) also: every turn a thread ends, with its status line, contract and pull request; a pull request found merged; a thread the fleet closed against GitHub; a standstill; and an anomaly.

A notice goes out when its receiver is free: no turn of the fleet's in flight, herdr calls it settled, and no draft of the person's in its input; with a draft, the fleet tries again a few seconds later. Several threads' notices go out together, in one message.

- **Built:** each thread holds one notice slot. A newer notice replaces one not yet delivered, and nothing makes delivery once-only or ordered across a restart.
- **Planned (slice C, in progress):** every notice to a coordinator or a lead is stored before it is typed, delivered in the order written, and once, across a restart. A notice that was only good "now", such as a standstill call, is dropped rather than sent late.

### Standstill and anomaly

Built, for autonomous projects only, by a pass after each poll of the pull requests (every minute):

- **Standstill:** when the coordinator and every run of its threads stayed settled for 15 minutes, the coordinator hears it once, with where each thread stands. It hears again only after a thread moved.
- **Anomaly:** when two or more, and at least a third, of one agent CLI's runs in the project over the last hour failed or ended without a HANDOFF, the coordinator hears it once per agent and hour, with the run ids, and is told to start that role on another CLI.

Planned: both come from the stage table and the reports above. Slice A, in progress, removes the anomaly notice and replaces a failed lead instead (below).

## Landing

Built:

1. The person presses a landing step; the fleet sends it to the lead or the coordinator (002).
2. When that agent's turn ends, the fleet checks that the step went as asked: the branch pushed and the pull request open, or the merge done. A step that did not is kept on the thread with what the fleet found, and the thread waits for the person.
3. A thread whose commits are merged, by git or on GitHub, closes: its panes close, its worktree and branch are removed, and it is resolved. What git kept, such as a worktree with uncommitted work, is said on the thread. A discard forces both.

### Reading GitHub

Built: every minute, the fleet reads each open pull request of a thread with `gh`: its state and its checks, with the failing ones by name. Failing checks make the thread wait for the person, who can press Fix CI. In an autonomous project, the fleet also reads a settled thread's pull request once per quiet period, and closes the thread when GitHub shows it merged.

Planned: a read-only subscription. A thread follows its pull request; review comments and changes of its checks reach the thread's lead as notices, so the lead answers a review or fixes CI inside the pull request the person already approved, without the person pressing a step. The server still writes nothing to GitHub.

## Failure and recovery

### Starting an agent

Built: a role has candidates, a CLI and model each, tried in order. A candidate is passed over while its account's usage is above the configured share or it is cooling down after a rate limit; one that fails to start moves on to the next. A run whose first turn fails starts its task again on the next candidate, and names its replacement. Later turns are not tried again: by then the agent holds state a replacement would not have.

### A lead that fails later

- **Built:** a lead that fails after its first turn, or whose pane closes, leaves its thread failed or ended until the person acts.
- **Planned (slice A, in progress):** a lead that fails or ends a turn without a report is replaced by a new run on another CLI, in the same worktree, branch and group. Its task carries a recovery note: check the worktree, git history and GitHub before repeating any outside action. The thread's stage goes on from its stored facts.

### Restarting the server

Built: the run registry keeps every run's record across a restart (dropping runs untouched for a week), and each run's report is read again from its result folder. The agents' panes are herdr's and go on while the server is down; the fleet reads their state again when it comes back.

## Measuring the factory

Built: `fleet report` computes a project's metrics from the fleet's event log, which records ids, roles, agents, models, states and times, never message text, and from GitHub: how often the person stepped in, the stretches the project stood still, starts per agent with the failed ones, runs that ended without a HANDOFF, anomalies, turns agents started themselves, threads closed against GitHub, pull requests merged into the base, and issues closed and opened.

Planned (slice B, in progress): each run records the version of its role file and of the standing orders, and the report counts starts, failures and lost runs per role version, so a change to what the models read can be measured.

Planned: every merge the coordinator makes on its own under gated merge authority is an event, and the report counts the change failure rate (such merges later reverted) and the time to restore (002).
