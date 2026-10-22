import { readFileSync } from "node:fs";

/**
 * When a process started, in ms since the epoch: Linux counts it in /proc (USER_HZ
 * ticks after boot). null where that is not readable, as on macOS.
 */
export function processStartedAt(pid: number): number | null {
  try {
    const ticks = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]);
    const boot = Number(readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1]);
    return Number.isFinite(ticks) && Number.isFinite(boot) ? boot * 1000 + ticks * 10 : null;
  } catch {
    return null;
  }
}

/** An upper bound for comparing a new thread's timestamp, without btime's whole-second loss. */
export function processStartUpperBound(pid: number): number | null {
  if (process.platform !== "linux") {
    const started = processStartedAt(pid);
    return started === null ? null : started + 1000;
  }
  try {
    const ticks = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]);
    const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    // uptime and start ticks truncate to 10ms. Reading the wall clock last and adding
    // one tick bounds the process start from above, rather than admitting older threads.
    return Number.isFinite(ticks) && Number.isFinite(uptime) ? Date.now() - uptime * 1000 + ticks * 10 + 10 : null;
  } catch { return null; }
}
