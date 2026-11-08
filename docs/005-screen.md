# 005 Fleet screen

The Fleet screen in the Web UI is where the person talks with a project's coordinator, sees what needs them, and presses the steps that land work. This document builds on [000 Philosophy](000-philosophy.md) through [004 Prompts](004-prompts.md).

## Three questions

Opening the screen answers three questions, in this order, as dsh's panel does:

1. Does anything need me now?
2. Is the factory moving, and doing the right things?
3. What did one thread do, from the request to the merge?

## Layout

Built:

| Part | Shows |
| --- | --- |
| Project rail | The projects, each with a dot: needs you, working or idle |
| Project conversation | The coordinator's pane, where the person writes requests |
| Overview, Threads | The threads by what they ask of the person: Needs you, Ready for review, Landing, Working, Idle, and the resolved ones folded |
| Overview, Agents | The runs outside threads that have not ended, as cards |
| A thread | Its members (the lead and its helpers), the landing steps above its tabs, and the tabs **Chat**, **Plan** when the lead handed one, and, on a branch of its own, **Changes** (the diff and line comments) and **Checks** |
| Settings | Each role's candidates and thinking, usage limits, concurrency, the setup commands, and the fleet skill's entrances |

The Overview button carries the number of threads that need the person. A push notification tells the person when an agent waits for an answer or a permission.

### Needs you

- **Built:** a thread is under Needs you when its stage is `waiting` or `failed` (003), worked out from the lead's run.
- **Planned:** a thread is under Needs you exactly when its stage in the stage table starts with `person` (003). Each row names what the thread waits for (an answer, a plan, a review, a merge, a landing step that went wrong, a failure) and offers that action directly.

### Landing

Built: the Checks tab shows what stands between the thread and landing: work no commit holds, commits ahead of and behind the base branch, the contract, whether a review ran on another CLI, and the pull request with its checks. The landing steps of 002 are buttons above the thread's tabs (Discard, Merge into the base branch, Create PR, Fix CI, Merge PR) and on the Checks rows they fix (Update branch, Send to lead, Fix CI), each offered only when it applies. Line comments are left on the Changes tab and sent with Send to lead.

## Principles

1. **Focus on what matters.** Every element answers one of the three questions, or it goes. A number appears only when it changes what the person does.
2. **Precise definitions.** Groups have checkable definitions, are mutually exclusive and cover every case, as the stages do. A label says what a row waits for, not an internal state.
3. **One place per concept.** A thread's work is in the thread; the coordinator's conversation is the project's; settings are grouped by what they configure.
4. **Domain terms.** The screen uses the terms of [001 Domain model](001-domain.md); internal ids appear only in folded details.
5. **Honest state.** A count equals the length of the list it links to, and no state contradicts another fact.
6. **Quiet by default.** A healthy state takes no extra space. A step that cannot be undone, such as Discard, asks for confirmation.
7. **English labels.** Labels stay in English; sentences have a Japanese translation, and a test fails on a missing one.
