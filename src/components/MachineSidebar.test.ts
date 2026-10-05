import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import type { Machine } from "../../shared/machines.ts";
import { DEFAULT_SETTINGS, SettingsProvider } from "../lib/settings.ts";
import { MachineSidebar, type MachineSidebarModel } from "./MachineSidebar.tsx";

// the build defines it (vite.config.ts); the footer prints it
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = "0.0.0-test";

const pc = (extra: Partial<Machine> = {}): Machine => ({ id: "local", name: "omarchy", kind: "local", enabled: true, state: "connected", error: null, snapshot: null, ...extra });
const model = (extra: Partial<MachineSidebarModel> = {}): MachineSidebarModel => ({
  machines: [pc()], selectedMachineId: "local", selectedPaneId: null, version: "0.9.1", install: { installed: false, canInstall: true, help: "" }, ...extra,
});

/** English, as under the app's own provider with an English browser */
function render(values: MachineSidebarModel): string {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderBare(createElement(SettingsProvider, {
      settings: DEFAULT_SETTINGS, onChange: () => {},
      children: createElement(MachineSidebar, { model: values, tree: (machine: Machine) => `TREE-${machine.id}`, emit: () => {} }),
    }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("Machine sidebar view", () => {
  it("says it is loading until a PC is known", () => {
    expect(render(model({ machines: [] }))).toContain("Loading PCs…");
  });

  it("draws a connected PC's sessions from the shell, marks the selected PC, and shows herdr's version", () => {
    const html = render(model());
    expect(html).toContain("TREE-local");
    expect(html).toContain('class="machine-group is-current"');
    expect(html).toContain("herdr 0.9.1");
  });

  it("spells out a PC that is not connected, and keeps its sessions out of reach", () => {
    const html = render(model({ machines: [pc({ state: "reconnecting" })] }));
    expect(html).toContain("Reconnecting…");
    expect(html).toContain("No saved sessions");
    expect(html).not.toContain("TREE-local");
  });

  it("offers the install only where the app is not installed", () => {
    expect(render(model())).toContain("Install app");
    expect(render(model({ install: { installed: true, canInstall: false, help: "" } }))).not.toContain("Install app");
  });
});
