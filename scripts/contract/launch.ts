/**
 * Starts a server under test as a process of its own, from a launch spec (ADR 0122-parity-criteria,
 * "HTTP/WS の契約: 起動の指定"). A black-box test talks to it through `url` only, so the same test
 * runs against the TypeScript server or the Rust core:
 *
 *   HERDR_FLEET_CONTRACT_TARGET=ts            scripts/contract/server.ts (the default)
 *   HERDR_FLEET_CONTRACT_TARGET=rust:<path>   that executable
 *
 * The child's environment is built from nothing: what a CLI child keeps (server/cli-child.ts, childEnv),
 * HERDR_FLEET_HERDR_BIN, the test herdr session's socket, a new empty state folder, and the test's
 * own `env` on top. Never HERDR_* of the test process, never an API key, never port 7317.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { childEnv } from "../../server/cli-child.ts";
import { testSocketPath } from "../test-herdr.ts";
import { checkEnvNames, parseTestOptions, type LaunchSpec, type TestOptions } from "./spec.ts";

export type { LaunchSpec, TestOptions } from "./spec.ts";

export interface LaunchedServer {
  /** `http://<host>:<port>`, no trailing slash */
  readonly url: string;
  /** SIGTERM, then waits for the exit; fails unless the server ended with code 0 */
  stop(): Promise<void>;
}

export type ContractTarget = { kind: "ts" } | { kind: "rust"; path: string };

const REPO = resolve(import.meta.dir, "../..");
const TS_ENTRY = join(import.meta.dir, "server.ts");
const PORT_FIRST = 7400;
const PORT_LAST = 7499;
const LISTEN_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 10_000;

/** what the child inherits besides what a CLI child keeps (server/cli-child.ts): the herdr the tests use */
const ALSO_KEPT = ["HERDR_FLEET_HERDR_BIN"];

/** The server the contract runs against, from HERDR_FLEET_CONTRACT_TARGET. */
export function contractTarget(value: string | undefined): ContractTarget {
  if (value === undefined || value === "" || value === "ts") return { kind: "ts" };
  if (value.startsWith("rust:") && value.length > "rust:".length) return { kind: "rust", path: resolve(value.slice("rust:".length)) };
  throw new Error(`HERDR_FLEET_CONTRACT_TARGET="${value}": expected ts or rust:<path to the executable>`);
}

const targetLabel = (target: ContractTarget) => (target.kind === "ts" ? "ts" : `rust:${target.path}`);

/** The child's environment before the launcher adds PORT (ADR 0122, steps 1 to 3). */
export function serverEnvironment(
  source: Record<string, string | undefined>,
  env: Record<string, string>,
  given: { socket: string; stateDir: string },
): Record<string, string> {
  checkEnvNames(env);
  const built = childEnv(source, ALSO_KEPT);
  built["HERDR_SOCKET"] = given.socket;
  built["HERDR_FLEET_STATE_DIR"] = given.stateDir;
  Object.assign(built, env);
  // an empty socket is no socket to herdr's client, which then falls back to the person's own session
  if (built["HERDR_SOCKET"] === "") throw new Error("launch spec: HERDR_SOCKET is empty, and the server would talk to the default herdr session");
  refuseFleetState(source, built["HERDR_FLEET_STATE_DIR"]!);
  return built;
}

/**
 * The running fleet's state folder (and what is in it) never reaches a server under test, and neither
 * does an empty one, from which the server would fall back to it. Links are followed before comparing.
 */
function refuseFleetState(source: Record<string, string | undefined>, stateDir: string): void {
  if (stateDir === "") throw new Error("launch spec: HERDR_FLEET_STATE_DIR is empty, and the server would use the fleet's own state folder");
  const home = source["HOME"] || homedir();
  const fleetStates = [source["HERDR_FLEET_STATE_DIR"], join(home, ".config", "herdr-fleet"), source["XDG_CONFIG_HOME"] && join(source["XDG_CONFIG_HOME"], "herdr-fleet")]
    .filter((path): path is string => !!path);
  const target = canonical(stateDir);
  for (const fleetState of fleetStates) {
    const protectedPath = canonical(fleetState);
    if (target === protectedPath || target.startsWith(`${protectedPath}/`)) {
      throw new Error(`launch spec: HERDR_FLEET_STATE_DIR is in the fleet's own state folder (${fleetState})`);
    }
  }
}

/** the path with every link in its existing part followed */
function canonical(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...rest);
}

/** The test options a server gets: tailscaleOwner defaults to null, so the result never depends on this PC's Tailscale. */
export function serverTestOptions(test: TestOptions, env: Record<string, string>): TestOptions {
  const options = parseTestOptions(test);
  const ownerInEnv = env["HERDR_FLEET_TAILSCALE_OWNER"];
  if (options.tailscaleOwner !== undefined && ownerInEnv !== undefined) {
    throw new Error("launch spec: set the Tailscale owner in test.tailscaleOwner or in env.HERDR_FLEET_TAILSCALE_OWNER, not both");
  }
  // an empty or blank owner in env names nobody: the server would read `tailscale status` instead
  return options.tailscaleOwner === undefined && !ownerInEnv?.trim() ? { ...options, tailscaleOwner: null } : options;
}

/** Ports 7400 to 7499 in a random order, each one skipped while something on 127.0.0.1 holds it. */
export function* candidatePorts(): Generator<number> {
  const ports = Array.from({ length: PORT_LAST - PORT_FIRST + 1 }, (_, index) => PORT_FIRST + index);
  for (let index = ports.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [ports[index], ports[other]] = [ports[other]!, ports[index]!];
  }
  for (const port of ports) if (portFree(port)) yield port;
}

function portFree(port: number): boolean {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
}

/** servers still running when the test process exits are killed with it */
const running = new Set<Bun.Subprocess>();
process.once("exit", () => {
  for (const child of running) child.kill("SIGKILL");
});

/**
 * Starts the target server from `spec` and resolves once it listens. `internals` is for the
 * launcher's own tests: the ports to try, in order, and the target in place of the environment's.
 */
export async function launchServer(
  spec: LaunchSpec = {},
  internals: { ports?: Iterable<number>; target?: ContractTarget } = {},
): Promise<LaunchedServer> {
  const target = internals.target ?? contractTarget(process.env["HERDR_FLEET_CONTRACT_TARGET"]);
  const label = targetLabel(target);
  const env = spec.env ?? {};
  checkEnvNames(env);
  const test = serverTestOptions(spec.test ?? {}, env as Record<string, string>);
  if (target.kind === "rust" && !existsSync(target.path)) {
    throw new Error(`HTTP/WS contract target ${label}: the executable ${target.path} was not found`);
  }
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-fleet-contract-"));
  try {
    const childEnv = serverEnvironment(process.env, env as Record<string, string>, { socket: testSocketPath(), stateDir });
    for (const port of internals.ports ?? candidatePorts()) {
      if (port < PORT_FIRST || port > PORT_LAST) throw new Error(`launch spec: port ${port} is outside ${PORT_FIRST}-${PORT_LAST}`);
      const started = await start(target, label, { ...childEnv, PORT: String(port) }, test);
      if (started === "port-in-use") continue;
      return {
        url: started.url,
        stop: () => started.stop().finally(() => rmSync(stateDir, { recursive: true, force: true })),
      };
    }
    throw new Error(`HTTP/WS contract target ${label}: no free port in ${PORT_FIRST}-${PORT_LAST}`);
  } catch (error) {
    rmSync(stateDir, { recursive: true, force: true });
    throw error;
  }
}

async function start(
  target: ContractTarget,
  label: string,
  env: Record<string, string>,
  test: TestOptions,
): Promise<"port-in-use" | { url: string; stop(): Promise<void> }> {
  const command = target.kind === "ts" ? [process.execPath, TS_ENTRY] : [target.path];
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn(command, { cwd: REPO, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
  } catch (error) {
    throw new Error(`HTTP/WS contract target ${label}: could not start ${command.join(" ")}: ${error instanceof Error ? error.message : String(error)}`);
  }
  running.add(child);
  try {
    child.stdin.write(JSON.stringify(test));
    await child.stdin.end();
  } catch {
    // a server that exits without reading its options closes the pipe: its exit and standard error tell why, below
  }

  let errors = "";
  let started = false;
  const forward = (text: string) => { if (started) process.stderr.write(text); };
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      const text = decoder.decode(chunk, { stream: true });
      if (errors.length < 64_000) errors += text;
      forward(text);
    }
  })();

  const stdout = child.stdout.getReader();
  const listening = (async (): Promise<{ hostname: string; port: number } | null> => {
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { done, value } = await stdout.read();
      if (done) return null;
      buffered += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const address = listeningAddress(line);
        if (address) {
          if (buffered) process.stderr.write(buffered);
          return address;
        }
      }
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolveTimeout) => { timer = setTimeout(() => resolveTimeout("timeout"), LISTEN_TIMEOUT_MS); });
  let address = await Promise.race([listening, timeout]);
  // a server that closed its standard output without listening has the rest of the time to exit
  if (address === null && await Promise.race([child.exited.then(() => "exited" as const), timeout]) === "timeout") address = "timeout";
  clearTimeout(timer);
  // a server that listens on another port than the one it was given could be any server, 7317 included
  const expectedPort = Number(env["PORT"]);
  if (address !== null && address !== "timeout" && address.port !== expectedPort) {
    child.kill("SIGKILL");
    await child.exited;
    running.delete(child);
    throw new Error(`HTTP/WS contract target ${label}: the server announced port ${address.port}, not the PORT it was given (${expectedPort})`);
  }

  if (address === null || address === "timeout") {
    if (address === "timeout") child.kill("SIGKILL");
    const code = await child.exited;
    running.delete(child);
    await stderrDone;
    if (address === null && /EADDRINUSE|address already in use|port \d+ in use/i.test(errors)) return "port-in-use";
    const why = address === "timeout" ? `did not listen within ${LISTEN_TIMEOUT_MS / 1000}s` : `exited with code ${code} before it listened`;
    throw new Error(`HTTP/WS contract target ${label}: the server ${why}${errors ? `\n${errors.trimEnd()}` : ""}`);
  }

  started = true;
  if (errors) process.stderr.write(errors);
  // what the server writes from now on goes to the test's output
  void (async () => {
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await stdout.read();
      if (done) return;
      process.stderr.write(decoder.decode(value, { stream: true }));
    }
  })();

  let stopped: Promise<void> | undefined;
  return {
    url: `http://${urlHost(address.hostname)}:${address.port}`,
    stop: () => (stopped ??= (async () => {
      child.kill("SIGTERM");
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((resolveLate) => { killTimer = setTimeout(() => resolveLate("late"), STOP_TIMEOUT_MS); });
      const exited = await Promise.race([child.exited, late]);
      clearTimeout(killTimer);
      if (exited === "late") child.kill("SIGKILL");
      const code = await child.exited;
      running.delete(child);
      if (exited === "late") throw new Error(`HTTP/WS contract target ${label}: the server did not exit within ${STOP_TIMEOUT_MS / 1000}s of SIGTERM`);
      if (code !== 0) throw new Error(`HTTP/WS contract target ${label}: the server exited with code ${code} after SIGTERM`);
    })()),
  };
}

function listeningAddress(line: string): { hostname: string; port: number } | null {
  try {
    const parsed = JSON.parse(line) as { listening?: { hostname?: unknown; port?: unknown } };
    const { hostname, port } = parsed.listening ?? {};
    return typeof hostname === "string" && typeof port === "number" ? { hostname, port } : null;
  } catch {
    return null;
  }
}

/** a server on every address is reached on loopback; an IPv6 literal goes in brackets */
function urlHost(hostname: string): string {
  if (hostname === "0.0.0.0" || hostname === "") return "127.0.0.1";
  if (hostname === "::") return "[::1]";
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}
