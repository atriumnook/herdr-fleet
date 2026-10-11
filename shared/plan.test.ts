import { describe, expect, it } from "bun:test";
import { numberClaims, parsePlan, planAsks } from "./plan.ts";

const ask = (id: string) => ({ id, question: `Which ${id}?`, options: [{ value: "a", label: "A" }, { value: "b", label: "B", note: "claim 2 goes" }], recommended: "a" });

const PLAN = {
  title: "Scheduled send in the composer",
  why: ["I want to send a message later"],
  claims: [
    {
      text: "The person can pick a time in the composer.",
      exhibit: { kind: "list", items: ["Send later opens a time picker"] },
      ask: ask("picker"),
      children: [
        { text: "Send later saves the message with a time.", exhibit: { kind: "calls", rows: [{ depth: 0, text: "createScheduled()", at: "server/routes.ts:18" }, { depth: 1, text: "insert()" }] },
          children: [{ text: "routes.ts:18 · createScheduled()", exhibit: { kind: "code", path: "server/routes.ts", start: 18, end: 24 } }] },
      ],
    },
    { text: "A person holds 50 scheduled messages at most.", exhibit: { kind: "schema", lang: "sql", text: "create table scheduled (id int)" }, ask: ask("limit") },
  ],
  shared: { text: "One new table.", exhibit: { kind: "code", path: "db/new.sql", text: "create table scheduled ();" } },
  scope: ["Normal send", "Drafts"],
  extra: "dropped",
};

describe("plans", () => {
  it("take a plan the lead wrote, in the shape the fleet keeps", () => {
    const parsed = parsePlan(PLAN);
    if ("errors" in parsed) throw new Error(parsed.errors.join("\n"));
    expect(parsed.plan.title).toBe("Scheduled send in the composer");
    expect(parsed.plan.claims[0]!.children[0]!.children[0]!.exhibit).toEqual({ kind: "code", path: "server/routes.ts", start: 18, end: 24 });
    expect(parsed.plan.shared).toEqual({ text: "One new table.", exhibit: { kind: "code", path: "db/new.sql", text: "create table scheduled ();" } });
    expect(parsed.plan.scope).toEqual(["Normal send", "Drafts"]);
    expect("extra" in parsed.plan).toBe(false);
  });

  it("number the claims in reading order, and the decisions D1, D2 on the claims they change", () => {
    const parsed = parsePlan(PLAN);
    if ("errors" in parsed) throw new Error(parsed.errors.join("\n"));
    expect(numberClaims(parsed.plan).map((claim) => `${claim.id}@${claim.level}`)).toEqual(["1@1", "1.1@2", "1.1.1@3", "2@1"]);
    expect(planAsks(parsed.plan).map((each) => `${each.number} ${each.claim} ${each.ask.id}`)).toEqual(["D1 1 picker", "D2 2 limit"]);
  });

  it("answer every problem at once, so the lead fixes them together", () => {
    const parsed = parsePlan({
      title: "",
      claims: [
        { text: "x", exhibit: { kind: "code", path: "a.ts" } },
        { text: "y", exhibit: { kind: "code", path: "a.ts", start: 1, end: 100 } },
        { text: "z", ask: { ...ask("limit"), recommended: "c" } },
        { text: "w", ask: ask("limit"), exhibit: { kind: "video" } },
      ],
    });
    expect("errors" in parsed && parsed.errors).toEqual([
      "title must be a non-empty string",
      "claims[0].exhibit needs start (and end) to show lines of a.ts, or text for code it proposes",
      "claims[1].exhibit must show 1 to 60 lines",
      "claims[2].ask.recommended must be one of its options' values",
      "claims[3].exhibit.kind must be code, schema, calls or list",
      "claims[3].ask.id limit is used twice",
    ]);
  });

  it("hold at most 3 levels, 5 claims under each, and 5 decisions", () => {
    const deep = { text: "1", children: [{ text: "2", children: [{ text: "3", children: [{ text: "4" }] }] }] };
    expect(parsePlan({ title: "t", claims: [deep] })).toEqual({ errors: ["claims[0].children[0].children[0].children: a plan has at most 3 levels"] });
    const wide = Array.from({ length: 6 }, (_, index) => ({ text: `${index}`, ask: ask(`d${index}`) }));
    expect("errors" in parsePlan({ title: "t", claims: wide }) && (parsePlan({ title: "t", claims: wide }) as { errors: string[] }).errors).toEqual(["claims has more than 5 claims"]);
    const asks = Array.from({ length: 3 }, (_, index) => ({ text: `${index}`, ask: ask(`a${index}`), children: [{ text: "c", ask: ask(`b${index}`) }] }));
    expect(parsePlan({ title: "t", claims: asks })).toEqual({ errors: ["a plan asks at most 5 decisions; ask only what changes what you build"] });
  });

  it("need a title and at least one claim, and refuse what is not an object", () => {
    expect(parsePlan([])).toEqual({ errors: ["the plan must be a JSON object"] });
    expect(parsePlan({ title: "t" })).toEqual({ errors: ["claims is required"] });
    expect(parsePlan({ title: "t", claims: [] })).toEqual({ errors: ["claims must hold at least one claim"] });
  });
});
