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
    // an attempt that opened starts the deadline over at 8s
    second.disconnect();
    jest.advanceTimersByTime(250);
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
