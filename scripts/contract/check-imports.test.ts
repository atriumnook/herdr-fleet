import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkFile, MARKER, markedFiles, unmarkedContractFiles } from "./check-imports.ts";

const file = "server/ping.contract.test.ts";
const marked = (...lines: string[]) => [MARKER, ...lines].join("\n");

describe("the black-box import check", () => {
  it("lets a marked file import shared/, the test herdr's tools, the fake push service, the launcher and built-ins", () => {
    expect(checkFile(file, marked(
      `import { expect, it } from "bun:test";`,
      `import { join } from "node:path";`,
      `import type { ServerMessage } from "../shared/protocol.ts";`,
      `import { OUTPUT_STALLED_CLOSE_CODE } from "@shared/terminal-flow.ts";`,
      `import { workspaceCreate } from "./herdr/client.ts";`,
      `import { paneGrid } from "./pane-grid.ts";`,
      `import { PtySession } from "./pty/session.ts";`,
      `import { startFakePushService } from "./push.fake.ts";`,
      `import { fileViewUrl } from "../src/lib/api.ts";`,
      `import { launchServer } from "../scripts/contract/launch.ts";`,
      `import { testSocketPath } from "../scripts/test-herdr.ts";`,
    ))).toEqual([]);
  });

  it("refuses the server itself and its internals, type-only, re-exported, dynamic or required", () => {
    const problems = checkFile(file, marked(
      `import { createServer } from "./index.ts";`,
      `import type { DeviceStore } from "./devices.ts";`,
      `export { SUBMIT_DELAY_MS } from "./submit.ts";`,
      `const late = await import("./access.ts");`,
      `const other = require("./push.ts");`,
      `const named = await import(name);`,
      `import "./collector.ts";`,
      `import { serve } from "bun";`,
      `import { secret } from "../../outside.ts";`,
      `import { createServer as viaAlias } from "@shared/../server/index.ts";`,
    ));
    for (const expected of ["./index.ts", "./devices.ts", "./submit.ts", "./access.ts", "./push.ts", "a module named at run time", "./collector.ts", `"bun"`, "../../outside.ts", "@shared/../server/index.ts"]) {
      expect(problems.some((problem) => problem.includes(expected))).toBe(true);
    }
  });

  it("refuses an import or require whose name is computed, even when it starts with a literal", () => {
    for (const line of [`const a = require("./" + "index.ts");`, "const b = await import(`../shared/${name}`);", `const c = await import("../shared/" + name);`]) {
      expect(checkFile(file, marked(line))).toContain(`${file}: imports a module named at run time`);
    }
  });

  it("reads multi-line imports", () => {
    expect(checkFile(file, marked(`import {`, `  createServer,`, `} from "./index.ts";`))).toHaveLength(1);
  });

  it("leaves a file without the marker alone", () => {
    expect(checkFile(file, `import { createServer } from "./index.ts";`)).toEqual([]);
  });

  it("passes every marked file of the repository", () => {
    const files = markedFiles();
    expect(files).toContain("server/ping.contract.test.ts");
    expect(files).toContain("server/device-access.contract.test.ts");
    for (const marked of files) expect(checkFile(marked, readFileSync(resolve(import.meta.dir, "../..", marked), "utf8"))).toEqual([]);
  });

  it("finds no contract test of the repository without the marker", () => {
    expect(unmarkedContractFiles()).toEqual([]);
  });
});
