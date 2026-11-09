import { describe, expect, it, mock } from "bun:test";
import { allowed, refusal } from "../../opencode/fleet-guard/guard.js";

/**
 * The guard is the gate of a role that edits nothing (OpenCode 2.0.26 asks for permission only about the
 * command nodes tree-sitter finds, so a declaration, an assignment or a bare redirect runs unchecked).
 * Every line below was run through the real binary or git when it was written (see
 * scripts/opencode-live-check.ts); the first group is the reproducers of the review of this change.
 */
const FLEET = "/usr/bin/bun /opt/fleet/bin/fleet.ts";
const read = { fleetCommand: FLEET, merges: false };
const coordinator = { fleetCommand: FLEET, merges: true };
const HIST = "--no-ext-diff --no-textconv";

const ACCEPTED = [
  "git status", "git ls-files", "ls", "pwd",
  `git diff ${HIST}`, `git diff ${HIST} HEAD`, `git diff ${HIST} main...HEAD`, `git diff ${HIST} main..HEAD`, `git diff ${HIST} HEAD~3 -- src/a.ts`, `git diff ${HIST} --cached --stat`,
  `git log ${HIST} -n 20 --oneline`, `git log ${HIST} -n20`, `git log ${HIST} --format=%h -- src`, `git log ${HIST} -p --format=%H -5`, `git log ${HIST} --author=a@b.c --since=2.weeks --grep=fix`, `git log ${HIST} -Gfoo -- src`,
  `git show ${HIST} HEAD`, `git show ${HIST} HEAD:src/a.ts`, `git show ${HIST} --stat HEAD^`, `git show ${HIST} v1.2.3:README.md`,
  "gh pr view 12", "gh pr view", "gh pr view --json title", "gh pr checks", "gh run view 9 --job 3", "gh pr view 12 --json title,body --comments", "gh pr checks 12", "gh pr checks 12 --json name,state", "gh pr list", "gh pr list --state all -L 100",
  "gh run view 9", "gh run view 9 --log-failed", "gh run view 9 --exit-status",
  FLEET, `${FLEET} list`, `${FLEET} send lead 'go'`, `${FLEET} send lead "done; see src/a.ts"`, `${FLEET} send lead 'a -> b, Map<K,V>, C:\\dir, $HOME, \`x\`; "q"'`,
  `${FLEET} send lead "a -> b"`, `${FLEET} thread --title 'fix x' --goal "one two" --write src/a.ts --done 'tests pass'`, `${FLEET} send lead 'line one\nline two'`, `${FLEET} send lead 'multi\nline'`, `${FLEET} send lead 'PR#12 and C#'`, `${FLEET} send lead 'don'"'"'t'`, `${FLEET} send lead ~/x`,
];

const REFUSED = [
  // H1: declarations, assignments and env prefixes run unchecked, or set up a program for the allowed command
  "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=id; git status", "declare -x GIT_EXTERNAL_DIFF=/bin/x; git diff", "GIT_CONFIG_COUNT=1; git status",
  "export X=$(id)", "export X=1", "typeset -x X=1", "readonly X=1", "local x=1", "x=$(id)", "x=1", "FOO=1 git status", "GIT_EXTERNAL_DIFF=/bin/x git diff --no-ext-diff --no-textconv HEAD",
  "GIT_SSH_COMMAND=x git pull --ff-only", "GH_BROWSER=id gh pr view 1 --web",
  "X='a[$(touch /tmp/pwn1)]'; (( X ))", "X='$(touch /tmp/pwn2)'; export Y=${X@P}", "X='a[$(touch /tmp/pwn1)]'; [[ X -eq 1 ]]",
  // separators, substitutions, groups
  "git status; rm x", "git status && id", "git status | tee x", "git status |& cat", "git status & id", "ls; echo", "ls ;rm", "git status ;rm", "ls | sh", "ls |sh", "ls $(id)", "ls `id`", "ls ${IFS}x", "git status$IFS-s",
  "(rm x)", "{ rm x; }", "ls\nrm", "ls\n", " ls", "ls ", "git  status", "git status\t", "env ls", "bash -c ls", "eval ls", "xargs rm", "rm x",
  // redirects, here-strings, process substitution, backslashes
  "> x", ">> ~/.bashrc", "<f", "<<<hi", "ls > x", "git status > f", `git diff ${HIST} --output=x`, "cat <(ls)", "ls \\", `git diff ${HIST} --o\\utput=f`,
  // quoting and expansion that make git read a different line than a pattern does
  `git diff ${HIST} --ex""t-diff`, `git diff ${HIST} "--output=/tmp/x"`, `git diff ${HIST} --ext$X-diff`, `git diff ${HIST} --ext{-diff,}`, `git diff ${HIST} HEAD*`, `git diff ${HIST} 'HEAD'`,
  // other arguments of ls, git status and pwd
  "ls -la", "ls /etc", "ls -R /", "ls --color=always", "pwd -P", "git status --short", "git status -s", "git ls-files -z", "git ls-files --others --exclude-from=/etc/shadow", "git ls-files --format=%(objectname)",
  // H2: paths outside the repository (git diff of two such paths is an implicit --no-index), and git's own switches
  `git diff ${HIST} /dev/null /etc/passwd`, `git diff ${HIST} /dev/null ~/.ssh/id_ed25519`, `git diff ${HIST} HEAD -- /etc/passwd`, `git diff ${HIST} -- ../outside`, `git diff ${HIST} ..`, `git diff ${HIST} ../x ../y`,
  `git diff ${HIST} HEAD:../x`, `git diff ${HIST} --stat=/x`, `git diff ${HIST} -O/etc/passwd`, `git diff ${HIST} --no-index a b`, `git diff ${HIST} --no-ind /etc/passwd /dev/null`, `git diff ${HIST} --no-i a b`,
  `git diff ${HIST} --output x`, `git diff ${HIST} --outpu=x`, `git diff ${HIST} HEAD --ext-diff`, `git diff ${HIST} HEAD --ext`, `git diff ${HIST} HEAD --textconv`, `git diff ${HIST} HEAD --no-ext-diff --ext-diff`,
  `git diff ${HIST} HEAD -c core.pager=id`, `git diff ${HIST} HEAD --open-files-in-pager=id`, `git diff ${HIST} HEAD --exit-code`, `git diff ${HIST} --ignore-submodules=none`, `git diff ${HIST} HEAD --submodule=diff`,
  `git log ${HIST} --format=%GK`, `git log ${HIST} --pretty=format:%h%GS`, `git log ${HIST} --format=%G?`, `git log ${HIST} --format=%GG`, `git log ${HIST} --show-signature`, `git log ${HIST} --exec=id`, `git log ${HIST} -G x --pickaxe-regex`, `git log ${HIST} -C`, `git log ${HIST} -c`, `git log ${HIST} --git-dir=/x`, `git log ${HIST} --work-tree=/x`,
  "git diff", "git log", "git show HEAD", "git diff --no-ext-diff HEAD", `git diff --no-textconv --no-ext-diff HEAD`, `git -c core.pager=id log ${HIST}`, `git --no-pager diff ${HIST}`,
  // secrets in the repository that read denies cannot cover through git
  `git show ${HIST} HEAD:.env`, `git show ${HIST} HEAD:config/.env.local`, `git log ${HIST} -p -- .env`, `git diff ${HIST} -- apps/web/.env.production`,
  // gh
  "gh pr view 1 --web", "gh pr view --repo evil/x 1", "gh pr view 1 --json body --jq .body", "gh pr view 1 -R x/y", "gh pr list --search x", "gh pr checks 1 --watch", "gh pr view main", "gh run view", "gh run view --log", "gh pr view 1; gh api -X DELETE repos/x/y",
  "gh api repos/x/y", "gh run view 1 --web", "gh run view 1 --log --exit-status --web", "gh pr create", "gh pr view 1 --json",
  // the merge forms belong to the coordinator
  "gh pr merge 12 --merge", "git pull --ff-only", "git merge --no-ff fleet/x", "git merge --abort",
  // the fleet command: no unquoted shell syntax
  `${FLEET} send lead "$(id)"`, `${FLEET} send lead "\`id\`"`, `${FLEET} send lead "a\\nb"`, `${FLEET} send lead $HOME`, `${FLEET} send lead x > f`, `${FLEET} send lead x; id`, `${FLEET} send lead 'unclosed`, `${FLEET} send lead "unclosed`,
  `${FLEET} send lead x | cat`, `${FLEET} send lead x && id`, `${FLEET} send lead x\nid`, `${FLEET}x`, `${FLEET}; id`, `${FLEET} send lead *`, `${FLEET} send lead PR#12`, `${FLEET} send lead {a,b}`, `${FLEET} send lead !x`, `${FLEET} send lead (x)`,
  `cd /tmp && ${FLEET} list`, `FOO=1 ${FLEET} list`, `/usr/bin/bun /opt/fleet/bin/other.ts list`,
];

const MERGES = [
  "gh pr merge 12 --merge", "gh pr merge 123456 --merge", "git pull --ff-only", "git merge --no-ff fleet/ab12cd", "git merge --no-ff agents/worker-ab12", "git merge --abort",
  // merge modes: a merge the gate allowed, pinned to its commit; a revert, and the push that takes it to GitHub
  "gh pr merge 12 --merge --match-head-commit c0ffee1", "gh pr merge 12 --merge --match-head-commit 0123456789abcdef0123456789abcdef01234567",
  "git revert -m 1 --no-edit abc0001", "git revert -m 1 --no-edit 0123456789abcdef0123456789abcdef01234567", "git revert --abort",
  "git push origin main", "git push origin rust", "git push origin release/2.0",
];
const MERGES_REFUSED = [
  "gh pr merge main --merge", "gh pr merge a/b/c --merge", "gh pr merge https://github.com/evil/repo/pull/1 --merge", "gh pr merge 12 --merge --admin", "gh pr merge --admin --merge", "gh pr merge -d --merge",
  "gh pr merge 1 --merge --delete-branch", "gh pr merge 12 --merge -R evil/repo", "gh pr merge 12  --merge", "gh pr merge 1 --merge;gh pr merge 2 --merge", "gh pr merge 12 --merge --body x", "gh pr merge 12 --squash", "gh pr merge 12",
  "gh pr merge 12 --merge && git push", "gh pr merge 1234567890 --merge",
  "git merge --no-ff fleet/x main", "git merge --no-ff fleet/x -s ours", "git merge --no-ff fleet/x --allow-unrelated-histories -X theirs", "git merge --no-ff fleet/x -m msg", "git merge --no-ff fleet/x --no-verify",
  "git merge --no-ff fleet/x -F /etc/passwd", "git merge --no-ff fleet/x --file=/etc/passwd", "git merge --no-ff fleet/x --abort", "git merge --no-ff fleet/ ", "git merge --no-ff fleet/", "git merge --no-ff main", "git merge --no-ff fleet/../x",
  "git merge --no-ff fleet/x HEAD~5", "git merge --no-ff fleet/x > f", "git merge --abort x", "git pull --ff-only origin", "git pull --ff-only evil", "git pull", "git merge main", "git checkout main",
  // the pinned merge: one hex commit, nothing after it
  "gh pr merge 12 --merge --match-head-commit", "gh pr merge 12 --merge --match-head-commit HEAD", "gh pr merge 12 --merge --match-head-commit main", "gh pr merge 12 --merge --match-head-commit c0ffee1 --admin",
  "gh pr merge 12 --merge --match-head-commit c0ffee1 --delete-branch", "gh pr merge 12 --merge --match-head-commit=c0ffee1", "gh pr merge 12 --match-head-commit c0ffee1 --merge", "gh pr merge 12 --squash --match-head-commit c0ffee1",
  "gh pr merge 12 --merge --match-head-commit C0FFEE1", "gh pr merge 12 --merge --match-head-commit c0ff", "gh pr merge 12 --merge --match-head-commit c0ffee1 -R evil/repo",
  // a revert: of one hex commit, with no edit, no other mainline, no strategy or option
  "git revert abc0001", "git revert -m 1 abc0001", "git revert -m 2 --no-edit abc0001", "git revert -m 1 --no-edit HEAD", "git revert -m 1 --no-edit HEAD~1", "git revert -m 1 --no-edit abc0001 def0002",
  "git revert -m 1 --no-edit abc0001 -X theirs", "git revert -m 1 --no-edit --no-commit abc0001", "git revert -m 1 --edit abc0001", "git revert --continue", "git revert --quit", "git revert --skip", "git revert --abort x",
  "git revert -m 1 --no-edit abc0001 > f", "git revert -m 1 --no-edit abc0001; git push",
  // a push: to origin, one branch, never forced, deleted, as a refspec or a tag
  "git push", "git push origin", "git push origin main --force", "git push --force origin main", "git push -f origin main", "git push origin +main", "git push origin main:main", "git push origin :main",
  "git push origin HEAD", "git push origin HEAD:main", "git push origin --delete main", "git push origin -d main", "git push origin main other", "git push origin --tags", "git push origin --all", "git push origin --mirror",
  "git push evil main", "git push https://github.com/evil/x main", "git push origin ../main", "git push origin main/..", "git push origin -main", "git push origin main --force-with-lease", "git push origin main && id",
  "git push origin 'main'", "git push origin main\nid", "git push  origin main", "git push origin .main", "git push origin main/",
];

describe("the guard of a role that edits nothing", () => {
  it("accepts the exact forms", () => {
    for (const command of ACCEPTED) expect([command, allowed(command, read)]).toEqual([command, true]);
  });

  it("refuses every other line, among them each reproducer of the review", () => {
    for (const command of REFUSED) expect([command, allowed(command, read)]).toEqual([command, false]);
  });

  it("lets the coordinator, and only the coordinator, merge in the forms the fleet asks for", () => {
    for (const command of MERGES) {
      expect([command, allowed(command, coordinator)]).toEqual([command, true]);
      expect([command, allowed(command, read)]).toEqual([command, false]);
    }
    for (const command of MERGES_REFUSED) expect([command, allowed(command, coordinator)]).toEqual([command, false]);
    // the forms of every other role stay as they are for the coordinator
    for (const command of ACCEPTED) expect([command, allowed(command, coordinator)]).toEqual([command, true]);
  });

  it("refuses everything when it is not told the fleet command", () => {
    expect(allowed(`${FLEET} list`, {})).toBe(false);
    expect(allowed("git status", {})).toBe(true);
    expect(allowed("git pull --ff-only", { merges: true })).toBe(true);
    expect(allowed("git pull --ff-only", undefined)).toBe(false);
  });

  it("looks at the shell only, and at a command that is text", () => {
    expect(refusal("edit", { path: "/state/fleet-results/r1/handoff.md", oldString: "<", newString: ">" }, read)).toBeUndefined();
    expect(refusal("read", { path: "a>b" }, read)).toBeUndefined();
    expect(refusal("shell", { command: "ls" }, read)).toBeUndefined();
    expect(refusal("shell", { command: "x=1" }, read)).toContain("herdr-fleet:");
    for (const input of [undefined, null, {}, { command: 5 }, { command: ["ls"] }, "ls"]) expect(refusal("shell", input, read)).toContain("text");
  });

  it("registers a tool.execute.before hook that fails with a Tool.Error, and hands it the pane's options", async () => {
    // the host provides `effect` and @opencode/plugin to a plugin; stand-ins record how they are used
    const failures: unknown[] = [];
    mock.module("effect", () => ({ Effect: { fail: (error: unknown) => { failures.push(error); return { failed: error }; }, void: { ok: true }, asVoid: Symbol("asVoid") } }));
    class ToolError { constructor(readonly fields: { message: string }) {} }
    mock.module("@opencode/plugin/promise/tool", () => ({ Error: ToolError }));
    const entry = "../../opencode/fleet-guard/index.js";
    const plugin = (await import(entry)).default as { id: string; effect: (ctx: unknown) => unknown };
    expect(plugin.id).toBe("herdr-fleet.guard");
    const registered: Array<{ name: string; callback: (event: unknown) => unknown }> = [];
    const hooks = { pipe: (...fns: unknown[]) => fns };
    plugin.effect({ options: coordinator, tool: { hook: (name: string, callback: (event: unknown) => unknown) => { registered.push({ name, callback }); return hooks; } } });
    expect(registered.map((hook) => hook.name)).toEqual(["execute.before"]);
    const callback = registered[0]!.callback;
    const refused = callback({ tool: "shell", input: { command: "export A=1; git status" } }) as { failed: ToolError };
    expect(refused.failed).toBeInstanceOf(ToolError);
    expect(refused.failed.fields.message).toContain("exact command forms");
    expect(callback({ tool: "shell", input: { command: "ls" } })).toEqual({ ok: true });
    // options reach the check: the coordinator's merge goes through
    expect(callback({ tool: "shell", input: { command: "git pull --ff-only" } })).toEqual({ ok: true });
    expect(failures).toHaveLength(1);
  });
});
