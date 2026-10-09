import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import { DEFAULT_SETTINGS, SettingsProvider } from "../lib/settings.ts";
import { KeyBar, type KeyBarModel } from "./KeyBar.tsx";

/** English, as under the app's own provider with an English browser */
function render(values: KeyBarModel): string {
  return renderBare(createElement(SettingsProvider, { settings: DEFAULT_SETTINGS, onChange: () => {}, children: createElement(KeyBar, { model: values, emit: () => {} }) }));
}

describe("Key bar view", () => {
  it("offers the switch to typing straight into the terminal only on a touch screen, first, pressed when on", () => {
    expect(render({ disabled: false, ctrlArmed: false, directTyping: null })).not.toContain('data-key="direct"');
    const touch = render({ disabled: false, ctrlArmed: false, directTyping: true });
    expect(touch).toMatch(/^<div class="key-bar"[^>]*><button[^>]*data-key="direct"[^>]*aria-pressed="true"/);
  });

  it("shows Control armed, and holds every key while an input method composes", () => {
    expect(render({ disabled: false, ctrlArmed: true, directTyping: null })).toMatch(/class="key is-armed" data-key="Control"[^>]*aria-pressed="true"/);
    expect(render({ disabled: true, ctrlArmed: false, directTyping: null }).match(/disabled=""/g)?.length).toBe(8);
  });
});
