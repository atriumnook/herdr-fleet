import { resolve } from "node:path";

/**
 * The configuration a fleet pane gives OpenCode 2 (`OPENCODE_CONFIG_CONTENT`: read last, so its rules
 * come after the person's own, and the last rule that matches wins). The facts this rests on are in
 * v2.0.26's source (packages/core/src/permission.ts, util/wildcard.ts, tool/plugin/shell.ts,
 * shell/parse.ts, file-access.ts):
 * - A rule is `{action, resource, effect}`. A request is denied when ANY of its resources has a
 *   `deny` as its last match; otherwise a missing match asks. A saved "Always allow" is appended
 *   after the config as an allow, so it overrides an `ask` but never a `deny`.
 * - `*` matches anything, `?` one character; a trailing ` *` also matches the bare command.
 * - The shell tool matches each command node of the line on its own (`;`, `&&`, `|`, `$(...)` give
 *   several), and a command with a redirect by the text of the whole statement.
 * - A line with no command node (`> ~/x`, `x=1`, `export A=1`) is not checked at all. A role that edits
 *   nothing is therefore held by the guard plugin (opencode/fleet-guard), which accepts a shell line only
 *   in a few exact forms; the rules below are its second layer.
 * - A file inside the work folder is matched by its relative path, one outside by its absolute path.
 *
 * The fleet writes no `ask`: the prompt's "Always allow" saves a broad `<prefix> *` allow for the
 * project, shared with the person's own use of OpenCode, so no run may depend on a prompt.
 */

type Rule = { action: string; resource: string; effect: "allow" | "deny" };
const rule = (action: string, resource: string, effect: Rule["effect"]): Rule => ({ action, resource, effect });
const allow = (action: string, resource: string) => rule(action, resource, "allow");
const deny = (action: string, resource: string) => rule(action, resource, "deny");

export interface OpencodeRole {
  /** this run's result folder, outside the workspace */
  resultDir: string;
  /** the shell command that runs the fleet CLI */
  fleetCommand: string;
  /** the model as `provider/model[#variant]` */
  model?: string;
  /** the role edits no file */
  readOnly: boolean;
  /** the role merges for the person: the project's coordinator */
  merges: boolean;
}

export const OPENCODE_READ_ONLY_AGENT = "fleet-readonly";
/** the guard plugin; a directory, since OpenCode loads no single file from its config */
export const OPENCODE_GUARD_PLUGIN = resolve(import.meta.dir, "..", "..", "opencode", "fleet-guard");

/**
 * git config for every git the agent runs, through the pane's environment: `-c`-level config beats the
 * repository's own (checked on git 2.55). `core.fsmonitor` names a program that `git status`, `git diff`
 * and `git ls-files` would run. Not neutralisable: a `filter.<name>.clean` or `.smudge` program (only the
 * name can be overridden, and the names are not known) that the person's own config defines and a
 * `.gitattributes` selects. The agent of a role that edits nothing cannot write either file.
 */
export function opencodeGitEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  // config the fleet server's own environment already carries is kept: ours is appended after it
  const count = /^[0-9]{1,3}$/.test(base["GIT_CONFIG_COUNT"] ?? "") ? Number(base["GIT_CONFIG_COUNT"]) : 0;
  const kept: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const key = base[`GIT_CONFIG_KEY_${i}`];
    const value = base[`GIT_CONFIG_VALUE_${i}`];
    if (key !== undefined && value !== undefined) { kept[`GIT_CONFIG_KEY_${i}`] = key; kept[`GIT_CONFIG_VALUE_${i}`] = value; }
  }
  return { ...kept, GIT_CONFIG_COUNT: String(count + 1), [`GIT_CONFIG_KEY_${count}`]: "core.fsmonitor", [`GIT_CONFIG_VALUE_${count}`]: "false" };
}

/** commands a read-only role runs unasked, each exactly as written */
const READ_ONLY_COMMANDS = ["git status", "git ls-files", "ls", "pwd"];

/**
 * git's history commands in the one form that runs no diff helper; the guard accepts only plain
 * arguments after it. A flag later in the line could turn the helpers back on, so those are denied after.
 */
const HISTORY_COMMANDS = ["diff", "log", "show"].map((command) => `git ${command} --no-ext-diff --no-textconv *`);

/** read-only queries of GitHub, the pull request and the checks a lead's work is judged by */
const GITHUB_QUERIES = ["gh pr view *", "gh pr checks *", "gh pr list *", "gh run view *"];

/**
 * A merge or a revert the coordinator is handed (orchestrator.ts `coordinatorStep`): the person's,
 * or a merge the project's gate allowed, pinned to the commit it checked. A pattern has no digit
 * class, so the number of `gh pr merge` is one to six characters; the guard accepts digits only, and
 * a commit as hex only.
 */
const MERGE_COMMANDS = [
  ...Array.from({ length: 6 }, (_, i) => `gh pr merge ${"?".repeat(i + 1)} --merge`),
  ...Array.from({ length: 6 }, (_, i) => `gh pr merge ${"?".repeat(i + 1)} --merge --match-head-commit *`),
  "git pull --ff-only",
  "git merge --no-ff fleet/*",
  "git merge --no-ff agents/*",
  "git merge --abort",
  "git revert -m 1 --no-edit *",
  "git revert --abort",
  "git push origin *",
];

/**
 * Text that turns an allowed command into a refusal, whatever allowed it. A redirect makes the shell
 * tool match the whole statement, so `git log ... > ~/x` would meet the allow for `git log ... *`.
 * The characters after `git` are the ones a shell drops before git reads the line: `git diff
 * --ex""t-diff` is `--ext-diff` to git and not to a pattern. A path outside the repository given to
 * `git diff` is an implicit --no-index. (A backslash cannot be denied here: OpenCode turns it into `/`
 * before matching. The guard refuses it.)
 */
const DENIED_AFTER_ALLOWS = [
  "*>*", "*<*",
];
const DENIED_AFTER_FLEET = [
  "git *--output*", "git *--no-index*", "git *--ext-diff*", "git *--textconv*",
  `git *"*`, "git *'*", "git *`*", "git *$*", "git *{*",
  "git * /*", "git * ~*", "git * ../*", "git * ..", "git *=/*",
  "git merge --no-ff * ?*",
  // a revert takes one commit; a push one branch, never forced, deleted or as a refspec
  "git revert -m 1 --no-edit * ?*", "git revert -m 1 --no-edit *-*",
  "git push origin * ?*", "git push origin -*", "git push origin +*", "git push origin *:*", "git push origin HEAD",
  "gh *--web*", "gh *--watch*", "gh pr merge *-* --merge", "gh pr merge *-* --merge --match-head-commit *",
  "gh pr merge * --merge --match-head-commit * ?*", "gh pr merge * --merge --match-head-commit *-*",
];

function readOnlyRules({ resultDir, fleetCommand, merges }: OpencodeRole): Rule[] {
  return [
    // everything off, then only what a role that edits nothing needs
    deny("*", "*"),
    ...["read", "glob", "grep", "question"].map((action) => allow(action, "*")),
    // OpenCode asks before it reads a .env file; with no ask, it is denied (.env.example is not a secret)
    deny("read", "*.env"), deny("read", "*.env.*"), allow("read", "*.env.example"),
    ...[...READ_ONLY_COMMANDS, ...HISTORY_COMMANDS, ...GITHUB_QUERIES, ...(merges ? MERGE_COMMANDS : [])].map((command) => allow("shell", command)),
    ...DENIED_AFTER_ALLOWS.map((pattern) => deny("shell", pattern)),
    // the fleet command takes quoted text, which may hold < and >; the guard checks its arguments
    allow("shell", `${fleetCommand} *`),
    ...DENIED_AFTER_FLEET.map((pattern) => deny("shell", pattern)),
    // the result file is outside the workspace: both the path and the folder need the allowance
    allow("edit", `${resultDir}/*`), allow("external_directory", `${resultDir}/*`),
  ];
}

/**
 * The flags with which a push overwrites or deletes on the remote, as patterns on the text after
 * `git *push*`: `--force*` (also `--force-with-lease`; git takes no shorter prefix of it), `--mi*` and `--de*`
 * (git takes `--mir` and `--del` for `--mirror` and `--delete`), `--pru*` (`--prun`, `--prune`), `-d*`, `-f*`, up
 * to two flags of push before an `f` (`-vf`, `-vuf`; `-vunf` is not caught), a `:ref` (delete) and a `+ref` (force).
 */
function pushFlags(): string[] {
  const letters = [..."unvqd46"];
  return [
    "--force*", "--mi*", "--de*", "--pru*", "-d*", "-f*", ":*", "+*",
    // a bundle of up to two other flags before the f; spelled out, since a `?` between would also take the space of `-u fork`
    ...letters.flatMap((first) => [`-${first}f*`, ...letters.map((second) => `-${first}${second}f*`)]),
  ];
}

/**
 * A role that edits is treated as pi is: no approval gate. `* * allow` is not added, since it would
 * override the person's own denies; only what must not happen by accident is denied on top of the
 * defaults. These are best-effort, as pi's: an agent that edits and runs tests can run anything
 * (`env git push -f`, `bash -c`, an alias), and a rule only stops the usual spelling.
 * - a push that overwrites or deletes on the remote (above). Matched on the text, so `git *push*` also
 *   covers `git -C <dir> push`. (It refuses `git commit -m "no push -f"` too.)
 * - a file outside the work folder, except the result folder. A path outside is absolute, and one
 *   in the repository above a worktree is `../...`.
 */
function editorRules({ resultDir, fleetCommand }: OpencodeRole): Rule[] {
  return [
    // another config's ask or deny on shell would stop the fleet's own commands
    allow("shell", `${fleetCommand} *`),
    ...pushFlags().map((flag) => deny("shell", `git *push* ${flag}`)),
    deny("edit", "/*"), deny("edit", "../*"),
    allow("edit", `${resultDir}/*`), allow("external_directory", `${resultDir}/*`),
  ];
}

export function opencodeConfig(role: OpencodeRole): Record<string, unknown> {
  return {
    ...(role.model ? { model: role.model } : {}),
    share: "disabled",
    update: "disable",
    ...(role.readOnly
      ? {
        // the TUI takes no --agent: the agent is the default one. The rules are the agent's own, not the top level's, so the person's other agents are left as they are
        default_agent: OPENCODE_READ_ONLY_AGENT,
        agents: { [OPENCODE_READ_ONLY_AGENT]: { mode: "primary", description: "Reads the repository and edits no file.", permissions: readOnlyRules(role) } },
        plugins: [{ package: OPENCODE_GUARD_PLUGIN, options: { fleetCommand: role.fleetCommand, merges: role.merges } }],
      }
      : { permissions: editorRules(role) }),
  };
}

/** What a read-only role is told about the commands it may run, since a refused one only says no. */
export function opencodeReadOnlyNote({ merges, fleetCommand }: Pick<OpencodeRole, "merges" | "fleetCommand">): string {
  return [
    "Your shell accepts only these command lines, each whole and written exactly like this; any other is refused, and so is the web:",
    `- ${fleetCommand} ... (arguments are plain words, 'single-quoted' text, or "double-quoted" text without $, backticks or backslashes)`,
    "- git status, git ls-files, ls, pwd, each alone",
    "- git diff, git log, git show only as `git diff --no-ext-diff --no-textconv <arguments>` (the same for log and show), the arguments being plain flags (--stat, --name-only, --oneline, -n 20, --format=%h ...), revisions, and relative paths inside the repository after `--`; no quotes, no absolute or ~ or .. paths, no .env files",
    "- gh pr view [<number>], gh pr checks [<number>] (no number: the checked-out branch's pull request), gh pr list, gh run view <number>, with flags such as --json <fields>",
    ...(merges ? ["- for a merge or a revert the fleet asks you for: gh pr merge <number> --merge [--match-head-commit <sha>], git pull --ff-only, git merge --no-ff <branch>, git merge --abort, git revert -m 1 --no-edit <sha>, git revert --abort, git push origin <branch>"] : []),
    "In the fleet command, quote any text that holds a `#`, a space or other punctuation: 'single quotes' keep it literal; to put a single quote inside, close the quotes around it: 'don'\"'\"'t'.",
    "No `;`, `&&`, `|`, `$`, redirect (`<`, `>`), variable assignment or `export` outside the quotes of the fleet command. Read files with the read tool and search with grep and glob, not with cat or find.",
    "Do not try other forms of a refused command. If you need one, say so in your reply to the person or your lead, who can run it or widen what you may do.",
  ].join("\n");
}
