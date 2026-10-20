import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore, normalizeLabel } from "./devices.ts";
import { isTaggedNode, parseTailscaleOwner } from "./tailscale.ts";

const dir = mkdtempSync(join(tmpdir(), "herdr-devices-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("DeviceStore", () => {
  it("keeps an unreadable or invalid registry gated and intact for recovery", () => {
    for (const contents of ["{broken", "null", "{}", '{"devices":[]}', '{"gate_closed_at":null,"devices":[{}]}']) {
      const root = mkdtempSync(join(dir, "invalid-"));
      const path = join(root, "devices.json");
      writeFileSync(path, contents);
      const store = new DeviceStore(root);
      expect(store.gated).toBe(true);
      expect(store.error).toContain("Restore a valid devices.json");
      expect(() => store.startPairing()).toThrow();
      expect(() => store.revoke("any")).toThrow();
      expect(readFileSync(path, "utf8")).toBe(contents);
    }
    const unreadable = mkdtempSync(join(dir, "unreadable-"));
    mkdirSync(join(unreadable, "devices.json"));
    expect(new DeviceStore(unreadable).gated).toBe(true);
    const fresh = new DeviceStore(mkdtempSync(join(dir, "fresh-")));
    expect(fresh.error).toBeNull();
    expect(fresh.gated).toBe(false);
  });

  it("regression: drops a device an older version paired to only watch, rather than let it type", () => {
    const root = mkdtempSync(join(dir, "older-"));
    const stored = (id: string, token: string, role: string) => ({ id, label: id, role, token_hash: createHash("sha256").update(token).digest("hex"), created_at: "2026-10-01T00:00:00.000Z", last_seen_at: null });
    writeFileSync(join(root, "devices.json"), JSON.stringify({ gate_closed_at: "2026-10-01T00:00:00.000Z", devices: [stored("phone", "drive-token", "drive"), stored("tablet", "watch-token", "watch")] }));
    const store = new DeviceStore(root);
    expect(store.error).toBeNull();
    // nor is it left in the file, for an older version to let in again
    expect(readFileSync(join(root, "devices.json"), "utf8")).not.toContain("tablet");
    expect(store.match("watch-token")).toBeNull();
    expect(store.match("drive-token")).toEqual({ id: "phone", label: "phone" });
    expect(store.list(null).map((d) => d.id)).toEqual(["phone"]);
    // the gate stays closed, though it may have been only a watching device that closed it
    expect(store.gated).toBe(true);
    expect(new DeviceStore(root).match("drive-token")).toEqual({ id: "phone", label: "phone" });
  });

  it("reads an entry without a role as damaged, and writes the role it reads", () => {
    const root = mkdtempSync(join(dir, "roleless-"));
    const contents = JSON.stringify({ gate_closed_at: null, devices: [{ id: "x", label: "x", token_hash: "h", created_at: "2026-10-01T00:00:00.000Z", last_seen_at: null }] });
    writeFileSync(join(root, "devices.json"), contents);
    expect(new DeviceStore(root).error).toContain("Restore a valid devices.json");
    const fresh = mkdtempSync(join(dir, "written-"));
    const store = new DeviceStore(fresh);
    const paired = store.pair(store.startPairing().code, "Phone")!;
    expect(new DeviceStore(fresh).match(paired.token)).toEqual(paired.device);
  });

  it("closes only the revoked device's listeners, including late registrations", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "listeners-")));
    const a = store.pair(store.startPairing().code, "A")!;
    const b = store.pair(store.startPairing().code, "B")!;
    const closed: string[] = [];
    store.onRevoke(a.device.id, () => closed.push("a"));
    store.onRevoke(b.device.id, () => closed.push("b"));
    const unsubscribe = store.onRevoke(a.device.id, () => closed.push("finished"));
    unsubscribe();
    store.revoke(a.device.id);
    store.onRevoke(a.device.id, () => closed.push("late upgrade"));
    expect(closed).toEqual(["a", "late upgrade"]);
    expect(store.match(b.token)).not.toBeNull();
  });

  it("pairs with the code once, keeps only a hash, and finds the device by its token", () => {
    const store = new DeviceStore(dir);
    expect(store.gated).toBe(false);
    const { code } = store.startPairing();
    expect(code).toMatch(/^\d{6}$/);
    expect(store.pair("000000".replace(/./g, (c) => c === code[0] ? "1" : c), "x")).toBeNull(); // a wrong code
    const paired = store.pair(code.slice(0, 3) + " " + code.slice(3), "My phone");
    expect(paired).not.toBeNull();
    expect(store.pair(code, "again")).toBeNull(); // spent
    expect(store.gated).toBe(true);
    const file = readFileSync(join(dir, "devices.json"), "utf8");
    expect(file).not.toContain(paired!.token);
    expect((statSync(join(dir, "devices.json")).mode & 0o777)).toBe(0o600);
    expect(store.match(paired!.token)).toEqual({ id: paired!.device.id, label: "My phone" });
    expect(store.match("not-a-token")).toBeNull();
    // and a second store reading the same file knows the device
    expect(new DeviceStore(dir).match(paired!.token)?.label).toBe("My phone");
  });

  it("expires a code after ten minutes and after five wrong tries", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "s-")));
    const started = Date.now();
    const { code } = store.startPairing(started);
    expect(store.pair(code, "late", started + 10 * 60_000 + 1)).toBeNull();
    const second = store.startPairing().code;
    for (let i = 0; i < 5; i++) expect(store.pair("999999" === second ? "000000" : "999999", "x")).toBeNull();
    expect(store.pair(second, "x")).toBeNull();
  });

  it("renames, revokes, and marks the caller's device", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "r-")));
    const a = store.pair(store.startPairing().code, "A")!;
    const b = store.pair(store.startPairing().code, "B")!;
    expect(store.list(a.device.id).map((d) => [d.label, d.current])).toEqual([["A", true], ["B", false]]);
    expect(store.update(b.device.id, { label: "Bee" })?.label).toBe("Bee");
    expect(store.revoke(a.device.id)).toBe(true);
    expect(store.revoke(a.device.id)).toBe(false);
    expect(store.match(a.token)).toBeNull();
    expect(store.match(b.token)?.label).toBe("Bee");
    // revoking the last device does not reopen the gate, not even after a restart
    expect(store.revoke(b.device.id)).toBe(true);
    expect(store.gated).toBe(true);
    expect(new DeviceStore(join(dir, "r-") === "" ? dir : (store as unknown as { path: string }).path.replace(/\/devices\.json$/, "")).gated).toBe(true);
  });
});

describe("labels and owner", () => {
  it("trims labels and falls back", () => {
    expect(normalizeLabel("  my   phone ", "Device")).toBe("my phone");
    expect(normalizeLabel("", "Device")).toBe("Device");
    expect(normalizeLabel(42, "Device")).toBe("Device");
    expect(normalizeLabel("x".repeat(80), "Device")).toHaveLength(48);
  });

  it("reads the PC's login out of tailscale status", () => {
    const status = JSON.stringify({ Self: { UserID: 42 }, User: { "42": { LoginName: "me@example.com" }, "43": { LoginName: "them@example.com" } } });
    expect(parseTailscaleOwner(status)).toBe("me@example.com");
    expect(parseTailscaleOwner(JSON.stringify({ Self: { UserID: 99 }, User: {} }))).toBeNull();
    // regression: a real id is past 2^53, and as a double it becomes ...136 and names nobody
    expect(parseTailscaleOwner('{"Self":{"UserID":15633668397603135},"User":{"15633668397603135":{"LoginName":"me@example.com"}}}')).toBe("me@example.com");
    expect(parseTailscaleOwner(null)).toBeNull();
    expect(parseTailscaleOwner("nope")).toBeNull();
    expect(isTaggedNode(status)).toBeFalse();
    // a tagged node's user entry is the node itself: no person's login
    const tagged = JSON.stringify({ Self: { UserID: 7, Tags: ["tag:server"] }, User: { "7": { LoginName: "pc.tailnet.ts.net" } } });
    expect(parseTailscaleOwner(tagged)).toBeNull();
    expect(isTaggedNode(tagged)).toBeTrue();
    expect(isTaggedNode(null)).toBeFalse();
  });
});

it("reports failed registry writes without committing a pair, rename or revocation in memory", () => {
  const root = mkdtempSync(join(dir, "write-failure-"));
  const store = new DeviceStore(root);
  const first = store.pair(store.startPairing().code, "Original")!;
  let closed = false;
  store.onRevoke(first.device.id, () => { closed = true; });
  const blocked = join(root, `devices.json.${process.pid}.tmp`);
  mkdirSync(blocked);
  const code = store.startPairing().code;
  expect(() => store.pair(code, "Failed pair")).toThrow();
  expect(() => store.update(first.device.id, { label: "Failed rename" })).toThrow();
  expect(() => store.revoke(first.device.id)).toThrow();
  expect(closed).toBe(false);
  expect(store.list(null).map((d) => d.label)).toEqual(["Original"]);
  expect(store.match(first.token)?.label).toBe("Original");
  expect(new DeviceStore(root).match(first.token)?.label).toBe("Original");
  rmSync(blocked, { recursive: true });
  expect(store.pair(code, "Retry")).not.toBeNull();
  expect(store.revoke(first.device.id)).toBe(true);
  expect(closed).toBe(true);
  expect(new DeviceStore(root).match(first.token)).toBeNull();
});
