import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import { DEFAULT_SETTINGS, SettingsProvider } from "../../lib/settings.ts";
import type { AgentRun } from "../../../shared/fleet.ts";
import { fleetScreenModel } from "../../ui/fleetView.ts";
import { INITIAL_STATE, type UiState } from "../../ui/state.ts";
import { FleetScreen, forRun } from "./FleetScreen.tsx";
import { RunCard } from "./RunCard.tsx";
import { RunDetailSheet } from "./RunDetailSheet.tsx";
import { UsageCapsule } from "./UsageCapsule.tsx";
import { t } from "../../lib/i18n.ts";

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
  it("draws the runs in the order they need the person, with the usage beside the title", () => {
    const html = renderToStaticMarkup(createElement(FleetScreen, {
      model: model(state([run("impl"), run("review", { state: "blocked", lastError: "codex asks to run a command" })], {
        usage: { status: "ready", again: false, refreshing: false, data: [{ key: "claude", reading: { readAt: NOW, windows: [{ name: "5h", usedPercent: 92 }] } }] },
      })),
      screen: "fleet", emit: noop,
    }));
    expect(html.indexOf("review")).toBeLessThan(html.indexOf("impl"));
    expect(html).toContain("codex asks to run a command");
    expect(html).toContain("Open pane to answer");
    expect(html).toContain('class="fleet-capsule level-low"');
    expect(html).toContain("--fleet-ring:92%");
    expect(html).toContain('aria-pressed="true">Fleet</button>');
  });

  it("says when there are no runs yet, and folds ended runs behind a button", () => {
    expect(renderToStaticMarkup(createElement(FleetScreen, { model: model(state([])), screen: "fleet", emit: noop }))).toContain("No fleet agents yet");
    const html = renderToStaticMarkup(createElement(FleetScreen, { model: model(state([run("old", { state: "stopped" })])), screen: "fleet", emit: noop }));
    expect(html).toContain("Show 1 ended runs");
    expect(html).not.toContain(">old<");
  });

  it("offers no pane or interrupt where there is none, and shows a finished run's result", () => {
    const ended = model(state([run("old", { state: "stopped" })])).ended[0]!;
    const html = renderToStaticMarkup(createElement(RunCard, { run: ended, now: NOW, emit: noop }));
    expect(html).not.toContain("Open pane");
    expect(html).not.toContain("Interrupt");
    const done = model(state([run("scout", { state: "done", result: "HANDOFF\noutcome: read only" })])).sections[0]!.runs[0]!;
    expect(renderToStaticMarkup(createElement(RunCard, { run: done, now: NOW, emit: noop }))).toContain("outcome: read only");
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

  it("tells in the detail how the run was routed, and that only a person answers its question", () => {
    const detail = model(state([run("review", { state: "blocked", lastError: "asks", skipped: [{ candidate: "claude:sonnet", reason: "claude has used 92% of its 5h limit" }] })], { detail: "review" })).detail!;
    const html = renderToStaticMarkup(createElement(RunDetailSheet, { run: detail, now: NOW, emit: noop }));
    expect(html).toContain("claude:sonnet");
    expect(html).toContain("claude has used 92% of its 5h limit");
    expect(html).toContain("codex:gpt-6");
    expect(html).toContain(t("The fleet never answers a question; only a person does."));
    expect(html).toContain("1:03");
  });
});

describe("events from the views", () => {
  it("bubble up as the Mediator's events for the run they are about", () => {
    const events: unknown[] = [];
    const emit = forRun((event) => events.push(event), "r1");
    for (const type of ["open-pane", "interrupt", "show-detail", "close"] as const) emit({ type });
    expect(events).toEqual([
      { type: "open-pane", runId: "r1" }, { type: "interrupt-run", runId: "r1" }, { type: "show-run", runId: "r1" }, { type: "hide-run" },
    ]);
  });
});
