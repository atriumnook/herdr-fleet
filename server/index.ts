import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import type { ServerWebSocket } from "bun";

import type { AgentKind, ClientMessage, ClientRole, HealthAuth, HerdrPane, ServerFeature, ServerMessage, SessionSnapshot } from "../shared/protocol.ts";
import { paneTitle } from "../shared/notify-policy.ts";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { DEVICE_COOKIE, handleAuthRequest, isAuthenticated, parseCookies, requiresAuth, unauthorizedJson } from "./auth.ts";
import { cameThroughProxy, decideAccess, isLoopbackAddress } from "./access.ts";
import { DeviceStore, handleDeviceRequest } from "./devices.ts";
import { remoteAccess, tailscaleIdentity } from "./tailscale.ts";
import { paneCommands } from "./commands.ts";
import { paneFiles } from "./files.ts";
import { badRequest, errorResponse, isCount, isJsonObject, jsonResponse, sameOrigin } from "./http.ts";
import { serveStatic } from "./static.ts";
import { startStatusCollector } from "./collector.ts";
import { conversationImage, ConversationUnavailable, HistoryChanged, paneConversation, toolOutput } from "./conversation.ts";
import { CompletionTracker } from "./completion.ts";
import { placeWithProject, WorkspaceProjects } from "./projects.ts";
import { EXPLAIN_MODEL, ExplainCalls, ExplainError, explainQuestion, explainRequest, type ExplainDeps } from "./explain.ts";
import { freeAgentName } from "./agent-name.ts";
import { listDirectories } from "./directories.ts";
import { FILE_VIEW_PREFIX, fileInfo, fileResponse, fileRoots, locateFile, parseViewPath, withinRoots } from "./file-view.ts";
import {
  agentManifests,
  agentPrompt,
  agentStart,
  HerdrError,
  herdrSocketPath,
  paneClose,
  paneRead,
  paneScroll,
  paneScrollInfo,
  paneSelectionRead,
  paneRename,
  paneSendKeys,
  paneSendText,
  ping,
  sessionSnapshot,
  workspaceClose,
  workspaceCreate,
  workspaceMove,
  workspaceRename,
} from "./herdr/client.ts";
import { type AlertTiming, createPushService, defaultStateDir, handlePushRequest } from "./push.ts";
import { codexQuestionsCollapsed, handlePromptRequest } from "./prompt.ts";
import { secretPrompt, validSecret } from "../shared/secret-prompt.ts";
import { PasteImageError, savePaneImage } from "./paste.ts";
import { PtySession } from "./pty/session.ts";
import { attachableIdentity, sidecarAvailable } from "./pty/sidecar.ts";
import { MirrorSession } from "./mirror.ts";
import { paneGrid, type Grid } from "./pane-grid.ts";
import { mirrorInput } from "./mirror-input.ts";
import { OutputWindow, OUTPUT_HIGH_BYTES, OUTPUT_HARD_BYTES, OUTPUT_STALL_MS, ReplayBuffer } from "./output-window.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../shared/terminal-flow.ts";

import { BRIDGE_PROTOCOL } from "../shared/machines.ts";
import { MachineManager } from "./machines.ts";
import { discoverAgents } from "./fleet/agents.ts";
import { handleFleetRequest } from "./fleet/api.ts";
import { FleetSettingsStore } from "./fleet/settings.ts";
import { EntranceStore } from "./fleet/entrances.ts";
import { ModelCatalog } from "./fleet/models.ts";
import { loadConfig, loadStandingOrders } from "./fleet/config.ts";
import { Orchestrator, type OrchestratorDeps } from "./fleet/orchestrator.ts";
import { defaultProbes, UsageTracker } from "./fleet/usage.ts";
import { RunRegistry } from "./fleet/registry.ts";
import { HerdrRuntime } from "./fleet/runtime.ts";
import { handleMachineRequest } from "./machine-api.ts";

const MAX_REPLAY_BYTES = 256 * 1024;
/**
 * herdr's refusal of an attach while a read of the same terminal is in progress; it asks
 * for a retry. A read of more lines than an idle alt-screen agent (Codex) shows, like the
 * transcript match's 400, makes herdr scroll the agent's history back with wheel events:
 * up to 15 s, and 5 more to restore it (herdr 0.9, src/server/alt_screen_read.rs). A
 * 400-line read of an idle Codex pane took about a second, refusing every attach meanwhile.
 */
const ATTACH_READ_RACE_RE = /has a read in progress; retry/;
/**
 * herdr's refusal when another client holds the terminal's one attach slot. It is the attach's
 * last line, after its teardown: the same words earlier in the pane's own output are not it.
 */
const ATTACH_HELD_RE = /terminal attach failed: [^\r\n]*(?:already has an attached client|retry with --takeover)[^\r\n]*\s*$/;
/** how long refused attaches are retried: herdr's longest read of that kind */
const ATTACH_RETRY_FOR_MS = 20_000;
const ATTACH_RETRY_MS = 50;
const ATTACH_RETRY_MAX_MS = 500;
/** a refused attach says so within milliseconds of its first bytes: those are held this long */
const ATTACH_HOLD_MS = 100;
/**
 * What `herdr terminal attach` writes itself before herdr has answered: terminal modes set and
 * reset only (mouse reporting off, the alternate screen on; the last one maybe cut short). The
 * answer can come any time after them, later than the hold on a busy PC, so they say nothing
 * about whether the attach took and do not start the hold. A refusal and a screen both begin
 * with something else.
 */
const ATTACH_PREAMBLE_RE = /^(?:\x1b\[\?[\d;]+[hl])*(?:\x1b(?:\[(?:\?[\d;]*)?)?)?$/;
/** how often a terminal another web bridge holds is tried again, while clients here still want it */
const ATTACH_HELD_RETRY_MS = 3_000;
/**
 * herdr refusing an attach, its line (maybe not all of it yet) the last output, before the
 * exit has come. The same words earlier in the pane's own output, with more after them, are not it.
 */
const ATTACH_REFUSING_RE = /terminal attach failed[^\r\n]*\s*$/;
/** how long a refusal's exit is waited for before its output is taken for the pane's own */
const ATTACH_REFUSAL_EXIT_MS = 2_000;
const ATTACH_HELD_MESSAGE = "Another web bridge has this pane open. It connects here as soon as that bridge lets go.";
/**
 * How long a pane whose attach herdr ended is looked up again before its terminal is taken for
 * ended. A live handoff (`herdr update --handoff`, `herdr server live-handoff`) moves every pane
 * to a new server under a new terminal id and cuts each attach with "server shut down", the
 * words a pane that exited gets too. Measured on herdr 0.9.3: the socket answers
 * server_unavailable for ~200 ms, then the pane is back under its new terminal; an exited
 * pane is gone from the snapshot within ~30 ms.
 */
const ATTACH_RELOOKUP_FOR_MS = 5_000;
const ATTACH_RELOOKUP_MS = 100;
/** How often the panes attached here are looked up in herdr's layout, for a rect that changed (regrid). */
const LAYOUT_POLL_MS = 1000;
/** How often the threads' open pull requests are read again from GitHub, for their checks and a merge made there. */
const PULL_REQUEST_POLL_MS = 60_000;
/** How long a regrid waits for herdr to apply its layout to the terminal let go of, and how often it looks. */
const REGRID_SETTLE_MS = 1000;
const REGRID_POLL_MS = 50;
/** what a pane lookup answers for a pane that has no terminal to attach any more */
const PANE_GONE_CODES = new Set(["pane_not_found", "pane_not_restored", "no_terminal"]);
/** The gap between a composer message's text and its Enter (see submitText). */
export const SUBMIT_DELAY_MS = 120;
/**
 * herdr holds a lone ESC typed through the attach pty ~150ms (measured) to tell it from
 * an Alt+key: a composer message waits this long after the pane's last keystroke, so a
 * Stop tapped just before Send still reaches the pane first.
 */
const TYPED_SETTLE_MS = 300;
/**
 * Nothing of a composer message is typed once this long has passed since it reached the
 * server (it can wait behind a stalled one in the pane's queue): it answers submit_timeout
 * instead. A send that starts in time ends within two more 10s RPCs, before the client
 * stops waiting (SUBMIT_TIMEOUT_MS in src/lib/ws.ts), so a message it gave up on never
 * reaches the pane later.
 */
export const SUBMIT_DEADLINE_MS = 45_000;
const SERVER_FEATURES: ServerFeature[] = ["submit", "secret-input", "input-ready"];

/** Bind addresses only this machine can reach, so an unset token is nobody else's business. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
/** how long a burst of fleet run changes is gathered before clients are told once */
const FLEET_CHANGED_MS = 200;
/** what an agent runs in its shell to reach the fleet: this Bun and bin/fleet.ts, both by absolute path */
const FLEET_COMMAND = [process.execPath, resolve(import.meta.dir, "..", "bin", "fleet.ts")].map((part) => /^[\w./-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`).join(" ");

const AGENT_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  omp: "Oh My Pi",
  pi: "pi",
  gemini: "Gemini CLI",
  cursor: "Cursor",
  opencode: "OpenCode",
  copilot: "GitHub Copilot",
  kimi: "Kimi",
  amp: "Amp",
};

function expandedDirectory(value: string): string | null {
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : resolve(value);
  try {
    return statSync(expanded).isDirectory() ? expanded : null;
  } catch {
    return null;
  }
}

async function paneContext(paneId: string): Promise<{ agent: string | null; cwd: string }> {
  const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
  if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
  const cwd = pane.foreground_cwd ?? pane.cwd;
  if (!cwd) throw new HerdrError("cwd_not_found", `pane ${paneId} has no working directory`);
  return { agent: pane.agent ?? pane.agent_session?.agent ?? null, cwd };
}

interface SocketData {
  deviceId?: string;
  readOnly?: boolean;
  revoked?: boolean;
  unwatchDevice?: () => void;
  attached: Set<string>;
  output: Map<string, OutputWindow>;
  closing: boolean;
  /** the connection's authority: observe connections cannot type or resize */
  mode: ClientRole;
}

type Client = ServerWebSocket<SocketData>;

/**
 * One live PTY per pane, shared by every client watching that pane.
 *
 * The terminal is a real `herdr terminal attach` on a PTY rather than repeated
 * `pane.read` snapshots, so the browser receives an actual byte stream: xterm.js
 * keeps screen state and selection, while herdr owns scrollback.
 */
interface PaneAttachment {
  ready: boolean;
  pty: PtySession | MirrorSession;
  /** set when herdr cannot attach here: `pty` repaints the pane's screen (server/mirror.ts), on the pane's own grid */
  mirror?: MirrorSession;
  clients: Set<Client>;
  /**
   * the pty's grid, which every client adopts: the pane's own, as herdr lays it out, unless a
   * viewport sizes it (driver). An attach holds the terminal at its pty's size, so a viewport
   * that kept it after the user left it (a tab left open) had herdr's own screen show the top
   * of a taller grid, the prompt under its bottom edge: a viewport sizes the pane only while
   * it is in front with the focus (a terminal lens in the window the person looks at), and lets
   * go when it leaves.
   */
  cols: number;
  rows: number;
  /** the viewport sizing the pane now, the latest to ask (tmux's window-size latest) */
  driver?: Client;
  /** the pane's own grid when a viewport took it, given back when that viewport lets go */
  ownGrid?: Grid;
  /** the pane's rect in herdr's layout when the grid was read: a change re-reads the grid (regrid) */
  rect?: { width: number; height: number } | null;
  /** lets go of the terminal so herdr applies its layout, reads the grid it got and attaches again */
  regrid?: () => Promise<void>;
  /** bounded tail so a client joining late still sees the current screen */
  replay: ReplayBuffer;
  stalled: Map<Client, number>;
  /** another web bridge holds herdr's one attach slot for this terminal: waiting for it to let go */
  held?: boolean;
  /** the next try at a held terminal; a closed attachment cancels it */
  heldRetry?: ReturnType<typeof setTimeout>;
  /** the next look for the terminal a pane lives on after herdr ended its attach; a closed attachment cancels it */
  relookup?: ReturnType<typeof setTimeout>;
}

/** A file outside the pane's folder, the temp folder and the fleet's results (see fileRoots). */
function outsideRoots(): Response {
  return jsonResponse({ error: { code: "outside_roots", message: "only files in the pane's folder, the temp folder or the fleet's results open here" } }, 403);
}

function send(client: Client, message: ServerMessage): number {
  if (client.data.closing) return 0;
  try {
    const encoded = JSON.stringify(message);
    // Include JSON escaping in the transport budget, before Bun could drop a
    // frame at its own cap. An overload close is explicit and never auto-replayed.
    if (client.getBufferedAmount() + Buffer.byteLength(encoded) > OUTPUT_HARD_BYTES) {
      client.close(OUTPUT_STALLED_CLOSE_CODE, "terminal output transport stalled");
      return 0;
    }
    // -1 means ALREADY queued. Never retry that frame, or terminal bytes repeat.
    const result = client.send(encoded);
    if (result === 0) client.close(OUTPUT_STALLED_CLOSE_CODE, "output delivery failed");
    return result;
  } catch {
    /* client vanished mid-send */
    return 0;
  }
}

export function createServer(
  options: {
    port?: number;
    hostname?: string;
    token?: string;
    /** where VAPID keys and push subscriptions persist; tests pass a temp dir */
    stateDir?: string;
    /** the PC's own Tailscale login, for the identity check; tests set it, otherwise `tailscale status` says */
    tailscaleOwner?: string | null;
    /** Native Codex store; defaults to CODEX_HOME. Tests use an isolated store. */
    codexHome?: string;
    machines?: boolean;
    /** SUBMIT_DEADLINE_MS; tests shorten it */
    submitDeadlineMs?: number;
    /** how long a push alert waits for the pane to change first (server/push.ts); tests send at once */
    alertTiming?: Partial<AlertTiming>;
    /** push endpoints this server stores; tests that serve their own push service accept it here */
    pushEndpoint?: (url: URL) => boolean;
    /** ATTACH_RETRY_FOR_MS; tests shorten it */
    attachRetryForMs?: number;
    /** ATTACH_HELD_RETRY_MS; tests shorten it */
    attachHeldRetryMs?: number;
    /** ATTACH_RELOOKUP_FOR_MS; tests shorten it */
    attachRelookupForMs?: number;
    /** whether herdr can `terminal attach`; unset, its ping says, and this runtime's PTY sidecar has to be runnable. Tests give a Windows herdr's answer, at once or as late as a ping's. */
    terminalAttach?: boolean | (() => Promise<boolean>);
    /** whether this runtime can run the PTY sidecar; unset, server/pty/sidecar.ts says. Tests give a runtime without Node or node-pty, while herdr keeps its own answer. */
    sidecar?: boolean;
    /** the fleet's runtime (herdr unless a test stands in one), roles and config; unset, the real ones */
    fleet?: Partial<Pick<OrchestratorDeps, "runtime" | "agents" | "config" | "standingOrders">> & { usage?: UsageTracker; models?: Pick<ModelCatalog, "unknown" | "listAll">; userDir?: string; homeDir?: string };
    /** what an explanation's call uses in place of the real one: tests give a fake claude, a conversation and the account's answer */
    explain?: Partial<Pick<ExplainDeps, "command" | "conversation" | "unavailable" | "timeoutMs" | "killAfterMs" | "env">>;
  } = {},
): { port: number; hostname: string; stop: () => void } {
  const attachments = new Map<string, PaneAttachment>();
  /** whether this bridge can `terminal attach`: herdr is asked once, and the PTY sidecar has to be runnable here (server/pty/sidecar.ts) */
  /** whether the sidecar can run, settled as the server starts so that attach and /api/health tell one answer; a forced answer (tests) stands in for it */
  const sidecar = options.sidecar ?? (options.terminalAttach === undefined ? sidecarAvailable() : options.terminalAttach !== false);
  let terminalAttachKnown: boolean | null = typeof options.terminalAttach === "boolean" ? options.terminalAttach : null;
  const terminalAttach = async (): Promise<boolean> => {
    if (terminalAttachKnown === null) {
      terminalAttachKnown = typeof options.terminalAttach === "function" ? await options.terminalAttach() : attachableIdentity(await ping(), sidecar).terminal_attach !== false;
    }
    return terminalAttachKnown;
  };
  const retryFor = options.attachRetryForMs ?? ATTACH_RETRY_FOR_MS;
  const heldRetry = options.attachHeldRetryMs ?? ATTACH_HELD_RETRY_MS;
  const relookupFor = options.attachRelookupForMs ?? ATTACH_RELOOKUP_FOR_MS;
  /** attachments still resolving their terminal, so concurrent attaches share one pty */
  const pendingAttachments = new Map<string, Promise<PaneAttachment>>();
  // herdr releases its exclusive attach slot only after the old process exits.
  const retiringAttachments = new Map<string, Promise<void>>();
  const clients = new Set<Client>();
  /** each pane's input while a composer message is in flight, one step after another */
  const paneQueues = new Map<string, Promise<unknown>>();
  /** when each pane last got keystrokes through its attach pty */
  const lastTyped = new Map<string, number>();
  const hostname = options.hostname ?? process.env["HOST"] ?? "127.0.0.1";
  /** Empty token = gate disabled; every route then behaves exactly as it did before auth existed. */
  const token = options.token ?? process.env["HERDR_FLEET_TOKEN"] ?? "";
  /** paired devices (server/devices.ts) and the PC's Tailscale login: the two ways in besides the token and this PC itself */
  const devices = new DeviceStore(options.stateDir ?? defaultStateDir());
  /** a login named here is taken as it is: a tagged node has none of its own to read (HERDR_FLEET_TAILSCALE_OWNER) */
  const namedOwner = options.tailscaleOwner !== undefined ? options.tailscaleOwner : process.env["HERDR_FLEET_TAILSCALE_OWNER"]?.trim() || undefined;
  const identityOf = namedOwner !== undefined ? () => ({ owner: namedOwner, tagged: false }) : tailscaleIdentity;
  identityOf();

  /**
   * Runs `task` after everything queued for the pane. While a composer message is in
   * flight, the pane's other input (keystrokes, keys, prompt answers) waits behind it:
   * a Stop tapped right after Send must not land between the text and its Enter.
   */
  function serialize<T>(paneId: string, task: () => T | Promise<T>): Promise<T> {
    const run = (paneQueues.get(paneId) ?? Promise.resolve()).catch(() => {}).then(task);
    paneQueues.set(paneId, run);
    run.catch(() => {}).finally(() => { if (paneQueues.get(paneId) === run) paneQueues.delete(paneId); });
    return run;
  }

  /**
   * Types a composer message and submits it, with its own Enter after the text: arriving
   * in the same chunk as the paste, a TUI still busy with it (turning an image path into
   * an attachment, redrawing after the phone keyboard closed) could take it for a newline
   * and leave the message unsent in its input box. Done here rather than in the browser,
   * the gap survives a jittery connection and the Enter still goes when the phone locks.
   *
   * An agent gets it through herdr's agent.prompt (the paste, then Enter 300ms later),
   * which refuses while the agent waits for an answer: the message is not typed into its
   * menu. A pane without an agent in front gets `payload`, shaped for its own paste mode,
   * through send_text, then Enter SUBMIT_DELAY_MS later; both return once the pane has
   * the bytes, so the pane sees the whole gap. So does a Codex "blocked" only by questions
   * waiting collapsed in its queue: its main prompt still takes the message.
   */
  async function submitText(paneId: string, text: string, payload: string, arrivedAt: number, fromTerminal = false, authorize: () => void = () => {}): Promise<void> {
    const inTime = (): void => {
      authorize();
      if (Date.now() - arrivedAt > (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS)) {
        throw new HerdrError("submit_timeout", "the message waited too long behind earlier input; nothing was typed");
      }
    };
    const typed = Date.now() - (lastTyped.get(paneId) ?? 0);
    if (typed < TYPED_SETTLE_MS) await Bun.sleep(TYPED_SETTLE_MS - typed);
    lastTyped.delete(paneId);
    inTime();
    // the terminal's input line stands in for the keyboard: it types what the user wrote, an
    // answer into an open menu included, where agent.prompt would refuse
    if (!fromTerminal) try {
      await agentPrompt(paneId, text);
      return;
    } catch (error) {
      if (!(error instanceof HerdrError)) throw error;
      const queuedOnly = error.code === "agent_blocked" && await blockedOnlyByCodexQueue(paneId);
      if (error.code !== "agent_not_found" && error.code !== "agent_not_ready" && !queuedOnly) throw error;
    }
    inTime();
    // a mirrored pane's browser never learned the program's paste mode, so `payload` came as bare
    // lines: several of them are shaped here as the same block typed into the mirror is. herdr is
    // asked only for such a block, so a one-line message never waits on it.
    const shaped = await mirrorInput(payload, async () => await terminalAttach() ? null : (await paneContext(paneId)).agent);
    inTime();
    await paneSendText(paneId, shaped);
    await Bun.sleep(SUBMIT_DELAY_MS);
    authorize();
    await paneSendKeys(paneId, ["Enter"]);
  }

  function authorizeSocket(client: Client): void {
    if (client.data.revoked) throw new HerdrError("device_revoked", "this device's access was revoked");
    if (client.data.readOnly || client.data.mode === "observe") throw new HerdrError("read_only", "this connection can only watch");
  }

  /** Is this pane's agent Codex, blocked only by questions waiting collapsed in its queue (codexQuestionsCollapsed)? */
  async function blockedOnlyByCodexQueue(paneId: string): Promise<boolean> {
    const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
    if ((pane?.agent ?? pane?.agent_session?.agent) !== "codex") return false;
    // a collapsed queue in scrollback must not let a message past an approval on the live screen
    return codexQuestionsCollapsed((await paneRead({ paneId, source: "detection", format: "text" })).text);
  }

  function stopSlowClient(client: Client): void {
    if (client.data.closing) return;
    client.data.closing = true;
    clients.delete(client);
    for (const paneId of client.data.attached) detach(paneId, client);
    client.data.attached.clear();
    client.data.output.clear();
    client.close(OUTPUT_STALLED_CLOSE_CODE, "terminal output consumer stalled");
  }

  function reconcileOutput(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (!attachment?.pty) return;
    let paused = false;
    for (const client of attachment.clients) {
      const window = client.data.output.get(paneId);
      const buffered = client.getBufferedAmount();
      const blocked = window?.blocked || buffered >= OUTPUT_HIGH_BYTES;
      if (!blocked) {
        attachment.stalled.delete(client);
        continue;
      }
      const since = attachment.stalled.get(client) ?? Date.now();
      attachment.stalled.set(client, since);
      if (Date.now() - since >= OUTPUT_STALL_MS || buffered >= OUTPUT_HARD_BYTES) {
        stopSlowClient(client);
      } else {
        paused = true;
      }
    }
    if (attachments.get(paneId) !== attachment) return;
    if (paused) attachment.pty.pause();
    else attachment.pty.resume();
  }

  function sendOutput(client: Client, paneId: string, data: string): void {
    const window = client.data.output.get(paneId);
    const bytes = Buffer.byteLength(data);
    if ((window && window.pending + bytes > OUTPUT_HARD_BYTES) || client.getBufferedAmount() >= OUTPUT_HARD_BYTES) {
      stopSlowClient(client);
      return;
    }
    send(client, {
      type: "pty-data", pane_id: paneId, data,
      ...(window ? { flow: { stream_id: window.id, offset: window.write(bytes) } } : {}),
    });
  }
  const push = createPushService({
    stateDir: options.stateDir ?? defaultStateDir(),
    timing: options.alertTiming,
    ...(options.pushEndpoint ? { acceptEndpoint: options.pushEndpoint } : {}),
    // no owner (undefined) is a subscription from the removed open-LAN mode: it hears nothing
    canDeliver: (id) => id === null || (id !== undefined && devices.has(id)),
    lookupTitle: async (paneId) => {
      const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
      return pane ? paneTitle(pane) : undefined;
    },
  });

  /** `done` for agents herdr loses track of (server/completion.ts), kept across restarts */
  const completions = new CompletionTracker(join(options.stateDir ?? defaultStateDir(), "completions.json"));
  /** each workspace's repository, for the sidebar's projects */
  const projects = new WorkspaceProjects();
  /** the snapshot clients get: finishes settled, workspaces with their repository */
  const clientSnapshot = async (): Promise<SessionSnapshot> => projects.attach(await completions.readSnapshot(sessionSnapshot));
  const machines = options.machines === false ? null : new MachineManager(completions, clientSnapshot);
  /** agents started on callers' behalf (server/fleet): told of herdr's status events by the collector below */
  let listeningPort = 0;
  /** run saves come in bursts (a spawn writes several): clients hear of a burst once, after it */
  let fleetChangedTimer: ReturnType<typeof setTimeout> | null = null;
  const fleetChanged = () => {
    if (fleetChangedTimer) return;
    fleetChangedTimer = setTimeout(() => { fleetChangedTimer = null; broadcastAll({ type: "fleet-changed" }); }, FLEET_CHANGED_MS);
  };
  /** each subscription's usage, asked of the CLIs themselves; rate limits the fleet meets add cooldowns */
  const usage = options.fleet?.usage ?? new UsageTracker({
    file: join(options.stateDir ?? defaultStateDir(), "fleet-usage.json"),
    probes: defaultProbes(options.stateDir ?? defaultStateDir()),
  });
  const models = options.fleet?.models ?? new ModelCatalog({ workDir: join(options.stateDir ?? defaultStateDir(), "model-list") });
  // where runs hand their results in: chats link to them, so the file viewer opens them too
  const resultsDir = join(options.stateDir ?? defaultStateDir(), "fleet-results");
  const fleet = new Orchestrator({
    models,
    runtime: options.fleet?.runtime ?? new HerdrRuntime(),
    registry: new RunRegistry(join(options.stateDir ?? defaultStateDir(), "fleet-runs.json")),
    resultsDir,
    plansDir: join(options.stateDir ?? defaultStateDir(), "fleet-plans"),
    instructionsDir: join(options.stateDir ?? defaultStateDir(), "fleet-instructions"),
    config: options.fleet?.config ?? ((cwd) => loadConfig(cwd)),
    agents: options.fleet?.agents ?? ((cwd) => discoverAgents(cwd)),
    standingOrders: options.fleet?.standingOrders ?? ((cwd) => loadStandingOrders(cwd)),
    fleetCommand: FLEET_COMMAND,
    usage,
    onChanged: fleetChanged,
    agentEnv: () => ({ HERDR_FLEET_URL: `http://127.0.0.1:${listeningPort}`, ...(token ? { HERDR_FLEET_TOKEN: token } : {}) }),
  });

  /** the server's own folder for explanations: the person's limits are read from it, and the claude call runs in its `work` folder, one at a time */
  const explainRoot = join(options.stateDir ?? defaultStateDir(), "explain");
  const explainCalls = new ExplainCalls();
  /** the person's fleet.json, read and written by the Settings page */
  const settings = new FleetSettingsStore({ agents: options.fleet?.agents ?? ((cwd) => discoverAgents(cwd)), usage, userDir: options.fleet?.userDir });
  /** the fleet skill in the person's skill folders, put there from the Settings page */
  const entrances = new EntranceStore({ command: FLEET_COMMAND, url: () => `http://127.0.0.1:${listeningPort}`, tokenRequired: token !== "", home: options.fleet?.homeDir });

  function broadcast(paneId: string, message: ServerMessage): void {
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    for (const client of attachment.clients) send(client, message);
  }

  function broadcastAll(message: ServerMessage): void {
    machines?.localMessage(message);
    for (const client of clients) send(client, message);
  }

  async function terminalInfoFor(paneId: string, timeoutMs?: number): Promise<{ terminalId: string; rect: { width: number; height: number } | null }> {
    const snapshot = await sessionSnapshot(undefined, timeoutMs);
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
    // herdr (0.9.3+) could not restore it after a restart: its terminal has no process
    // and an attach would only die with "not found". The client shows the reason instead.
    if (pane.restore_error) throw new HerdrError("pane_not_restored", pane.restore_error);
    const terminalId = (pane as HerdrPane & { terminal_id?: string }).terminal_id;
    if (!terminalId) throw new HerdrError("no_terminal", `pane ${paneId} has no terminal`);
    // the pane's grid as the operator's layout holds it: an observe connection must
    // create the pty at THIS size, never at the observer's own viewport
    const rect = snapshot.layouts.flatMap((layout) => layout.panes).find((entry) => entry.pane_id === paneId)?.rect ?? null;
    return { terminalId, rect: rect ? { width: rect.width, height: rect.height } : null };
  }

  function closeAttachment(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    attachments.delete(paneId);
    clearTimeout(attachment.heldRetry);
    clearTimeout(attachment.relookup);
    // its members hold nothing on this pane any more (a pty that exited leaves them on
    // the "terminal ended" screen): a stale entry would read as a live claim in
    // releaseUnclaimed and keep a later, empty pty on this pane running
    for (const member of attachment.clients) member.data.attached.delete(paneId);
    for (const member of attachment.clients) member.data.output.delete(paneId);
    const retired = attachment.pty.exited.finally(() => {
      if (retiringAttachments.get(paneId) === retired) retiringAttachments.delete(paneId);
    });
    retiringAttachments.set(paneId, retired);
    attachment.pty.kill();
  }

  /** Clamp surface for the shared pty, mirroring the sidecar's own limits. */
  function validGeometry(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
    if (typeof cols !== "number" || typeof rows !== "number" || !Number.isInteger(cols) || !Number.isInteger(rows)) {
      return null;
    }
    if (cols < 1 || cols > 1000 || rows < 1 || rows > 1000) return null;
    return { cols, rows };
  }

  /** `free`: no viewport sizes the pane now, which is said even when its grid stays the same */
  function setGrid(paneId: string, attachment: PaneAttachment, cols: number, rows: number, free = false): void {
    if (attachment.cols === cols && attachment.rows === rows && !free) return;
    if (attachment.cols !== cols || attachment.rows !== rows) attachment.pty.resize(cols, rows);
    attachment.cols = cols;
    attachment.rows = rows;
    broadcast(paneId, { type: "pane-geometry", pane_id: paneId, cols, rows, ...(free ? { free: true } : {}) });
  }

  /**
   * The viewport sizing the pane lets go: the pane is back at the grid it had, herdr's. A layout
   * that moved meanwhile is seen at the next look (regridMoved), which left its rect as it was.
   * The clients hear that the pane is free: the one the person looks at takes it again.
   */
  function release(paneId: string, client: Client): void {
    const attachment = attachments.get(paneId);
    if (!attachment || attachment.driver !== client) return;
    const own = attachment.ownGrid;
    attachment.driver = undefined;
    attachment.ownGrid = undefined;
    if (own) setGrid(paneId, attachment, own.cols, own.rows, true);
  }

  function ensureAttachment(paneId: string): Promise<PaneAttachment> {
    const existing = attachments.get(paneId);
    if (existing) return Promise.resolve(existing);
    // a second attach arriving while the first is still resolving the terminal joins
    // that creation: two creations would spawn two ptys, and the orphaned one keeps
    // streaming into the surviving attachment and kills it when it exits
    const pending = pendingAttachments.get(paneId);
    if (pending) return pending;

    const created = spawnAttachment(paneId).finally(() => pendingAttachments.delete(paneId));
    pendingAttachments.set(paneId, created);
    return created;
  }

  async function spawnAttachment(paneId: string): Promise<PaneAttachment> {
    await retiringAttachments.get(paneId);
    const mirrored = !(await terminalAttach());
    const { terminalId, rect } = await terminalInfoFor(paneId);
    // every attachment spawns at the pane's own grid: read from its tty where that can be
    // done (the rect is larger by herdr's borders), else the rect, else 80x24
    const grid = mirrored ? null : await paneGrid(paneId).catch(() => null);
    const spawnCols = grid?.cols ?? rect?.width ?? 80;
    const spawnRows = grid?.rows ?? rect?.height ?? 24;
    const attachment: PaneAttachment = {
      ready: mirrored,
      pty: undefined as unknown as PtySession,
      clients: new Set<Client>(),
      cols: spawnCols,
      rows: spawnRows,
      rect,
      replay: new ReplayBuffer(MAX_REPLAY_BYTES),
      stalled: new Map(),
    };
    attachments.set(paneId, attachment);

    if (mirrored) {
      const mirror = new MirrorSession({
        cols: spawnCols,
        rows: spawnRows,
        size: async () => {
          const now = (await terminalInfoFor(paneId)).rect;
          return now ? { cols: now.width, rows: now.height } : null;
        },
        // the grid follows herdr's layout: the clients adopt the new size before the screen
        onResize: (cols, rows) => {
          if (attachments.get(paneId) !== attachment) return;
          attachment.cols = cols;
          attachment.rows = rows;
          broadcast(paneId, { type: "pane-geometry", pane_id: paneId, cols, rows, fixed: true });
        },
        read: async () => (await paneRead({ paneId, source: "visible", format: "ansi" })).text,
        write: (data) => paneSendText(paneId, data),
        onData: (frame) => {
          if (attachments.get(paneId) !== attachment) return;
          for (const client of attachment.clients) sendOutput(client, paneId, frame);
          reconcileOutput(paneId);
        },
        onExit: (code) => {
          if (attachments.get(paneId) !== attachment) return;
          broadcast(paneId, { type: "pty-exit", pane_id: paneId, code });
          closeAttachment(paneId);
        },
      });
      attachment.pty = mirror;
      attachment.mirror = mirror;
      return attachment;
    }

    // No --takeover: another web bridge may own the exclusive attach slot.
    // Report that conflict without displacing it or the user's own TUI.
    // herdr also refuses an attach while a read of the same terminal is in progress ("has a
    // read in progress; retry"), and this server reads panes all the time (prompt polls,
    // transcript matches): an attach that races one, typically a phone reconnecting just as
    // Codex finished an answer, is started again for the same clients, for as long as such
    // a read can last, instead of ending their terminal.
    const forward = (data: string): void => {
      if (attachments.get(paneId) !== attachment) return;
      attachment.replay.append(data);
      for (const client of attachment.clients) sendOutput(client, paneId, data);
      reconcileOutput(paneId);
    };
    let retries = 0;
    let refusedSince: number | null = null;
    /** the terminal attached to: a pane keeps its id across a server handoff, its terminal does not */
    let attachedTerminal = terminalId;
    /** the attach a regrid let go of: what it still prints was drawn for the old grid */
    let replaced: PtySession | null = null;
    const start = (): PtySession => {
      let output = ""; // this attach's own last words: herdr's refusal is in them
      // its first bytes wait ATTACH_HOLD_MS: a refusal (herdr's setup, teardown and message)
      // is dropped then, never painted into the clients' terminal
      let held: string | null = "";
      let heldSince = 0;
      let holding = false;
      let holdTimer: ReturnType<typeof setTimeout> | undefined;
      /** ended before its exit came: what it still prints is no attach's */
      let retired = false;
      const release = (): void => {
        clearTimeout(holdTimer);
        if (held === null) return;
        const data = held;
        held = null;
        if (data) forward(data);
      };
      const took = (): void => {
        // a closed attachment's kill skips onExit, which would clear this timer: a newer
        // attachment on the pane must not hear this one's resume
        if (attachments.get(paneId) !== attachment) return;
        // a refusal whose exit comes late (a busy PC) is not an attach: resuming would free
        // the input to a pane another bridge may hold. Only output after it is an attach's.
        if (ATTACH_REFUSING_RE.test(output)) {
          if (Date.now() - heldSince < ATTACH_REFUSAL_EXIT_MS) {
            holdTimer = setTimeout(took, ATTACH_HOLD_MS);
            return;
          }
          // its exit is overdue: this try ends here, as that exit would have ended it (a pane
          // whose own output ends the same way waits for more output on a later try)
          retired = true;
          session.kill();
          ended(null);
          return;
        }
        // the attach took: a pane that waited for another bridge is this bridge's again
        if (attachment.held) {
          attachment.held = false;
          broadcast(paneId, { type: "attach-resumed", pane_id: paneId });
        }
        attachment.ready = true;
        broadcast(paneId, { type: "input-ready", pane_id: paneId });
        release();
      };
      const ended = (code: number | null): void => {
        clearTimeout(holdTimer);
        if (attachments.get(paneId) !== attachment) return;
        if (attachment.ready) broadcast(paneId, { type: "input-ready", pane_id: paneId, ready: false });
        attachment.ready = false;
        const now = Date.now();
        if (code !== 0 && ATTACH_READ_RACE_RE.test(output) && now - (refusedSince ??= now) < retryFor) {
          held = null;
          retries += 1;
          setTimeout(() => {
            if (attachments.get(paneId) !== attachment) return;
            try {
              attachment.pty = start();
            } catch (error) {
              // a throw here is uncaught and takes the whole server down: end this
              // pane's terminal instead, on the exited pty the record still holds
              const message = spawnFailure(paneId, error);
              broadcast(paneId, { type: "error", code: "command_failed", message });
              broadcast(paneId, { type: "pty-exit", pane_id: paneId, code: null });
              closeAttachment(paneId);
            }
          }, Math.min(ATTACH_RETRY_MS * 2 ** (retries - 1), ATTACH_RETRY_MAX_MS));
          return;
        }
        if (code !== 0 && ATTACH_HELD_RE.test(output)) {
          held = null; // herdr's refusal is not the pane's output: never painted, and it repeats
          // waiting for the other bridge is not a read race: the next one gets its full budget
          refusedSince = null;
          retries = 0;
          // Another web bridge holds herdr's one attach slot (two bridges on one herdr, e.g. a
          // second install beside the first). Its attach is left alone; this pane waits for it
          // to let go, trying again while anyone here still has it open, instead of ending.
          if (!attachment.held) broadcast(paneId, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: paneId });
          attachment.held = true;
          attachment.heldRetry = setTimeout(() => {
            if (attachments.get(paneId) !== attachment) return;
            if (attachment.clients.size === 0) {
              closeAttachment(paneId);
              return;
            }
            try {
              attachment.pty = start();
            } catch (error) {
              const message = spawnFailure(paneId, error);
              broadcast(paneId, { type: "error", code: "command_failed", message });
              broadcast(paneId, { type: "pty-exit", pane_id: paneId, code: null });
              closeAttachment(paneId);
            }
          }, heldRetry);
          return;
        }
        release();
        const finish = (): void => {
          broadcast(paneId, { type: "pty-exit", pane_id: paneId, code });
          closeAttachment(paneId);
        };
        // a refusal whose exit never came ended this try itself, on a terminal that is still there
        if (retired) return finish();
        // herdr ended the attach, maybe not the pane: after a live handoff the pane lives on under
        // a new terminal, and the same clients attach to that one. A pane that is gone, or still
        // on this terminal once the lookups run out, ended.
        const deadline = Date.now() + relookupFor;
        const again = (): void => {
          if (Date.now() >= deadline) return finish();
          attachment.relookup = setTimeout(relookup, ATTACH_RELOOKUP_MS);
        };
        const relookup = (): void => {
          // a herdr that takes the request and never answers must not hold the terminal past the
          // deadline: the lookup gets what is left of it, not the RPC's own 10 s
          terminalInfoFor(paneId, Math.max(1, deadline - Date.now())).then(({ terminalId: now }) => {
            if (attachments.get(paneId) !== attachment) return;
            if (now === attachedTerminal) return again();
            if (attachment.clients.size === 0) {
              closeAttachment(paneId);
              return;
            }
            attachedTerminal = now;
            // a new terminal gets the whole read-race budget
            refusedSince = null;
            retries = 0;
            try {
              attachment.pty = start();
            } catch (error) {
              const message = spawnFailure(paneId, error);
              broadcast(paneId, { type: "error", code: "command_failed", message });
              finish();
            }
          }, (error: unknown) => {
            if (attachments.get(paneId) !== attachment) return;
            if (error instanceof HerdrError && PANE_GONE_CODES.has(error.code)) return finish();
            // herdr is between servers (server_unavailable, connect_failed) or not answering (timeout): ask again
            again();
          });
        };
        relookup();
      };
      const session = new PtySession({
        command: process.env["HERDR_FLEET_HERDR_BIN"] || "herdr",
        args: ["terminal", "attach", attachedTerminal],
        // herdr's CLI reads HERDR_SOCKET_PATH, not HERDR_SOCKET: the stream must reach
        // the same session the RPCs talk to, or a named session's terminals are
        // looked up on the default socket and the attach dies.
        env: { HERDR_SOCKET_PATH: herdrSocketPath() },
        cols: attachment.cols,
        rows: attachment.rows,
        onData: (data) => {
          if (retired || session === replaced || attachments.get(paneId) !== attachment) return;
          output = (output + data).slice(-1024);
          if (held === null) return forward(data);
          held += data;
          if (!holding && !ATTACH_PREAMBLE_RE.test(held)) {
            holding = true;
            heldSince = Date.now();
            holdTimer = setTimeout(took, ATTACH_HOLD_MS);
          }
        },
        onExit: ended,
      });
      return session;
    };
    try {
      attachment.pty = start();
    } catch (error) {
      // Bun.spawn throws synchronously (node missing from PATH, fd or process limits): the
      // placeholder must go with it, or the next attach joins a record with no pty and
      // its close dereferences one (#154). The waiting attaches get the error in-band.
      attachments.delete(paneId);
      spawnFailure(paneId, error);
      throw error;
    }
    // While attached, herdr keeps the terminal at the attach's size and ignores its own layout
    // (a split dragged, a zoom, its window resized). Let go of it, herdr applies the layout:
    // the grid is read then, and the attach comes back at it.
    let regridding = false;
    attachment.regrid = async () => {
      if (regridding || attachment.driver || attachment.held || !attachment.ready) return;
      regridding = true;
      try {
        const previous = attachment.pty as PtySession;
        replaced = previous;
        attachment.ready = false;
        broadcast(paneId, { type: "input-ready", pane_id: paneId, ready: false });
        previous.kill();
        await previous.exited;
        let grid: Grid | null = null;
        for (const deadline = Date.now() + REGRID_SETTLE_MS; ;) {
          grid = await paneGrid(paneId).catch(() => null);
          // a pane on no herdr screen (a headless server) keeps its grid: the wait runs out
          if (!grid || grid.cols !== attachment.cols || grid.rows !== attachment.rows || Date.now() >= deadline) break;
          await Bun.sleep(REGRID_POLL_MS);
        }
        if (attachments.get(paneId) !== attachment) return;
        if (attachment.clients.size === 0) {
          closeAttachment(paneId);
          return;
        }
        // a viewport that took the pane meanwhile sizes it: the grid read is its own to give back
        if (grid && attachment.driver) attachment.ownGrid = grid;
        else if (grid) {
          attachment.cols = grid.cols;
          attachment.rows = grid.rows;
        }
        // the tail was drawn for the old grid; the new attach paints the whole screen again
        attachment.replay = new ReplayBuffer(MAX_REPLAY_BYTES);
        broadcast(paneId, { type: "pane-geometry", pane_id: paneId, cols: attachment.cols, rows: attachment.rows });
        try {
          attachment.pty = start();
        } catch (error) {
          const message = spawnFailure(paneId, error);
          broadcast(paneId, { type: "error", code: "command_failed", message });
          broadcast(paneId, { type: "pty-exit", pane_id: paneId, code: null });
          closeAttachment(paneId);
        }
      } finally {
        regridding = false;
      }
    };

    return attachment;
  }

  /** The panes whose rect in herdr's layout moved since their grid was read: each lets go and reads it again. */
  async function regridMoved(): Promise<void> {
    // a pane a viewport sizes is not herdr's to lay out until it lets go
    const attached = [...attachments].filter(([, attachment]) => attachment.regrid && attachment.ready && !attachment.held && !attachment.driver);
    if (attached.length === 0) return;
    const snapshot = await sessionSnapshot();
    const rects = new Map(snapshot.layouts.flatMap((layout) => layout.panes).map((entry) => [entry.pane_id, entry.rect]));
    for (const [paneId, attachment] of attached) {
      const rect = rects.get(paneId);
      if (!rect) continue;
      const now = { width: rect.width, height: rect.height };
      const before = attachment.rect;
      attachment.rect = now;
      if (before && (before.width !== now.width || before.height !== now.height)) void attachment.regrid?.();
    }
  }

  /** The attaching client sees the error in-band; the log is the only record the operator gets. */
  function spawnFailure(paneId: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`terminal attach for pane ${paneId} failed to start: ${message}`);
    return message;
  }

  function detach(paneId: string, client: Client): void {
    release(paneId, client);
    client.data.output.delete(paneId);
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    attachment.clients.delete(client);
    attachment.stalled.delete(client);
    if (attachment.clients.size === 0) closeAttachment(paneId);
    else reconcileOutput(paneId);
  }

  /**
   * Closes an attachment whose creating client detached or disconnected before it was
   * ready, unless a client still wants it: every attach records its pane in
   * `attached` before awaiting, so a joiner of the same creation that has not resumed
   * yet still counts and is not left holding a dead record.
   */
  function releaseUnclaimed(paneId: string, attachment: PaneAttachment): void {
    if (attachments.get(paneId) !== attachment || attachment.clients.size > 0) return;
    for (const other of clients) if (other.data.attached.has(paneId)) return;
    closeAttachment(paneId);
  }

  /** A broken state file must cost the alert, never the server (an unhandled rejection would). */
  const logPushError = (error: unknown): void => {
    console.error(`web push: ${error instanceof Error ? error.message : String(error)}`);
  };

  /** Status of EVERY pane, attached or not: one collector feeds all connected clients and web push. */
  const collector = startStatusCollector({
    onStatus: (paneId, raw, agent, replay) => {
      fleet.onPaneStatus(paneId);
      // read back from a snapshot around a gap between subscriptions
      if (replay && !completions.replayed(paneId, raw, replay)) return;
      // an agent herdr lost on the way still works and finishes as such (server/completion.ts)
      const status = completions.observe(paneId, raw, agent);
      broadcastAll({ type: "pane-status", pane_id: paneId, agent_status: status });
      push.onStatus(paneId, status).catch(logPushError);
    },
    // a finish reported as done, now in front at herdr's terminal: seen, idle again
    onFocus: (paneId) => {
      if (!completions.seen(paneId)) return;
      broadcastAll({ type: "pane-status", pane_id: paneId, agent_status: "idle" });
      push.onStatus(paneId, "idle").catch(logPushError);
    },
    onBaseline: (panes) => push.seed(panes),
    // the tracker first: what it makes of each pane (a finish after work is done, not idle) is
    // what the alerts are measured against from here, or the next event would alert of it
    onResync: (panes, newer) => {
      void fleet.reconcileAll();
      completions.resync(panes, newer);
      push.resync(panes.map((pane) => ({ ...pane, agent_status: completions.current(pane.pane_id) ?? pane.agent_status })), newer);
    },
    onPaneEnded: (paneId) => {
      fleet.onPaneEnded(paneId);
      completions.forget(paneId);
      broadcastAll({ type: "pane-exited", pane_id: paneId });
      push.onEnded(paneId).catch(logPushError);
    },
    onStructureChange: () => broadcastAll({ type: "session-changed" }),
  });

  const envPort = process.env["PORT"];
  const server = Bun.serve<SocketData>({
    port: options.port ?? (envPort ? Number(envPort) : DEFAULT_PORT),
    hostname,

    async fetch(request, bunServer) {
      const url = new URL(request.url);
      let { pathname } = url;
      const ip = bunServer.requestIP(request);
      const access = decideAccess({
        loopback: ip !== null && isLoopbackAddress(ip.address),
        forwarded: cameThroughProxy(request.headers),
        funnel: request.headers.has("tailscale-funnel-request"),
        tailscaleLogin: request.headers.get("tailscale-user-login"),
        forwardedFor: request.headers.get("x-forwarded-for"),
        tokenMatched: token !== "" && isAuthenticated(request, token),
        device: devices.match(parseCookies(request.headers.get("cookie")).get(DEVICE_COOKIE)),
        ...identityOf(),
        tokenConfigured: token !== "",
        gated: devices.gated,
      });
      const authenticated = access.level === "full";

      if (requiresAuth(pathname) && !authenticated) {
        // The WS client never parses a body, so the upgrade refusal stays plain text.
        return pathname === "/ws" ? new Response("unauthorized", { status: 401 }) : unauthorizedJson(access.level === "none" ? access.reason : "token_required");
      }

      const readOnly = access.level === "full" && access.role === "watch";
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
      if (pathname.startsWith("/api/") && mutating && !sameOrigin(request)) {
        return jsonResponse({ error: { code: "invalid_origin", message: "Use controls from this app" } }, 403);
      }
      // An empty segment ("//") reads as another route to the checks below, while the PC proxy
      // drops it before forwarding: `/api/machines/<id>//fs/file` would pass as not a file read.
      if (pathname.startsWith("/api/") && pathname.includes("//")) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
      // Watching a terminal grants no arbitrary filesystem access: those files include credentials.
      const fileRead = /^\/api\/(?:machines\/[^/]+\/)?fs\//.test(pathname);
      const ownPreferences = pathname === "/api/auth" || pathname === "/api/push/subscribe" || pathname === "/api/push/test";
      if (readOnly && (fileRead || mutating && !ownPreferences)) {
        return jsonResponse({ error: { code: "read_only", message: "this device can only watch" } }, 403);
      }

      if (pathname === "/api/fleet" || pathname.startsWith("/api/fleet/")) {
        // a spawn waits for the agent to start, a wait for its turn: Bun's 10 s idle limit is too short
        bunServer.timeout(request, 0);
        return handleFleetRequest(request, url, fleet, usage, settings, entrances, models);
      }
      if (pathname === "/api/machines" || pathname.startsWith("/api/machines/")) {
        if (!machines) return jsonResponse({ error: { code: "bridge_only", message: "Manage PCs on the connection server" } }, 404);
        // /local aliases preserve every existing endpoint without a self-proxy.
        if (pathname.startsWith("/api/machines/local/")) {
          if (!sameOrigin(request) || (request.method !== "GET" && request.headers.get("x-herdr-machine") !== "1")) return jsonResponse({ error: { code: "invalid_origin", message: "Use PC controls from this app" } }, 403);
          pathname = pathname.replace("/api/machines/local/", "/api/");
          if (!/^\/api\/(session|agents|pane\/|workspace\/)/.test(pathname)) return badRequest("invalid_route", "Unknown PC endpoint");
          url.pathname = pathname;
        } else {
          bunServer.timeout(request, pathname === "/api/machines/events" ? 0 : 80);
          const deviceId = access.level === "full" ? access.device?.id : undefined;
          const response = await handleMachineRequest(request, machines, deviceId ? (close) => devices.onRevoke(deviceId, close) : undefined);
          response.headers.set("cache-control", "no-store");
          return response;
        }
      }
      if (pathname === "/ws") {
        if (!sameOrigin(request)) return new Response("invalid origin", { status: 403 });
        const deviceId = access.level === "full" ? access.device?.id : undefined;
        const machineId = url.searchParams.get("machine_id");
        if (machineId && machineId !== "local") return jsonResponse({ error: { code: "not_found", message: "unknown PC" } }, 404);
        const upgraded = bunServer.upgrade(request, { data: { attached: new Set<string>(), mode: readOnly ? "observe" : "interact", output: new Map(), closing: false, deviceId, readOnly } });
        if (upgraded) return undefined as unknown as Response;
        return new Response("websocket upgrade required", { status: 426 });
      }

      if (pathname === "/api/auth") return handleAuthRequest(request, token);
      if (pathname === "/api/devices" || pathname.startsWith("/api/devices/")) {
        try {
          const response = await handleDeviceRequest(request, pathname, devices, access);
          if (request.method === "DELETE" && response.status === 204) {
            // The device registry is the delivery authority even if cleaning the push file fails.
            try { push.revokeDevice(pathname.slice("/api/devices/".length)); } catch (error) { logPushError(error); }
          }
          return response;
        } catch (error) { return errorResponse(error); }
      }



      if (pathname === "/api/push" || pathname.startsWith("/api/push/")) {
        try {
          // a paired device owns its alerts; a local/token/Tailscale sign-in is the owner (null)
          const owner = access.level !== "full" ? null : access.device?.id ?? null;
          const answered = await handlePushRequest(request, pathname, push, owner);
          if (answered) return answered;
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/health") {
        const auth: HealthAuth = access.level === "full"
          ? { required: false, authenticated: true, via: access.via, role: access.role }
          : { required: true, authenticated, ...(authenticated ? {} : { reason: access.reason }) };
        if (url.searchParams.get("scope") === "bridge") return jsonResponse({ ok: true, auth, bridge_protocol: BRIDGE_PROTOCOL });
        try {
          const info = await ping();
          // a forced answer (tests) and a runtime without the PTY sidecar are told the way a Windows herdr's own would be
          const herdr = attachableIdentity(info, sidecar);
          return jsonResponse({ ok: true, herdr, auth,
            web_ui: { boot_id: process.env["HERDR_FLEET_BOOT_ID"] ?? null, revision: process.env["HERDR_FLEET_REVISION"] ?? null } });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/access") {
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        return jsonResponse(await remoteAccess(bunServer.port ?? DEFAULT_PORT), 200, { "cache-control": "no-store" });
      }

      if (pathname === "/api/session") {
        try {
          return jsonResponse({ snapshot: await clientSnapshot() });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/agents") {
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        try {
          const kinds = new Set((await agentManifests()).manifests.map((manifest) => manifest.agent));
          kinds.add("omp");
          kinds.add("claude");
          const agents: AgentKind[] = [...kinds]
            .map((kind) => ({ kind, label: AGENT_LABELS[kind] ?? kind }))
            .sort((left, right) => left.label.localeCompare(right.label) || left.kind.localeCompare(right.kind));
          return jsonResponse({ agents });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/fs/stat" || pathname === "/api/fs/file") {
        if (request.method !== "GET" && request.method !== "HEAD") return badRequest("method_not_allowed", "use GET");
        const paneId = url.searchParams.get("pane_id");
        let cwd: string | null = null;
        if (paneId) {
          try { cwd = (await paneContext(paneId)).cwd; } catch { /* an absolute path still opens */ }
        }
        const found = locateFile(url.searchParams.get("path") ?? "", cwd);
        if (found === null) return jsonResponse({ error: { code: "not_found", message: "no readable file at that path" } }, 404);
        const roots = fileRoots(cwd, resultsDir);
        // several files end in that name: the viewer lists them to choose from
        if ("candidates" in found) {
          const candidates = found.candidates.filter((path) => withinRoots(path, roots));
          if (candidates.length === 0) return outsideRoots();
          return jsonResponse({ error: { code: "ambiguous_path", message: "several files have that name", candidates } }, 409);
        }
        if (!withinRoots(found.info.path, roots)) return outsideRoots();
        return pathname === "/api/fs/stat" ? jsonResponse(found.info) : fileResponse(found.info, url.searchParams.get("download") === "1");
      }

      // an HTML page, and the files it names relative to itself
      if (pathname.startsWith(FILE_VIEW_PREFIX)) {
        if (request.method !== "GET" && request.method !== "HEAD") return badRequest("method_not_allowed", "use GET");
        const view = parseViewPath(pathname);
        const info = view === null ? null : fileInfo(view.path);
        if (view === null || info === null) return jsonResponse({ error: { code: "not_found", message: "no readable file at that path" } }, 404);
        let cwd: string | null = null;
        if (view.paneId !== null) {
          try { cwd = (await paneContext(view.paneId)).cwd; } catch { /* the temp and results folders still open */ }
        }
        if (!withinRoots(info.path, fileRoots(cwd, resultsDir))) return outsideRoots();
        return fileResponse(info, false, { host: request.headers.get("host"), paneId: view.paneId });
      }

      if (pathname === "/api/workspace/directories") {
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        // a folder a pane's chat names is read from that pane's folder, as a file it names is
        const paneId = url.searchParams.get("pane_id");
        let base: string | undefined;
        if (paneId) {
          try { base = (await paneContext(paneId)).cwd; } catch { /* an absolute path still lists */ }
          // a relative path whose pane is gone has no folder to be read from: not the server's own
          const path = (url.searchParams.get("path") ?? "").trim();
          if (base === undefined && path !== "" && path !== "~" && !path.startsWith("~/") && !isAbsolute(path)) return badRequest("invalid_cwd", "the pane a relative path belongs to is gone");
        }
        const listing = listDirectories(url.searchParams.get("path") ?? "", url.searchParams.get("hidden") === "1", url.searchParams.get("files") === "1", base);
        return listing === null ? badRequest("invalid_cwd", "path must be a directory this user can read") : jsonResponse(listing);
      }

      if (pathname === "/api/workspace/create") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { cwd?: unknown; label?: unknown; agent?: { kind?: unknown; name?: unknown; args?: unknown } | null };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        // the client sends null for "not given": treat it exactly like an absent field
        if (payload.cwd === null) delete payload.cwd;
        if (payload.label === null) delete payload.label;
        if (payload.agent === null) delete payload.agent;
        if (payload.cwd !== undefined && typeof payload.cwd !== "string") return badRequest("invalid_cwd", "cwd must be an existing directory");
        const cwd = payload.cwd === undefined ? undefined : expandedDirectory(payload.cwd);
        if (payload.cwd !== undefined && cwd === null) return badRequest("invalid_cwd", "cwd must be an existing directory");
        if (payload.label !== undefined && typeof payload.label !== "string") return badRequest("missing_label", "label must be a string");
        if (payload.agent !== undefined && (typeof payload.agent !== "object" || typeof payload.agent.kind !== "string" || payload.agent.kind.length === 0)) {
          return badRequest("invalid_agent", "agent.kind is required");
        }
        if (payload.agent && ((payload.agent.name !== undefined && typeof payload.agent.name !== "string")
          || (payload.agent.args !== undefined && (!Array.isArray(payload.agent.args) || !payload.agent.args.every((arg) => typeof arg === "string"))))) {
          return badRequest("invalid_agent", "agent.name must be a string and agent.args must be an array of strings");
        }
        // agent.start can legitimately take a minute; Bun's default idle timeout is shorter.
        if (payload.agent) bunServer.timeout(request, 75);
        try {
          const created = await workspaceCreate({
            ...(cwd === undefined || cwd === null ? {} : { cwd }),
            ...(typeof payload.label === "string" ? { label: payload.label } : {}),
          });
          // best effort: a workspace left at the end is still shown in its project
          await clientSnapshot().then((snapshot) => placeWithProject(created.workspace.workspace_id, snapshot, workspaceMove)).catch(() => undefined);
          if (!payload.agent) {
            return jsonResponse({ workspace_id: created.workspace.workspace_id, pane_id: created.root_pane.pane_id, agent_started: false });
          }
          try {
            const kind = payload.agent.kind as string;
            const given = typeof payload.agent.name === "string" && payload.agent.name.length > 0 ? payload.agent.name : null;
            // herdr refuses a name another agent holds. Two creations at once can pick the same
            // free one: the refused one picks again. It also refuses a pane whose shell is not up
            // yet (`agent_pane_busy`, herdr 0.9.3), which a workspace made a moment ago can be.
            const shellDeadline = Date.now() + 10_000;
            for (let attempt = 1; ; ) {
              try {
                await agentStart({
                  name: given ?? freeAgentName(kind, (await sessionSnapshot()).agents.map((agent) => agent.name)),
                  kind,
                  paneId: created.root_pane.pane_id,
                  ...(payload.agent.args === undefined ? {} : { args: payload.agent.args as string[] }),
                  timeoutMs: 60_000,
                });
                break;
              } catch (error) {
                if (!(error instanceof HerdrError)) throw error;
                if (error.code === "agent_pane_busy" && Date.now() < shellDeadline) {
                  await Bun.sleep(100);
                  continue;
                }
                if (given !== null || attempt === 3 || error.code !== "agent_name_taken") throw error;
                attempt += 1;
              }
            }
            return jsonResponse({ workspace_id: created.workspace.workspace_id, pane_id: created.root_pane.pane_id, agent_started: true });
          } catch (error) {
            return jsonResponse({
              workspace_id: created.workspace.workspace_id,
              pane_id: created.root_pane.pane_id,
              agent_started: false,
              error: {
                code: error instanceof HerdrError ? error.code : "agent_start_failed",
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/workspace/rename" || pathname === "/api/workspace/move" || pathname === "/api/workspace/close") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { workspace_id?: unknown; label?: unknown; insert_index?: unknown };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.workspace_id !== "string" || payload.workspace_id.length === 0) {
          return badRequest("missing_workspace_id", "workspace_id is required");
        }
        if (pathname === "/api/workspace/rename" && typeof payload.label !== "string") {
          return badRequest("missing_label", "label is required");
        }
        if (pathname === "/api/workspace/move" && (typeof payload.insert_index !== "number" || !Number.isInteger(payload.insert_index) || payload.insert_index < 0)) {
          return badRequest("invalid_index", "insert_index must be a non-negative integer");
        }
        try {
          if (pathname === "/api/workspace/rename") await workspaceRename(payload.workspace_id, payload.label as string);
          else if (pathname === "/api/workspace/move") await workspaceMove(payload.workspace_id, payload.insert_index as number);
          else await workspaceClose(payload.workspace_id);
          return jsonResponse({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/rename") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { pane_id?: unknown; label?: unknown };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.pane_id !== "string" || payload.pane_id.length === 0) return badRequest("missing_pane_id", "pane_id is required");
        if (typeof payload.label !== "string") return badRequest("missing_label", "label is required");
        try {
          await paneRename(payload.pane_id, payload.label.length === 0 ? null : payload.label);
          return jsonResponse({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/commands" || pathname === "/api/pane/files") {
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
        try {
          const context = await paneContext(paneId);
          if (pathname === "/api/pane/commands") {
            return jsonResponse({ commands: paneCommands(context.agent, context.cwd) });
          }
          const limitRaw = url.searchParams.get("limit");
          const limit = limitRaw === null ? 20 : Number(limitRaw);
          if (!Number.isInteger(limit) || limit < 1) return badRequest("invalid_limit", "limit must be a positive integer");
          return jsonResponse({ files: await paneFiles(context.cwd, url.searchParams.get("q") ?? "", Math.min(limit, 100)) });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/read") {
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
        const linesRaw = url.searchParams.get("lines");
        const lines = linesRaw === null ? undefined : Number(linesRaw);
        if (lines !== undefined && !Number.isFinite(lines)) {
          return badRequest("invalid_lines", "lines must be a number");
        }
        try {
          const read = await paneRead({
            paneId,
            source: (url.searchParams.get("source") ?? "visible") as never,
            format: (url.searchParams.get("format") ?? "text") as never,
            ...(lines === undefined ? {} : { lines }),
          });
          return jsonResponse({ read });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/scroll") {
        if (request.method === "GET") {
          const paneId = url.searchParams.get("pane_id");
          if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
          try {
            return jsonResponse({ scroll: await paneScrollInfo(paneId) });
          } catch (error) {
            return errorResponse(error);
          }
        }
        if (request.method !== "POST") return badRequest("method_not_allowed", "use GET or POST");
        let payload: { pane_id?: unknown; offset_from_bottom?: unknown };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.pane_id !== "string" || payload.pane_id.length === 0) return badRequest("missing_pane_id", "pane_id is required");
        if (!isCount(payload.offset_from_bottom)) return badRequest("invalid_offset", "offset_from_bottom must be a non-negative integer");
        try {
          return jsonResponse({ scroll: await paneScroll(payload.pane_id, payload.offset_from_bottom) });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/selection") {
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
        const [anchorRow, anchorCol, cursorRow, cursorCol] = ["anchor_row", "anchor_col", "cursor_row", "cursor_col"]
          .map((name) => { const raw = url.searchParams.get(name); return raw === null || raw === "" ? NaN : Number(raw); });
        if (![anchorRow, anchorCol, cursorRow, cursorCol].every(isCount)) {
          return badRequest("invalid_range", "anchor_row, anchor_col, cursor_row and cursor_col must be non-negative integers");
        }
        try {
          const text = await paneSelectionRead(paneId, { row: anchorRow!, col: anchorCol! }, { row: cursorRow!, col: cursorCol! });
          return jsonResponse({ text });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/conversation/tool-output") {
        const paneId = url.searchParams.get("pane_id");
        const ref = url.searchParams.get("ref");
        if (!paneId || !ref) return badRequest("missing_parameter", "pane_id and ref query parameters are required");
        try {
          const output = await toolOutput(paneId, ref, options.codexHome);
          if (output === null) return jsonResponse({ error: { code: "output_not_found", message: "no such tool call in this pane's conversation" } }, 404);
          return new Response(output, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, max-age=86400, immutable", "x-content-type-options": "nosniff" } });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/conversation/image") {
        const paneId = url.searchParams.get("pane_id");
        const ref = url.searchParams.get("ref");
        if (!paneId || !ref) return badRequest("missing_parameter", "pane_id and ref query parameters are required");
        try {
          const image = await conversationImage(paneId, ref, options.codexHome);
          if (image === null) return jsonResponse({ error: { code: "image_not_found", message: "no such image in this pane's conversation" } }, 404);
          // Claude embeds immutable bytes; a Codex attachment may name a local file that changes.
          return new Response(image.bytes, { headers: { "content-type": image.mediaType, "cache-control": ref.startsWith("codex-") ? "private, no-store" : "private, max-age=86400, immutable", "x-content-type-options": "nosniff" } });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/conversation") {
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
        const page = {
          before: url.searchParams.get("before") ?? undefined,
          since: url.searchParams.get("since") ?? undefined,
          from: url.searchParams.get("from") ?? undefined,
        };
        try {
          const { version, ...conversation } = await paneConversation(paneId, options.codexHome, page);
          // The chat polls every 2s: an unchanged conversation answers 304 with no body.
          // no-store keeps the browser's own cache out of it, so the chat sees the 304.
          const etag = `"${version}"`;
          const headers = { etag, "cache-control": "no-store" };
          if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
          return jsonResponse(conversation, 200, headers);
        } catch (error) {
          if (error instanceof HistoryChanged) return jsonResponse({ error: { code: "history_changed", message: error.message } }, 409);
          // an unrecognized pane is not an error: the client falls back to the
          // scrollback transcript, exactly like chatmux's terminal fallback
          if (error instanceof ConversationUnavailable) return jsonResponse({ source: "scrollback", turns: [] });
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/explain") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        const explain = explainRequest(payload);
        if (typeof explain === "string") return badRequest("invalid_body", explain);
        // the person's own limits, read from the server's own folder: neither a project's fleet.json
        // nor one left in the shared temp folder decides what their account is spent on
        const config = (options.fleet?.config ?? ((cwd: string) => loadConfig(cwd)))(explainRoot);
        // a call waits its turn and runs up to 90 s: Bun's 10 s idle limit would close the request
        // while claude went on spending the plan, and a second press would spend it again
        bunServer.timeout(request, 0);
        try {
          return jsonResponse(await explainQuestion(explain, {
            workDir: join(explainRoot, "work"),
            calls: explainCalls,
            conversation: async (paneId) => (await paneConversation(paneId, options.codexHome)).turns,
            unavailable: () => usage.unavailable("claude", EXPLAIN_MODEL, config.maxUsedPercent),
            failed: (message) => { usage.noteFailure("claude", EXPLAIN_MODEL, message, config.rateLimitCooldownMinutes); },
            ...options.explain,
          }, request.signal));
        } catch (error) {
          if (error instanceof ExplainError) {
            const [status, code] = ({ limited: [409, "usage_limited"], busy: [429, "explain_busy"], aborted: [499, "request_closed"], failed: [502, "explain_failed"] } as const)[error.code];
            return jsonResponse({ error: { code, message: error.message } }, status);
          }
          if (error instanceof ConversationUnavailable) return jsonResponse({ error: { code: "conversation_unavailable", message: "this pane has no conversation to read" } }, 404);
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/input" || pathname === "/api/pane/keys") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { pane_id?: string; text?: string; keys?: string[] };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.pane_id !== "string" || !payload.pane_id.trim()) return badRequest("missing_pane_id", "pane_id is required");
        try {
          if (pathname === "/api/pane/input") {
            if (typeof payload.text !== "string") return badRequest("missing_text", "text is required");
            await paneSendText(payload.pane_id, payload.text);
          } else {
            if (!Array.isArray(payload.keys) || !payload.keys.every((key) => typeof key === "string")) return badRequest("missing_keys", "keys must be an array");
            await paneSendKeys(payload.pane_id, payload.keys);
          }
          return jsonResponse({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/close") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { pane_id?: string };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.pane_id !== "string" || !payload.pane_id.trim()) return badRequest("missing_pane_id", "pane_id is required");
        try {
          // herdr emits pane.closed -> the collector broadcasts session-changed, so
          // every client refetches and the pane leaves sidebars on its own
          await paneClose(payload.pane_id);
          return jsonResponse({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/image") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { pane_id?: string; content_type?: string; data_base64?: string; name?: string };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.pane_id !== "string" || !payload.pane_id.trim()) return badRequest("missing_pane_id", "pane_id is required");
        if ((payload.content_type !== undefined && typeof payload.content_type !== "string")
          || (payload.data_base64 !== undefined && typeof payload.data_base64 !== "string")
          || (payload.name !== undefined && typeof payload.name !== "string")) {
          return badRequest("invalid_image", "content_type, data_base64 and name must be strings");
        }
        try {
          const path = await savePaneImage({
            paneId: payload.pane_id,
            contentType: payload.content_type ?? "",
            dataBase64: payload.data_base64 ?? "",
            name: payload.name,
          });
          return jsonResponse({ ok: true, path });
        } catch (error) {
          if (error instanceof PasteImageError) {
            return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
          }
          return errorResponse(error);
        }
      }

      if (pathname.startsWith("/api/pane/prompt")) {
        try {
          const response = await handlePromptRequest(request, url, { serialize, codexHome: options.codexHome });
          if (response) return response;
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname.startsWith("/api/")) {
        return jsonResponse({ error: { code: "not_found", message: `unknown endpoint ${pathname}` } }, 404);
      }

      // static client - public even when the API is gated, so the login UI can load
      return serveStatic(pathname);
    },

    websocket: {
      // This transport cap also covers clients that predate application ACKs.
      backpressureLimit: OUTPUT_HARD_BYTES,
      closeOnBackpressureLimit: true,
      drain(client) {
        for (const paneId of client.data.attached) reconcileOutput(paneId);
      },
      async open(client) {
        if (client.data.deviceId) {
          client.data.unwatchDevice = devices.onRevoke(client.data.deviceId, () => {
            client.data.revoked = true;
            client.data.closing = true;
            clients.delete(client);
            for (const paneId of client.data.attached) detach(paneId, client);
            client.data.attached.clear();
            client.data.output.clear();
            client.close(1008, "Device access revoked");
          });
          if (client.data.revoked) return;
        }
        clients.add(client);
        try {
          send(client, { type: "snapshot", snapshot: await clientSnapshot(), features: SERVER_FEATURES });
        } catch (error) {
          const code = error instanceof HerdrError ? error.code : "snapshot_failed";
          send(client, { type: "error", code, message: error instanceof Error ? error.message : String(error) });
        }
      },

      async message(client, raw) {
        if (client.data.closing) return;
        let message: ClientMessage;
        try {
          message = JSON.parse(String(raw)) as ClientMessage;
        } catch {
          send(client, { type: "error", code: "invalid_json", message: "message must be JSON" });
          return;
        }
        try {
          switch (message.type) {
            case "attach": {
              if (message.flow_control !== undefined && message.flow_control !== "ack") {
                send(client, { type: "error", code: "invalid_flow_control", message: "flow_control must be ack" });
                break;
              }
              const geometry = validGeometry(message.cols, message.rows);
              if (!geometry) {
                send(client, { type: "error", code: "invalid_geometry", message: "cols and rows must be integers in 1..1000" });
                break;
              }
              // record the pane before the await: a detach (switching panes) or a close
              // that lands while the terminal is looked up must cancel this attach, and
              // neither can see a client that only joins the attachment afterwards
              client.data.attached.add(message.pane_id);
              let attachment: PaneAttachment;
              try {
                attachment = await ensureAttachment(message.pane_id);
              } catch (error) {
                client.data.attached.delete(message.pane_id);
                throw error;
              }
              if (!client.data.attached.has(message.pane_id)) {
                releaseUnclaimed(message.pane_id, attachment);
                break;
              }
              // a mirror whose pane went away during its first read has already ended: joining
              // it would leave this client on a terminal that never says anything again
              if (attachment.mirror && attachments.get(message.pane_id) !== attachment) {
                client.data.attached.delete(message.pane_id);
                send(client, { type: "pty-exit", pane_id: message.pane_id, code: null });
                break;
              }
              // An idempotent attach must not replay terminal bytes a second time.
              const alreadyAttached = attachment.clients.has(client);
              attachment.clients.add(client);
              if (!alreadyAttached && message.flow_control === "ack") client.data.output.set(message.pane_id, new OutputWindow());
              // the screen is drawn for the pty's grid: the client takes that size before the
              // screen, or the rows would wrap in a grid of another width. A mirror's is fixed:
              // no viewport sizes it (fixed); any other a viewport in front may (resize)
              send(client, { type: "pane-geometry", pane_id: message.pane_id, cols: attachment.cols, rows: attachment.rows, ...(attachment.mirror ? { fixed: true } : {}) });
              // hand the newcomer the current screen it would otherwise have missed
              // (a mirror keeps its latest screen whole; a pty keeps a bounded tail of its stream)
              const replay = attachment.mirror ? attachment.mirror.current ?? "" : attachment.replay.text();
              if (!alreadyAttached && replay) sendOutput(client, message.pane_id, replay);
              // a pane waiting for another web bridge to let go says so to each newcomer, too
              if (!alreadyAttached && attachment.held) send(client, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: message.pane_id });
              reconcileOutput(message.pane_id);
              if (client.data.closing) break;
              if (attachment.ready && !attachment.held) send(client, { type: "input-ready", pane_id: message.pane_id });
              break;
            }
            case "detach": {
              client.data.attached.delete(message.pane_id);
              detach(message.pane_id, client);
              break;
            }
            case "pty-ack": {
              // Observers may acknowledge output, but never input or resize it.
              const window = client.data.output.get(message.pane_id);
              if (window && window.id === message.stream_id && !window.acknowledge(message.stream_id, message.offset)) {
                send(client, { type: "error", code: "invalid_ack", message: "offset must acknowledge bytes already sent" });
                break;
              }
              reconcileOutput(message.pane_id);
              break;
            }
            case "input": {
              if (client.data.mode === "observe") {
                send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
                break;
              }
              // typing goes straight through the pty, unless a composer message is still in
              // flight: then it waits its turn and goes the message's own way (send_text), since
              // the pty holds a lone ESC ~150ms and a Stop would overtake nothing
              // typing reaches an attached pane only, queued or not
              const attachment = attachments.get(message.pane_id);
              const inputFailed = () => {
                if (clients.has(client)) send(client, { type: "error", code: "input_failed", message: "Terminal input could not be confirmed. Check the terminal before typing again.", pane_id: message.pane_id });
              };
              // without a pty (Windows: no terminal, or a mirrored one) typing, the key bar's Enter,
              // Stop and arrows go through herdr itself, each in its turn behind a message in flight.
              // The turn is taken before herdr is asked what it can do: a message sent while
              // that answer is on its way must not overtake the typing.
              if (terminalAttachKnown === false || (!attachment && terminalAttachKnown === null)) {
                const text = message.text;
                void serialize(message.pane_id, async () => {
                  // a herdr that attaches: typing reaches an attached pane only
                  if (await terminalAttach()) { inputFailed(); return; }
                  // a pasted block asks herdr what the pane runs, so it is shaped before the checks below
                  const shaped = await mirrorInput(text, async () => (await paneContext(message.pane_id)).agent);
                  // nothing typed outlives its connection
                  if (!clients.has(client)) return;
                  authorizeSocket(client);
                  await paneSendText(message.pane_id, shaped);
                  // the echo is read at once, not at the mirror's next idle read
                  attachments.get(message.pane_id)?.mirror?.poke();
                }).catch(inputFailed);
                break;
              }
              // another web bridge has this pane's terminal: nothing typed here reaches it
              if (!attachment?.clients.has(client) || !attachment.ready || attachment.held) {
                send(client, { type: "error", code: "input_not_ready", message: "Terminal input is not ready. Nothing was sent.", pane_id: message.pane_id });
                break;
              }
              if (paneQueues.has(message.pane_id)) {
                const text = message.text;
                // typed into this attach: one that ended meanwhile (and was attached again) takes none of it
                const pty = attachment.pty;
                void serialize(message.pane_id, () => {
                  // held while this waited its turn: it goes nowhere, as unqueued typing would
                  if (attachments.get(message.pane_id) !== attachment || attachment.pty !== pty || !attachment.clients.has(client) || !attachment.ready || attachment.held) { inputFailed(); return; }
                  // nothing typed outlives its connection
                  if (!clients.has(client)) return;
                  authorizeSocket(client);
                  return paneSendText(message.pane_id, text);
                }).catch(inputFailed);
              } else {
                if (!attachment.pty.write(message.text)) { inputFailed(); break; }
                lastTyped.set(message.pane_id, Date.now());
                if (lastTyped.size > 64) {
                  for (const [pane, at] of lastTyped) if (Date.now() - at > TYPED_SETTLE_MS) lastTyped.delete(pane);
                }
              }
              break;
            }
            case "resize": {
              if (client.data.mode === "observe") {
                send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
                break;
              }
              const geometry = validGeometry(message.cols, message.rows);
              if (!geometry) {
                send(client, { type: "error", code: "invalid_geometry", message: "cols and rows must be integers in 1..1000" });
                break;
              }
              // the pty is still being created (an attach, then the switch to the terminal lens before
              // the terminal was looked up): the resize waits for it, or it would be lost
              const creating = attachments.has(message.pane_id) ? undefined : pendingAttachments.get(message.pane_id);
              if (creating && client.data.attached.has(message.pane_id)) {
                try { await creating; } catch { break; }
                if (client.data.closing || client.data.mode !== "interact") break;
              }
              const attachment = attachments.get(message.pane_id);
              // a mirrored pane's grid is herdr's own: no viewport sizes it
              if (!attachment || attachment.mirror || !attachment.clients.has(client)) break;
              if (!attachment.driver) attachment.ownGrid = { cols: attachment.cols, rows: attachment.rows };
              attachment.driver = client;
              setGrid(message.pane_id, attachment, geometry.cols, geometry.rows);
              break;
            }
            case "release": {
              if (typeof message.pane_id === "string") release(message.pane_id, client);
              break;
            }
            case "keys": {
              if (client.data.mode === "observe") {
                send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
                break;
              }
              if (attachments.get(message.pane_id)?.held) {
                send(client, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: message.pane_id });
                break;
              }
              await serialize(message.pane_id, async () => {
                // held while this waited its turn (the attach was refused after the check above)
                if (attachments.get(message.pane_id)?.held) {
                  send(client, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: message.pane_id });
                  return;
                }
                // a key pressed by a connection that has gone since is not pressed
                if (!clients.has(client)) return;
                authorizeSocket(client);
                await paneSendKeys(message.pane_id, message.keys);
                attachments.get(message.pane_id)?.mirror?.poke();
              });
              break;
            }
            case "secret": {
              // Refuse busy panes instead of retaining the secret behind another send.
              const result = (ok: boolean, code?: string) => send(client, {
                type: "secret-result", id: message.id, pane_id: message.pane_id, ok, ...(code ? { code } : {}),
              });
              try {
                if (!Number.isSafeInteger(message.id) || typeof message.pane_id !== "string"
                  || typeof message.prompt !== "string" || secretPrompt(message.prompt) !== message.prompt || !validSecret(message.secret)) {
                  result(false, "invalid_secret"); break;
                }
                if (client.data.mode === "observe") { result(false, "read_only"); break; }
                const attachment = attachments.get(message.pane_id);
                if (!attachment?.clients.has(client)) { result(false, "not_attached"); break; }
                if (!attachment.ready || attachment.held) { result(false, "input_not_ready"); break; }
                if (paneQueues.has(message.pane_id)) { result(false, "pane_busy"); break; }
                await serialize(message.pane_id, async () => {
                  // a viewport scrolled into history can still show an old password prompt: check the live screen
                  const screen = await paneRead({ paneId: message.pane_id, source: "detection", format: "text" });
                  if (client.data.closing || client.data.mode === "observe") { result(false, "read_only"); return; }
                  authorizeSocket(client);
                  if (!attachment.clients.has(client) || attachments.get(message.pane_id) !== attachment) { result(false, "not_attached"); return; }
                  if (!attachment.ready || attachment.held) { result(false, "input_not_ready"); return; }
                  if (secretPrompt(screen.text, attachment.cols) !== message.prompt) { result(false, "prompt_changed"); return; }
                  if (attachment.mirror) {
                    // A mirrored pane has no pty to type into: the secret is herdr's text, then the
                    // Enter key (a `\r` inside the text is not Enter to every shell). Both are awaited,
                    // so a send herdr refused is answered as failed, not as entered.
                    await paneSendText(message.pane_id, message.secret);
                    await paneSendKeys(message.pane_id, ["Enter"]);
                  } else {
                    // Direct attach keystrokes: no agent transcript, RPC payload or delayed Enter.
                    if (!attachment.pty.write(`${message.secret}\r`)) { result(false, "input_not_ready"); return; }
                  }
                  result(true);
                });
              } catch {
                // Never forward an exception that might include submitted bytes.
                result(false, "secret_failed");
              } finally { message.secret = ""; }
              break;
            }
            case "submit": {
              // every submit is answered: the composer keeps its text until it hears back
              const result = (ok: boolean, code?: string, text?: string) => send(client, {
                type: "submit-result", id: message.id, pane_id: message.pane_id, ok, ...(code ? { code, message: text } : {}),
              });
              if (!Number.isSafeInteger(message.id) || typeof message.pane_id !== "string" || !message.pane_id
                || typeof message.text !== "string" || typeof message.payload !== "string") {
                send(client, { type: "error", code: "invalid_submit", message: "id must be an integer, pane_id, text and payload strings" });
                break;
              }
              if (client.data.mode === "observe") {
                result(false, "read_only", "this connection is in observe mode");
                break;
              }
              // another web bridge has this pane's terminal: its user types there, not this one
              if (attachments.get(message.pane_id)?.held) {
                result(false, "attach_held", ATTACH_HELD_MESSAGE);
                break;
              }
              const arrivedAt = Date.now();
              try {
                await serialize(message.pane_id, () => {
                  // held while this waited its turn (the attach was refused after the check above)
                  if (attachments.get(message.pane_id)?.held) throw new HerdrError("attach_held", ATTACH_HELD_MESSAGE);
                  return submitText(message.pane_id, message.text, message.payload, arrivedAt, message.typed === true, () => authorizeSocket(client));
                });
                result(true);
              } catch (error) {
                result(false, error instanceof HerdrError ? error.code : "submit_failed", error instanceof Error ? error.message : String(error));
              }
              break;
            }
            case "role": {
              if (message.mode !== "interact" && message.mode !== "observe") {
                send(client, { type: "error", code: "invalid_role", message: "mode must be interact or observe" });
                break;
              }
              if (client.data.readOnly) message.mode = "observe";
              client.data.mode = message.mode;
              send(client, { type: "role-ack", mode: message.mode });
              if (message.mode === "observe") {
                // the fresh observer needs the grid it must adopt, and sizes no pane any more
                for (const paneId of client.data.attached) {
                  release(paneId, client);
                  const attachment = attachments.get(paneId);
                  if (attachment) {
                    send(client, { type: "pane-geometry", pane_id: paneId, cols: attachment.cols, rows: attachment.rows });
                  }
                }
              }
              break;
            }
          }
        } catch (error) {
          const code = error instanceof HerdrError ? error.code : "command_failed";
          send(client, { type: "error", code, message: error instanceof Error ? error.message : String(error) });
        }
      },

      close(client) {
        client.data.unwatchDevice?.();
        clients.delete(client);
        for (const paneId of client.data.attached) detach(paneId, client);
        client.data.attached.clear();
        client.data.output.clear();
      },
    },
  });


  // ACKs can stop arriving entirely (a suspended tab). Bound the pause even then.
  const outputTimer = setInterval(() => {
    for (const paneId of attachments.keys()) reconcileOutput(paneId);
  }, 100);
  outputTimer.unref();
  // herdr's layout moved under an attach (it does not apply it to an attached terminal itself)
  let layoutPolling = false;
  const layoutTimer = setInterval(() => {
    if (layoutPolling) return;
    layoutPolling = true;
    regridMoved().catch(() => undefined).finally(() => { layoutPolling = false; });
  }, LAYOUT_POLL_MS);
  layoutTimer.unref();
  // the threads' open pull requests: their checks, and a merge the person made on GitHub
  let pullRequestsPolling = false;
  const pullRequestTimer = setInterval(() => {
    if (pullRequestsPolling) return;
    pullRequestsPolling = true;
    fleet.refreshPullRequests().catch(() => undefined).finally(() => { pullRequestsPolling = false; });
  }, PULL_REQUEST_POLL_MS);
  pullRequestTimer.unref();

  listeningPort = server.port ?? 0;
  // runs from before a restart: read back from herdr, so the finished ones are not counted as working
  void fleet.reconcileAll();

  return {
    port: server.port ?? 0,
    hostname,
    stop: () => {
      clearInterval(outputTimer);
      clearInterval(layoutTimer);
      clearInterval(pullRequestTimer);
      collector.stop();
      machines?.stop();
      fleet.stop();
      if (fleetChangedTimer) clearTimeout(fleetChangedTimer);
      for (const paneId of [...attachments.keys()]) closeAttachment(paneId);
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const instance = createServer();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    instance.stop();
    // Attach sidecars need ~1.2s to release herdr's exclusive client slot.
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.log(`herdr-fleet listening on http://${instance.hostname}:${instance.port}`);
  if ((process.env["HERDR_FLEET_TOKEN"] ?? "") === "" && !LOOPBACK_HOSTNAMES.has(instance.hostname)) {
    console.error(
      `NOTE: listening on ${instance.hostname} without HERDR_FLEET_TOKEN - other devices need a pairing code (Settings → Devices, on this PC) to get in.`,
    );
  }
}
