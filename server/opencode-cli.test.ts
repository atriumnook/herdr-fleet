import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationUnavailable } from "./conversation-errors.ts";
import { OpencodeHttpError, opencodeCli, type OpencodeCliOptions } from "./opencode-cli.ts";
import { OpencodeConversations } from "./opencode-session.ts";

const SID = "ses_testsession0001";

/** The real CLI path, with a stand-in `opencode` that records what it was asked and answers from files. */
describe("the CLI", () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-cli-"));
  const log = join(root, "log");
  const state = join(root, "state");
  const bin = join(root, "bin");
  const fake = join(bin, "opencode");

  beforeAll(() => {
    writeFileSync(state, "running");
    writeFileSync(join(root, "attempts"), "0");
    writeFileSync(join(root, "big.json"), JSON.stringify({ data: [{ id: "msg_big", type: "user", text: "x".repeat(400_000) }] }));
    writeFileSync(join(root, "ok.json"), JSON.stringify({ data: { id: SID } }));
    writeFileSync(join(root, "cut.json"), '{"data":{"id":"ses_te');
    // stands in for opencode: `service status` answers from the state file, `api GET <path>` from a file named by the path
    const script = `#!/bin/sh
echo "$@ | cwd=$(pwd) | env=$(env | grep -c '^HERDR\\|API_KEY\\|OPENCODE_PASSWORD') auto=$OPENCODE_DISABLE_AUTOUPDATE" >> ${JSON.stringify(log)}
if [ "$1" = service ] && [ "$2" = status ]; then
  if [ "$(cat ${JSON.stringify(state)})" = running ]; then echo http://127.0.0.1:1; else echo stopped; fi
  exit 0
fi
if [ "$1" = api ]; then
  case "$3" in
    */big) cat ${JSON.stringify(join(root, "big.json"))};;
    */cut) n=$(cat ${JSON.stringify(join(root, "attempts"))}); echo $((n+1)) > ${JSON.stringify(join(root, "attempts"))}
           if [ "$n" -lt 1 ]; then cat ${JSON.stringify(join(root, "cut.json"))}; else cat ${JSON.stringify(join(root, "ok.json"))}; fi;;
    */oldcli) echo "must never be asked" >> ${JSON.stringify(join(root, "oldcli"))};;
    */hang) trap '' TERM; sleep 5; cat ${JSON.stringify(join(root, "ok.json"))};;
    */fail) echo "boom: \\"quoted\\" detail" >&2; exit 3;;
    */huge) head -c 5000 /dev/zero | tr '\\0' a;;
    */slow) echo start >> ${JSON.stringify(join(root, "overlap"))}; sleep 0.3; echo end >> ${JSON.stringify(join(root, "overlap"))}; cat ${JSON.stringify(join(root, "ok.json"))};;
    */alwayscut) cat ${JSON.stringify(join(root, "cut.json"))};;
    */missing) echo '{"_tag":"SessionNotFoundError","message":"x"}'; echo "HTTP 404 Not Found" >&2; exit 1;;
    *) cat ${JSON.stringify(join(root, "ok.json"))};;
  esac
  exit 0
fi
exit 2
`;
    mkdirSync(bin);
    writeFileSync(fake, script);
    chmodSync(fake, 0o755);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const cli = (extra: Record<string, string> = {}, options: Partial<OpencodeCliOptions> = {}) => opencodeCli({ workDir: join(root, "work"), command: fake, env: { PATH: process.env["PATH"], HOME: root, HERDR_PANE_ID: "p", OPENAI_API_KEY: "sk", OPENCODE_PASSWORD: "pw", ...extra }, ...options });
  const calls = (): string[] => readFileSync(log, "utf8").trim().split("\n");

  test("a reply of hundreds of kilobytes arrives whole at the reading end (the writer's own cut is not reproducible here)", async () => {
    const body = await cli().get("/api/session/big") as { data: { text: string }[] };
    expect(body.data[0]!.text).toHaveLength(400_000);
  });

  test("a reply cut short (a file standing in for the cut) is read again; one that stays cut is a failed read, not a crash", async () => {
    expect(await cli().get("/api/session/cut")).toEqual({ data: { id: SID } });
    await expect(cli().get("/api/session/alwayscut")).rejects.toThrow("no JSON");
  });

  test("a CLI that ignores SIGTERM is killed, and the read ends with a timeout that is not tried again", async () => {
    const before = calls().filter((line) => line.includes("/api/session/hang")).length;
    const started = Date.now();
    await expect(cli({}, { timeoutMs: 300, killGraceMs: 200 }).get("/api/session/hang")).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(calls().filter((line) => line.includes("/api/session/hang")).length - before).toBe(1);
  });

  test("an error exit with nothing to read is not tried again, and keeps what the CLI said", async () => {
    const before = calls().filter((line) => line.includes("/api/session/fail")).length;
    const error = (await cli().get("/api/session/fail").catch((reason: unknown) => reason)) as Error;
    expect(error.message).toContain("exit 3");
    expect(error.message).toContain('boom: "quoted" detail');
    expect(calls().filter((line) => line.includes("/api/session/fail")).length - before).toBe(1);
  });

  test("a reply past the limit is dropped, not held", async () => {
    await expect(cli({}, { maxReplyBytes: 1000 }).get("/api/session/huge")).rejects.toThrow("more than 1000 bytes");
  });

  test("no more CLIs run at once than allowed, however many ask", async () => {
    rmSync(join(root, "overlap"), { force: true });
    const api = cli({}, { maxChildren: 2 });
    await Promise.all(Array.from({ length: 6 }, () => api.get("/api/session/slow")));
    let open = 0;
    let most = 0;
    for (const line of readFileSync(join(root, "overlap"), "utf8").trim().split("\n")) { open += line === "start" ? 1 : -1; most = Math.max(most, open); }
    expect(most).toBe(2);
  });

  test("panels asking whether the service runs share one question", async () => {
    const before = calls().filter((line) => line.startsWith("service status")).length;
    const api = cli();
    await Promise.all([api.serviceRunning(), api.serviceRunning(), api.serviceRunning()]);
    expect(calls().filter((line) => line.startsWith("service status")).length - before).toBe(1);
  });

  test("an HTTP error carries its status and tag", async () => {
    const error = await cli().get("/api/session/missing").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect(error).toMatchObject({ status: 404, tag: "SessionNotFoundError" });
  });

  test("it runs in a folder of its own, with only the environment it needs", async () => {
    await cli().get("/api/session/ok");
    const last = calls().at(-1)!;
    expect(last).toContain(`cwd=${join(root, "work")}`);
    expect(last).toEndWith("env=0 auto=true");
  });

  test("an OpenCode without `service` and `api` (1.x) leaves the pane on its scrollback and is asked nothing more", async () => {
    // what 1.19 does with `opencode service status`: its help on stderr, nothing on stdout, exit 1
    const old = join(root, "old-bin");
    mkdirSync(old);
    writeFileSync(join(old, "opencode"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(root, "old-log"))}\necho "Commands: opencode [project]" >&2\nexit 1\n`);
    chmodSync(join(old, "opencode"), 0o755);
    const reader = new OpencodeConversations(opencodeCli({ workDir: join(root, "work"), command: join(old, "opencode"), env: { PATH: process.env["PATH"], HOME: root } }));
    await expect(reader.page(SID, false)).rejects.toBeInstanceOf(ConversationUnavailable);
    expect(readFileSync(join(root, "old-log"), "utf8").trim().split("\n")).toEqual(["service status"]);
  });

  test("whether the service runs is asked, not assumed, and a stopped one is never asked anything else", async () => {
    const api = cli();
    expect(await api.serviceRunning()).toBe(true);
    writeFileSync(state, "stopped");
    const fresh = cli();
    expect(await fresh.serviceRunning()).toBe(false);
    const reader = new OpencodeConversations(fresh);
    const before = calls().length;
    await expect(reader.page(SID, false)).rejects.toBeInstanceOf(ConversationUnavailable);
    expect(calls().slice(before).every((line) => line.startsWith("service status"))).toBe(true);
    writeFileSync(state, "running");
  });
});
