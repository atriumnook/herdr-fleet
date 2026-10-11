/**
 * A thread lead's plan: a tree of claims the person reads level by level and answers in place,
 * before the lead builds a large change. The lead hands it over as JSON (`fleet plan <file>`); the
 * server checks it with parsePlan, reads the code it points at, and keeps it in a folder of its
 * own, outside the lead's result folder, checking it again each time it reads it. The Fleet screen draws it and sends the person's answers back to the lead as one
 * message. The shape follows html-plan's idea (a claim per level: what, how, where; one exhibit
 * per claim; a decision on the claim it changes), drawn by the Web UI instead of the agent's HTML.
 */

/** A plan as the lead writes it and the server keeps it. */
export interface Plan {
  /** counts the plans this thread's lead handed over: answers name the one they answer */
  version: number;
  /** when the server took it (epoch ms) */
  writtenAt: number;
  /** the change and the place, in a few words */
  title: string;
  /** the person's own words that asked for it */
  why: string[];
  /** what someone can now do or see, each with how it works and where */
  claims: PlanClaim[];
  /** what the claims share, such as one new table */
  shared?: { text: string; exhibit?: PlanExhibit };
  /** what the change leaves alone */
  scope: string[];
  /** when the person answered this version (epoch ms), and what they answered */
  answeredAt?: number;
  answer?: PlanAnswer;
  /** when the lead went on to another turn without the answers, which closed this version (epoch ms) */
  closedAt?: number;
}

/** One claim: a sentence that can be true or false (a place at the third level), its exhibit, a decision on it, and the claims under it. */
export interface PlanClaim {
  text: string;
  exhibit?: PlanExhibit;
  ask?: PlanAsk;
  children: PlanClaim[];
}

/**
 * What proves a claim. `code` names lines of a file in the thread's worktree, which the server
 * reads into `lines`; with `text` it is code the lead proposes, shown as written.
 */
export type PlanExhibit =
  | { kind: "code"; path: string; start?: number; end?: number; lang?: string; text?: string; lines?: string[] }
  | { kind: "schema"; lang?: string; text: string }
  | { kind: "calls"; rows: Array<{ depth: number; text: string; at?: string }> }
  | { kind: "list"; items: string[] };

/** A decision for the person, with the option the lead recommends. */
export interface PlanAsk {
  id: string;
  question: string;
  options: Array<{ value: string; label: string; note?: string }>;
  recommended: string;
}

/** The person's answers to one version of a plan. */
export interface PlanAnswer {
  version: number;
  /** the option picked for each decision, by its id */
  choices: Record<string, string>;
  /** the decisions the person looked at: the others keep the lead's recommendation, unopened */
  seen: string[];
  /** comments on claims, by the claim's number (1, 1.2, 1.2.1, shared) */
  comments: Array<{ claim: string; text: string }>;
  note?: string;
}

/** What a run keeps of its plan, so the thread list can say a plan waits without reading it. */
export interface PlanMark {
  version: number;
  asks: number;
  answeredAt?: number;
  closedAt?: number;
}

/** A plan still takes answers: none were sent, and the lead has not gone on without them. */
export function planOpen(plan: Pick<PlanMark, "answeredAt" | "closedAt">): boolean {
  return plan.answeredAt === undefined && plan.closedAt === undefined;
}

export const PLAN_LIMITS = {
  title: 120, why: 5, quote: 600, claims: 5, depth: 3, text: 300, asks: 5, options: 5, codeLines: 60, codeLine: 480,
  schema: 4000, rows: 30, items: 12, scope: 8, comments: 50, comment: 2000, note: 4000,
} as const;

/** The plan as the lead wrote it, before the server reads its code and numbers its version. */
export type PlanInput = Omit<Plan, "version" | "writtenAt" | "answeredAt" | "answer" | "closedAt">;

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/**
 * Checks a plan the lead wrote and answers it in the shape the fleet keeps, or every problem found,
 * so the lead fixes them all at once. Unknown keys are left out. `stored`: a plan the server kept,
 * read back, whose code exhibits hold the lines it read.
 */
export function parsePlan(value: unknown, options: { stored?: boolean } = {}): { plan: PlanInput } | { errors: string[] } {
  const errors: string[] = [];
  const asks = new Set<string>();
  const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const text = (v: unknown, where: string, max: number, required = true): string | undefined => {
    if (v === undefined || v === null) {
      if (required) errors.push(`${where} is required`);
      return undefined;
    }
    if (typeof v !== "string" || !v.trim()) { errors.push(`${where} must be a non-empty string`); return undefined; }
    if (v.length > max) { errors.push(`${where} is longer than ${max} characters`); return undefined; }
    return v.trim();
  };
  const texts = (v: unknown, where: string, count: number, max: number): string[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) { errors.push(`${where} must be a list of strings`); return []; }
    if (v.length > count) errors.push(`${where} has more than ${count} entries`);
    return v.slice(0, count).flatMap((each, index) => text(each, `${where}[${index}]`, max) ?? []);
  };
  const line = (v: unknown, where: string): number | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) { errors.push(`${where} must be a line number from 1`); return undefined; }
    return v;
  };

  const exhibit = (v: unknown, where: string): PlanExhibit | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!object(v)) { errors.push(`${where} must be an object`); return undefined; }
    switch (v["kind"]) {
      case "code": {
        const path = text(v["path"], `${where}.path`, 500);
        const code = text(v["text"], `${where}.text`, PLAN_LIMITS.schema, false);
        const lang = text(v["lang"], `${where}.lang`, 20, false);
        const start = line(v["start"], `${where}.start`);
        const end = line(v["end"], `${where}.end`) ?? start;
        if (code === undefined) {
          if (start === undefined) errors.push(`${where} needs start (and end) to show lines of ${path ?? "the file"}, or text for code it proposes`);
          else if (end !== undefined && (end < start || end - start + 1 > PLAN_LIMITS.codeLines)) errors.push(`${where} must show 1 to ${PLAN_LIMITS.codeLines} lines`);
        }
        const read = v["lines"];
        let lines: string[] | undefined;
        if (options.stored && read !== undefined) {
          if (!Array.isArray(read) || read.length > PLAN_LIMITS.codeLines || !read.every((each) => typeof each === "string" && each.length <= PLAN_LIMITS.codeLine)) errors.push(`${where}.lines must be up to ${PLAN_LIMITS.codeLines} lines`);
          else lines = read as string[];
        }
        if (!path) return undefined;
        return { kind: "code", path, ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}), ...(lang ? { lang } : {}), ...(code !== undefined ? { text: code } : {}), ...(lines ? { lines } : {}) };
      }
      case "schema": {
        const body = text(v["text"], `${where}.text`, PLAN_LIMITS.schema);
        const lang = text(v["lang"], `${where}.lang`, 20, false);
        return body === undefined ? undefined : { kind: "schema", text: body, ...(lang ? { lang } : {}) };
      }
      case "calls": {
        const rows = v["rows"];
        if (!Array.isArray(rows) || rows.length === 0) { errors.push(`${where}.rows must be a non-empty list`); return undefined; }
        if (rows.length > PLAN_LIMITS.rows) errors.push(`${where}.rows has more than ${PLAN_LIMITS.rows} rows`);
        return {
          kind: "calls", rows: rows.slice(0, PLAN_LIMITS.rows).flatMap((row, index) => {
            const at = `${where}.rows[${index}]`;
            if (!object(row)) { errors.push(`${at} must be an object`); return []; }
            const depth = row["depth"] ?? 0;
            if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0 || depth > 5) errors.push(`${at}.depth must be 0 to 5`);
            const body = text(row["text"], `${at}.text`, 200);
            const place = text(row["at"], `${at}.at`, 500, false);
            return body === undefined ? [] : [{ depth: typeof depth === "number" ? Math.max(0, Math.min(5, Math.trunc(depth))) : 0, text: body, ...(place ? { at: place } : {}) }];
          }),
        };
      }
      case "list": {
        const items = texts(v["items"], `${where}.items`, PLAN_LIMITS.items, PLAN_LIMITS.text);
        if (items.length === 0) errors.push(`${where}.items must be a non-empty list`);
        return { kind: "list", items };
      }
      default:
        errors.push(`${where}.kind must be code, schema, calls or list`);
        return undefined;
    }
  };

  const ask = (v: unknown, where: string): PlanAsk | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!object(v)) { errors.push(`${where} must be an object`); return undefined; }
    const id = v["id"];
    if (typeof id !== "string" || !ID.test(id)) errors.push(`${where}.id must be letters, digits, - and _ (up to 32)`);
    else if (asks.has(id)) errors.push(`${where}.id ${id} is used twice`);
    else asks.add(id);
    const question = text(v["question"], `${where}.question`, PLAN_LIMITS.text);
    const options = v["options"];
    if (!Array.isArray(options) || options.length < 2 || options.length > PLAN_LIMITS.options) { errors.push(`${where}.options must hold 2 to ${PLAN_LIMITS.options} options`); return undefined; }
    const values = new Set<string>();
    const parsed = options.flatMap((option, index) => {
      const at = `${where}.options[${index}]`;
      if (!object(option)) { errors.push(`${at} must be an object`); return []; }
      const optionValue = option["value"];
      if (typeof optionValue !== "string" || !ID.test(optionValue)) { errors.push(`${at}.value must be letters, digits, - and _ (up to 32)`); return []; }
      if (values.has(optionValue)) errors.push(`${at}.value ${optionValue} is used twice`);
      values.add(optionValue);
      const label = text(option["label"], `${at}.label`, PLAN_LIMITS.title);
      const note = text(option["note"], `${at}.note`, PLAN_LIMITS.text, false);
      return label === undefined ? [] : [{ value: optionValue, label, ...(note ? { note } : {}) }];
    });
    const recommended = v["recommended"];
    if (typeof recommended !== "string" || !values.has(recommended)) errors.push(`${where}.recommended must be one of its options' values`);
    if (typeof id !== "string" || question === undefined || typeof recommended !== "string") return undefined;
    return { id, question, options: parsed, recommended };
  };

  const claims = (v: unknown, where: string, depth: number): PlanClaim[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) { errors.push(`${where} must be a list of claims`); return []; }
    if (depth > PLAN_LIMITS.depth && v.length > 0) { errors.push(`${where}: a plan has at most ${PLAN_LIMITS.depth} levels`); return []; }
    if (v.length > PLAN_LIMITS.claims) errors.push(`${where} has more than ${PLAN_LIMITS.claims} claims`);
    return v.slice(0, PLAN_LIMITS.claims).flatMap((claim, index) => {
      const at = `${where}[${index}]`;
      if (!object(claim)) { errors.push(`${at} must be an object`); return []; }
      const body = text(claim["text"], `${at}.text`, PLAN_LIMITS.text);
      const shown = exhibit(claim["exhibit"], `${at}.exhibit`);
      const asked = ask(claim["ask"], `${at}.ask`);
      const children = claims(claim["children"], `${at}.children`, depth + 1);
      return body === undefined ? [] : [{ text: body, ...(shown ? { exhibit: shown } : {}), ...(asked ? { ask: asked } : {}), children }];
    });
  };

  if (!object(value)) return { errors: ["the plan must be a JSON object"] };
  const title = text(value["title"], "title", PLAN_LIMITS.title);
  const why = texts(value["why"], "why", PLAN_LIMITS.why, PLAN_LIMITS.quote);
  const tree = claims(value["claims"], "claims", 1);
  if (Array.isArray(value["claims"]) && value["claims"].length === 0) errors.push("claims must hold at least one claim");
  if (value["claims"] === undefined) errors.push("claims is required");
  let shared: Plan["shared"];
  if (value["shared"] !== undefined && value["shared"] !== null) {
    if (!object(value["shared"])) errors.push("shared must be an object");
    else {
      const body = text(value["shared"]["text"], "shared.text", PLAN_LIMITS.text);
      const shown = exhibit(value["shared"]["exhibit"], "shared.exhibit");
      if (body !== undefined) shared = { text: body, ...(shown ? { exhibit: shown } : {}) };
    }
  }
  const scope = texts(value["scope"], "scope", PLAN_LIMITS.scope, PLAN_LIMITS.text);
  if (asks.size > PLAN_LIMITS.asks) errors.push(`a plan asks at most ${PLAN_LIMITS.asks} decisions; ask only what changes what you build`);
  if (errors.length || title === undefined) return { errors: errors.length ? errors : ["title is required"] };
  return { plan: { title, why, claims: tree, ...(shared ? { shared } : {}), scope } };
}

/** One claim with its number (1, 1.2, 1.2.1) and its level, in reading order. */
export interface NumberedClaim {
  id: string;
  level: number;
  claim: PlanClaim;
}

/** The claims in reading order, numbered; `shared` is numbered "shared". */
export function numberClaims(plan: Pick<Plan, "claims">): NumberedClaim[] {
  const out: NumberedClaim[] = [];
  const walk = (claims: PlanClaim[], prefix: string, level: number) => claims.forEach((claim, index) => {
    const id = prefix ? `${prefix}.${index + 1}` : `${index + 1}`;
    out.push({ id, level, claim });
    walk(claim.children, id, level + 1);
  });
  walk(plan.claims, "", 1);
  return out;
}

/** The plan's decisions in reading order, each with the number the person sees (D1, D2, …) and the claim it sits on. */
export function planAsks(plan: Pick<Plan, "claims">): Array<{ number: string; claim: string; ask: PlanAsk }> {
  return numberClaims(plan).flatMap(({ id, claim }) => (claim.ask ? [{ claim: id, ask: claim.ask }] : [])).map((each, index) => ({ number: `D${index + 1}`, ...each }));
}
