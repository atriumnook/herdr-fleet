import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import { DEFAULT_SETTINGS, SettingsProvider } from "../lib/settings.ts";
import { QueuedMessages, type QueuedMessagesModel } from "./QueuedMessages.tsx";

const model = (extra: Partial<QueuedMessagesModel> = {}): QueuedMessagesModel => ({
  messages: [{ id: "a", text: "first" }, { id: "b", text: "second" }], unsaved: false, sending: null, anySending: false, error: null, canSend: true, heldByOpenQueue: false, ready: true, ...extra,
});

/** English, as under the app's own provider with an English browser */
function render(values: QueuedMessagesModel): string {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderBare(createElement(SettingsProvider, { settings: DEFAULT_SETTINGS, onChange: () => {}, children: createElement(QueuedMessages, { model: values, emit: () => {} }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("Held messages view", () => {
  it("lists each held message for review, and says they wait while the agent works", () => {
    const html = render(model());
    expect(html).toContain("Queued messages (2)");
    expect(html).toContain("Held message — review and send");
    expect(render(model({ ready: false }))).toContain("Held until the agent is ready");
  });

  it("holds every Send now while one goes out, and the one going out from edits", () => {
    const html = render(model({ sending: "a", anySending: true }));
    expect(html.match(/class="composer-queue-send" disabled=""/g)?.length).toBe(2);
    expect(html).toMatch(/id="queued-a"[^>]*disabled=""/);
  });

  it("says why the last one did not go, and a queue this device could not keep", () => {
    expect(render(model({ error: { owner: "o", id: "a", note: { kind: "said", text: "the pane refused it" } } }))).toContain("the pane refused it");
    expect(render(model({ error: { owner: "o", id: "a", note: { kind: "not-sent" } } }))).toContain("Not sent. Reconnect and try again.");
    expect(render(model({ unsaved: true }))).toContain("Queue could not be saved.");
  });
});
