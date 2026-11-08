import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { branchHead, branchState, diffStat, diffText, excludeWorktrees, gitBranch, gitHead, gitRoot, isMerged, mainWorktree, removeThread, runSetup } from "./thread.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-thread-")));
  roots.push(root);
  Bun.spawnSync(["git", "init", "-q", root]);
  return root;
}

describe("thread helpers", () => {
  it("find the repository's main worktree from a thread's worktree, from a subfolder, and nothing outside a repository", async () => {
    const root = repo();
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args]);
    writeFileSync(join(root, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "base");
    const worktree = join(root, ".herdr-fleet", "worktrees", "t1");
    git("worktree", "add", "-q", "-b", "fleet/t1", worktree);
    mkdirSync(join(root, "sub"));
    const main = await gitRoot(root);
    expect(await mainWorktree(worktree)).toBe(main);
    expect(await mainWorktree(join(root, "sub"))).toBe(main);
    expect(await gitRoot(worktree)).not.toBe(main);
    expect(await mainWorktree(tmpdir())).toBeNull();
  });

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

  it("measure a thread's change from where it left its base branch, however far the base branch moved on", async () => {
    const root = repo();
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args]);
    writeFileSync(join(root, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "base");
    git("branch", "-M", "main");
    expect(await gitBranch(root)).toBe("main");
    const worktree = join(root, ".herdr-fleet", "worktrees", "t1");
    git("worktree", "add", "-q", "-b", "fleet/t1", worktree);
    writeFileSync(join(worktree, "b.txt"), "thread\n");
    Bun.spawnSync(["git", "-C", worktree, "add", "b.txt"]);
    Bun.spawnSync(["git", "-C", worktree, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "-m", "thread"]);
    writeFileSync(join(root, "c.txt"), "main moved\n");
    git("add", "c.txt");
    git("commit", "-q", "-m", "main");
    writeFileSync(join(worktree, "new.txt"), "uncommitted\n");
    expect(await diffStat(worktree, "main")).toEqual({ added: 1, removed: 0, files: 1 });
    const diff = await diffText(worktree, "main");
    expect(diff?.truncated).toBe(false);
    expect(diff?.diff).toContain("+++ b/b.txt");
    expect(diff?.diff).not.toContain("c.txt");
    expect(await branchState(worktree, "main")).toEqual({ uncommitted: ["new.txt"], ahead: 1, behind: 1 });
    expect(await branchHead(root, "fleet/t1")).toMatch(/^[0-9a-f]{40}$/);
    expect(await branchHead(root, "fleet/none")).toBeNull();
    expect(await isMerged(root, "fleet/t1", "main")).toBe(false);
    // work no commit holds keeps the worktree, and so does an unmerged branch
    expect(await removeThread(root, worktree, "fleet/t1")).toContain("was kept");
    expect(existsSync(worktree)).toBe(true);
    Bun.spawnSync(["rm", join(worktree, "new.txt")]);
    expect(await removeThread(root, worktree, "fleet/t1")).toContain("The branch fleet/t1 was kept");
    expect(existsSync(worktree)).toBe(false);
    git("merge", "-q", "--no-ff", "-m", "merge", "fleet/t1");
    expect(await isMerged(root, "fleet/t1", "main")).toBe(true);
    expect(await removeThread(root, worktree, "fleet/t1")).toBeUndefined();
    expect(await branchHead(root, "fleet/t1")).toBeNull();
  });

  it("throw a thread away whatever it holds", async () => {
    const root = repo();
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args]);
    writeFileSync(join(root, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "base");
    const worktree = join(root, "w");
    git("worktree", "add", "-q", "-b", "fleet/t2", worktree);
    writeFileSync(join(worktree, "a.txt"), "changed\n");
    writeFileSync(join(worktree, "new.txt"), "new\n");
    expect(await removeThread(root, worktree, "fleet/t2", { force: true })).toBeUndefined();
    expect(existsSync(worktree)).toBe(false);
    expect(await branchHead(root, "fleet/t2")).toBeNull();
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
