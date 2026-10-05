import { describe, expect, it } from "bun:test";
import { keep, regions, sameRegions, type Kept } from "./presenter.ts";
import { INITIAL_STATE, transition, type UiState } from "./state.ts";

/** Reads one selection over a run of states, as a Presenter does on each change. */
function reads<T>(states: UiState[], select: (state: UiState) => T, isEqual?: (a: T, b: T) => boolean): T[] {
  let cache: Kept<T> | null = null;
  return states.map((state) => (cache = keep(cache, state, select, isEqual)).value);
}

describe("a Presenter's selection", () => {
  it("keeps the value it drew while the state is the same object", () => {
    let calls = 0;
    const [a, b] = reads([INITIAL_STATE, INITIAL_STATE], (state) => { calls += 1; return { screen: state.screen }; });
    expect(b).toBe(a!);
    expect(calls).toBe(1);
  });

  it("keeps the regions it reads when another region changes, and takes them anew when one of them does", () => {
    const typing = transition(transition(INITIAL_STATE, { type: "open-settings" }).state, { type: "edit-font", field: "chatFontFamily", text: "Menlo" }).state;
    const fleet = regions("runs", "usage", "request", "detail", "canAct");
    const [before, whileTyping] = reads([INITIAL_STATE, typing], fleet, sameRegions);
    expect(whileTyping).toBe(before!);
    const loaded = transition(typing, { type: "runs-loaded", runs: [] }).state;
    const [, , afterRuns] = reads([INITIAL_STATE, typing, loaded], fleet, sameRegions);
    expect(afterRuns).not.toBe(before);
    expect(afterRuns!.runs).toBe(loaded.runs);
  });

  it("keeps an equal plain value, such as a count", () => {
    const loaded = transition(INITIAL_STATE, { type: "runs-loaded", runs: [] }).state;
    const [a, b] = reads([INITIAL_STATE, loaded], (state) => state.runs.data.length);
    expect(a).toBe(0);
    expect(b).toBe(0);
  });
});
