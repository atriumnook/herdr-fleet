import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import { DEFAULT_SETTINGS, SettingsProvider } from "../lib/settings.ts";
import { Composer, type ComposerModel } from "./Composer.tsx";
import { TerminalInput, type TerminalInputModel } from "./TerminalInput.tsx";

const model = (extra: Partial<ComposerModel> = {}): ComposerModel => ({
  machineId: "local", paneId: "w1:p1", owner: "w1:p1", connected: true, autoFocus: false, agent: "claude", agentStatus: "idle", metadata: null, queueMode: false,
  answerHint: null, suggestion: null, text: "", draftRead: true, sending: false, settled: undefined, outcome: undefined, commands: [], files: [], slashUsage: {},
  attachments: [], enterSends: true, showSuggestionChip: false, quickReplies: null, ...extra,
});

/** English, as under the app's own provider with an English browser */
function render(element: ReturnType<typeof createElement>): string {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderBare(createElement(SettingsProvider, { settings: DEFAULT_SETTINGS, onChange: () => {}, children: element }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
}
const composer = (values: ComposerModel) => render(createElement(Composer, { model: values, emit: () => {} }));

describe("Composer view", () => {
  it("shows the draft, and says what a message does now in the placeholder", () => {
    expect(composer(model({ text: "hello" }))).toContain(">hello</textarea>");
    expect(composer(model({ connected: false }))).toContain('placeholder="Reconnecting… message held here, never queued"');
    expect(composer(model({ answerHint: "Answer above: type 1–2 to choose…" }))).toContain('placeholder="Answer above: type 1–2 to choose…"');
    expect(composer(model({ suggestion: "run the tests" }))).toContain('placeholder="run the tests"');
  });

  it("offers the quick replies chosen in Settings, and only then", () => {
    expect(composer(model({ quickReplies: ["yes", "continue"] }))).toContain(">continue</button>");
    expect(composer(model())).not.toContain(">continue</button>");
  });

  it("shows each attached file's upload as it goes", () => {
    const file = new File(["x"], "notes.txt", { type: "text/plain" });
    const html = composer(model({ attachments: [{ id: 1, file, machineId: "local", paneId: "w1:p1", batch: 1, path: null, state: "uploading" }] }));
    expect(html).toContain("notes.txt");
    expect(html).toContain("Uploading");
  });
});

describe("Terminal input line view", () => {
  const line = (extra: Partial<TerminalInputModel> = {}): TerminalInputModel => ({ owner: "w1:p1", connected: true, text: "", sending: false, outcome: undefined, ...extra });
  const draw = (values: TerminalInputModel) => render(createElement(TerminalInput, { model: values, onEnter: () => true, emit: () => {} }));

  it("shows the line kept for the pane, and offers Enter alone while it is empty", () => {
    expect(draw(line({ text: "ls -la" }))).toContain(">ls -la</textarea>");
    expect(draw(line())).toContain('aria-label="Press Enter in the terminal"');
    expect(draw(line({ text: "ls" }))).toContain('aria-label="Send to the terminal"');
  });
});
