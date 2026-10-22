import { afterAll, beforeAll, expect, it, jest } from "bun:test";
import { HerdrSocket } from "./ws.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../../shared/terminal-flow.ts";

/** A WebSocket the test drives: it opens, receives and records what the client sends. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static last: FakeSocket;
  readyState = FakeSocket.CONNECTING;
  readonly sent: { type: string; [key: string]: unknown }[] = [];
  private readonly listeners = new Map<string, ((event: any) => void)[]>();
  constructor(readonly url: string) { FakeSocket.last = this; }
  addEventListener(type: string, listener: (event: any) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  send(data: string): void { const frame = JSON.parse(data); this.sent.push(frame); this.emit("sent", frame); }
  nextSubmission(): Promise<{ id: number }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no submit frame")), 1_000);
      this.addEventListener("sent", (frame) => {
        if (frame.type === "submit") { clearTimeout(timeout); resolve(frame); }
      });
    });
  }
  close(): void { this.readyState = 3; }
  disconnect(): void { this.readyState = 3; this.emit("close", { code: 1006 }); }
  /** the closing handshake started (the server's close frame, or the error handler's close()); the close event comes later */
  closing(): void { this.readyState = 2; }
  closeEvent(code: number): void { this.readyState = 3; this.emit("close", { code }); }
  private emit(type: string, event: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  open(): void { this.readyState = FakeSocket.OPEN; this.emit("open", {}); }
  receive(message: unknown): void { this.emit("message", { data: JSON.stringify(message) }); }
}

const globals = globalThis as unknown as { WebSocket?: unknown; window?: unknown };
const before = { WebSocket: globals.WebSocket, window: globals.window };
beforeAll(() => { globals.WebSocket = FakeSocket; globals.window = globalThis; });
afterAll(() => { globals.WebSocket = before.WebSocket; globals.window = before.window; });

const snapshot = (features: string[]) => ({ type: "snapshot", snapshot: { workspaces: [], panes: [], agents: [], layouts: [] }, features });
const secrets = (socket: FakeSocket) => socket.sent.filter((frame) => frame.type === "secret");
const submissions = (socket: FakeSocket) => socket.sent.filter((frame) => ["submit", "input", "keys"].includes(frame.type));

it("sends a secret entered before the reconnect's snapshot arrived, once the snapshot lists masked input", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  // terminal output is already on screen and the masked field is up; the snapshot is still on its way
  const result = client.sendSecret("w1:p1", "Password:", "hunter2");
  expect(result).not.toBeNull();
  await Promise.resolve();
  expect(secrets(socket)).toEqual([]);
  socket.receive(snapshot(["submit", "secret-input"]));
  // the secret goes out as soon as the snapshot is in, not at the wait's deadline
  for (let turn = 0; turn < 10 && secrets(socket).length === 0; turn++) await Promise.resolve();
  expect(secrets(socket)).toMatchObject([{ type: "secret", pane_id: "w1:p1", prompt: "Password:", secret: "hunter2" }]);
  socket.receive({ type: "secret-result", id: secrets(socket)[0]!["id"], pane_id: "w1:p1", ok: true });
  expect(await result).toEqual({ ok: true });
  client.close();
});

it("answers unsupported, sending nothing, when the snapshot lists no masked input", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit"]));
  expect(await client.sendSecret("w1:p1", "Password:", "hunter2")).toMatchObject({ ok: false, code: "unsupported" });
  expect(secrets(socket)).toEqual([]);
  client.close();
});

it("requires attachment readiness and never replays held input after a detach", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "input-ready"]));
  client.attach("w1:p1", 80, 24);
  expect(client.sendInput("w1:p1", "lost?")).toBe(false);
  socket.receive({ type: "pty-data", pane_id: "w1:p1", data: "screen" });
  expect(client.canInput("w1:p1")).toBe(false);
  socket.receive({ type: "input-ready", pane_id: "w1:p1" });
  expect(client.sendInput("w1:p1", "한글")).toBe(true);
  client.detach("w1:p1");
  socket.receive({ type: "input-ready", pane_id: "w1:p1" });
  expect(client.sendInput("w1:p1", "wrong pane")).toBe(false);
  expect(socket.sent.filter((m) => m.type === "input")).toEqual([{ type: "input", pane_id: "w1:p1", text: "한글" }]);
  client.close();
});

it("attaches a grid the chat lens covers without resizing the shared pty, on a reconnect too, until it drives the size again", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  const lastAttach = () => socket.sent.filter((m) => m.type === "attach").at(-1);
  // attached before the socket opened: the open replays it, as a reconnect does
  client.attach("w1:p1", 40, 20, true);
  socket.open();
  expect(lastAttach()).toEqual({ type: "attach", pane_id: "w1:p1", cols: 40, rows: 20, flow_control: "ack", keep_size: true });
  // the terminal lens is shown and resizes: from then on it drives the size
  client.resize("w1:p1", 100, 30, true);
  socket.open();
  expect(lastAttach()).toEqual({ type: "attach", pane_id: "w1:p1", cols: 100, rows: 30, flow_control: "ack" });
  // the chat lens covers it again
  client.keepSize("w1:p1");
  socket.open();
  expect(lastAttach()).toEqual({ type: "attach", pane_id: "w1:p1", cols: 100, rows: 30, flow_control: "ack", keep_size: true });
  client.close();
});

it("sizes the pane after a resize until it lets go, and takes it again on a reconnect", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  const sizing = () => socket.sent.filter((m) => m.type === "resize" || m.type === "release");
  socket.open();
  client.attach("w1:p1", 40, 20);
  // letting go of a pane it never sized says nothing
  client.keepSize("w1:p1");
  expect(sizing()).toEqual([]);
  // a phone's terminal lens in front sizes the pane
  client.resize("w1:p1", 50, 30, true);
  // the connection drops and comes back: the phone still in front sizes it again, after its attach
  socket.open();
  expect(socket.sent.slice(-2).map((m) => m.type)).toEqual(["attach", "resize"]);
  // the page leaves the screen: it lets go, once
  client.keepSize("w1:p1");
  client.keepSize("w1:p1");
  expect(sizing()).toEqual([
    { type: "resize", pane_id: "w1:p1", cols: 50, rows: 30 },
    { type: "resize", pane_id: "w1:p1", cols: 50, rows: 30 },
    { type: "release", pane_id: "w1:p1" },
  ]);
  // and a reconnect after that leaves the pane alone
  socket.open();
  expect(socket.sent.at(-1)?.type).toBe("attach");
  client.close();
});

it("waits for capabilities when output precedes snapshot, and supports old bridges", () => {
  for (const features of [["input-ready"], []]) {
    const client = new HerdrSocket("ws://test/ws"); client.connect();
    const socket = FakeSocket.last; socket.open(); client.attach("w1:p1", 80, 24);
    socket.receive({ type: "pty-data", pane_id: "w1:p1", data: "screen" });
    expect(client.canInput("w1:p1")).toBe(false);
    socket.receive(snapshot(features));
    expect(client.canInput("w1:p1")).toBe(features.length === 0);
    socket.receive({ type: "input-ready", pane_id: "w1:p1" });
    expect(client.canInput("w1:p1")).toBe(true);
    socket.receive({ type: "input-ready", pane_id: "w1:p1", ready: false });
    expect(client.sendInput("w1:p1", "no replay")).toBe(false);
    client.close();
  }
});

it("reconnects at once when the page wakes instead of waiting out the backoff, and starts the backoff over", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const first = FakeSocket.last;
  first.open();
  // a phone asleep: each attempt fails and the backoff grows toward its cap
  first.disconnect();
  for (let attempt = 0; attempt < 5; attempt++) {
    client.wake();
    FakeSocket.last.disconnect();
  }
  const sleeping = FakeSocket.last;
  client.wake();
  expect(FakeSocket.last).not.toBe(sleeping);
  const woken = FakeSocket.last;
  woken.open();
  expect(woken.sent.map((frame) => frame.type)).toEqual(["role"]);
  // a live connection has no timer to skip: waking opens nothing more
  client.wake();
  expect(FakeSocket.last).toBe(woken);
  client.close();
});

it("backs off repeated short-lived opens, even when each receives a snapshot and terminal readiness", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient([]);
  try {
    let current = socket;
    for (const delay of [250, 500, 1000, 2000, 4000, 5000, 5000]) {
      current.disconnect();
      expect(client.state).toBe("waiting");
      jest.advanceTimersByTime(delay - 1);
      expect(FakeSocket.last).toBe(current);
      jest.advanceTimersByTime(1);
      const next = FakeSocket.last;
      expect(next).not.toBe(current);
      next.open();
      next.receive(snapshot(["input-ready"]));
      next.receive({ type: "input-ready", pane_id: "w1:p1" });
      expect(client.canInput("w1:p1")).toBe(true);
      expect(next.sent.filter((frame) => frame.type === "attach")).toHaveLength(1);
      current = next;
    }
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("starts the retry delay over only after an open connection has stayed up for 10s", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient([]);
  try {
    socket.disconnect();
    jest.advanceTimersByTime(250);
    const short = FakeSocket.last;
    short.open();
    jest.advanceTimersByTime(9_999);
    short.disconnect();
    jest.advanceTimersByTime(499);
    expect(FakeSocket.last).toBe(short);
    jest.advanceTimersByTime(1);
    const stable = FakeSocket.last;
    expect(stable).not.toBe(short);
    stable.open();
    jest.advanceTimersByTime(10_000);
    stable.disconnect();
    jest.advanceTimersByTime(249);
    expect(FakeSocket.last).toBe(stable);
    jest.advanceTimersByTime(1);
    expect(FakeSocket.last).not.toBe(stable);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("ignores a late open from an abandoned attempt instead of replaying on the replacement", () => {
  jest.useFakeTimers();
  const client = new HerdrSocket("ws://test/ws");
  try {
    client.attach("w1:p1", 100, 30);
    client.connect();
    const abandoned = FakeSocket.last;
    jest.advanceTimersByTime(8_000);
    jest.advanceTimersByTime(250);
    const replacement = FakeSocket.last;
    expect(replacement).not.toBe(abandoned);
    replacement.open();
    const sent = [...replacement.sent];
    abandoned.open();
    expect(replacement.sent).toEqual(sent);
    expect(client.state).toBe("open");
    replacement.disconnect();
    jest.advanceTimersByTime(499);
    expect(FakeSocket.last).toBe(replacement);
    jest.advanceTimersByTime(1);
    expect(FakeSocket.last).not.toBe(replacement);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("still bypasses a flapping connection's backoff on wake and resets its next retry", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient([]);
  try {
    socket.disconnect();
    jest.advanceTimersByTime(250);
    const second = FakeSocket.last;
    second.open();
    second.disconnect();
    client.wake();
    const woken = FakeSocket.last;
    expect(woken).not.toBe(second);
    woken.open();
    woken.disconnect();
    jest.advanceTimersByTime(249);
    expect(FakeSocket.last).toBe(woken);
    jest.advanceTimersByTime(1);
    expect(FakeSocket.last).not.toBe(woken);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("does not wake a connection whose output stopped, nor one that was closed", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  (socket as unknown as { emit(type: string, event: unknown): void }).emit("close", { code: OUTPUT_STALLED_CLOSE_CODE });
  client.wake();
  expect(FakeSocket.last).toBe(socket);
  client.close();
  client.wake();
  expect(FakeSocket.last).toBe(socket);
});

it("gives up a connect attempt stuck in CONNECTING after its deadline and starts a new one", () => {
  jest.useFakeTimers();
  const client = new HerdrSocket("ws://test/ws");
  try {
    let disconnects = 0;
    client.onDisconnect(() => { disconnects++; });
    client.connect();
    const stuck = FakeSocket.last;
    jest.advanceTimersByTime(7_999);
    expect(FakeSocket.last).toBe(stuck);
    jest.advanceTimersByTime(1);
    // closed by the client itself, without waiting for a close event that may never come
    expect(stuck.readyState).toBe(3);
    expect(disconnects).toBe(1);
    jest.advanceTimersByTime(250);
    const retry = FakeSocket.last;
    expect(retry).not.toBe(stuck);
    // the late close event of the abandoned attempt changes nothing
    stuck.disconnect();
    expect(disconnects).toBe(1);
    retry.open();
    // an open connection has no deadline
    jest.advanceTimersByTime(60_000);
    expect(FakeSocket.last).toBe(retry);
    expect(retry.readyState).toBe(FakeSocket.OPEN);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("connects at once when the page wakes with a closed socket and no reconnect waiting", () => {
  const client = new HerdrSocket("ws://test/ws");
  let disconnects = 0;
  client.onDisconnect(() => { disconnects++; });
  client.connect();
  const frozen = FakeSocket.last;
  frozen.open();
  // the page froze: the socket died and its close event has not run, so no reconnect is scheduled
  frozen.close();
  client.wake();
  const woken = FakeSocket.last;
  expect(woken).not.toBe(frozen);
  expect(disconnects).toBe(1);
  // its close event arriving afterwards is the old connection's and ends nothing
  frozen.disconnect();
  expect(disconnects).toBe(1);
  // a socket still connecting is left to its own attempt
  client.wake();
  expect(FakeSocket.last).toBe(woken);
  woken.open();
  // and an open one is left alone
  client.wake();
  expect(FakeSocket.last).toBe(woken);
  expect(woken.readyState).toBe(FakeSocket.OPEN);
  client.close();
});

it("leaves a CLOSING socket to its close event on wake, so the server's output-stalled close still stops output", () => {
  const client = new HerdrSocket("ws://test/ws");
  const errors: string[] = [];
  client.on((message) => { if (message.type === "error") errors.push(message.code); });
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.closing();
  client.wake();
  expect(FakeSocket.last).toBe(socket);
  socket.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
  expect(errors).toEqual(["output_stalled"]);
  client.wake();
  expect(FakeSocket.last).toBe(socket);
  client.close();
});

it("still delivers a submit-result that arrives while a woken socket is closing", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit"]));
  try {
    const sent = socket.nextSubmission();
    const result = client.submit("w1:p1", "hello", "hello");
    const frame = await sent;
    socket.closing();
    client.wake();
    socket.receive({ type: "submit-result", id: frame.id, pane_id: "w1:p1", ok: true });
    expect(await result).toEqual({ ok: true });
  } finally {
    client.close();
  }
});

it("stops output when the late close event of a socket wake() already ended says output stalled", () => {
  const client = new HerdrSocket("ws://test/ws");
  const errors: string[] = [];
  client.on((message) => { if (message.type === "error") errors.push(message.code); });
  client.connect();
  const frozen = FakeSocket.last;
  frozen.open();
  // CLOSED with its close event still queued: wake ends it and starts a replacement
  frozen.close();
  client.wake();
  const replacement = FakeSocket.last;
  expect(replacement).not.toBe(frozen);
  replacement.open();
  frozen.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
  expect(errors).toEqual(["output_stalled"]);
  expect(replacement.readyState).toBe(3);
  expect(client.connected).toBe(false);
  // stopped: waking reconnects nothing, an attach does
  client.wake();
  expect(FakeSocket.last).toBe(replacement);
  client.attach("w1:p1", 80, 24);
  expect(FakeSocket.last).not.toBe(replacement);
  client.close();
});

it("lets a slow handshake connect: each attempt given up doubles the next deadline", () => {
  jest.useFakeTimers();
  const client = new HerdrSocket("ws://test/ws");
  try {
    client.connect();
    const first = FakeSocket.last;
    jest.advanceTimersByTime(8_000);
    expect(first.readyState).toBe(3);
    jest.advanceTimersByTime(250);
    const second = FakeSocket.last;
    expect(second).not.toBe(first);
    // a remote PC's upgrade waits up to 15s for its relay: 12s is past the first deadline but inside the second
    jest.advanceTimersByTime(12_000);
    expect(FakeSocket.last).toBe(second);
    expect(second.readyState).toBe(FakeSocket.CONNECTING);
    second.open();
    expect(client.connected).toBe(true);
    // Opening starts the connect deadline over at 8s, not the backoff: this open was brief.
    second.disconnect();
    jest.advanceTimersByTime(500);
    const third = FakeSocket.last;
    expect(third).not.toBe(second);
    jest.advanceTimersByTime(8_000);
    expect(third.readyState).toBe(3);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("gives up an attempt with a grown deadline on wake and starts a fresh one with the shortest", () => {
  jest.useFakeTimers();
  const client = new HerdrSocket("ws://test/ws");
  try {
    client.connect();
    const first = FakeSocket.last;
    jest.advanceTimersByTime(8_000 + 250);
    const second = FakeSocket.last;
    expect(second).not.toBe(first);
    jest.advanceTimersByTime(16_000 + 500);
    const third = FakeSocket.last;
    expect(third).not.toBe(second);
    // the network comes back 2s into an attempt whose deadline has grown to 30s
    jest.advanceTimersByTime(2_000);
    expect(third.readyState).toBe(FakeSocket.CONNECTING);
    client.wake();
    const fresh = FakeSocket.last;
    expect(fresh).not.toBe(third);
    expect(third.readyState).toBe(3);
    // the fresh attempt's deadline is 8s again
    jest.advanceTimersByTime(8_000);
    expect(fresh.readyState).toBe(3);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("never reconnects from a backoff retry left pending once the server stopped output", () => {
  jest.useFakeTimers();
  const client = new HerdrSocket("ws://test/ws");
  const errors: string[] = [];
  client.on((message) => { if (message.type === "error") errors.push(message.code); });
  try {
    client.connect();
    // failed attempts back the retry off to 4s
    for (const delay of [250, 500, 1_000, 2_000]) {
      FakeSocket.last.disconnect();
      jest.advanceTimersByTime(delay);
    }
    const failing = FakeSocket.last;
    failing.disconnect();
    // a pane mounts and connects before that retry runs
    client.connect();
    const replacement = FakeSocket.last;
    expect(replacement).not.toBe(failing);
    replacement.open();
    replacement.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
    expect(errors).toEqual(["output_stalled"]);
    jest.advanceTimersByTime(10_000);
    expect(FakeSocket.last).toBe(replacement);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

/** An attached, input-ready connection to a bridge listing `features`. */
function liveClient(features: string[]): { client: HerdrSocket; socket: FakeSocket } {
  const client = new HerdrSocket("ws://test/ws");
  client.attach("w1:p1", 100, 30);
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["input-ready", ...features]));
  socket.receive({ type: "input-ready", pane_id: "w1:p1" });
  return { client, socket };
}
const pings = (socket: FakeSocket) => socket.sent.filter((frame) => frame.type === "ping");
/** Lets the client's async submit paths run up to their next real wait. */
const settle = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };

it("drops an open socket that answers no ping, reconnects at once and replays the attach", async () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["submit", "ping"]);
  try {
    let disconnects = 0;
    client.onDisconnect(() => { disconnects++; });
    const result = client.submit("w1:p1", "sent before the wake", "sent before the wake");
    for (let turn = 0; turn < 10 && submissions(socket).length === 0; turn++) await Promise.resolve();
    expect(submissions(socket).map((frame) => frame.type)).toEqual(["submit"]);
    // the page comes back: the socket still reads OPEN, but its network is gone
    client.wake();
    expect(pings(socket)).toEqual([{ type: "ping", id: 1 }]);
    expect(client.state).toBe("probing");
    expect(client.connected).toBe(true);
    // a slow link gets a second ping at the first deadline, and is dropped only when that one goes unanswered too
    jest.advanceTimersByTime(3_000);
    expect(pings(socket)).toEqual([{ type: "ping", id: 1 }, { type: "ping", id: 2 }]);
    expect(FakeSocket.last).toBe(socket);
    jest.advanceTimersByTime(2_999);
    expect(FakeSocket.last).toBe(socket);
    jest.advanceTimersByTime(1);
    // given up without waiting for a close event, and a new attempt started without a backoff
    expect(socket.readyState).toBe(3);
    expect(disconnects).toBe(1);
    expect(await result).toMatchObject({ ok: false, code: "disconnected" });
    const fresh = FakeSocket.last;
    expect(fresh).not.toBe(socket);
    expect(client.state).toBe("connecting");
    fresh.open();
    expect(fresh.sent).toEqual([{ type: "role", mode: "interact" }, { type: "attach", pane_id: "w1:p1", cols: 100, rows: 30, flow_control: "ack" }]);
    expect(client.state).toBe("open");
    // the dead socket's late close changes nothing
    socket.disconnect();
    expect(disconnects).toBe(1);
    expect(client.connected).toBe(true);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("keeps typing out of the socket while a probe waits, and takes it again only when its pong comes back", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["submit", "ping"]);
  try {
    expect(client.sendInput("w1:p1", "a")).toBe(true);
    client.wake();
    // refused, so PaneTerminal keeps the keys as a held draft
    expect(client.canInput("w1:p1")).toBe(false);
    expect(client.sendInput("w1:p1", "b")).toBe(false);
    expect(client.sendKeys("w1:p1", ["Enter"])).toBe(false);
    expect(submissions(socket)).toEqual([{ type: "input", pane_id: "w1:p1", text: "a" }]);
    // a second wake while one waits sends no second ping
    client.wake();
    expect(pings(socket)).toHaveLength(1);
    // a frame the browser had buffered before the sleep, or a pong to no ping in flight, proves nothing
    socket.receive({ type: "pane-status", pane_id: "w1:p1", agent_status: "idle" });
    socket.receive({ type: "pong", id: 99 });
    expect(client.state).toBe("probing");
    expect(client.canInput("w1:p1")).toBe(false);
    socket.receive({ type: "pong", id: 1 });
    expect(client.state).toBe("open");
    expect(client.sendInput("w1:p1", "c")).toBe(true);
    jest.advanceTimersByTime(10_000);
    expect(FakeSocket.last).toBe(socket);
    expect(socket.readyState).toBe(FakeSocket.OPEN);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("drops a socket whose only frames during a probe are stale ones", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["ping"]);
  try {
    client.wake();
    for (let step = 0; step < 6; step++) {
      socket.receive({ type: "pane-status", pane_id: "w1:p1", agent_status: "idle" });
      jest.advanceTimersByTime(1_000);
    }
    expect(FakeSocket.last).not.toBe(socket);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("holds a submit and a secret until the probe's pong, then sends each once", async () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["submit", "secret-input", "ping"]);
  try {
    client.wake();
    const submit = client.submit("w1:p1", "later", "later");
    const secret = client.sendSecret("w1:p1", "Password:", "hunter2");
    // waiting, not offline: the composer keeps its text and does not say the PC is gone
    expect(submit).not.toBeNull();
    expect(secret).not.toBeNull();
    await settle();
    const requests = () => socket.sent.filter((frame) => ["submit", "secret"].includes(frame.type));
    expect(requests()).toEqual([]);
    socket.receive({ type: "pong", id: 1 });
    await settle();
    expect(requests().map((frame) => frame.type)).toEqual(["submit", "secret"]);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("settles a submit that waited on a probe as disconnected when the socket is dropped, having sent nothing", async () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["submit", "secret-input", "ping"]);
  try {
    // a submit already on its way when the page comes back, still before its snapshot wait ends
    const submit = client.submit("w1:p1", "later", "later");
    client.wake();
    const secret = client.sendSecret("w1:p1", "Password:", "hunter2");
    await settle();
    jest.advanceTimersByTime(6_000);
    expect(FakeSocket.last).not.toBe(socket);
    expect(await submit).toMatchObject({ ok: false, code: "disconnected" });
    expect(await secret).toMatchObject({ ok: false, code: "disconnected" });
    expect(socket.sent.filter((frame) => ["submit", "secret"].includes(frame.type))).toEqual([]);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("still stops output on a 4008 close that comes after a probe dropped the socket", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["ping"]);
  try {
    const errors: string[] = [];
    client.on((message) => { if (message.type === "error") errors.push(message.code); });
    client.wake();
    jest.advanceTimersByTime(6_000);
    const fresh = FakeSocket.last;
    expect(fresh).not.toBe(socket);
    fresh.open();
    socket.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
    expect(errors).toEqual(["output_stalled"]);
    expect(client.state).toBe("stopped");
    expect(fresh.readyState).toBe(3);
    expect(client.connected).toBe(false);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("does not drop a connection over a probe deadline that ran out while the page was frozen", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["ping"]);
  try {
    client.wake();
    // the page froze for a minute: the timers fire at once on resume, before the queued pong is read
    jest.setSystemTime(Date.now() + 60_000);
    jest.advanceTimersByTime(3_000);
    expect(FakeSocket.last).toBe(socket);
    expect(pings(socket)).toEqual([{ type: "ping", id: 1 }, { type: "ping", id: 2 }]);
    // the pong to the ping sent before the freeze no longer counts; the fresh one does
    socket.receive({ type: "pong", id: 1 });
    expect(client.state).toBe("probing");
    socket.receive({ type: "pong", id: 2 });
    expect(client.state).toBe("open");
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("pauses a probe when the page is hidden and pings again when it is shown", () => {
  jest.useFakeTimers();
  const listeners = new Map<string, () => void>();
  const page = { visibilityState: "visible", addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); }, removeEventListener: () => {} };
  const globalDocument = globalThis as unknown as { document?: unknown };
  const previous = globalDocument.document;
  globalDocument.document = page;
  const { client, socket } = liveClient(["ping"]);
  try {
    client.wake();
    page.visibilityState = "hidden";
    listeners.get("visibilitychange")!();
    // a probe cut short is not an answer: typing stays refused until a pong comes
    expect(client.state).toBe("probing");
    expect(client.canInput("w1:p1")).toBe(false);
    jest.advanceTimersByTime(60_000);
    expect(FakeSocket.last).toBe(socket);
    page.visibilityState = "visible";
    listeners.get("visibilitychange")!();
    expect(pings(socket)).toEqual([{ type: "ping", id: 1 }, { type: "ping", id: 2 }]);
    socket.receive({ type: "pong", id: 2 });
    expect(client.state).toBe("open");
  } finally {
    client.close();
    globalDocument.document = previous;
    jest.useRealTimers();
  }
});

it("probes a reconnected socket whose snapshot never came, on a bridge that listed ping before", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["ping"]);
  try {
    socket.disconnect();
    jest.advanceTimersByTime(250);
    const fresh = FakeSocket.last;
    expect(fresh).not.toBe(socket);
    fresh.open();
    client.wake();
    expect(pings(fresh)).toHaveLength(1);
    jest.advanceTimersByTime(6_000);
    expect(FakeSocket.last).not.toBe(fresh);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("doubles the probe deadline after a probe drop, and starts over once a pong comes back", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["ping"]);
  try {
    client.wake();
    jest.advanceTimersByTime(6_000);
    const second = FakeSocket.last;
    expect(second).not.toBe(socket);
    second.open();
    second.receive(snapshot(["ping"]));
    client.wake();
    // 6s per ping now: a link that is just slow is not dropped again at the same deadline
    jest.advanceTimersByTime(11_999);
    expect(FakeSocket.last).toBe(second);
    expect(pings(second)).toHaveLength(2);
    second.receive({ type: "pong", id: pings(second).at(-1)!.id as number });
    expect(client.state).toBe("open");
    client.wake();
    jest.advanceTimersByTime(6_000);
    expect(FakeSocket.last).not.toBe(second);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("pings a connection silent for 20s while visible, and not one that keeps receiving", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["ping"]);
  try {
    for (let second = 0; second < 60; second += 5) {
      jest.advanceTimersByTime(5_000);
      socket.receive({ type: "pane-status", pane_id: "w1:p1", agent_status: "working" });
    }
    expect(pings(socket)).toEqual([]);
    jest.advanceTimersByTime(19_999);
    expect(pings(socket)).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(pings(socket)).toEqual([{ type: "ping", id: 1 }]);
    jest.advanceTimersByTime(6_000);
    expect(FakeSocket.last).not.toBe(socket);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("never pings a bridge whose snapshot does not list ping, and trusts its connection as before", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["submit"]);
  try {
    client.wake();
    jest.advanceTimersByTime(120_000);
    expect(pings(socket)).toEqual([]);
    expect(FakeSocket.last).toBe(socket);
    expect(client.state).toBe("open");
    expect(client.sendInput("w1:p1", "x")).toBe(true);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("leaves a socket the server is closing to its close event when a probe times out, so a 4008 still stops output", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["ping"]);
  try {
    const errors: string[] = [];
    client.on((message) => { if (message.type === "error") errors.push(message.code); });
    client.wake();
    socket.closing();
    jest.advanceTimersByTime(3_000);
    expect(FakeSocket.last).toBe(socket);
    socket.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
    expect(errors).toEqual(["output_stalled"]);
    expect(client.state).toBe("stopped");
    jest.advanceTimersByTime(10_000);
    expect(FakeSocket.last).toBe(socket);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("keeps a submit and a secret waiting when the page hides during a probe, and sends them after the next pong", async () => {
  jest.useFakeTimers();
  const listeners = new Map<string, () => void>();
  const page = { visibilityState: "visible", addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); }, removeEventListener: () => {} };
  const globalDocument = globalThis as unknown as { document?: unknown };
  const previous = globalDocument.document;
  globalDocument.document = page;
  const { client, socket } = liveClient(["submit", "secret-input", "ping"]);
  try {
    client.wake();
    const submit = client.submit("w1:p1", "later", "later");
    const secret = client.sendSecret("w1:p1", "Password:", "hunter2");
    await settle();
    page.visibilityState = "hidden";
    listeners.get("visibilitychange")!();
    await settle();
    const requests = () => socket.sent.filter((frame) => ["submit", "secret"].includes(frame.type));
    // nothing goes out on a socket no pong has vouched for
    expect(requests()).toEqual([]);
    page.visibilityState = "visible";
    listeners.get("visibilitychange")!();
    expect(pings(socket)).toEqual([{ type: "ping", id: 1 }, { type: "ping", id: 2 }]);
    await settle();
    expect(requests()).toEqual([]);
    socket.receive({ type: "pong", id: 2 });
    await settle();
    expect(requests().map((frame) => frame.type)).toEqual(["submit", "secret"]);
    expect(submit).not.toBeNull();
    expect(secret).not.toBeNull();
  } finally {
    client.close();
    globalDocument.document = previous;
    jest.useRealTimers();
  }
});

it("settles a submit waiting on a probe when a CLOSING socket is replaced, and takes input on the new one", async () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["submit", "ping"]);
  try {
    let disconnects = 0;
    client.onDisconnect(() => { disconnects++; });
    client.wake();
    let outcome: unknown = null;
    void client.submit("w1:p1", "later", "later")!.then((result) => { outcome = result; });
    await settle();
    // the closing handshake started, and a pane mount connects again before the close event
    socket.closing();
    client.connect();
    const fresh = FakeSocket.last;
    expect(fresh).not.toBe(socket);
    await settle();
    expect(outcome).toMatchObject({ ok: false, code: "disconnected" });
    expect(disconnects).toBe(1);
    fresh.open();
    fresh.receive(snapshot(["input-ready", "submit", "ping"]));
    fresh.receive({ type: "input-ready", pane_id: "w1:p1" });
    // the old probe's deadline does not hold the new socket's input
    expect(client.canInput("w1:p1")).toBe(true);
    jest.advanceTimersByTime(12_000);
    expect(FakeSocket.last).toBe(fresh);
    expect(socket.sent.filter((frame) => frame.type === "submit")).toEqual([]);
    // its late close changes nothing
    socket.closeEvent(1000);
    expect(disconnects).toBe(1);
    expect(client.connected).toBe(true);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("tells its handlers the probe's pong, so a view that read input as refused during the probe reads it again", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["ping"]);
  try {
    const seen: boolean[] = [];
    client.on((message) => { seen.push(message.type === "pong" && client.canInput("w1:p1")); });
    client.wake();
    // output during the probe: a view reading canInput() now stores false
    socket.receive({ type: "pty-data", pane_id: "w1:p1", data: "x" });
    expect(seen).toEqual([false]);
    socket.receive({ type: "pong", id: 1 });
    expect(seen).toEqual([false, true]);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("ends a probe sent before the snapshot when the reconnected bridge does not list ping, and keeps its connection", async () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["submit", "ping"]);
  try {
    socket.disconnect();
    jest.advanceTimersByTime(250);
    const older = FakeSocket.last;
    expect(older).not.toBe(socket);
    older.open();
    // woken before the new snapshot: the ping support remembered from the last bridge sends a ping
    client.wake();
    expect(pings(older)).toHaveLength(1);
    const submit = client.submit("w1:p1", "later", "later");
    older.receive(snapshot(["submit"]));
    expect(client.state).toBe("open");
    await settle();
    expect(older.sent.filter((frame) => frame.type === "submit").map((frame) => frame.text)).toEqual(["later"]);
    older.receive({ type: "submit-result", id: older.sent.find((frame) => frame.type === "submit")!.id, pane_id: "w1:p1", ok: true });
    expect(await submit).toEqual({ ok: true });
    jest.advanceTimersByTime(30_000);
    expect(FakeSocket.last).toBe(older);
    expect(older.readyState).toBe(FakeSocket.OPEN);
    expect(pings(older)).toHaveLength(1);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

it("ends a probe the hidden page paused when the reconnected bridge's snapshot does not list ping", async () => {
  jest.useFakeTimers();
  const listeners = new Map<string, () => void>();
  const page = { visibilityState: "visible", addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); }, removeEventListener: () => {} };
  const globalDocument = globalThis as unknown as { document?: unknown };
  const previous = globalDocument.document;
  globalDocument.document = page;
  const { client, socket } = liveClient(["submit", "ping"]);
  try {
    socket.disconnect();
    jest.advanceTimersByTime(250);
    const older = FakeSocket.last;
    older.open();
    client.wake();
    expect(pings(older)).toHaveLength(1);
    // put away before the snapshot: the probe pauses
    page.visibilityState = "hidden";
    listeners.get("visibilitychange")!();
    expect(client.state).toBe("probing");
    const submit = client.submit("w1:p1", "later", "later");
    older.receive(snapshot(["submit"]));
    // shown again: probe() never pings this bridge, so the snapshot must have ended the paused probe
    page.visibilityState = "visible";
    listeners.get("visibilitychange")!();
    expect(client.state).toBe("open");
    await settle();
    expect(older.sent.filter((frame) => frame.type === "submit").map((frame) => frame.text)).toEqual(["later"]);
    older.receive({ type: "submit-result", id: older.sent.find((frame) => frame.type === "submit")!.id, pane_id: "w1:p1", ok: true });
    expect(await submit).toEqual({ ok: true });
  } finally {
    client.close();
    globalDocument.document = previous;
    jest.useRealTimers();
  }
});

it("lets an interrupt and other control keys through while a probe waits, never text", () => {
  jest.useFakeTimers();
  const { client, socket } = liveClient(["ping"]);
  try {
    client.wake();
    expect(client.canInput("w1:p1")).toBe(false);
    // a runaway program must be stoppable while the connection is checked; a dead socket loses it either way
    expect(client.sendInput("w1:p1", "\x03")).toBe(true);
    expect(client.sendInput("w1:p1", "\x1b")).toBe(true);
    expect(client.sendInput("w1:p1", "ls")).toBe(false);
    expect(client.sendInput("w1:p1", "\r")).toBe(false);
    expect(socket.sent.filter((frame) => frame.type === "input").map((frame) => frame.text)).toEqual(["\x03", "\x1b"]);
  } finally {
    client.close();
    jest.useRealTimers();
  }
});

/** A page whose visibility the test sets: install it before connect(), which listens for its changes. */
function fakePage(): { hide(): void; show(): void; restore(): void } {
  const listeners = new Map<string, () => void>();
  const page = { visibilityState: "visible", addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); }, removeEventListener: () => {} };
  const globalDocument = globalThis as unknown as { document?: unknown };
  const previous = globalDocument.document;
  globalDocument.document = page;
  const change = (state: string) => { page.visibilityState = state; listeners.get("visibilitychange")?.(); };
  return { hide: () => change("hidden"), show: () => change("visible"), restore: () => { globalDocument.document = previous; } };
}

it("marks a 4008 that came while the page was hidden, and an attach after it is shown reconnects and replays every attach", () => {
  const page = fakePage();
  const { client, socket } = liveClient([]);
  try {
    client.attach("w1:p2", 80, 24);
    page.hide();
    socket.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
    expect(client.outputStopped).toBe(true);
    expect(client.stoppedWhileHidden).toBe(true);
    // showing the page reconnects nothing by itself: the pane, back in use, attaches again
    page.show();
    expect(FakeSocket.last).toBe(socket);
    client.attach("w1:p1", 100, 30);
    expect(client.outputStopped).toBe(false);
    expect(client.stoppedWhileHidden).toBe(false);
    const reconnected = FakeSocket.last;
    expect(reconnected).not.toBe(socket);
    reconnected.open();
    expect(reconnected.sent.filter((frame) => frame.type === "attach").map((frame) => frame.pane_id).sort()).toEqual(["w1:p1", "w1:p2"]);
  } finally {
    client.close();
    page.restore();
  }
});

it("counts a 4008 read just after the page is shown again as the hidden page's, once", () => {
  jest.useFakeTimers();
  const page = fakePage();
  const { client, socket } = liveClient([]);
  try {
    page.hide();
    page.show();
    // the frozen page reads the server's close only after it resumed
    jest.advanceTimersByTime(1_000);
    socket.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
    expect(client.stoppedWhileHidden).toBe(true);
    client.attach("w1:p1", 100, 30);
    const reconnected = FakeSocket.last;
    reconnected.open();
    // the same device stalls again while in use: that stop is final
    reconnected.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
    expect(client.outputStopped).toBe(true);
    expect(client.stoppedWhileHidden).toBe(false);
  } finally {
    client.close();
    page.restore();
    jest.useRealTimers();
  }
});

it("keeps a 4008 while the page is in use final: no reconnect on its own, on wake or later", () => {
  jest.useFakeTimers();
  const page = fakePage();
  const { client, socket } = liveClient([]);
  try {
    page.hide();
    page.show();
    // long after the page came back, this device is simply too slow
    jest.advanceTimersByTime(60_000);
    socket.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
    expect(client.outputStopped).toBe(true);
    expect(client.stoppedWhileHidden).toBe(false);
    client.wake();
    page.hide();
    page.show();
    jest.advanceTimersByTime(60_000);
    expect(FakeSocket.last).toBe(socket);
    expect(client.state).toBe("stopped");
  } finally {
    client.close();
    page.restore();
    jest.useRealTimers();
  }
});

it("counts a page that connected while hidden as put away until it is first shown", () => {
  const page = fakePage();
  page.hide();
  const { client, socket } = liveClient([]);
  try {
    page.show();
    socket.closeEvent(OUTPUT_STALLED_CLOSE_CODE);
    expect(client.stoppedWhileHidden).toBe(true);
  } finally {
    client.close();
    page.restore();
  }
});
