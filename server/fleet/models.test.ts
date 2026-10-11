import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "./adapters.ts";
import { listCodexModels, parseAgyModels, parseCodexModels, parseCursorModels, parsePiModels } from "./model-lists.ts";
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

  it("reads one page of codex's model/list and where the next begins", () => {
    expect(parseCodexModels({ data: [{ model: "gpt-6", displayName: "GPT-6" }, { id: "no-model-field" }], nextCursor: "c2" })).toEqual({ models: [{ id: "gpt-6", label: "GPT-6" }], next: "c2" });
    expect(parseCodexModels({ data: [], nextCursor: null })).toEqual({ models: [] });
  });
});

function catalog(source: { complete: boolean; list: () => Promise<Array<{ id: string }>> } | undefined, now = () => 0) {
  return new ModelCatalog({ adapter: () => ({ models: source }) as Pick<AgentAdapter, "models">, now });
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

  it("answers a failed ask with the reason, and asks again next time", async () => {
    let fail = true;
    const models = catalog({ complete: true, list: async () => { if (fail) throw new Error("offline"); return [{ id: "a" }]; } });
    expect(await models.list("codex")).toEqual({ agent: "codex", models: [], complete: false, error: "offline" });
    fail = false;
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
      expect(await listCodexModels(fake)).toEqual([{ id: "gpt-6-sol", label: "GPT-6-Sol" }, { id: "gpt-reserve", label: "GPT-Reserve" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
