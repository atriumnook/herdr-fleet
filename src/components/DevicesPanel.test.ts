import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import type { PairedDevice } from "../../shared/protocol.ts";
import { DEFAULT_SETTINGS, SettingsProvider } from "../lib/settings.ts";
import { devicesPanelModel } from "../ui/devicesView.ts";
import { NO_DEVICES, type DevicesState } from "../ui/state.ts";
import { DevicesPanel } from "./DevicesPanel.tsx";
import { t } from "../lib/i18n.ts";

const device: PairedDevice = { id: "a", label: "iPhone", role: "drive", created_at: "2026-10-01T00:00:00Z", last_seen_at: null, current: true };
const code = { code: "123456", expires_at: new Date(Date.now() + 600_000).toISOString() };

/** English, as under the app's own provider with an English browser */
function render(devices: Partial<DevicesState>, pairUrl: string | null = null): string {
  const model = devicesPanelModel({ ...NO_DEVICES, ...devices }, pairUrl, { required: false, authenticated: true, via: "local" } as never);
  return renderBare(createElement(SettingsProvider, { settings: DEFAULT_SETTINGS, onChange: () => {}, children: createElement(DevicesPanel, { model, emit: () => {} }) }));
}

describe("Devices panel view", () => {
  it("says it is loading until the server answers, then lists the devices", () => {
    expect(render({})).toContain("Loading…");
    const html = render({ list: [device] });
    expect(html).toContain("iPhone");
    expect(html).toContain("this device");
    expect(html).toContain(t("You are on the PC itself."));
  });

  it("offers Revoke as a quiet button (its confirm is a dialog: devices-regression), and keeps the name being typed", () => {
    const html = render({ list: [device] });
    expect(html).toContain('class="btn btn-ghost"');
    expect(html).not.toContain("Revoke?");
    expect(render({ list: [device], renaming: { id: "a", label: "Desk" } })).toContain('value="Desk"');
  });

  it("shows the code out, with a link to open on a phone when one can reach this PC", () => {
    expect(render({ list: [], code })).toContain("123 456");
    expect(render({ list: [], code }, "https://pc.tail.ts.net/")).toContain('href="https://pc.tail.ts.net/?pair=123456"');
    expect(render({ list: [], code })).not.toContain("?pair=");
  });

  it("offers no pairing where the server keeps no devices, and says why", () => {
    const html = render({ list: [], unavailable: true, failure: { kind: "unavailable" } });
    expect(html).toContain(t("Devices are managed on a real server."));
    expect(html).toMatch(/disabled="">Pair a device<\/button>/);
  });
});
