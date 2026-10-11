import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UsageEntry, UsageReading, UsageWindow } from "../../shared/fleet.ts";
import { childEnv, claudeEnv, emptyWorkDir } from "../cli-child.ts";
import type { AgentKind } from "./types.ts";

export type { Cooldown, UsageEntry, UsageReading, UsageWindow } from "../../shared/fleet.ts";

/**
 * How much of each subscription is used, and which are cooling down after a rate limit: what the
 * fleet skips a spawn candidate for. Every number comes from the CLI's own way of telling it
 * (codex app-server, agy's and Claude Code's `/usage` in print mode, cursor's `/usage` screen); no
 * credential file is ever read.
 */

/**
 * The account a candidate draws on. agy keeps separate limits for its Gemini models and for the
 * others it hosts; pi has none of its own, so each of its providers cools down apart.
 */
export function usageKey(kind: AgentKind, model?: string): string {
  if (kind === "agy") return !model || /gemini/i.test(model) ? "agy:gemini" : "agy:3p";
  if (kind === "pi") {
    const slash = model?.indexOf("/") ?? -1;
    return slash > 0 ? `pi:${model!.slice(0, slash)}` : "pi";
  }
  return kind;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function windowName(minutes: unknown): string {
  if (!finite(minutes)) return "window";
  if (minutes === 10_080) return "weekly";
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

/** codex app-server's `account/rateLimits/read` result: primary and secondary windows. */
export function parseCodexRateLimits(result: unknown, now = Date.now()): UsageReading | undefined {
  const limits = isObject(result) && isObject(result["rateLimits"]) ? result["rateLimits"] : undefined;
  if (!limits) return undefined;
  const windows: UsageWindow[] = [];
  for (const key of ["primary", "secondary"]) {
    const window = limits[key];
    if (!isObject(window) || !finite(window["usedPercent"])) continue;
    windows.push({ name: windowName(window["windowDurationMins"]), usedPercent: window["usedPercent"], ...(finite(window["resetsAt"]) ? { resetsAt: window["resetsAt"] * 1000 } : {}) });
  }
  return windows.length ? { windows, readAt: now } : undefined;
}

/** `agy -p /usage --output-format json`: buckets of remaining share per model group, keyed by bucket id ("gemini-5h", "3p-weekly"). */
export function parseAgyUsage(output: unknown, now = Date.now()): Record<string, UsageReading> {
  const groups = isObject(output) && isObject(output["command"]) && isObject(output["command"]["data"]) ? output["command"]["data"]["groups"] : undefined;
  const readings: Record<string, UsageReading> = {};
  if (!Array.isArray(groups)) return readings;
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group["buckets"])) continue;
    for (const bucket of group["buckets"]) {
      if (!isObject(bucket) || typeof bucket["id"] !== "string" || !finite(bucket["remaining_fraction"])) continue;
      const key = bucket["id"].startsWith("gemini") ? "agy:gemini" : "agy:3p";
      const resetsAt = typeof bucket["reset_time"] === "string" ? Date.parse(bucket["reset_time"]) : NaN;
      (readings[key] ??= { windows: [], readAt: now }).windows.push({
        name: typeof bucket["window"] === "string" ? bucket["window"] : bucket["id"],
        usedPercent: Math.round((1 - bucket["remaining_fraction"]) * 1000) / 10,
        ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
      });
    }
  }
  return readings;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** epoch ms of a wall-clock time in an IANA zone; NaN for a zone Intl does not know */
function zonedTime(year: number, month: number, day: number, hours: number, minutes: number, zone: string): number {
  const guess = Date.UTC(year, month, day, hours, minutes);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(guess);
  } catch {
    return NaN;
  }
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const shown = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
  return guess - (shown - guess);
}

/** `Oct 4, 9:50pm (Asia/Tokyo)`: no year, so the next such time, at most a day in the past */
function claudeResetTime(text: string, now: number): number | undefined {
  const match = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(text.trim());
  if (!match) return undefined;
  const month = MONTHS.indexOf(match[1]!.slice(0, 1).toUpperCase() + match[1]!.slice(1, 3).toLowerCase());
  const hours = (Number(match[3]) % 12) + (match[5]!.toLowerCase() === "pm" ? 12 : 0);
  const year = new Date(now).getUTCFullYear();
  let at = zonedTime(year, month, Number(match[2]), hours, Number(match[4] ?? 0), match[6]!);
  if (Number.isFinite(at) && at < now - 86_400_000) at = zonedTime(year + 1, month, Number(match[2]), hours, Number(match[4] ?? 0), match[6]!);
  return Number.isFinite(at) ? at : undefined;
}

/**
 * `claude -p /usage`'s text: `Current session: 7% used · resets Oct 4, 9:50pm (Asia/Tokyo)` and
 * `Current week (all models): …`. Only the windows every model shares: a per-model weekly window
 * would wrongly hold back the others. An API-key session has none.
 */
export function parseClaudeUsage(text: string, now = Date.now()): UsageReading | undefined {
  const windows: UsageWindow[] = [];
  for (const [label, name] of [["Current session", "5h"], ["Current week (all models)", "weekly"]] as const) {
    const line = text.split("\n").find((l) => l.trim().startsWith(`${label}:`));
    const match = line && /:\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets (.+))?/.exec(line);
    if (!match) continue;
    const resetsAt = match[2] ? claudeResetTime(match[2], now) : undefined;
    windows.push({ name, usedPercent: Number(match[1]), ...(resetsAt ? { resetsAt } : {}) });
  }
  return windows.length ? { windows, readAt: now } : undefined;
}

const RATE_LIMITED = /rate.?limit|usage limit|limit reached|quota|too many requests|\b429\b|resource.?exhausted|out of credits/i;

/**
 * A failure message that says a limit was hit, and until when if it says: an ISO time, "in 2h 5m"
 * / "in 30 minutes", or a clock time ("at 3:45 PM", the next one to come). null when it is not a
 * rate limit, undefined when it is one with no time in it.
 */
export function rateLimitUntil(message: string, now = Date.now()): number | undefined | null {
  if (!RATE_LIMITED.test(message)) return null;
  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/.exec(message);
  if (iso) {
    const at = Date.parse(iso[0]);
    if (Number.isFinite(at) && at > now) return at;
  }
  const relative = /\bin\s+((?:\d+\s*(?:d|days?|h|hours?|hrs?|m|mins?|minutes?|s|secs?|seconds?)\b[\s,]*(?:and\s+)?)+)/i.exec(message);
  if (relative) {
    const unit: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };
    let total = 0;
    for (const part of relative[1]!.matchAll(/(\d+)\s*([dhms])/gi)) total += Number(part[1]) * unit[part[2]!.toLowerCase()]!;
    if (total > 0) return now + total;
  }
  const clock = /\bat\s+(\d{1,2}):(\d{2})\s*(am|pm)?\b/i.exec(message);
  if (clock) {
    let hours = Number(clock[1]) % (clock[3] ? 12 : 24);
    if (clock[3]?.toLowerCase() === "pm") hours += 12;
    const at = new Date(now);
    at.setHours(hours, Number(clock[2]), 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return at.getTime();
  }
  return undefined;
}

/**
 * a window read without its reset time counts this long: a full one would otherwise hold its CLI
 * back for good, since a CLI read only after its own turns (cursor) is never read again
 */
export const UNDATED_WINDOW_MS = 24 * 3_600_000;

/** A window that still counts: it has not reset since it was read. */
const current = (window: UsageWindow, reading: UsageReading, now: number) =>
  window.resetsAt === undefined ? now - reading.readAt < UNDATED_WINDOW_MS : window.resetsAt > now;

/** Reads the readings a CLI can give on demand: what it returns replaces everything known of that CLI but cooldowns. */
export type UsageProbe = () => Promise<Record<string, UsageReading>>;

export interface UsageTrackerOptions {
  /** readings and cooldowns survive a restart here; null keeps them in memory */
  file: string | null;
  /** the probe for each CLI that can be asked; a kind without one is learned from its errors (and cursor's screen) */
  probes?: Partial<Record<AgentKind, UsageProbe>>;
  /** how old a probed reading may be before a spawn asks again */
  probeTtlMs?: number;
  /** how long a probe may take before it counts as failed; PROBE_TIMEOUT_MS */
  probeTimeoutMs?: number;
  now?: () => number;
}

export const PROBE_TTL_MS = 60_000;
/**
 * How old a reading may be before the Fleet screen's own refresh asks again. Only the CLIs that
 * have a probe are asked: cursor has none (its `/usage` is typed into a live pane, after a turn).
 */
export const AUTO_REFRESH_MS = 5 * 60_000;
/** a CLI that keeps failing is asked less often (the wait doubles per failure) but at least hourly */
export const BACKOFF_CAP_MS = 60 * 60_000;
/** longer than any probe's own kill timer: a probe stuck past it must not hold spawns up */
export const PROBE_TIMEOUT_MS = 35_000;
/** cursor's `/usage` screen is read again after a turn once the last reading, or the last try, is this old */
export const SCREEN_TTL_MS = 10 * 60_000;

/** a key of this CLI: the CLI's own, or one of its parts (`agy:gemini`) */
const ofKind = (key: string, kind: string) => key === kind || key.startsWith(`${kind}:`);

function validWindow(value: unknown): value is UsageWindow {
  return isObject(value) && typeof value["name"] === "string" && finite(value["usedPercent"]) && (value["resetsAt"] === undefined || finite(value["resetsAt"]));
}

/** A stored entry, with only the parts that still have the shape this code reads. */
function storedEntry(value: unknown): UsageEntry | undefined {
  if (!isObject(value) || typeof value["key"] !== "string") return undefined;
  const entry: UsageEntry = { key: value["key"] };
  const reading = value["reading"];
  if (isObject(reading) && finite(reading["readAt"]) && Array.isArray(reading["windows"]) && reading["windows"].every(validWindow)) entry.reading = { readAt: reading["readAt"], windows: reading["windows"] };
  const cooldown = value["cooldown"];
  if (isObject(cooldown) && finite(cooldown["until"]) && finite(cooldown["since"]) && typeof cooldown["reason"] === "string") entry.cooldown = { until: cooldown["until"], since: cooldown["since"], reason: cooldown["reason"] };
  if (typeof value["error"] === "string") entry.error = value["error"];
  return entry;
}

/** The usage the fleet knows of, kept per account (usageKey). */
export class UsageTracker {
  private readonly entries = new Map<string, UsageEntry>();
  private readonly probedAt = new Map<AgentKind, number>();
  private readonly inFlight = new Map<AgentKind, Promise<void>>();
  /** failures in a row per CLI: one not installed or not signed in is not asked every time */
  private readonly failures = new Map<AgentKind, number>();
  /** when each account's screen was last tried, read or not: a screen that never shows the usage costs one try per SCREEN_TTL_MS */
  private readonly screenTriedAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly options: UsageTrackerOptions) {
    this.now = options.now ?? Date.now;
    if (!options.file) return;
    let stored: unknown;
    try { stored = JSON.parse(readFileSync(options.file, "utf8")); } catch { return; }
    if (!Array.isArray(stored)) return;
    for (const value of stored) {
      const entry = storedEntry(value);
      if (entry) this.entries.set(entry.key, entry);
    }
  }

  list(): UsageEntry[] {
    return [...this.entries.values()].sort((a, b) => a.key.localeCompare(b.key)).map((entry) => ({ ...entry }));
  }

  /**
   * Asks every probe whose last try is older than `maxAgeMs` (the probe TTL by default), one that
   * keeps failing after longer. `force` asks them all now, backing off or not.
   */
  async refresh(force = false, maxAgeMs?: number): Promise<void> {
    await Promise.all(Object.keys(this.options.probes ?? {}).map((kind) => this.probe(kind as AgentKind, force, maxAgeMs)));
  }

  /**
   * Why a candidate should not start now: its account is cooling down, or a window it draws on is
   * at least `maxUsedPercent` used. undefined when it may, including when nothing is known.
   */
  async unavailable(kind: AgentKind, model: string | undefined, maxUsedPercent: number): Promise<string | undefined> {
    await this.probe(kind);
    return this.known(kind, model, maxUsedPercent);
  }

  /** The same answer as unavailable from what is known now, asking no CLI. */
  known(kind: AgentKind, model: string | undefined, maxUsedPercent: number): string | undefined {
    const key = usageKey(kind, model);
    const entry = this.entries.get(key);
    const now = this.now();
    if (entry?.cooldown && entry.cooldown.until > now) return `${key} is cooling down until ${new Date(entry.cooldown.until).toISOString()} (${entry.cooldown.reason})`;
    const reading = entry?.reading;
    const full = reading?.windows.find((window) => current(window, reading, now) && window.usedPercent >= maxUsedPercent);
    if (full) return `${key} has used ${full.usedPercent}% of its ${full.name} limit${full.resetsAt ? ` (resets ${new Date(full.resetsAt).toISOString()})` : ""}`;
    return undefined;
  }

  /**
   * A start or a turn failed with `message`. A rate limit puts the account in cooldown: until the
   * time the message names, else until a window it read as full resets, else `defaultMinutes`.
   * Says whether it was one.
   */
  noteFailure(kind: AgentKind, model: string | undefined, message: string, defaultMinutes: number): boolean {
    const now = this.now();
    const until = rateLimitUntil(message, now);
    if (until === null) return false;
    const key = usageKey(kind, model);
    const entry = this.entries.get(key) ?? { key };
    const reading = entry.reading;
    const fullResets = reading?.windows.filter((window) => current(window, reading, now) && window.usedPercent >= 100 && window.resetsAt).map((window) => window.resetsAt!) ?? [];
    entry.cooldown = { until: until ?? (fullResets.length ? Math.max(...fullResets) : now + defaultMinutes * 60_000), reason: message.slice(0, 200), since: now };
    this.entries.set(key, entry);
    this.persist();
    return true;
  }

  /**
   * Whether to read a CLI's usage off its screen now (cursor's `/usage`): when neither the last
   * reading nor the last try is recent. A yes counts as the try.
   */
  claimScreen(kind: AgentKind, model?: string): boolean {
    const key = usageKey(kind, model);
    const now = this.now();
    const last = Math.max(this.entries.get(key)?.reading?.readAt ?? -Infinity, this.screenTriedAt.get(key) ?? -Infinity);
    if (now - last < SCREEN_TTL_MS) return false;
    this.screenTriedAt.set(key, now);
    return true;
  }

  record(key: string, reading: UsageReading): void {
    const entry = this.entries.get(key) ?? { key };
    entry.reading = reading;
    delete entry.error;
    this.entries.set(key, entry);
    this.persist();
  }

  /** Ends cooldowns: one account's, every account of a CLI (`agy`), or all of them. Returns the keys cleared. */
  clearCooldown(target?: string): string[] {
    const cleared: string[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.cooldown || (target && entry.key !== target && !entry.key.startsWith(`${target}:`))) continue;
      delete entry.cooldown;
      cleared.push(entry.key);
    }
    if (cleared.length) this.persist();
    return cleared;
  }

  private probe(kind: AgentKind, force = false, maxAgeMs?: number): Promise<void> {
    const probe = this.options.probes?.[kind];
    if (!probe) return Promise.resolve();
    const running = this.inFlight.get(kind);
    if (running) return running;
    const wait = maxAgeMs ?? this.options.probeTtlMs ?? PROBE_TTL_MS;
    const backedOff = Math.min(wait * 2 ** Math.min(this.failures.get(kind) ?? 0, 6), Math.max(wait, BACKOFF_CAP_MS));
    if (!force && this.now() - (this.probedAt.get(kind) ?? -Infinity) < backedOff) return Promise.resolve();
    const next = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutMs = this.options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${kind} did not answer within ${timeoutMs / 1000}s`)), timeoutMs); });
        const readings = await Promise.race([probe(), timeout]);
        // what the CLI answered is all there is now: a part it no longer reports goes, and so does an earlier failure
        for (const entry of [...this.entries.values()]) {
          if (!ofKind(entry.key, kind) || entry.key in readings) continue;
          delete entry.reading;
          delete entry.error;
          if (!entry.cooldown) this.entries.delete(entry.key);
        }
        for (const [key, reading] of Object.entries(readings)) {
          const entry = this.entries.get(key) ?? { key };
          entry.reading = reading;
          delete entry.error;
          this.entries.set(key, entry);
        }
        this.failures.delete(kind);
      } catch (error) {
        this.failures.set(kind, (this.failures.get(kind) ?? 0) + 1);
        // a CLI that cannot say leaves what was known; it is not a reason to refuse a spawn
        const message = error instanceof Error ? error.message : String(error);
        const known = [...this.entries.values()].filter((entry) => ofKind(entry.key, kind));
        for (const entry of known.length ? known : [{ key: kind }]) {
          entry.error = message;
          this.entries.set(entry.key, entry);
        }
      } finally {
        clearTimeout(timer);
        this.probedAt.set(kind, this.now());
        this.inFlight.delete(kind);
        this.persist();
      }
    })();
    this.inFlight.set(kind, next);
    return next;
  }

  /** A file that cannot be written loses only the restart's memory: never a spawn's own outcome. */
  private persist(): void {
    const file = this.options.file;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.entries.values()]), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch (error) {
      console.warn(`fleet: cannot save usage to ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// ---- probes: each asks the CLI itself ------------------------------------------------------

/**
 * Where a probe runs and what it starts. The folder is the probe's own, emptied before each run
 * (cli-child's emptyWorkDir); the tracker asks one probe of a kind at a time, so a kind's runs share
 * it. The CLI gets only the environment it needs from `env` (childEnv): an API key there would make
 * the CLI answer for the API, not the person's plan.
 */
export interface ProbeOptions {
  workDir: string;
  command?: string;
  /** the server's environment; process.env when left out */
  env?: Record<string, string | undefined>;
}

async function run(argv: string[], options: { timeoutMs: number; cwd: string; env: Record<string, string> }): Promise<string> {
  emptyWorkDir(options.cwd);
  const child = Bun.spawn(argv, { cwd: options.cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore", env: options.env });
  const timer = setTimeout(() => child.kill(), options.timeoutMs);
  try {
    const output = await new Response(child.stdout).text();
    const code = await child.exited;
    if (code !== 0) throw new Error(`${argv[0]} exited with ${code}`);
    return output;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `codex app-server` over stdio: initialize, then `account/rateLimits/read`. The answer comes back
 * as one JSON line among others; only the rate limits are kept (it also names the account). codex
 * keeps its sign-in under CODEX_HOME, which passes when set.
 */
export function codexProbe(options: ProbeOptions): UsageProbe {
  return async (): Promise<Record<string, UsageReading>> => {
    emptyWorkDir(options.workDir);
    const env = childEnv(options.env ?? process.env, ["CODEX_HOME"]);
    const child = Bun.spawn([options.command ?? "codex", "app-server"], { cwd: options.workDir, env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "herdr-fleet", version: "0" } } });
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("codex app-server closed before it answered");
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let message: { id?: number; result?: unknown; error?: { message?: string } };
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id === 1) {
            send({ method: "initialized" });
            send({ id: 2, method: "account/rateLimits/read" });
          } else if (message.id === 2) {
            if (message.error) throw new Error(`codex: ${message.error.message ?? "rate limits unavailable"}`);
            const reading = parseCodexRateLimits(message.result);
            return reading ? { codex: reading } : {};
          }
        }
      }
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  };
}

/** `agy -p /usage`: answered by the CLI without a model turn. Auto-update is held off (`true`, not `1`). */
export function agyProbe(options: ProbeOptions): UsageProbe {
  return async () => {
    const env = { ...childEnv(options.env ?? process.env), AGY_CLI_DISABLE_AUTO_UPDATE: "true" };
    return parseAgyUsage(JSON.parse(await run([options.command ?? "agy", "-p", "/usage", "--output-format", "json"], { timeoutMs: 30_000, cwd: options.workDir, env })));
  };
}

/**
 * `claude -p /usage`: a local command in print mode, answered without a model turn. No session is
 * kept, and the person's settings are not loaded, so their hooks and plugins do not run at every
 * probe (the sign-in is not a setting: it still applies). It runs in the probe's own folder, whose
 * project folder Claude Code still makes once, empty.
 */
export function claudeProbe(options: ProbeOptions): UsageProbe {
  return async (): Promise<Record<string, UsageReading>> => {
    const argv = [options.command ?? "claude", "-p", "/usage", "--no-session-persistence", "--setting-sources", "project", "--output-format", "json"];
    const output = JSON.parse(await run(argv, { timeoutMs: 30_000, cwd: options.workDir, env: claudeEnv(options.env ?? process.env) })) as { is_error?: boolean; result?: unknown };
    if (output.is_error || typeof output.result !== "string") throw new Error("claude: /usage gave no answer");
    const reading = parseClaudeUsage(output.result);
    return reading ? { claude: reading } : {};
  };
}
