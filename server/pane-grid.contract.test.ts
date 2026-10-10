import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, workspaceClose } from "./herdr/client.ts";
import { paneGrid, type Grid } from "./pane-grid.ts";
import { PtySession } from "./pty/session.ts";
import { TEST_SESSION } from "../scripts/test-herdr.ts";

/**
 * An attach holds the pane's terminal at its pty's size, and herdr then leaves its own layout
 * unapplied to it. Only a herdr screen (the TUI) lays panes out, so these run one on the test
 * session, as the user has one on theirs.
 */
let server: { port: number; stop: () => void };
let screen: PtySession;
const stateDir = mkdtempSync(join(tmpdir(), "herdr-fleet-grid-"));

beforeAll(() => {
  server = createServer({ port: 0, stateDir });
  screen = new PtySession({
    command: process.env["HERDR_FLEET_HERDR_BIN"] || "herdr",
    args: ["--session", TEST_SESSION],
    cols: 120,
    rows: 40,
    onData: () => {},
    onExit: () => {},
  });
});

afterAll(async () => {
  screen?.kill();
  await screen?.exited;
  server?.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

type Frame = { type: string; pane_id?: string; data?: string; cols?: number; rows?: number; fixed?: boolean };

async function connect(): Promise<{ ws: WebSocket; seen: Frame[]; waitFor: (predicate: (frame: Frame) => boolean, label: string) => Promise<Frame> }> {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
  const seen: Frame[] = [];
  ws.addEventListener("message", (event) => seen.push(JSON.parse(String(event.data)) as Frame));
  await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
  const waitFor = async (predicate: (frame: Frame) => boolean, label: string): Promise<Frame> => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const found = seen.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`${label} not received`);
      await Bun.sleep(20);
    }
  };
  return { ws, seen, waitFor };
}

async function settledGrid(paneId: string, until: (grid: Grid) => boolean): Promise<Grid> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const grid = await paneGrid(paneId);
    if (grid && until(grid)) return grid;
    if (Date.now() > deadline) throw new Error(`pane ${paneId} never reached the grid wanted (last ${JSON.stringify(grid)})`);
    await Bun.sleep(50);
  }
}

it("follows herdr's layout: a split moved under an attach re-reads the pane's grid and attaches again", async () => {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: "herdr-fleet-test-grid", cwd: tmpdir(), focus: true },
  );
  const paneId = created.root_pane.pane_id;
  const client = await connect();
  try {
    await herdrRpc("pane.split", { target_pane_id: paneId, direction: "down", focus: false });
    // the screen lays the top half out: well under its 40 rows, and narrower than 120 by its borders
    const own = await settledGrid(paneId, (grid) => grid.rows < 30 && grid.cols < 120);

    client.ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 200, rows: 60 }));
    expect(await client.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId, "the pane's grid")).toEqual({ type: "pane-geometry", pane_id: paneId, ...own });
    await client.waitFor((m) => m.type === "input-ready" && m.pane_id === paneId, "attach took");
    expect(await paneGrid(paneId)).toEqual(own);

    client.seen.length = 0;
    await herdrRpc("pane.resize", { pane_id: paneId, direction: "down", amount: 0.2 });
    const moved = await client.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId && m.rows !== own.rows, "the grid after the split moved");
    expect(moved).toMatchObject({ cols: own.cols });
    expect(moved.rows!).toBeGreaterThan(own.rows);
    await client.waitFor((m) => m.type === "input-ready" && m.pane_id === paneId && (m as { ready?: boolean }).ready !== false, "attached again");
    // herdr's screen and the program in the pane agree on the grid the browser now shows
    expect(await paneGrid(paneId)).toEqual({ cols: moved.cols!, rows: moved.rows! });
    // no space in the answer: herdr's screen draws a blank as a cursor move
    client.ws.send(JSON.stringify({ type: "input", pane_id: paneId, text: "clear; echo size=$(stty size | tr ' ' x)\r" }));
    await client.waitFor((m) => m.type === "pty-data" && String(m.data).includes(`size=${moved.rows}x${moved.cols}`), "the shell sees the moved grid");
  } finally {
    client.ws.close();
    await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
  }
}, 60_000);

it("leaves a pane a phone sizes to the phone while herdr's layout moves, and gives it herdr's new grid when the phone lets go", async () => {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: "herdr-fleet-test-grid-phone", cwd: tmpdir(), focus: true },
  );
  const paneId = created.root_pane.pane_id;
  const phone = await connect();
  try {
    await herdrRpc("pane.split", { target_pane_id: paneId, direction: "down", focus: false });
    const own = await settledGrid(paneId, (grid) => grid.rows < 30 && grid.cols < 120);
    phone.ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 40, rows: 20 }));
    await phone.waitFor((m) => m.type === "input-ready" && m.pane_id === paneId, "attach took");
    phone.ws.send(JSON.stringify({ type: "resize", pane_id: paneId, cols: 40, rows: 20 }));
    await settledGrid(paneId, (grid) => grid.cols === 40 && grid.rows === 20);

    // the split moves while the phone sizes the pane: the phone keeps it
    await herdrRpc("pane.resize", { pane_id: paneId, direction: "down", amount: 0.2 });
    await Bun.sleep(2500);
    expect(await paneGrid(paneId)).toEqual({ cols: 40, rows: 20 });

    // the phone lets go: the pane takes the grid herdr lays it out at now, taller than before
    phone.ws.send(JSON.stringify({ type: "release", pane_id: paneId }));
    // (the phone's own 40x20 may be taller than the pane was: the width tells them apart)
    const moved = await settledGrid(paneId, (grid) => grid.cols === own.cols && grid.rows > own.rows);
    await phone.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId && m.rows === moved.rows && m.cols === moved.cols, "the phone draws herdr's new grid");
  } finally {
    phone.ws.close();
    await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
  }
}, 60_000);
