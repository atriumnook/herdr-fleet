import type { AgentRun, UsageEntry } from "../../shared/fleet.ts";

/**
 * The Root Mediator's state machine. One state with parallel regions (what Main shows, the fleet's
 * runs, the usage, the action in flight, the run whose detail is open), one entry for events, and
 * a pure transition: (state, event) → (next state, effects). The Mediator runs the effects and
 * feeds their outcome back as events.
 */

export type Screen = "pane" | "fleet";

/** A fetched record set: `again` asks for one more fetch once the one in flight answers. */
export interface Loadable<T> {
  status: "idle" | "loading" | "ready" | "error";
  data: T;
  error?: string;
  again: boolean;
}

export type RequestAction =
  | { kind: "interrupt"; runId: string }
  | { kind: "close-done"; group: string }
  | { kind: "clear-cooldown"; key: string };

export type RequestState =
  | { status: "none" }
  | { status: "pending"; action: RequestAction }
  | { status: "failed"; action: RequestAction; message: string };

export interface UiState {
  screen: Screen;
  runs: Loadable<AgentRun[]>;
  usage: Loadable<UsageEntry[]> & { refreshing: boolean };
  request: RequestState;
  /** the run whose detail sheet is open */
  detail: string | null;
  /**
   * A pane the legacy shell should select (it still owns the pane selection until it moves to
   * this Mediator): `seq` makes asking for the same pane twice a new request.
   */
  paneRequest: { paneId: string; seq: number } | null;
}

export type UiEvent =
  /** the Root mounted */
  | { type: "started" }
  | { type: "show-screen"; screen: Screen }
  /** the legacy shell selected a pane (sidebar, palette, notification) */
  | { type: "pane-selected" }
  /** the server pushed fleet-changed */
  | { type: "fleet-changed" }
  | { type: "runs-loaded"; runs: AgentRun[] }
  | { type: "runs-failed"; message: string }
  | { type: "usage-loaded"; entries: UsageEntry[] }
  | { type: "usage-failed"; message: string }
  /** ask the CLIs again (runs codex, agy and claude probes on the server) */
  | { type: "refresh-usage" }
  | { type: "show-run"; runId: string }
  | { type: "hide-run" }
  | { type: "open-pane"; runId: string }
  | { type: "interrupt-run"; runId: string }
  | { type: "close-done"; group: string }
  | { type: "clear-cooldown"; key: string }
  | { type: "request-done" }
  | { type: "request-failed"; message: string }
  | { type: "dismiss-error" };

export type Effect =
  | { kind: "load-runs" }
  | { kind: "load-usage" }
  | { kind: "refresh-usage" }
  | { kind: "request"; action: RequestAction };

export interface Transition { state: UiState; effects: Effect[] }

export const INITIAL_STATE: UiState = {
  screen: "pane",
  runs: { status: "idle", data: [], again: false },
  usage: { status: "idle", data: [], again: false, refreshing: false },
  request: { status: "none" },
  detail: null,
  paneRequest: null,
};

/** A run whose pane is gone: nothing to open or stop in it. */
export const isEnded = (run: AgentRun): boolean => run.state === "stopped";

/** Start a fetch, or, with one in flight, ask for another after it: a change it may have missed. */
function load<T extends Loadable<unknown>>(region: T, effect: Effect, effects: Effect[]): T {
  if (region.status === "loading") return { ...region, again: true };
  effects.push(effect);
  return { ...region, status: "loading", again: false };
}

/** A fetch answered: settle, or start the one asked for meanwhile. */
function settle<T extends Loadable<unknown>>(region: T, outcome: Partial<T>, effect: Effect, effects: Effect[]): T {
  if (region.again) {
    effects.push(effect);
    return { ...region, ...outcome, status: "loading", again: false };
  }
  return { ...region, ...outcome };
}

export function transition(state: UiState, event: UiEvent): Transition {
  const effects: Effect[] = [];
  // an event that changes nothing keeps the state object itself, so nobody re-renders for it
  const next = (patch: Partial<UiState>): Transition =>
    ({ state: (Object.keys(patch) as Array<keyof UiState>).every((key) => patch[key] === state[key]) ? state : { ...state, ...patch }, effects });
  switch (event.type) {
    case "started":
      return next({ runs: load(state.runs, { kind: "load-runs" }, effects), usage: load(state.usage, { kind: "load-usage" }, effects) });
    case "show-screen":
      return next({ screen: event.screen, detail: event.screen === "pane" ? null : state.detail });
    case "pane-selected":
      return next({ screen: "pane", detail: null });
    case "fleet-changed":
      // a refresh in flight answers with the new usage itself
      return next({
        runs: load(state.runs, { kind: "load-runs" }, effects),
        usage: state.usage.refreshing ? state.usage : load(state.usage, { kind: "load-usage" }, effects),
      });
    case "runs-loaded": {
      const runs = settle(state.runs, { status: "ready", data: event.runs, error: undefined }, { kind: "load-runs" }, effects);
      // a detail whose run the server no longer has closes
      return next({ runs, detail: state.detail && event.runs.some((run) => run.id === state.detail) ? state.detail : null });
    }
    case "runs-failed":
      // the runs shown last stay, marked stale by the error
      return next({ runs: settle(state.runs, { status: "error", error: event.message }, { kind: "load-runs" }, effects) });
    case "usage-loaded":
      return next({ usage: settle(state.usage, { status: "ready", data: event.entries, error: undefined, refreshing: false }, { kind: "load-usage" }, effects) });
    case "usage-failed":
      return next({ usage: settle(state.usage, { status: "error", error: event.message, refreshing: false }, { kind: "load-usage" }, effects) });
    case "refresh-usage":
      if (state.usage.refreshing) return next({});
      effects.push({ kind: "refresh-usage" });
      return next({ usage: { ...state.usage, refreshing: true } });
    case "show-run":
      return next({ detail: state.runs.data.some((run) => run.id === event.runId) ? event.runId : state.detail });
    case "hide-run":
      return next({ detail: null });
    case "open-pane": {
      const run = state.runs.data.find((candidate) => candidate.id === event.runId);
      if (!run || isEnded(run)) return next({});
      return next({ screen: "pane", detail: null, paneRequest: { paneId: run.paneId, seq: (state.paneRequest?.seq ?? 0) + 1 } });
    }
    case "interrupt-run":
      return request(state, { kind: "interrupt", runId: event.runId });
    case "close-done":
      return request(state, { kind: "close-done", group: event.group });
    case "clear-cooldown":
      return request(state, { kind: "clear-cooldown", key: event.key });
    case "request-done": {
      if (state.request.status !== "pending") return next({});
      // a cleared cooldown changes no run, so no fleet-changed follows: the usage is read here
      const usage = state.request.action.kind === "clear-cooldown" ? load(state.usage, { kind: "load-usage" }, effects) : state.usage;
      return next({ request: { status: "none" }, usage });
    }
    case "request-failed":
      if (state.request.status !== "pending") return next({});
      return next({ request: { status: "failed", action: state.request.action, message: event.message } });
    case "dismiss-error":
      return next({ request: state.request.status === "failed" ? { status: "none" } : state.request });
  }
}

/** One action at a time: another one while it runs is ignored, as its button is disabled. */
function request(state: UiState, action: RequestAction): Transition {
  if (state.request.status === "pending") return { state, effects: [] };
  return { state: { ...state, request: { status: "pending", action } }, effects: [{ kind: "request", action }] };
}
