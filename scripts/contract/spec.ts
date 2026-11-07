/**
 * The launch spec of the HTTP/WS contract (ADR 0122-parity-criteria, "HTTP/WS の契約: 起動の指定"):
 * the environment a server under test starts with, and the test options its test entry point reads.
 * Both the launcher (scripts/contract/launch.ts) and the TypeScript test entry point
 * (scripts/contract/server.ts) check a spec here, so that both refuse the same names.
 */

/** What `env` may set: only what the production server already reads from its environment. PORT is the launcher's. */
export const ENV_NAMES = [
  "HOST", "HERDR_FLEET_TOKEN", "HERDR_FLEET_TAILSCALE_OWNER", "HERDR_FLEET_STATE_DIR", "HERDR_SOCKET",
  "CODEX_HOME", "HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR",
  "TMPDIR", "PATH", "HERDR_FLEET_HERDR_BIN", "XDG_CONFIG_HOME",
] as const;

export type EnvName = (typeof ENV_NAMES)[number];

/** The test options: what the production environment cannot express, written as data only. */
export interface TestOptions {
  /** the PC's Tailscale login; null = none. Either way `tailscale status` is never read */
  tailscaleOwner?: string | null;
  /** false: the PC list (/api/machines) does not poll this PC's herdr */
  machines?: boolean;
  /** true: push subscriptions accept endpoints on 127.0.0.1 only (server/push.fake.ts), and no vendor's */
  acceptLoopbackPush?: boolean;
  /** milliseconds a push alert waits for the pane first (short, long), and the shortest turn told as long (longTurn) */
  alertTiming?: { short?: number; long?: number; longTurn?: number };
  submitDeadlineMs?: number;
  attachRetryForMs?: number;
  attachHeldRetryMs?: number;
  attachRelookupForMs?: number;
  /** whether herdr can `terminal attach`, settled without asking herdr */
  terminalAttach?: boolean;
  /** false: the server cannot run a pane's terminal on a PTY of its own. Unset, it follows terminalAttach */
  localPty?: boolean;
}

export interface LaunchSpec {
  env?: Partial<Record<EnvName, string>>;
  test?: TestOptions;
}

const BOOLEANS = ["machines", "acceptLoopbackPush", "terminalAttach", "localPty"] as const;
const MILLISECONDS = ["submitDeadlineMs", "attachRetryForMs", "attachHeldRetryMs", "attachRelookupForMs"] as const;
const TIMINGS = ["short", "long", "longTurn"] as const;
const TEST_NAMES: readonly string[] = ["tailscaleOwner", "alertTiming", ...BOOLEANS, ...MILLISECONDS];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isMilliseconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The test options in `value`, or an Error that names the first option that is not in the table or not of its type. */
export function parseTestOptions(value: unknown): TestOptions {
  if (!isRecord(value)) throw new Error("test options: expected a JSON object");
  for (const [name, option] of Object.entries(value)) {
    if (!TEST_NAMES.includes(name)) throw new Error(`test options: unknown option "${name}"`);
    const wrong = () => new Error(`test options: "${name}" has the wrong type`);
    if (name === "tailscaleOwner") {
      if (option !== null && typeof option !== "string") throw wrong();
    } else if (name === "alertTiming") {
      if (!isRecord(option)) throw wrong();
      for (const [timing, ms] of Object.entries(option)) {
        if (!(TIMINGS as readonly string[]).includes(timing)) throw new Error(`test options: unknown option "alertTiming.${timing}"`);
        if (!isMilliseconds(ms)) throw new Error(`test options: "alertTiming.${timing}" has the wrong type`);
      }
    } else if ((BOOLEANS as readonly string[]).includes(name)) {
      if (typeof option !== "boolean") throw wrong();
    } else if (!isMilliseconds(option)) {
      throw wrong();
    }
  }
  return value as TestOptions;
}

/** The names in `env`, or an Error that names the first one the spec does not allow. */
export function checkEnvNames(env: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(env)) {
    if (name === "PORT") throw new Error(`launch spec: env "PORT" is chosen by the launcher, not by a test`);
    if (!(ENV_NAMES as readonly string[]).includes(name)) throw new Error(`launch spec: env "${name}" is not one the server reads`);
    if (typeof value !== "string") throw new Error(`launch spec: env "${name}" must be a string`);
  }
}
