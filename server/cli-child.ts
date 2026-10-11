import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * What a CLI the server starts on its own gets: a usage probe or an explanation, never an agent's
 * pane. Only the environment it needs, and a folder of the server's own.
 */

/** what every such CLI keeps of the server's environment: what it needs to start and to find its sign-in */
const KEPT_ENV = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TMPDIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]);

/**
 * The CLI's whole environment: KEPT_ENV, the locale (LC_*), XDG_*, and the names in `alsoKeep` (the
 * CLI's own folder, like CLAUDE_CONFIG_DIR). Nothing else passes: an API key (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GEMINI_API_KEY) would bill the API instead of the person's plan and answer for it,
 * other provider settings could send the CLI elsewhere, and HERDR_* points at the person's session.
 */
export function childEnv(source: Record<string, string | undefined>, alsoKeep: readonly string[] = []): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (KEPT_ENV.has(name) || alsoKeep.includes(name) || name.startsWith("LC_") || name.startsWith("XDG_"))) env[name] = value;
  }
  return env;
}

/**
 * Makes the folder (0700) or empties it, so what a run before left behind is not read by the next.
 * Never the shared temp folder, where another user could leave a `.claude/settings.json` or a
 * `CLAUDE.md` for the CLI to read. One fixed folder per use, so Claude Code keeps one entry for it
 * under ~/.claude/projects, not one per run; its users run one at a time.
 */
export function emptyWorkDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // a link in its place would send the CLI elsewhere: only a real folder is used
  if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`);
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true });
}
