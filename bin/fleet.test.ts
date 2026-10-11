import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "fleet.ts");

/** A stand-in fleet server: answers /projects with a coordinator run and keeps what it was sent. */
const received: Array<{ path: string; body: Record<string, unknown> }> = [];
const server = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(request) {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    received.push({ path: new URL(request.url).pathname, body });
    return Response.json({ run: { id: "r1", name: "repo · fleet", role: "coordinator", agent: "claude", group: "g1", paneId: "w9:p1", state: "working" } }, { status: 201 });
  },
});
afterAll(() => server.stop(true));

/** The CLI run as a pane's agent would run it: none of this shell's HERDR_* variables, only `env`. */
async function fleet(args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR")));
  const child = Bun.spawn([process.execPath, CLI, ...args], { env: { ...clean, HERDR_FLEET_URL: `http://127.0.0.1:${server.port}`, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

describe("fleet project from a pane's conversation", () => {
  it("names the pane it was sent from", async () => {
    received.length = 0;
    const { code } = await fleet(["project", "--cwd", "/repo", "--task", "Fix the doubled login error."], { HERDR_PANE_ID: "w2:p3" });
    expect(code).toBe(0);
    expect(received).toEqual([{ path: "/api/fleet/projects", body: { task: "Fix the doubled login error.", cwd: "/repo", from_pane: "w2:p3" } }]);
  });

  it("is refused to the fleet's own agents, which report to whoever started them", async () => {
    received.length = 0;
    const { code, err } = await fleet(["project", "--task", "t"], { HERDR_PANE_ID: "w2:p4", HERDR_FLEET_RUN: "r7" });
    expect(code).toBe(2);
    expect(err).toContain("the fleet's own agents do not call the coordinator");
    expect(received).toEqual([]);
  });

  it("guide tells the agent to hand the work on in a request that stands alone, and not to wait", async () => {
    const { code, out } = await fleet(["guide"], {});
    expect(code).toBe(0);
    expect(out).toContain("fleet project --cwd <the repository> --task");
    expect(out).toContain("stands alone");
    expect(out).toContain("Do not wait for it");
    expect(out).toContain("fleet threads --cwd <the repository>");
  });
});
