# Glossary

The terms of herdr-fleet's domain model, one term per concept. `docs/001-domain.md` introduces them in order and gives their rules; this list is for looking one up. Each term reuses a word this repository's code or role files already use, and names the [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md) concept it corresponds to. **Built** means the code on main has it; **Planned** means the model asks for it and the code does not have it yet.

Watch one word: a fleet **thread** is a dsh *Ticket*. dsh's *Thread* (events in time order) has no counterpart here.

| Term | Meaning | In code | dsh | Status |
| --- | --- | --- | --- | --- |
| Anomaly | A fact that something went wrong in the factory beyond one turn, such as an agent CLI whose runs keep failing | `anomaly` event, `checkAnomalies` | Anomaly | Built as a notice to the coordinator; as a structured field of a report Planned (slice A) |
| Autonomous project | A project run without the person between the first request and the merges: its coordinator hears every turn its threads end | `autonomous` in `fleet.json` | — | Built |
| Base branch | The branch the main checkout was on when a thread started; the thread lands there | `baseBranch` | — | Built |
| Brief | What a caller hands to a thread or a helper: goal, the paths it may write, context, done, verify | `Brief` | Mandate's scope | Built |
| Candidate | One CLI and model a role may run on, tried in order | `RoleCandidate`, `fallbackModels` | — | Built |
| Contract | A lead's three to seven checkable assertions, each met, open or unmet | `contract.md`, `ContractItem` | — | Built |
| Coordinator | The run that talks with the person about one project, starts its threads and merges on the person's step, or alone under gated merge authority | role `coordinator` | Main Session | Built |
| Group | The runs that see and message each other: a coordinator's, or a thread's lead and its helpers. Agents' instructions call it their fleet | `group` | — | Built |
| Helper | A run a lead (or another helper) started for one part of the work, with a brief | `spawn` | Worker subagent | Built |
| Landing step | A step the person pressed to land a thread: update, create PR, fix CI, comments, merge, merge PR, discard. It approves that step only | `LandAction`, `LandingStep` | Mandate, as the person's approval | Built |
| Lead | The run that owns one thread end to end | role `lead` | Executor Session | Built |
| Merge authority | Who may merge a project's threads: `person` (the default: every merge waits for the person) or `gated` (the coordinator merges alone only when every condition of the gate holds). Set per project in the person's own `fleet.json`, never by the repository | — | Mandate's strength | Planned |
| Notice | A message from the fleet to a coordinator or a lead, opening with `[fleet]`, sent when its receiver is free | `notice` | Notice | Built as one slot per thread; stored, ordered, once Planned (slice C) |
| Plan | A lead's tree of claims before a large change, with the decisions it asks the person | `Plan`, `fleet plan` | Attention | Built |
| Project | A repository by its main checkout's path, or a folder outside one | `project` | — | Built |
| Report | What a run leaves at the end of a turn for its thread: its outcome, the evidence, and any question for the person. Agents write it as the HANDOFF section of their result file | `result`, `handoff.md` | Report | Built as free text with a PASS, ISSUES or BLOCKED status line; structured fields (`report.json`) Planned (slice A) |
| Role | What an agent is told to be and how it runs, from a file in `agents/` | `AgentDefinition` | Preset | Built; versioned Planned (slice B) |
| Run | One agent the fleet started in a herdr pane with a role, followed turn by turn | `AgentRun` | Assignment | Built |
| Stage | Where a thread stands, by what it waits for; one at a time, the first matching row of a table | `ThreadState` | Ticket stage | Built from the lead's run (`threadState`); a table from stored reports Planned |
| Standing orders | Rules every agent gets with its role: the person's and the project's `standing.md` | `loadStandingOrders` | Team sections | Built |
| Standstill | A project where nothing moved over the quiet period | `standstill` event | — | Built for autonomous projects; from the stage table Planned |
| Subscription | A thread following its pull request on GitHub, read only, so reviews and check changes reach its lead | — | Subscription | Planned |
| Thread | One piece of a project's work, with its own herdr workspace and, in a repository, its own worktree on `fleet/<id>` | `thread`, role `lead` | Ticket | Built as its lead's run; kept apart from its runs Planned (slice A) |
| Turn | One prompt to a run, until it settles, blocks or fails | `PendingTurn` | Executor turn | Built |
| Worktree | A thread's own git checkout under `.herdr-fleet/worktrees/<id>` | `THREAD_WORKTREES` | Ticket directory | Built |

| Group | Values |
| --- | --- |
| Run state | working · idle · done · blocked · unknown (herdr's) · starting · failed · stopped (the fleet's) |
| Stage, Built | working · waiting · review · landing · idle · failed · ended · resolved |
| Report status line, Built | PASS · ISSUES · BLOCKED |
| Report state, Planned (slice A) | progress · waiting · ready · blocked · failed · dropped (dsh's) |
