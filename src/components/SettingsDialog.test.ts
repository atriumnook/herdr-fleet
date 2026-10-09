import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import type { RemoteAccess } from "../../shared/protocol.ts";
import { DEFAULT_SETTINGS, SettingsProvider } from "../lib/settings.ts";
import { settingsDialogModel } from "../ui/settingsView.ts";
import { INITIAL_STATE, type UiState } from "../ui/state.ts";
import { SettingsDialog } from "./SettingsDialog.tsx";

const LOCAL = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:7000", secure: true };
const served: RemoteAccess = { port: 7000, tailscale: { state: "running", dns_name: "pc.tail.ts.net", serving_url: "https://pc.tail.ts.net", serve_command: null, serve_url: null } };
const open = (extra: Partial<UiState> = {}): UiState => ({ ...INITIAL_STATE, settingsDialog: { open: true, drafts: {} }, ...extra });
const install = { installed: false, canInstall: true, help: "" };
const noop = () => {};

/** the dialog reads the settings, as under the app's own provider */
function render(state: UiState, extra: Partial<Parameters<typeof SettingsDialog>[0]> = {}): string {
  const model = settingsDialogModel(state, LOCAL);
  if (!model) throw new Error("the dialog is closed");
  return renderBare(createElement(SettingsProvider, {
    settings: DEFAULT_SETTINGS, onChange: noop,
    children: createElement(SettingsDialog, { model, install, alerts: "ALERTS-SLOT", devices: "DEVICES-SLOT", emit: noop, ...extra }),
  }));
}

describe("Settings dialog view", () => {
  it("has no values to draw while closed", () => {
    expect(settingsDialogModel(INITIAL_STATE, LOCAL)).toBeNull();
  });

  it("draws the settings it is given, not the ones the provider holds", () => {
    const html = render(open({ settings: { ...DEFAULT_SETTINGS, theme: "light", terminalFontSize: 17 } }));
    expect(html).toContain('aria-pressed="true">Light</button>');
    expect(html).toContain("17px");
  });

  it("shows a font list being typed in place of the one set", () => {
    const html = render(open({ settings: { ...DEFAULT_SETTINGS, chatFontFamily: "Inter" }, settingsDialog: { open: true, drafts: { chatFontFamily: "Menlo, " } } }));
    expect(html).toContain('value="Menlo, "');
    expect(html).not.toContain('value="Inter"');
  });

  it("draws the parent's alert and device panels where they belong", () => {
    const html = render(open());
    expect(html.indexOf("ALERTS-SLOT")).toBeGreaterThan(html.indexOf(">Alerts<"));
    expect(html.indexOf("DEVICES-SLOT")).toBeGreaterThan(html.indexOf(">Devices<"));
  });

  it("offers to install only when the browser can, and says so once installed", () => {
    expect(render(open())).toContain(">Install app</button>");
    expect(render(open(), { install: { installed: true, canInstall: false, help: "" } })).toContain(">Installed<");
    expect(render(open(), { install: { installed: false, canInstall: false, help: "Choose File, then Add to Dock." } })).toContain("Choose File, then Add to Dock.");
  });

  it("pairs a phone with the address Tailscale serves, and with none from loopback alone", () => {
    expect(settingsDialogModel(open({ remoteAccess: { status: "ready", data: served, again: false } }), LOCAL)?.pairUrl).toBe("https://pc.tail.ts.net");
    expect(settingsDialogModel(open({ remoteAccess: { status: "error", data: null, again: false } }), LOCAL)?.pairUrl).toBeNull();
    expect(settingsDialogModel(open(), { ...LOCAL, hostname: "192.168.1.5", origin: "http://192.168.1.5:7000" })?.pairUrl).toBe("http://192.168.1.5:7000");
  });

  it("says it is checking the remote access until the server answers", () => {
    expect(settingsDialogModel(open({ remoteAccess: { status: "loading", data: null, again: false } }), LOCAL)?.phone.loading).toBe(true);
    expect(settingsDialogModel(open({ remoteAccess: { status: "ready", data: served, again: false } }), LOCAL)?.phone).toEqual({ plan: { kind: "served", url: "https://pc.tail.ts.net" }, loading: false });
  });
});
