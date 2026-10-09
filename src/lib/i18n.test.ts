import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JA } from "./i18n.ja.ts";
import { isSentence, t } from "./i18n.ts";

const root = join(import.meta.dir, "..");

/**
 * Every string literal in the first argument of a `t(…)` / `tt(…)` call in the client, ternaries
 * included (`t(open ? "Hide" : "Show")`). A key built any other way is not allowed: label maps
 * are listed below instead.
 */
function keysInCode(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: root })) {
    if (file.endsWith(".test.ts") || /i18n\.\w+\.ts$/.test(file)) continue;
    const text = readFileSync(join(root, file), "utf8");
    for (const match of text.matchAll(/(?<![\w.])(?:t|tt)\(/g)) {
      const firstArg = firstArgument(text, match.index + match[0].length);
      for (const literal of firstArg.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        // a literal a condition compares against (`kind === "here" ? …`) is not shown to anyone
        if (/[=!]==?\s*$/.test(firstArg.slice(0, literal.index))) continue;
        const key = literal[1]!.replace(/\\"/g, '"').replace(/\\'/g, "'");
        found.set(key, [...(found.get(key) ?? []), file]);
      }
    }
  }
  return found;
}

/** The text of a call's first argument: up to the first comma or the closing paren at depth zero, strings and nesting respected. */
function firstArgument(text: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") { if (depth === 0) return text.slice(from, i); depth -= 1; }
    else if (ch === "," && depth === 0) return text.slice(from, i);
  }
  return text.slice(from);
}

/** Label maps the UI translates at the display site (`t(MAP[x])`): their values are keys too. */
function labelMapKeys(): string[] {
  const grab = (file: string, name: string, valuePattern: RegExp): string[] => {
    const text = readFileSync(join(root, file), "utf8");
    const start = text.indexOf(`const ${name}`);
    if (start < 0) throw new Error(`${name} not found in ${file}`);
    const end = text.indexOf("\n};", start) > 0 && (text.indexOf("\n];", start) < 0 || text.indexOf("\n};", start) < text.indexOf("\n];", start)) ? text.indexOf("\n};", start) : text.indexOf("\n];", start);
    return [...text.slice(start, end).matchAll(valuePattern)].flatMap((m) => m.slice(1).filter((v): v is string => v !== undefined));
  };
  const value = /^\s+\w+: "([^"]*)",?$/gm;
  return [
    ...grab("lib/status.ts", "STATUS_WORD", value),
    ...grab("components/MachineSidebar.tsx", "STATE_WORD", value),
    ...grab("components/Sidebar.tsx", "FAILED", value),
    ...grab("components/Composer.tsx", "SOURCE_LABEL", value),
    ...grab("components/DevicesPanel.tsx", "VIA", value),
    ...grab("components/KeyBar.tsx", "ARROWS", /label: "([^"]+)"/g),
    ...grab("lib/shortcuts.ts", "SHORTCUTS", /label: "([^"]+)"/g),
    ...grab("lib/workBlocks.ts", "CATEGORY_LABEL", /\["([^"]+)", "([^"]+)"\]/g),
  ];
}

describe("the Japanese dictionary", () => {
  const inCode = keysInCode();
  const keys = new Set([...inCode.keys(), ...labelMapKeys()]);

  it("has every sentence the code asks for", () => {
    const missing = [...keys].filter((key) => isSentence(key) && !(key in JA)).sort();
    expect(missing).toEqual([]);
  });

  it("translates sentences only: labels stay in English", () => {
    const labels = Object.keys(JA).filter((key) => !isSentence(key)).sort();
    expect(labels).toEqual([]);
  });

  it("keeps no entry the code no longer uses", () => {
    const stale = Object.keys(JA).filter((key) => !keys.has(key)).sort();
    expect(stale).toEqual([]);
  });

  it("keeps every placeholder of the English in the translation", () => {
    const broken = Object.entries(JA).filter(([en, text]) => {
      const want = [...en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const have = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      return want.join() !== have.join();
    }).map(([en]) => en);
    expect(broken).toEqual([]);
  });

  it("is Japanese, not the English repeated", () => {
    const english = Object.entries(JA).filter(([, text]) => !/[\u3040-\u30ff\u4e00-\u9fff]/.test(text)).map(([en]) => en);
    expect(english).toEqual([]);
  });
});

describe("t", () => {
  it("gives a sentence in Japanese and a label as it is, placeholders filled", () => {
    expect(t("This folder cannot be opened.")).toBe(JA["This folder cannot be opened."]!);
    expect(t("Showing the first {shown} of {total}.", { shown: 3, total: 9 })).toBe(JA["Showing the first {shown} of {total}."]!.replace("{shown}", "3").replace("{total}", "9"));
    expect(t("Settings")).toBe("Settings");
    expect(t("{n} min ago", { n: 5 })).toBe("5 min ago");
    expect(t("{a} and {b}", { a: 1 })).toBe("1 and {b}");
  });
});
