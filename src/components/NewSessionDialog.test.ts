import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import { DEFAULT_SETTINGS, SettingsProvider } from "../lib/settings.ts";
import { NewSessionDialog, type NewSessionModel } from "./NewSessionDialog.tsx";

const model = (extra: Partial<NewSessionModel> = {}): NewSessionModel => ({
  open: true, machineId: "local", machineName: "omarchy", seq: 1, agents: [{ kind: "claude", label: "Claude Code" }] as never,
  agentKind: "claude", cwd: "/w/api", name: "", status: "editing", error: null, createdPaneId: null, ...extra,
});

/** English, as under the app's own provider with an English browser */
function render(values: NewSessionModel): string {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderBare(createElement(SettingsProvider, { settings: DEFAULT_SETTINGS, onChange: () => {}, children: createElement(NewSessionDialog, { model: values, browser: () => null, emit: () => {} }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("New session dialog view", () => {
  it("names the PC, shows what is typed, and the folder as the name's hint", () => {
    const html = render(model());
    expect(html).toContain("New session · omarchy");
    expect(html).toContain('value="/w/api"');
    expect(html).toContain('placeholder="api"');
  });

  it("says the agent is starting, and holds every button meanwhile", () => {
    const html = render(model({ status: "starting" }));
    expect(html).toContain("Starting Claude Code… up to 60s");
    expect(html).toMatch(/disabled="">Starting…<\/button>/);
  });

  it("offers the pane made when its agent did not start, and says why", () => {
    const html = render(model({ createdPaneId: "w9:p1", error: { kind: "message", message: "claude is not signed in" } }));
    expect(html).toContain(">Open session</button>");
    expect(html).toContain("claude is not signed in");
  });

  it("says a folder that is not there in words", () => {
    expect(render(model({ error: { kind: "invalid-cwd" } }))).toContain("Directory not found");
  });
});
