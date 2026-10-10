import { isAbsolute, relative, resolve } from "node:path";
import { FleetError } from "./runtime.ts";

/**
 * What an agent handing work on has to say about it. A helper cannot see its caller's
 * conversation, so a brief missing one of these leaves it to guess (pstack's orchestrate brief,
 * less what the fleet adds itself: the report shape and the standing orders).
 */
export interface Brief {
  /** the outcome, in one sentence */
  goal: string;
  /** the paths the helper may change, from its folder; none for work that only reads */
  write: string[];
  /** the files, earlier results and decisions it needs; "none" when it depends on nothing */
  context: string;
  /** a checkable condition for done */
  done: string;
  /** how to check it, and the evidence to return */
  verify: string;
  forbidden?: string;
  timebox?: string;
}

const REQUIRED = ["goal", "write", "context", "done", "verify"] as const;

/** The brief's fields, each present, or a FleetError that names every one missing. */
export function checkBrief(brief: Partial<Brief> | undefined): Brief {
  const missing = REQUIRED.filter((key) => key === "write" ? !Array.isArray(brief?.write) : !brief?.[key]?.trim());
  if (missing.length) {
    throw new FleetError("incomplete_brief", `An agent hands work on with a full brief; missing: ${missing.join(", ")}. Give --goal, --write <path> (or --read-only), --context (or "none"), --done and --verify.`);
  }
  return brief as Brief;
}

/** The brief as the helper's task. */
export function renderBrief(brief: Brief, note?: string): string {
  return [
    "## Goal", brief.goal.trim(),
    "## You may change", brief.write.length ? `${brief.write.map((path) => `- ${path}`).join("\n")}\nChange nothing outside these paths.` : "Nothing: this task only reads.",
    "## Context", brief.context.trim(),
    "## Done when", brief.done.trim(),
    "## Verify", brief.verify.trim(),
    ...(brief.forbidden?.trim() ? ["## Forbidden", brief.forbidden.trim()] : []),
    ...(brief.timebox?.trim() ? ["## Timebox", `${brief.timebox.trim()}. When it runs out, report what you have and stop.`] : []),
    ...(note?.trim() ? ["## Notes", note.trim()] : []),
  ].join("\n\n");
}

/** The write paths as absolute paths, so two runs in the same folder compare whatever they wrote. */
export function writeScope(cwd: string, write: string[]): string[] {
  return write.map((path) => resolve(cwd, path));
}

/** The first path of `a` that is, contains or lies within a path of `b`. */
export function overlap(a: string[], b: string[]): { mine: string; theirs: string } | undefined {
  const within = (inner: string, outer: string) => {
    const rel = relative(outer, inner);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  for (const mine of a) for (const theirs of b) if (within(mine, theirs) || within(theirs, mine)) return { mine, theirs };
  return undefined;
}
