import type { ClientMessage, ClientRole, ServerFeature, ServerMessage } from "../../shared/protocol.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../../shared/terminal-flow.ts";

type Handler = (message: ServerMessage) => void;

/** How a composer message ended: ok once the pane has it and its Enter, else why not. */
export type SubmitResult = { ok: true } | { ok: false; code: string; message: string };

/** Right after a reconnect the snapshot that says what the server supports may still be on its way. */
const SNAPSHOT_WAIT_MS = 2000;
/**
 * A submit the server never answers: the composer stops waiting and keeps the text. The
 * server types nothing once 45s have passed since the message reached it (queued behind
 * others included) and a send that started in time ends within two more 10s RPCs, so a
 * message the client gave up on is never submitted later.
 */
const SUBMIT_TIMEOUT_MS = 90_000;
/**
 * A connect attempt that has neither opened nor failed by now is given up and retried: a phone
 * that wakes on a dead network (or a tunnel that drops the handshake) can leave a socket in
 * CONNECTING for minutes, and nothing else would ever start a new attempt. Each attempt given up
 * doubles the next one's deadline up to CONNECT_TIMEOUT_MAX_MS, so a slow path that does work (a
 * remote PC, where the server waits up to 15s for the machine relay before it upgrades; a slow
 * cellular or tunnel handshake) still connects; an attempt that opens starts it over.
 */
const CONNECT_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MAX_MS = 30_000;
/**
 * Liveness (feature "ping"): a socket can read OPEN while its TCP path is gone (a phone moved from
 * Wi-Fi to cellular, a NAT entry expired while it slept) and no close event comes for minutes. The
 * client pings when the page comes back, the network changes, or nothing arrived for
 * IDLE_PROBE_MS while the page is visible (checked every IDLE_CHECK_MS). Only the pong of a ping in
 * flight answers it: a frame buffered before the sleep proves nothing. With no pong by
 * PROBE_TIMEOUT_MS it pings once more, and drops the socket when that one is not answered either;
 * each probe that ends in a drop doubles the next one's deadline up to PROBE_TIMEOUT_MAX_MS, so a
 * slow link (a relayed tailnet, a remote PC) is not dropped over and over. A deadline that fires
 * PROBE_OVERDUE_MS late was frozen with the page, not waiting: the probe starts over.
 */
const PROBE_TIMEOUT_MS = 3_000;
const PROBE_TIMEOUT_MAX_MS = 12_000;
const PROBE_OVERDUE_MS = 2_000;
const IDLE_PROBE_MS = 20_000;
const IDLE_CHECK_MS = 5_000;
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;
const DISCONNECTED: SubmitResult = { ok: false, code: "disconnected", message: "the connection dropped before the pane confirmed this message" };

/**
 * Where the connection stands. `connected` and the input checks still read the socket itself:
 * a frozen page's socket can turn CLOSED before any event updates this.
 * - idle: connect() was never called
 * - connecting: an attempt has not opened yet
 * - open: open, and no liveness probe in flight
 * - probing: open, a ping sent and its pong not back yet; terminal input is refused (it goes to the
 *   held draft) and submits, pending actions and secrets wait for the answer before they are sent
 * - waiting: no socket, a reconnect waits out its backoff
 * - stopped: output stopped (4008); only an attach reconnects
 * - closed: close() was called
 */
export type ConnectionState = "idle" | "connecting" | "open" | "probing" | "waiting" | "stopped" | "closed";

interface AttachState {
  cols: number;
  rows: number;
  /** the chat lens covers the grid: attaches (a reconnect's too) leave the shared pty's size alone */
  keepSize: boolean;
  /** this viewport sizes the pane (resize) until it lets go (keepSize): a reconnect takes it again */
  drives: boolean;
}

function defaultUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

/**
 * Reconnecting client for /ws. Attachments are remembered with their geometry so a
 * dropped connection restores the live terminal at the right size instead of
 * leaving a stale screen behind.
 *
 * Two policies live here:
 * - The connection's role survives reconnects: an observe connection re-sends its
 *   role before the attach replay, so a reconnecting phone still cannot resize or
 *   type into the operator's pty.
 * - Terminal input is NEVER queued while disconnected (a command typed into a dead
 *   socket must not fire later, unannounced); PaneTerminal keeps it as a draft the
 *   user reviews instead. Control frames (attach/resize/role) replay as before.
 */
export class HerdrSocket {
  private socket: WebSocket | null = null;
  private readonly url: string;
  private readonly handlers = new Set<Handler>();
  private readonly disconnectHandlers = new Set<() => void>();
  private snapshotKnown = false;
  private readonly outputSeen = new Set<string>();
  private readonly inputReady = new Set<string>();
  private readonly attached = new Map<string, AttachState>();
  private retries = 0;
  private reconnectTimer: number | null = null;
  /** the deadline of the attempt still in CONNECTING */
  private connectTimer: number | null = null;
  /** attempts given up at their deadline since the last one that opened */
  private connectTimeouts = 0;
  /** sockets wake() or a probe ended before their close event ran: that event can still say the output stopped */
  private endedEarly = new WeakSet<WebSocket>();
  private disposed = false;
  private wakeListening = false;
  private connectionState: ConnectionState = "idle";
  /** when the current socket last opened or delivered a frame (Date.now()) */
  private lastFrameAt = 0;
  /** the deadline of the ping in flight; null while no probe waits */
  private probeTimer: number | null = null;
  /**
   * a probe the page hid before its pong: its deadline is stopped (it must not run out while the
   * page is frozen), but it is not answered, so input stays refused and submits keep waiting; the
   * page coming back pings again
   */
  private probePaused = false;
  /** the ids of the probe's pings: only their pong ends it */
  private readonly probeIds = new Set<number>();
  /** settles when the probe in flight ends (answered, given up, or the connection ended) */
  private probeDone: Promise<void> = Promise.resolve();
  private markProbeDone: () => void = () => {};
  /** probes since the last pong that ended in a drop: each doubles the next deadline */
  private probeDrops = 0;
  /** whether the last snapshot listed "ping": kept across reconnects, so a socket whose snapshot never comes is probed too */
  private pingKnown = false;
  /** the periodic check that pings a connection silent for IDLE_PROBE_MS */
  private idleTimer: number | null = null;
  private nextPing = 1;
  /** a page shown again or a network back: a reconnect waiting out its backoff runs now */
  private readonly onWake = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      // a deadline must not run out while the page is frozen, and a probe cut short is not an
      // answer: it pauses, and the page coming back asks again
      this.pauseProbe();
      return;
    }
    this.wake();
  };
  private mode: ClientRole = "interact";
  private outputStopped = false;
  /** what the connected server listed in its snapshot: empty until it arrives, and on older bridges */
  private features = new Set<ServerFeature>();
  /** settles when this connection's snapshot arrives (or the connection ends) */
  private snapshotSeen: Promise<void> = Promise.resolve();
  private markSnapshot: () => void = () => {};
  private nextSubmit = 1;
  /** submits waiting for their submit-result, by id */
  private readonly submits = new Map<number, (result: SubmitResult) => void>();

  constructor(url: string = defaultUrl()) {
    this.url = url;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get state(): ConnectionState {
    return this.connectionState;
  }

  connect(): void {
    if (this.disposed) return;
    this.listenForWake();
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    // A socket still CLOSING (or CLOSED before its close event ran) is replaced: end it first, so its
    // probe, its waiting submits and the disconnect handlers settle now rather than never (its
    // close event would find it replaced). A late 4008 from it still stops output.
    const previous = this.socket;
    if (previous) {
      this.endConnection();
      this.endedEarly.add(previous);
    }
    // a backoff retry still waiting would only open a second attempt later, past whatever ends this one
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    this.connectionState = "connecting";
    this.features = new Set();
    this.inputReady.clear();
    this.outputSeen.clear();
    this.snapshotKnown = false;
    this.snapshotSeen = new Promise((resolve) => { this.markSnapshot = resolve; });
    this.clearConnectTimer();
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null;
      if (this.socket !== socket || socket.readyState !== WebSocket.CONNECTING) return;
      this.connectTimeouts += 1;
      socket.close();
      // the close event of an attempt that never opened may come late or not at all: end it here
      this.closed(socket, 1006);
    }, Math.min(CONNECT_TIMEOUT_MAX_MS, CONNECT_TIMEOUT_MS * 2 ** this.connectTimeouts));

    socket.addEventListener("open", () => {
      if (this.socket === socket) {
        this.clearConnectTimer();
        this.connectTimeouts = 0;
        this.connectionState = "open";
        this.lastFrameAt = Date.now();
        this.watchIdle(socket);
      }
      this.retries = 0;
      // always send the role, never only when non-default: a user can flip the role
      // while disconnected (setMode stores it without sending), so without this frame
      // the reconnect would leave the server on the stale role and no ack would ever
      // arrive - the UI would stay stuck in the old role while the header pill lies
      this.rawSend({ type: "role", mode: this.mode });
      for (const [paneId, state] of this.attached) {
        this.rawSend({ type: "attach", pane_id: paneId, cols: state.cols, rows: state.rows, flow_control: "ack", ...(state.keepSize ? { keep_size: true } : {}) });
        if (state.drives) this.rawSend({ type: "resize", pane_id: paneId, cols: state.cols, rows: state.rows });
      }
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      // any frame postpones the idle probe; only the pong of a ping in flight ends a probe (a frame
      // the browser had buffered before a sleep does not prove the path is still there)
      this.lastFrameAt = Date.now();
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        /* ignore malformed frame */
        return;
      }
      // ended before the handlers run, so the input checks they make already read true; the pong
      // goes on to them, so a view that read input as refused during the probe reads it again
      if (message.type === "pong" && this.probeIds.has(message.id)) {
        this.probeDrops = 0;
        this.endProbe();
      }
      if (message.type === "snapshot") {
        this.features = new Set(message.features ?? []);
        this.snapshotKnown = true;
        this.pingKnown = this.features.has("ping");
        // a probe sent before this snapshot (running or paused), on ping support remembered from an
        // earlier connection: this bridge does not answer pings (an older one after a reconnect), so
        // its connection is trusted as before rather than dropped at the deadline or left paused
        if (!this.pingKnown && this.probing) this.endProbe();
        if (!this.features.has("input-ready")) for (const pane of this.outputSeen) if (this.attached.has(pane)) this.inputReady.add(pane);
        this.markSnapshot();
      }
      if (message.type === "pty-data") this.outputSeen.add(message.pane_id);
      if ((message.type === "input-ready" && message.ready !== false) || (message.type === "pty-data" && this.snapshotKnown && !this.features.has("input-ready"))) {
        if (this.attached.has(message.pane_id)) this.inputReady.add(message.pane_id);
      }
      if ((message.type === "input-ready" && message.ready === false) || message.type === "pty-exit" || (message.type === "error" && message.pane_id && ["attach_held", "input_not_ready"].includes(message.code))) this.inputReady.delete(message.pane_id!);
      if (message.type === "submit-result") {
        const settle = this.submits.get(message.id);
        this.submits.delete(message.id);
        settle?.(message.ok ? { ok: true } : { ok: false, code: message.code ?? "submit_failed", message: message.message ?? "the pane did not take the message" });
      }
      if (message.type === "secret-result") {
        const settle = this.submits.get(message.id);
        this.submits.delete(message.id);
        settle?.(message.ok ? { ok: true } : { ok: false, code: message.code ?? "secret_failed", message: "Secret was not sent. Check the prompt and enter it again." });
      }
      // A terminal/parser failure is not malformed JSON and must not disappear.
      this.emit(message);
    });

    socket.addEventListener("close", (event) => {
      if (this.endedEarly.has(socket)) {
        this.endedEarly.delete(socket);
        // the server's own close still decides whether output stopped, even after a replacement started
        if (event.code === OUTPUT_STALLED_CLOSE_CODE && !this.disposed) {
          if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
          const replacement = this.socket;
          if (replacement) {
            this.endConnection();
            replacement.close();
          }
          this.stopOutput();
        }
        return;
      }
      this.closed(socket, event.code);
    });

    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  /** The end of this connection, from its close event or a connect deadline; a stale socket's is ignored. */
  private closed(socket: WebSocket, code: number): void {
    if (this.socket !== socket) return;
    this.endConnection();
    if (code === OUTPUT_STALLED_CLOSE_CODE) {
      this.stopOutput();
      return;
    }
    this.scheduleReconnect();
  }

  /** Drops the current connection: its submits settle as disconnected and the disconnect handlers run. */
  private endConnection(): void {
    this.socket = null;
    this.clearConnectTimer();
    this.clearLiveness();
    for (const handler of this.disconnectHandlers) handler();
    this.markSnapshot();
    this.settleSubmits(DISCONNECTED);
  }

  private stopOutput(): void {
    this.outputStopped = true;
    this.connectionState = "stopped";
    // stopped output stays stopped until an attach: no retry left armed may reconnect behind it
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.emit({ type: "error", code: "output_stalled", message: "Terminal output stopped because this device could not keep up." });
  }

  /**
   * Pings an open connection whose bridge listed "ping" in its last snapshot (an older one is
   * never asked, and its connection is trusted as before). Until the pong comes back, terminal
   * input is refused, so typing goes to the held draft rather than into a socket that may be
   * dead, and submits wait (see probeSettled()); with no pong after two pings (see
   * PROBE_TIMEOUT_MS) the socket is dropped and a new one connects at once.
   */
  private probe(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.pingKnown || this.probeTimer !== null) return;
    this.connectionState = "probing";
    // a paused probe goes on with a fresh ping: whoever waits on it keeps waiting
    if (this.probePaused) this.probePaused = false;
    else this.probeDone = new Promise((resolve) => { this.markProbeDone = resolve; });
    this.ping(socket, 1);
  }

  /** Stops a probe's deadline while the page is hidden, without answering it (see probePaused). */
  private pauseProbe(): void {
    if (this.probeTimer === null) return;
    window.clearTimeout(this.probeTimer);
    this.probeTimer = null;
    this.probeIds.clear();
    this.probePaused = true;
  }

  /** A probe waits for its pong: running, or paused while the page is hidden. */
  private get probing(): boolean {
    return this.probeTimer !== null || this.probePaused;
  }

  /** Sends one of the probe's pings and arms its deadline; `attempt` 2 is the last before a drop. */
  private ping(socket: WebSocket, attempt: 1 | 2): void {
    const deadline = Math.min(PROBE_TIMEOUT_MAX_MS, PROBE_TIMEOUT_MS * 2 ** this.probeDrops);
    const armedAt = Date.now();
    this.probeTimer = window.setTimeout(() => {
      this.probeTimer = null;
      if (this.socket !== socket) return;
      // the server is closing it: its close event decides, so a 4008 still stops output (see wake())
      if (socket.readyState === SOCKET_CLOSING) {
        this.endProbe();
        return;
      }
      // the page was frozen past the deadline: no pong could have been read meanwhile, so ask again,
      // and a pong to a ping sent before the freeze no longer counts
      if (Date.now() - armedAt > deadline + PROBE_OVERDUE_MS) {
        this.probeIds.clear();
        this.ping(socket, 1);
      }
      else if (attempt === 1) this.ping(socket, 2);
      else this.drop(socket);
    }, deadline);
    const id = this.nextPing++;
    this.probeIds.add(id);
    // a send that throws leaves the deadline to drop the socket
    try { this.rawSend({ type: "ping", id }); } catch { /* see above */ }
  }

  private endProbe(): void {
    if (this.probeTimer !== null) window.clearTimeout(this.probeTimer);
    this.probeTimer = null;
    this.probePaused = false;
    this.probeIds.clear();
    this.markProbeDone();
    if (this.connectionState === "probing") this.connectionState = "open";
  }

  /** Waits out a probe in flight on `socket`; true when it is still this connection afterwards. */
  private async probeSettled(socket: WebSocket): Promise<boolean> {
    while (this.probing && this.socket === socket) await this.probeDone;
    return this.connected && this.socket === socket;
  }

  /**
   * Ends a connection that did not answer its probe without waiting for a close event, which a
   * half-open socket may not deliver for minutes: its submits settle, the disconnect handlers run,
   * and a new socket connects now and replays the role and attaches. The old socket's late events
   * are ignored (it is no longer this.socket).
   */
  private drop(socket: WebSocket): void {
    this.probeDrops += 1;
    this.endConnection();
    // a server close (4008) that comes after this still stops output
    this.endedEarly.add(socket);
    socket.close();
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.retries = 0;
    this.connect();
  }

  private watchIdle(socket: WebSocket): void {
    if (this.idleTimer !== null) window.clearInterval(this.idleTimer);
    this.idleTimer = window.setInterval(() => {
      if (this.socket !== socket) return;
      // a hidden page is probed when it comes back (wake)
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (Date.now() - this.lastFrameAt >= IDLE_PROBE_MS) this.probe();
    }, IDLE_CHECK_MS);
  }

  private clearLiveness(): void {
    this.endProbe();
    if (this.idleTimer !== null) window.clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  private clearConnectTimer(): void {
    if (this.connectTimer === null) return;
    window.clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private listenForWake(): void {
    if (this.wakeListening || typeof window.addEventListener !== "function") return;
    this.wakeListening = true;
    window.addEventListener("online", this.onWake);
    window.addEventListener("pageshow", this.onWake);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onWake);
  }

  /**
   * A phone that slept or went to the background comes back with its socket closed and a
   * reconnect timer that may have backed off to its 5s cap, or with a socket already CLOSED whose
   * close event has not run yet (so no timer at all). Waking skips the wait and starts again from
   * the shortest delay. An open connection may be half-open, so it is probed (see probe()); a
   * first attempt still connecting is left to its deadline. An attempt still connecting after
   * earlier ones hit their deadline has a deadline grown up to 30s, likely started on the network
   * that just came back or changed: it is given up now and a fresh attempt starts with the
   * shortest deadline. A socket in CLOSING is left to its close event: a
   * submit-result can still arrive during that handshake, and the server's close code decides whether output stopped (the
   * reconnect it schedules starts from the shortest delay). A stopped output stays stopped: only
   * an attach resumes it.
   */
  wake(): void {
    if (this.disposed || this.outputStopped) return;
    const socket = this.socket;
    // an open socket may be half-open after a sleep or a network change: ask it (a bridge without "ping" is trusted)
    if (socket?.readyState === WebSocket.OPEN) {
      this.probe();
      return;
    }
    if (socket?.readyState === SOCKET_CLOSING) {
      this.retries = 0;
      return;
    }
    if (socket?.readyState === WebSocket.CONNECTING && this.connectTimeouts > 0) {
      // never opened, so its close event can carry no output-stalled code: end it like its deadline would
      socket.close();
      this.closed(socket, 1006);
    } else if (socket?.readyState === SOCKET_CLOSED) {
      // ended now so its submits and listeners settle; its close event, when it runs, can still stop output
      this.closed(socket, 1006);
      this.endedEarly.add(socket);
    }
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.retries = 0;
    this.connectTimeouts = 0;
    this.connect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    const delay = Math.min(5000, 250 * 2 ** this.retries);
    this.retries += 1;
    this.connectionState = "waiting";
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.outputStopped || this.disposed) return;
      this.connect();
    }, delay);
  }

  private rawSend(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  private send(message: ClientMessage): void {
    if (this.connected) this.rawSend(message);
    // Role/attach/geometry already live in state. Replaying both that state and
    // a queue used to attach twice and duplicate the initial terminal replay.
  }

  private emit(message: ServerMessage): void {
    for (const handler of this.handlers) handler(message);
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onDisconnect(handler: () => void): () => void {
    this.disconnectHandlers.add(handler);
    return () => { this.disconnectHandlers.delete(handler); };
  }

  attach(paneId: string, cols: number, rows: number, keepSize = false): void {
    this.outputSeen.delete(paneId);
    this.inputReady.delete(paneId);
    this.attached.set(paneId, { cols, rows, keepSize, drives: false });
    this.send({ type: "attach", pane_id: paneId, cols, rows, flow_control: "ack", ...(keepSize ? { keep_size: true } : {}) });
    if (this.outputStopped) {
      this.outputStopped = false;
      this.connect();
    }
  }

  /** Capture connection AND subscription before xterm's asynchronous write. Never queue ACKs. */
  outputAcknowledgement(message: Extract<ServerMessage, { type: "pty-data" }>): (() => void) | undefined {
    const flow = message.flow;
    if (!flow) return undefined;
    const connection = this.socket;
    const subscription = this.attached.get(message.pane_id);
    return () => {
      if (!connection || this.socket !== connection || !this.connected || !subscription
        || this.attached.get(message.pane_id) !== subscription) return;
      this.rawSend({ type: "pty-ack", pane_id: message.pane_id, stream_id: flow.stream_id, offset: flow.offset });
    };
  }

  detach(paneId: string): void {
    this.outputSeen.delete(paneId);
    this.inputReady.delete(paneId);
    this.attached.delete(paneId);
    this.send({ type: "detach", pane_id: paneId });
  }

  resize(paneId: string, cols: number, rows: number, force = false): void {
    const state = this.attached.get(paneId);
    if (state) {
      // skip only redundant resizes of OUR OWN geometry: a force resize re-asserts
      // it after another client resized the shared pty (see PaneTerminal refit)
      if (!force && state.drives && state.cols === cols && state.rows === rows) return;
      state.cols = cols;
      state.rows = rows;
      state.keepSize = false;
      state.drives = true;
    }
    this.send({ type: "resize", pane_id: paneId, cols, rows });
  }

  /** The chat lens covers the grid again, or the page left the screen: this viewport lets go of the pane, until the next resize. */
  keepSize(paneId: string): void {
    const state = this.attached.get(paneId);
    if (!state) return;
    state.keepSize = true;
    if (!state.drives) return;
    state.drives = false;
    this.send({ type: "release", pane_id: paneId });
  }

  /** Sets the connection's role. Not queued: the role replays before the attaches on reconnect. */
  setMode(mode: ClientRole): void {
    this.mode = mode;
    if (this.connected) this.rawSend({ type: "role", mode });
  }

  /** False while a liveness probe waits: typing goes to the held draft until the connection answers its ping. */
  canInput(paneId: string): boolean {
    return this.connected && !this.probing && this.mode === "interact" && this.inputReady.has(paneId);
  }

  sendInput(paneId: string, text: string): boolean {
    if (!this.canInput(paneId)) return false;
    try { this.rawSend({ type: "input", pane_id: paneId, text }); return true; } catch { return false; }
  }

  /**
   * Types a composer message and submits it, straight to the socket: a Ctrl armed on the
   * terminal key bar must not turn a one-letter message into a control key. A server
   * listing "submit" sends the Enter itself, after a gap, and says how it went; an older
   * bridge gets the payload and its Enter in one frame, as before. `text` is the message
   * as written, `payload` the same shaped for the pane's paste mode. null, sending
   * nothing, when offline.
   */
  /** `typed`: from the terminal's input line, typed into the pane like the keyboard (see ClientMessage) */
  submit(paneId: string, text: string, payload: string, typed = false): Promise<SubmitResult> | null {
    const socket = this.socket;
    if (!this.connected || socket === null) return null;
    return (async (): Promise<SubmitResult> => {
      await Promise.race([this.snapshotSeen, new Promise((resolve) => window.setTimeout(resolve, SNAPSHOT_WAIT_MS))]);
      // a liveness probe in flight is waited out: nothing is sent on a socket that may be dead
      if (!(await this.probeSettled(socket))) return DISCONNECTED;
      if (!this.features.has("submit")) {
        this.rawSend({ type: "input", pane_id: paneId, text: `${payload}\r` });
        return { ok: true };
      }
      const id = this.nextSubmit++;
      const result = new Promise<SubmitResult>((resolve) => {
        this.submits.set(id, resolve);
        window.setTimeout(() => {
          if (!this.submits.delete(id)) return;
          resolve({ ok: false, code: "timeout", message: "the pane did not confirm this message in time" });
        }, SUBMIT_TIMEOUT_MS);
      });
      this.rawSend({ type: "submit", id, pane_id: paneId, text, payload, ...(typed ? { typed: true } : {}) });
      return await result;
    })();
  }

  /** Send once on this connection. Only a result callback is retained, never the value. */
  sendSecret(paneId: string, prompt: string, secret: string): Promise<SubmitResult> | null {
    const socket = this.socket;
    if (!this.connected || socket === null || this.mode === "observe") return null;
    return (async (): Promise<SubmitResult> => {
      // right after a reconnect the terminal's output can arrive before the snapshot that says
      // whether the server takes masked input: wait for it, as a submit does
      await Promise.race([this.snapshotSeen, new Promise((resolve) => window.setTimeout(resolve, SNAPSHOT_WAIT_MS))]);
      if (!(await this.probeSettled(socket))) { secret = ""; return DISCONNECTED; }
      if (!this.features.has("secret-input")) { secret = ""; return { ok: false, code: "unsupported", message: "Update this PC to use masked input." }; }
      const id = this.nextSubmit++;
      const result = new Promise<SubmitResult>((resolve) => {
        this.submits.set(id, resolve);
        window.setTimeout(() => {
          if (this.submits.delete(id)) resolve({ ok: false, code: "timeout", message: "Check the terminal before trying again." });
        }, 15_000);
      });
      try { this.rawSend({ type: "secret", id, pane_id: paneId, prompt, secret }); }
      catch {
        this.submits.get(id)?.(DISCONNECTED);
        this.submits.delete(id);
      } finally { secret = ""; }
      return result;
    })();
  }

  private settleSubmits(result: SubmitResult): void {
    for (const settle of this.submits.values()) settle(result);
    this.submits.clear();
  }

  sendKeys(paneId: string, keys: string[]): boolean {
    if (!this.canInput(paneId)) return false;
    try { this.rawSend({ type: "keys", pane_id: paneId, keys }); return true; } catch { return false; }
  }

  close(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearConnectTimer();
    this.clearLiveness();
    this.connectionState = "closed";
    this.endedEarly = new WeakSet();
    if (this.wakeListening) {
      window.removeEventListener("online", this.onWake);
      window.removeEventListener("pageshow", this.onWake);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onWake);
      this.wakeListening = false;
    }
    this.socket?.close();
    this.socket = null;
    this.settleSubmits(DISCONNECTED);
    this.handlers.clear();
    this.disconnectHandlers.clear();
  }
}
