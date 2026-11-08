/**
 * An agent's report of a turn: `report.json` beside its handoff in the run's result folder. The
 * fleet takes a turn's outcome from this file alone: a turn that left none, or one that does not
 * say a known state, a summary and evidence, has the outcome "no report", whatever the agent's
 * prose or screen says. A file rather than a fleet command, because agy's sandbox runs no fleet
 * command. The states follow dsh-superagent's Report (docs/001-domain.md).
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { REPORT_STATES, type ReportState, type RunReport, type TurnOutcome } from "../../shared/fleet.ts";

export const REPORT_FILE = "report.json";
/** a report is a few sentences: more than this is not one */
export const REPORT_MAX_BYTES = 16 * 1024;

/** The report in `dir`, read only from a regular file (never through a symlink), or why there is none. */
export function readReport(dir: string): TurnOutcome {
  const none = (problem: string): TurnOutcome => ({ report: null, problem: `${REPORT_FILE} ${problem}.` });
  let fd: number;
  try {
    fd = openSync(join(dir, REPORT_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return none((error as NodeJS.ErrnoException).code === "ENOENT" ? "is missing" : (error as NodeJS.ErrnoException).code === "ELOOP" ? "is not a regular file" : "cannot be read");
  }
  let text: string;
  try {
    if (!fstatSync(fd).isFile()) return none("is not a regular file");
    const buffer = Buffer.alloc(REPORT_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > REPORT_MAX_BYTES) return none(`is larger than ${REPORT_MAX_BYTES} bytes`);
    text = buffer.subarray(0, length).toString("utf8");
  } catch {
    return none("cannot be read");
  } finally {
    closeSync(fd);
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return none("is not JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return none("is not a JSON object");
  const fields = value as Record<string, unknown>;
  if (!(REPORT_STATES as readonly unknown[]).includes(fields["state"])) return none(`has state ${JSON.stringify(fields["state"] ?? null)}; it must be one of ${REPORT_STATES.join(", ")}`);
  const summary = typeof fields["summary"] === "string" ? fields["summary"].trim() : "";
  if (!summary) return none("has no summary");
  const evidence = typeof fields["evidence"] === "string" ? [fields["evidence"]] : fields["evidence"];
  if (!Array.isArray(evidence) || evidence.some((item) => typeof item !== "string")) return none("has no evidence: a string or a list of strings");
  const action = fields["human_action"];
  if (action !== undefined && action !== null && typeof action !== "string") return none("has a human_action that is not a string");
  const human = typeof action === "string" ? action.trim() : "";
  const report: RunReport = { state: fields["state"] as ReportState, summary, evidence: evidence as string[], ...(human ? { human_action: human } : {}) };
  return { report };
}
