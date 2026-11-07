import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "./devices.ts";
import { createServer } from "./index.ts";

/**
 * What server/device-access.contract.test.ts cannot check through a URL alone (ADR 0122): the
 * failed write is made by a folder named after the server's own pid, and the registry is read
 * and seeded in this process, so the server runs here.
 */

const guard = { "x-herdr-machine": "1", "content-type": "application/json" };

it("returns an error when revocation cannot be persisted, then allows a successful retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-write-"));
  const store = new DeviceStore(root);
  const paired = store.pair(store.startPairing().code, "Phone")!;
  const server = createServer({ port: 0, stateDir: root, token: "test-write", tailscaleOwner: null, machines: false });
  const base = `http://127.0.0.1:${server.port}`;
  const blocked = join(root, `devices.json.${process.pid}.tmp`);
  try {
    mkdirSync(blocked);
    const revoke = () => fetch(`${base}/api/devices/${paired.device.id}`, { method: "DELETE", headers: { ...guard, authorization: "Bearer test-write" } });
    const failed = await revoke();
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(new DeviceStore(root).match(paired.token)).not.toBeNull();
    rmSync(blocked, { recursive: true });
    expect((await revoke()).status).toBe(204);
    expect(new DeviceStore(root).match(paired.token)).toBeNull();
  } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
});
