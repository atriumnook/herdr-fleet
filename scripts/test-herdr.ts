/**
 * Tests talk to their own herdr: a headless server for the named session
 * `herdr-fleet-test` (HERDR_TEST_SESSION overrides), started on first use and left
 * running for the next run. The workspaces, panes and agents the tests create never
 * show in the herdr the user works in.
 *
 * `bun test` loads this first (bunfig.toml); the browser and SSH scripts import it.
 * HERDR_TEST_LIVE=1 keeps the old behaviour: tests use HERDR_SOCKET, else the default
 * session. Without a herdr binary nothing changes, so CI runs as before.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ping, sessionSnapshot, workspaceCreate } from "../server/herdr/client.ts";

export const TEST_SESSION = process.env["HERDR_TEST_SESSION"] || "herdr-fleet-test";

/** Where herdr puts a named session's socket (it follows XDG_CONFIG_HOME, as remote-entry.ts does). */
export function testSocketPath(): string {
  const config = join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "herdr");
  return join(config, "sessions", TEST_SESSION, "herdr.sock");
}

/**
 * Where the test herdr's shells read their zsh startup files from (ZDOTDIR), beside the session's
 * socket so that it lasts as long as the server. The server hands it to every shell it starts, however
 * the pane is made (workspace.create, pane.split, tab.create, a server under test), so the panes never
 * read the person's ~/.zshenv and ~/.zshrc: the tests' results must not depend on them (#167, #168),
 * and the tests must leave nothing in what the person's zsh shares, such as zsh-abbr's job queue in
 * /tmp, where a shell closed while it starts holds every new zsh back for up to 30 s (#179). HOME stays
 * the person's: herdr finds its config and its sockets through it, and the programs the tests run in a
 * pane through ~. Every process the server starts inherits ZDOTDIR, an agent CLI and the shells it
 * starts included; they find their programs through the PATH the tests were started with. The empty
 * .zshrc keeps zsh from asking its new-user questions. A server of the session that was not started
 * here with ZDOTDIR is refused (useTestHerdr).
 */
export function testShellStartup(): string {
  return join(dirname(testSocketPath()), "zsh");
}

function herdrBinary(): string | null {
  const configured = process.env["HERDR_FLEET_HERDR_BIN"];
  if (configured) return configured;
  const found = Bun.which("herdr");
  return found ?? null;
}

async function answers(socket: string): Promise<boolean> {
  try { await ping(socket); return true; } catch { return false; }
}

/**
 * The server listening on `socket`, told apart from an earlier one: herdr makes the socket anew
 * each time a server starts, and a client connecting changes neither its inode nor its mtime.
 */
function serverOf(socket: string): string {
  const { ino, mtimeMs } = statSync(socket);
  return `${ino}:${mtimeMs}`;
}

/** Point this process (and what it spawns) at the test session, starting its server if needed. */
export async function useTestHerdr(): Promise<string | null> {
  // Unit tests must not discover or start herdr, even on a developer's PC.
  if (process.env["HERDR_TEST_MODE"] === "unit") return null;
  if (process.env["HERDR_TEST_LIVE"] === "1") return null;
  const herdr = herdrBinary();
  if (!herdr) return null;
  const socket = testSocketPath();
  const zshStartup = testShellStartup();
  mkdirSync(zshStartup, { recursive: true });
  if (!existsSync(join(zshStartup, ".zshrc"))) writeFileSync(join(zshStartup, ".zshrc"), "");
  // which server this file started with ZDOTDIR: one already running keeps the environment it was started with
  const startedHere = join(dirname(socket), "test-server.zdotdir");
  if (await answers(socket)) {
    if (!existsSync(startedHere) || readFileSync(startedHere, "utf8") !== serverOf(socket)) {
      throw new Error(
        `The test herdr session "${TEST_SESSION}" runs a server that was not started with ZDOTDIR (by an older scripts/test-herdr.ts, or another checkout's), ` +
        `so its panes would read your zsh files (#179). Once no other run uses it, stop it: herdr --session ${TEST_SESSION} server stop`,
      );
    }
  } else {
    Bun.spawn([herdr, "--session", TEST_SESSION, "server"], {
      stdin: "ignore",
      stdout: Bun.file(join(dirname(socket), "test-server.log")),
      stderr: Bun.file(join(dirname(socket), "test-server.log")),
      // run from inside a herdr pane, this process carries that pane's HERDR_* variables
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("HERDR_"))), ZDOTDIR: zshStartup },
    }).unref();
    const deadline = Date.now() + 15_000;
    while (!(existsSync(socket) && await answers(socket))) {
      if (Date.now() > deadline) throw new Error(`The test herdr session "${TEST_SESSION}" did not start; see ${join(dirname(socket), "test-server.log")}`);
      await Bun.sleep(100);
    }
    writeFileSync(startedHere, serverOf(socket));
  }
  // some tests read "a live workspace" without owning one: keep one resident, as a
  // session in use always has
  if ((await sessionSnapshot(socket)).workspaces.length === 0) {
    await workspaceCreate({ cwd: homedir(), label: "herdr-fleet-test-resident" }, socket);
  }
  process.env["HERDR_SOCKET"] = socket;
  return socket;
}

await useTestHerdr();
