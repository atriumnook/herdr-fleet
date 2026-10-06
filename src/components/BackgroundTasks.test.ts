import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import type { OmoTask } from "../../shared/protocol.ts";
import { DEFAULT_SETTINGS, SettingsProvider } from "../lib/settings.ts";
import { BackgroundTasks, type BackgroundTasksModel } from "./BackgroundTasks.tsx";

const task = (id: string, status: OmoTask["status"], title: string): OmoTask => ({
  id, title, status, category: null, model: null, started_at: "2026-10-06T00:00:00.000Z", ended_at: status === "running" ? null : "2026-10-06T00:00:30.000Z", turns: null, tool_calls: null, tokens: null,
} as OmoTask);
const model = (extra: Partial<BackgroundTasksModel> = {}): BackgroundTasksModel => ({ count: 1, omo: true, open: true, activity: null, failed: false, ...extra });
const activity = (tasks: OmoTask[]) => ({ tasks, runs: [], offset: 0, readAt: Date.parse("2026-10-06T00:01:05.000Z") });

/** English, as under the app's own provider with an English browser */
function render(values: BackgroundTasksModel): string {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderBare(createElement(SettingsProvider, { settings: DEFAULT_SETTINGS, onChange: () => {}, children: createElement(BackgroundTasks, { model: values, emit: () => {} }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("Background tasks view", () => {
  it("shows nothing on a pane that is not OmO's while nothing runs", () => {
    expect(render(model({ count: 0, omo: false, open: false }))).toBe("");
    expect(render(model({ open: false }))).toContain('aria-label="1 background task"');
  });

  it("says it is loading, and that the first read failed", () => {
    expect(render(model())).toContain("Loading…");
    expect(render(model({ failed: true }))).toContain("Couldn&#x27;t load the background tasks");
  });

  it("lists what runs, timed on the PC's clock as of the read, and folds what ended into one line", () => {
    const html = render(model({ activity: activity([task("t1", "running", "Index"), task("t2", "failed", "Lint")]) }));
    expect(html).toContain("Index");
    expect(html).toContain("1m 5s");
    expect(html).toContain("1 recently ended");
    expect(html).toMatch(/<ul id="[^"]+" class="bg-task-list" hidden="">/);
  });

  it("keeps the list it read last when a read fails, and says so", () => {
    expect(render(model({ failed: true, activity: activity([task("t1", "running", "Index")]) }))).toContain("Couldn&#x27;t refresh: this is the list as it last read");
  });
});
