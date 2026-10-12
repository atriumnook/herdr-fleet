/**
 * The part of the guard that decides. OpenCode 2 asks for permission about the commands it finds in
 * a shell line, and finds none in a line that is only a redirect (`> ~/x`, `>> ~/.bashrc`, `<f`):
 * such a line runs with no check at all, and `> file` truncates any file the person can write.
 * No permission rule can reach it, so a read-only role is held to this instead: its shell lines
 * carry no `<` and no `>`. (A `<` or `>` inside quotes is refused too; the check does not parse.)
 *
 * A backslash is refused as well. The permission rules for git match the raw text of a command,
 * and `git diff --o\utput=f` reaches git as `--output=f` (git takes an option's unambiguous
 * prefix and the shell drops the backslash), so no pattern can see it.
 */
const REFUSED = /[<>\\]/;

/** Why a tool call is refused, or undefined when it is let through. */
export function refusal(tool, input) {
  if (tool !== "shell") return undefined;
  const command = input && typeof input === "object" ? input.command : undefined;
  if (typeof command !== "string") return "herdr-fleet: this agent may run only shell commands given as text.";
  if (!REFUSED.test(command)) return undefined;
  return "herdr-fleet: this agent edits no file, so a shell command with a redirect (< or >) or a backslash is refused. Use the read tool to read files, and write your result file with the edit tool.";
}
