#!/usr/bin/env bun
/**
 * A Claude Code statusLine command that keeps the session's `rate_limits` for the fleet, then hands
 * the same input to the statusLine command it wraps, if any, whose output is what Claude Code shows.
 *
 *   claude-statusline-tap.ts <file> [command args...]
 *
 * The fleet sets it on the Claude Code sessions it starts; a person can put it in front of their own
 * statusLine so their sessions keep the reading fresh too. Nothing it fails at stops the display.
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function tap(input: string, file: string, now = Date.now()): void {
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { return; }
  const limits = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)["rate_limits"] : undefined;
  // API-key and third-party sessions have none: an older reading from a subscription stays
  if (!limits || typeof limits !== "object") return;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ rate_limits: limits, writtenAt: now }), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

if (import.meta.main) {
  const [file, ...command] = process.argv.slice(2);
  const input = await new Response(Bun.stdin.stream()).text();
  if (file) try { tap(input, file); } catch { /* the display goes on */ }
  if (command.length) {
    const child = Bun.spawn(command, { stdin: new TextEncoder().encode(input), stdout: "inherit", stderr: "inherit" });
    process.exitCode = await child.exited;
  }
}
