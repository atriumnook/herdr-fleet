import type { AgentRun, UsageEntry } from "../../shared/fleet.ts";
import type { PairedDevice, PairingCode, RemoteAccess } from "../../shared/protocol.ts";
import { sanitizeFontFamily } from "../lib/fontFamily.ts";
import { DEFAULT_SETTINGS, sanitizeSettings, type DefaultView, type Settings } from "../lib/settings.ts";

/**
 * The Root Mediator's state machine. One state with parallel regions (what Main shows, the fleet's
 * runs, the usage, the action in flight, the run whose detail is open, this device's settings and
 * their dialog), one entry for events, and
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

/** The font lists Settings takes as typed text: saved when the field is left, on Enter or when the dialog closes. */
export type FontField = "terminalFontFamily" | "chatFontFamily";

/**
 * The Settings dialog. A font list being typed stays a draft until committed: saving every
 * keystroke would tidy away the comma or space being typed, and each change of the terminal's
 * font refits the grid and resizes the pane.
 */
export type SettingsDialogState =
  | { open: false }
  | { open: true; drafts: Partial<Record<FontField, string>> };

/** how often the devices are read while a pairing code is out, to see the device it lets in */
export const DEVICE_POLL_MS = 3000;
/** how long a first press on Revoke waits for the second */
export const REVOKE_CONFIRM_MS = 4000;

/** Settings → Devices: the paired devices, and a code out to pair one more. Read anew each time Settings opens. */
export interface DevicesState {
  /** null until the server answered */
  list: PairedDevice[] | null;
  /** the devices seen so far: one that appears while a code is out has just paired */
  known: string[];
  /** the server keeps no devices (the demo, or an older server) */
  unavailable: boolean;
  failure: { kind: "unavailable" } | { kind: "message"; message: string } | null;
  code: PairingCode | null;
  justPaired: string | null;
  /** the name being typed for a device */
  renaming: { id: string; label: string } | null;
  /** the device whose Revoke was pressed once */
  confirming: string | null;
  /** the poll chain running for the code out: one at a time, a later one ends the one before */
  pollSeq: number;
  /** the press on Revoke whose timeout counts: pressing again re-arms it */
  confirmSeq: number;
}

export const NO_DEVICES: DevicesState = { list: null, known: [], unavailable: false, failure: null, code: null, justPaired: null, renaming: null, confirming: null, pollSeq: 0, confirmSeq: 0 };

/** Settings → Alerts' test push: what came of the last one, on this device. */
export type PushTest = "idle" | "sending" | "sent" | "unsupported" | "permission" | "missing" | "failed";

/** `auto`: picked by the shell for a pane that closed; it raises no phone keyboard until the person picks a pane or lens */
export interface Selection { machineId: string; paneId: string | null; auto: boolean }

/** how long a failed change stays noted in a session tree */
export const TREE_FAILURE_MS = 5000;

/** What a PC's session tree asks of its herdr. */
export type TreeRequest =
  | { kind: "close-pane"; paneId: string }
  | { kind: "close-workspace"; workspaceId: string }
  | { kind: "rename-pane"; paneId: string; label: string }
  | { kind: "rename-workspace"; workspaceId: string; label: string }
  | { kind: "move-workspace"; workspaceId: string; index: number };

/** A reorder shown before herdr has it: it holds while herdr's own order is still `basis`. */
export interface ShownOrder { basis: string[]; order: string[] }

/** One PC's session tree in the sidebar. */
export interface TreeState {
  /** the name being typed for a pane */
  paneRename: { paneId: string; label: string } | null;
  /** the name being typed for a workspace; `key` is the copy clicked (by folder, one shows under several) */
  workspaceRename: { key: string; workspaceId: string; label: string } | null;
  order: ShownOrder | null;
  /** a change herdr refused, noted for a while (beside its pane's row when it has one) */
  failure: { kind: "close" | "rename" | "reorder"; reason: string; paneId?: string; seq: number } | null;
  /** a close that takes a workspace with it asks first; `error`: the yes that failed */
  confirm: { action: Extract<TreeRequest, { kind: "close-pane" | "close-workspace" }>; title: string; body: string; status: "asking" | "running"; error?: string } | null;
}

export const EMPTY_TREE: TreeState = { paneRename: null, workspaceRename: null, order: null, failure: null, confirm: null };

/** A PC's tree, empty until something happens in it. */
export const treeOf = (state: UiState, machineId: string): TreeState => state.trees[machineId] ?? EMPTY_TREE;

export interface UiState {
  screen: Screen;
  runs: Loadable<AgentRun[]>;
  usage: Loadable<UsageEntry[]> & { refreshing: boolean };
  request: RequestState;
  /** the run whose detail sheet is open */
  detail: string | null;
  /** this device may change things (a paired watch-only device may not: the server answers read_only) */
  canAct: boolean;
  /** the pane shown: on which PC, and whether the shell picked it itself (the one selected closed) */
  selection: Selection;
  /** this device's preferences, kept in localStorage */
  settings: Settings;
  settingsDialog: SettingsDialogState;
  /** how a phone can reach this PC: what Tailscale on it already serves (Settings → Phone); null when unknown */
  remoteAccess: Loadable<RemoteAccess | null>;
  devices: DevicesState;
  /**
   * Counts the openings of Settings. What its panels asked for (an answer, a timer) carries the
   * opening it was asked in, and is dropped in a later one, as the panels it was for are gone.
   */
  settingsSession: number;
  pushTest: PushTest;
  /** each PC's session tree, by machine id */
  trees: Record<string, TreeState>;
}

export type UiEvent =
  | { type: "show-screen"; screen: Screen }
  /** what the server said this device may do */
  | { type: "access-known"; canAct: boolean }
  /** the person picked a pane (sidebar, palette, notification, a new session) */
  | { type: "select-pane"; machineId: string; paneId: string | null }
  /** the selected pane `from` closed: the shell picked `paneId` in its place */
  | { type: "fall-back-pane"; from: string | null; paneId: string | null; auto: boolean }
  /** the person chose a lens in the pane the shell picked: it is theirs now */
  | { type: "selection-confirmed" }
  /** the server pushed fleet-changed, or the event stream (re)opened and pushes may have been missed */
  | { type: "fleet-changed" }
  | { type: "runs-loaded"; runs: AgentRun[] }
  | { type: "runs-failed"; message: string }
  | { type: "usage-loaded"; entries: UsageEntry[] }
  | { type: "usage-failed"; message: string }
  /** the CLIs answered a refresh: its own outcome, apart from a plain read of what is known */
  | { type: "usage-refreshed"; entries: UsageEntry[] }
  | { type: "usage-refresh-failed"; message: string }
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
  | { type: "dismiss-error" }
  | { type: "open-settings" }
  /** the dialog closes: the font lists still being typed are committed */
  | { type: "close-settings" }
  | { type: "change-settings"; patch: Partial<Settings> }
  /** the lens for every pane: choosing another one puts every pane back on it */
  | { type: "choose-default-view"; view: DefaultView }
  | { type: "edit-font"; field: FontField; text: string }
  | { type: "commit-font"; field: FontField }
  | { type: "load-remote-access" }
  | { type: "remote-access-loaded"; access: RemoteAccess }
  | { type: "remote-access-failed"; message: string }
  | { type: "devices-loaded"; devices: PairedDevice[]; session: number }
  /** `unavailable`: the server keeps no devices */
  | { type: "devices-failed"; message: string; unavailable: boolean; session: number }
  | { type: "poll-devices"; session: number; seq: number }
  | { type: "pair-device" }
  /** `at`: when the code arrived, to time its expiry */
  | { type: "pairing-started"; code: PairingCode; at: number; session: number }
  | { type: "pairing-expired"; code: string; session: number }
  | { type: "end-pairing" }
  | { type: "start-rename"; id: string; label: string }
  | { type: "edit-rename"; label: string }
  | { type: "cancel-rename" }
  | { type: "save-rename" }
  | { type: "revoke-device"; id: string }
  | { type: "unconfirm-revoke"; id: string; session: number; seq: number }
  | { type: "device-renamed"; session: number }
  /** a revoke the server took */
  | { type: "device-changed"; session: number }
  | { type: "device-change-failed"; message: string; session: number }
  | { type: "send-test-push" }
  /** the shell turns alerts on again (permission, subscription, then a confirmation push) */
  | { type: "push-repair-started" }
  | { type: "push-tested"; result: Exclude<PushTest, "idle" | "sending">; session: number }
  | TreeEvent;

/** What a PC's session tree sends up; every one names its PC. */
export type TreeEvent = { machineId: string } & (
  | { type: "tree-start-pane-rename"; paneId: string; label: string }
  | { type: "tree-edit-pane-rename"; label: string }
  /** Escape, or the field left */
  | { type: "tree-end-pane-rename" }
  | { type: "tree-save-pane-rename" }
  | { type: "tree-start-workspace-rename"; key: string; workspaceId: string; label: string }
  | { type: "tree-edit-workspace-rename"; label: string }
  | { type: "tree-end-workspace-rename" }
  | { type: "tree-save-workspace-rename" }
  /** a pane that leaves its workspace standing closes at once */
  | { type: "tree-close-pane"; paneId: string }
  | { type: "tree-ask"; action: Extract<TreeRequest, { kind: "close-pane" | "close-workspace" }>; title: string; body: string }
  | { type: "tree-confirm" }
  | { type: "tree-cancel" }
  /** `shown`: the order drawn now; `herdr`: herdr's own */
  | { type: "tree-move-workspace"; workspaceId: string; insertIndex: number; shown: string[]; herdr: string[] }
  | { type: "tree-done"; viaConfirm: boolean }
  | { type: "tree-failed"; request: TreeRequest; reason: string; viaConfirm: boolean; revert: ShownOrder | null }
  | { type: "tree-clear-failure"; seq: number }
);

export type Effect =
  | { kind: "load-runs" }
  | { kind: "load-usage" }
  | { kind: "refresh-usage" }
  | { kind: "request"; action: RequestAction }
  | { kind: "save-settings"; settings: Settings }
  /** every pane's own lens on this device is forgotten */
  | { kind: "forget-pane-views" }
  | { kind: "load-remote-access" }
  | { kind: "load-devices"; session: number }
  | { kind: "start-pairing"; session: number }
  | { kind: "rename-device"; id: string; label: string; session: number }
  | { kind: "revoke-device"; id: string; session: number }
  /** an event the state machine sends itself after a while */
  | { kind: "later"; ms: number; event: UiEvent }
  | { kind: "test-push"; session: number }
  | { kind: "store-selection"; machineId: string; paneId: string | null }
  /** `revert`: the order to go back to when herdr refuses a reorder */
  | { kind: "tree-request"; machineId: string; request: TreeRequest; viaConfirm: boolean; revert: ShownOrder | null };

export interface Transition { state: UiState; effects: Effect[] }

export const INITIAL_STATE: UiState = {
  screen: "pane",
  runs: { status: "idle", data: [], again: false },
  usage: { status: "idle", data: [], again: false, refreshing: false },
  request: { status: "none" },
  detail: null,
  selection: { machineId: "local", paneId: null, auto: false },
  canAct: true,
  settings: DEFAULT_SETTINGS,
  settingsDialog: { open: false },
  remoteAccess: { status: "idle", data: null, again: false },
  devices: NO_DEVICES,
  settingsSession: 0,
  pushTest: "idle",
  trees: {},
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
    case "access-known":
      return next({ canAct: event.canAct });
    case "show-screen":
      return next({ screen: event.screen, detail: event.screen === "pane" ? null : state.detail });
    case "select-pane":
      return next({ screen: "pane", detail: null, selection: select(event.machineId, event.paneId, false, effects) });
    case "fall-back-pane":
      if (state.selection.paneId !== event.from) return next({});
      return next({ selection: select(state.selection.machineId, event.paneId, event.auto || state.selection.auto, effects) });
    case "selection-confirmed":
      return next(state.selection.auto ? { selection: { ...state.selection, auto: false } } : {});
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
      return next({ usage: settle(state.usage, { status: "ready", data: event.entries, error: undefined }, { kind: "load-usage" }, effects) });
    case "usage-failed":
      return next({ usage: settle(state.usage, { status: "error", error: event.message }, { kind: "load-usage" }, effects) });
    case "usage-refreshed": {
      // a read still in flight may have read the server before the refresh landed: it is read again after
      const usage = { ...state.usage, data: event.entries, error: undefined, refreshing: false, again: state.usage.status === "loading" ? true : state.usage.again };
      return next({ usage: state.usage.status === "loading" ? usage : { ...usage, status: "ready" } });
    }
    case "usage-refresh-failed":
      return next({ usage: { ...state.usage, refreshing: false, error: event.message, status: state.usage.status === "loading" ? "loading" : "error" } });
    case "refresh-usage":
      if (state.usage.refreshing || !state.canAct) return next({});
      effects.push({ kind: "refresh-usage" });
      return next({ usage: { ...state.usage, refreshing: true } });
    case "show-run":
      return next({ detail: state.runs.data.some((run) => run.id === event.runId) ? event.runId : state.detail });
    case "hide-run":
      return next({ detail: null });
    case "open-pane": {
      const run = state.runs.data.find((candidate) => candidate.id === event.runId);
      if (!run || isEnded(run)) return next({});
      // a fleet run's pane lives on this PC
      return next({ screen: "pane", detail: null, selection: select("local", run.paneId, false, effects) });
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
    case "open-settings":
      if (state.settingsDialog.open) return next({});
      effects.push({ kind: "load-devices", session: state.settingsSession + 1 });
      return next({ settingsDialog: { open: true, drafts: {} }, remoteAccess: readAccess(state.remoteAccess, effects), devices: NO_DEVICES, settingsSession: state.settingsSession + 1, pushTest: "idle" });
    case "close-settings": {
      if (!state.settingsDialog.open) return next({});
      const fonts: Partial<Settings> = {};
      for (const [field, text] of Object.entries(state.settingsDialog.drafts) as Array<[FontField, string]>) fonts[field] = sanitizeFontFamily(text);
      return next(change(state, fonts, effects, { open: false }));
    }
    case "change-settings":
      return next(change(state, event.patch, effects));
    case "choose-default-view":
      if (state.settings.defaultView === event.view) return next({});
      effects.push({ kind: "forget-pane-views" });
      return next(change(state, { defaultView: event.view }, effects));
    case "edit-font":
      if (!state.settingsDialog.open) return next({});
      return next({ settingsDialog: { open: true, drafts: { ...state.settingsDialog.drafts, [event.field]: event.text } } });
    case "commit-font": {
      if (!state.settingsDialog.open) return next({});
      const text = state.settingsDialog.drafts[event.field];
      if (text === undefined) return next({});
      return next(change(state, { [event.field]: sanitizeFontFamily(text) }, effects, withoutDraft(state.settingsDialog, event.field)));
    }
    case "load-remote-access":
      return next({ remoteAccess: readAccess(state.remoteAccess, effects) });
    case "remote-access-loaded":
      return next({ remoteAccess: settleAccess(state.remoteAccess, { status: "ready", data: event.access, error: undefined }, effects) });
    case "devices-loaded":
    case "devices-failed":
    case "poll-devices":
    case "pair-device":
    case "pairing-started":
    case "pairing-expired":
    case "end-pairing":
    case "start-rename":
    case "edit-rename":
    case "cancel-rename":
    case "save-rename":
    case "revoke-device":
    case "unconfirm-revoke":
    case "device-renamed":
    case "device-changed":
    case "device-change-failed": {
      // devices exist only while Settings is open: what arrives after it closed, or from an earlier opening, is dropped
      if (!state.settingsDialog.open || ("session" in event && event.session !== state.settingsSession)) return next({});
      return next({ devices: devicesTransition(state.devices, event, state.settingsSession, effects) });
    }
    case "send-test-push":
      if (!state.settingsDialog.open || state.pushTest === "sending") return next({});
      effects.push({ kind: "test-push", session: state.settingsSession });
      return next({ pushTest: "sending" });
    case "push-repair-started":
      return next(state.settingsDialog.open ? { pushTest: "sending" } : {});
    case "push-tested":
      return next(state.settingsDialog.open && event.session === state.settingsSession ? { pushTest: event.result } : {});
    case "tree-start-pane-rename":
    case "tree-edit-pane-rename":
    case "tree-end-pane-rename":
    case "tree-save-pane-rename":
    case "tree-start-workspace-rename":
    case "tree-edit-workspace-rename":
    case "tree-end-workspace-rename":
    case "tree-save-workspace-rename":
    case "tree-close-pane":
    case "tree-ask":
    case "tree-confirm":
    case "tree-cancel":
    case "tree-move-workspace":
    case "tree-done":
    case "tree-failed":
    case "tree-clear-failure": {
      const current = treeOf(state, event.machineId);
      const tree = treeTransition(current, event, effects);
      return next(tree === current ? {} : { trees: { ...state.trees, [event.machineId]: tree } });
    }
    case "remote-access-failed":
      return next({ remoteAccess: settleAccess(state.remoteAccess, { status: "error", data: null, error: event.message }, effects) });
  }
}

function devicesTransition(devices: DevicesState, event: UiEvent, session: number, effects: Effect[]): DevicesState {
  switch (event.type) {
    case "devices-loaded": {
      const fresh = event.devices.filter((device) => !devices.known.includes(device.id));
      // as before the migration: a device counts as just paired only once some were known
      const paired = devices.known.length > 0 || event.devices.length === 0 ? fresh.at(-1) : undefined;
      const code = paired ? null : devices.code;
      return { ...devices, list: event.devices, failure: null, known: event.devices.map((device) => device.id), justPaired: paired?.label ?? devices.justPaired, code };
    }
    case "devices-failed":
      return { ...devices, list: [], unavailable: devices.unavailable || event.unavailable, failure: event.unavailable ? { kind: "unavailable" } : { kind: "message", message: event.message } };
    case "poll-devices":
      // the chain of an earlier code, or of no code any more, ends here
      if (devices.code === null || event.seq !== devices.pollSeq) return devices;
      effects.push({ kind: "load-devices", session }, { kind: "later", ms: DEVICE_POLL_MS, event: { type: "poll-devices", session, seq: event.seq } });
      return devices;
    case "pair-device":
      effects.push({ kind: "start-pairing", session });
      return { ...devices, justPaired: null };
    case "pairing-started": {
      const pollSeq = devices.pollSeq + 1;
      effects.push(
        { kind: "later", ms: DEVICE_POLL_MS, event: { type: "poll-devices", session, seq: pollSeq } },
        { kind: "later", ms: Math.max(0, Date.parse(event.code.expires_at) - event.at), event: { type: "pairing-expired", code: event.code.code, session } },
      );
      return { ...devices, code: event.code, failure: null, pollSeq };
    }
    case "pairing-expired":
      return devices.code?.code === event.code ? { ...devices, code: null } : devices;
    case "end-pairing":
      return { ...devices, code: null };
    case "start-rename":
      return { ...devices, renaming: { id: event.id, label: event.label } };
    case "edit-rename":
      return devices.renaming ? { ...devices, renaming: { ...devices.renaming, label: event.label } } : devices;
    case "cancel-rename":
      return { ...devices, renaming: null };
    case "save-rename":
      if (!devices.renaming) return devices;
      effects.push({ kind: "rename-device", id: devices.renaming.id, label: devices.renaming.label, session });
      return devices;
    case "revoke-device":
      if (devices.confirming !== event.id) {
        const confirmSeq = devices.confirmSeq + 1;
        effects.push({ kind: "later", ms: REVOKE_CONFIRM_MS, event: { type: "unconfirm-revoke", id: event.id, session, seq: confirmSeq } });
        return { ...devices, confirming: event.id, confirmSeq };
      }
      effects.push({ kind: "revoke-device", id: event.id, session });
      return { ...devices, confirming: null };
    case "unconfirm-revoke":
      return devices.confirming === event.id && devices.confirmSeq === event.seq ? { ...devices, confirming: null } : devices;
    case "device-renamed":
      effects.push({ kind: "load-devices", session });
      return { ...devices, renaming: null };
    case "device-changed":
      effects.push({ kind: "load-devices", session });
      return devices;
    case "device-change-failed":
      return { ...devices, failure: { kind: "message", message: event.message } };
    default:
      return devices;
  }
}

const FAILURE_KIND: Record<TreeRequest["kind"], NonNullable<TreeState["failure"]>["kind"]> = {
  "close-pane": "close", "close-workspace": "close", "rename-pane": "rename", "rename-workspace": "rename", "move-workspace": "reorder",
};

function treeTransition(tree: TreeState, event: TreeEvent, effects: Effect[]): TreeState {
  const ask = (request: TreeRequest, viaConfirm = false, revert: ShownOrder | null = null): void => {
    effects.push({ kind: "tree-request", machineId: event.machineId, request, viaConfirm, revert });
  };
  switch (event.type) {
    case "tree-start-pane-rename":
      return { ...tree, paneRename: { paneId: event.paneId, label: event.label } };
    case "tree-edit-pane-rename":
      return tree.paneRename ? { ...tree, paneRename: { ...tree.paneRename, label: event.label } } : tree;
    case "tree-end-pane-rename":
      return tree.paneRename ? { ...tree, paneRename: null } : tree;
    case "tree-save-pane-rename":
      if (!tree.paneRename) return tree;
      ask({ kind: "rename-pane", paneId: tree.paneRename.paneId, label: tree.paneRename.label.trim() });
      return { ...tree, paneRename: null };
    case "tree-start-workspace-rename":
      return { ...tree, workspaceRename: { key: event.key, workspaceId: event.workspaceId, label: event.label } };
    case "tree-edit-workspace-rename":
      return tree.workspaceRename ? { ...tree, workspaceRename: { ...tree.workspaceRename, label: event.label } } : tree;
    case "tree-end-workspace-rename":
      return tree.workspaceRename ? { ...tree, workspaceRename: null } : tree;
    case "tree-save-workspace-rename":
      if (!tree.workspaceRename) return tree;
      ask({ kind: "rename-workspace", workspaceId: tree.workspaceRename.workspaceId, label: tree.workspaceRename.label.trim() });
      return { ...tree, workspaceRename: null };
    case "tree-close-pane":
      ask({ kind: "close-pane", paneId: event.paneId });
      return { ...tree, failure: null };
    case "tree-ask":
      return { ...tree, confirm: { action: event.action, title: event.title, body: event.body, status: "asking" } };
    case "tree-confirm":
      if (tree.confirm?.status !== "asking") return tree;
      ask(tree.confirm.action, true);
      return { ...tree, confirm: { action: tree.confirm.action, title: tree.confirm.title, body: tree.confirm.body, status: "running" } };
    case "tree-cancel":
      // a deed that runs cannot be undone: the question stays until it ends
      return tree.confirm?.status === "asking" ? { ...tree, confirm: null } : tree;
    case "tree-move-workspace": {
      const from = event.shown.indexOf(event.workspaceId);
      if (from < 0) return tree;
      const to = Math.max(0, Math.min(event.shown.length - 1, event.insertIndex));
      if (from === to) return tree;
      const order = [...event.shown];
      order.splice(from, 1);
      order.splice(to, 0, event.workspaceId);
      ask({ kind: "move-workspace", workspaceId: event.workspaceId, index: to }, false, tree.order);
      return { ...tree, order: { basis: event.herdr, order } };
    }
    case "tree-done":
      return event.viaConfirm && tree.confirm ? { ...tree, confirm: null } : tree;
    case "tree-failed": {
      if (event.viaConfirm) return tree.confirm ? { ...tree, confirm: { ...tree.confirm, status: "asking", error: event.reason } } : tree;
      const seq = (tree.failure?.seq ?? 0) + 1;
      effects.push({ kind: "later", ms: TREE_FAILURE_MS, event: { type: "tree-clear-failure", machineId: event.machineId, seq } });
      const paneId = event.request.kind === "close-pane" || event.request.kind === "rename-pane" ? event.request.paneId : undefined;
      return {
        ...tree,
        order: event.request.kind === "move-workspace" ? event.revert : tree.order,
        failure: { kind: FAILURE_KIND[event.request.kind], reason: event.reason, ...(paneId === undefined ? {} : { paneId }), seq },
      };
    }
    case "tree-clear-failure":
      return tree.failure?.seq === event.seq ? { ...tree, failure: null } : tree;
  }
}

/** A pane selected, and kept for the next load. */
function select(machineId: string, paneId: string | null, auto: boolean, effects: Effect[]): Selection {
  effects.push({ kind: "store-selection", machineId, paneId });
  return { machineId, paneId, auto };
}

/** Read the remote access again; what was known goes meanwhile, so the panel says it is checking. */
function readAccess(region: UiState["remoteAccess"], effects: Effect[]): UiState["remoteAccess"] {
  return { ...load(region, { kind: "load-remote-access" }, effects), data: null };
}

/** A read of the remote access answered; one asked for meanwhile reads again, and shows nothing until it answers. */
function settleAccess(region: UiState["remoteAccess"], outcome: Partial<UiState["remoteAccess"]>, effects: Effect[]): UiState["remoteAccess"] {
  const settled = settle(region, outcome, { kind: "load-remote-access" }, effects);
  return settled.status === "loading" ? { ...settled, data: null } : settled;
}

function withoutDraft(dialog: SettingsDialogState, field: FontField): SettingsDialogState {
  if (!dialog.open || !(field in dialog.drafts)) return dialog;
  const { [field]: _dropped, ...drafts } = dialog.drafts;
  return { open: true, drafts };
}

/**
 * Apply a change to the settings, tidied as a stored record is, and save it. A font list being
 * typed gives way to a change of the same setting made elsewhere.
 */
function change(state: UiState, patch: Partial<Settings>, effects: Effect[], dialog = state.settingsDialog): Partial<UiState> {
  for (const field of ["terminalFontFamily", "chatFontFamily"] as const) {
    if (field in patch) dialog = withoutDraft(dialog, field);
  }
  const settings = sanitizeSettings({ ...state.settings, ...patch });
  // plain data: the tidied record holds new arrays and objects even where nothing changed
  const same = (Object.keys(settings) as Array<keyof Settings>).every((key) => JSON.stringify(settings[key]) === JSON.stringify(state.settings[key]));
  if (same) return { settingsDialog: dialog };
  effects.push({ kind: "save-settings", settings });
  return { settings, settingsDialog: dialog };
}

/** One action at a time: another one while it runs is ignored, as its button is disabled. */
function request(state: UiState, action: RequestAction): Transition {
  if (state.request.status === "pending" || !state.canAct) return { state, effects: [] };
  return { state: { ...state, request: { status: "pending", action } }, effects: [{ kind: "request", action }] };
}
