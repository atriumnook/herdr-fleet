import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import type { DirectoryListing } from "../../shared/protocol.ts";
import { DEFAULT_SETTINGS, SettingsProvider } from "../lib/settings.ts";
import { DirectoryBrowser, type DirectoryBrowserModel } from "./DirectoryBrowser.tsx";

const listing = (extra: Partial<DirectoryListing> = {}): DirectoryListing => ({ path: "/home/me/w", parent: "/home/me", home: "/home/me", directories: ["api"], truncated: false, ...extra });
const model = (extra: Partial<DirectoryBrowserModel> = {}): DirectoryBrowserModel => ({ start: "~/w", listing: listing(), hidden: false, loading: false, error: null, files: false, canPick: true, ...extra });

/** English, as under the app's own provider with an English browser */
function render(values: DirectoryBrowserModel): string {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderBare(createElement(SettingsProvider, { settings: DEFAULT_SETTINGS, onChange: () => {}, children: createElement(DirectoryBrowser, { model: values, emit: () => {} }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("Folder browser view", () => {
  it("shows the path typed while it loads, then the folder inside home as ~/…", () => {
    expect(render(model({ listing: null, loading: true }))).toContain('<span dir="ltr">~/w</span>');
    expect(render(model({ listing: null, loading: true }))).toContain("Loading…");
    const html = render(model());
    expect(html).toContain('<span dir="ltr">~/w</span>');
    expect(html).toContain("<span>api</span>");
    expect(html).toContain("Use this folder");
  });

  it("lists files only when asked, and offers no folder choice without a parent to take it", () => {
    const html = render(model({ files: true, canPick: false, listing: listing({ directories: [], files: [{ name: "notes.txt", size: 2048 }] }) }));
    expect(html).toContain("notes.txt");
    expect(html).toContain("2 KB");
    expect(html).not.toContain("Use this folder");
    expect(render(model({ listing: listing({ directories: [] }) }))).toContain("No folders here");
    expect(render(model({ files: true, listing: listing({ directories: [], files: [] }) }))).toContain("Nothing here");
  });

  it("says why a folder was not listed", () => {
    expect(render(model({ error: "unsupported" }))).toContain("This PC&#x27;s bridge cannot browse folders yet. Type the path instead.");
    expect(render(model({ error: "invalid" }))).toContain("This folder cannot be opened.");
    expect(render(model({ error: "failed" }))).toContain("Folders could not be loaded.");
  });
});
