import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProbe, parseAgyUsage, parseClaudeUsage, parseCodexRateLimits, rateLimitUntil, usageKey, UsageTracker, type UsageReading } from "./usage.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tempDir = () => { const root = mkdtempSync(join(tmpdir(), "fleet-usage-")); roots.push(root); return root; };

const NOW = Date.parse("2026-10-04T07:00:00Z");
const HOUR = 3_600_000;

describe("usageKey", () => {
  it("splits agy by model group and pi by provider; the other CLIs are one account each", () => {
    expect(usageKey("codex", "gpt-6")).toBe("codex");
    expect(usageKey("claude")).toBe("claude");
    expect(usageKey("agy", "gemini-3.8-flash-low")).toBe("agy:gemini");
    expect(usageKey("agy")).toBe("agy:gemini");
    expect(usageKey("agy", "claude-sonnet-5-5")).toBe("agy:3p");
    expect(usageKey("pi", "opencode-go/space-bunny-free")).toBe("pi:opencode-go");
    expect(usageKey("pi")).toBe("pi");
  });
});

describe("readings", () => {
  it("reads codex app-server's primary and secondary windows (codex-cli 0.157.0)", () => {
    const result = {
      ordinaryUsageAllowed: true,
      rateLimits: {
        limitId: "codex", primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1791103555 },
        secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1791648524 }, planType: "plus", rateLimitReachedType: null,
      },
    };
    expect(parseCodexRateLimits(result, NOW)).toEqual({
      readAt: NOW,
      windows: [{ name: "5h", usedPercent: 12, resetsAt: 1791103555000 }, { name: "weekly", usedPercent: 40, resetsAt: 1791648524000 }],
    });
    expect(parseCodexRateLimits({}, NOW)).toBeUndefined();
  });

  it("reads agy's /usage buckets per model group as used shares (agy 1.2.16)", () => {
    const output = {
      status: "SUCCESS", usage: { total_tokens: 0 },
      command: { name: "usage", data: { groups: [
        { name: "Gemini Models", buckets: [
          { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.75, reset_time: "2026-10-11T03:46:16Z" },
          { id: "gemini-5h", window: "5h", remaining_fraction: 0.05, reset_time: "2026-10-04T08:46:16Z" },
        ] },
        { name: "Claude and GPT models", buckets: [{ id: "3p-5h", window: "5h", remaining_fraction: 1, reset_time: "2026-10-04T12:37:27Z" }] },
      ] } },
    };
    expect(parseAgyUsage(output, NOW)).toEqual({
      "agy:gemini": { readAt: NOW, windows: [
        { name: "weekly", usedPercent: 25, resetsAt: Date.parse("2026-10-11T03:46:16Z") },
        { name: "5h", usedPercent: 95, resetsAt: Date.parse("2026-10-04T08:46:16Z") },
      ] },
      "agy:3p": { readAt: NOW, windows: [{ name: "5h", usedPercent: 0, resetsAt: Date.parse("2026-10-04T12:37:27Z") }] },
    });
    expect(parseAgyUsage({ status: "ERROR" }, NOW)).toEqual({});
  });

  // claude -p /usage --output-format json, `result` as Claude Code 2.1.289 printed it (no model turn, 0 tokens)
  const CLAUDE_USAGE = [
    "You are currently using your subscription to power your Claude Code usage",
    "",
    "Current session: 7% used · resets Oct 4, 9:50pm (Asia/Tokyo)",
    "Current week (all models): 27% used · resets Oct 8, 12am (Asia/Tokyo)",
    "Current week (Fable): 95% used · resets Oct 8, 12am (Asia/Tokyo)",
    "",
    "What's contributing to your limits usage?",
    "Last 24h · 1285 requests · 14 sessions",
    "  90% of your usage was at >150k context",
  ].join("\n");

  it("reads Claude Code's /usage: the shared windows, not a per-model one, with their reset in the named zone", () => {
    expect(parseClaudeUsage(CLAUDE_USAGE, NOW)).toEqual({ readAt: NOW, windows: [
      { name: "5h", usedPercent: 7, resetsAt: Date.parse("2026-10-04T12:50:00Z") },
      { name: "weekly", usedPercent: 27, resetsAt: Date.parse("2026-10-07T15:00:00Z") },
    ] });
  });

  it("takes a reset with no year as the next one, keeps a window whose reset it cannot read, and reads nothing from an API-key session", () => {
    const newYear = parseClaudeUsage("Current session: 50% used · resets Jan 1, 9am (UTC)", Date.parse("2026-12-31T20:00:00Z"));
    expect(newYear!.windows).toEqual([{ name: "5h", usedPercent: 50, resetsAt: Date.parse("2027-01-01T09:00:00Z") }]);
    expect(parseClaudeUsage("Current session: 3% used · resets soon (Mars/Base)", NOW)!.windows).toEqual([{ name: "5h", usedPercent: 3 }]);
    expect(parseClaudeUsage("You are currently using an API key", NOW)).toBeUndefined();
  });

  it("asks claude for /usage without keeping a session or loading the person's settings, and fails on an error answer", async () => {
    const dir = tempDir();
    const fake = (name: string, answer: unknown) => {
      const file = join(dir, name);
      writeFileSync(file, `#!/bin/sh\necho "$@" > "${file}.args"\ncat <<'JSON'\n${JSON.stringify(answer)}\nJSON\n`, { mode: 0o755 });
      return file;
    };
    const ok = fake("claude-ok", { is_error: false, num_turns: 0, result: CLAUDE_USAGE });
    const readings = await claudeProbe(ok)();
    expect(readings["claude"]!.windows.map((w) => [w.name, w.usedPercent])).toEqual([["5h", 7], ["weekly", 27]]);
    expect(readFileSync(`${ok}.args`, "utf8").trim()).toBe("-p /usage --no-session-persistence --setting-sources project --output-format json");
    await expect(claudeProbe(fake("claude-error", { is_error: true, result: "Not logged in" }))()).rejects.toThrow("/usage gave no answer");
  });
});

describe("rateLimitUntil", () => {
  it("is null for other failures and undefined for a rate limit that names no time", () => {
    expect(rateLimitUntil("model not found", NOW)).toBeNull();
    expect(rateLimitUntil("429 Too Many Requests", NOW)).toBeUndefined();
    expect(rateLimitUntil("You've hit your usage limit.", NOW)).toBeUndefined();
  });

  it("takes an ISO time, a relative one or the next clock time", () => {
    expect(rateLimitUntil("rate limit exceeded; resets 2026-10-04T09:30:00Z", NOW)).toBe(Date.parse("2026-10-04T09:30:00Z"));
    expect(rateLimitUntil("Rate limit reached. Try again in 2h 5m.", NOW)).toBe(NOW + 2 * HOUR + 5 * 60_000);
    expect(rateLimitUntil("quota exhausted, retry in 30 minutes", NOW)).toBe(NOW + 30 * 60_000);
    const clock = rateLimitUntil("usage limit reached, try again at 3:45 PM", NOW)!;
    const at = new Date(clock);
    expect([at.getHours(), at.getMinutes()]).toEqual([15, 45]);
    expect(clock).toBeGreaterThan(NOW);
    expect(clock - NOW).toBeLessThanOrEqual(24 * HOUR);
  });
});

describe("UsageTracker", () => {
  const reading = (usedPercent: number, resetsAt?: number): UsageReading => ({ readAt: NOW, windows: [{ name: "5h", usedPercent, ...(resetsAt ? { resetsAt } : {}) }] });

  it("refuses a candidate whose window is at the threshold until that window resets", async () => {
    let now = NOW;
    const usage = new UsageTracker({ file: null, now: () => now });
    usage.record("codex", reading(90, NOW + HOUR));
    expect(await usage.unavailable("codex", "gpt-6", 90)).toContain("codex has used 90% of its 5h limit");
    expect(await usage.unavailable("codex", "gpt-6", 95)).toBeUndefined();
    now = NOW + HOUR + 1;
    expect(await usage.unavailable("codex", "gpt-6", 90)).toBeUndefined();
    // nothing known is no reason to refuse
    expect(await usage.unavailable("claude", undefined, 90)).toBeUndefined();
  });

  it("counts a window read without its reset time for a day only", async () => {
    let now = NOW;
    const usage = new UsageTracker({ file: null, now: () => now });
    usage.record("cursor", reading(95));
    expect(await usage.unavailable("cursor", undefined, 90)).toContain("95%");
    now = NOW + 24 * HOUR;
    expect(await usage.unavailable("cursor", undefined, 90)).toBeUndefined();
  });

  it("cools an account down on a rate limit, for the time named, else a full window's reset, else the default", async () => {
    let now = NOW;
    const usage = new UsageTracker({ file: null, now: () => now });
    expect(usage.noteFailure("cursor", undefined, "Error: model not found", 60)).toBe(false);
    expect(usage.noteFailure("cursor", undefined, "Error: rate limit exceeded", 60)).toBe(true);
    expect(await usage.unavailable("cursor", "gpt", 90)).toContain("cursor is cooling down until 2026-10-04T08:00:00.000Z");
    usage.record("codex", reading(100, NOW + 3 * HOUR));
    usage.noteFailure("codex", undefined, "You've hit your usage limit", 60);
    expect(usage.list().find((e) => e.key === "codex")!.cooldown!.until).toBe(NOW + 3 * HOUR);
    usage.noteFailure("agy", "gemini-pro", "RESOURCE_EXHAUSTED, retry in 10m", 60);
    expect(usage.list().find((e) => e.key === "agy:gemini")!.cooldown!.until).toBe(NOW + 10 * 60_000);
    now = NOW + HOUR;
    expect(await usage.unavailable("cursor", "gpt", 90)).toBeUndefined();
  });

  it("clears one account's cooldown, a CLI's or all", () => {
    const usage = new UsageTracker({ file: null, now: () => NOW });
    for (const model of ["gemini-pro", "claude-sonnet"]) usage.noteFailure("agy", model, "rate limit", 60);
    usage.noteFailure("cursor", undefined, "rate limit", 60);
    expect(usage.clearCooldown("agy:3p")).toEqual(["agy:3p"]);
    expect(usage.clearCooldown("agy")).toEqual(["agy:gemini"]);
    expect(usage.clearCooldown()).toEqual(["cursor"]);
    expect(usage.clearCooldown()).toEqual([]);
  });

  it("asks a probe once per TTL, keeps the last reading when it fails, and survives a restart", async () => {
    const file = join(tempDir(), "fleet-usage.json");
    let now = NOW;
    let calls = 0;
    let fail = false;
    const probes = { codex: async () => { calls += 1; if (fail) throw new Error("codex exited with 1"); return { codex: reading(50) }; } };
    const usage = new UsageTracker({ file, probes, probeTtlMs: 60_000, now: () => now });
    await Promise.all([usage.unavailable("codex", undefined, 90), usage.unavailable("codex", undefined, 90)]);
    await usage.unavailable("codex", undefined, 90);
    expect(calls).toBe(1);
    now += 60_000;
    fail = true;
    expect(await usage.unavailable("codex", undefined, 90)).toBeUndefined();
    expect(calls).toBe(2);
    expect(usage.list().find((e) => e.key === "codex")).toMatchObject({ error: "codex exited with 1", reading: reading(50) });
    await usage.refresh(true);
    expect(calls).toBe(3);
    usage.noteFailure("cursor", undefined, "rate limit", 60);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const restarted = new UsageTracker({ file, now: () => now });
    expect(await restarted.unavailable("cursor", undefined, 90)).toContain("cooling down");
    expect(restarted.list().find((e) => e.key === "codex")!.reading).toEqual(reading(50));
  });

  it("has cursor's screen read only when neither its last reading nor its last try is recent", () => {
    let now = NOW;
    const usage = new UsageTracker({ file: null, now: () => now });
    expect(usage.claimScreen("cursor")).toBe(true);
    // the try found nothing: the next turn does not pay for another one yet
    expect(usage.claimScreen("cursor")).toBe(false);
    now += 10 * 60_000;
    usage.record("cursor", { readAt: now, windows: [] });
    expect(usage.claimScreen("cursor")).toBe(false);
    now += 10 * 60_000;
    expect(usage.claimScreen("cursor")).toBe(true);
  });

  it("gives up on a probe that never answers, so spawns go on", async () => {
    const usage = new UsageTracker({ file: null, probeTimeoutMs: 20, probes: { agy: () => new Promise(() => {}) } });
    expect(await usage.unavailable("agy", "gemini-pro", 90)).toBeUndefined();
    expect(usage.list()).toEqual([{ key: "agy", error: "agy did not answer within 0.02s" }]);
  });

  it("replaces what it knew of a CLI with what the probe answers, clearing an earlier failure but not a cooldown", async () => {
    let answer: Record<string, UsageReading> | Error = new Error("agy exited with 1");
    const usage = new UsageTracker({ file: null, probeTtlMs: 0, probes: { agy: async () => { if (answer instanceof Error) throw answer; return answer; } } });
    await usage.refresh();
    expect(usage.list()).toEqual([{ key: "agy", error: "agy exited with 1" }]);
    answer = { "agy:gemini": reading(10), "agy:3p": reading(20) };
    await usage.refresh();
    expect(usage.list().map((e) => e.key)).toEqual(["agy:3p", "agy:gemini"]);
    answer = new Error("agy exited with 2");
    await usage.refresh();
    expect(usage.list().map((e) => [e.key, e.error])).toEqual([["agy:3p", "agy exited with 2"], ["agy:gemini", "agy exited with 2"]]);
    usage.noteFailure("agy", "claude-sonnet", "rate limit", 60);
    answer = { "agy:gemini": reading(30) };
    await usage.refresh();
    expect(usage.list()).toEqual([
      { key: "agy:3p", cooldown: expect.objectContaining({ reason: "rate limit" }) },
      { key: "agy:gemini", reading: reading(30) },
    ]);
  });

  it("drops what a stored file holds in a shape it cannot read", async () => {
    const file = join(tempDir(), "fleet-usage.json");
    writeFileSync(file, "{\"not\":\"a list\"}");
    expect(new UsageTracker({ file }).list()).toEqual([]);
    writeFileSync(file, JSON.stringify([{ key: "codex", reading: { readAt: 1 } }, { key: "claude", reading: reading(95), cooldown: { until: "soon" } }, { nokey: true }]));
    const usage = new UsageTracker({ file, now: () => NOW });
    expect(usage.list()).toEqual([{ key: "claude", reading: reading(95) }, { key: "codex" }]);
    expect(await usage.unavailable("codex", undefined, 90)).toBeUndefined();
    expect(await usage.unavailable("claude", undefined, 90)).toContain("95%");
  });

  it("still notes a cooldown when its file cannot be written", () => {
    const root = tempDir();
    writeFileSync(join(root, "blocker"), "");
    const usage = new UsageTracker({ file: join(root, "blocker", "fleet-usage.json"), now: () => NOW });
    expect(usage.noteFailure("cursor", undefined, "rate limit", 60)).toBe(true);
    expect(usage.list()[0]!.cooldown).toBeDefined();
  });
});
