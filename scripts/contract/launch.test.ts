import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { candidatePorts, contractTarget, launchServer, serverEnvironment, serverTestOptions } from "./launch.ts";

/** Unit tests: every server started here gets a socket where no herdr answers. */
const NO_HERDR = "/nonexistent/herdr.sock";
const given = { socket: "/run/test-herdr.sock", stateDir: "/tmp/herdr-fleet-contract-x" };

describe("the child's environment", () => {
  const source = {
    PATH: "/usr/bin", HOME: "/home/t", USER: "t", LANG: "C.UTF-8", LC_TIME: "ja_JP.UTF-8", XDG_CONFIG_HOME: "/home/t/.config",
    HTTPS_PROXY: "http://proxy:3128", SSL_CERT_FILE: "/etc/ssl/cert.pem",
    HERDR_FLEET_HERDR_BIN: "/opt/herdr", HERDR_SOCKET: "/home/t/.config/herdr/herdr.sock", HERDR_FLEET_TOKEN: "person", HERDR_PANE_ID: "p1",
    HERDR_FLEET_STATE_DIR: "/home/t/.config/herdr-fleet", PORT: "7317",
    ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", GEMINI_API_KEY: "g", EDITOR: "vi",
  };

  it("keeps only what a CLI child keeps and HERDR_FLEET_HERDR_BIN, then adds the test session's socket and a state folder of its own", () => {
    expect(serverEnvironment(source, {}, given)).toEqual({
      PATH: "/usr/bin", HOME: "/home/t", USER: "t", LANG: "C.UTF-8", LC_TIME: "ja_JP.UTF-8", XDG_CONFIG_HOME: "/home/t/.config",
      HTTPS_PROXY: "http://proxy:3128", SSL_CERT_FILE: "/etc/ssl/cert.pem",
      HERDR_FLEET_HERDR_BIN: "/opt/herdr",
      HERDR_SOCKET: "/run/test-herdr.sock", HERDR_FLEET_STATE_DIR: "/tmp/herdr-fleet-contract-x",
    });
  });

  it("puts the test's env on top, its own socket and state folder included", () => {
    const env = serverEnvironment(source, { HERDR_SOCKET: "/tmp/proxy.sock", HERDR_FLEET_STATE_DIR: "/tmp/mine", HOME: "/tmp/home", HERDR_FLEET_TOKEN: "t" }, given);
    expect(env).toMatchObject({ HERDR_SOCKET: "/tmp/proxy.sock", HERDR_FLEET_STATE_DIR: "/tmp/mine", HOME: "/tmp/home", HERDR_FLEET_TOKEN: "t" });
  });

  it("refuses a name the server does not read, PORT and API keys included, naming it", () => {
    for (const name of ["PORT", "ANTHROPIC_API_KEY", "HERDR_PANE_ID", "EDITOR"]) {
      expect(() => serverEnvironment(source, { [name]: "x" }, given)).toThrow(name);
    }
  });

  it("refuses the fleet's own state folder, and an empty one the server would fall back from to it", () => {
    expect(() => serverEnvironment(source, { HERDR_FLEET_STATE_DIR: "" }, given)).toThrow("HERDR_FLEET_STATE_DIR");
    expect(() => serverEnvironment(source, { HERDR_FLEET_STATE_DIR: "/home/t/.config/herdr-fleet/" }, given)).toThrow("fleet's own state folder");
    expect(() => serverEnvironment({ HOME: "/home/t" }, { HERDR_FLEET_STATE_DIR: "/home/t/.config/herdr-fleet" }, given)).toThrow("fleet's own state folder");
  });
});

describe("the test options", () => {
  it("default the Tailscale owner to none, so this PC's Tailscale never shows", () => {
    expect(serverTestOptions({ machines: false }, {})).toEqual({ machines: false, tailscaleOwner: null });
    expect(serverTestOptions({ tailscaleOwner: "me@example.com" }, {})).toEqual({ tailscaleOwner: "me@example.com" });
    expect(serverTestOptions({}, { HERDR_FLEET_TAILSCALE_OWNER: "me@example.com" })).toEqual({});
  });

  it("refuse the owner in both places", () => {
    expect(() => serverTestOptions({ tailscaleOwner: null }, { HERDR_FLEET_TAILSCALE_OWNER: "me@example.com" })).toThrow("not both");
  });

  it("refuse an option outside the table, or of another type, naming it", () => {
    expect(() => serverTestOptions({ pushEndpoint: true } as never, {})).toThrow("pushEndpoint");
    expect(() => serverTestOptions({ alertTiming: { soon: 1 } } as never, {})).toThrow("alertTiming.soon");
    expect(() => serverTestOptions({ machines: "no" } as never, {})).toThrow("machines");
    expect(() => serverTestOptions({ submitDeadlineMs: -1 }, {})).toThrow("submitDeadlineMs");
  });
});

describe("the target", () => {
  it("is ts unless HERDR_FLEET_CONTRACT_TARGET names a Rust executable", () => {
    expect(contractTarget(undefined)).toEqual({ kind: "ts" });
    expect(contractTarget("ts")).toEqual({ kind: "ts" });
    expect(contractTarget("rust:/opt/contract-server")).toEqual({ kind: "rust", path: "/opt/contract-server" });
    expect(() => contractTarget("url:http://127.0.0.1:7317")).toThrow("url:http://127.0.0.1:7317");
    expect(() => contractTarget("rust:")).toThrow("rust:");
  });

  it("fails naming the target when its executable is missing", async () => {
    await expect(launchServer({}, { target: { kind: "rust", path: "/nonexistent" } })).rejects.toThrow(/rust:\/nonexistent.*not found/);
  });
});

describe("launchServer", () => {
  it("refuses a spec outside the ADR before it starts anything", async () => {
    await expect(launchServer({ env: { PORT: "7317" } as never })).rejects.toThrow("PORT");
    await expect(launchServer({ test: { fleet: {} } as never })).rejects.toThrow("fleet");
  });

  it("starts the TypeScript server on 7400-7499 and stops it with SIGTERM, which it answers after its 2s grace", async () => {
    const server = await launchServer({ env: { HERDR_SOCKET: NO_HERDR, HERDR_FLEET_TOKEN: "test-launch" }, test: { machines: false } });
    const port = Number(new URL(server.url).port);
    expect(new URL(server.url).hostname).toBe("127.0.0.1");
    expect(port).toBeGreaterThanOrEqual(7400);
    expect(port).toBeLessThanOrEqual(7499);
    // the token the test gave is the one the server holds
    expect((await fetch(`${server.url}/api/devices`)).status).toBe(401);
    expect((await fetch(`${server.url}/api/devices`, { headers: { authorization: "Bearer test-launch" } })).status).toBe(200);
    const stopping = Date.now();
    await server.stop();
    expect(Date.now() - stopping).toBeGreaterThanOrEqual(1900);
    await expect(fetch(`${server.url}/api/devices`)).rejects.toThrow();
  }, 15_000);

  it("starts again on another port when the one it tried is taken", async () => {
    const free = candidatePorts();
    const taken = free.next().value!;
    const holder = Bun.listen({ hostname: "127.0.0.1", port: taken, socket: { data() {} } });
    try {
      const server = await launchServer({ env: { HERDR_SOCKET: NO_HERDR }, test: { machines: false } }, { ports: [taken, ...free] });
      try {
        expect(Number(new URL(server.url).port)).not.toBe(taken);
        expect((await fetch(`${server.url}/api/health?scope=bridge`)).status).toBe(200);
      } finally {
        await server.stop();
      }
    } finally {
      holder.stop(true);
    }
  }, 15_000);
});

describe("the TypeScript test entry point", () => {
  const entry = join(import.meta.dir, "server.ts");
  const run = async (input: string) => {
    const child = Bun.spawn([process.execPath, entry], {
      env: { PATH: process.env["PATH"] ?? "", HERDR_SOCKET: NO_HERDR, PORT: "7400", HERDR_FLEET_STATE_DIR: "/nonexistent/state" },
      stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe",
    });
    return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
  };

  it("names an option outside the table on standard error and exits with 2, before it listens", async () => {
    const unknown = await run(JSON.stringify({ pushEndpoint: "loopback" }));
    expect(unknown).toMatchObject({ code: 2, stdout: "" });
    expect(unknown.stderr).toContain("pushEndpoint");
    const wrongType = await run(JSON.stringify({ localPty: "no" }));
    expect(wrongType.code).toBe(2);
    expect(wrongType.stderr).toContain("localPty");
  });
});
