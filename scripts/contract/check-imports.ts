/**
 * Checks what a black-box contract test imports (ADR 0122-parity-criteria). A file whose first
 * line is the marker below talks to the server under test through its URL only, so it may import:
 * shared/, the test herdr's tools (server/herdr/client.ts, server/pane-grid.ts, server/pty/session.ts),
 * the fake push service (server/push.fake.ts), the Web UI's URL builders (src/lib/api.ts),
 * scripts/contract/, scripts/test-herdr.ts, and node: and bun: built-ins. Nothing else, type-only
 * imports included: the server's internals and its values are what the contract must not lean on.
 * Every `*.contract.test.ts` is such a file, so one without the marker is refused too.
 *
 *   bun scripts/contract/check-imports.ts        exit 1 and one line per import outside that list or contract test without the marker
 */
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export const MARKER = "// black-box: scripts/contract/launch.ts";

const REPO = resolve(import.meta.dir, "../..");
const ALLOWED_FILES = new Set(["server/herdr/client.ts", "server/pane-grid.ts", "server/pty/session.ts", "server/push.fake.ts", "src/lib/api.ts", "scripts/test-herdr.ts"]);
const ALLOWED_FOLDERS = ["shared/", "scripts/contract/"];

/** every module specifier in `source`, static, re-exported, side-effect, dynamic or required; null for a dynamic one that is not a string literal */
export function specifiers(source: string): (string | null)[] {
  const found: (string | null)[] = [];
  const patterns = [
    /\b(?:import|export)\s[^;]*?\bfrom\s*(["'])([^"']+)\1/g,
    /\bimport\s*(["'])([^"']+)\1/g,
    /\bimport\s*\(\s*(["'`])([^"'`]+)\1\s*[,)]/g,
    /\brequire\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.push(match[2]!);
  // `import(…)` or `require(…)` with anything but one whole literal (a sum, a template with ${}) could load any module
  for (const match of source.matchAll(/\b(?:import|require)\s*\(/g)) {
    const argument = source.slice(match.index! + match[0].length);
    if (!/^\s*(?:"[^"\n]*"|'[^'\n]*'|`[^`$]*`)\s*[,)]/.test(argument)) found.push(null);
  }
  // what the transpiler sees (it drops type-only imports, which the patterns above keep)
  for (const { path } of new Bun.Transpiler({ loader: "tsx" }).scanImports(source)) found.push(path);
  return [...new Set(found)];
}

/** whether a black-box file at `file` (relative to the repository) may import `specifier` */
export function allowed(file: string, specifier: string): boolean {
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) return true;
  let target: string;
  if (specifier.startsWith("@shared/")) target = relative(REPO, resolve(REPO, "shared", specifier.slice("@shared/".length)));
  else if (specifier.startsWith(".")) target = relative(REPO, resolve(REPO, dirname(file), specifier));
  else return false;
  if (target.startsWith("..")) return false;
  return ALLOWED_FILES.has(target) || ALLOWED_FOLDERS.some((folder) => target.startsWith(folder));
}

/** the imports of one file that break the rule, as messages; none when the file has no marker */
export function checkFile(file: string, source: string): string[] {
  if (source.split("\n", 1)[0]!.trim() !== MARKER) return [];
  return specifiers(source)
    .filter((specifier) => specifier === null || !allowed(file, specifier))
    .map((specifier) => `${file}: ${specifier === null ? "imports a module named at run time" : `imports "${specifier}", which a black-box test may not`}`);
}

const FOLDERS = "{server,scripts,src,shared,bin,e2e}";
const hasMarker = (file: string) => readFileSync(resolve(REPO, file), "utf8").split("\n", 1)[0]!.trim() === MARKER;

/** the files that carry the marker, relative to the repository */
export function markedFiles(): string[] {
  const files = [...new Bun.Glob(`${FOLDERS}/**/*.{ts,tsx}`).scanSync({ cwd: REPO })];
  return files.filter(hasMarker).sort();
}

/** the contract tests that lack the marker, relative to the repository */
export function unmarkedContractFiles(): string[] {
  return [...new Bun.Glob(`${FOLDERS}/**/*.contract.test.{ts,tsx}`).scanSync({ cwd: REPO })].filter((file) => !hasMarker(file)).sort();
}

if (import.meta.main) {
  const files = markedFiles();
  const problems = files.flatMap((file) => checkFile(file, readFileSync(resolve(REPO, file), "utf8")));
  const unmarked = unmarkedContractFiles();
  for (const problem of problems) console.error(problem);
  for (const file of unmarked) console.error(`${file}: a contract test whose first line is not ${MARKER}`);
  console.log(`${files.length} black-box files, ${problems.length} forbidden imports, ${unmarked.length} contract tests without the marker`);
  process.exit(problems.length + unmarked.length === 0 ? 0 : 1);
}
