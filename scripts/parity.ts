/**
 * Compares docs/rust-migration/parity.md with the test files ADR 0122-parity-criteria says it lists:
 * every tracked file the globs below match must have one row in the table under "## 一覧", and the
 * table must have no other row. The successor column (引き継ぎ先) may hold only a criterion of the
 * plan, a crate's tests (`<crate> の crate のテスト`, a folder of rust/crates/), 「そのまま残す」,
 * 「なし: <理由>」, several of them joined by 「、」, or nothing yet. A 「なし: <理由>」 is the last value of its
 * cell, so its reason may hold 「、」 too.
 *
 * Not part of scripts/ci-tests.ts: a phase's gate runs it, so that a pull request adding a test file
 * need not edit parity.md (issue #134).
 *
 *   bun scripts/parity.ts        exit 1 and one line per missing row, extra row or unknown successor
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const PARITY = "docs/rust-migration/parity.md";
const GLOBS = ["**/*.test.ts", "**/*.test.tsx", "scripts/*-regression.ts", "scripts/*-qa.ts", "e2e/*.ts", "scripts/opencode-live-check.ts", "scripts/pty-compare.ts"].map((glob) => new Bun.Glob(glob));
const CRITERIA = ["画面の corpus", "会話ログの corpus", "fleet CLI の契約", "HTTP/WS の契約", "安全上の判定の表", "UI の回帰"];

/** the tracked files parity.md must list */
export function testFiles(tracked: string[]): string[] {
  return tracked.filter((file) => GLOBS.some((glob) => glob.match(file))).sort();
}

export type Row = { file: string; successor: string; line: number };

/** the rows of the table under "## 一覧", up to the next heading: a file in backticks in the first cell, the successor in the second */
export function rows(markdown: string): Row[] {
  const found: Row[] = [];
  let inList = false;
  markdown.split("\n").forEach((text, index) => {
    if (text.startsWith("#")) inList = text.trim() === "## 一覧";
    if (!inList) return;
    const cells = text.match(/^\|\s*`([^`]+)`\s*\|((?:\\\||[^|])*)\|/);
    if (cells) found.push({ file: cells[1]!, successor: cells[2]!.replaceAll("\\|", "|").trim(), line: index + 1 });
  });
  return found;
}

/** the values of one successor cell: split at 「、」, except inside the reason of a 「なし: <理由>」 */
export function successors(cell: string): string[] {
  const values: string[] = [];
  for (const part of cell.split("、")) {
    if (values.length && values[values.length - 1]!.startsWith("なし: ")) values[values.length - 1] += `、${part}`;
    else values.push(part.trim());
  }
  return values;
}

/** whether one value of the successor column is one parity.md may hold */
export function knownSuccessor(value: string, crates: string[]): boolean {
  if (CRITERIA.includes(value) || value === "そのまま残す" || /^なし: \S/.test(value)) return true;
  const crate = value.match(/^`?([\w-]+)`? の crate のテスト$/);
  return crate !== null && crates.includes(crate[1]!);
}

/** what is wrong with parity.md, one message each */
export function problems(files: string[], table: Row[], crates: string[]): string[] {
  const found: string[] = [];
  const listed = new Map<string, Row>();
  for (const row of table) {
    if (listed.has(row.file)) found.push(`${PARITY}:${row.line}: ${row.file} has a second row (the first is at line ${listed.get(row.file)!.line})`);
    else listed.set(row.file, row);
  }
  const wanted = new Set(files);
  for (const file of files) if (!listed.has(file)) found.push(`missing row: ${file}`);
  for (const row of listed.values()) if (!wanted.has(row.file)) found.push(`${PARITY}:${row.line}: extra row: ${row.file} is not a file the globs of ADR 0122 select`);
  for (const row of table) {
    if (row.successor === "") continue;
    for (const value of successors(row.successor)) {
      if (!knownSuccessor(value, crates)) found.push(`${PARITY}:${row.line}: ${row.file}: unknown successor "${value}"`);
    }
  }
  return found;
}

if (import.meta.main) {
  const tracked = (await Bun.$`git ls-files`.cwd(REPO).text()).split("\n").filter(Boolean);
  const files = testFiles(tracked);
  const table = rows(readFileSync(resolve(REPO, PARITY), "utf8"));
  const crates = readdirSync(resolve(REPO, "rust/crates"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const found = problems(files, table, crates);
  for (const problem of found) console.error(problem);
  const blank = table.filter((row) => row.successor === "").length;
  console.log(`${files.length} test files, ${table.length} rows (${blank} without a successor yet), ${found.length} problems`);
  process.exit(found.length === 0 ? 0 : 1);
}
