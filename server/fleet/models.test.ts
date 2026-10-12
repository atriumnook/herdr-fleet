import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_KINDS, type AgentAdapter } from "./adapters.ts";
import { listAgyModels, listCodexModels, listCursorModels, listOpencodeModels, listPiModels, parseAgyModels, parseCodexModels, parseCursorModels, parseOpencodeModels, parsePiModels } from "./model-lists.ts";
import { modelListed } from "../../shared/fleet.ts";
import { ModelCatalog } from "./models.ts";

describe("model lists, as each CLI prints them", () => {
  it("reads agy's tab-separated lines and skips its progress line", () => {
    expect(parseAgyModels("Fetching available models...\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n\n")).toEqual([{ id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" }]);
  });

  it("reads cursor's `id - name` lines, and drops the zero-width characters its names carry", () => {
    const output = "Available models\n\nauto - Auto (default)\ngrok-4.7-low-fast - Grok 4.7  Low Fast​​\n";
    expect(parseCursorModels(output)).toEqual([{ id: "auto", label: "Auto (default)" }, { id: "grok-4.7-low-fast", label: "Grok 4.7  Low Fast" }]);
  });

  it("reads pi's table as provider/model", () => {
    const output = "provider  model    context  max-out  thinking  images\nopenai    gpt-4.1  1.0M     32.8K    no        yes\n";
    expect(parsePiModels(output)).toEqual([{ id: "openai/gpt-4.1" }]);
  });

  it("reads opencode's provider/model lines, and leaves out what is not one", () => {
    expect(parseOpencodeModels("github-copilot/claude-opus-5.5\nminimax-coding-plan/MiniMax-M2.5\n\nopencode/big-pickle  \nnot a model\nx/y#high\n")).toEqual([
      { id: "github-copilot/claude-opus-5.5" }, { id: "minimax-coding-plan/MiniMax-M2.5" }, { id: "opencode/big-pickle" },
    ]);
  });

  it("reads one page of codex's model/list and where the next begins", () => {
    expect(parseCodexModels({ data: [{ model: "gpt-6", displayName: "GPT-6" }, { id: "no-model-field" }], nextCursor: "c2" })).toEqual({ models: [{ id: "gpt-6", label: "GPT-6" }], next: "c2" });
    expect(parseCodexModels({ data: [], nextCursor: null })).toEqual({ models: [] });
  });
});

function catalog(source: { complete: boolean; list: () => Promise<Array<{ id: string }>> } | undefined, now = () => 0) {
  return new ModelCatalog({ workDir: "/nonexistent", adapter: () => ({ models: source }) as Pick<AgentAdapter, "models">, now });
}

describe("the model catalog", () => {
  it("asks a CLI once and keeps the answer for minutes", async () => {
    let asked = 0;
    let at = 0;
    const models = catalog({ complete: true, list: async () => { asked += 1; return [{ id: "a" }]; } }, () => at);
    await models.list("codex");
    await models.list("codex");
    expect(asked).toBe(1);
    at = 11 * 60_000;
    await models.list("codex");
    expect(asked).toBe(2);
  });

  it("answers a failed ask with the reason, and asks again once the minute is over", async () => {
    let fail = true;
    let at = 0;
    const models = catalog({ complete: true, list: async () => { if (fail) throw new Error("offline"); return [{ id: "a" }]; } }, () => at);
    expect(await models.list("codex")).toEqual({ agent: "codex", models: [], complete: false, error: "offline" });
    fail = false;
    at = 61_000;
    expect(await models.list("codex")).toMatchObject({ models: [{ id: "a" }], complete: true });
  });

  it("refuses a model a complete list lacks, after asking again once", async () => {
    let asked = 0;
    const models = catalog({ complete: true, list: async () => { asked += 1; return [{ id: "gpt-6" }, { id: "gpt-7[effort=high]" }]; } });
    expect(await models.unknown("codex", "gpt-6")).toBeUndefined();
    expect(asked).toBe(1);
    expect(await models.unknown("codex", "gpt-6:high")).toBeUndefined();
    expect(await models.unknown("codex", "gpt-7")).toBeUndefined();
    expect(await models.unknown("codex", "gpt-9")).toBe("codex does not offer a model named gpt-9");
    expect(asked).toBe(2);
  });

  it("refuses nothing when the list is not complete, when there is no model, or when the CLI cannot be asked", async () => {
    expect(await catalog({ complete: false, list: async () => [{ id: "a" }] }).unknown("claude", "claude-opus-9")).toBeUndefined();
    expect(await catalog({ complete: true, list: async () => [{ id: "a" }] }).unknown("codex", undefined)).toBeUndefined();
    expect(await catalog({ complete: true, list: async () => { throw new Error("offline"); } }).unknown("codex", "x")).toBeUndefined();
    expect(await catalog(undefined).unknown("codex", "x")).toBeUndefined();
  });
});

describe("agy's models, listed once per effort", () => {
  // as `agy models` prints them; the adapter passes `--effort` apart from `--model`
  const listing = { agent: "agy" as const, complete: true, models: parseAgyModels("Fetching available models...\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\ngemini-3.1-pro-low\tGemini 3.1 Pro (Low)\nclaude-opus-5-5-medium\tClaude Opus 5.5 (Medium)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n") };

  it("accepts a listed id and the same model without its effort, and nothing else", () => {
    expect(modelListed(listing, "gemini-3.1-pro-high")).toBe(true);
    expect(modelListed(listing, "gemini-3.1-pro")).toBe(true);
    expect(modelListed(listing, "claude-opus-5-5")).toBe(true);
    expect(modelListed(listing, "gemini-3.1-pro-xhigh")).toBe(false);
    expect(modelListed(listing, "gemini-9")).toBe(false);
    // another CLI's names keep their ending
    expect(modelListed({ ...listing, agent: "cursor" }, "gemini-3.1-pro")).toBe(false);
  });
});

describe("opencode's models, run with a #variant", () => {
  const listing = { agent: "opencode" as const, complete: false, models: parseOpencodeModels("github-copilot/claude-opus-5.5\nopencode/big-pickle\n") };

  it("accepts a listed id with or without its variant, and nothing else", () => {
    expect(modelListed(listing, "github-copilot/claude-opus-5.5")).toBe(true);
    expect(modelListed(listing, "github-copilot/claude-opus-5.5#high")).toBe(true);
    expect(modelListed(listing, "github-copilot/claude-opus-5.5#high:low")).toBe(true);
    expect(modelListed(listing, "github-copilot/claude-opus-9#high")).toBe(false);
    // only opencode names a variant that way
    expect(modelListed({ ...listing, agent: "pi" }, "github-copilot/claude-opus-5.5#high")).toBe(false);
  });
});

describe("a CLI that fails or hangs", () => {
  it("is not asked again for a minute, then is", async () => {
    let asked = 0;
    let at = 0;
    const models = catalog({ complete: true, list: async () => { asked += 1; throw new Error("down"); } }, () => at);
    await models.list("codex");
    await models.list("codex");
    await models.listAll();
    expect(asked).toBe(AGENT_KINDS.length /* codex once, and every other kind once: they share the stub */);
    at = 61_000;
    await models.list("codex");
    expect(asked).toBe(AGENT_KINDS.length + 1);
  });

  it("holds a spawn up for no longer than the wait, then lets the model through", async () => {
    const models = new ModelCatalog({ workDir: "/nonexistent", spawnWaitMs: 30, adapter: () => ({ models: { complete: true, list: () => new Promise(() => {}) } }) as Pick<AgentAdapter, "models"> });
    const started = Date.now();
    expect(await models.unknown("codex", "anything")).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("is asked anew by a fresh lookup, not answered by an older one still under way", async () => {
    const answers: Array<(models: Array<{ id: string }>) => void> = [];
    const models = catalog({ complete: true, list: () => new Promise((resolve) => answers.push(resolve)) });
    const older = models.list("codex");
    const fresh = models.list("codex", true);
    expect(answers).toHaveLength(2);
    answers[1]!([{ id: "new" }]);
    expect((await fresh).models).toEqual([{ id: "new" }]);
    answers[0]!([{ id: "old" }]);
    await older;
  });
});

describe("codex app-server's model/list", () => {
  // recorded from `codex app-server`: a notification before the answers, a request of the server's own with no result, two pages
  const script = `#!/usr/bin/env bun
const out = (m) => console.log(JSON.stringify({ jsonrpc: "2.0", ...m }));
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let n;
  while ((n = buffer.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buffer.slice(0, n));
    buffer = buffer.slice(n + 1);
    if (m.method === "initialize") { out({ method: "remoteControl/status/changed", params: { status: "disabled" } }); out({ id: m.id, result: { userAgent: "codex" } }); }
    else if (m.method === "model/list") {
      out({ id: 3, method: "item/tool/requestUserInput", params: {} });
      if (m.params.cursor === "p2") out({ id: m.id, result: { data: [{ id: "gpt-reserve", model: "gpt-reserve", displayName: "GPT-Reserve", hidden: true }], nextCursor: null } });
      else out({ id: m.id, result: { data: [{ id: "gpt-6-sol", model: "gpt-6-sol", displayName: "GPT-6-Sol", hidden: false }], nextCursor: "p2" } });
    }
  }
}
`;

  it("reads every page, skipping what is not an answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-codex-fake-"));
    try {
      const fake = join(dir, "codex");
      writeFileSync(fake, script);
      chmodSync(fake, 0o755);
      expect(await listCodexModels({ workDir: join(dir, "work"), command: fake })).toEqual([{ id: "gpt-6-sol", label: "GPT-6-Sol" }, { id: "gpt-reserve", label: "GPT-Reserve" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("what a model listing's CLI gets", () => {
  // the server's environment as a listing sees it: API keys and the person's herdr session among the rest
  const SERVER_ENV = {
    PATH: process.env["PATH"], HOME: "/home/u", LANG: "ja_JP.UTF-8", CODEX_HOME: "/home/u/.codex-alt", PI_CODING_AGENT_DIR: "/home/u/.pi-alt", CLAUDE_CONFIG_DIR: "/home/u/.claude-alt",
    ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-openai", GEMINI_API_KEY: "g-key", CURSOR_API_KEY: "c-key", HERDR_SOCKET: "/run/herdr.sock", HERDR_FLEET_TOKEN: "t",
  };
  const FORBIDDEN = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "CURSOR_API_KEY", "HERDR_SOCKET", "HERDR_FLEET_TOKEN"];
  const dirs: string[] = [];
  const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "fleet-model-lists-")); dirs.push(dir); return dir; };
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  /** a CLI that notes its environment, its folder and what it found there, then answers */
  const recorder = (dir: string, name: string, answer: string) => {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n/usr/bin/env > "${file}.env"\npwd > "${file}.cwd"\nls -A > "${file}.ls"\n${answer}\n`, { mode: 0o755 });
    return file;
  };
  const envNames = (file: string) => readFileSync(`${file}.env`, "utf8").split("\n").filter(Boolean).map((line) => line.split("=")[0]!);
  /** what another run, or another user, could leave in the folder for the next CLI to read */
  const plant = (workDir: string) => {
    mkdirSync(join(workDir, ".claude"), { recursive: true });
    writeFileSync(join(workDir, ".claude", "settings.json"), '{"hooks":{}}');
    writeFileSync(join(workDir, "CLAUDE.md"), "planted");
  };
  const expectOwnEmptyFolder = (file: string, workDir: string) => {
    expect(readFileSync(`${file}.cwd`, "utf8").trim()).toBe(realpathSync(workDir));
    expect(readFileSync(`${file}.ls`, "utf8")).toBe("");
    expect(statSync(workDir).mode & 0o777).toBe(0o700);
  };
  const noSecrets = (file: string) => { for (const name of FORBIDDEN) expect(envNames(file)).not.toContain(name); };

  it("agy lists in its own emptied folder, without an API key or herdr session, and with its self-update held off", async () => {
    const dir = tempDir();
    const workDir = join(dir, "model-list", "agy");
    plant(workDir);
    const agy = recorder(dir, "agy", "echo 'gemini-3.1-pro-high\tGemini 3.1 Pro (High)'");
    expect(await listAgyModels({ workDir, command: agy, env: SERVER_ENV })).toEqual([{ id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" }]);
    expectOwnEmptyFolder(agy, workDir);
    noSecrets(agy);
    expect(readFileSync(`${agy}.env`, "utf8")).toContain("AGY_CLI_DISABLE_AUTO_UPDATE=true\n");
  });

  it("cursor lists in its own emptied folder, without an API key or herdr session", async () => {
    const dir = tempDir();
    const workDir = join(dir, "model-list", "cursor");
    plant(workDir);
    const cursor = recorder(dir, "cursor-agent", "echo 'auto - Auto (default)'");
    expect(await listCursorModels({ workDir, command: cursor, env: SERVER_ENV })).toEqual([{ id: "auto", label: "Auto (default)" }]);
    expectOwnEmptyFolder(cursor, workDir);
    noSecrets(cursor);
    expect(envNames(cursor)).toEqual(expect.arrayContaining(["PATH", "HOME", "LANG"]));
  });

  it("pi lists in its own emptied folder, with its own folder's setting and no API key or herdr session", async () => {
    const dir = tempDir();
    const workDir = join(dir, "model-list", "pi");
    plant(workDir);
    const pi = recorder(dir, "pi", "printf 'provider model\\nopenai gpt-4.1\\n'");
    expect(await listPiModels({ workDir, command: pi, env: SERVER_ENV })).toEqual([{ id: "openai/gpt-4.1" }]);
    expectOwnEmptyFolder(pi, workDir);
    noSecrets(pi);
    expect(envNames(pi)).toContain("PI_CODING_AGENT_DIR");
    expect(envNames(pi)).not.toContain("CODEX_HOME");
  });

  it("opencode lists with its own private server, never the person's shared service, in its own emptied folder and with its self-update held off", async () => {
    const dir = tempDir();
    const workDir = join(dir, "model-list", "opencode");
    plant(workDir);
    const opencode = recorder(dir, "opencode", "printf '%s\\n' \"$*\" > \"$0.args\"\nprintf 'anthropic/claude-sonnet-5-5\\nopencode/big-pickle\\n'");
    expect(await listOpencodeModels({ workDir, command: opencode, env: SERVER_ENV })).toEqual([{ id: "anthropic/claude-sonnet-5-5" }, { id: "opencode/big-pickle" }]);
    expect(readFileSync(`${opencode}.args`, "utf8")).toBe("models --standalone\n");
    expectOwnEmptyFolder(opencode, workDir);
    noSecrets(opencode);
    expect(readFileSync(`${opencode}.env`, "utf8")).toContain("OPENCODE_DISABLE_AUTOUPDATE=true\n");
  });

  it("opencode 1.x answers `models --standalone` with its help and a failure: no list, and no TUI started", async () => {
    const dir = tempDir();
    const workDir = join(dir, "model-list", "opencode");
    const old = recorder(dir, "opencode", "printf 'opencode models [provider]\\n\\nlist all available models\\n'\nexit 1");
    await expect(listOpencodeModels({ workDir, command: old, env: SERVER_ENV })).rejects.toThrow("opencode models failed");
    expectOwnEmptyFolder(old, workDir);
  });

  it("codex app-server runs in its own emptied folder, with CODEX_HOME and no API key or herdr session", async () => {
    const dir = tempDir();
    const workDir = join(dir, "model-list", "codex");
    plant(workDir);
    const result = { data: [{ id: "gpt-6", model: "gpt-6", displayName: "GPT-6" }], nextCursor: null };
    const codex = recorder(dir, "codex", `read a\necho '{"id":1,"result":{}}'\nread b\nread c\necho '${JSON.stringify({ id: 2, result })}'`);
    expect(await listCodexModels({ workDir, command: codex, env: SERVER_ENV })).toEqual([{ id: "gpt-6", label: "GPT-6" }]);
    expectOwnEmptyFolder(codex, workDir);
    noSecrets(codex);
    expect(envNames(codex)).toContain("CODEX_HOME");
  });

  it("refuses a link in place of the folder", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "elsewhere"));
    symlinkSync(join(dir, "elsewhere"), join(dir, "agy"));
    const agy = recorder(dir, "agy-cli", "echo x");
    await expect(listAgyModels({ workDir: join(dir, "agy"), command: agy, env: SERVER_ENV })).rejects.toThrow("is not a folder");
  });
});
