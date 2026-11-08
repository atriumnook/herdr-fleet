/**
 * Who may merge a project's threads: its merge authority. Set per project in the person's own
 * fleet.json (`projects[<path>].merge`), never read from the repository, which would grant itself
 * merges (docs/002-authorization.md). `person`, the default, leaves every merge to the person;
 * `gated` lets the coordinator merge a thread that lands on a covered base branch on its own, only
 * when every condition of the gate holds, and otherwise leaves it to the person as `person` does.
 *
 * Pure: the orchestrator reads the facts (git and gh, github.ts) and hands them in.
 */
import type { ContractItem, FleetAgentKind, GateCheck, GateResult, MergeSetting, PullRequest, ReportState } from "../../shared/fleet.ts";

/** dsh-superagent's delivery rule: a change under 200 lines */
export const DEFAULT_MAX_LINES = 200;
const MAX_BRANCHES = 20;
const MAX_PROTECTED = 50;
const MAX_PATTERN_CHARS = 200;

/**
 * What a gated merge never touches, whatever the person lists: the gate itself and what enforces it
 * (its conditions, the reads they rest on, the orchestrator that evaluates them and hands the merge
 * on, where the setting is read and written, access control, the merge rules of the coordinator and
 * the lead, and the OpenCode guard and rules), the project's own fleet files (its roles and standing
 * orders tell the agents how to merge), and its CI, which a change could rewrite to pass its own checks.
 */
export const ALWAYS_PROTECTED: readonly string[] = [
  ".herdr-fleet/", ".github/",
  // herdr-fleet's own: the whole fleet server (the gate's reads, the runs' records it trusts, the
  // adapters that keep a role from editing), access control, the bundled roles and the OpenCode guard
  "server/fleet/", "server/access.ts", "agents/", "opencode/",
];

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isBranchName = (value: unknown): value is string => typeof value === "string" && /^[\w][\w./-]{0,199}$/.test(value) && !value.includes("..");
const isPattern = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.trim().length <= MAX_PATTERN_CHARS && !/[\n\r]/.test(value);

/**
 * A project's `merge` as the person wrote it, checked: what does not parse is the person mode, so
 * a broken entry never merges anything on its own.
 */
export function parseMergeSetting(value: unknown): MergeSetting | undefined {
  if (!isObject(value)) return undefined;
  if (value["mode"] !== "gated") return value["mode"] === "person" ? { mode: "person", branches: [], maxLines: DEFAULT_MAX_LINES, protected: [] } : undefined;
  const branches = Array.isArray(value["branches"]) ? [...new Set(value["branches"].filter(isBranchName))].slice(0, MAX_BRANCHES) : [];
  const maxLines = typeof value["maxLines"] === "number" && Number.isInteger(value["maxLines"]) && value["maxLines"] >= 1 ? value["maxLines"] : DEFAULT_MAX_LINES;
  const protectedPaths = Array.isArray(value["protected"]) ? [...new Set(value["protected"].filter(isPattern).map((each) => each.trim()))].slice(0, MAX_PROTECTED) : [];
  return { mode: "gated", branches, maxLines, protected: protectedPaths };
}

/** A setting from the Settings page, checked as strictly as the page promises; throws what is wrong. */
export function checkMergeSetting(value: unknown): MergeSetting {
  if (!isObject(value) || (value["mode"] !== "person" && value["mode"] !== "gated")) throw new Error("merge.mode must be person or gated");
  if (value["mode"] === "person") return { mode: "person", branches: [], maxLines: DEFAULT_MAX_LINES, protected: [] };
  const branches = value["branches"];
  if (!Array.isArray(branches) || branches.length > MAX_BRANCHES || !branches.every(isBranchName)) throw new Error(`merge.branches must list up to ${MAX_BRANCHES} branch names`);
  const maxLines = value["maxLines"] ?? DEFAULT_MAX_LINES;
  if (typeof maxLines !== "number" || !Number.isInteger(maxLines) || maxLines < 1 || maxLines > 100_000) throw new Error("merge.maxLines must be a whole number from 1 to 100000");
  const patterns = value["protected"] ?? [];
  if (!Array.isArray(patterns) || patterns.length > MAX_PROTECTED || !patterns.every(isPattern)) throw new Error(`merge.protected must list up to ${MAX_PROTECTED} paths or globs`);
  return { mode: "gated", branches: [...new Set(branches)], maxLines, protected: [...new Set(patterns.map((each: string) => each.trim()))] };
}

/** The setting as fleet.json holds it: the person mode is the absence of one. */
export function mergeEntry(setting: MergeSetting): Record<string, unknown> | undefined {
  return setting.mode === "gated" ? { mode: "gated", branches: setting.branches, maxLines: setting.maxLines, protected: setting.protected } : undefined;
}

export type MergeAuthority = { mode: "person" } | { mode: "gated"; maxLines: number; protected: string[] };

/** The authority over a merge into `baseBranch`: gated only when the person's setting names that branch. */
export function mergeAuthority(setting: MergeSetting | undefined, baseBranch: string): MergeAuthority {
  if (setting?.mode !== "gated" || !setting.branches.includes(baseBranch)) return { mode: "person" };
  return { mode: "gated", maxLines: setting.maxLines, protected: setting.protected };
}

/** What the fleet read about a thread for the gate, each from git, GitHub or its own records. */
export interface GateFacts {
  /** the state of the lead's latest report */
  report?: ReportState;
  contract: ContractItem[];
  /** the CLIs that wrote the change: every run of the thread that could edit files */
  writers: FleetAgentKind[];
  /** the thread's reviews by runs that could not edit: their CLI, the state of their latest report, and the commit the branch was at when it ended */
  reviews: Array<{ agent: FleetAgentKind; report?: ReportState; head?: string }>;
  /** the branch's latest commit here; null when git could not say */
  head: string | null;
  /** the base branch the thread lands on, under the gate */
  base: string;
  /** the pull request as GitHub has it: the commit its branch is at, the branch it targets, and whether its checks were read */
  pr?: Pick<PullRequest, "state" | "checks"> & { head?: string; base?: string; checksRead?: boolean };
  /**
   * what the pull request delivers, as GitHub compares its commit with the base branch there: lines
   * added and removed, the files they are in, and the commits the base has that it does not; null
   * when GitHub could not say
   */
  lines: number | null;
  files: string[] | null;
  behind: number | null;
}

/**
 * A pattern as the person writes it: a folder ending in `/` stands for itself and everything below
 * it, as does one ending in `/**` (a symlink in the folder's place is a change to the folder).
 */
function matches(pattern: string, file: string): boolean {
  const glob = new Bun.Glob(pattern.replace(/^\.\//, "").replace(/\/$/, "/**"));
  // the folder itself matches when something below it would, wildcards in its path included
  return glob.match(file) || (pattern.replace(/\/$/, "/**").endsWith("/**") && glob.match(`${file}/-`));
}

/** Every condition of the gate, each with what was found; the merge goes ahead only when all hold. */
export function evaluateGate(authority: Extract<MergeAuthority, { mode: "gated" }>, facts: GateFacts): GateResult {
  const contractMet = facts.contract.length > 0 && facts.contract.every((item) => item.state === "met");
  const writers = new Set(facts.writers);
  const passed = facts.reviews.filter((review) => !writers.has(review.agent) && review.report === "ready");
  const fresh = facts.head === null ? [] : passed.filter((review) => review.head === facts.head);
  const touched = facts.files?.filter((file) => [...ALWAYS_PROTECTED, ...authority.protected].some((pattern) => matches(pattern, file))) ?? [];
  const checks: GateCheck[] = [
    { id: "report", ok: facts.report === "ready", detail: facts.report === "ready" ? "The lead's latest report is ready." : `The lead's latest report is ${facts.report ?? "missing"}, not ready.` },
    {
      id: "review", ok: fresh.length > 0,
      detail: fresh.length ? `A review on ${fresh[0]!.agent} passed at the branch's latest commit.`
        : passed.length ? `The review on ${passed.map((each) => each.agent).join(", ")} was of another commit than the branch's latest.`
          : `No review on a CLI other than ${[...writers].join(", ") || "the writer's"} passed.`,
    },
    checksCondition(facts.pr, facts.head, facts.base, facts.report === "ready" && contractMet),
    {
      id: "size", ok: facts.lines !== null && facts.lines <= authority.maxLines,
      detail: facts.lines === null ? "GitHub could not count the pull request's lines." : `The change has ${facts.lines} lines${facts.lines <= authority.maxLines ? "," : ", over"} the limit of ${authority.maxLines}.`,
    },
    {
      id: "paths", ok: facts.files !== null && touched.length === 0,
      detail: facts.files === null ? "GitHub could not list the pull request's files." : touched.length ? `It touches protected paths: ${touched.slice(0, 5).join(", ")}${touched.length > 5 ? ", …" : ""}.` : "It touches no protected path.",
    },
    {
      id: "fresh", ok: facts.behind === 0,
      detail: facts.behind === null ? "GitHub could not say whether the branch has the base branch's latest commits." : facts.behind === 0 ? "The branch has the base branch's latest commits." : `The branch is ${facts.behind} commit${facts.behind === 1 ? "" : "s"} behind the base branch.`,
    },
  ];
  return { ok: checks.every((check) => check.ok), checks };
}

function checksCondition(pr: GateFacts["pr"], head: string | null, base: string, recordedPassed: boolean): GateCheck {
  if (pr?.state !== "OPEN") return { id: "checks", ok: false, detail: "The thread has no open pull request." };
  if (pr.base !== base) return { id: "checks", ok: false, detail: `The pull request targets ${pr.base ?? "a branch GitHub did not name"}, not ${base}.` };
  // what is merged is the pull request's commit: what was measured here must be that commit
  if (!head || pr.head !== head) return { id: "checks", ok: false, detail: "The pull request is not at the branch's latest commit here: it has commits that are not pushed, or GitHub has others." };
  if (pr.checks === "pass") return { id: "checks", ok: true, detail: "The pull request's checks passed." };
  if (pr.checks === "none" && !pr.checksRead) return { id: "checks", ok: false, detail: "GitHub could not say which checks the pull request has." };
  if (pr.checks === "none") return { id: "checks", ok: recordedPassed, detail: recordedPassed ? "The pull request has no checks, and the lead's contract is met." : "The pull request has no checks, and the lead's contract is not met." };
  return { id: "checks", ok: false, detail: `The pull request's checks are ${pr.checks === "fail" ? "failing" : "still running"}.` };
}

/** The gate's result in lines, for the coordinator's message and the pull request's record. */
export function gateLines(result: GateResult): string[] {
  return result.checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.detail}`);
}
