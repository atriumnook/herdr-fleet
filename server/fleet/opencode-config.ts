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
 * - A line with no command node (`> ~/x`, `<f`) is not checked at all (see opencode/fleet-guard).
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
/** the plugin that refuses what no rule can reach; a directory, since OpenCode loads no single file from its config */
export const OPENCODE_GUARD_PLUGIN = resolve(import.meta.dir, "..", "..", "opencode", "fleet-guard");

/** commands a read-only role runs unasked, each exactly as written */
const READ_ONLY_COMMANDS = ["git status", "git ls-files", "ls", "pwd"];

/**
 * git's history commands in the one form that cannot run the repository's diff helpers: a flag later
 * in the line could turn them back on, so `--ext-diff` and `--textconv` are denied after. (git takes no
 * abbreviation of these options: `--ext-d` is refused, checked with git 2.x.)
 */
const HISTORY_COMMANDS = ["diff", "log", "show"].map((command) => `git ${command} --no-ext-diff --no-textconv *`);

/** read-only queries of GitHub, the pull request and the checks a lead's work is judged by */
const GITHUB_QUERIES = ["gh pr view *", "gh pr list *", "gh pr checks *", "gh run view *"];

/**
 * A merge the person pressed (orchestrator.ts `coordinatorStep`), each as the fleet words it. The
 * number of `gh pr merge` is one to six characters (a pattern has no digit class), and a dash among
 * them is denied after: a flag before `--merge` would be a different merge (`--admin`, `-d`).
 */
const MERGE_COMMANDS = [
  ...Array.from({ length: 6 }, (_, i) => `gh pr merge ${"?".repeat(i + 1)} --merge`),
  "git pull --ff-only",
  "git merge --no-ff fleet/*",
  "git merge --no-ff agents/*",
  "git merge --abort",
];

/**
 * Text that turns an allowed command into a refusal, whatever allowed it. A redirect makes the shell
 * tool match the whole statement, so `ls > ~/x` would meet the pattern of `<fleet> *`.
 * The characters after `git` are the ones a shell drops before git reads the line: `git diff
 * --ex""t-diff` is `--ext-diff` to git and not to a pattern. (A backslash cannot be denied here:
 * OpenCode turns it into `/` before matching. The plugin refuses it.)
 */
const DENIED_AFTER = [
  "*>*", "*<*",
  "git *--output*", "git *--no-index*", "git *--ext-diff*", "git *--textconv*",
  `git *"*`, "git *'*", "git *`*", "git *$*", "git *{*",
  "gh pr merge *-* --merge",
];

function readOnlyRules({ resultDir, fleetCommand, merges }: OpencodeRole): Rule[] {
  return [
    // everything off, then only what a role that edits nothing needs
    deny("*", "*"),
    ...["read", "glob", "grep", "question"].map((action) => allow(action, "*")),
    // OpenCode asks before it reads a .env file; with no ask, it is denied (.env.example is not a secret)
    deny("read", "*.env"), deny("read", "*.env.*"), allow("read", "*.env.example"),
    ...[...READ_ONLY_COMMANDS, ...HISTORY_COMMANDS, ...GITHUB_QUERIES, `${fleetCommand} *`, ...(merges ? MERGE_COMMANDS : [])].map((command) => allow("shell", command)),
    // the result file is outside the workspace: both the path and the folder need the allowance
    allow("edit", `${resultDir}/*`), allow("external_directory", `${resultDir}/*`),
    ...DENIED_AFTER.map((pattern) => deny("shell", pattern)),
  ];
}

/**
 * A role that edits is treated as pi is: no approval gate. `* * allow` is not added, since it would
 * override the person's own denies; only what must not happen by accident is denied on top of the
 * defaults. Its shell is open (a test run is a program), so these are not a boundary:
 * - a push that overwrites the remote: git's `--force*` and `--mirror`, `-f` alone or after the
 *   other one-letter flags of push, and a `+refspec`. Matched on the text, so `git *push*` also
 *   covers `git -C <dir> push`. (It refuses `git commit -m "no push -f"` too.)
 * - a file outside the work folder, except the result folder. A path outside is absolute, and one
 *   in the repository above a worktree is `../...`.
 */
function editorRules({ resultDir, fleetCommand }: OpencodeRole): Rule[] {
  const pushFlags = ["--force*", "--mirror*", "+*", "-f*", ...[..."unvqd46"].map((flag) => `-${flag}f*`)];
  return [
    // another config's ask or deny on shell would stop the fleet's own commands
    allow("shell", `${fleetCommand} *`),
    ...pushFlags.map((flag) => deny("shell", `git *push* ${flag}`)),
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
        plugins: [OPENCODE_GUARD_PLUGIN],
      }
      : { permissions: editorRules(role) }),
  };
}

/** What a read-only role is told about the commands it may run, since a refused one only says no. */
export function opencodeReadOnlyNote({ merges, fleetCommand }: Pick<OpencodeRole, "merges" | "fleetCommand">): string {
  return [
    "Your shell runs only these commands, each written exactly like this; any other is refused, and so is the web:",
    `- git status, git ls-files, ls, pwd, ${fleetCommand} ...`,
    "- git diff, git log, git show only as `git diff --no-ext-diff --no-textconv <arguments>` (the same for log and show), with no quotes, $, backticks or braces",
    "- gh pr view, gh pr list, gh pr checks, gh run view",
    ...(merges ? ["- for a merge the fleet asks you for: gh pr merge <number> --merge, git pull --ff-only, git merge --no-ff <branch>, git merge --abort"] : []),
    "No command may contain `<`, `>` or a backslash. Read files with the read tool and search with grep and glob, not with cat or find.",
    "Do not try other forms of a refused command. If you need one, say so in your reply to the person or your lead, who can run it or widen what you may do.",
  ].join("\n");
}
