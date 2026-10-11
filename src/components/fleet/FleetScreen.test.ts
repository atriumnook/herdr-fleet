import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import { DEFAULT_SETTINGS, SettingsProvider } from "../../lib/settings.ts";
import type { AgentRun, AgentState } from "../../../shared/fleet.ts";
import { fleetScreenModel } from "../../ui/fleetView.ts";
import { INITIAL_STATE, type UiState } from "../../ui/state.ts";
import { FleetScreen, forRun } from "./FleetScreen.tsx";
import { RunCard } from "./RunCard.tsx";
import { ThreadCard } from "./ThreadCard.tsx";
import { ProjectRail } from "./ProjectRail.tsx";
import { UsageCapsule } from "./UsageCapsule.tsx";
import { StateBadge } from "./format.tsx";

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

  it("draws the project conversation beside the Overview, its threads by what the person has to do", () => {
    const html = screen(state([coordinator, lead("ask", { result: "BLOCKED — keep the old API?" }), lead("done", { result: "PASS", diff: { added: 24, removed: 9, files: 2 } }), lead("busy", { state: "working" })]));
    expect(html).toContain("slot-conversation");
    expect(html).not.toContain("slot-side");
    expect(html).toContain("coordinator · claude");
    expect(html.indexOf('id="fleet-group-needs"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="fleet-group-needs"')).toBeLessThan(html.indexOf('id="fleet-group-review"'));
    expect(html.indexOf('id="fleet-group-review"')).toBeLessThan(html.indexOf('id="fleet-group-working"'));
    expect(html).toContain("BLOCKED — keep the old API?");
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
    const runs = [coordinator, lead("t", { result: "PASS", contract: [{ id: "A1", state: "met" }, { id: "A2", state: "open" }] }), run("rev", { role: "reviewer", group: "g-t", agent: "cursor", state: "done" })];
    const open = (expanded: boolean) => screen(state(runs, { fleetView: { project: null, overview: true, open: { kind: "thread", runId: "t", member: null }, expanded } }));
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
    const html = renderToStaticMarkup(createElement(ProjectRail, { model: { projects, usage: { capsules: [], refreshing: false }, canAct: true, now: NOW }, browser: () => null, emit: noop }));
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("fleet-project-dot dot-needs");
    expect(html).toContain("New project");
    expect(html.match(/fleet-project-dot/g)).toHaveLength(1);
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
