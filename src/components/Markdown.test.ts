import { describe, expect, it } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FileUrlContext, OpenFileContext } from "../lib/filePaths.ts";
import { Markdown } from "./Markdown.tsx";

/** markdown in a chat whose pane serves files, or in a place that opens none */
function render(text: string, chat = true): string {
  const body: ReactNode = createElement(Markdown, { children: text });
  if (!chat) return renderToStaticMarkup(body);
  return renderToStaticMarkup(createElement(OpenFileContext.Provider, { value: () => {} },
    createElement(FileUrlContext.Provider, { value: (path: string) => `/api/fs/file?path=${encodeURIComponent(path)}` }, body)));
}

describe("Markdown files", () => {
  it("shows an image a reply names, from where the chat's pane serves it", () => {
    const html = render("![画面](docs/shot.png)");
    expect(html).toContain('class="markdown-image"');
    expect(html).toContain('src="/api/fs/file?path=docs%2Fshot.png"');
    expect(html).toContain('alt="画面"');
  });

  it("links a file that is not an image, and shows no image where nothing serves files", () => {
    expect(render("![report](out/REPORT.md)")).toContain('class="markdown-file"');
    const elsewhere = render("![画面](docs/shot.png)", false);
    expect(elsewhere).not.toContain("<img");
    expect(elsewhere).toContain("docs/shot.png");
  });

  it("opens the file a `path:line` code span names, still showing the line", () => {
    const html = render("see `src/app.ts:12`");
    expect(html).toContain('title="Open src/app.ts"');
    expect(html).toContain("<code>src/app.ts:12</code>");
  });
});
