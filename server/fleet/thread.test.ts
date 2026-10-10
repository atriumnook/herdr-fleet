import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { excludeWorktrees, gitRoot, runSetup } from "./thread.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-thread-")));
  roots.push(root);
  Bun.spawnSync(["git", "init", "-q", root]);
  return root;
}

describe("thread helpers", () => {
  it("find a folder's repository, and none outside one", async () => {
    const root = repo();
    expect(await gitRoot(root)).toBe(root);
    expect(await gitRoot(tmpdir())).toBeNull();
  });

  it("keep the threads' worktrees out of git status with one line in info/exclude, however often asked", async () => {
    const root = repo();
    const exclude = join(root, ".git", "info", "exclude");
    writeFileSync(exclude, "# local\n*.log");
    await excludeWorktrees(root);
    await excludeWorktrees(root);
    expect(readFileSync(exclude, "utf8")).toBe("# local\n*.log\n/.herdr-fleet/worktrees/\n");
  });

  it("run the setup command in the worktree, and keep the tail of a failure's output", async () => {
    const root = repo();
    expect(await runSetup(root, "pwd")).toEqual({ ok: true, output: root });
    const failed = await runSetup(root, "echo installing; echo 'npm ERR! missing script' >&2; exit 3");
    expect(failed.ok).toBe(false);
    expect(failed.output).toContain("npm ERR! missing script");
  });
});
