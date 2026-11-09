import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import { DEFAULT_SETTINGS, SettingsProvider } from "../../lib/settings.ts";
import type { AgentRun, AgentState, PullRequest, ReportState } from "../../../shared/fleet.ts";
import { fleetScreenModel } from "../../ui/fleetView.ts";
import { INITIAL_STATE, type UiState } from "../../ui/state.ts";
import { FleetScreen, forRun } from "./FleetScreen.tsx";
import { RunCard } from "./RunCard.tsx";
import { ThreadCard } from "./ThreadCard.tsx";
import { ProjectRail } from "./ProjectRail.tsx";
import { UsageCapsule } from "./UsageCapsule.tsx";
import { StateBadge } from "./format.tsx";

/** a run whose last turn reported `state` (report.json) */
const reported = (state: ReportState, summary: string, human_action?: string): Pick<AgentRun, "outcome"> => ({ outcome: { report: { state, summary, evidence: [], ...(human_action ? { human_action } : {}) } } });

const NOW = Date.now();
const run = (id: string, extra: Partial<AgentRun> = {}): AgentRun => ({
  id, name: id, role: "worker", agent: "codex", group: "g1", herdrName: `h-${id}`, paneId: `w1:${id}`, cwd: "/w", model: "gpt-6",
  state: "working", depth: 1, interactive: false, worktree: false, startedAt: NOW - 63_000, updatedAt: NOW, ...extra,
});
const state = (runs: AgentRun[], extra: Partial<UiState> = {}): UiState => ({ ...INITIAL_STATE, screen: "fleet", runs: { status: "ready", data: runs, again: false }, ...extra });
const model = (s: UiState) => fleetScreenModel(s, NOW);
const noop = () => {};
/** the views read the settings, as under the app's own provider */
function renderToStaticMarkup(element: ReturnType<typeof createElement>): string {
  return renderBare(createElement(SettingsProvider, { settings: DEFAULT_SETTINGS, onChange: () => {}, children: element }));
}

describe("Fleet screen views", () => {
  const lead = (id: string, extra: Partial<AgentRun> = {}) => run(id, { role: "lead", agent: "claude", project: "/repo", group: `g-${id}`, interactive: true, branch: `fleet/${id}`, state: "idle", ...extra });
  const coordinator = run("co", { role: "coordinator", agent: "claude", project: "/repo", group: "g-co", interactive: true, state: "idle" });
  const screen = (s: UiState, slots: { conversation?: string; side?: string } = {}) => renderToStaticMarkup(createElement(FleetScreen, {
    model: model(s), conversation: createElement("div", { className: "slot-conversation" }, slots.conversation ?? "conversation"),
    side: createElement("div", { className: "slot-side" }, slots.side ?? "side"), emit: noop,
  }));

  it("draws a lead's plan in its own tab: the claims closed to their first level, the decisions, the code, and Respond", () => {
    const ask = { id: "limit", question: "How many retries?", options: [{ value: "three", label: "3 retries" }, { value: "five", label: "5 retries", note: "claim 1.1 goes" }], recommended: "three" };
    const data = {
      version: 1, writtenAt: 1, title: "Retry limit", why: ["retries spam the log"], scope: ["Drafts"],
      claims: [{ text: "A failed send is tried three times.", ask, children: [{ text: "retry.ts:3 · shouldRetry()", exhibit: { kind: "code" as const, path: "src/retry.ts", start: 3, end: 4, lines: ["function shouldRetry() {", "  return attempt < RETRIES;"] }, children: [] }] }],
    };
    const thread = lead("t", { ...reported("blocked", "The plan waits.", "Answer the plan in the Plan tab."), plan: { version: 1, asks: 1 } });
    const html = screen(state([coordinator, thread], {
      fleetView: { ...INITIAL_STATE.fleetView, open: { kind: "thread", runId: "t", member: null }, tab: "plan" },
      plan: { runId: "t", reading: { status: "ready", data }, drafts: {}, confirm: null, dropped: null, seq: 0 },
    }));
    expect(html).toContain('<button type="button" aria-pressed="true">Plan<span class="fleet-tab-alert" aria-label="Needs you">1</span></button>');
    expect(html).toContain('<span class="fleet-plan-left">1 to answer</span>');
    expect(html).toContain("A failed send is tried three times.");
    expect(html).toContain('role="radio" aria-checked="true"');
    expect(html).toContain("src/retry.ts:3–4");
    expect(html).toContain("return attempt &lt; RETRIES;");
    expect(html).toContain("Not changing");
    expect(html).toMatch(/<button type="button" class="btn btn-primary">Respond<\/button>/);
    // the chat stays mounted behind the plan
    expect(html).toMatch(/class="fleet-open-chat" hidden=""/);
    expect(html).not.toContain("fleet-plan-dropped");
    // answers to an older version were dropped: the plan says so
    const replaced = screen(state([coordinator, thread], {
      fleetView: { ...INITIAL_STATE.fleetView, open: { kind: "thread", runId: "t", member: null }, tab: "plan" },
      plan: { runId: "t", reading: { status: "ready", data }, drafts: {}, confirm: null, dropped: { runId: "t", version: 0 }, seq: 0 },
    }));
    expect(replaced).toContain("lead が計画の版 1 を出したので、版 0 への回答は破棄しました。");
  });

  it("draws the project conversation beside the Overview, its threads by what the person has to do", () => {
    const html = screen(state([coordinator, lead("ask", { ...reported("blocked", "Keep the old API?", "Keep the old API?") }), lead("done", { ...reported("ready", "Done."), diff: { added: 24, removed: 9, files: 2 } }), lead("busy", { state: "working" })]));
    expect(html).toContain("slot-conversation");
    expect(html).not.toContain("slot-side");
    expect(html).toContain("coordinator · claude");
    expect(html.indexOf('id="fleet-group-needs"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="fleet-group-needs"')).toBeLessThan(html.indexOf('id="fleet-group-review"'));
    expect(html.indexOf('id="fleet-group-review"')).toBeLessThan(html.indexOf('id="fleet-group-working"'));
    expect(html).toContain("Keep the old API?");
    expect(html).toContain("+24");
    // the Overview button carries the dot while a thread waits on the person
    expect(html).toContain("fleet-needs-dot");
    expect(html).toContain('aria-label="Overview: 1 need you"');
  });

  it("asks for the first message while the project has no coordinator, and says when there is no project", () => {
    const html = screen(state([lead("t")]));
    expect(html).toContain("Ask repo");
    expect(html).toContain("No coordinator yet");
    expect(html).not.toContain("slot-conversation");
    expect(screen(state([]))).toContain("No projects yet");
  });

  it("opens a thread in the Overview with its agents and its chat, and large in the middle when expanded", () => {
    const runs = [coordinator, lead("t", { ...reported("ready", "Done."), contract: [{ id: "A1", state: "met" }, { id: "A2", state: "open" }] }), run("rev", { role: "reviewer", group: "g-t", agent: "cursor", state: "done" })];
    const open = (expanded: boolean) => screen(state(runs, { fleetView: { project: null, overview: true, open: { kind: "thread", runId: "t", member: null }, expanded, tab: "chat", settings: false } }));
    const beside = open(false);
    expect(beside).toContain("slot-conversation");
    expect(beside).toContain("slot-side");
    expect(beside).toContain("lead · claude");
    expect(beside).toContain("rev · cursor");
    expect(beside).toContain("A1 ✓");
    expect(beside).toContain(">Resolve<");
    expect(beside).toContain('aria-label="Expand"');
    const large = open(true);
    expect(large).not.toContain("slot-conversation");
    expect(large).toContain('aria-label="Collapse"');
    // the Overview lists the threads again, the open one marked
    expect(large).toContain("fleet-row group-review is-selected");
  });

  it("offers the steps that land a thread, and its chat, change and checks", () => {
    const opened = (target: AgentRun, extra: Partial<UiState> = {}) => screen(state([coordinator, target], { fleetView: { ...INITIAL_STATE.fleetView, open: { kind: "thread", runId: target.id, member: null }, ...extra.fleetView }, ...extra }));
    const review = opened(lead("t", { ...reported("ready", "Done."), baseBranch: "main", diff: { added: 3, removed: 1, files: 1 } }));
    expect(review).toContain(">Discard<");
    expect(review).toContain(">Merge into main<");
    expect(review).toContain(">Create PR<");
    expect(review).toContain(">Chat</button>");
    expect(review).toContain(">Changes</button>");
    expect(review).toContain(">Checks</button>");
    // the chat stays mounted while it shows
    expect(review).toMatch(/class="fleet-open-chat"><div class="slot-side"/);
    // the lead at work: its steps wait
    expect(opened(lead("t", { state: "working", diff: { added: 3, removed: 1, files: 1 } }))).toMatch(/disabled="" class="btn btn-primary"|class="btn btn-primary" disabled="">Create PR/);
    const pr: PullRequest = { number: 70, url: "https://github.com/o/r/pull/70", state: "OPEN", checks: "fail", failing: ["test"] };
    const landing = opened(lead("t", { ...reported("ready", "Done."), pr, landing: { action: "fix-ci", at: 1, sent: true } }));
    expect(landing).toContain('href="https://github.com/o/r/pull/70"');
    expect(landing).toContain("PR #70");
    expect(landing).toContain("Lead is fixing CI…");
    expect(landing).not.toContain(">Create PR<");
    expect(landing).toContain(">Merge PR<");
    expect(landing).toContain("fleet-tab-alert");
    expect(opened(lead("t", { ...reported("ready", "Done."), landed: "merged", resolvedAt: 1, state: "stopped", baseBranch: "main" }))).toContain("Merged into main");
  });

  it("draws a thread's change with the comments not sent yet, and its checks with the steps that settle them", () => {
    const target = lead("t", { ...reported("ready", "Done."), baseBranch: "main", diff: { added: 1, removed: 1, files: 1 }, pr: { number: 70, url: "https://github.com/o/r/pull/70", state: "OPEN", checks: "fail", failing: ["test", "lint"] } });
    const diff = ["diff --git a/a.md b/a.md", "--- a/a.md", "+++ b/a.md", "@@ -1,2 +1,2 @@", " same", "-old", "+new"].join("\n");
    const landing = {
      runId: "t", diff: { status: "ready" as const, data: { diff, truncated: false } },
      checks: { status: "ready" as const, data: { baseBranch: "main", uncommitted: [], ahead: 2, behind: 3 } },
      comments: { t: [{ file: "a.md", line: 2, text: "why the new word?" }] }, confirm: null,
    };
    const tab = (name: "changes" | "checks") => screen(state([coordinator, target], { fleetView: { ...INITIAL_STATE.fleetView, open: { kind: "thread", runId: "t", member: null }, tab: name }, landing }));
    const changes = tab("changes");
    expect(changes).toContain("compared with main");
    expect(changes).toContain('class="fleet-file is-on"');
    expect(changes).toContain("fleet-line is-add has-comment");
    expect(changes).toContain("why the new word?");
    expect(changes).toContain("not sent");
    expect(changes).toContain("1 comment for the lead");
    expect(changes).toContain(">Send to lead<");
    // the chat waits behind, hidden
    expect(changes).toContain('class="fleet-open-chat" hidden=""');
    const checks = tab("checks");
    expect(checks).toContain("All work committed");
    expect(checks).toContain("main moved 3 commits ahead");
    expect(checks).toContain(">Update branch<");
    expect(checks).toContain("1 comment not sent");
    expect(checks).toContain("Checks failed");
    expect(checks).toContain("test · lint");
    expect(checks).toContain(">Fix CI<");
    expect(checks).toContain("No review on another CLI");
  });

  it("offers Revert on a merged thread, says the gate merged it, and draws the merge gate among the checks", () => {
    const opened = (target: AgentRun, tab: "chat" | "checks" = "chat") => screen(state([coordinator, target], { fleetView: { ...INITIAL_STATE.fleetView, open: { kind: "thread", runId: target.id, member: null }, tab } }));
    const merged = opened(lead("t", { ...reported("ready", "Done."), landed: "merged", merged: { by: "gate", via: "pr", base: "rust", at: 1, commit: "abc0001" }, state: "stopped", baseBranch: "rust" }));
    expect(merged).toContain("Merged into rust by the gate");
    expect(merged).toMatch(/<button type="button" class="btn">Revert<\/button>/);
    const reverting = opened(lead("t", { ...reported("ready", "Done."), landed: "merged", merged: { by: "person", via: "local", base: "rust", at: 1, commit: "abc0001" }, landing: { action: "revert", at: 2, sent: true }, state: "stopped", baseBranch: "rust" }));
    expect(reverting).toContain("Coordinator is reverting the merge…");
    expect(reverting).toMatch(/disabled="">Revert<\/button>/);
    expect(opened(lead("t", { ...reported("ready", "Done."), landed: "merged", merged: { by: "gate", via: "pr", base: "rust", at: 1, commit: "abc0001" }, reverted: { at: 2, commit: "beef" }, state: "stopped", baseBranch: "rust" }))).not.toContain(">Revert<");
    const gate = { at: 1, ok: false, checks: [{ id: "report" as const, ok: true, detail: "The lead's latest report is ready." }, { id: "size" as const, ok: false, detail: "The change has 340 lines, over the limit of 200." }] };
    const checks = opened(lead("t", { ...reported("ready", "Done."), pr: { number: 9, url: "u", state: "OPEN", checks: "pass" }, gate }), "checks");
    expect(checks).toContain("Merge gate waits for you");
    expect(checks).toContain("The change has 340 lines, over the limit of 200.");
    expect(checks).not.toContain("The lead&#x27;s latest report is ready.");
  });

  it("draws the Settings page in place of the project: each role's candidates and the one the fleet would start now", () => {
    const settings = {
      file: "/home/me/.config/herdr-fleet/fleet.json", maxUsedPercent: 90, rateLimitCooldownMinutes: 60, maxConcurrent: 6, closeOnSettle: true, language: "", projects: [], readOnlyAgents: ["claude" as const],
      roles: [
        { name: "lead", description: "Owns one thread.", readOnly: false, changed: true, thinking: "high" as const, defaults: { candidates: [{ agent: "claude" as const }], thinking: "high" as const },
          candidates: [{ agent: "codex" as const, model: "gpt-6", skip: "codex has used 92% of its 5h limit" }, { agent: "claude" as const }] },
        { name: "coordinator", description: "Talks with you.", readOnly: true, changed: false, defaults: { candidates: [{ agent: "claude" as const }] }, candidates: [{ agent: "claude" as const }],
          project: { candidates: [{ agent: "claude" as const, model: "opus" }] } },
      ],
    };
    const html = screen(state([coordinator], { fleetView: { ...INITIAL_STATE.fleetView, settings: true }, fleetSettings: { status: "ready", data: settings, cwd: "/repo", saving: 0, seq: 0 } }));
    expect(html).not.toContain("slot-conversation");
    expect(html).toContain("Fleet settings");
    expect(html).toContain("/home/me/.config/herdr-fleet/fleet.json");
    expect(html).toContain("codex:gpt-6");
    expect(html).toContain("fleet-candidate is-skipped");
    expect(html).toContain("Now: claude");
    expect(html).toContain(">Changed<");
    expect(html).toContain(">Project<");
    expect(html).toContain(">Roles</button>");
    expect(html).toContain(">Limits</button>");
  });

  it("draws a thread's card with its change, its state, and what it waits on the person for", () => {
    const rows = model(state([coordinator, lead("ask", { state: "blocked", lastError: "Allow bun test?", diff: { added: 3, removed: 1, files: 1 } })])).threads;
    const html = renderToStaticMarkup(createElement(ThreadCard, { thread: rows[0]!, emit: noop }));
    expect(html).toContain("is-near");
    expect(html).toContain("Allow bun test?");
    expect(html).toContain("fleet/ask");
    expect(html).toContain('class="badge badge-blocked"');
  });

  it("lists the projects with what their threads ask of the person, and a new one from a folder", () => {
    const projects = [{ path: "/repo", name: "repo", dot: "needs" as const, selected: true }, { path: "/new", name: "new", dot: "none" as const, selected: false }];
    const html = renderToStaticMarkup(createElement(ProjectRail, { model: { projects, usage: { capsules: [], refreshing: false }, now: NOW, settings: false }, browser: () => null, emit: noop }));
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("fleet-project-dot dot-needs");
    expect(html).toContain("New project");
    expect(html.match(/fleet-project-dot/g)).toHaveLength(1);
    expect(html).toContain("Fleet settings");
  });

  it("offers no pane or interrupt where there is none, and shows a finished run's result", () => {
    const ended = model(state([run("old", { state: "stopped" })])).ended[0]!;
    const html = renderToStaticMarkup(createElement(RunCard, { run: ended, now: NOW, emit: noop }));
    expect(html).not.toContain("Open pane");
    expect(html).not.toContain("Interrupt");
    const done = model(state([run("scout", { state: "done", result: "HANDOFF\noutcome: read only" })])).sections[0]!.runs[0]!;
    expect(renderToStaticMarkup(createElement(RunCard, { run: done, now: NOW, emit: noop }))).toContain("outcome: read only");
  });

  it("writes a run's state with the word of its section, and none on an ended run", () => {
    const badge = (state: AgentState) => renderToStaticMarkup(createElement(StateBadge, { state }));
    expect(badge("starting")).toContain(">Working<");
    expect(badge("unknown")).toContain(">Working<");
    expect(badge("idle")).toContain(">Done<");
    expect(badge("blocked")).toContain(">Needs you<");
    expect(badge("failed")).toContain(">Failed<");
    expect(badge("stopped")).toBe("");
    const ended = model(state([run("old", { state: "stopped" })])).ended[0]!;
    expect(renderToStaticMarkup(createElement(RunCard, { run: ended, now: NOW, emit: noop }))).not.toContain('class="badge');
  });

  it("draws a run that needs you or failed nearest, and only the one that needs you with the way to answer", () => {
    const card = (runState: AgentRun["state"]) => {
      const m = model(state([run("r", { state: runState })]));
      return renderToStaticMarkup(createElement(RunCard, { run: m.sections[0]!.runs[0]!, now: NOW, emit: noop }));
    };
    expect(card("blocked")).toContain("is-near");
    expect(card("blocked")).toContain('class="btn btn-primary"');
    expect(card("failed")).toContain("is-near");
    expect(card("failed")).not.toContain("btn-primary");
    expect(card("working")).not.toContain("is-near");
    // the app's one badge, with the state's own class
    expect(card("failed")).toContain('class="badge badge-failed"');
    expect(card("working")).toContain('class="badge badge-working"');
  });

  it("shows a cooldown with the way to end it, and an account it could not read", () => {
    const capsules = model(state([], { usage: { status: "ready", again: false, refreshing: false, data: [
      { key: "cursor", cooldown: { until: NOW + 60_000, reason: "rate limit", since: NOW } },
      { key: "agy", error: "agy exited with 1" },
    ] } })).usage.capsules;
    const cooling = renderToStaticMarkup(createElement(UsageCapsule, { capsule: capsules.find((c) => c.key === "cursor")!, now: NOW, emit: noop }));
    expect(cooling).toContain("Cooling down until");
    expect(cooling).toContain(">Clear</button>");
    expect(renderToStaticMarkup(createElement(UsageCapsule, { capsule: capsules.find((c) => c.key === "agy")!, now: NOW, emit: noop }))).toContain("Last read failed");
  });

});

describe("events from the views", () => {
  it("bubble up as the Mediator's events for the run they are about", () => {
    const events: unknown[] = [];
    const emit = forRun((event) => events.push(event), "r1");
    for (const type of ["open-pane", "interrupt", "show-detail"] as const) emit({ type });
    expect(events).toEqual([{ type: "open-pane", runId: "r1" }, { type: "interrupt-run", runId: "r1" }, { type: "fleet-open", kind: "agent", runId: "r1" }]);
  });
});
