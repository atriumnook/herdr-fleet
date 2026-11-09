/**
 * The gate of a pane whose role edits no file. A shell command passes only when the WHOLE string is
 * one of a few exact forms; everything else is refused, whatever the permission rules would say.
 *
 * Why the rules cannot be the gate (OpenCode 2.0.26, core/src/shell/parse.ts): the shell tool asks
 * for permission about each `command` node tree-sitter finds, and about nothing else. A line with no
 * command node runs unchecked: a bare redirect (`> ~/x`), an assignment (`x=1`), and a declaration
 * (`export GIT_CONFIG_COUNT=1 ...; git status` sets variables that make the allowed `git status` run
 * a program of the agent's choosing). Their text is also matched after OpenCode turns `\` into `/`,
 * and git reads `--ex""t-diff` as `--ext-diff`. So the rules stay as a second layer, and this decides.
 *
 * Forms (no quoting or expansion anywhere but in the fleet command's arguments):
 * - the fleet command, then arguments that are plain words, 'single-quoted' (literal in bash) or
 *   "double-quoted" without `$`, a backtick or a backslash;
 * - `git status`, `git ls-files`, `ls`, `pwd`;
 * - `git diff|log|show --no-ext-diff --no-textconv`, then only whitelisted flags, revisions and
 *   relative paths: none starting with `/` or `~`, none with a `..` path segment, none naming a `.env`
 *   file (git diff of two paths outside the repository is an implicit --no-index and reads any file);
 * - `gh pr view|checks <number>`, `gh run view <number>`, `gh pr list`, with whitelisted flags;
 * - for the coordinator: `gh pr merge <number> --merge`, `gh pr merge <number> --merge
 *   --match-head-commit <sha>` (a merge the project's gate allowed, pinned to the commit it checked),
 *   `git pull --ff-only`, `git merge --no-ff <fleet or agents branch>`, `git merge --abort`,
 *   `git revert -m 1 --no-edit <sha>`, `git revert --abort`, and `git push origin <branch>` (a revert
 *   of a pull request's merge reaches the base branch on GitHub; no flag, refspec or other remote).
 */

/** characters of a plain word; `~` only after its first character, so nothing expands (in the fleet command's arguments an unquoted `~` expands to $HOME: harmless, an absolute path is allowed there anyway) */
const WORD = /^(?!~)[A-Za-z0-9_.,:@%+=\/^~-]+$/;
const PLAIN = /[A-Za-z0-9_.,:@%+=\/^~-]/;
const DIGITS = /^[0-9]{1,9}$/;
const BRANCH = /^(?:fleet|agents)\/[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{7,40}$/;
/** a base branch to push to: plain names joined by `/`; no flag, `+` (force), `:` (refspec), `..` or HEAD */
const PUSHED = /^(?!HEAD$)[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;

const EXACT = new Set(["git status", "git ls-files", "ls", "pwd"]);

const GIT_FLAGS = new Set([
  "--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--oneline", "--graph", "--decorate", "--no-decorate", "--all",
  "--abbrev-commit", "--no-merges", "--merges", "--first-parent", "--reverse", "--cached", "--staged", "--patch", "--no-patch", "--summary",
  "--follow", "--full-index", "--raw", "--date-order", "--topo-order", "--branches", "--tags", "--remotes", "--no-color", "--ignore-all-space",
  "--ignore-space-change", "--check", "--minimal", "--patience", "--histogram", "-p", "-u", "-s", "-w", "-b", "-M",
]);
const GIT_VALUED = /^--(?:abbrev|max-count|skip|stat|diff-filter|since|until|after|before|author|committer|grep|format|pretty|date|unified)=(.+)$/;
const GIT_SHORT = /^(?:-[0-9]{1,6}|-n[0-9]{1,6}|-U[0-9]{1,4}|-[SG][A-Za-z0-9_.,:@%+=\/^~-]+)$/;

/** a revision or a path handed to git: inside the repository, and not a secret file */
function inside(word) {
  if (word.startsWith("/") || word.startsWith("~")) return false;
  if (/(^|[\/:])\.\.($|\/)/.test(word)) return false;
  if (/=[\/~]/.test(word)) return false;
  if (/(^|[\/:])\.env/.test(word)) return false;
  return true;
}

function gitHistory(words) {
  const [, , noExt, noText, ...rest] = words;
  if (noExt !== "--no-ext-diff" || noText !== "--no-textconv") return false;
  let paths = false;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i];
    if (!inside(word)) return false;
    // %GK, %GS, %GG and the rest of the %G placeholders verify a signature, which runs the gpg.program of the repository's config
    if (/%G/.test(word)) return false;
    if (paths) continue;
    if (word === "--") { paths = true; continue; }
    if (!word.startsWith("-")) continue;
    if (GIT_FLAGS.has(word) || GIT_SHORT.test(word) || GIT_VALUED.test(word)) continue;
    if (word === "-n" && DIGITS.test(rest[i + 1] ?? "")) { i++; continue; }
    return false;
  }
  return true;
}

/** flags of the gh queries; a flag that takes a value is followed by it */
function ghFlags(rest, flags) {
  for (let i = 0; i < rest.length; i++) {
    const kind = flags[rest[i]];
    if (kind === undefined) return false;
    if (kind === "value" && !/^[A-Za-z0-9_,.-]{1,60}$/.test(rest[++i] ?? "")) return false;
    if (kind === "number" && !DIGITS.test(rest[++i] ?? "")) return false;
  }
  return true;
}
const PR_VIEW = { "--json": "value", "--comments": "bool", "-c": "bool" };
const PR_CHECKS = { "--json": "value", "--required": "bool" };
const PR_LIST = { "--json": "value", "--state": "value", "-s": "value", "--limit": "number", "-L": "number" };
const RUN_VIEW = { "--json": "value", "--log": "bool", "--log-failed": "bool", "--exit-status": "bool", "--job": "number" };

function github(words) {
  const [, group, verb, ...rest] = words;
  if (group === "pr" && verb === "list") return ghFlags(rest, PR_LIST);
  const numbered = DIGITS.test(rest[0] ?? "");
  const flags = numbered ? rest.slice(1) : rest;
  // without a number, view and checks read the pull request of the checked-out branch; a run needs its number
  if (group === "pr" && verb === "view") return ghFlags(flags, PR_VIEW);
  if (group === "pr" && verb === "checks") return ghFlags(flags, PR_CHECKS);
  if (group === "run" && verb === "view") return numbered && ghFlags(flags, RUN_VIEW);
  return false;
}

function merge(command) {
  if (command === "git pull --ff-only" || command === "git merge --abort" || command === "git revert --abort") return true;
  const words = command.split(" ");
  if (words.length === 4 && words[0] === "git" && words[1] === "merge" && words[2] === "--no-ff") return BRANCH.test(words[3]);
  if (words.length === 6 && command.startsWith("git revert -m 1 --no-edit ")) return SHA.test(words[5]);
  if (words.length === 4 && command.startsWith("git push origin ")) return PUSHED.test(words[3]) && !words[3].includes("..");
  if (!command.startsWith("gh pr merge ") || !DIGITS.test(words[3]) || words[4] !== "--merge") return false;
  return words.length === 5 || (words.length === 7 && words[5] === "--match-head-commit" && SHA.test(words[6]));
}

/** the fleet command's arguments (after the command itself): words of plain characters and quoted strings */
function fleetArguments(rest) {
  let i = 0;
  while (i < rest.length) {
    if (rest[i] !== " ") return false;
    while (rest[i] === " ") i++;
    while (i < rest.length && rest[i] !== " ") {
      const char = rest[i];
      if (char === "'") {
        const end = rest.indexOf("'", i + 1);
        if (end < 0) return false;
        i = end + 1;
      } else if (char === '"') {
        let end = i + 1;
        while (end < rest.length && rest[end] !== '"') {
          if (rest[end] === "$" || rest[end] === "`" || rest[end] === "\\") return false;
          end++;
        }
        if (end >= rest.length) return false;
        i = end + 1;
      } else if (PLAIN.test(char)) i++;
      else return false;
    }
  }
  return true;
}

/** Whether the shell line is one of the exact forms. `options`: `{ fleetCommand, merges }`. */
export function allowed(command, options = {}) {
  const { fleetCommand, merges } = options;
  if (typeof command !== "string") return false;
  if (fleetCommand && (command === fleetCommand || command.startsWith(`${fleetCommand} `))) return fleetArguments(command.slice(fleetCommand.length));
  if (EXACT.has(command)) return true;
  const words = command.split(" ");
  if (!words.every((word) => WORD.test(word))) return false;
  if (merges === true && merge(command)) return true;
  if (words[0] === "git" && ["diff", "log", "show"].includes(words[1])) return gitHistory(words);
  if (words[0] === "gh" && (words[1] === "pr" || words[1] === "run")) return github(words);
  return false;
}

/** Why a tool call is refused, or undefined when it is let through. */
export function refusal(tool, input, options = {}) {
  if (tool !== "shell") return undefined;
  const command = input && typeof input === "object" ? input.command : undefined;
  if (typeof command !== "string") return "herdr-fleet: this agent may run only shell commands given as text.";
  if (allowed(command, options)) return undefined;
  return "herdr-fleet: this agent edits no file, and its shell takes only a few exact command forms (git status, git ls-files, ls, pwd, git diff|log|show --no-ext-diff --no-textconv with plain arguments inside the repository, gh pr view|checks|list, gh run view, the fleet command). This one is refused. Use the read, grep and glob tools, write your result file with the edit tool, and ask the person or your lead for anything else.";
}
