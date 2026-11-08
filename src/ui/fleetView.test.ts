import { describe, expect, it } from "bun:test";
import type { AgentRun, ReportState } from "../../shared/fleet.ts";
import { fleetScreenModel, meterLevel, needsCount, projectsOf, threadCards } from "./fleetView.ts";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { INITIAL_STATE, type UiState } from "./state.ts";

/** a run whose last turn reported `state` (report.json) */
const reported = (state: ReportState, summary: string, human_action?: string): Pick<AgentRun, "outcome"> => ({ outcome: { report: { state, summary, evidence: [], ...(human_action ? { human_action } : {}) } } });

const NOW = 1_000_000;
const run = (id: string, extra: Partial<AgentRun> = {}): AgentRun => ({
  id, name: id, role: "worker", agent: "pi", group: "g1", herdrName: `h-${id}`, paneId: `w1:${id}`, cwd: "/w",
  state: "working", depth: 1, interactive: false, worktree: false, startedAt: 1, updatedAt: 1, ...extra,
});
const withRuns = (runs: AgentRun[], extra: Partial<UiState> = {}): UiState => ({ ...INITIAL_STATE, runs: { status: "ready", data: runs, again: false }, ...extra });

const PERSON = { mode: "person" as const, branches: [], maxLines: 200, protected: [] };
const GATED = { mode: "gated" as const, branches: ["rust"], maxLines: 150, protected: ["docs/plan.md"] };

describe("fleet screen model", () => {
  it("orders runs by what they ask of the person, and folds ended ones away", () => {
    const model = fleetScreenModel(withRuns([
      run("done", { state: "done", updatedAt: 5 }),
      run("child", { depth: 2, startedAt: 3 }),
      run("waiting", { state: "blocked", lastError: "Cursor Agent asks whether to trust this folder." }),
      run("parent", { startedAt: 2 }),
      run("broken", { state: "failed", lastError: "rate limit exceeded", replacedBy: "parent" }),
      run("gone", { state: "stopped" }),
    ]), NOW);
    expect(model.sections.map((section) => [section.tone, section.runs.map((r) => r.id)])).toEqual([
      ["needs", ["waiting"]], ["failed", ["broken"]], ["working", ["parent", "child"]], ["done", ["done"]],
    ]);
    expect(model.ended.map((r) => r.id)).toEqual(["gone"]);
    expect(model.counts).toEqual({ needs: 1, failed: 1, working: 2, done: 1 });
    expect(model.sections[0]!.runs[0]!.question).toBe("Cursor Agent asks whether to trust this folder.");
    expect(model.sections[1]!.runs[0]).toMatchObject({ error: "rate limit exceeded", replacedBy: { id: "parent", name: "parent" } });
  });

  it("offers a pane only while it exists, and an interrupt only to a run that works or waits", () => {
    const model = fleetScreenModel(withRuns([run("w"), run("b", { state: "blocked" }), run("d", { state: "done" }), run("s", { state: "stopped" })]), NOW);
    const all = [...model.sections.flatMap((section) => section.runs), ...model.ended];
    const by = (id: string) => all.find((r) => r.id === id)!;
    expect([by("w"), by("b"), by("d"), by("s")].map((r) => [r.canOpenPane, r.canInterrupt])).toEqual([[true, true], [true, true], [true, false], [false, false]]);
  });

  it("names the groups whose finished non-interactive panes can be closed", () => {
    const model = fleetScreenModel(withRuns([run("a", { state: "done", group: "g2" }), run("b", { state: "done", interactive: true }), run("c", { state: "idle" })]), NOW);
    expect(model.closableGroups).toEqual(["g2"]);
  });

  it("shows each account's tightest window that has not reset, its cooldown while it lasts, and what is in flight", () => {
    const state: UiState = {
      ...withRuns([]),
      usage: { status: "ready", again: false, refreshing: false, data: [
        { key: "codex", reading: { readAt: 5, windows: [{ name: "5h", usedPercent: 92, resetsAt: NOW - 1 }, { name: "weekly", usedPercent: 64, resetsAt: NOW + 10 }] } },
        { key: "cursor", cooldown: { until: NOW + 60_000, reason: "rate limit", since: 1 } },
        { key: "agy:gemini", cooldown: { until: NOW - 1, reason: "over", since: 1 }, error: "agy exited with 1" },
      ] },
      request: { status: "pending", action: { kind: "clear-cooldown", key: "cursor" } },
    };
    const capsules = fleetScreenModel(state, NOW).usage.capsules;
    expect(capsules.map((c) => c.key)).toEqual(["agy:gemini", "codex", "cursor"]);
    expect(capsules[1]).toMatchObject({ agent: "codex", worst: { name: "weekly", usedPercent: 64 }, level: "mid", readAt: 5 });
    expect(capsules[2]).toMatchObject({ agent: "cursor", cooldown: { until: NOW + 60_000, reason: "rate limit" }, busy: true });
    expect(capsules[0]).toMatchObject({ agent: "agy", cooldown: undefined, error: "agy exited with 1", worst: undefined });
  });

  it("dates the usage by the oldest reading of the accounts refreshed by themselves, leaving cursor's out", () => {
    const at = (readAt: number) => ({ readAt, windows: [{ name: "5h", usedPercent: 1 }] });
    const usage = (data: UiState["usage"]["data"]): UiState => ({ ...withRuns([]), usage: { status: "ready", again: false, refreshing: false, data } });
    const model = fleetScreenModel(usage([{ key: "codex", reading: at(300) }, { key: "agy:3p", reading: at(200) }, { key: "agy:gemini", reading: at(250) }, { key: "claude", reading: at(400) }, { key: "cursor", reading: at(100) }]), NOW);
    expect(model.usage.readAt).toBe(200);
    expect(fleetScreenModel(usage([{ key: "cursor", reading: at(100) }]), NOW).usage.readAt).toBeUndefined();
  });

  it("says what the last action's failure was", () => {
    const state = withRuns([run("a")], { request: { status: "failed", action: { kind: "interrupt", runId: "a" }, message: "read_only" } });
    expect(fleetScreenModel(state, NOW).requestError).toBe("read_only");
  });

  it("counts the runs waiting on the person for the Fleet button", () => {
    expect(needsCount(withRuns([run("a", { state: "blocked" }), run("b"), run("c", { state: "blocked" })]))).toBe(2);
  });

  it("meters by what is left: plenty from half, getting low from a fifth, low under it", () => {
    expect([0, 49, 50, 79, 80, 100].map(meterLevel)).toEqual(["ok", "ok", "mid", "mid", "low", "low"]);
  });
});

describe("the projects, their threads and the run open in the Overview", () => {
  const lead = (id: string, extra: Partial<AgentRun> = {}) => run(id, { role: "lead", project: "/repo", group: `g-${id}`, interactive: true, branch: `fleet/${id}`, state: "idle", ...extra });
  const coordinator = (extra: Partial<AgentRun> = {}) => run("co", { role: "coordinator", agent: "claude", project: "/repo", group: "g-co", interactive: true, state: "idle", updatedAt: 10, ...extra });

  it("lists every repository a coordinator or a thread worked for, the latest first, and a folder picked for a new one", () => {
    const runs = [coordinator(), lead("t1", { project: "/other", updatedAt: 50, state: "blocked" }), run("w")];
    expect(projectsOf(withRuns(runs)).list.map((p) => [p.name, p.dot, p.selected])).toEqual([["other", "needs", true], ["repo", "idle", false]]);
    const picked = withRuns(runs, { fleetView: { ...INITIAL_STATE.fleetView, project: "/new" } });
    expect(projectsOf(picked)).toMatchObject({ selected: "/new", list: [{ path: "/other" }, { path: "/repo" }, { path: "/new", dot: "none", selected: true }] });
    // a folder inside a listed repository is that repository
    expect(projectsOf(withRuns(runs, { fleetView: { ...INITIAL_STATE.fleetView, project: "/repo/src" } })).selected).toBe("/repo");
  });

  it("groups the project's threads by what the person has to do, with what each waits on them for", () => {
    const model = fleetScreenModel(withRuns([
      coordinator(),
      lead("ask", { ...reported("blocked", "Keep the old API?", "Keep the old API?"), updatedAt: 5 }),
      lead("screen", { state: "blocked", lastError: "Allow bun test?", updatedAt: 6 }),
      lead("broke", { state: "failed", lastError: "429 rate limit", updatedAt: 4 }),
      lead("done", { ...reported("ready", "12 pass"), diff: { added: 24, removed: 9, files: 2 }, contract: [{ id: "A1", state: "met" }] }),
      lead("busy", { state: "working" }),
      lead("quiet", { ...reported("waiting", "1 left") }),
      lead("over", { resolvedAt: 1 }),
      lead("elsewhere", { project: "/other" }),
    ]), NOW);
    expect(model.project).toEqual({ path: "/repo", name: "repo" });
    expect(model.coordinator).toEqual({ runId: "co", paneId: "w1:co", agent: "claude" });
    expect(model.threadGroups.map((group) => [group.key, group.rows.map((row) => row.id)])).toEqual([
      ["needs", ["screen", "ask", "broke"]], ["review", ["done"]], ["working", ["busy"]], ["idle", ["quiet"]],
    ]);
    expect(model.needs).toBe(3);
    expect(model.threadGroups[0]!.rows.map((row) => [row.label, row.question])).toEqual([["Needs you", "Allow bun test?"], ["Needs you", "Keep the old API?"], ["Failed", "429 rate limit"]]);
    expect(model.threadGroups[1]!.rows[0]).toMatchObject({ label: "Ready for review", badge: "done", diff: { added: 24, removed: 9 }, contract: [{ id: "A1", state: "met" }] });
    expect(model.resolved.map((row) => row.id)).toEqual(["over"]);
  });

  it("shows a thread as the lead run that took it over, and keeps the thread open on that run", () => {
    const runs = [coordinator(), lead("t", { state: "stopped", replacedBy: "t2" }), lead("t2", { group: "g-t", branch: "fleet/t", thread: "t", agent: "codex", state: "working" })];
    const model = fleetScreenModel(withRuns(runs, { fleetView: { ...INITIAL_STATE.fleetView, open: { kind: "thread", runId: "t", member: null } } }), NOW);
    const rows = model.threadGroups.flatMap((group) => group.rows);
    expect(rows.map((row) => [row.id, row.selected])).toEqual([["t2", true]]);
    expect(model.open).toMatchObject({ runId: "t2", agent: "codex" });
    // the run it took over from is not one of the thread's agents
    expect(model.open!.members.map((member) => member.runId)).toEqual([null]);
  });

  it("asks for a project's first message while no coordinator lives there", () => {
    const model = fleetScreenModel(withRuns([coordinator({ state: "stopped" }), lead("t")]), NOW);
    expect(model.coordinator).toBeNull();
    expect(model.project?.path).toBe("/repo");
  });

  it("keeps the agents outside every thread and project conversation, and opens a thread on its lead or one of its helpers", () => {
    const helper = run("rev", { role: "reviewer", group: "g-t", agent: "cursor", state: "done" });
    const runs = [coordinator(), lead("t", { ...reported("ready", "Done.") }), helper, run("loose", { group: "g9" }), run("old", { group: "g8", state: "stopped" })];
    const open = (member: string | null, expanded = false) => fleetScreenModel(withRuns(runs, { fleetView: { project: null, overview: true, open: { kind: "thread", runId: "t", member }, expanded, tab: "chat", settings: false } }), NOW);
    expect(open(null).agents.map((card) => card.id)).toEqual(["loose"]);
    expect(open(null).open).toMatchObject({ title: "t", paneId: "w1:t", paneRunId: "t", label: "Ready for review", canResolve: true, members: [{ runId: null, name: "lead", selected: true }, { runId: "rev", name: "rev", selected: false }] });
    expect(open("rev", true)).toMatchObject({ expanded: true, open: { paneId: "w1:rev", paneRunId: "rev", agent: "cursor", members: [{ selected: false }, { selected: true }] } });
    expect(open(null).threadGroups[0]!.rows[0]!.selected).toBe(true);
  });

  it("lands a thread: the steps it offers where it stands, and what can be pressed now", () => {
    const pr = { number: 70, url: "https://github.com/o/r/pull/70", state: "OPEN", checks: "pending" } as const;
    const runs = [
      coordinator(),
      lead("t", { ...reported("ready", "Done."), agent: "claude", baseBranch: "main", diff: { added: 3, removed: 1, files: 1 } }),
      run("rev", { role: "reviewer", group: "g-t", agent: "cursor", state: "done", ...reported("ready", "No findings.") }),
      lead("pr", { ...reported("ready", "Done."), pr, updatedAt: 3 }),
      lead("red", { ...reported("ready", "Done."), pr: { ...pr, number: 71, checks: "fail", failing: ["test"] }, updatedAt: 4 }),
      lead("stuck", { ...reported("ready", "Done."), landing: { action: "merge", at: 1, sent: true, error: "fleet/stuck is not in main after the coordinator's turn; its reply says why." }, updatedAt: 5 }),
    ];
    const opened = (runId: string, extra: Partial<UiState> = {}) => fleetScreenModel(withRuns(runs, { fleetView: { ...INITIAL_STATE.fleetView, open: { kind: "thread", runId, member: null } }, ...extra }), NOW).open!.landing!;
    const groups = fleetScreenModel(withRuns(runs), NOW).threadGroups;
    expect(groups.map((group) => [group.key, group.rows.map((row) => row.id)])).toEqual([["needs", ["stuck", "red"]], ["review", ["t"]], ["landing", ["pr"]]]);
    expect(groups[0]!.rows.map((row) => row.question)).toEqual(["fleet/stuck is not in main after the coordinator's turn; its reply says why.", "PR #71: test"]);
    expect(groups[2]!.rows[0]).toMatchObject({ label: "Landing", badge: "working", pr });
    const review = opened("t");
    expect(review).toMatchObject({ stage: "review", baseBranch: "main", branch: "fleet/t", repo: "/repo", tab: "chat", can: { lead: true, merge: true, discard: true } });
    expect(review.offers).toEqual({ createPr: true, mergeLocal: true, discard: true, fixCi: false, mergePr: false, revert: false });
    expect(review.checks.thread.find((check) => check.kind === "review")).toEqual({ kind: "review", tone: "ok", reviewers: [{ agent: "cursor", status: "ready — No findings." }] });
    expect(opened("pr")).toMatchObject({ stage: "landing", offers: { createPr: false, mergeLocal: false, discard: false, mergePr: true }, mergePrReady: false });
    expect(opened("red")).toMatchObject({ offers: { fixCi: true }, attention: true });
    expect(opened("red").checks.pr.map((check) => [check.kind, check.tone])).toEqual([["pr", "ok"], ["ci", "bad"]]);
    // a step under way holds the next one; an action in flight presses nothing
    const asked = { ...runs[1]!, landing: { action: "pr" as const, at: 1, sent: true } };
    expect(fleetScreenModel(withRuns([coordinator(), asked], { fleetView: { ...INITIAL_STATE.fleetView, open: { kind: "thread", runId: "t", member: null } } }), NOW).open!.landing).toMatchObject({ pending: "pr", can: { lead: false, merge: false, discard: true } });
    expect(opened("t", { request: { status: "pending", action: { kind: "resolve", runId: "x", resolved: true } } }).can.discard).toBe(false);
  });

  it("reads the open thread's change into files, with the person's comments on their lines, and its checks", () => {
    const runs = [coordinator(), lead("t", { ...reported("ready", "Done."), baseBranch: "main", diff: { added: 1, removed: 1, files: 1 } })];
    const diff = ["diff --git a/a.md b/a.md", "--- a/a.md", "+++ b/a.md", "@@ -1,2 +1,2 @@", " same", "-old", "+new"].join("\n");
    const landing = {
      runId: "t", diff: { status: "ready" as const, data: { diff, truncated: true } },
      checks: { status: "ready" as const, data: { baseBranch: "main", uncommitted: ["notes.txt"], ahead: 2, behind: 1 } },
      comments: { t: [{ file: "a.md", line: 2, text: "why?" }, { file: "a.md", line: 2, removed: true, text: "keep it" }] },
      confirm: { runId: "t", action: "discard" as const, status: "asking" as const },
    };
    const model = fleetScreenModel(withRuns(runs, { fleetView: { ...INITIAL_STATE.fleetView, open: { kind: "thread", runId: "t", member: null }, tab: "changes" }, landing }), NOW).open!.landing!;
    expect(model.changes).toMatchObject({ status: "ready", truncated: true, files: [{ path: "a.md", added: 1, removed: 1, comments: 2 }] });
    expect(model.changes.files[0]!.lines.slice(1).map((line) => [line.kind, line.comments])).toEqual([
      ["ctx", []], ["del", [{ index: 1, text: "keep it" }]], ["add", [{ index: 0, text: "why?" }]],
    ]);
    expect(model.checks.branch).toEqual([
      { kind: "committed", tone: "warn", uncommitted: ["notes.txt"], ahead: 2 },
      { kind: "base", tone: "warn", baseBranch: "main", behind: 1, action: "update" },
    ]);
    expect(model.checks.thread.find((check) => check.kind === "comments")).toEqual({ kind: "comments", tone: "warn", count: 2, action: "comments" });
    expect(model.confirm).toEqual({ action: "discard", running: false, worktree: "/repo/.herdr-fleet/worktrees/t", ahead: 2 });
    // what was read for another thread is not this one's
    const other = fleetScreenModel(withRuns([...runs, lead("u", { ...reported("ready", "Done.") })], { fleetView: { ...INITIAL_STATE.fleetView, open: { kind: "thread", runId: "u", member: null } }, landing }), NOW).open!.landing!;
    expect(other).toMatchObject({ changes: { status: "idle", files: [] }, checks: { status: "idle", branch: [] }, comments: [], confirm: null });
  });

  it("draws the open thread's plan with the person's answers so far, and the thread as waiting on them until they are sent", () => {
    const ask = (id: string) => ({ id, question: `Which ${id}?`, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], recommended: "a" });
    const data = {
      version: 2, writtenAt: 1, title: "Retry limit", why: ["too many retries"], scope: ["drafts"],
      claims: [{ text: "Tried three times.", ask: ask("limit"), children: [{ text: "Stops at RETRIES.", ask: ask("where"), children: [] }] }],
      shared: { text: "One constant." },
    };
    const runs = [coordinator(), lead("t", { ...reported("blocked", "The plan waits.", "Answer the plan in the Plan tab."), plan: { version: 2, asks: 2 } }), lead("u", { plan: { version: 1, asks: 1, answeredAt: 3 } })];
    const plan = { runId: "t", reading: { status: "ready" as const, data }, drafts: { t: { version: 2, choices: { where: "b" }, seen: ["where"], comments: { "1.1": "use the constant" }, note: "" } }, confirm: { runId: "t", version: 2, status: "asking" as const }, dropped: null, seq: 0 };
    const state = withRuns(runs, { fleetView: { ...INITIAL_STATE.fleetView, open: { kind: "thread", runId: "t", member: null }, tab: "plan" }, plan });
    const model = fleetScreenModel(state, NOW);
    const open = model.open!;
    expect(open.tab).toBe("plan");
    expect(open.plan).toMatchObject({ status: "ready", version: 2, title: "Retry limit", toAnswer: ["limit"], comments: 1, canRespond: true });
    expect(open.plan!.claims[0]).toMatchObject({ id: "1", ask: { number: "D1", chosen: "a", seen: false }, children: [{ id: "1.1", comment: "use the constant", ask: { number: "D2", chosen: "b", seen: true } }] });
    expect(open.plan!.shared).toMatchObject({ id: "shared", text: "One constant." });
    expect(open.plan!.confirm!.decisions).toEqual([
      { number: "D1", question: "Which limit?", choice: "A", recommended: true, seen: false },
      { number: "D2", question: "Which where?", choice: "B", recommended: false, seen: true },
    ]);
    // the thread list: a plan waits with one decision left to look at; an answered one does not wait
    expect(model.threadGroups.find((group) => group.key === "needs")!.rows.map((row) => [row.id, row.plan])).toEqual([["t", { toAnswer: 1 }]]);
    expect(model.threads.find((row) => row.id === "u")!.plan).toBeUndefined();
    // a plan the lead went on without: shown, closed, nothing to answer or send
    const closedRun = lead("t", { ...reported("ready", "Five retries."), plan: { version: 2, asks: 2, closedAt: 4 } });
    const closed = fleetScreenModel(withRuns([coordinator(), closedRun], { fleetView: state.fleetView, plan: { ...plan, reading: { status: "ready", data: { ...data, closedAt: 4 } } } }), NOW);
    expect(closed.threads[0]!.plan).toBeUndefined();
    expect(closed.threads[0]!.state).toBe("review");
    expect(closed.open!.plan).toMatchObject({ closedAt: 4, toAnswer: [], canRespond: false });
    // the lead at work: nothing to send
    expect(fleetScreenModel(withRuns([coordinator(), { ...runs[1]!, state: "working" }], { fleetView: state.fleetView, plan }), NOW).open!.plan!.canRespond).toBe(false);
  });

  it("offers Revert on a merged thread whose merge commit the fleet knows, until the fleet saw it reverted, and shows the merge gate", () => {
    const gate = { at: 1, head: "c0ffee", ok: false, checks: [{ id: "report" as const, ok: true, detail: "The lead's latest report is ready." }, { id: "size" as const, ok: false, detail: "The change has 340 lines, over the limit of 200." }] };
    const runs = [
      coordinator(),
      lead("m", { ...reported("ready", "Done."), state: "stopped", landed: "merged", merged: { by: "gate", via: "pr", base: "rust", at: 2, commit: "abc0001" }, baseBranch: "rust" }),
      lead("r", { ...reported("ready", "Done."), state: "stopped", landed: "merged", merged: { by: "gate", via: "pr", base: "rust", at: 2, commit: "abc0002" }, reverted: { at: 3, commit: "beef" }, updatedAt: 2 }),
      lead("n", { ...reported("ready", "Done."), state: "stopped", landed: "merged", merged: { by: "github", via: "pr", base: "rust", at: 2 }, updatedAt: 3 }),
      lead("g", { ...reported("ready", "Done."), pr: { number: 9, url: "u", state: "OPEN", checks: "pass" }, gate, updatedAt: 4 }),
    ];
    const opened = (runId: string) => fleetScreenModel(withRuns(runs, { fleetView: { ...INITIAL_STATE.fleetView, open: { kind: "thread", runId, member: null } } }), NOW).open!.landing!;
    expect(opened("m")).toMatchObject({ stage: "landed", mergedBy: "gate", mergedVia: "pr", offers: { revert: true }, can: { revert: true } });
    // the merge went into the branch the pull request was moved to, not the one the thread started from
    expect(fleetScreenModel(withRuns([coordinator(), { ...runs[1]!, merged: { by: "github", via: "pr", base: "main", at: 2, commit: "abc0001" } }], { fleetView: { ...INITIAL_STATE.fleetView, open: { kind: "thread", runId: "m", member: null } } }), NOW).open!.landing!.baseBranch).toBe("main");
    expect(opened("r")).toMatchObject({ reverted: true, offers: { revert: false } });
    // GitHub named no merge commit: nothing to revert by
    expect(opened("n").offers.revert).toBe(false);
    expect(opened("g").checks.thread.find((check) => check.kind === "gate")).toEqual({ kind: "gate", tone: "warn", gate });
    expect(opened("m").checks.thread.find((check) => check.kind === "gate")).toBeUndefined();
  });

  it("draws the Settings page in place of the project, with each project's setup command and how full each account is", () => {
    const settings = { file: "/c/fleet.json", roles: [], maxUsedPercent: 80, rateLimitCooldownMinutes: 60, maxConcurrent: 6, closeOnSettle: true, language: "", projects: [{ path: "/kept", setup: "make", merge: PERSON }, { path: "/repo", setup: "", merge: GATED }], readOnlyAgents: ["claude" as const] };
    const usage = { status: "ready" as const, again: false, refreshing: false, data: [
      { key: "codex", reading: { readAt: 1, windows: [{ name: "5h", usedPercent: 85 }, { name: "weekly", usedPercent: 40 }] } },
      { key: "claude", reading: { readAt: 1, windows: [{ name: "5h", usedPercent: 99, resetsAt: NOW - 1 }, { name: "weekly", usedPercent: 30 }] } },
      { key: "pi" },
    ] };
    const model = fleetScreenModel(withRuns([coordinator(), lead("t")], {
      usage, fleetView: { ...INITIAL_STATE.fleetView, settings: true, open: { kind: "thread", runId: "t", member: null } },
      fleetSettings: { status: "ready", data: settings, cwd: "/repo", saving: 1, seq: 1 },
      fleetEntrances: { status: "ready", data: { entrances: [{ id: "agents", file: "/h/.agents/skills/herdr-fleet/SKILL.md", readers: ["pi", "codex", "cursor"], state: "outdated" }], tokenRequired: true }, busy: "agents" },
    }), NOW);
    expect(model.open).toBeNull();
    expect(model.settings).toMatchObject({ status: "ready", saving: true, settings });
    expect(model.settings!.projects).toEqual([{ path: "/repo", name: "repo", setup: "", merge: GATED }, { path: "/kept", name: "kept", setup: "make", merge: PERSON }]);
    // a project the person's fleet.json does not name leaves every merge to the person
    const known = fleetScreenModel(withRuns([coordinator({ project: "/other", cwd: "/other" })], { fleetView: { ...INITIAL_STATE.fleetView, settings: true }, fleetSettings: { status: "ready", data: { ...settings, projects: [] }, cwd: "/other", saving: 0, seq: 1 } }), NOW);
    expect(known.settings!.projects).toEqual([{ path: "/other", name: "other", setup: "", merge: PERSON }]);
    // a window that reset no longer counts
    expect(model.settings!.accounts).toEqual([{ key: "claude", usedPercent: 30, skipped: false }, { key: "codex", usedPercent: 85, skipped: true }]);
    expect(model.settings!.entrances).toEqual({ status: "ready", list: [{ id: "agents", file: "/h/.agents/skills/herdr-fleet/SKILL.md", readers: ["pi", "codex", "cursor"], state: "outdated" }], tokenRequired: true, busy: "agents" });
    expect(fleetScreenModel(withRuns([coordinator()]), NOW).settings).toBeNull();
  });

  it("offers each CLI's models, and marks a candidate whose model its CLI does not offer", () => {
    const candidate = (agent: "codex" | "claude" | "pi", model?: string) => ({ agent, ...(model ? { model } : {}) });
    const role = (name: string, candidates: Array<ReturnType<typeof candidate>>) => ({ name, description: name, readOnly: false, candidates, changed: false, defaults: { candidates } });
    const settings = { file: "/c/fleet.json", roles: [role("worker", [candidate("codex", "gpt-6:high"), candidate("codex", "gpt-9"), candidate("claude", "claude-opus-9"), candidate("pi")])], maxUsedPercent: 80, rateLimitCooldownMinutes: 60, maxConcurrent: 6, closeOnSettle: true, language: "", projects: [], readOnlyAgents: [] };
    const listings = [
      { agent: "codex" as const, models: [{ id: "gpt-6", label: "GPT-6" }], complete: true },
      { agent: "claude" as const, models: [{ id: "opus" }], complete: false },
      { agent: "pi" as const, models: [], complete: false, error: "pi failed" },
    ];
    const model = fleetScreenModel(withRuns([coordinator()], {
      fleetView: { ...INITIAL_STATE.fleetView, settings: true },
      fleetSettings: { status: "ready", data: settings, cwd: "/repo", saving: 0, seq: 0 },
      fleetModels: { status: "ready", data: listings },
    }), NOW);
    // a CLI that gave nothing offers nothing; a list that is not complete flags no one
    expect(model.settings!.models).toEqual({ options: { codex: [{ id: "gpt-6", label: "GPT-6" }], claude: [{ id: "opus" }] }, unlisted: ["worker:1"] });
  });

  it("puts each thread's card under the coordinator's turn it was started in", () => {
    const turn = (role: "user" | "assistant", ts: string): ConversationTurn => ({ role, ts, parts: [] });
    const at = (iso: string) => Date.parse(iso);
    const turns = [turn("user", "2026-10-11T10:00:00Z"), turn("assistant", "2026-10-11T10:00:05Z"), turn("user", "2026-10-11T10:05:00Z"), turn("assistant", "2026-10-11T10:05:02Z")];
    const model = fleetScreenModel(withRuns([coordinator(), lead("a", { startedAt: at("2026-10-11T10:00:30Z") }), lead("b", { startedAt: at("2026-10-11T10:06:00Z") }), lead("early", { startedAt: at("2026-10-11T09:00:00Z") })]), NOW);
    const cards = threadCards(turns, model.threads);
    expect([...cards.entries()].map(([ts, rows]) => [ts, rows.map((row) => row.id)])).toEqual([["2026-10-11T10:00:05Z", ["a"]], ["2026-10-11T10:05:02Z", ["b"]]]);
  });
});
