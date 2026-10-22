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
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;
const DISCONNECTED: SubmitResult = { ok: false, code: "disconnected", message: "the connection dropped before the pane confirmed this message" };

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
  /** a socket wake() ended before its close event ran: that event can still say the output stopped */
  private endedEarly: WebSocket | null = null;
  private disposed = false;
  private wakeListening = false;
  /** a page shown again or a network back: a reconnect waiting out its backoff runs now */
  private readonly onWake = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
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

  connect(): void {
    if (this.disposed) return;
    this.listenForWake();
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    // a backoff retry still waiting would only open a second attempt later, past whatever ends this one
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = new WebSocket(this.url);
    this.socket = socket;
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
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        /* ignore malformed frame */
        return;
      }
      if (message.type === "snapshot") {
        this.features = new Set(message.features ?? []);
        this.snapshotKnown = true;
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
      if (this.endedEarly === socket) {
        this.endedEarly = null;
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
    for (const handler of this.disconnectHandlers) handler();
    this.markSnapshot();
    this.settleSubmits(DISCONNECTED);
  }

  private stopOutput(): void {
    this.outputStopped = true;
    // stopped output stays stopped until an attach: no retry left armed may reconnect behind it
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.emit({ type: "error", code: "output_stalled", message: "Terminal output stopped because this device could not keep up." });
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
   * the shortest delay; a connection that is open, or a first attempt still connecting, is left
   * alone (connect() ignores it). An attempt still connecting after earlier ones hit their deadline
   * has a deadline grown up to 30s, likely started on the network that just came back or changed:
   * it is given up now and a fresh attempt starts with the shortest deadline. A socket in CLOSING
   * is left to its close event too: a submit-result can still arrive during that handshake, and
   * the server's close code decides whether output stopped (the reconnect it schedules starts from
   * the shortest delay). A stopped output stays stopped: only an attach resumes it.
   */
  wake(): void {
    if (this.disposed || this.outputStopped) return;
    const socket = this.socket;
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
      this.endedEarly = socket;
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

  canInput(paneId: string): boolean {
    return this.connected && this.mode === "interact" && this.inputReady.has(paneId);
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
      if (!this.connected || this.socket !== socket) return DISCONNECTED;
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
      if (!this.connected || this.socket !== socket) { secret = ""; return DISCONNECTED; }
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

  sendKeys(paneId: string, keys: string[]): void {
    if (!this.connected) return;
    this.rawSend({ type: "keys", pane_id: paneId, keys });
  }

  close(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearConnectTimer();
    this.endedEarly = null;
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
