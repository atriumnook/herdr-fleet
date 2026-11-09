import { describe, expect, it } from "bun:test";
import { BUNDLED_AGENTS_DIR, discoverAgents, findAgent } from "./agents.ts";

/**
 * What each bundled role must tell its model, and how long it may grow. A rule is one the fleet's
 * working rests on (who edits, who merges, what waits for the person, how a turn ends); its pattern
 * matches the role's body with runs of whitespace read as one space. A rewrite of a role keeps
 * every rule's meaning: when it rewords one, it updates the pattern here in the same change, and a
 * new or removed role adds or removes its row. The budget is in UTF-8 bytes of the body, the part
 * of the instructions the role file adds; raise it only on purpose.
 */
const ROLES: Record<string, { budget: number; rules: Record<string, RegExp> }> = {
  coordinator: {
    budget: 4_500,
    rules: {
      "edits no file": /You change no file/,
      "hands work to threads": /thread --title/,
      "leaves a plan to the person on the Fleet screen": /Do not answer a plan yourself/,
      "never answers an approval on a thread's screen": /Never answer an approval on a thread's screen/,
      "leaves restarting a failed thread to the fleet": /do not restart it yourself/,
      "merges only what the person pressed, that merge only": /person pressed Merge .* approval for that merge only/,
      "does not force a merge that is in the way": /do not force it/,
      "takes a [from pane] message as the person's request": /`\[from pane <id>\]` is the person's own request/,
    },
  },
  lead: {
    budget: 6_000,
    rules: {
      "writes an acceptance contract first": /contract\.md/,
      "hands a large change to the person as a plan and stops": /Before a large change .* run `plan <file\.json>`.* `blocked` report whose `human_action`/,
      "sees a check fail before changing behaviour": /see it fail/,
      "takes expected values from outside the code under test": /Never compute it the way the code does/,
      "has every change reviewed on another CLI": /Every change gets a review, on another CLI than the one that wrote it \(`--avoid`/,
      "gives an agy reviewer the diff and checks as files": /reviewer on agy cannot run git/,
      "waits for an agent it started in the same turn, or reports first": /wait for it with `wait <agent>` in the same turn: do not end your turn to wait, and if you must end it, write your report first/,
      "asks an architect how to build": /spawn --role architect --read-only/,
      "asks the person what to build when it cannot be undone": /When the assumption would be hard to undo, do not guess/,
      "ends a turn with the contract's state": /Contract: A1/,
      "pushes or opens a pull request only when the person pressed it": /Never push, open or merge a pull request, or change another branch, unless a `\[fleet\]` message says the person pressed/,
      "never force-pushes": /Never force-push/,
    },
  },
  architect: {
    budget: 2_500,
    rules: {
      "edits no file": /You change no file/,
      "designs at least two shapes": /Design it twice/,
      "leaves what to build to the person": /What to build or why .* is not yours to decide/,
      "ends with a ready or blocked report": /Your report is `ready` .* or `blocked`/,
    },
  },
  planner: { budget: 800, rules: { "edits no source file": /Do not modify source files/ } },
  reviewer: {
    budget: 800,
    rules: {
      "reviews independently": /independent reviewer/,
      "orders findings by severity and cites files": /by severity and cite exact files/,
      "does not rewrite the code": /Do not rewrite code/,
    },
  },
  scout: { budget: 800, rules: { "edits no file": /Do not edit files/ } },
  worker: {
    budget: 800,
    rules: {
      "claims only checks it ran": /Never claim tests passed unless you ran them/,
      "keeps unrelated refactors out": /Keep unrelated refactors out/,
    },
  },
};

/** the roles the fleet must never give to agy: they run the fleet command, which agy's sandbox hides (CLAUDE.md) */
const NEVER_ON_AGY = ["coordinator", "lead"];

const bundled = discoverAgents("/nonexistent", [], { bundled: BUNDLED_AGENTS_DIR, user: "/nonexistent" });

describe("bundled roles", () => {
  it("has a row in the rule table for every bundled role, and a bundled role for every row", () => {
    expect(bundled.map((agent) => agent.name).sort()).toEqual(Object.keys(ROLES).sort());
  });

  for (const [name, { budget, rules }] of Object.entries(ROLES)) {
    describe(name, () => {
      const body = () => findAgent(bundled, name)!.systemPrompt.replace(/\s+/g, " ");
      for (const [rule, pattern] of Object.entries(rules)) {
        it(`states: ${rule}`, () => {
          expect(body()).toMatch(pattern);
        });
      }
      it(`stays within ${budget} bytes`, () => {
        expect(Buffer.byteLength(findAgent(bundled, name)!.systemPrompt, "utf8")).toBeLessThanOrEqual(budget);
      });
    });
  }

  it("never puts the coordinator or a lead on agy, first or as a fallback", () => {
    for (const name of NEVER_ON_AGY) {
      const role = findAgent(bundled, name)!;
      expect([role.agent, ...(role.fallbackModels ?? []).map((model) => model.split(":")[0])]).not.toContain("agy");
    }
  });
});
