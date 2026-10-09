import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import type { HerdrPane } from "../../shared/protocol.ts";
import { DEFAULT_SETTINGS, SettingsProvider } from "../lib/settings.ts";
import { Droplet, type DropletModel } from "./Droplet.tsx";

const pane = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: "blocked", agent: "claude" } as HerdrPane;
const model = (extra: Partial<DropletModel["notice"]> = {}, phase: DropletModel["phase"] = "in"): DropletModel => ({
  notice: { id: 1, machineId: "local", machineName: null, pane, kind: "blocked", ...extra }, title: "api", phase,
});

/** English, as under the app's own provider with an English browser */
function render(values: DropletModel): string {
  return renderBare(createElement(SettingsProvider, { settings: DEFAULT_SETTINGS, onChange: () => {}, children: createElement(Droplet, { model: values, emit: () => {} }) }));
}

describe("In-app alert view", () => {
  it("names the pane and what happened, and offers to open it", () => {
    const html = render(model());
    expect(html).toContain('data-kind="blocked"');
    expect(html).toContain('aria-label="api, Needs you. Open pane"');
    expect(html).toContain('<span class="droplet-title">api</span>');
  });

  it("names the PC beside what happened when there are several, and folds away when told", () => {
    const html = render(model({ kind: "ended", machineName: "omarchy" }, "out"));
    expect(html).toContain("omarchy · terminal ended");
    expect(html).toContain('data-phase="out"');
  });
});
