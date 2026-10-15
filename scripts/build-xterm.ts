/** xterm's source uses const enums in .d.ts files; TypeScript must inline them before Vite. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export function buildXtermSource(root: string): string {
  const source = join(root, "node_modules/@xterm/xterm/src");
  const output = join(root, "node_modules/.cache/herdr-xterm");
  const version = JSON.parse(readFileSync(join(source, "../package.json"), "utf8")).version;
  if (version !== "5.5.0") throw new Error("Revalidate the xterm composition backport before changing xterm versions");
  mkdirSync(output, { recursive: true });
  // TypeScript 7 has no stable compiler API, so build through its CLI with a generated project
  const project = join(root, "node_modules/.cache/herdr-xterm.tsconfig.json");
  writeFileSync(project, JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "bundler",
      rootDir: source, outDir: output,
      paths: { "browser/*": [join(source, "browser/*")], "common/*": [join(source, "common/*")] },
      experimentalDecorators: true, useDefineForClassFields: false,
      skipLibCheck: true, types: [], noEmitOnError: true,
    },
    include: [join(source, "**/*.ts")],
  }));
  const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin/tsc");
  try {
    execFileSync(process.execPath, [tsc, "-p", project, "--pretty"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`${stdout ?? ""}${stderr ?? ""}` || String(error));
  }
  return output;
}
