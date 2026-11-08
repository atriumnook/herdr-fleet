import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReport, REPORT_MAX_BYTES } from "./report.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function folder(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-report-"));
  roots.push(dir);
  if (content !== undefined) writeFileSync(join(dir, "report.json"), content);
  return dir;
}

describe("report.json", () => {
  it("is read as the turn's report: its state, summary, evidence and the question for the person", () => {
    const dir = folder(JSON.stringify({ state: "blocked", summary: "Keep the old retry API?", evidence: ["bun test: 12 pass"], human_action: "Keep the old retry API, or drop it?" }));
    expect(readReport(dir)).toEqual({ report: { state: "blocked", summary: "Keep the old retry API?", evidence: ["bun test: 12 pass"], human_action: "Keep the old retry API, or drop it?" } });
  });

  it("takes evidence written as one string, and no question when there is none", () => {
    expect(readReport(folder(JSON.stringify({ state: "ready", summary: "Fixed.", evidence: "bun test: 3 pass", human_action: null }))))
      .toEqual({ report: { state: "ready", summary: "Fixed.", evidence: ["bun test: 3 pass"] } });
    expect(readReport(folder(JSON.stringify({ state: "dropped", summary: "Does not reproduce.", evidence: [] }))))
      .toEqual({ report: { state: "dropped", summary: "Does not reproduce.", evidence: [] } });
  });

  it("is no report, with why, when it is missing or does not say a known state, a summary and evidence", () => {
    expect(readReport(folder())).toEqual({ report: null, problem: "report.json is missing." });
    expect(readReport(folder("PASS — all good"))).toEqual({ report: null, problem: "report.json is not JSON." });
    expect(readReport(folder("[]"))).toEqual({ report: null, problem: "report.json is not a JSON object." });
    expect(readReport(folder(JSON.stringify({ state: "PASS", summary: "s", evidence: [] }))))
      .toEqual({ report: null, problem: 'report.json has state "PASS"; it must be one of progress, waiting, ready, blocked, failed, dropped.' });
    expect(readReport(folder(JSON.stringify({ state: "ready", summary: " ", evidence: [] })))).toEqual({ report: null, problem: "report.json has no summary." });
    expect(readReport(folder(JSON.stringify({ state: "ready", summary: "s" })))).toEqual({ report: null, problem: "report.json has no evidence: a string or a list of strings." });
    expect(readReport(folder(JSON.stringify({ state: "ready", summary: "s", evidence: [1] })))).toEqual({ report: null, problem: "report.json has no evidence: a string or a list of strings." });
    expect(readReport(folder(JSON.stringify({ state: "blocked", summary: "s", evidence: [], human_action: 3 })))).toEqual({ report: null, problem: "report.json has a human_action that is not a string." });
  });

  it("is never read through a symlink, nor past its size limit", () => {
    const dir = folder();
    const secret = join(dir, "secret.json");
    writeFileSync(secret, JSON.stringify({ state: "ready", summary: "s", evidence: [] }));
    symlinkSync(secret, join(dir, "report.json"));
    expect(readReport(dir)).toEqual({ report: null, problem: "report.json is not a regular file." });
    const big = folder(JSON.stringify({ state: "ready", summary: "x".repeat(REPORT_MAX_BYTES), evidence: [] }));
    expect(readReport(big)).toEqual({ report: null, problem: `report.json is larger than ${REPORT_MAX_BYTES} bytes.` });
  });
});
