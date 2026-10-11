import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffStat, excludeWorktrees, gitHead, gitRoot, runSetup } from "./thread.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-thread-")));
  roots.push(root);
  Bun.spawnSync(["git", "init", "-q", root]);
  return root;
}

describe("thread helpers", () => {
  it("measure a worktree's change since a commit, committed or not, in the files git tracks", async () => {
    const root = repo();
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args]);
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "base");
    const base = await gitHead(root);
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(root, "a.txt"), "one\n2\nthree\nfour\n");
    writeFileSync(join(root, "b.txt"), "new\n");
    git("add", "b.txt");
    git("commit", "-q", "-m", "b");
    writeFileSync(join(root, "untracked.txt"), "not counted\n");
    expect(await diffStat(root, base!)).toEqual({ added: 3, removed: 1, files: 2 });
    expect(await diffStat(root, "0000000")).toBeNull();
    expect(await gitHead(tmpdir())).toBeNull();
  });

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
