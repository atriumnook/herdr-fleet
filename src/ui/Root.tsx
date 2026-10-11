import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { App } from "../App.tsx";
import { ApiError, answerPanePrompt, explainPaneQuestion, createWorkspace, uploadPaneImage, fetchPaneCommands, fetchPaneFiles, fetchPaneConversation, fetchPanePromptState, fetchPaneTranscript, fetchDirectories, fetchFileInfo, fetchFileStart, fetchAgentKinds, sendTestPush, authenticate, fetchBridgeHealth, fetchHealth, fetchMachines, fetchSession, pairDevice, signOut, clearFleetCooldown, closePane, closeWorkspace, moveWorkspace, renamePane, renameWorkspace, closeDoneFleetRuns, fetchDevices, fetchFleetDiff, fetchFleetLanding, fetchFleetRuns, fetchFleetSettings, landFleetRun, saveFleetSettings, fetchFleetUsage, fetchRemoteAccess, interruptFleetRun, refreshFleetUsage, resolveFleetRun, startFleetProject, renameDevice, revokeDevice, startPairing } from "../lib/api.ts";
import { forgetPaneViews, loadSettings, PANE_VIEW_KEY_PREFIX, saveSettings, SettingsProvider, type Settings } from "../lib/settings.ts";
import { Mediator, type EffectPorts } from "./mediator.ts";
import { MediatorContext, useSelected } from "./presenter.ts";
import { ensurePushSubscription, pushSupported, removePushSubscription, testDevicePush } from "../lib/push.ts";
import { notificationState, requestNotificationPermission, showPaneEndedNotification, showPaneStatusNotification } from "../lib/notifications.ts";
import { onNotificationTarget } from "../lib/notificationTarget.ts";
import { displayPaneTitle } from "../components/Sidebar.tsx";
import { initialSelection, storeSelection } from "../lib/selection.ts";
import { loadRecentPanes, rememberPane } from "../lib/recentPanes.ts";
import { takeAuthTokenFromUrl } from "../lib/authLink.ts";
import { deviceLabel, takePairCode } from "../lib/phone.ts";
import { leavePreview, previewFromState, showPreview } from "../lib/fileHistory.ts";
import { HerdrSocket } from "../lib/ws.ts";
import { cachedPaneCommands, readSlashUsage, saveSlashUsage } from "../lib/completionStore.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { EMPTY_DRAFT, draftIsEmpty } from "../lib/draft.ts";
import { messageQueues, QUEUE_KEY_PREFIX } from "../lib/messageQueue.ts";
import { COMPOSER_DRAFT_KEY_PREFIX, composerDrafts } from "../lib/composerDraft.ts";
import { acknowledgeTerminalDraft, readTerminalDraft, setTerminalDraftSending, terminalDraftSending, writeTerminalDraft } from "../lib/terminalDraft.ts";
import { INITIAL_STATE, type ConversationOutcome } from "./state.ts";
import type { ConversationTurn } from "../../shared/protocol.ts";
import type { ConversationPageQuery } from "../lib/api.ts";

/** A 401 is the server refusing what the gate sent; anything else stays an error. */
function refusedOr(error: unknown): "refused" {
  if (error instanceof ApiError && error.status === 401) return "refused";
  throw error;
}

/** A read of a conversation page, as the state machine takes it: the page, or why not (409: the transcript was replaced). */
async function conversationPage(paneId: string, machineId: string, page: ConversationPageQuery): Promise<ConversationOutcome> {
  try {
    return { kind: "ok", conversation: await fetchPaneConversation(paneId, machineId, page) };
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error), status: error instanceof ApiError ? error.status : null };
  }
}

/** the most pages a gap between the held start and the newest page is read in */
const GAP_PAGES = 32;

/** the input held for a pane on this device, by the pane's storage id */
const DRAFT_KEY_PREFIX = "herdr-fleet:terminal-draft:";

/** the agent a new session starts with, as chosen last on this device */
const LAST_AGENT_KEY = "herdr-fleet:new-session-agent";

/** The Mediator's effects against this PC's server and this browser's storage. */
export const FLEET_PORTS: EffectPorts = {
  loadRuns: fetchFleetRuns,
  loadUsage: fetchFleetUsage,
  refreshUsage: refreshFleetUsage,
  runRequest: async (action) => {
    if (action.kind === "interrupt") await interruptFleetRun(action.runId);
    else if (action.kind === "close-done") await closeDoneFleetRuns(action.group);
    else if (action.kind === "start-project") await startFleetProject(action.task, action.cwd);
    else if (action.kind === "resolve") await resolveFleetRun(action.runId, action.resolved);
    else if (action.kind === "land") await landFleetRun(action.runId, action.action, action.comments);
    else await clearFleetCooldown(action.key);
  },
  loadLandingDiff: fetchFleetDiff,
  loadLandingChecks: fetchFleetLanding,
  loadFleetSettings: fetchFleetSettings,
  saveFleetSettings,
  saveSettings,
  forgetPaneViews: () => void forgetPaneViews(),
  loadRemoteAccess: fetchRemoteAccess,
  // the demo, or an older server, has no device list (404)
  loadDevices: () => fetchDevices().catch((error: unknown) => { if (error instanceof ApiError && error.status === 404) return null; throw error; }),
  startPairing,
  renameDevice: async (id, label) => { await renameDevice(id, label); },
  revokeDevice,
  later: (ms, then) => { window.setTimeout(then, ms); },
  storeSelection,
  // a subscription the server no longer has is what the test is for: it says so, not that it failed
  testPush: () => testDevicePush().catch((error: unknown) => { if (error instanceof ApiError && error.code === "subscription_not_found") return "missing" as const; throw error; }),
  treeRequest: async (machineId, request) => {
    if (request.kind === "close-pane") await closePane(request.paneId, machineId);
    else if (request.kind === "close-workspace") await closeWorkspace(request.workspaceId, machineId);
    else if (request.kind === "rename-pane") await renamePane(request.paneId, request.label, machineId);
    else if (request.kind === "rename-workspace") await renameWorkspace(request.workspaceId, request.label, machineId);
    else await moveWorkspace(request.workspaceId, request.index, machineId);
  },
  requestPermission: async () => (notificationState() === "granted" ? "granted" : await requestNotificationPermission()),
  subscribePush: ensurePushSubscription,
  confirmPush: sendTestPush,
  removePush: removePushSubscription,
  notifyPane: ({ machineId, machineName, pane, status }, open) => {
    const title = `${machineName} · ${displayPaneTitle(pane)}`;
    if (status === "ended") showPaneEndedNotification(pane.pane_id, title, open, machineId);
    else showPaneStatusNotification(pane.pane_id, title, status, open, machineId);
  },
  gatePair: (code) => pairDevice(code, deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0)).then(() => "ok" as const, refusedOr),
  gateAuthenticate: (token) => authenticate(token).then(() => "ok" as const, refusedOr),
  loadAgentKinds: fetchAgentKinds,
  loadRecent: loadRecentPanes,
  rememberPane,
  rememberedAgent: () => {
    try { return window.localStorage.getItem(LAST_AGENT_KEY) ?? ""; } catch { return ""; }
  },
  rememberAgent: (agentKind) => {
    try { window.localStorage.setItem(LAST_AGENT_KEY, agentKind); } catch { /* private mode: the choice simply is not remembered */ }
  },
  createSession: (machineId, request) => createWorkspace(request, machineId).catch((error: unknown) => {
    if (error instanceof ApiError && error.code === "invalid_cwd") return "invalid-cwd" as const;
    throw error;
  }),
  loadPromptState: (machineId, paneId) => fetchPanePromptState(paneId, machineId),
  answerPrompt: (machineId, answer) => answerPanePrompt(answer, machineId),
  explainQuestion: (machineId, request) => explainPaneQuestion(request, machineId).then(
    (response) => ({ kind: "ok" as const, response }),
    (error: unknown) => {
      if (!(error instanceof ApiError)) throw error;
      return { kind: "failed" as const, message: error.detail, limited: error.code === "usage_limited" };
    },
  ),
  uploadFile: (machineId, paneId, file) => uploadPaneImage(paneId, file, machineId),
  loadCommands: (machineId, paneId) => cachedPaneCommands(paneStorageId(machineId, paneId), () => fetchPaneCommands(paneId, machineId)),
  loadSlashUsage: readSlashUsage,
  saveSlashUsage,
  searchFiles: (machineId, paneId, query) => fetchPaneFiles(paneId, query, 20, machineId),
  changeComposerDraft: (owner, change) => {
    const key = `${COMPOSER_DRAFT_KEY_PREFIX}${owner}`;
    let settled: { text: string; edited: boolean } | null = null;
    if (change.kind === "refresh") composerDrafts.refresh(key);
    else if (change.kind === "set") composerDrafts.set(key, change.text);
    else if (change.kind === "begin") composerDrafts.begin(key, change.sent);
    else if (change.kind === "end") composerDrafts.end(key);
    else if (change.kind === "settle") settled = composerDrafts.settle(key, change.sent);
    const { text, sending } = composerDrafts.read(key);
    return { text, sending, settled };
  },
  changeLineDraft: (owner, change) => {
    if (change.kind === "set") writeTerminalDraft(owner, change.text);
    else if (change.kind === "begin") setTerminalDraftSending(owner, true);
    else if (change.kind === "end") setTerminalDraftSending(owner, false);
    else if (change.kind === "acknowledge") acknowledgeTerminalDraft(owner);
    return { text: readTerminalDraft(owner), sending: terminalDraftSending(owner) };
  },
  changeQueue: (owner, change) => {
    if (change.kind === "refresh") messageQueues.refresh(owner);
    else if (change.kind === "add") messageQueues.add(owner, change.text);
    else if (change.kind === "edit") messageQueues.edit(owner, change.id, change.text);
    else if (change.kind === "remove") messageQueues.remove(owner, change.id);
    return { messages: messageQueues.read(owner), unsaved: messageQueues.isUnsaved(owner) };
  },
  readConversation: (machineId, paneId, page) => conversationPage(paneId, machineId, "before" in page ? { before: page.before } : page.from === null ? {} : { from: page.from }),
  // the pages back from where the newest page starts to the held start, never past it
  conversationBetween: async (machineId, paneId, held, start) => {
    const pages: ConversationTurn[][] = [];
    let before = start;
    try {
      for (let step = 0; step < GAP_PAGES && before !== held; step++) {
        const page = await fetchPaneConversation(paneId, machineId, { before, since: held });
        if (typeof page.cursor !== "string") return null;
        pages.unshift(page.turns);
        before = page.cursor;
      }
    } catch {
      return null;
    }
    return before === held ? pages.flat() : null;
  },
  readScrollback: async (machineId, paneId, lines) => {
    const read = await fetchPaneTranscript(paneId, lines, machineId);
    return { text: read.text, truncated: read.truncated === true };
  },
  loadDraft: (owner) => {
    try {
      const value = JSON.parse(localStorage.getItem(`${DRAFT_KEY_PREFIX}${owner}`) ?? "null");
      if (value && typeof value.text === "string" && Number.isInteger(value.droppedSpecial)) return value;
    } catch { /* unreadable: nothing held */ }
    return EMPTY_DRAFT;
  },
  saveDraft: (owner, value) => {
    try {
      if (draftIsEmpty(value)) localStorage.removeItem(`${DRAFT_KEY_PREFIX}${owner}`);
      else localStorage.setItem(`${DRAFT_KEY_PREFIX}${owner}`, JSON.stringify(value));
    } catch { /* private mode: the draft lives for this page only */ }
  },
  // the terminal's socket: one per PC shown, reconnecting by itself until closed
  openPaneSocket: (machineId, on) => {
    const socket = new HerdrSocket(`${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws?machine_id=${encodeURIComponent(machineId)}`);
    socket.on(on.message);
    socket.onDisconnect(on.disconnected);
    socket.connect();
    return socket;
  },
  // a bridge from before folder browsing has no such route (404)
  listFolders: (machineId, path, hidden, files) => fetchDirectories(path, hidden, machineId, files).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return { failure: "unsupported" as const };
    if (error instanceof ApiError && error.code === "invalid_cwd") return { failure: "invalid" as const };
    throw error;
  }),
  showPreview,
  leavePreview,
  loadFileInfo: (machineId, path, paneId) => fetchFileInfo(path, paneId, machineId).then(
    (read) => ("candidates" in read ? { kind: "candidates" as const, candidates: read.candidates } : { kind: "info" as const, info: read }),
    (error: unknown) => {
      if (error instanceof ApiError && error.code === "outside_roots") return { kind: "outside" as const };
      if (error instanceof ApiError && error.status === 404) return { kind: "missing" as const };
      throw error;
    },
  ),
  // only the first part of a text file travels
  loadFileText: (machineId, path, paneId) => fetchFileStart(path, paneId, machineId),
  listFolder: async (machineId, path, paneId) => (await fetchDirectories(path, false, machineId, true, paneId)).path,
  storeLens: (storageId, view) => {
    try { window.localStorage.setItem(`${PANE_VIEW_KEY_PREFIX}${storageId}`, view); } catch { /* private mode: the lens just stops being remembered */ }
  },
  loadAccess: fetchBridgeHealth,
  loadHealth: fetchHealth,
  loadMachines: () => fetchMachines().catch((error: unknown) => { if (error instanceof ApiError && error.status === 401) return "unauthorized" as const; throw error; }),
  authenticate,
  pairFromAddress: (code) => pairDevice(code, deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0)),
  // the subscription goes first, while the cookie still lets it
  signOut: async () => {
    await removePushSubscription().catch(() => undefined);
    await signOut();
  },
  loadSession: fetchSession,
  // one stream watches every PC, even when no pane is selected
  openStream: ({ opened, event }) => {
    const events = new EventSource("/api/machines/events");
    events.onopen = opened;
    events.onmessage = (message) => {
      let payload;
      try { payload = JSON.parse(message.data); } catch { return; }
      event(payload);
    };
    return () => events.close();
  },
};

/** Hands the settings the Mediator holds to the views that read them from context (`useSettings`). */
function SettingsFromMediator({ mediator, children }: { mediator: Mediator; children: ReactNode }) {
  const settings = useSelected((state) => state.settings);
  const change = useCallback((patch: Partial<Settings>) => mediator.dispatch({ type: "change-settings", patch }), [mediator]);
  return <SettingsProvider settings={settings} onChange={change}>{children}</SettingsProvider>;
}

/**
 * The top of the component hierarchy: it owns the Mediator and provides it to the Presenters
 * below, each of which reads only the regions its view draws. Events bubble up to the Mediator
 * through the Emit each parent hands down. The legacy shell (App) is a child like any other; it
 * moves to Passive Views one part at a time.
 */
export function Root() {
  const mediator = useMemo(() => new Mediator(FLEET_PORTS, { ...INITIAL_STATE, settings: loadSettings(), selection: { ...initialSelection(), auto: false } }), []);
  // the pane a notification's address named is this window's from now on
  useEffect(() => {
    const { machineId, paneId } = mediator.getState().selection;
    storeSelection(machineId, paneId);
    // and the palette offers it first
    if (paneId !== null) rememberPane(machineId, paneId);
  }, [mediator]);
  // the page starts reading the server once: a bookmarked `#auth=` link and a scanned QR's code
  // are taken off the address as it does (twice would find them gone)
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    mediator.dispatch({ type: "boot", linkToken: takeAuthTokenFromUrl(), pairCode: takePairCode(), alerts: { permission: notificationState(), supported: pushSupported() }, visible: document.visibilityState !== "hidden" });
  }, [mediator]);
  useEffect(() => {
    // a hidden tab (or a phone app in the background) reads nothing; it catches up on return
    const onVisibility = (): void => mediator.dispatch({ type: "visibility", visible: document.visibilityState !== "hidden" });
    // another tab changed a pane's held messages...
    const onStorage = (event: StorageEvent): void => {
      if (event.key?.startsWith(QUEUE_KEY_PREFIX)) mediator.dispatch({ type: "queue-stored", owner: event.key.slice(QUEUE_KEY_PREFIX.length) });
      // ...or the text typed in a pane's composer
      if (event.key?.startsWith(COMPOSER_DRAFT_KEY_PREFIX)) mediator.dispatch({ type: "composer-draft", owner: event.key.slice(COMPOSER_DRAFT_KEY_PREFIX.length), change: { kind: "refresh" } });
    };
    window.addEventListener("storage", onStorage);
    // pasting the auth link into an open tab navigates the fragment alone: no reload, so no boot
    const onHashChange = (): void => {
      const token = takeAuthTokenFromUrl();
      if (token !== null) mediator.dispatch({ type: "auth-link", token });
    };
    // Back and Forward move between the chat and a file's entry: Forward (or a reload) restores the file with its PC and pane
    const onHistory = (event: PopStateEvent): void => mediator.dispatch({ type: "file-history", preview: previewFromState(event.state) });
    // the in-app alert goes with a fade when the device asks for less motion
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    const onMotion = (): void => mediator.dispatch({ type: "motion-preference", reduced: motion?.matches === true });
    onMotion();
    motion?.addEventListener?.("change", onMotion);
    mediator.dispatch({ type: "file-history", preview: previewFromState(window.history.state) });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("popstate", onHistory);
    // a tapped notification focuses this window and names the pane (public/sw.js)
    const offTarget = onNotificationTarget((target) => mediator.dispatch({ type: "select-pane", machineId: target.machine_id, paneId: target.pane_id }));
    return () => {
      offTarget();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("popstate", onHistory);
      window.removeEventListener("storage", onStorage);
      motion?.removeEventListener?.("change", onMotion);
    };
  }, [mediator]);
  return (
    <MediatorContext.Provider value={mediator}>
      <SettingsFromMediator mediator={mediator}><App emit={mediator.dispatch} /></SettingsFromMediator>
    </MediatorContext.Provider>
  );
}
