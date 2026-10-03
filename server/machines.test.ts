import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneNotificationTag } from "../shared/notify-policy.ts";
import { paneStorageId } from "../shared/machines.ts";
import { sameOrigin } from "./http.ts";
import { handleMachineRequest } from "./machine-api.ts";
import { MachineManager } from "./machines.ts";
import { CompletionTracker } from "./completion.ts";
import { terminalAttachSupported } from "./herdr/client.ts";
import { attachableIdentity, isRealNode, sidecarAvailable } from "./pty/sidecar.ts";

describe("machine boundaries", () => {
  it("separates equal pane IDs while preserving historical local storage", () => {
    expect(paneStorageId("local", "p:1")).toBe("p:1");
    expect(new Set(["local", "one", "two"].map((id) => paneStorageId(id, "p:1"))).size).toBe(3);
    expect(paneNotificationTag("p:1", "one")).not.toBe(paneNotificationTag("p:1", "two"));
  });
  it("rejects cross-origin controls", () => {
    expect(sameOrigin(new Request("http://localhost:7317/api/machines", { headers: { origin: "http://evil.test" } }))).toBe(false);
    expect(sameOrigin(new Request("http://localhost:7317/api/machines", { headers: { origin: "http://localhost:7317" } }))).toBe(true);
    expect(sameOrigin(new Request("http://localhost:7317/api/machines", { headers: { "sec-fetch-site": "cross-site" } }))).toBe(false);
  });
});

describe("PC list", () => {
  const manager = () => new MachineManager(new CompletionTracker(null), async () => ({ workspaces: [], tabs: [], panes: [] }) as never);
  const at = (path: string, method = "GET") => new Request(`http://localhost:7317/api/machines${path}`, { method });

  it("lists this PC only, and offers no setup, proxy or management routes", async () => {
    const pcs = manager();
    try {
      const listed = await (await handleMachineRequest(at(""), pcs)).json() as { machines: { id: string; kind: string }[] };
      expect(listed.machines.map((pc) => [pc.id, pc.kind])).toEqual([["local", "local"]]);
      for (const path of ["/setup", "/settings", "/pc1/session", "/pc1/fs/file", "/pc1/update-bridge"]) expect((await handleMachineRequest(at(path), pcs)).status).toBe(404);
      for (const method of ["POST", "PATCH", "DELETE"]) expect((await handleMachineRequest(at("/setup", method), pcs)).status).toBe(405);
    } finally { pcs.stop(); }
  });
});

describe("terminal attach capability", () => {
  it("follows herdr's own word when it gives one, and the platform otherwise", () => {
    expect(terminalAttachSupported({ direct_terminal_attach: false, live_handoff: true })).toBe(false);
    expect(terminalAttachSupported({ direct_terminal_attach: true })).toBe(true);
    expect(terminalAttachSupported({ live_handoff: true })).toBe(process.platform !== "win32");
    expect(terminalAttachSupported(undefined)).toBe(process.platform !== "win32");
  });

  it("mirrors a PC whose bridge cannot run the PTY sidecar, whatever herdr declares", () => {
    const declared = { version: "0.9.9", protocol: 22, terminal_attach: terminalAttachSupported({ direct_terminal_attach: true }) };
    expect(attachableIdentity(declared, false)).toEqual({ version: "0.9.9", protocol: 22, terminal_attach: false, terminal_mirror: true });
    expect(attachableIdentity(declared, true)).toEqual(declared);
    const mirrored = { version: "0.9.9", protocol: 22, terminal_attach: false, terminal_mirror: true };
    expect(attachableIdentity(mirrored, true)).toEqual(mirrored);
    expect(attachableIdentity(mirrored, false)).toEqual(mirrored);
  });

  it("counts the sidecar as runnable only with both node and node-pty", () => {
    expect(sidecarAvailable({ node: () => true, pty: () => true })).toBe(true);
    expect(sidecarAvailable({ node: () => false, pty: () => true })).toBe(false);
    expect(sidecarAvailable({ node: () => true, pty: () => false })).toBe(false);
  });

  it("takes a node for Node only when it answers in time and is not Bun", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-sidecar-probe-"));
    const stand = (name: string, body: string) => {
      const path = join(dir, name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
      return path;
    };
    try {
      expect(isRealNode(stand("node", "echo"))).toBe(true);
      expect(isRealNode(stand("bun-as-node", "echo 1.4.2"))).toBe(false);
      expect(isRealNode(stand("broken", "exit 1"))).toBe(false);
      expect(isRealNode(join(dir, "absent"))).toBe(false);
      // a node that never answers is given up on, not waited for
      expect(isRealNode(stand("hung", "exec sleep 30"), process.env, 200)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
