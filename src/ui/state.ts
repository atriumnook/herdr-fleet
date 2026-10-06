import type { AgentRun, UsageEntry } from "../../shared/fleet.ts";
import { paneStorageId, type Machine } from "../../shared/machines.ts";
import { alertsAllow, shouldNotifyStatus, type AlertPrefs } from "../../shared/notify-policy.ts";
import type { AccessRefusal, AgentKind, AgentStatus, ClientRole, HerdrPane, HealthAuth, PairedDevice, PairingCode, RemoteAccess, ServerMessage, SessionSnapshot } from "../../shared/protocol.ts";
import type { HealthInfo } from "../lib/api.ts";
import type { PaneView } from "../lib/actions.ts";
import { dropletAllows, endedTurn, trackTurn, type DropletKind } from "../lib/droplet.ts";
import type { NotificationState } from "../lib/notifications.ts";
import { applyPaneStatus } from "../lib/snapshot.ts";
import { sanitizeFontFamily } from "../lib/fontFamily.ts";
import { alertPrefs, DEFAULT_SETTINGS, sanitizeSettings, type DefaultView, type Settings } from "../lib/settings.ts";

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
  /** the devices seen so far, null until the first read: one that appears after it has just paired */
  known: string[] | null;
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

export const NO_DEVICES: DevicesState = { list: null, known: null, unavailable: false, failure: null, code: null, justPaired: null, renaming: null, confirming: null, pollSeq: 0, confirmSeq: 0 };

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

/** how often health and the PCs are read while the page is on screen */
export const POLL_MS = 5000;
/** pushes that change a PC's sessions come in bursts: one read after them */
export const REFETCH_DEBOUNCE_MS = 500;

/** This browser and the server: may it in, what the server says of itself. */
export interface ConnectionState {
  /** null until the server said whether this browser may in */
  locked: boolean | null;
  reason: AccessRefusal | null;
  auth: HealthAuth | null;
  health: HealthInfo | null;
  /** the code a scanned QR brought along (`?pair=CODE`): this browser pairs with it once in */
  pairCode: string;
  pairing: "none" | "asked";
  /** the page is on screen: a hidden one reads nothing, and catches up on return */
  visible: boolean;
  /** the poll chain running: one at a time */
  pollSeq: number;
}

/** Every PC and its sessions, as the server reads and pushes them. */
export interface MachinesState {
  list: Machine[];
  error: string | null;
  /** reads and pushes so far: a read counts only when nothing newer came while it ran */
  revision: number;
  /** a read after a burst of session changes waits */
  refetching: boolean;
  /** the selected pane the PC is being asked about, as the roster no longer lists it */
  checking: string | null;
}

/** The pane open in Main: its socket, and the lens the person chose in it. */
export interface PaneState {
  connected: boolean;
  /** the server stopped sending its output (output_stalled) until the socket is live again */
  outputStopped: boolean;
  /** the connection's role: the server's role-ack confirms it (no UI control today) */
  role: ClientRole;
  /** a lens chosen in the pane, kept here too for a browser that cannot store it; `key` names the pane and what decides its lens */
  lens: { key: string; view: PaneView } | null;
}

/** This device's alerts: the browser's permission, its push subscription, and what the pushes told so far. */
export interface AlertsState {
  permission: NotificationState;
  /** this browser can take push alerts (HTTPS or localhost, a service worker) */
  supported: boolean;
  /** this device has a push subscription: alerts come from the server, not the tab */
  push: boolean;
  /** each pane's last status seen, by alert key: the baseline that decides whether a push is news */
  statuses: Record<string, AgentStatus>;
  /** when each pane's turn began, so an alert knows a long turn from a quick one */
  turnStarts: Record<string, number>;
  /** how long each pane's last finished turn took: a pane that ends is told by it too */
  lastTurns: Record<string, number>;
  /** the registration asked last: an answer to an older one is superseded */
  subscribeSeq: number;
}

/** What starting a session asks of a PC's herdr. */
export interface SessionRequest { cwd: string | null; label: string | null; agent: { kind: string } | null }

/** The new session dialog, on one PC: what is typed, and the start under way. */
export type NewSessionState =
  | { open: false }
  | {
    open: true;
    machineId: string;
    /** the opening it is: what an earlier one asked for answers too late */
    seq: number;
    agents: AgentKind[];
    /** "" starts a shell */
    agentKind: string;
    cwd: string;
    name: string;
    status: "editing" | "starting";
    error: { kind: "message"; message: string } | { kind: "invalid-cwd" } | null;
    /** a pane made although its agent did not start: the next submit opens it */
    createdPaneId: string | null;
  };

/** The command palette, on the selected pane's PC: the search typed, and the panes opened last there. */
export type PaletteState = { open: false } | { open: true; machineId: string; query: string; recent: string[] };

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
  connection: ConnectionState;
  machines: MachinesState;
  pane: PaneState;
  alerts: AlertsState;
  newSession: NewSessionState;
  palette: PaletteState;
  /** openings of the new session dialog so far */
  newSessionSeq: number;
  /** the phone's workspace drawer: a pane picked closes it, and an in-app alert shows for the open pane while it is open */
  drawerOpen: boolean;
}

export type UiEvent =
  | { type: "show-screen"; screen: Screen }
  /** the person picked a pane (sidebar, palette, notification, a new session) */
  | { type: "select-pane"; machineId: string; paneId: string | null }
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
  /** Settings turns alerts on again (permission, subscription, then a confirmation push) */
  | { type: "repair-alerts" }
  | { type: "push-tested"; result: Exclude<PushTest, "idle" | "sending">; session: number }
  | TreeEvent
  | ConnectionEvent
  | { type: "pane-connection"; connected: boolean }
  | { type: "output-stalled" }
  | { type: "role-ack"; role: ClientRole }
  /** `storageId`: where the pane's lens is kept; null with no pane selected */
  | { type: "choose-lens"; key: string; storageId: string | null; view: PaneView }
  | { type: "drawer"; open: boolean }
  | { type: "toggle-drawer" }
  /** the bell, or a shortcut: ask for the permission, subscribe, confirm with a push */
  | { type: "enable-alerts" }
  | { type: "disable-alerts" }
  | { type: "alerts-permission"; permission: NotificationState }
  /** `seq`: the registration it answers, null for the one turning alerts on */
  | { type: "push-subscribed"; on: boolean; seq: number | null }
  /** alerts turned on, or not: `session` when Settings asked */
  | { type: "alerts-enabled"; ok: boolean; session: number | null }
  /** `defaultCwd`: the selected pane's folder when it is on that PC */
  | { type: "open-new-session"; machineId: string; defaultCwd: string | null }
  | { type: "close-new-session" }
  | { type: "edit-new-session"; field: "agentKind" | "cwd" | "name"; value: string }
  | { type: "submit-new-session" }
  /** `remembered`: the agent chosen last on this device */
  | { type: "new-session-agents"; agents: AgentKind[]; remembered: string; seq: number }
  | { type: "new-session-agents-failed"; message: string; seq: number }
  /** `agentError`: why the agent asked for did not start; the pane exists all the same */
  | { type: "new-session-created"; paneId: string; agentError: string | null; seq: number }
  | { type: "new-session-failed"; message: string; invalidCwd: boolean; seq: number }
  | { type: "open-palette" }
  | { type: "close-palette" }
  | { type: "palette-query"; text: string }
  | { type: "palette-recent"; machineId: string; recent: string[] }
  /** a pane picked in the palette: it opens, and the palette closes */
  | { type: "palette-pick"; paneId: string };

/** The server, as this page reads it and is pushed by it. */
export type ConnectionEvent =
  /** the page loaded: `linkToken` from a bookmarked `#auth=` link, `pairCode` from a scanned QR, what the browser allows of alerts */
  | { type: "boot"; linkToken: string | null; pairCode?: string; alerts?: { permission: NotificationState; supported: boolean }; visible?: boolean }
  | { type: "poll"; seq: number }
  | { type: "visibility"; visible: boolean }
  | { type: "authenticated"; reason: "boot" | "link" }
  | { type: "authentication-failed"; reason: "boot" | "link" }
  /** the auth link pasted into an open tab */
  | { type: "auth-link"; token: string }
  /** the access gate let this browser in */
  | { type: "unlocked" }
  | { type: "access-loaded"; auth: HealthAuth }
  | { type: "health-loaded"; health: HealthInfo }
  | { type: "health-failed" }
  | { type: "machines-loaded"; machines: Machine[]; revision: number }
  | { type: "machines-failed"; message: string; unauthorized: boolean; revision: number }
  /** Retry, or Refresh */
  | { type: "reload-machines" }
  | { type: "refetch-machines" }
  | { type: "stream-opened" }
  | { type: "machines-pushed"; machines: Machine[] }
  /** `at`: when it arrived, to time a pane's turn */
  | { type: "machine-message"; machineId: string; message: ServerMessage; at?: number }
  | { type: "paired-from-address" }
  | { type: "sign-out" }
  | { type: "signed-out" }
  | { type: "pane-session-read"; machineId: string; paneId: string; session: SessionSnapshot }
  | { type: "pane-session-failed"; machineId: string; paneId: string };

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
  | { kind: "tree-request"; machineId: string; request: TreeRequest; viaConfirm: boolean; revert: ShownOrder | null }
  /** this browser's access, then the server's health */
  | { kind: "load-health" }
  | { kind: "load-machines"; revision: number }
  | { kind: "authenticate"; token: string; reason: "boot" | "link" }
  | { kind: "pair-from-address"; code: string }
  | { kind: "sign-out" }
  /** the stream of every PC's changes */
  | { kind: "open-stream" }
  | { kind: "close-stream" }
  /** ask the PC itself whether the selected pane closed: the roster can lag a pane just made */
  | { kind: "confirm-pane-gone"; machineId: string; paneId: string }
  | { kind: "store-lens"; storageId: string; view: PaneView }
  /** permission, subscription, confirmation push; `session` when Settings asked */
  | { kind: "enable-alerts"; prefs: AlertPrefs; session: number | null }
  | { kind: "remove-push" }
  | { kind: "subscribe-push"; prefs: AlertPrefs; seq: number }
  /** an in-app alert; `machineName` only when there are several PCs */
  | { kind: "drop-in"; machineId: string; machineName: string | null; pane: HerdrPane; alert: DropletKind }
  | { kind: "load-agents"; machineId: string; seq: number }
  /** the panes opened last on a PC, for the palette */
  | { kind: "load-recent"; machineId: string }
  | { kind: "remember-pane"; machineId: string; paneId: string }
  | { kind: "remember-agent"; agentKind: string }
  | { kind: "create-session"; machineId: string; request: SessionRequest; seq: number }
  /** the tab's own alert */
  | { kind: "notify-pane"; machineId: string; machineName: string; pane: HerdrPane; status: "blocked" | "done" | "ended" };

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
  connection: { locked: null, reason: null, auth: null, health: null, pairCode: "", pairing: "none", visible: true, pollSeq: 0 },
  machines: { list: [], error: null, revision: 0, refetching: false, checking: null },
  pane: { connected: false, outputStopped: false, role: "interact", lens: null },
  alerts: { permission: "default", supported: false, push: false, statuses: {}, turnStarts: {}, lastTurns: {}, subscribeSeq: 0 },
  drawerOpen: false,
  newSession: { open: false },
  palette: { open: false },
  newSessionSeq: 0,
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
  return followUp(state, transitionOnly(state, event));
}

function transitionOnly(state: UiState, event: UiEvent): Transition {
  const effects: Effect[] = [];
  // an event that changes nothing keeps the state object itself, so nobody re-renders for it
  const next = (patch: Partial<UiState>): Transition =>
    ({ state: (Object.keys(patch) as Array<keyof UiState>).every((key) => patch[key] === state[key]) ? state : { ...state, ...patch }, effects });
  switch (event.type) {
    case "show-screen":
      return next({ screen: event.screen, detail: event.screen === "pane" ? null : state.detail });
    case "select-pane":
      return next({ screen: "pane", detail: null, ...pick(state, event.machineId, event.paneId, effects) });
    case "pane-connection":
      return next({ pane: { ...state.pane, connected: event.connected, outputStopped: event.connected ? false : state.pane.outputStopped } });
    case "output-stalled":
      return next({ pane: { ...state.pane, outputStopped: true } });
    case "role-ack":
      return next(state.pane.role === event.role ? {} : { pane: { ...state.pane, role: event.role } });
    case "choose-lens":
      if (event.storageId !== null) effects.push({ kind: "store-lens", storageId: event.storageId, view: event.view });
      return next({ pane: { ...state.pane, lens: { key: event.key, view: event.view } }, selection: state.selection.auto ? { ...state.selection, auto: false } : state.selection });
    case "open-new-session":
    case "close-new-session":
    case "edit-new-session":
    case "submit-new-session":
    case "new-session-agents":
    case "new-session-agents-failed":
    case "new-session-created":
    case "new-session-failed":
      return newSessionTransition(state, event, effects);
    case "open-palette":
      effects.push({ kind: "load-recent", machineId: state.selection.machineId });
      return next({ palette: { open: true, machineId: state.selection.machineId, query: "", recent: [] } });
    case "close-palette":
      return next(state.palette.open ? { palette: { open: false } } : {});
    case "palette-query":
      return next(state.palette.open ? { palette: { ...state.palette, query: event.text } } : {});
    case "palette-recent":
      return next(state.palette.open && state.palette.machineId === event.machineId ? { palette: { ...state.palette, recent: event.recent } } : {});
    case "palette-pick":
      if (!state.palette.open) return next({});
      return next({ screen: "pane", detail: null, palette: { open: false }, ...pick(state, state.palette.machineId, event.paneId, effects) });
    case "drawer":
      return next({ drawerOpen: event.open });
    case "toggle-drawer":
      return next({ drawerOpen: !state.drawerOpen });
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
      return next({ screen: "pane", detail: null, ...pick(state, "local", run.paneId, effects) });
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
    case "repair-alerts":
      if (!state.settingsDialog.open || state.pushTest === "sending") return next({});
      effects.push({ kind: "enable-alerts", prefs: alertPrefs(state.settings), session: state.settingsSession });
      return next({ pushTest: "sending" });
    case "enable-alerts":
      effects.push({ kind: "enable-alerts", prefs: alertPrefs(state.settings), session: null });
      return next({});
    case "disable-alerts":
      // the browser's permission cannot be taken back from the page: off drops the subscription and silences the tab
      effects.push({ kind: "remove-push" });
      // a registration still on its way answers a choice no longer there
      return next({ ...change(state, { alertsOn: false }, effects), alerts: { ...state.alerts, push: false, subscribeSeq: state.alerts.subscribeSeq + 1 } });
    case "alerts-permission": {
      const alerts = { ...state.alerts, permission: event.permission };
      return next({ ...(event.permission === "granted" ? change(state, { alertsOn: true }, effects) : {}), alerts });
    }
    case "push-subscribed":
      if (event.seq !== null && event.seq !== state.alerts.subscribeSeq) return next({});
      return next(state.alerts.push === event.on ? {} : { alerts: { ...state.alerts, push: event.on } });
    case "alerts-enabled":
      if (event.session === null || !state.settingsDialog.open || event.session !== state.settingsSession) return next({});
      return next({ pushTest: event.ok ? "sent" : "failed" });
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
    case "boot":
    case "poll":
    case "visibility":
    case "authenticated":
    case "authentication-failed":
    case "auth-link":
    case "unlocked":
    case "access-loaded":
    case "health-loaded":
    case "health-failed":
    case "machines-loaded":
    case "machines-failed":
    case "reload-machines":
    case "refetch-machines":
    case "stream-opened":
    case "machines-pushed":
    case "machine-message":
    case "paired-from-address":
    case "sign-out":
    case "signed-out":
    case "pane-session-read":
    case "pane-session-failed":
      return connectionTransition(state, event, effects);
    case "remote-access-failed":
      return next({ remoteAccess: settleAccess(state.remoteAccess, { status: "error", data: null, error: event.message }, effects) });
  }
}

function devicesTransition(devices: DevicesState, event: UiEvent, session: number, effects: Effect[]): DevicesState {
  switch (event.type) {
    case "devices-loaded": {
      // the first read is what was there already; after it, a device not seen before has just paired
      const known = devices.known;
      const paired = known === null ? undefined : event.devices.filter((device) => !known.includes(device.id)).at(-1);
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

/** The pane to show on a PC when none is, or the one shown closed: herdr's focused one, else the first. */
function fallbackPane(snapshot: SessionSnapshot): string | null {
  return snapshot.panes.find((pane) => pane.pane_id === snapshot.focused_pane_id)?.pane_id ?? snapshot.panes[0]?.pane_id ?? null;
}

/** Data the same as before keeps its object, so nobody re-renders for a read that changed nothing. */
function same<T>(previous: T, next: T): T {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

function connectionTransition(state: UiState, event: ConnectionEvent, effects: Effect[]): Transition {
  const { connection, machines } = state;
  const next = (patch: Partial<UiState>): Transition => ({ state: { ...state, ...patch }, effects });
  const readMachines = (): MachinesState => {
    const revision = machines.revision + 1;
    effects.push({ kind: "load-machines", revision });
    return { ...machines, revision };
  };
  /** read health, and the PCs too unless this browser is locked out (it only watches health then) */
  const read = (): Partial<UiState> => {
    effects.push({ kind: "load-health" });
    return connection.locked === true ? {} : { machines: readMachines() };
  };
  const startPolling = (): Transition => {
    const pollSeq = connection.pollSeq + 1;
    // a tab loaded in the background reads nothing until it shows
    const patch = connection.visible ? read() : {};
    effects.push({ kind: "later", ms: POLL_MS, event: { type: "poll", seq: pollSeq } });
    return next({ ...patch, connection: { ...connection, pollSeq } });
  };
  switch (event.type) {
    case "boot": {
      const booted = { ...state, connection: { ...connection, pairCode: event.pairCode ?? "", visible: event.visible ?? connection.visible }, alerts: event.alerts ? { ...state.alerts, ...event.alerts } : state.alerts };
      if (event.linkToken === null) return connectionTransition(booted, { type: "authentication-failed", reason: "boot" }, effects);
      effects.push({ kind: "authenticate", token: event.linkToken, reason: "boot" });
      return { state: booted, effects };
    }
    case "authenticated":
    case "authentication-failed":
      if (event.reason === "boot") return startPolling();
      return event.type === "authenticated" ? connectionTransition(state, { type: "unlocked" }, effects) : next({});
    case "poll": {
      if (event.seq !== connection.pollSeq) return next({});
      const patch = connection.visible ? read() : {};
      effects.push({ kind: "later", ms: POLL_MS, event: { type: "poll", seq: event.seq } });
      return next(patch);
    }
    case "visibility":
      // each time the page shows (again), it catches up at once
      return next({ ...(event.visible ? read() : {}), connection: connection.visible === event.visible ? connection : { ...connection, visible: event.visible } });
    case "auth-link":
      effects.push({ kind: "authenticate", token: event.token, reason: "link" });
      return next({});
    case "unlocked":
      effects.push({ kind: "load-health" });
      return next({ connection: { ...connection, locked: false }, machines: readMachines() });
    case "access-loaded": {
      const auth = connection.auth === null ? event.auth : same(connection.auth, event.auth);
      const locked = auth.required && !auth.authenticated;
      let pairing = connection.pairing;
      // a device already in (token, Tailscale) still pairs from the QR code's address
      if (!locked && connection.pairCode !== "" && pairing === "none" && auth.via !== "device") {
        pairing = "asked";
        effects.push({ kind: "pair-from-address", code: connection.pairCode });
      }
      // a paired watch-only device sees the fleet but changes nothing in it
      return next({ connection: { ...connection, auth, locked, reason: auth.reason ?? null, pairing }, canAct: auth.role !== "watch" });
    }
    case "health-loaded":
      return next({ connection: { ...connection, health: same(connection.health, event.health) } });
    case "health-failed":
      return next(connection.health === null ? {} : { connection: { ...connection, health: null } });
    case "machines-loaded":
      if (event.revision !== machines.revision) return next({});
      return next({ machines: { ...machines, list: same(machines.list, event.machines), error: null }, connection: connection.locked === false ? connection : { ...connection, locked: false } });
    case "machines-failed":
      if (event.revision !== machines.revision) return next({});
      if (event.unauthorized) return next({ connection: { ...connection, locked: true } });
      return next({ machines: { ...machines, error: event.message } });
    case "reload-machines":
      return next({ machines: readMachines() });
    case "refetch-machines":
      return next({ machines: connection.locked === true ? { ...machines, refetching: false } : { ...readMachines(), refetching: false } });
    case "stream-opened":
      // the stream opened, or opened again: fleet changes made meanwhile never arrived as pushes
      return transitionOnly(state, { type: "fleet-changed" });
    case "machines-pushed": {
      // each pane's status as pushed is the baseline its next change is news against
      const statuses = { ...state.alerts.statuses };
      for (const machine of event.machines) for (const pane of machine.snapshot?.panes ?? []) statuses[alertKey(machine.id, pane.pane_id)] = pane.agent_status;
      // a read started before this push can carry an older roster
      return next({ machines: { ...machines, list: same(machines.list, event.machines), revision: machines.revision + 1 }, alerts: { ...state.alerts, statuses } });
    }
    case "machine-message": {
      const machine = machines.list.find((candidate) => candidate.id === event.machineId);
      if (!machine) return next({});
      const message = event.message;
      let list = machines.list;
      let refetching = machines.refetching;
      if (message.type === "pane-status" && machine.snapshot) {
        const snapshot = applyPaneStatus(machine.snapshot, message.pane_id, message.agent_status, message.background_tasks);
        if (snapshot !== machine.snapshot) list = list.map((candidate) => (candidate === machine ? { ...machine, snapshot } : candidate));
      }
      if ((message.type === "session-changed" || message.type === "pane-exited") && !refetching) {
        refetching = true;
        effects.push({ kind: "later", ms: REFETCH_DEBOUNCE_MS, event: { type: "refetch-machines" } });
      }
      const pushed: UiState = { ...state, machines: { ...machines, list, refetching, revision: machines.revision + 1 }, alerts: alertOn(state, machine, message, event.at ?? 0, effects) };
      // the fleet lives on this PC's server only
      if (message.type === "fleet-changed" && machine.kind === "local") return transitionOnly(pushed, { type: "fleet-changed" });
      return { state: pushed, effects };
    }
    case "paired-from-address":
      effects.push({ kind: "load-health" });
      return next({});
    case "sign-out":
      // the subscription goes first, while the cookie still lets it: a device locked out must stop receiving pane titles
      effects.push({ kind: "sign-out" });
      return next({ drawerOpen: false, alerts: { ...state.alerts, push: false, subscribeSeq: state.alerts.subscribeSeq + 1 } });
    case "signed-out":
      // the cookie may still be set: the health answer decides whether the gate shows
      effects.push({ kind: "load-health" });
      return next({});
    case "pane-session-read": {
      const asked = `${event.machineId}\n${event.paneId}`;
      const cleared = { ...machines, checking: machines.checking === asked ? null : machines.checking };
      const { selection } = state;
      if (selection.machineId !== event.machineId || selection.paneId !== event.paneId || event.session.panes.some((pane) => pane.pane_id === event.paneId)) return next({ machines: cleared });
      return next({ machines: cleared, selection: select(event.machineId, fallbackPane(event.session), true, effects) });
    }
    case "pane-session-failed": {
      // a failed read is not evidence that the pane disappeared
      const asked = `${event.machineId}\n${event.paneId}`;
      return next(machines.checking === asked ? { machines: { ...machines, checking: null } } : {});
    }
  }
}

/** Where a pane's alert records live: its PC and id. */
const alertKey = (machineId: string, paneId: string): string => paneStorageId(machineId, paneId);

/**
 * What a pushed pane change tells: an in-app alert while the app is on screen (never for the pane
 * open in front of the person, unless the drawer covers it), and the tab's own while this device
 * has no push subscription to bring it. The pane's last status, its turn's start and its last
 * turn's length are kept to decide whether the change is news and how long the turn was.
 */
function alertOn(state: UiState, machine: Machine, message: ServerMessage, at: number, effects: Effect[]): AlertsState {
  const { alerts, settings } = state;
  if (message.type !== "pane-status" && message.type !== "pane-exited") return alerts;
  const key = alertKey(machine.id, message.pane_id);
  const pane = machine.snapshot?.panes.find((candidate) => candidate.pane_id === message.pane_id) as HerdrPane | undefined;
  const prefs = alertPrefs(settings);
  const started = new Map(Object.entries(alerts.turnStarts));
  const lasted = new Map(Object.entries(alerts.lastTurns));
  const statuses = { ...alerts.statuses };
  const open = state.selection.machineId === machine.id && state.selection.paneId === message.pane_id && !state.drawerOpen;
  const dropsIn = settings.alertsOn && settings.alertInApp && state.connection.visible && !open;
  const tabTells = settings.alertsOn && !alerts.push;
  const machineName = state.machines.list.length > 1 ? machine.name : null;
  if (message.type === "pane-status") {
    const previous = statuses[key];
    statuses[key] = message.agent_status;
    const worked = trackTurn(started, key, previous, message.agent_status, at);
    if (worked !== null) lasted.set(key, worked);
    if (pane && shouldNotifyStatus(previous, message.agent_status)) {
      const alert = message.agent_status === "blocked" ? "blocked" : "done";
      if (dropsIn && dropletAllows(prefs, message.agent_status, worked)) effects.push({ kind: "drop-in", machineId: machine.id, machineName, pane, alert });
      if (tabTells && alertsAllow(prefs, message.agent_status)) effects.push({ kind: "notify-pane", machineId: machine.id, machineName: machine.name, pane, status: alert });
    }
  } else {
    const worked = endedTurn(started, lasted, key, at);
    if (pane && dropsIn && dropletAllows(prefs, "done", worked)) effects.push({ kind: "drop-in", machineId: machine.id, machineName, pane, alert: "ended" });
    if (pane && tabTells && prefs.done !== "off") effects.push({ kind: "notify-pane", machineId: machine.id, machineName: machine.name, pane, status: "ended" });
  }
  return { ...alerts, statuses, turnStarts: Object.fromEntries(started), lastTurns: Object.fromEntries(lasted) };
}

/** This device's push subscription is registered whenever it may be: in, allowed, alerts on, push there; again as its choice of alerts changes. */
function subscriptionKey(state: UiState): string | null {
  const { connection, alerts, settings } = state;
  if (connection.locked !== false || alerts.permission !== "granted" || !settings.alertsOn || !alerts.supported) return null;
  return JSON.stringify(alertPrefs(settings));
}

/**
 * What follows from any step: the event stream runs while this browser is in, and a selected
 * pane the roster no longer lists is looked into (or, with none selected, herdr's focused one taken).
 */
function followUp(before: UiState, step: Transition): Transition {
  let { state } = step;
  const effects = [...step.effects];
  if (before.connection.locked !== false && state.connection.locked === false) effects.push({ kind: "open-stream" });
  if (before.connection.locked === false && state.connection.locked !== false) effects.push({ kind: "close-stream" });
  // the panes opened last, as the palette offers them: each one selected, however it was picked
  if (state.selection.paneId !== null && (state.selection.paneId !== before.selection.paneId || state.selection.machineId !== before.selection.machineId)) {
    effects.push({ kind: "remember-pane", machineId: state.selection.machineId, paneId: state.selection.paneId });
  }
  const subscription = subscriptionKey(state);
  if (subscription !== null && subscription !== subscriptionKey(before)) {
    const subscribeSeq = state.alerts.subscribeSeq + 1;
    effects.push({ kind: "subscribe-push", prefs: alertPrefs(state.settings), seq: subscribeSeq });
    state = { ...state, alerts: { ...state.alerts, subscribeSeq } };
  }
  const selectedPc = (of: UiState) => of.machines.list.find((candidate) => candidate.id === of.selection.machineId);
  const machine = selectedPc(state);
  // only the selected PC's sessions, or the selection itself, say anything about the selected pane
  if (state.selection !== before.selection || machine?.snapshot !== selectedPc(before)?.snapshot || machine?.state !== selectedPc(before)?.state) {
    const { selection } = state;
    // an offline PC's cached roster cannot invalidate a selection
    if (machine?.snapshot && machine.state === "connected" && !machine.snapshot.panes.some((pane) => pane.pane_id === selection.paneId)) {
      if (selection.paneId === null) {
        const paneId = fallbackPane(machine.snapshot);
        if (paneId !== null) state = { ...state, selection: select(selection.machineId, paneId, selection.auto, effects) };
      } else {
        const asked = `${selection.machineId}\n${selection.paneId}`;
        if (state.machines.checking !== asked) {
          effects.push({ kind: "confirm-pane-gone", machineId: selection.machineId, paneId: selection.paneId });
          state = { ...state, machines: { ...state.machines, checking: asked } };
        }
      }
    }
  }
  return state === step.state && effects.length === step.effects.length ? step : { state, effects };
}

type NewSessionEvent = Extract<UiEvent, { type: "open-new-session" | "close-new-session" | "edit-new-session" | "submit-new-session" | "new-session-agents" | "new-session-agents-failed" | "new-session-created" | "new-session-failed" }>;

function newSessionTransition(state: UiState, event: NewSessionEvent, effects: Effect[]): Transition {
  // an event that changes nothing keeps the state object itself
  const next = (patch: Partial<UiState>): Transition => ({ state: Object.keys(patch).length === 0 ? state : { ...state, ...patch }, effects });
  if (event.type === "open-new-session") {
    const seq = state.newSessionSeq + 1;
    effects.push({ kind: "load-agents", machineId: event.machineId, seq });
    return next({
      newSessionSeq: seq,
      drawerOpen: false,
      newSession: { open: true, machineId: event.machineId, seq, agents: [], agentKind: "", cwd: event.defaultCwd ?? "", name: "", status: "editing", error: null, createdPaneId: null },
    });
  }
  const dialog = state.newSession;
  if (!dialog.open || ("seq" in event && event.seq !== dialog.seq)) return next({});
  /** the session it started is open: its pane selected, the dialog gone, the PCs read again */
  const opened = (paneId: string): Transition => {
    const picked = { ...state, ...pick(state, dialog.machineId, paneId, effects), newSession: { open: false } as const };
    return connectionTransition(picked, { type: "reload-machines" }, effects);
  };
  switch (event.type) {
    case "close-new-session":
      return next(dialog.status === "starting" ? {} : { newSession: { open: false } });
    case "edit-new-session":
      if (dialog.status === "starting" || dialog.createdPaneId !== null) return next({});
      return next({ newSession: { ...dialog, [event.field]: event.value } });
    case "submit-new-session": {
      if (dialog.status === "starting") return next({});
      if (dialog.createdPaneId !== null) return opened(dialog.createdPaneId);
      effects.push(
        { kind: "remember-agent", agentKind: dialog.agentKind },
        { kind: "create-session", machineId: dialog.machineId, seq: dialog.seq, request: { cwd: dialog.cwd.trim() || null, label: dialog.name.trim() || null, agent: dialog.agentKind ? { kind: dialog.agentKind } : null } },
      );
      return next({ newSession: { ...dialog, status: "starting", error: null } });
    }
    case "new-session-agents":
      return next({ newSession: { ...dialog, agents: event.agents, agentKind: event.agents.some((agent) => agent.kind === event.remembered) ? event.remembered : "" } });
    case "new-session-agents-failed":
      return next({ newSession: { ...dialog, error: { kind: "message", message: event.message } } });
    case "new-session-created":
      if (dialog.agentKind && event.agentError !== null) {
        return next({ newSession: { ...dialog, status: "editing", error: { kind: "message", message: event.agentError }, createdPaneId: event.paneId } });
      }
      return opened(event.paneId);
    case "new-session-failed":
      return next({ newSession: { ...dialog, status: "editing", error: event.invalidCwd ? { kind: "invalid-cwd" } : { kind: "message", message: event.message } } });
  }
}

/**
 * A pane the person picked: selected and kept, the drawer closed, a stalled output forgotten,
 * and the socket no longer live when the pane is on another PC (only that mounts a new one).
 */
function pick(state: UiState, machineId: string, paneId: string | null, effects: Effect[]): Pick<UiState, "selection" | "drawerOpen" | "pane"> {
  const otherPc = machineId !== state.selection.machineId;
  return {
    selection: select(machineId, paneId, false, effects),
    drawerOpen: false,
    pane: { ...state.pane, outputStopped: false, connected: otherPc ? false : state.pane.connected },
  };
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
