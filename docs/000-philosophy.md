# 000 Philosophy

herdr-fleet runs coding agents for one person. Its aim is a factory that runs without that person: the person gives the first request and approves the merges, or names in their own settings the conditions under which a project's coordinator may merge alone, and the fleet does the rest. Its core principle, taken from [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md):

**Take as little of the person's attention as possible, and give as much value as possible.**

Every part of the fleet is judged by the attention it costs. A notice to the coordinator, a question, a push notification, a setting, a row on the Fleet screen and a paragraph of these documents each cost attention, and each has to give more than that, or it goes.

## Built and Planned

These documents describe the domain model the fleet is moving to, not only the code as it stands. Each mechanism is marked:

- **Built**: the code on main does it today.
- **Planned**: the model asks for it and the code does not do it yet. A slice that runs as a thread now is marked *in progress*.

The slices in progress are: A, a structured report and a thread kept apart from its runs; B, versioned prompts and tests of what models read; C, stored notices (an outbox); D, these documents. Later work is Planned without a slice.

## What follows for the agents

- **They act on a request or a written rule.** The person's request starts a thread; a role file, the standing orders or the brief say how far it goes. Work nobody asked for is not started.
- **They speak only when the person must act or can use a result.** A thread's question, a result to review and a failure reach the person. Progress does not.
- **They ask one concrete question at a time,** with the options and a recommendation, and only what is the person's to decide. A question on how to build something goes to an architect first.
- **They stop by impact, not by effort.** A change goes as far as a reviewable result. A change that needs the person's decision stops with a plan or a question.
- **They report honestly.** A failed check is reported as failed, a step not taken is said, and a limit is never worked around to avoid asking.

## What follows for the design

These three principles come from dsh and decide most of what the later documents say:

- **A thread's state is its own.** Where a thread stands does not follow the state of the agent or the pane working on it. An agent can fail, be replaced or be restarted, and the thread goes on.
- **Whether the person is needed is not read from free text.** It comes from structured facts: a field of a report, a plan that waits for answers, a landing step that went wrong. Prose an agent wrote is for people to read.
- **An anomaly is a structured field of a report,** not a sentence the coordinator has to notice.

And three more, for the fleet as a whole:

- **Few concepts.** The model has only its domain concepts, defined in [GLOSSARY.md](../GLOSSARY.md). A need becomes an attribute of one of them, or text an agent reads. It does not become a new concept.
- **A screen that shows first what needs the person.** A healthy state takes no space.
- **Documents read in order.** Each numbered document builds only on the ones before it and links only to them and to the glossary, so a reader never meets a concept that has not been introduced. A test checks the links.

## Hard limits

Some things the fleet never does, whatever a request or a prompt says. 002 Authorization gives the detail.

- The fleet server never writes to GitHub. It reads with `gh`; agents push, open pull requests and merge, each on a step the person pressed, or, for a merge, under the merge authority the person set.
- Every merge waits for the person, unless the person's own settings make the project's merge authority gated and every condition of the gate holds. A repository never grants itself merges.
- Access control is not loosened.
- No third-party code is fetched or run without the person's approval.

## Responsibility

The agents commit, push and open pull requests under the person's own accounts, and run with the person's permissions. Every message they send costs the person's attention. The more the fleet does alone, the more care it owes:

- **Start narrow.** Let a project run without the person only once its threads' reports look right.
- **Tune for less noise.** When the fleet is noisy, make the role files shorter and stricter. Do not add messages to explain the noise.
- **Do not produce volume.** Many small threads and pull requests cost more review than they save.
