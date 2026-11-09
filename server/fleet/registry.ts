import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FleetAgentKind, Writer } from "../../shared/fleet.ts";
import type { AgentRun } from "./types.ts";

export function makeId(): string {
  return randomBytes(4).toString("hex");
}

export function makeGroupId(): string {
  return `fleet-${randomBytes(4).toString("hex")}`;
}

function slug(value: string, max = 20): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const safe = /^[a-z]/.test(normalized) ? normalized : `a-${normalized || "agent"}`;
  return safe.slice(0, max).replace(/-+$/g, "") || "agent";
}

/** herdr's agent name for a run: short, unique per run, and readable in herdr's own UI. */
export function makeHerdrName(group: string, role: string, id: string): string {
  return slug(`${group.replace(/^fleet-/, "f")}-${slug(role, 12)}-${id.slice(0, 4)}`, 32);
}

/** Runs not touched for this long are dropped when the registry loads: their callers are long gone. */
export const STALE_RUN_MS = 7 * 24 * 3_600_000;

/**
 * Every run this server started, kept across restarts in one JSON file (0600). The last
 * turn's output and result are not kept in it: they are the bulk of a record, the file is
 * rewritten on every change, and herdr and the run's result file have them again.
 */
export class RunRegistry {
  private readonly runs = new Map<string, AgentRun>();

  constructor(readonly filePath: string | null, now = Date.now()) {
    if (!filePath) return;
    let stored: unknown;
    try { stored = JSON.parse(readFileSync(filePath, "utf8")); } catch { return; }
    if (!Array.isArray(stored)) return;
    for (const run of stored as AgentRun[]) {
      if (typeof run?.id !== "string" || typeof run.paneId !== "string") continue;
      if (now - (run.updatedAt ?? 0) > STALE_RUN_MS) continue;
      // a record from before writers named their model holds the CLI alone: its model's company is
      // told only where the CLI tells it (shared/model-company.ts), and otherwise no review counts
      if (Array.isArray(run.writers)) run.writers = (run.writers as unknown[]).map((writer) => (typeof writer === "string" ? { agent: writer as FleetAgentKind } : writer as Writer));
      this.runs.set(run.id, run);
    }
  }

  all(): AgentRun[] {
    return [...this.runs.values()];
  }

  get(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }

  byPane(paneId: string): AgentRun | undefined {
    return this.all().filter((run) => run.paneId === paneId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  /** A run by id, name, role, herdr name or pane, the newest first; within `group` when one is given. */
  resolve(target: string, group?: string): AgentRun | undefined {
    const lowered = target.toLowerCase();
    return this.all()
      .filter((r) => group === undefined || r.group === group)
      .filter((r) => [r.id, r.name, r.role, r.herdrName, r.paneId].some((key) => key.toLowerCase() === lowered))
      .sort((a, b) => b.startedAt - a.startedAt)[0];
  }

  upsert(run: AgentRun): void {
    this.runs.set(run.id, run);
    this.persist();
  }

  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const data = this.all().map(({ lastOutput: _output, result: _result, ...rest }) => rest);
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.filePath);
  }
}
