import type { AgentRun, FleetEntrance, FleetEntrances, FleetSettings, FleetSettingsPatch, LandAction, LandingChecks, LineComment, UsageEntry } from "../../shared/fleet.ts";
import { LOCAL_MACHINE, paneStorageId, type Machine } from "../../shared/machines.ts";
import { shouldNotifyStatus, type AlertPrefs } from "../../shared/notify-policy.ts";
import type { AccessRefusal, AgentKind, AgentStatus, ClientRole, SlashCommand, ConversationMetadata, ConversationResponse, ConversationTurn, DirectoryListing, FileInfo, InteractivePrompt, HerdrPane, HealthAuth, PairedDevice, PairingCode, RemoteAccess, ServerMessage, SessionSnapshot } from "../../shared/protocol.ts";
import type { HealthInfo } from "../lib/api.ts";
import type { PaneView } from "../lib/actions.ts";
import type { FilePreview } from "../lib/fileHistory.ts";
import { DROPLET_EXIT_MS, DROPLET_EXIT_REDUCED_MS, DROPLET_HOLD_MS, DROPLET_REPEAT_MS, DROPLET_REVEAL_MS, dropletAllows, endedTurn, trackTurn, type DropletNotice } from "../lib/droplet.ts";
import type { NotificationState } from "../lib/notifications.ts";
import { applyPaneStatus } from "../lib/snapshot.ts";
import { EMPTY_DRAFT, applyToDraft, type InputDraft } from "../lib/draft.ts";
import { answerFromText, needsConfirmation, type TypedAnswer } from "../lib/promptAnswer.ts";
import { composerMessage, composerPayload } from "../lib/compose.ts";
import { toTranscriptMessages, type TranscriptMessage } from "../lib/transcript.ts";
import { statusEdgeRead } from "../lib/status.ts";
import type { HeldMessage } from "../lib/messageQueue.ts";
import { sanitizeFontFamily } from "../lib/fontFamily.ts";
import { alertPrefs, DEFAULT_SETTINGS, sanitizeSettings, type DefaultView, type Settings } from "../lib/settings.ts";

/**
 * The Root Mediator's state machine. One state with parallel regions (what Main shows, the fleet's
 * runs, the usage, the action in flight, what the Fleet screen shows, this device's settings and
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
  | { kind: "clear-cooldown"; key: string }
  /** a project's coordinator started (or told the task) in `cwd` */
  | { kind: "start-project"; task: string; cwd: string }
  | { kind: "resolve"; runId: string; resolved: boolean }
  /** a landing step the person pressed (a comments step carries the comments it sends) */
  | { kind: "land"; runId: string; action: LandAction; comments?: LineComment[] };

/**
 * What the Fleet screen shows: the project (a repository's path, as the runs name it, or a folder
 * picked for a new one), whether the Overview is open, and the thread or agent opened in it, in the
 * chat beside (`member`: one of a thread's helpers instead of its lead), large in the middle when expanded.
 */
export interface FleetViewState {
  project: string | null;
  overview: boolean;
  open: { kind: "thread" | "agent"; runId: string; member: string | null } | null;
  expanded: boolean;
  /** what the open thread shows: its chat, its change, or what stands before it lands */
  tab: ThreadTab;
  /** the Settings page shows in the middle, in place of the project */
  settings: boolean;
}

/**
 * The person's fleet.json as the Settings page last read it, for the project in `cwd`. Each change
 * is saved at once; `saving` counts the saves in flight, and only the latest one's answer is kept.
 */
export interface FleetSettingsState extends Reading<FleetSettings> {
  cwd: string | null;
  saving: number;
  seq: number;
  saveError?: string;
}

/** The skill folders as the Settings page last read them; `busy` is the folder being changed. */
export interface FleetEntrancesState extends Reading<FleetEntrances> {
  busy: FleetEntrance["id"] | null;
  changeError?: string;
}

export type ThreadTab = "chat" | "changes" | "checks";

/** The landing steps that wait for the person's yes in a dialog: each changes the base branch, or cannot be undone. */
export type ConfirmedStep = "merge" | "merge-pr" | "discard";

/** One read of the server's for the open thread: answers for another thread are dropped. */
export interface Reading<T> {
  status: "idle" | "loading" | "ready" | "error";
  data: T | null;
  error?: string;
}

/**
 * Landing the open thread: its change and its checks as last read, the person's comments on each
 * thread's change that are not sent yet, and the step that waits for their yes.
 */
export interface LandingState {
  /** the thread `diff` and `checks` were read for */
  runId: string | null;
  diff: Reading<{ diff: string; truncated: boolean }>;
  checks: Reading<LandingChecks>;
  comments: Record<string, LineComment[]>;
  confirm: { runId: string; action: ConfirmedStep; status: "asking" | "running"; error?: string } | null;
}

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
  /** the device a confirm asks about revoking */
  confirming: string | null;
  /** the poll chain running for the code out: one at a time, a later one ends the one before */
  pollSeq: number;
}

export const NO_DEVICES: DevicesState = { list: null, known: null, unavailable: false, failure: null, code: null, justPaired: null, renaming: null, confirming: null, pollSeq: 0 };

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

/** The terminal attached to the pane open in Main, as its socket tells it. */
export interface PaneSession {
  /** the pane these describe: the one the terminal attached last */
  paneId: string | null;
  /** the pane's output has been written to the grid since it attached */
  outputReady: boolean;
  /** the server takes input for the pane */
  inputReady: boolean;
  ended: boolean;
  /** another web bridge has the pane's terminal: the server attaches once it lets go */
  held: boolean;
  /** a bridge too old to mirror a terminal: the lens is a notice, the chat still works */
  unsupported: boolean;
  inputError: string | null;
  /** the output stopped (stalled, or another attach took it): the pane must be reopened */
  outputError: string | null;
  /** a masked prompt on screen (a password asked), by its text */
  secret: string | null;
}

export const NO_SESSION: PaneSession = { paneId: null, outputReady: false, inputReady: false, ended: false, held: false, unsupported: false, inputError: null, outputError: null, secret: null };

/** What the terminal asks of its socket: which pane it shows, at what size, in which role. */
export type PaneCommand =
  /** `keepSize`: the chat lens covers the grid, so the shared pty keeps its size */
  | { kind: "attach"; paneId: string; cols: number; rows: number; keepSize: boolean }
  | { kind: "detach"; paneId: string }
  /** `force`: re-assert this size after another client resized the shared pty */
  | { kind: "resize"; paneId: string; cols: number; rows: number; force: boolean }
  /** the chat lens covers the grid again: a reconnect attaches without resizing */
  | { kind: "keep-size"; paneId: string }
  | { kind: "mode"; role: ClientRole };

/** The pane open in Main: its socket, and the lens the person chose in it. */
export interface PaneState {
  connected: boolean;
  /** the server stopped sending its output (output_stalled) until the socket is live again */
  outputStopped: boolean;
  /** the connection's role: the server's role-ack confirms it (no UI control today) */
  role: ClientRole;
  /** a lens chosen in the pane, kept here too for a browser that cannot store it; `key` names the pane and what decides its lens */
  lens: { key: string; view: PaneView } | null;
  session: PaneSession;
  /** the terminal's socket, to the PC it shows; `seq`: the one it is, as each opening is a new one */
  socket: { machineId: string; seq: number } | null;
  /** sockets opened so far */
  socketSeq: number;
  /** input typed while the terminal could not take it, held for the person to review and send; `owner`: the pane's storage id */
  draft: { owner: string | null; value: InputDraft };
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
    /** the agent was picked in this opening: the list arriving leaves it */
    agentPicked: boolean;
    cwd: string;
    name: string;
    status: "editing" | "starting";
    error: { kind: "message"; message: string } | { kind: "invalid-cwd" } | null;
    /** a pane made although its agent did not start: the next submit opens it */
    createdPaneId: string | null;
  };

/** The command palette, on the selected pane's PC: the search typed, and the panes opened last there. */
/** `chat`: the chat whose prompts it searches, the one that held the focus when it opened */
export type PaletteState = { open: false } | { open: true; machineId: string; query: string; recent: string[]; chat: Lens };

/** The sign-in screen while the server does not know this browser: a pairing code, or the shared token. */
export interface GateState {
  code: string;
  token: string;
  submitting: "code" | "token" | null;
  error: { kind: "refused"; via: "code" | "token" } | { kind: "message"; via: "code" | "token"; message: string } | null;
  /** the code a scanned QR brought was sent: once */
  scannedSent: boolean;
}

/** What the viewer shows of its file: read, several files of that name, a folder at the path, or why not. */
export type FileContent =
  | { kind: "opening" }
  /** `text`: the start of a text file, null until it arrived (or for any other kind) */
  | { kind: "file"; info: FileInfo; text: string | null }
  | { kind: "candidates"; candidates: string[] }
  | { kind: "folder"; path: string }
  | { kind: "failed"; reason: "outside" | "missing" | "failed" };

/** What the server said of a path asked for in the viewer. */
export type FileOutcome =
  | { kind: "info"; info: FileInfo }
  | { kind: "candidates"; candidates: string[] }
  /** outside the pane's folder and the temp folder */
  | { kind: "outside" }
  /** no file there */
  | { kind: "missing" }
  | { kind: "failed" };

/** The file open in the viewer: a history entry above the chat, so Back closes it. */
export interface FileViewerState {
  /** the file as its history entry keeps it */
  preview: FilePreview;
  /** the path shown: one of several files of that name replaces the one asked */
  path: string;
  content: FileContent;
  /** Back was asked for: until the browser moves, another open or close is ignored */
  closing: boolean;
}

/** The Files dialog on the selected pane, and the file viewer above it (or above the chat). */
export interface FilesState {
  dialog: boolean;
  viewer: FileViewerState | null;
  /** the viewer's reads so far: an answer to an earlier one is dropped */
  seq: number;
}

/** The in-app alert (lib/droplet.ts): one shown at a time, the newest waiting for it to fold away. */
export interface DropletState {
  shown: DropletNotice | null;
  /** in: falling and showing; out: folding away */
  phase: "in" | "out";
  next: DropletNotice | null;
  /** when each notice (PC, pane, kind) dropped in last: the same one again this soon is one */
  lastShown: Record<string, number>;
  /** notices so far */
  count: number;
  /** the timer that counts: a press, a release or a leave starts another */
  timerSeq: number;
  /** the device asks for less motion: the card goes with a fade */
  reducedMotion: boolean;
}

/** Where a folder browser shows: the new session dialog, Files, and a folder opened in the file viewer (above Files). */
export type FolderSlot = "new-session" | "files" | "viewer" | "fleet-project";

/** Why a folder was not listed: a bridge too old to browse, a folder that cannot be opened, or anything else. */
export type FolderFailure = "unsupported" | "invalid" | "failed";

/** One folder browser: the folder shown now, read from its PC; nothing else is kept. */
export interface FolderBrowserState {
  /** the browser it is: one that takes the slot after it starts empty, not on this one's folder */
  owner: number;
  machineId: string;
  /** lists files too (Files, the viewer), not only folders */
  files: boolean;
  listing: DirectoryListing | null;
  hidden: boolean;
  loading: boolean;
  error: FolderFailure | null;
  /** the folder it opened at was typed half-way: one that cannot be opened opens home instead */
  homeIfInvalid: boolean;
  /** the read that counts: a later one makes an earlier one's answer too late */
  seq: number;
}

/** The folder browsers open, by where they show. */
export interface FoldersState {
  open: Partial<Record<FolderSlot, FolderBrowserState>>;
  /** reads so far, across browsers */
  seq: number;
}

/** how often the chat reads the pane's waiting prompt */
export const CHAT_POLL_MS = 2000;
/** how long the card says the prompt changed under its answer */
export const CARD_CHANGED_MS = 2000;

/** The chat lens on a pane, and what it shares with the composer below it: the waiting prompt, the agent's suggestion, the settings in use. */
export interface ChatState {
  /** the pane the chat lens is open on */
  open: { machineId: string; paneId: string } | null;
  /** the pane has an agent: only then is there a prompt to read */
  agent: boolean;
  /** the prompt waiting on the pane: while it waits, a message from the composer answers it */
  prompt: InteractivePrompt | null;
  /** what the agent suggests typing next (Claude's grey input text), for the composer's placeholder */
  suggestion: string | null;
  /** the model and reasoning the pane's agent reported last */
  metadata: { paneId: string; value: ConversationMetadata | null } | null;
  /** a typed pick of an approval's option, shown in the card until Confirm or Cancel */
  pendingAnswer: { promptId: string; answer: TypedAnswer } | null;
  /** messages sent from the composer: a prompt read begun before the latest answers for the turn before it */
  sent: number;
  /** messages the pane confirmed: the conversation is read at once */
  delivered: number;
  /** the prompt read chain running: one at a time */
  promptSeq: number;
  /** an answer from the prompt's card: on its way, refused (`changed`: the prompt moved on under it), or none */
  card: { promptId: string; status: "pending" } | { promptId: string; status: "changed"; seq: number } | { promptId: string; status: "failed"; message: string } | null;
  /** a prompt of the conversation asked for (a step back or on, or the one picked in the palette): the chat scrolls to it once per `seq` */
  seek: { to: -1 | 1 | { key: string }; seq: number } | null;
}

/** how often the chat reads its conversation's newest page */
export const CONVERSATION_POLL_MS = 2000;
/** the scrollback read for an agent with no transcript */
export const TRANSCRIPT_LINES = 400;

/** What the chat lays out: the transcript's turns, or the scrollback's messages for an agent with none. */
export interface ConversationView {
  source: "conversation" | "scrollback";
  turns: ConversationTurn[];
  messages: TranscriptMessage[];
  truncated: boolean;
}

export const EMPTY_VIEW: ConversationView = { source: "conversation", turns: [], messages: [], truncated: false };

/** What one read of a page answered: the page, or why not (`status`: the HTTP status, 409 for a transcript replaced under it). */
export type ConversationOutcome = { kind: "ok"; conversation: ConversationResponse } | { kind: "failed"; message: string; status: number | null };

/**
 * The chat's conversation, read from the pane's transcript: the newest page polled, and earlier
 * pages above it once asked for. Once any shows, the newest page is polled from its start at that
 * moment (`heldFrom`), so the two always meet; the turns it later moves past join the earlier ones.
 */
export interface ConversationState {
  /** the pane read: the one the chat is open on */
  open: { machineId: string; paneId: string } | null;
  /** the read chain running: a pane, a delivered message, a status edge or the page coming back starts another */
  seq: number;
  /** bumped whenever the earlier pages are dropped: a read or a page load begun for them answers too late */
  olderSeq: number;
  historyId: string | undefined;
  /** the answer laid out last in full: an unchanged poll (a 304) hands back this very object */
  answer: ConversationResponse | null;
  signature: string;
  view: ConversationView;
  /** the view changed from an empty one (a pane, a reset): nothing was there to be "new" against */
  fresh: boolean;
  /** the earlier pages above the newest: `cursor` is the page before them, null at the beginning, undefined when unknown */
  older: { turns: ConversationTurn[]; cursor: string | null | undefined; status: "idle" | "loading" | "failed"; heldFrom: string | null };
  /** a read waiting on its gap fill or its scrollback, with what it read */
  pending: { conversation: ConversationResponse; moved: ConversationTurn[] } | null;
  abandoned: NonNullable<ConversationResponse["abandoned"]> | null;
  error: { message: string; status: number | null } | null;
  /** the first answer for this pane arrived (or failed): until then an empty chat is only loading */
  loaded: boolean;
  /**
   * The assistant turn that was last when a message went out, with the turns it was read from.
   * It holds only while those turns are unchanged: once the transcript moves at all, the status
   * applies again (a slash command Claude logs as no user turn continues the very same turn).
   */
  sentOver: { turn: ConversationTurn; page: ConversationTurn[] } | null;
}

export const NO_CHAT: ChatState = { open: null, agent: false, prompt: null, suggestion: null, metadata: null, pendingAnswer: null, sent: 0, delivered: 0, promptSeq: 0, card: null, seek: null };

const NO_OLDER: ConversationState["older"] = { turns: [], cursor: undefined, status: "idle", heldFrom: null };
export const NO_CONVERSATION: ConversationState = {
  open: null, seq: 0, olderSeq: 0, historyId: undefined, answer: null, signature: "", view: EMPTY_VIEW, fresh: true, older: NO_OLDER,
  pending: null, abandoned: null, error: null, loaded: false, sentOver: null,
};

/** What a held message's send came to: taken by the pane, refused with the reason, not sent, or not confirmed. */
export type QueueSendResult = { kind: "sent" } | { kind: "submit-failed"; code: string; message: string } | { kind: "not-sent" } | { kind: "unconfirmed" };

/** A change to a pane's held messages, as the store (lib/messageQueue.ts) makes it: it reads another tab's first. */
export type QueueChange =
  | { kind: "read" }
  | { kind: "refresh" }
  | { kind: "add"; text: string }
  | { kind: "edit"; id: string; text: string }
  | { kind: "remove"; id: string };

/** Messages held while the agent works, by pane: explicitly sent, never dispatched by reconnects or status changes. */
export interface QueueState {
  /** each pane's held messages, as the store answered last */
  lists: Record<string, HeldMessage[]>;
  /** panes whose held messages this device could not keep */
  unsaved: Record<string, true>;
  /** the one going out now */
  sending: { owner: string; id: string } | null;
  /** why the last one did not go */
  error: { owner: string; id: string; note: Exclude<QueueSendResult, { kind: "sent" }> } | null;
}

/** A change to a composer draft, as its store (lib/composerDraft.ts) makes it: it reads another tab's first. */
export type ComposerDraftChange =
  | { kind: "read" }
  | { kind: "refresh" }
  | { kind: "set"; text: string }
  /** `sent`: the draft text the send carries, settled once it is acknowledged */
  | { kind: "begin"; sent?: string }
  | { kind: "end" }
  /** the send was acknowledged: only what was sent leaves the box */
  | { kind: "settle"; sent: string };

/** A change to the terminal's input line (lib/terminalDraft.ts). */
export type LineDraftChange = { kind: "read" } | { kind: "set"; text: string } | { kind: "begin" } | { kind: "end" } | { kind: "acknowledge" };

/** What is typed in each pane's composer and terminal input line, as their stores keep it on this device. */
export interface DraftsState {
  composer: Record<string, { text: string; sending: boolean }>;
  /** what a composer's last acknowledged send left in the box, and whether its sent text was changed meanwhile */
  settled: Record<string, { text: string; edited: boolean }>;
  line: Record<string, { text: string; sending: boolean }>;
}

/** What became of a message sent from a composer or an input line; the view words it. */
export type SendOutcome =
  | { kind: "sent" }
  /** no socket took it: the text stays, nothing to say */
  | { kind: "not-sent" }
  | { kind: "unconfirmed" }
  | { kind: "submit-failed"; code: string; message: string }
  /** Codex has a question open in the terminal: a message would become its answer */
  | { kind: "open-queue" }
  /** not one of the waiting prompt's options */
  | { kind: "refused"; prompt: InteractivePrompt }
  /** the question on screen changed before the answer reached it */
  | { kind: "answer-changed" }
  | { kind: "answer-failed"; message: string };

/** What the socket said of a message it was asked to submit. */
export type SubmitOutcome = { kind: "ok" } | { kind: "failed"; code: string; message: string } | { kind: "not-sent" } | { kind: "unconfirmed" };

/** A send under way: whose it is, and what it carries. */
type PendingSend =
  | { target: "composer"; owner: string; via: "box" | "quick"; sent: string }
  | { target: "line"; owner: string }
  | { target: "queue"; owner: string; queueId: string }
  | { target: "card"; machineId: string; paneId: string; promptId: string; typed: boolean };

/** The messages sent from composers, input lines and held messages, one under way per box. */
export interface SendsState {
  /** requests so far */
  seq: number;
  pending: Record<number, PendingSend>;
  /** what each box's last send came to, by "composer:"/"line:" and its pane */
  outcomes: Record<string, { id: number; outcome: SendOutcome }>;
  /** submits a socket took: the terminal scrolls to its end for each */
  started: number;
}

/** how long the composer waits after the typing stops before it searches the pane's files */
export const FILE_SEARCH_DELAY_MS = 150;

/** What the composer offers to complete: the pane's slash commands, files under a typed `@`, and how often each command was used here. */
export interface CompletionsState {
  commands: { machineId: string; paneId: string; list: SlashCommand[] } | null;
  /** `query`: the name being typed after `@`, null when none is; the newest search wins */
  files: { seq: number; machineId: string; paneId: string; query: string | null; list: string[] };
  slashUsage: Record<string, number>;
}

/** A file attached to a composer's message: stored beside the pane, then mentioned in the message by its path. */
export interface ComposerAttachment {
  id: number;
  file: File;
  /** the pane it goes to: its composer's, when attached */
  machineId: string;
  paneId: string;
  /** the files attached together: they go up one after another, apart from another batch's */
  batch: number;
  /** where the pane's PC stored it, once uploaded */
  path: string | null;
  state: "uploading" | "ready" | "error";
  error?: string;
}

/** The files attached to each composer's message, uploaded one after another. */
export interface AttachmentsState {
  lists: Record<string, ComposerAttachment[]>;
  /** the uploads under way for each composer, one per batch */
  uploading: Record<string, Array<{ id: number; batch: number }>>;
  /** attachments so far */
  seq: number;
}

export interface UiState {
  screen: Screen;
  runs: Loadable<AgentRun[]>;
  usage: Loadable<UsageEntry[]> & { refreshing: boolean };
  request: RequestState;
  fleetView: FleetViewState;
  landing: LandingState;
  fleetSettings: FleetSettingsState;
  fleetEntrances: FleetEntrancesState;
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
  files: FilesState;
  droplet: DropletState;
  folders: FoldersState;
  chat: ChatState;
  conversation: ConversationState;
  /** the chat beside the pane's, with its conversation: the same steps run on it (`lens: "side"`) */
  side: { chat: ChatState; conversation: ConversationState };
  queue: QueueState;
  drafts: DraftsState;
  sends: SendsState;
  completions: CompletionsState;
  attachments: AttachmentsState;
  gate: GateState;
  /** openings of the new session dialog so far */
  newSessionSeq: number;
  /** the phone's workspace drawer: a pane picked closes it, and an in-app alert shows for the open pane while it is open */
  drawerOpen: boolean;
}

type BareEvent =
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
  | { type: "fleet-project"; project: string }
  | { type: "fleet-overview"; open: boolean }
  /** a thread or an agent opens in the Overview (or, expanded, in the middle) */
  | { type: "fleet-open"; kind: "thread" | "agent"; runId: string }
  /** one of the open thread's agents: null is its lead */
  | { type: "fleet-member"; runId: string | null }
  | { type: "fleet-close" }
  | { type: "fleet-expand"; expanded: boolean }
  | { type: "fleet-start-project"; task: string; cwd: string }
  | { type: "fleet-resolve"; runId: string; resolved: boolean }
  | { type: "fleet-tab"; tab: ThreadTab }
  /** the Settings page opens for the project in `cwd` (none: the server's own folder), or closes */
  | { type: "fleet-settings"; open: boolean; cwd?: string | null }
  | { type: "fleet-settings-loaded"; settings: FleetSettings }
  | { type: "fleet-settings-failed"; message: string }
  | { type: "fleet-settings-change"; patch: FleetSettingsPatch }
  | { type: "fleet-settings-saved"; seq: number; settings: FleetSettings }
  | { type: "fleet-settings-save-failed"; seq: number; message: string }
  | { type: "fleet-entrances-loaded"; entrances: FleetEntrances }
  | { type: "fleet-entrances-failed"; message: string }
  | { type: "fleet-entrance"; id: FleetEntrance["id"]; action: "install" | "remove" }
  | { type: "fleet-entrance-changed"; entrances: FleetEntrances }
  | { type: "fleet-entrance-failed"; message: string }
  | { type: "landing-diff-loaded"; runId: string; diff: { diff: string; truncated: boolean } }
  | { type: "landing-diff-failed"; runId: string; message: string }
  | { type: "landing-checks-loaded"; runId: string; checks: LandingChecks }
  | { type: "landing-checks-failed"; runId: string; message: string }
  | { type: "landing-comment"; runId: string; comment: LineComment }
  | { type: "landing-uncomment"; runId: string; index: number }
  | { type: "landing-clear-comments"; runId: string }
  /** a landing step pressed: a merge or a discard asks first */
  | { type: "fleet-land"; runId: string; action: LandAction }
  | { type: "landing-confirm" }
  | { type: "landing-cancel" }
  | { type: "open-pane"; runId: string }
  /** a pane of this PC on the Pane screen: the one a request to a coordinator was sent from */
  | { type: "go-to-pane"; paneId: string }
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
  | { type: "confirm-revoke" }
  | { type: "cancel-revoke" }
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
  | PaneSessionEvent
  /** the terminal for a PC appeared, or went */
  | { type: "open-pane-socket"; machineId: string }
  | { type: "close-pane-socket"; machineId: string }
  /** `machineId`: the PC the terminal asking is on; a socket to another one is not its own */
  | { type: "pane-command"; machineId: string; command: PaneCommand }
  /** the terminal shows a pane (null: none): its held input is read back */
  | { type: "draft-open"; owner: string | null }
  | { type: "draft-loaded"; owner: string; value: InputDraft }
  /** a keystroke the socket did not take */
  | { type: "draft-input"; owner: string; input: string }
  | { type: "send-draft" }
  | { type: "draft-sent"; owner: string }
  | { type: "discard-draft" }
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
  /** the agent chosen last on this device, at once on opening */
  | { type: "new-session-remembered"; agentKind: string; seq: number }
  | { type: "new-session-agents"; agents: AgentKind[]; seq: number }
  | { type: "new-session-agents-failed"; message: string; seq: number }
  /** `agentError`: why the agent asked for did not start; the pane exists all the same */
  | { type: "new-session-created"; paneId: string; agentError: string | null; seq: number }
  | { type: "new-session-failed"; message: string; invalidCwd: boolean; seq: number }
  /** `chat`: the chat that holds the focus (the one beside on the Fleet screen), else the pane's */
  | { type: "open-palette"; chat?: Lens }
  | { type: "close-palette" }
  | { type: "palette-query"; text: string }
  | { type: "palette-recent"; machineId: string; recent: string[] }
  /** a pane picked in the palette: it opens, and the palette closes */
  | { type: "palette-pick"; paneId: string }
  /** a prompt of the open chat picked in the palette (its rail key): the chat scrolls to it, and the palette closes */
  | { type: "palette-pick-prompt"; key: string }
  /** the in-app alert held by a finger, and let go of without a flick */
  | { type: "droplet-press" }
  | { type: "droplet-release" }
  /** flicked up */
  | { type: "droplet-dismiss" }
  /** tapped: its pane opens */
  | { type: "droplet-open" }
  /** it has shown long enough */
  | { type: "droplet-expire"; seq: number }
  /** it folded away */
  | { type: "droplet-gone"; seq: number }
  | { type: "motion-preference"; reduced: boolean }
  /** `start`: the path typed so far (absolute, `~` or `~/…`); empty opens home */
  | { type: "open-folders"; slot: FolderSlot; owner: number; machineId: string; start: string; files: boolean }
  | { type: "close-folders"; slot: FolderSlot }
  /** into a folder, up to its parent, or home ("") */
  | { type: "browse-folder"; slot: FolderSlot; path: string }
  | { type: "show-hidden-folders"; slot: FolderSlot; hidden: boolean }
  | { type: "folders-listed"; slot: FolderSlot; seq: number; listing: DirectoryListing }
  | { type: "folders-failed"; slot: FolderSlot; seq: number; reason: FolderFailure }
  /** the chat lens shows a pane, or no longer does */
  | { type: "chat-open"; machineId: string; paneId: string }
  | { type: "chat-close"; machineId: string; paneId: string }
  | { type: "chat-agent"; paneId: string; agent: boolean }
  | { type: "poll-chat-prompt"; seq: number }
  /** `sent`: the sends counted when the read began */
  | { type: "chat-prompt-read"; seq: number; sent: number; prompt: InteractivePrompt | null; suggestion: string | null }
  | { type: "chat-prompt-failed"; seq: number }
  | { type: "chat-pending-answer"; promptId: string; answer: TypedAnswer }
  | { type: "chat-pending-answer-done" }
  /** the prompt before or after the one being read, by the keyboard */
  | { type: "prompt-rail-step"; direction: -1 | 1 }
  /** files attached to a composer's message (picked, pasted or dropped) */
  | { type: "attach-files"; owner: string; machineId: string; paneId: string; files: File[] }
  | { type: "upload-done"; owner: string; id: number; path: string }
  | { type: "upload-failed"; owner: string; id: number; message: string }
  | { type: "remove-attachment"; owner: string; id: number }
  /** a message went with these */
  | { type: "attachments-sent"; owner: string; ids: number[] }
  /** the composer went: what it had attached goes with it, uploads not yet started included */
  | { type: "attachments-close"; owner: string }
  /** a pane's composer opened: its slash commands are read */
  | { type: "completions-open"; machineId: string; paneId: string }
  | { type: "commands-loaded"; machineId: string; paneId: string; commands: SlashCommand[] }
  | { type: "slash-usage-loaded"; usage: Record<string, number> }
  /** the name typed after `@` changed; null: none is being typed */
  | { type: "file-query"; machineId: string; paneId: string; query: string | null }
  | { type: "search-files"; seq: number }
  | { type: "files-found"; seq: number; files: string[] }
  | { type: "slash-used"; name: string }
  /** a message from a pane's composer (`quick`: a quick reply, which leaves the box alone); `working`: the agent is at work */
  | { type: "composer-send"; owner: string; machineId: string; paneId: string; text: string; via: "box" | "quick"; bracketedPaste: boolean; working: boolean }
  /** the input line's text, typed with its own Enter */
  | { type: "line-send"; owner: string; paneId: string; text: string; bracketedPaste: boolean }
  /** Send now on a held message */
  | { type: "queue-send"; owner: string; id: string; text: string; paneId: string; bracketedPaste: boolean }
  | { type: "submit-started"; id: number }
  | { type: "send-result"; id: number; outcome: SubmitOutcome }
  | { type: "answer-result"; id: number; outcome: { kind: "ok" } | { kind: "failed"; status: number | null; code: string | null; message: string } }
  /** an option, options or a reply picked in the prompt's card; `typed`: the Confirm of a pick typed in the composer */
  | { type: "prompt-card-answer"; machineId: string; paneId: string; promptId: string; answer: TypedAnswer; typed: boolean }
  /** what the card said of a changed prompt has been shown long enough */
  | { type: "prompt-card-clear"; seq: number }
  /** `owner`: the pane's storage id */
  | { type: "composer-draft"; owner: string; change: ComposerDraftChange }
  | { type: "composer-draft-loaded"; owner: string; text: string; sending: boolean; settled: { text: string; edited: boolean } | null }
  | { type: "line-draft"; owner: string; change: LineDraftChange }
  | { type: "line-draft-loaded"; owner: string; text: string; sending: boolean }
  | { type: "queue-open"; owner: string }
  /** another tab changed them */
  | { type: "queue-stored"; owner: string }
  | { type: "queue-edit"; owner: string; id: string; text: string }
  | { type: "queue-discard"; owner: string; id: string }
  | { type: "queue-loaded"; owner: string; messages: HeldMessage[]; unsaved: boolean }
  | { type: "poll-conversation"; seq: number }
  | { type: "conversation-read"; seq: number; olderSeq: number; outcome: ConversationOutcome }
  /** the turns between the held start and where the newest page now starts; null when they cannot be joined */
  | { type: "conversation-gap-filled"; seq: number; olderSeq: number; turns: ConversationTurn[] | null }
  | { type: "conversation-scrollback-read"; seq: number; olderSeq: number; outcome: { kind: "ok"; text: string; truncated: boolean } | { kind: "failed"; message: string; status: number | null } }
  /** scrolled near the top, or the button: the page before the earliest shown */
  | { type: "load-older-conversation" }
  | { type: "older-conversation-read"; olderSeq: number; before: string; outcome: ConversationOutcome }
  | { type: "open-files" }
  | { type: "close-files" }
  /** a file named in the selected pane (its chat, its terminal, Files): `path` is read from the pane's folder */
  | { type: "open-file"; path: string }
  /** a file chosen in the viewer's folder listing: in place of the entry, on the viewer's own pane */
  | { type: "viewer-open"; path: string }
  /** one of several files of the name asked for */
  | { type: "choose-candidate"; path: string }
  | { type: "close-file" }
  /** history moved (Back, Forward, or the page loaded): the file its entry keeps, if any */
  | { type: "file-history"; preview: FilePreview | null }
  | { type: "file-loaded"; seq: number; outcome: FileOutcome }
  | { type: "file-text"; seq: number; text: string }
  /** the folder at a path no file is at; null when it is not one either */
  | { type: "file-folder"; seq: number; path: string | null }
  | { type: "gate-edit"; field: "code" | "token"; value: string }
  | { type: "gate-pair" }
  | { type: "gate-unlock" }
  /** the server took the code or the token, and set its cookie */
  | { type: "gate-passed" }
  /** `unauthorized`: the server refused the code or the token itself */
  | { type: "gate-failed"; via: "code" | "token"; unauthorized: boolean; message: string };

/** What the open pane's terminal socket says of it; each one naming a pane is for that pane only. */
export type PaneSessionEvent =
  /** the terminal attached to a pane (null: none): everything known of the one before goes */
  | { type: "pane-attached"; paneId: string | null }
  /** output written to the grid; `secret`: the masked prompt it now shows, if any */
  | { type: "pane-output"; paneId: string; secret: string | null }
  | { type: "pane-input-ready"; paneId: string; ready: boolean }
  | { type: "pane-attach-held"; paneId: string }
  | { type: "pane-attach-resumed"; paneId: string }
  | { type: "pane-exited"; paneId: string }
  | { type: "pane-input-failed"; paneId: string; message: string }
  | { type: "pane-terminal-unsupported"; paneId: string }
  /** the output stopped (stalled, or another attach took it) */
  | { type: "pane-output-failed"; message: string }
  /** the socket dropped: it attaches afresh on reconnecting */
  | { type: "pane-socket-lost" }
  | { type: "dismiss-input-error" };

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

/**
 * The chats the state keeps: the pane's (the Pane screen's chat lens, or the Fleet screen's project
 * conversation) and the one beside it (a thread or an agent opened in the Fleet screen's Overview).
 */
export type Lens = "main" | "side";

/** `lens: "side"`: the event is for the chat beside, and runs the same chat, conversation and send steps on it. */
export type UiEvent = BareEvent & { lens?: Lens };

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

type BareEffect =
  | { kind: "load-runs" }
  | { kind: "load-usage" }
  | { kind: "refresh-usage" }
  | { kind: "request"; action: RequestAction }
  | { kind: "load-landing-diff"; runId: string }
  | { kind: "load-landing-checks"; runId: string }
  | { kind: "load-fleet-settings"; cwd: string | null }
  | { kind: "save-fleet-settings"; cwd: string | null; patch: FleetSettingsPatch; seq: number }
  | { kind: "load-fleet-entrances" }
  | { kind: "change-fleet-entrance"; id: FleetEntrance["id"]; action: "install" | "remove" }
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
  | { kind: "load-agents"; machineId: string; seq: number }
  | { kind: "gate-pair"; code: string }
  | { kind: "gate-authenticate"; token: string }
  /** the panes opened last on a PC, for the palette */
  | { kind: "load-recent"; machineId: string }
  | { kind: "remember-pane"; machineId: string; paneId: string }
  | { kind: "remember-agent"; agentKind: string }
  /** the file as a history entry: a new one, or in place of the open one's */
  | { kind: "history-preview"; preview: FilePreview; replace: boolean }
  | { kind: "history-back" }
  | { kind: "open-pane-socket"; machineId: string; seq: number }
  | { kind: "close-pane-socket"; seq: number }
  | { kind: "pane-command"; seq: number; command: PaneCommand }
  | { kind: "load-draft"; owner: string }
  /** an empty draft is forgotten */
  | { kind: "save-draft"; owner: string; value: InputDraft }
  | { kind: "send-draft"; owner: string; paneId: string; text: string }
  /** `sent`: the sends counted now, handed back with the answer */
  | { kind: "load-chat-prompt"; machineId: string; paneId: string; seq: number; sent: number }
  | { kind: "queue-change"; owner: string; change: QueueChange }
  | { kind: "composer-draft-change"; owner: string; change: ComposerDraftChange }
  /** stores a file beside the pane, answering its path */
  | { kind: "upload-file"; owner: string; id: number; machineId: string; paneId: string; file: File }
  /** the pane's slash commands (kept a minute by the port) */
  | { kind: "load-commands"; machineId: string; paneId: string }
  | { kind: "load-slash-usage" }
  | { kind: "save-slash-usage"; usage: Record<string, number> }
  | { kind: "search-files"; machineId: string; paneId: string; query: string; seq: number }
  /** `text`: the message as written; `payload`: the same shaped for the pane's paste mode */
  | { kind: "submit"; id: number; paneId: string; text: string; payload: string; typed: boolean }
  | { kind: "answer-prompt"; id: number; machineId: string; paneId: string; promptId: string; answer: TypedAnswer }
  | { kind: "line-draft-change"; owner: string; change: LineDraftChange }
  /** the newest page, from the held start when earlier pages show */
  | { kind: "read-conversation"; machineId: string; paneId: string; from: string | null; seq: number; olderSeq: number }
  | { kind: "fill-conversation-gap"; machineId: string; paneId: string; held: string; start: string; seq: number; olderSeq: number }
  | { kind: "read-conversation-scrollback"; machineId: string; paneId: string; lines: number; seq: number; olderSeq: number }
  | { kind: "read-older-conversation"; machineId: string; paneId: string; before: string; olderSeq: number }
  /** `path` "" is home */
  | { kind: "list-folders"; slot: FolderSlot; machineId: string; path: string; hidden: boolean; files: boolean; seq: number }
  | { kind: "load-file"; machineId: string; paneId: string | null; path: string; seq: number }
  | { kind: "load-file-text"; machineId: string; paneId: string | null; path: string; seq: number }
  | { kind: "list-folder"; machineId: string; paneId: string | null; path: string; seq: number }
  | { kind: "create-session"; machineId: string; request: SessionRequest; seq: number }
  /** the tab's own alert */
  | { kind: "notify-pane"; machineId: string; machineName: string; pane: HerdrPane; status: "blocked" | "done" | "ended" };

/** `lens: "side"`: an effect of the chat beside; what it answers goes back to that chat. */
export type Effect = BareEffect & { lens?: Lens };

export interface Transition { state: UiState; effects: Effect[] }

/** No thread's change or checks read, no comment, nothing asked. */
const NO_LANDING: LandingState = { runId: null, diff: { status: "idle", data: null }, checks: { status: "idle", data: null }, comments: {}, confirm: null };

export const INITIAL_STATE: UiState = {
  screen: "pane",
  runs: { status: "idle", data: [], again: false },
  usage: { status: "idle", data: [], again: false, refreshing: false },
  request: { status: "none" },
  fleetView: { project: null, overview: true, open: null, expanded: false, tab: "chat", settings: false },
  landing: NO_LANDING,
  fleetSettings: { status: "idle", data: null, cwd: null, saving: 0, seq: 0 },
  fleetEntrances: { status: "idle", data: null, busy: null },
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
  pane: { connected: false, outputStopped: false, role: "interact", lens: null, session: NO_SESSION, socket: null, socketSeq: 0, draft: { owner: null, value: EMPTY_DRAFT } },
  alerts: { permission: "default", supported: false, push: false, statuses: {}, turnStarts: {}, lastTurns: {}, subscribeSeq: 0 },
  drawerOpen: false,
  newSession: { open: false },
  palette: { open: false },
  files: { dialog: false, viewer: null, seq: 0 },
  droplet: { shown: null, phase: "in", next: null, lastShown: {}, count: 0, timerSeq: 0, reducedMotion: false },
  folders: { open: {}, seq: 0 },
  chat: NO_CHAT,
  conversation: NO_CONVERSATION,
  side: { chat: NO_CHAT, conversation: NO_CONVERSATION },
  queue: { lists: {}, unsaved: {}, sending: null, error: null },
  drafts: { composer: {}, settled: {}, line: {} },
  sends: { seq: 0, pending: {}, outcomes: {}, started: 0 },
  attachments: { lists: {}, uploading: {}, seq: 0 },
  completions: { commands: null, files: { seq: 0, machineId: "local", paneId: "", query: null, list: [] }, slashUsage: {} },
  gate: { code: "", token: "", submitting: null, error: null, scannedSent: true },
  newSessionSeq: 0,
};

const CONFIRMED_STEPS: readonly LandAction[] = ["merge", "merge-pr", "discard"];

/** The open thread's change or checks, read again when its tab shows them; the open thread changes nothing else. */
function readLanding(landing: LandingState, view: FleetViewState, effects: Effect[]): LandingState {
  const runId = view.open?.kind === "thread" ? view.open.runId : null;
  const fresh = landing.runId === runId ? landing : { ...landing, runId, diff: NO_LANDING.diff, checks: NO_LANDING.checks };
  if (runId === null) return fresh;
  if (view.tab === "changes") {
    effects.push({ kind: "load-landing-diff", runId });
    return { ...fresh, diff: { ...fresh.diff, status: "loading" } };
  }
  if (view.tab === "checks") {
    effects.push({ kind: "load-landing-checks", runId });
    return { ...fresh, checks: { ...fresh.checks, status: "loading" } };
  }
  return fresh;
}

/** What of a thread's run its change and checks follow: a turn of its lead ending, a pull request, a step. */
const landingMark = (run: AgentRun | undefined): string => JSON.stringify(run ? [run.state, run.diff, run.pr, run.landing, run.landed] : null);

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
  if (event.lens === "side") {
    // the steps of the pane's chat, run on the one beside: only the two chats trade places
    const step = followUp(asSide(state), transitionOnly(asSide(state), event));
    return { state: step.state === asSide(state) ? state : fromSide(state, step.state), effects: step.effects.map(onSide) };
  }
  return followSide(state, followUp(state, transitionOnly(state, event)));
}

/** The state with the chat beside in the pane's place. */
function asSide(state: UiState): UiState {
  return sideViews.get(state) ?? (() => {
    const view = { ...state, chat: state.side.chat, conversation: state.side.conversation, side: { chat: state.chat, conversation: state.conversation } };
    sideViews.set(state, view);
    return view;
  })();
}
const sideViews = new WeakMap<UiState, UiState>();

/** A step run on asSide(before), put back: the chats return to their places, all else as the step left it. */
function fromSide(before: UiState, after: UiState): UiState {
  return { ...after, chat: before.chat, conversation: before.conversation, side: { chat: after.chat, conversation: after.conversation } };
}

/** An effect of the chat beside: what it answers is for that chat (a timer's event too). */
function onSide(effect: Effect): Effect {
  return effect.kind === "later" ? { ...effect, lens: "side", event: { ...effect.event, lens: "side" } } : { ...effect, lens: "side" };
}

/** What a step on the rest of the state means for the chat beside: a status edge, the page back, a pane gone. */
function followSide(before: UiState, step: Transition): Transition {
  if (step.state.side === before.side && step.state.connection === before.connection && step.state.machines === before.machines && step.state.pane === before.pane && step.state.sends === before.sends) return step;
  const effects: Effect[] = [];
  const lensed = followLens(asSide(before), asSide(step.state), effects);
  if (lensed === asSide(step.state) && effects.length === 0) return step;
  return { state: fromSide(step.state, lensed), effects: [...step.effects, ...effects.map(onSide)] };
}

function transitionOnly(state: UiState, event: UiEvent): Transition {
  const effects: Effect[] = [];
  // an event that changes nothing keeps the state object itself, so nobody re-renders for it
  const next = (patch: Partial<UiState>): Transition =>
    ({ state: (Object.keys(patch) as Array<keyof UiState>).every((key) => patch[key] === state[key]) ? state : { ...state, ...patch }, effects });
  switch (event.type) {
    case "show-screen":
      return next({ screen: event.screen });
    case "select-pane":
      return next({ screen: "pane", ...pick(state, event.machineId, event.paneId, effects) });
    case "pane-connection": {
      // the socket's connection is polled: the same answer again changes nothing
      const outputStopped = event.connected ? false : state.pane.outputStopped;
      if (state.pane.connected === event.connected && state.pane.outputStopped === outputStopped) return next({});
      return next({ pane: { ...state.pane, connected: event.connected, outputStopped } });
    }
    case "open-pane-socket": {
      const seq = state.pane.socketSeq + 1;
      effects.push({ kind: "open-pane-socket", machineId: event.machineId, seq });
      return next({ pane: { ...state.pane, socket: { machineId: event.machineId, seq }, socketSeq: seq, connected: false } });
    }
    case "close-pane-socket": {
      const { socket } = state.pane;
      if (socket?.machineId !== event.machineId) return next({});
      effects.push({ kind: "close-pane-socket", seq: socket.seq });
      return next({ pane: { ...state.pane, socket: null } });
    }
    case "pane-command": {
      const { socket } = state.pane;
      if (socket?.machineId === event.machineId) effects.push({ kind: "pane-command", seq: socket.seq, command: event.command });
      return next({});
    }
    case "draft-open":
    case "draft-loaded":
    case "draft-input":
    case "send-draft":
    case "draft-sent":
    case "discard-draft": {
      const pane = draftTransition(state.pane, event, effects);
      return next(pane === state.pane ? {} : { pane });
    }
    case "pane-attached":
    case "pane-output":
    case "pane-input-ready":
    case "pane-attach-held":
    case "pane-attach-resumed":
    case "pane-exited":
    case "pane-input-failed":
    case "pane-terminal-unsupported":
    case "pane-output-failed":
    case "pane-socket-lost":
    case "dismiss-input-error": {
      const pane = paneSessionTransition(state.pane, event);
      return next(pane === state.pane ? {} : { pane });
    }
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
    case "new-session-remembered":
    case "new-session-agents":
    case "new-session-agents-failed":
    case "new-session-created":
    case "new-session-failed":
      return newSessionTransition(state, event, effects);
    case "open-palette":
      effects.push({ kind: "load-recent", machineId: state.selection.machineId });
      return next({ palette: { open: true, machineId: state.selection.machineId, query: "", recent: [], chat: event.chat ?? "main" } });
    case "close-palette":
      return next(state.palette.open ? { palette: { open: false } } : {});
    case "palette-query":
      return next(state.palette.open ? { palette: { ...state.palette, query: event.text } } : {});
    case "palette-recent":
      return next(state.palette.open && state.palette.machineId === event.machineId ? { palette: { ...state.palette, recent: event.recent } } : {});
    case "palette-pick":
      if (!state.palette.open) return next({});
      return next({ screen: "pane", palette: { open: false }, ...pick(state, state.palette.machineId, event.paneId, effects) });
    case "palette-pick-prompt":
      if (!state.palette.open) return next({});
      // the prompt is the searched chat's: the pane's, or the one beside
      if (state.palette.chat === "side") return next({ palette: { open: false }, side: { ...state.side, chat: seekPrompt(state.side.chat, { key: event.key }) } });
      return next({ palette: { open: false }, chat: seekPrompt(state.chat, { key: event.key }) });
    case "prompt-rail-step":
      return next({ chat: seekPrompt(state.chat, event.direction) });
    case "droplet-press":
    case "droplet-release":
    case "droplet-dismiss":
    case "droplet-open":
    case "droplet-expire":
    case "droplet-gone":
    case "motion-preference":
      return dropletTransition(state, event, effects);
    case "chat-open":
    case "chat-close":
    case "chat-agent":
    case "poll-chat-prompt":
    case "chat-prompt-read":
    case "chat-prompt-failed":
    case "chat-pending-answer":
    case "chat-pending-answer-done": {
      const chat = chatTransition(state, event, effects);
      return next(chat === state.chat ? {} : { chat });
    }
    case "attach-files":
    case "upload-done":
    case "upload-failed":
    case "remove-attachment":
    case "attachments-sent":
    case "attachments-close": {
      const attachments = attachmentsTransition(state.attachments, event, effects);
      return next(attachments === state.attachments ? {} : { attachments });
    }
    case "completions-open":
    case "commands-loaded":
    case "slash-usage-loaded":
    case "file-query":
    case "search-files":
    case "files-found":
    case "slash-used": {
      const completions = completionsTransition(state.completions, event, effects);
      return next(completions === state.completions ? {} : { completions });
    }
    case "composer-send":
    case "line-send":
    case "queue-send":
    case "submit-started":
    case "send-result":
    case "answer-result":
    case "prompt-card-answer":
      return sendTransition(state, event, effects);
    case "prompt-card-clear": {
      const { card } = state.chat;
      return next(card?.status === "changed" && card.seq === event.seq ? { chat: { ...state.chat, card: null } } : {});
    }
    case "composer-draft":
      effects.push({ kind: "composer-draft-change", owner: event.owner, change: event.change });
      return next({});
    case "line-draft":
      effects.push({ kind: "line-draft-change", owner: event.owner, change: event.change });
      return next({});
    case "composer-draft-loaded": {
      const { drafts } = state;
      const kept = drafts.composer[event.owner];
      const composer = kept?.text === event.text && kept.sending === event.sending ? drafts.composer : { ...drafts.composer, [event.owner]: { text: event.text, sending: event.sending } };
      const settled = event.settled === null ? drafts.settled : { ...drafts.settled, [event.owner]: event.settled };
      return next(composer === drafts.composer && settled === drafts.settled ? {} : { drafts: { ...drafts, composer, settled } });
    }
    case "line-draft-loaded": {
      const { drafts } = state;
      const kept = drafts.line[event.owner];
      if (kept?.text === event.text && kept.sending === event.sending) return next({});
      return next({ drafts: { ...drafts, line: { ...drafts.line, [event.owner]: { text: event.text, sending: event.sending } } } });
    }
    case "queue-open":
    case "queue-stored":
    case "queue-edit":
    case "queue-discard":
    case "queue-loaded":
      return next({ queue: queueTransition(state.queue, event, effects) });
    case "poll-conversation":
    case "conversation-read":
    case "conversation-gap-filled":
    case "conversation-scrollback-read":
    case "load-older-conversation":
    case "older-conversation-read":
      return conversationTransition(state, event, effects);
    case "open-folders":
    case "close-folders":
    case "browse-folder":
    case "show-hidden-folders":
    case "folders-listed":
    case "folders-failed":
      return next({ folders: foldersTransition(state.folders, event, effects) });
    case "open-files":
    case "close-files":
    case "open-file":
    case "viewer-open":
    case "choose-candidate":
    case "close-file":
    case "file-history":
    case "file-loaded":
    case "file-text":
    case "file-folder":
      return filesTransition(state, event, effects);
    case "gate-edit":
      // the code is six digits, typed with or without the space it is shown with
      return next({ gate: { ...state.gate, [event.field]: event.field === "code" ? event.value.replace(/\D/g, "").slice(0, 6) : event.value } });
    case "gate-pair":
      if (state.gate.submitting !== null || state.gate.code.length !== 6) return next({});
      effects.push({ kind: "gate-pair", code: state.gate.code });
      return next({ gate: { ...state.gate, submitting: "code", error: null } });
    case "gate-unlock":
      if (state.gate.submitting !== null || state.gate.token === "") return next({});
      effects.push({ kind: "gate-authenticate", token: state.gate.token });
      return next({ gate: { ...state.gate, submitting: "token", error: null } });
    case "gate-passed": {
      // in: the next time the gate shows it starts empty, and has no scanned code to send
      const passed = { ...state, gate: { ...INITIAL_STATE.gate, scannedSent: true } };
      return connectionTransition(passed, { type: "unlocked" }, effects);
    }
    case "gate-failed":
      return next({ gate: { ...state.gate, submitting: null, error: event.unauthorized ? { kind: "refused", via: event.via } : { kind: "message", via: event.via, message: event.message } } });
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
      // a thread or agent open in the Fleet screen whose run is gone closes
      const open = state.fleetView.open;
      const gone = open !== null && !event.runs.some((run) => run.id === open.runId);
      if (gone) return next({ runs, fleetView: { ...state.fleetView, open: null, expanded: false, tab: "chat" }, landing: readLanding(state.landing, { ...state.fleetView, open: null }, effects) });
      // the open thread moved on (its lead's turn ended, a pull request, a step): its change and checks are read again
      const moved = open?.kind === "thread" && landingMark(state.runs.data.find((run) => run.id === open.runId)) !== landingMark(event.runs.find((run) => run.id === open.runId));
      return next({ runs, landing: moved ? readLanding(state.landing, state.fleetView, effects) : state.landing });
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
    case "fleet-project":
      return next({ fleetView: { ...state.fleetView, project: event.project, open: null, expanded: false, tab: "chat", settings: false } });
    case "fleet-settings": {
      if (!event.open) return next(state.fleetView.settings ? { fleetView: { ...state.fleetView, settings: false } } : {});
      const cwd = event.cwd ?? null;
      effects.push({ kind: "load-fleet-settings", cwd }, { kind: "load-fleet-entrances" });
      return next({
        fleetView: { ...state.fleetView, settings: true, open: null, expanded: false, tab: "chat" },
        fleetSettings: { ...state.fleetSettings, cwd, status: "loading", error: undefined, saveError: undefined, ...(state.fleetSettings.cwd === cwd ? {} : { data: null }) },
        fleetEntrances: { ...state.fleetEntrances, status: "loading", error: undefined, changeError: undefined },
      });
    }
    case "fleet-entrances-loaded":
      return next({ fleetEntrances: { ...state.fleetEntrances, status: "ready", data: event.entrances, error: undefined } });
    case "fleet-entrances-failed":
      return next({ fleetEntrances: { ...state.fleetEntrances, status: "error", error: event.message } });
    case "fleet-entrance": {
      // one folder at a time: a second press waits for the first answer
      if (!state.canAct || state.fleetEntrances.busy !== null) return next({});
      effects.push({ kind: "change-fleet-entrance", id: event.id, action: event.action });
      return next({ fleetEntrances: { ...state.fleetEntrances, busy: event.id, changeError: undefined } });
    }
    case "fleet-entrance-changed":
      return next({ fleetEntrances: { ...state.fleetEntrances, busy: null, status: "ready", data: event.entrances } });
    case "fleet-entrance-failed":
      return next({ fleetEntrances: { ...state.fleetEntrances, busy: null, changeError: event.message } });
    case "fleet-settings-loaded":
      return next({ fleetSettings: { ...state.fleetSettings, status: "ready", data: event.settings, error: undefined } });
    case "fleet-settings-failed":
      return next({ fleetSettings: { ...state.fleetSettings, status: "error", error: event.message } });
    case "fleet-settings-change": {
      if (!state.canAct) return next({});
      const seq = state.fleetSettings.seq + 1;
      effects.push({ kind: "save-fleet-settings", cwd: state.fleetSettings.cwd, patch: event.patch, seq });
      return next({ fleetSettings: { ...state.fleetSettings, seq, saving: state.fleetSettings.saving + 1, saveError: undefined } });
    }
    case "fleet-settings-saved":
    case "fleet-settings-save-failed": {
      const saving = Math.max(0, state.fleetSettings.saving - 1);
      // an older save's answer is older than what a later one wrote
      if (event.seq !== state.fleetSettings.seq) return next({ fleetSettings: { ...state.fleetSettings, saving } });
      return next({ fleetSettings: event.type === "fleet-settings-saved"
        ? { ...state.fleetSettings, saving, status: "ready", data: event.settings, saveError: undefined }
        : { ...state.fleetSettings, saving, saveError: event.message } });
    }
    case "fleet-overview":
      return next(state.fleetView.overview === event.open ? {} : { fleetView: { ...state.fleetView, overview: event.open } });
    case "fleet-open": {
      const fleetView: FleetViewState = { ...state.fleetView, overview: true, open: { kind: event.kind, runId: event.runId, member: null }, tab: "chat", settings: false };
      return next({ fleetView, landing: readLanding(state.landing, fleetView, effects) });
    }
    case "fleet-member":
      return next(state.fleetView.open?.kind !== "thread" ? {} : { fleetView: { ...state.fleetView, open: { ...state.fleetView.open, member: event.runId } } });
    case "fleet-close":
      return next({ fleetView: { ...state.fleetView, open: null, expanded: false, tab: "chat" } });
    case "fleet-tab": {
      if (state.fleetView.open?.kind !== "thread") return next({});
      const fleetView = { ...state.fleetView, tab: event.tab };
      return next({ fleetView, landing: readLanding(state.landing, fleetView, effects) });
    }
    case "landing-diff-loaded":
    case "landing-diff-failed":
      if (event.runId !== state.landing.runId) return next({});
      return next({ landing: { ...state.landing, diff: event.type === "landing-diff-loaded" ? { status: "ready", data: event.diff } : { ...state.landing.diff, status: "error", error: event.message } } });
    case "landing-checks-loaded":
    case "landing-checks-failed":
      if (event.runId !== state.landing.runId) return next({});
      return next({ landing: { ...state.landing, checks: event.type === "landing-checks-loaded" ? { status: "ready", data: event.checks } : { ...state.landing.checks, status: "error", error: event.message } } });
    case "landing-comment":
      return next({ landing: { ...state.landing, comments: { ...state.landing.comments, [event.runId]: [...(state.landing.comments[event.runId] ?? []), event.comment] } } });
    case "landing-uncomment":
      return next({ landing: { ...state.landing, comments: { ...state.landing.comments, [event.runId]: (state.landing.comments[event.runId] ?? []).filter((_, index) => index !== event.index) } } });
    case "landing-clear-comments": {
      const { [event.runId]: _cleared, ...comments } = state.landing.comments;
      return next({ landing: { ...state.landing, comments } });
    }
    case "fleet-land": {
      if (!state.canAct) return next({});
      if (CONFIRMED_STEPS.includes(event.action)) {
        if (state.landing.confirm?.status === "running") return next({});
        return next({ landing: { ...state.landing, confirm: { runId: event.runId, action: event.action as ConfirmedStep, status: "asking" } } });
      }
      const comments = state.landing.comments[event.runId] ?? [];
      if (event.action === "comments" && comments.length === 0) return next({});
      return request(state, { kind: "land", runId: event.runId, action: event.action, ...(event.action === "comments" ? { comments } : {}) });
    }
    case "landing-confirm": {
      const confirm = state.landing.confirm;
      if (confirm?.status !== "asking") return next({});
      const asked = request(state, { kind: "land", runId: confirm.runId, action: confirm.action });
      if (asked.state === state) return asked;
      return { state: { ...asked.state, landing: { ...state.landing, confirm: { runId: confirm.runId, action: confirm.action, status: "running" } } }, effects: asked.effects };
    }
    case "landing-cancel":
      return next(state.landing.confirm?.status === "asking" ? { landing: { ...state.landing, confirm: null } } : {});
    case "fleet-expand":
      return next({ fleetView: { ...state.fleetView, expanded: event.expanded && state.fleetView.open !== null } });
    case "fleet-start-project": {
      if (!event.task.trim()) return next({});
      const asked = request(state, { kind: "start-project", task: event.task, cwd: event.cwd });
      return asked.state === state ? asked : { state: { ...asked.state, fleetView: { ...state.fleetView, project: event.cwd } }, effects: asked.effects };
    }
    case "fleet-resolve":
      return request(state, { kind: "resolve", runId: event.runId, resolved: event.resolved });
    case "open-pane": {
      const run = state.runs.data.find((candidate) => candidate.id === event.runId);
      if (!run || isEnded(run)) return next({});
      // a fleet run's pane lives on this PC
      return next({ screen: "pane", ...pick(state, "local", run.paneId, effects) });
    }
    case "go-to-pane": {
      const there = state.machines.list.find((machine) => machine.id === "local")?.snapshot?.panes.some((pane) => pane.pane_id === event.paneId);
      return there ? next({ screen: "pane", ...pick(state, "local", event.paneId, effects) }) : next({});
    }
    case "interrupt-run":
      return request(state, { kind: "interrupt", runId: event.runId });
    case "close-done":
      return request(state, { kind: "close-done", group: event.group });
    case "clear-cooldown":
      return request(state, { kind: "clear-cooldown", key: event.key });
    case "request-done": {
      if (state.request.status !== "pending") return next({});
      const action = state.request.action;
      // a cleared cooldown changes no run, so no fleet-changed follows: the usage is read here
      const usage = action.kind === "clear-cooldown" ? load(state.usage, { kind: "load-usage" }, effects) : state.usage;
      if (action.kind !== "land") return next({ request: { status: "none" }, usage });
      // the comments went out: the ones written meanwhile stay
      const left = (state.landing.comments[action.runId] ?? []).slice(action.comments?.length ?? 0);
      const { [action.runId]: _sent, ...others } = state.landing.comments;
      const comments = action.action === "comments" ? (left.length ? { ...others, [action.runId]: left } : others) : state.landing.comments;
      return next({ request: { status: "none" }, usage, landing: { ...state.landing, comments, confirm: state.landing.confirm?.status === "running" ? null : state.landing.confirm } });
    }
    case "request-failed":
      if (state.request.status !== "pending") return next({});
      // a step asked in a dialog tells its failure there
      if (state.request.action.kind === "land" && state.landing.confirm?.status === "running") {
        return next({ request: { status: "none" }, landing: { ...state.landing, confirm: { ...state.landing.confirm, status: "asking", error: event.message } } });
      }
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
    case "confirm-revoke":
    case "cancel-revoke":
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
    // a revoke cannot be undone (the device must pair again): a confirm asks first
    case "revoke-device":
      return { ...devices, confirming: event.id };
    case "confirm-revoke":
      if (devices.confirming === null) return devices;
      effects.push({ kind: "revoke-device", id: devices.confirming, session });
      return { ...devices, confirming: null };
    case "cancel-revoke":
      return devices.confirming === null ? devices : { ...devices, confirming: null };
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
      const pairCode = event.pairCode ?? "";
      // a scanned QR's code is sent once, by the gate this page shows first
      const booted = { ...state, gate: { ...state.gate, code: pairCode, scannedSent: pairCode.length !== 6 }, connection: { ...connection, pairCode: event.pairCode ?? "", visible: event.visible ?? connection.visible }, alerts: event.alerts ? { ...state.alerts, ...event.alerts } : state.alerts };
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
        const snapshot = applyPaneStatus(machine.snapshot, message.pane_id, message.agent_status);
        if (snapshot !== machine.snapshot) list = list.map((candidate) => (candidate === machine ? { ...machine, snapshot } : candidate));
      }
      if ((message.type === "session-changed" || message.type === "pane-exited") && !refetching) {
        refetching = true;
        effects.push({ kind: "later", ms: REFETCH_DEBOUNCE_MS, event: { type: "refetch-machines" } });
      }
      const pushed: UiState = { ...state, machines: { ...machines, list, refetching, revision: machines.revision + 1 }, ...alertOn(state, machine, message, event.at ?? 0, effects) };
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
function alertOn(state: UiState, machine: Machine, message: ServerMessage, at: number, effects: Effect[]): Pick<UiState, "alerts" | "droplet"> {
  const { alerts, settings } = state;
  let { droplet } = state;
  if (message.type !== "pane-status" && message.type !== "pane-exited") return { alerts, droplet };
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
    // a finished turn is told only when it worked a while, unless every one is asked for, in
    // the page as in the push (a quick answer is read where it was asked)
    if (pane && shouldNotifyStatus(previous, message.agent_status) && dropletAllows(prefs, message.agent_status, worked)) {
      const alert = message.agent_status === "blocked" ? "blocked" : "done";
      if (dropsIn) droplet = dropIn(droplet, { machineId: machine.id, machineName, pane, kind: alert }, at, effects);
      if (tabTells) effects.push({ kind: "notify-pane", machineId: machine.id, machineName: machine.name, pane, status: alert });
    }
  } else {
    const worked = endedTurn(started, lasted, key, at);
    if (pane && dropsIn && dropletAllows(prefs, "done", worked)) droplet = dropIn(droplet, { machineId: machine.id, machineName, pane, kind: "ended" }, at, effects);
    if (pane && tabTells && prefs.done !== "off") effects.push({ kind: "notify-pane", machineId: machine.id, machineName: machine.name, pane, status: "ended" });
  }
  return { alerts: { ...alerts, statuses, turnStarts: Object.fromEntries(started), lastTurns: Object.fromEntries(lasted) }, droplet };
}

/** A notice drops in: at once with none shown, else after the shown one folds away. The same one again this soon is one. */
function dropIn(droplet: DropletState, notice: Omit<DropletNotice, "id">, at: number, effects: Effect[]): DropletState {
  const key = `${notice.machineId}\n${notice.pane.pane_id}\n${notice.kind}`;
  const last = droplet.lastShown[key];
  if (last !== undefined && at - last < DROPLET_REPEAT_MS) return droplet;
  const count = droplet.count + 1;
  const queued = { ...droplet, count, lastShown: { ...droplet.lastShown, [key]: at } };
  if (droplet.shown === null) return showDroplet(queued, { ...notice, id: count }, effects);
  return leaveDroplet({ ...queued, next: { ...notice, id: count } }, effects);
}

/** The card shows, and goes once its text has shown for a while. */
function showDroplet(droplet: DropletState, notice: DropletNotice, effects: Effect[]): DropletState {
  const timerSeq = droplet.timerSeq + 1;
  effects.push({ kind: "later", ms: DROPLET_REVEAL_MS + DROPLET_HOLD_MS, event: { type: "droplet-expire", seq: timerSeq } });
  return { ...droplet, shown: notice, phase: "in", next: null, timerSeq };
}

/** The card folds away; the one waiting shows after it. */
function leaveDroplet(droplet: DropletState, effects: Effect[]): DropletState {
  if (droplet.shown === null || droplet.phase === "out") return droplet;
  const timerSeq = droplet.timerSeq + 1;
  effects.push({ kind: "later", ms: droplet.reducedMotion ? DROPLET_EXIT_REDUCED_MS : DROPLET_EXIT_MS, event: { type: "droplet-gone", seq: timerSeq } });
  return { ...droplet, phase: "out", timerSeq };
}

type DropletEvent = Extract<UiEvent, { type: "droplet-press" | "droplet-release" | "droplet-dismiss" | "droplet-open" | "droplet-expire" | "droplet-gone" | "motion-preference" }>;

function dropletTransition(state: UiState, event: DropletEvent, effects: Effect[]): Transition {
  const { droplet } = state;
  const next = (changed: DropletState): Transition => ({ state: changed === droplet ? state : { ...state, droplet: changed }, effects });
  if (event.type === "motion-preference") return next(droplet.reducedMotion === event.reduced ? droplet : { ...droplet, reducedMotion: event.reduced });
  if (event.type === "droplet-gone") {
    if (event.seq !== droplet.timerSeq || droplet.phase !== "out") return next(droplet);
    return next(droplet.next === null ? { ...droplet, shown: null, phase: "in" } : showDroplet(droplet, droplet.next, effects));
  }
  // what is folding away takes no more presses
  const { shown } = droplet;
  if (shown === null || droplet.phase === "out") return next(droplet);
  switch (event.type) {
    case "droplet-press":
      // held while touched: the timer running no longer counts
      return next({ ...droplet, timerSeq: droplet.timerSeq + 1 });
    case "droplet-release": {
      const timerSeq = droplet.timerSeq + 1;
      effects.push({ kind: "later", ms: DROPLET_HOLD_MS, event: { type: "droplet-expire", seq: timerSeq } });
      return next({ ...droplet, timerSeq });
    }
    case "droplet-expire":
      return next(event.seq === droplet.timerSeq ? leaveDroplet(droplet, effects) : droplet);
    case "droplet-dismiss":
      return next(leaveDroplet(droplet, effects));
    case "droplet-open": {
      const left = { ...state, droplet: leaveDroplet(droplet, effects) };
      // an ended pane's card outlives the pane: the refetch has dropped it, and selecting it attaches nothing
      const there = state.machines.list.find((machine) => machine.id === shown.machineId)?.snapshot?.panes.some((pane) => pane.pane_id === shown.pane.pane_id);
      if (!there) return { state: left, effects };
      // Files lists the pane it was opened on: the card's pane opens in its place, even when it is the same one
      return { state: { ...left, screen: "pane", files: { ...state.files, dialog: false }, ...pick(state, shown.machineId, shown.pane.pane_id, effects) }, effects };
    }
  }
}

/** This device's push subscription is registered whenever it may be: in, allowed, alerts on, push there; again as its choice of alerts changes. */
function subscriptionKey(state: UiState): string | null {
  const { connection, alerts, settings } = state;
  if (connection.locked !== false || alerts.permission !== "granted" || !settings.alertsOn || !alerts.supported) return null;
  return JSON.stringify(alertPrefs(settings));
}

/** What a step means for the pane's chat and its conversation (and, run on asSide, for the chat beside). */
function followLens(before: UiState, after: UiState, effects: Effect[]): UiState {
  let state = after;
  // the conversation follows the chat open on a pane: another pane starts over, a closed chat reads nothing
  if (state.chat.open !== before.chat.open) {
    const opened = state.chat.open;
    const conversation = state.conversation;
    if (opened === null) state = { ...state, conversation: { ...conversation, open: null, seq: conversation.seq + 1, pending: null } };
    else if (conversation.open?.machineId !== opened.machineId || conversation.open.paneId !== opened.paneId) {
      state = { ...state, conversation: { ...NO_CONVERSATION, open: opened, seq: conversation.seq + 1, olderSeq: conversation.olderSeq + 1 } };
    } else state = { ...state, conversation: { ...conversation, open: opened } };
  }
  {
    // read now: the chat opened, the page came back, a message was delivered, or a turn started or ended (its status entered or left `working`)
    const reads = conversationReads(state);
    const opened = state.conversation.open !== before.conversation.open;
    const edge = state.conversation.open !== null && state.conversation.open === before.conversation.open && statusEdgeRead(openPaneStatus(before), openPaneStatus(state));
    if (reads && (opened || !conversationReads(before) || state.chat.delivered !== before.chat.delivered || edge)) {
      state = { ...state, conversation: readConversation(state.conversation, effects) };
    } else if (!reads && conversationReads(before)) state = { ...state, conversation: { ...state.conversation, seq: state.conversation.seq + 1, pending: null } };
  }
  // a message went out: the assistant turn last before it is no longer the one running (sent into a run, that turn is)
  if (state.chat.sent !== before.chat.sent) {
    const page = state.conversation.view.turns;
    const last = page[page.length - 1];
    const status = openPaneStatus(state);
    const sentOver = last?.role === "assistant" && status !== "working" && status !== "blocked" ? { turn: last, page } : null;
    if (sentOver !== state.conversation.sentOver) state = { ...state, conversation: { ...state.conversation, sentOver } };
  }
  // the chat reads the prompt while it may and the page is on screen; a pane that is no longer live, or has no agent, shows none
  const reads = chatReads(state);
  if (reads && (!chatReads(before) || state.chat.open !== before.chat.open)) state = { ...state, chat: readChatPrompt(state, effects) };
  else if (!reads && chatReads(before)) state = { ...state, chat: { ...state.chat, promptSeq: state.chat.promptSeq + 1 } };
  if (!chatAsks(state) && (state.chat.prompt !== null || state.chat.suggestion !== null)) state = { ...state, chat: { ...showPrompt(state.chat, null), suggestion: null } };
  // away from the page, the prompt is not read: it can be answered in the terminal and asked again unseen
  if (!state.connection.visible && state.chat.pendingAnswer !== null) state = { ...state, chat: { ...state.chat, pendingAnswer: null } };
  return state;
}

/**
 * What follows from any step: the event stream runs while this browser is in, and a selected
 * pane the roster no longer lists is looked into (or, with none selected, herdr's focused one taken).
 */
function followUp(before: UiState, step: Transition): Transition {
  let { state } = step;
  const effects = [...step.effects];
  if (before.connection.locked !== false && state.connection.locked === false) {
    effects.push({ kind: "open-stream" });
    // a file restored from history, or shown while locked out, is read as this browser now may
    state = readFile(state, effects);
  }
  if (before.connection.locked === false && state.connection.locked !== false) effects.push({ kind: "close-stream" });
  // a scanned QR code brings its code along: the gate sends it at once, no typing on the phone
  if (state.connection.locked === true && before.connection.locked !== true && !state.gate.scannedSent && state.gate.submitting === null) {
    effects.push({ kind: "gate-pair", code: state.gate.code });
    state = { ...state, gate: { ...state.gate, scannedSent: true, submitting: "code" } };
  }
  // the palette lists the selected PC's panes: another PC's selection takes it down
  if (state.palette.open && state.selection.machineId !== before.selection.machineId) state = { ...state, palette: { open: false } };
  state = followLens(before, state, effects);
  // Files lists the pane it was opened on, and would open its paths on another
  if (state.files.dialog && (state.selection.machineId !== before.selection.machineId || state.selection.paneId !== before.selection.paneId)) {
    state = { ...state, files: { ...state.files, dialog: false } };
  }
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

type NewSessionEvent = Extract<UiEvent, { type: "open-new-session" | "close-new-session" | "edit-new-session" | "submit-new-session" | "new-session-remembered" | "new-session-agents" | "new-session-agents-failed" | "new-session-created" | "new-session-failed" }>;

function newSessionTransition(state: UiState, event: NewSessionEvent, effects: Effect[]): Transition {
  // an event that changes nothing keeps the state object itself
  const next = (patch: Partial<UiState>): Transition => ({ state: Object.keys(patch).length === 0 ? state : { ...state, ...patch }, effects });
  if (event.type === "open-new-session") {
    // an open dialog stays as it is: what is typed, and a start under way
    if (state.newSession.open && (state.newSession.status === "starting" || state.newSession.machineId === event.machineId)) return next({});
    const seq = state.newSessionSeq + 1;
    effects.push({ kind: "load-agents", machineId: event.machineId, seq });
    return next({
      newSessionSeq: seq,
      drawerOpen: false,
      newSession: { open: true, machineId: event.machineId, seq, agents: [], agentKind: "", agentPicked: false, cwd: event.defaultCwd ?? "", name: "", status: "editing", error: null, createdPaneId: null },
    });
  }
  const dialog = state.newSession;
  if (!dialog.open || ("seq" in event && event.seq !== dialog.seq)) return next({});
  /** the session it started is open: its pane selected, the dialog gone, the PCs read again */
  const opened = (paneId: string): Transition => {
    const picked = { ...state, screen: "pane" as const, ...pick(state, dialog.machineId, paneId, effects), newSession: { open: false } as const };
    return connectionTransition(picked, { type: "reload-machines" }, effects);
  };
  switch (event.type) {
    case "close-new-session":
      return next(dialog.status === "starting" ? {} : { newSession: { open: false } });
    case "edit-new-session":
      if (dialog.status === "starting" || dialog.createdPaneId !== null) return next({});
      return next({ newSession: { ...dialog, [event.field]: event.value, agentPicked: dialog.agentPicked || event.field === "agentKind" } });
    case "submit-new-session": {
      if (dialog.status === "starting") return next({});
      if (dialog.createdPaneId !== null) return opened(dialog.createdPaneId);
      effects.push(
        { kind: "remember-agent", agentKind: dialog.agentKind },
        { kind: "create-session", machineId: dialog.machineId, seq: dialog.seq, request: { cwd: dialog.cwd.trim() || null, label: dialog.name.trim() || null, agent: dialog.agentKind ? { kind: dialog.agentKind } : null } },
      );
      return next({ newSession: { ...dialog, status: "starting", error: null } });
    }
    case "new-session-remembered":
      return next(dialog.agentPicked ? {} : { newSession: { ...dialog, agentKind: event.agentKind } });
    case "new-session-agents": {
      // the agent chosen last goes when this PC no longer has it; one picked here stays
      const kept = dialog.agentPicked || dialog.agentKind === "" || event.agents.some((agent) => agent.kind === dialog.agentKind);
      return next({ newSession: { ...dialog, agents: event.agents, agentKind: kept ? dialog.agentKind : "" } });
    }
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
 * The viewer's file read anew: an answer to an earlier read is dropped, even one asked before
 * this browser was locked out. `now`: this browser is in, so the read goes now (else on unlocking).
 */
function readFile(state: UiState, effects: Effect[], now = true): UiState {
  const { viewer } = state.files;
  if (viewer === null) return state;
  const seq = state.files.seq + 1;
  if (now) effects.push({ kind: "load-file", machineId: viewer.preview.machineId, paneId: viewer.preview.paneId, path: viewer.path, seq });
  return { ...state, files: { ...state.files, seq, viewer: { ...viewer, content: { kind: "opening" } } } };
}

type DraftEvent = Extract<UiEvent, { type: "draft-open" | "draft-loaded" | "draft-input" | "send-draft" | "draft-sent" | "discard-draft" }>;

/**
 * Input typed while the terminal could not take it is never queued and fired later, unannounced:
 * it is held, printable text only, for the person to send once the terminal takes input again.
 */
function draftTransition(pane: PaneState, event: DraftEvent, effects: Effect[]): PaneState {
  const { draft } = pane;
  /** the held input changed: kept for the next load too */
  const hold = (owner: string, value: InputDraft): PaneState => {
    effects.push({ kind: "save-draft", owner, value });
    return { ...pane, draft: { owner, value } };
  };
  switch (event.type) {
    case "draft-open":
      if (event.owner !== null) effects.push({ kind: "load-draft", owner: event.owner });
      return { ...pane, draft: { owner: event.owner, value: EMPTY_DRAFT } };
    case "draft-loaded":
      return draft.owner === event.owner ? { ...pane, draft: { owner: event.owner, value: event.value } } : pane;
    case "draft-input":
      return hold(event.owner, applyToDraft(draft.owner === event.owner ? draft.value : EMPTY_DRAFT, event.input));
    case "send-draft": {
      const { session } = pane;
      if (draft.owner === null || draft.value.text.length === 0 || session.paneId === null || !pane.connected || session.secret !== null || session.held) return pane;
      effects.push({ kind: "send-draft", owner: draft.owner, paneId: session.paneId, text: draft.value.text });
      return pane;
    }
    case "draft-sent":
      return draft.owner === event.owner ? hold(event.owner, EMPTY_DRAFT) : pane;
    case "discard-draft":
      return draft.owner === null ? pane : hold(draft.owner, EMPTY_DRAFT);
  }
}

function paneSessionTransition(pane: PaneState, event: PaneSessionEvent): PaneState {
  const { session } = pane;
  /** a change to the session, or the pane itself when nothing changes */
  const set = (patch: Partial<PaneSession>): PaneState =>
    ((Object.keys(patch) as Array<keyof PaneSession>).every((key) => patch[key] === session[key]) ? pane : { ...pane, session: { ...session, ...patch } });
  switch (event.type) {
    case "pane-attached":
      return { ...pane, session: { ...NO_SESSION, paneId: event.paneId } };
    case "pane-output-failed":
      return { ...pane, connected: false, session: { ...session, outputError: event.message, ended: true } };
    case "pane-socket-lost":
      return set({ outputReady: false, inputReady: false, held: false });
    case "dismiss-input-error":
      return set({ inputError: null });
  }
  if (event.paneId !== session.paneId) return pane;
  switch (event.type) {
    case "pane-output":
      return set({ outputReady: true, secret: event.secret });
    case "pane-input-ready":
      return set({ inputReady: event.ready });
    case "pane-attach-held":
      return set({ held: true });
    case "pane-attach-resumed":
      return set({ held: false });
    case "pane-exited":
      return set({ ended: true });
    case "pane-input-failed":
      return set({ inputError: event.message });
    case "pane-terminal-unsupported":
      return set({ unsupported: true });
  }
}

/** The chat may read the pane's prompt (the page aside): open on a live pane with an agent. */
function chatAsks(state: UiState): boolean {
  const { chat, pane } = state;
  return chat.open !== null && chat.agent && pane.connected && !(pane.session.paneId === chat.open.paneId && pane.session.ended);
}

/** ...and reads it now: the page is on screen too. */
const chatReads = (state: UiState): boolean => chatAsks(state) && state.connection.visible;

/** A prompt read starts, ending the one before. */
function readChatPrompt(state: UiState, effects: Effect[]): ChatState {
  const { chat } = state;
  const promptSeq = chat.promptSeq + 1;
  if (chat.open !== null) effects.push({ kind: "load-chat-prompt", machineId: chat.open.machineId, paneId: chat.open.paneId, seq: promptSeq, sent: chat.sent });
  return { ...chat, promptSeq };
}

/** The prompt shown changes: a typed pick belongs to the prompt it was typed for. */
function showPrompt(chat: ChatState, prompt: InteractivePrompt | null): ChatState {
  const kept = chat.prompt !== null && prompt !== null && chat.prompt.id === prompt.id ? chat.prompt : prompt;
  const pendingAnswer = chat.pendingAnswer !== null && chat.pendingAnswer.promptId !== kept?.id ? null : chat.pendingAnswer;
  // what the card said of its answer is for that prompt only
  const card = chat.card !== null && chat.card.promptId !== kept?.id ? null : chat.card;
  return kept === chat.prompt && pendingAnswer === chat.pendingAnswer && card === chat.card ? chat : { ...chat, prompt: kept, pendingAnswer, card };
}

/** the card's answer on its way for this pane, if any */
function cardAnswering(state: UiState, machineId: string, paneId: string): ChatState["card"] {
  const sending = Object.values(state.sends.pending).find((pending) => pending.target === "card" && pending.machineId === machineId && pending.paneId === paneId);
  return sending?.target === "card" ? { promptId: sending.promptId, status: "pending" } : null;
}

type ChatEvent = Extract<UiEvent, { type: "chat-open" | "chat-close" | "chat-agent" | "poll-chat-prompt" | "chat-prompt-read" | "chat-prompt-failed" | "chat-pending-answer" | "chat-pending-answer-done" }>;

function chatTransition(state: UiState, event: ChatEvent, effects: Effect[]): ChatState {
  const { chat } = state;
  const here = (paneId: string): boolean => chat.open?.paneId === paneId;
  switch (event.type) {
    case "chat-open":
      if (chat.open?.machineId === event.machineId && here(event.paneId)) return chat;
      // another pane: nothing of the one before holds, and its reads answer too late; the settings
      // reported are kept by pane, so the same pane opened again shows them at once; an answer
      // still on its way from its card holds the card when its prompt shows again
      return { ...chat, open: { machineId: event.machineId, paneId: event.paneId }, agent: false, prompt: null, suggestion: null, pendingAnswer: null, card: cardAnswering(state, event.machineId, event.paneId), promptSeq: chat.promptSeq + 1, seek: null };
    case "chat-close":
      if (chat.open?.machineId !== event.machineId || !here(event.paneId)) return chat;
      return { ...chat, open: null, agent: false, prompt: null, suggestion: null, pendingAnswer: null, card: null, promptSeq: chat.promptSeq + 1 };
    case "chat-agent":
      return here(event.paneId) && chat.agent !== event.agent ? { ...chat, agent: event.agent } : chat;
    case "chat-pending-answer":
      return { ...chat, pendingAnswer: { promptId: event.promptId, answer: event.answer } };
    case "chat-pending-answer-done":
      return chat.pendingAnswer === null ? chat : { ...chat, pendingAnswer: null };
  }
  if (event.seq !== chat.promptSeq || !chatReads(state)) return chat;
  if (event.type === "poll-chat-prompt") return readChatPrompt(state, effects);
  effects.push({ kind: "later", ms: CHAT_POLL_MS, event: { type: "poll-chat-prompt", seq: chat.promptSeq } });
  if (event.type === "chat-prompt-failed") {
    const failed = showPrompt(chat, null);
    return failed.suggestion === null ? failed : { ...failed, suggestion: null };
  }
  const shown = showPrompt(chat, event.prompt);
  // a read begun before the latest send answers for the turn before it: its suggestion is dropped
  if (event.sent !== chat.sent || shown.suggestion === event.suggestion) return shown;
  return { ...shown, suggestion: event.suggestion };
}

/** A prompt asked for in the open chat; with no chat open there is nothing to scroll. */
function seekPrompt(chat: ChatState, to: -1 | 1 | { key: string }): ChatState {
  return chat.open === null ? chat : { ...chat, seek: { to, seq: (chat.seek?.seq ?? 0) + 1 } };
}

/** The settings a read reported for the pane; the same settings keep the same object, as every poll would otherwise re-render the composer. */
function reportMetadata(chat: ChatState, paneId: string, value: ConversationMetadata | null): ChatState {
  const before = chat.metadata;
  if (before?.paneId === paneId && before.value?.model === value?.model && before.value?.reasoning_effort === value?.reasoning_effort
    && before.value?.context?.used === value?.context?.used && before.value?.context?.window === value?.context?.window) return chat;
  return { ...chat, metadata: { paneId, value } };
}

/** The open pane's agent status, as the PCs' sessions say it. */
function openPaneStatus(state: UiState): AgentStatus | undefined {
  const open = state.conversation.open;
  if (open === null) return undefined;
  return state.machines.list.find((machine) => machine.id === open.machineId)?.snapshot?.panes.find((pane) => pane.pane_id === open.paneId)?.agent_status;
}

/** The conversation is read while the chat is open on a pane and the page is on screen. */
const conversationReads = (state: UiState): boolean => state.conversation.open !== null && state.connection.visible;

/** A read of the newest page starts, ending the chain before (its answer is dropped, its timer too). */
function readConversation(conversation: ConversationState, effects: Effect[]): ConversationState {
  if (conversation.open === null) return conversation;
  const seq = conversation.seq + 1;
  effects.push({ kind: "read-conversation", ...conversation.open, from: conversation.older.heldFrom, seq, olderSeq: conversation.olderSeq });
  return { ...conversation, seq, pending: null };
}

/** The earlier pages go: a load still in flight for them answers too late. */
const dropOlder = (conversation: ConversationState): ConversationState => ({ ...conversation, olderSeq: conversation.olderSeq + 1, older: NO_OLDER });

/** ...and what was laid out with them: the next answer lays out afresh. */
const startOver = (conversation: ConversationState): ConversationState => ({ ...dropOlder(conversation), view: EMPTY_VIEW, signature: "", answer: null, fresh: true });

type ConversationEvent = Extract<UiEvent, { type: "poll-conversation" | "conversation-read" | "conversation-gap-filled" | "conversation-scrollback-read" | "load-older-conversation" | "older-conversation-read" }>;

function conversationTransition(state: UiState, event: ConversationEvent, effects: Effect[]): Transition {
  const { conversation } = state;
  const same: Transition = { state, effects };
  const put = (next: ConversationState, chat = state.chat): Transition =>
    ({ state: next === conversation && chat === state.chat ? state : { ...state, conversation: next, chat }, effects });
  const { open } = conversation;
  if (open === null) return same;
  /** read now, as a page load asks; a hidden page reads once it is back */
  const reread = (next: ConversationState): ConversationState => (conversationReads(state) ? readConversation(next, effects) : next);
  /** the read ended: the next one is a while away */
  const settle = (next: ConversationState): ConversationState => {
    effects.push({ kind: "later", ms: CONVERSATION_POLL_MS, event: { type: "poll-conversation", seq: next.seq } });
    return next;
  };
  /** a failed read: said where the turns would be, the turns read before kept */
  const fail = (message: string, status: number | null): Transition => {
    const error = conversation.error?.message === message && conversation.error.status === status ? conversation.error : { message, status };
    return put(settle(conversation.loaded && error === conversation.error && conversation.pending === null ? conversation : { ...conversation, loaded: true, error, pending: null }));
  };
  /** lays the newest page out, with the turns it moved past joined to the earlier ones */
  const layOut = (base: ConversationState, read: ConversationResponse, moved: ConversationTurn[], view: ConversationView): Transition => {
    let next = base;
    if (moved.length > 0) next = { ...next, older: { ...next.older, turns: [...next.older.turns, ...moved] } };
    const signature = JSON.stringify(view);
    if (signature !== next.signature) next = { ...next, signature, view, fresh: next.signature === "" };
    next = { ...next, error: null, loaded: true, pending: null, answer: read };
    return put(settle(next));
  };
  switch (event.type) {
    case "poll-conversation":
      return event.seq === conversation.seq && conversationReads(state) ? put(readConversation(conversation, effects)) : same;
    case "conversation-read": {
      if (event.seq !== conversation.seq || event.olderSeq !== conversation.olderSeq) return same;
      const { outcome } = event;
      if (outcome.kind === "failed") {
        // a new session or a Codex backtrack replaced the transcript the earlier pages came from
        if (outcome.status === 409 && conversation.older.heldFrom !== null) {
          const over = startOver(conversation);
          effects.push({ kind: "read-conversation", ...open, from: null, seq: over.seq, olderSeq: over.olderSeq });
          return put(over);
        }
        return fail(outcome.message, outcome.status);
      }
      const read = outcome.conversation;
      let next = conversation;
      if (next.historyId !== read.history_id) next = { ...dropOlder(next), historyId: read.history_id };
      // a 304 hands back the answer already shown: nothing to compare or lay out again
      if (read === next.answer) return put(settle(next.error === null ? next : { ...next, error: null }));
      // the newest page moved past the held start: the turns in between join the earlier pages and
      // the newest page is held from its new start, so no poll reads more than a page
      const held = next.older.heldFrom;
      if (held !== null && read.source !== "scrollback" && typeof read.cursor === "string" && read.cursor !== held) {
        effects.push({ kind: "fill-conversation-gap", ...open, held, start: read.cursor, seq: next.seq, olderSeq: next.olderSeq });
        return put({ ...next, pending: { conversation: read, moved: [] } });
      }
      return arrive(next, read, []);
    }
    case "conversation-gap-filled": {
      const { pending } = conversation;
      if (event.seq !== conversation.seq || event.olderSeq !== conversation.olderSeq || pending === null) return same;
      if (event.turns === null) return put(readConversation(startOver(conversation), effects));
      const cursor = pending.conversation.cursor as string;
      return arrive({ ...conversation, older: { ...conversation.older, heldFrom: cursor } }, pending.conversation, event.turns);
    }
    case "conversation-scrollback-read": {
      const { pending } = conversation;
      if (event.seq !== conversation.seq || event.olderSeq !== conversation.olderSeq || pending === null) return same;
      if (event.outcome.kind === "failed") return fail(event.outcome.message, event.outcome.status);
      const view: ConversationView = { source: "scrollback", turns: [], messages: toTranscriptMessages(event.outcome.text).filter((message) => message.role !== "status"), truncated: event.outcome.truncated };
      return layOut(conversation, pending.conversation, pending.moved, view);
    }
    case "load-older-conversation": {
      const { older } = conversation;
      if (older.status === "loading" || typeof older.cursor !== "string") return same;
      effects.push({ kind: "read-older-conversation", ...open, before: older.cursor, olderSeq: conversation.olderSeq });
      return put({ ...conversation, older: { ...older, status: "loading" } });
    }
    case "older-conversation-read": {
      if (event.olderSeq !== conversation.olderSeq) return same;
      const { outcome } = event;
      const { older } = conversation;
      if (outcome.kind === "failed") {
        if (outcome.status === 409) return put(reread(startOver(conversation)));
        return put({ ...conversation, older: { ...older, status: "failed" } });
      }
      const page = outcome.conversation;
      if (page.history_id !== conversation.historyId) return put(reread(startOver(conversation)));
      // a bridge without pages answers with its newest turns: nothing older to add
      if (page.source === "scrollback" || page.cursor === undefined) return put({ ...conversation, older: { ...older, cursor: undefined, status: "idle" } });
      const first = older.heldFrom === null;
      const next = { ...conversation, older: { turns: [...page.turns, ...older.turns], cursor: page.cursor, status: "idle" as const, heldFrom: older.heldFrom ?? event.before } };
      // the newest page may have slid since it was read: it is polled from the held start now
      return put(first ? reread(next) : next);
    }
  }

  /** a page read in full (its gap joined): what it says of the pane is taken, and it is laid out (a scrollback read first) */
  function arrive(base: ConversationState, read: ConversationResponse, moved: ConversationTurn[]): Transition {
    let next = base;
    if (next.older.heldFrom === null) next = { ...next, older: { ...next.older, cursor: read.source === "scrollback" ? undefined : read.cursor } };
    const chat = reportMetadata(state.chat, open!.paneId, read.source === "scrollback" ? null : read.metadata ?? null);
    const abandoned = read.abandoned ?? null;
    if (JSON.stringify(abandoned) !== JSON.stringify(next.abandoned)) next = { ...next, abandoned };
    if (read.source === "scrollback") {
      effects.push({ kind: "read-conversation-scrollback", ...open!, lines: TRANSCRIPT_LINES, seq: next.seq, olderSeq: next.olderSeq });
      return put({ ...next, pending: { conversation: read, moved } }, chat);
    }
    const laid = layOut(next, read, moved, { source: "conversation", turns: read.turns, messages: [], truncated: false });
    return chat === state.chat ? laid : { ...laid, state: { ...laid.state, chat } };
  }
}

type AttachmentsEvent = Extract<UiEvent, { type: "attach-files" | "upload-done" | "upload-failed" | "remove-attachment" | "attachments-sent" | "attachments-close" }>;

function attachmentsTransition(attachments: AttachmentsState, event: AttachmentsEvent, effects: Effect[]): AttachmentsState {
  const { owner } = event;
  const list = attachments.lists[owner] ?? [];
  const going = attachments.uploading[owner] ?? [];
  /** the batch's next file waiting goes up, one at a time within it */
  const startNext = (next: ComposerAttachment[], inFlight: Array<{ id: number; batch: number }>, batch: number): AttachmentsState => {
    const waiting = next.find((item) => item.batch === batch && item.state === "uploading" && !inFlight.some((upload) => upload.id === item.id));
    if (waiting !== undefined) {
      effects.push({ kind: "upload-file", owner, id: waiting.id, machineId: waiting.machineId, paneId: waiting.paneId, file: waiting.file });
      inFlight = [...inFlight, { id: waiting.id, batch }];
    }
    return { ...attachments, lists: { ...attachments.lists, [owner]: next }, uploading: { ...attachments.uploading, [owner]: inFlight } };
  };
  switch (event.type) {
    case "attach-files": {
      let seq = attachments.seq;
      const batch = seq + 1;
      const added = event.files.map((file): ComposerAttachment => ({ id: ++seq, file, machineId: event.machineId, paneId: event.paneId, batch, path: null, state: "uploading" }));
      return { ...startNext([...list, ...added], going, batch), seq };
    }
    case "upload-done":
    case "upload-failed": {
      // a composer gone answers to nothing
      const upload = going.find((item) => item.id === event.id);
      if (upload === undefined) return attachments;
      // a file removed while it went up: its answer changes nothing, and its batch goes on
      const settled = list.map((item) => (item.id !== event.id ? item
        : event.type === "upload-done" ? { ...item, path: event.path, state: "ready" as const } : { ...item, state: "error" as const, error: event.message }));
      return startNext(settled, going.filter((item) => item.id !== event.id), upload.batch);
    }
    case "remove-attachment":
    case "attachments-sent": {
      if (attachments.lists[owner] === undefined) return attachments;
      const gone = event.type === "remove-attachment" ? [event.id] : event.ids;
      return { ...attachments, lists: { ...attachments.lists, [owner]: list.filter((item) => !gone.includes(item.id)) } };
    }
    case "attachments-close": {
      if (attachments.lists[owner] === undefined && attachments.uploading[owner] === undefined) return attachments;
      const { [owner]: _list, ...lists } = attachments.lists;
      const { [owner]: _upload, ...uploading } = attachments.uploading;
      return { ...attachments, lists, uploading };
    }
  }
}

type CompletionsEvent = Extract<UiEvent, { type: "completions-open" | "commands-loaded" | "slash-usage-loaded" | "file-query" | "search-files" | "files-found" | "slash-used" }>;

function completionsTransition(completions: CompletionsState, event: CompletionsEvent, effects: Effect[]): CompletionsState {
  const { files } = completions;
  switch (event.type) {
    case "completions-open":
      // the usage is read anew each time: another tab may have counted since
      effects.push({ kind: "load-commands", machineId: event.machineId, paneId: event.paneId }, { kind: "load-slash-usage" });
      return { ...completions, commands: { machineId: event.machineId, paneId: event.paneId, list: [] } };
    case "commands-loaded": {
      const { commands } = completions;
      if (commands?.machineId !== event.machineId || commands.paneId !== event.paneId) return completions;
      return { ...completions, commands: { ...commands, list: event.commands } };
    }
    case "slash-usage-loaded":
      return { ...completions, slashUsage: event.usage };
    case "file-query": {
      const samePane = files.paneId === event.paneId && files.machineId === event.machineId;
      if (files.query === event.query && samePane) return completions;
      const seq = files.seq + 1;
      if (event.query !== null) effects.push({ kind: "later", ms: FILE_SEARCH_DELAY_MS, event: { type: "search-files", seq } });
      // the list shown stays while the name is typed on, never into another pane's menu
      return { ...completions, files: { seq, machineId: event.machineId, paneId: event.paneId, query: event.query, list: event.query !== null && samePane ? files.list : [] } };
    }
    case "search-files":
      if (event.seq !== files.seq || files.query === null) return completions;
      effects.push({ kind: "search-files", machineId: files.machineId, paneId: files.paneId, query: files.query, seq: files.seq });
      return completions;
    case "files-found":
      return event.seq === files.seq ? { ...completions, files: { ...files, list: event.files } } : completions;
    case "slash-used": {
      const slashUsage = { ...completions.slashUsage, [event.name]: (completions.slashUsage[event.name] ?? 0) + 1 };
      effects.push({ kind: "save-slash-usage", usage: slashUsage });
      return { ...completions, slashUsage };
    }
  }
}

type SendEvent = Extract<UiEvent, { type: "composer-send" | "line-send" | "queue-send" | "submit-started" | "send-result" | "answer-result" | "prompt-card-answer" }>;

/**
 * A message from a composer, an input line or a held message: never queued to fire later. It goes
 * the way the pane takes it now (an answer to its waiting prompt, held while the agent works, or
 * typed and submitted), and the box keeps its text until the pane took it, with why if it did not.
 */
function sendTransition(state: UiState, event: SendEvent, effects: Effect[]): Transition {
  const { sends } = state;
  const composerDraft = (owner: string, change: ComposerDraftChange): void => { effects.push({ kind: "composer-draft-change", owner, change }); };
  const lineDraft = (owner: string, change: LineDraftChange): void => { effects.push({ kind: "line-draft-change", owner, change }); };
  /** what a box's send came to, said in it */
  const said = (next: UiState, box: string, id: number, outcome: SendOutcome): UiState =>
    ({ ...next, sends: { ...next.sends, outcomes: { ...next.sends.outcomes, [box]: { id, outcome } } } });
  /** a request under way */
  const start = (pending: PendingSend): { id: number; next: UiState } => {
    const id = sends.seq + 1;
    return { id, next: { ...state, sends: { ...sends, seq: id, pending: { ...sends.pending, [id]: pending } } } };
  };
  /** the terminal takes a message now: not into a masked prompt, nor one another app holds */
  const takes = state.pane.session.secret === null && !state.pane.session.held;
  const busy = (owner: string, target: PendingSend["target"]): boolean => Object.values(sends.pending).some((pending) => pending.target === target && "owner" in pending && pending.owner === owner);
  switch (event.type) {
    case "composer-send": {
      const { owner, text, via } = event;
      const box = `composer:${owner}`;
      if (busy(owner, "composer")) return { state, effects };
      const id = sends.seq + 1;
      const counted = { ...state, sends: { ...sends, seq: id } };
      const prompt = state.chat.open?.paneId === event.paneId ? state.chat.prompt : null;
      /** the box's text went where it was asked: only what was sent leaves it */
      const cleared = (next: UiState): Transition => {
        if (via === "box") { composerDraft(owner, { kind: "begin", sent: text }); composerDraft(owner, { kind: "settle", sent: text }); composerDraft(owner, { kind: "end" }); }
        return { state: said(next, box, id, { kind: "sent" }), effects };
      };
      // Codex's queue open in the terminal holds the input: a message would become the answer
      if (prompt?.queued === "open") return { state: said(counted, box, id, { kind: "open-queue" }), effects };
      if (prompt !== null && !prompt.queued && !prompt.fallback) {
        // never typed into the agent's menu: only as one of its options, or its own reply row
        const answer = answerFromText(prompt, text);
        if (answer === null) return { state: said(counted, box, id, { kind: "refused", prompt }), effects };
        if (needsConfirmation(prompt, answer)) return cleared({ ...counted, chat: { ...state.chat, pendingAnswer: { promptId: prompt.id, answer } } });
        const answering = { ...state, chat: state.chat.pendingAnswer === null ? state.chat : { ...state.chat, pendingAnswer: null }, sends: { ...sends, seq: id, pending: { ...sends.pending, [id]: { target: "composer", owner, via, sent: text } as PendingSend } } };
        composerDraft(owner, via === "box" ? { kind: "begin", sent: text } : { kind: "begin" });
        effects.push({ kind: "answer-prompt", id, machineId: event.machineId, paneId: event.paneId, promptId: prompt.id, answer });
        return { state: answering, effects };
      }
      if (event.working) {
        // the composer may clear its box: the text lives in the held message
        effects.push({ kind: "queue-change", owner, change: { kind: "add", text } });
        return cleared(counted);
      }
      if (!takes) return { state: said(counted, box, id, { kind: "not-sent" }), effects };
      const { next } = start({ target: "composer", owner, via, sent: text });
      composerDraft(owner, via === "box" ? { kind: "begin", sent: text } : { kind: "begin" });
      effects.push({ kind: "submit", id, paneId: event.paneId, text: composerMessage(text), payload: composerPayload(text, event.bracketedPaste), typed: false });
      return { state: next, effects };
    }
    case "line-send": {
      const { owner, text } = event;
      if (busy(owner, "line")) return { state, effects };
      // the line goes into an open menu as typed: only a masked prompt holds it
      if (state.pane.session.secret !== null) return { state: said({ ...state, sends: { ...sends, seq: sends.seq + 1 } }, `line:${owner}`, sends.seq + 1, { kind: "not-sent" }), effects };
      const message = composerMessage(text);
      const { id, next } = start({ target: "line", owner });
      lineDraft(owner, { kind: "begin" });
      // several lines go as one paste
      effects.push({ kind: "submit", id, paneId: event.paneId, text: message, payload: message.includes("\n") ? composerPayload(text, event.bracketedPaste) : message, typed: true });
      return { state: next, effects };
    }
    case "queue-send": {
      // one at a time: the pane takes them in the order the person sends them
      if (state.queue.sending !== null) return { state, effects };
      if (!takes) return { state: { ...state, queue: { ...state.queue, error: { owner: event.owner, id: event.id, note: { kind: "not-sent" } } } }, effects };
      const { id, next } = start({ target: "queue", owner: event.owner, queueId: event.id });
      effects.push({ kind: "submit", id, paneId: event.paneId, text: composerMessage(event.text), payload: composerPayload(event.text, event.bracketedPaste), typed: false });
      return { state: { ...next, queue: { ...next.queue, sending: { owner: event.owner, id: event.id }, error: null } }, effects };
    }
    case "prompt-card-answer": {
      // one answer at a time, for the prompt the card shows on the pane open
      const { open, prompt } = state.chat;
      if (open?.machineId !== event.machineId || open.paneId !== event.paneId || prompt?.id !== event.promptId) return { state, effects };
      if (cardAnswering(state, event.machineId, event.paneId)?.promptId === event.promptId) return { state, effects };
      const { id, next } = start({ target: "card", machineId: event.machineId, paneId: event.paneId, promptId: event.promptId, typed: event.typed });
      effects.push({ kind: "answer-prompt", id, machineId: event.machineId, paneId: event.paneId, promptId: event.promptId, answer: event.answer });
      return { state: { ...next, chat: { ...next.chat, card: { promptId: event.promptId, status: "pending" } } }, effects };
    }
    case "submit-started": {
      const started = sends.pending[event.id];
      if (started === undefined) return { state, effects };
      const next = { ...state, sends: { ...sends, started: sends.started + 1 } };
      // a message went out, from the box or a held one: the agent's suggestion was for the turn before it
      if (started.target === "line") return { state: next, effects };
      return { state: { ...next, chat: { ...next.chat, sent: next.chat.sent + 1, suggestion: null } }, effects };
    }
  }
  const pending = sends.pending[event.id];
  if (pending === undefined) return { state, effects };
  const { [event.id]: _done, ...rest } = sends.pending;
  let next: UiState = { ...state, sends: { ...sends, pending: rest } };
  const ok = event.outcome.kind === "ok";
  if (event.type === "answer-result" && pending.target === "card") {
    const { chat } = next;
    // an answer for a prompt no longer shown (another pane open, or the prompt moved on) says nothing here
    if (chat.open?.machineId !== pending.machineId || chat.open.paneId !== pending.paneId || chat.prompt?.id !== pending.promptId) return { state: next, effects };
    // a typed pick waiting for Confirm goes once its Confirm answered, whatever came of it, and
    // with the prompt once it is answered
    const pendingAnswer = pending.typed ? null : chat.pendingAnswer;
    if (event.outcome.kind === "ok") {
      const answered: UiState = { ...next, chat: { ...showPrompt({ ...chat, pendingAnswer: null }, null), card: null } };
      return { state: answered, effects };
    }
    if (event.outcome.status === 409 && event.outcome.code === "prompt_changed") {
      const seq = event.id;
      const changed: UiState = { ...next, chat: { ...chat, pendingAnswer, card: { promptId: pending.promptId, status: "changed", seq } } };
      const reread = chatReads(changed) ? { ...changed, chat: readChatPrompt(changed, effects) } : changed;
      effects.push({ kind: "later", ms: CARD_CHANGED_MS, event: { type: "prompt-card-clear", seq } });
      return { state: reread, effects };
    }
    return { state: { ...next, chat: { ...chat, pendingAnswer, card: { promptId: pending.promptId, status: "failed", message: event.outcome.message } } }, effects };
  }
  if (event.type === "answer-result") {
    if (pending.target !== "composer") return { state: next, effects };
    if (ok && pending.via === "box") composerDraft(pending.owner, { kind: "settle", sent: pending.sent });
    composerDraft(pending.owner, { kind: "end" });
    const outcome: SendOutcome = event.outcome.kind === "ok" ? { kind: "sent" }
      : event.outcome.status === 409 ? { kind: "answer-changed" } : { kind: "answer-failed", message: event.outcome.message };
    next = said(next, `composer:${pending.owner}`, event.id, outcome);
    // the prompt is read again now: answered, or moved on
    return { state: chatReads(next) ? { ...next, chat: readChatPrompt(next, effects) } : next, effects };
  }
  const outcome: SendOutcome = event.outcome.kind === "ok" ? { kind: "sent" } : event.outcome.kind === "failed" ? { kind: "submit-failed", code: event.outcome.code, message: event.outcome.message } : event.outcome;
  if (pending.target === "queue") {
    const result: QueueSendResult = outcome.kind === "sent" ? { kind: "sent" } : outcome.kind === "submit-failed" ? { kind: "submit-failed", code: outcome.code, message: outcome.message }
      : outcome.kind === "unconfirmed" ? { kind: "unconfirmed" } : { kind: "not-sent" };
    const queued = settleQueueSend(next.queue, pending.owner, pending.queueId, result, effects);
    next = { ...next, queue: queued };
    // the chat lens reads at once so the sent prompt appears without a poll beat
    return { state: ok ? { ...next, chat: { ...next.chat, delivered: next.chat.delivered + 1 } } : next, effects };
  }
  if (pending.target === "line") {
    // text typed while it was on its way stays
    if (ok) lineDraft(pending.owner, { kind: "acknowledge" });
    lineDraft(pending.owner, { kind: "end" });
    return { state: said(next, `line:${pending.owner}`, event.id, outcome), effects };
  }
  if (pending.target === "card") return { state: next, effects };
  if (ok && pending.via === "box") composerDraft(pending.owner, { kind: "settle", sent: pending.sent });
  composerDraft(pending.owner, { kind: "end" });
  next = said(next, `composer:${pending.owner}`, event.id, outcome);
  return { state: ok ? { ...next, chat: { ...next.chat, delivered: next.chat.delivered + 1 } } : next, effects };
}

type QueueEvent = Extract<UiEvent, { type: "queue-open" | "queue-stored" | "queue-edit" | "queue-discard" | "queue-loaded" }>;

function queueTransition(queue: QueueState, event: QueueEvent, effects: Effect[]): QueueState {
  const change = (owner: string, asked: QueueChange): QueueState => { effects.push({ kind: "queue-change", owner, change: asked }); return queue; };
  switch (event.type) {
    case "queue-open":
      return change(event.owner, { kind: "read" });
    case "queue-stored":
      return change(event.owner, { kind: "refresh" });
    case "queue-edit":
      return change(event.owner, { kind: "edit", id: event.id, text: event.text });
    case "queue-discard":
      return change(event.owner, { kind: "remove", id: event.id });
    case "queue-loaded": {
      const { [event.owner]: _kept, ...saved } = queue.unsaved;
      const unsaved = event.unsaved ? { ...queue.unsaved, [event.owner]: true as const } : saved;
      const same = queue.lists[event.owner] === event.messages && Boolean(queue.unsaved[event.owner]) === event.unsaved;
      return same ? queue : { ...queue, lists: { ...queue.lists, [event.owner]: event.messages }, unsaved };
    }
  }
}

/** A held message's send ended: taken by the pane, it leaves the queue; refused, it stays and says why. */
function settleQueueSend(queue: QueueState, owner: string, id: string, result: QueueSendResult, effects: Effect[]): QueueState {
  if (queue.sending?.owner !== owner || queue.sending.id !== id) return queue;
  if (result.kind === "sent") {
    effects.push({ kind: "queue-change", owner, change: { kind: "remove", id } });
    return { ...queue, sending: null };
  }
  return { ...queue, sending: null, error: { owner, id, note: result } };
}

type FoldersEvent = Extract<UiEvent, { type: "open-folders" | "close-folders" | "browse-folder" | "show-hidden-folders" | "folders-listed" | "folders-failed" }>;

function foldersTransition(folders: FoldersState, event: FoldersEvent, effects: Effect[]): FoldersState {
  const { slot } = event;
  const browser = folders.open[slot];
  const put = (next: FolderBrowserState | undefined, seq = folders.seq): FoldersState => {
    const { [slot]: _gone, ...rest } = folders.open;
    return { open: next === undefined ? rest : { ...rest, [slot]: next }, seq };
  };
  /** the browser reads `path`, the newest read counting */
  const read = (from: FolderBrowserState, path: string, patch: Partial<FolderBrowserState> = {}): FoldersState => {
    const seq = folders.seq + 1;
    const next = { ...from, ...patch, loading: true, seq };
    effects.push({ kind: "list-folders", slot, machineId: next.machineId, path, hidden: next.hidden, files: next.files, seq });
    return put(next, seq);
  };
  if (event.type === "open-folders") {
    return read({ owner: event.owner, machineId: event.machineId, files: event.files, listing: null, hidden: false, loading: true, error: null, homeIfInvalid: true, seq: 0 }, event.start);
  }
  if (browser === undefined) return folders;
  switch (event.type) {
    case "close-folders":
      return put(undefined);
    case "browse-folder":
      return read(browser, event.path, { homeIfInvalid: false });
    case "show-hidden-folders":
      // with nothing listed yet, the read under way lists it; the choice holds for the next
      if (browser.listing === null) return put({ ...browser, hidden: event.hidden, homeIfInvalid: false });
      return read(browser, browser.listing.path, { hidden: event.hidden, homeIfInvalid: false });
    case "folders-listed":
      if (event.seq !== browser.seq) return folders;
      return put({ ...browser, listing: event.listing, error: null, loading: false, homeIfInvalid: false });
    case "folders-failed":
      if (event.seq !== browser.seq) return folders;
      // a path typed half-way opens home instead of an error
      if (browser.homeIfInvalid && event.reason === "invalid") return read(browser, "", { homeIfInvalid: false });
      return put({ ...browser, error: event.reason, loading: false, homeIfInvalid: false });
  }
}

type FilesEvent = Extract<UiEvent, { type: "open-files" | "close-files" | "open-file" | "viewer-open" | "choose-candidate" | "close-file" | "file-history" | "file-loaded" | "file-text" | "file-folder" }>;

/** a path a remote PC's bridge reads as given: a relative one it may read from its own folder */
const ABSOLUTE_PATH = /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/])/;

function filesTransition(state: UiState, event: FilesEvent, effects: Effect[]): Transition {
  const { files } = state;
  const { viewer } = files;
  const next = (patch: Partial<FilesState>): Transition => ({ state: { ...state, files: { ...files, ...patch } }, effects });
  const same: Transition = { state, effects };
  /** the viewer on `preview`, showing `path`, read now or once this browser is in */
  const read = (preview: FilePreview, path: string): Transition => {
    const viewing = { ...state, files: { ...files, viewer: { preview, path, content: { kind: "opening" as const }, closing: false } } };
    return { state: readFile(viewing, effects, state.connection.locked === false), effects };
  };
  /** an answer to the read under way changes what the viewer shows */
  const shown = (content: FileContent): Transition => (viewer ? next({ viewer: { ...viewer, content } }) : same);
  switch (event.type) {
    case "open-files":
      if (state.selection.paneId === null) return same;
      return { state: { ...state, drawerOpen: false, files: { ...files, dialog: true } }, effects };
    case "close-files":
      return files.dialog ? next({ dialog: false }) : same;
    case "open-file":
    case "viewer-open": {
      if (viewer?.closing) return same;
      if (event.type === "viewer-open" && viewer === null) return same;
      const preview = event.type === "viewer-open" && viewer !== null
        ? { ...viewer.preview, path: event.path }
        : { path: event.path, paneId: state.selection.paneId, machineId: state.selection.machineId };
      effects.push({ kind: "history-preview", preview, replace: viewer !== null });
      return read(preview, event.path);
    }
    case "choose-candidate":
      return viewer && !viewer.closing ? read(viewer.preview, event.path) : same;
    case "close-file":
      if (viewer === null || viewer.closing) return same;
      effects.push({ kind: "history-back" });
      return next({ viewer: { ...viewer, closing: true } });
    case "file-history": {
      const { preview } = event;
      if (preview === null) return viewer === null ? same : next({ viewer: null });
      if (viewer && viewer.preview.path === preview.path && viewer.preview.paneId === preview.paneId && viewer.preview.machineId === preview.machineId) {
        return viewer.closing ? next({ viewer: { ...viewer, closing: false } }) : same;
      }
      return read(preview, preview.path);
    }
  }
  if (viewer === null || event.seq !== files.seq) return same;
  const { machineId, paneId } = viewer.preview;
  switch (event.type) {
    case "file-loaded": {
      const { outcome } = event;
      switch (outcome.kind) {
        case "info":
          // only the first part of a text file travels, from the file found (a bare name may be deeper in the folder)
          if (outcome.info.kind === "text") effects.push({ kind: "load-file-text", machineId, paneId, path: outcome.info.path, seq: event.seq });
          return shown({ kind: "file", info: outcome.info, text: null });
        case "candidates":
          return shown({ kind: "candidates", candidates: outcome.candidates });
        case "missing":
          // a folder is listed from the pane's folder, as a file is found from it
          if (machineId !== LOCAL_MACHINE && !ABSOLUTE_PATH.test(viewer.path)) return shown({ kind: "failed", reason: "missing" });
          effects.push({ kind: "list-folder", machineId, paneId, path: viewer.path, seq: event.seq });
          return same;
        case "outside":
        case "failed":
          return shown({ kind: "failed", reason: outcome.kind });
      }
      return same;
    }
    case "file-text":
      return viewer.content.kind === "file" ? shown({ ...viewer.content, text: event.text }) : same;
    case "file-folder":
      return shown(event.path === null ? { kind: "failed", reason: "missing" } : { kind: "folder", path: event.path });
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
