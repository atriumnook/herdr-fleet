import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

/** a numbered doc: docs/000-philosophy.md and on */
const NUMBERED = /^(\d{3})-[a-z0-9-]+\.md$/;

/** The link targets of a markdown text, outside code: inline `[text](target)` and reference `[ref]: target`. */
function linkTargets(markdown: string): string[] {
  const prose = markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "").replace(/(`+)[^\n]*?\1/g, "");
  const inline = [...prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]!);
  const reference = [...prose.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)].map((m) => m[1]!);
  return [...inline, ...reference];
}

/**
 * Every link of a numbered doc in `<root>/docs` that does not go back: one to a doc of the same or
 * a higher number, or to anything but a lower-numbered doc and `<root>/GLOSSARY.md`, or to a file
 * that is not there. Links to the web and to a place in the same doc (`#…`) are left alone.
 */
function forwardLinks(root: string): string[] {
  const docs = join(root, "docs");
  const glossary = join(root, "GLOSSARY.md");
  const problems: string[] = [];
  for (const name of readdirSync(docs).filter((file) => NUMBERED.test(file)).sort()) {
    const number = Number(NUMBERED.exec(name)![1]);
    for (const target of linkTargets(readFileSync(join(docs, name), "utf8"))) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
      const path = resolve(docs, decodeURI(target.replace(/[#?].*$/, "")));
      const linked = NUMBERED.exec(relative(docs, path));
      const back = path === glossary || (linked !== null && Number(linked[1]) < number);
      if (!back) problems.push(`docs/${name} links to ${target}: a numbered doc links only to lower-numbered docs and GLOSSARY.md`);
      else if (!existsSync(path)) problems.push(`docs/${name} links to ${target}, which does not exist`);
    }
  }
  return problems;
}

const repo = resolve(import.meta.dir, "..");

describe("numbered docs", () => {
  it("start at 000 and each links only back, to lower-numbered docs and GLOSSARY.md", () => {
    expect(existsSync(join(repo, "docs", "000-philosophy.md"))).toBe(true);
    expect(existsSync(join(repo, "GLOSSARY.md"))).toBe(true);
    expect(forwardLinks(repo)).toEqual([]);
  });

  it("calls out a forward link, a link outside the docs and a missing doc, and leaves web links and anchors alone", () => {
    const root = mkdtempSync(join(tmpdir(), "docs-links-"));
    try {
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "GLOSSARY.md"), "# Glossary\n");
      writeFileSync(join(root, "docs", "guide.md"), "# Guide\n");
      writeFileSync(join(root, "docs", "000-philosophy.md"), [
        "Read [the domain](001-domain.md) next.",
        "See [the glossary](../GLOSSARY.md), [the web](https://example.com/002-x.md) and [below](#why).",
        "In code, `[not a link](001-domain.md)` is text, and so is `` `x` [not a link](001-domain.md) `` in a longer span.",
      ].join("\n"));
      writeFileSync(join(root, "docs", "001-domain.md"), [
        "Built on [000](000-philosophy.md#what-follows) and [the guide](guide.md).",
        "It names [a term](../GLOSSARY.md#thread) and [a doc that is gone](000-gone.md).",
        "[later]: 002-lifecycle.md",
      ].join("\n"));
      expect(forwardLinks(root)).toEqual([
        "docs/000-philosophy.md links to 001-domain.md: a numbered doc links only to lower-numbered docs and GLOSSARY.md",
        "docs/001-domain.md links to guide.md: a numbered doc links only to lower-numbered docs and GLOSSARY.md",
        "docs/001-domain.md links to 000-gone.md, which does not exist",
        "docs/001-domain.md links to 002-lifecycle.md: a numbered doc links only to lower-numbered docs and GLOSSARY.md",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
