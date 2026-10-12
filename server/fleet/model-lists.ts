/**
 * Each agent CLI's own list of the models it offers. Every command here answers from the CLI's
 * catalog or its account, none calls a model: `codex app-server` `model/list`, `agy models`,
 * `cursor-agent models`, `pi --list-models`, `opencode serve` of its own. Claude Code has no such command, so its aliases are
 * the list (`claude --help` names them).
 */

import type { ModelListing } from "../../shared/fleet.ts";
import { childEnv, emptyWorkDir } from "../cli-child.ts";

export type ModelEntry = ModelListing["models"][number];

const TIMEOUT_MS = 20_000;

/**
 * Where a listing runs and what it starts: the CLI's own folder, emptied before each run, and only
 * the environment it needs (cli-child), as for a usage probe. An API key there would make the CLI
 * list another account's models.
 */
export interface ListOptions {
  workDir: string;
  command?: string;
  /** the server's environment; process.env when left out */
  env?: Record<string, string | undefined>;
}

async function run(argv: string[], options: ListOptions, env: Record<string, string>): Promise<string> {
  emptyWorkDir(options.workDir);
  const child = Bun.spawn(argv, { cwd: options.workDir, stdin: "ignore", stdout: "pipe", stderr: "ignore", env });
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
  try {
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) throw new Error(`${argv[0]} ${argv[1] ?? ""} failed`.trim());
    return output;
  } finally {
    clearTimeout(timer);
  }
}

/** What `claude --model` takes by name (see `claude --help`); full model names work too. */
export const CLAUDE_ALIASES: ModelEntry[] = ["fable", "opus", "sonnet", "haiku"].map((id) => ({ id }));

const invisible = /[​-‏⁠﻿]/g;

/** `agy models`: `<id>\t<name>` per line after a progress line. */
export function parseAgyModels(output: string): ModelEntry[] {
  return output.split("\n").flatMap((line) => {
    const [id, label] = line.replace(invisible, "").split("\t");
    return id && label && /^[\w.-]+$/.test(id) ? [{ id, label: label.trim() }] : [];
  });
}

/** Auto-update is held off (`true`, not `1`), as for agy's usage probe. */
export const listAgyModels = async (options: ListOptions): Promise<ModelEntry[]> =>
  parseAgyModels(await run([options.command ?? "agy", "models"], options, { ...childEnv(options.env ?? process.env), AGY_CLI_DISABLE_AUTO_UPDATE: "true" }));

/** `cursor-agent models`: `<id> - <name>` per line under a heading. */
export function parseCursorModels(output: string): ModelEntry[] {
  return output.split("\n").flatMap((line) => {
    const match = /^([\w.[\]=,-]+) - (.+)$/.exec(line.replace(invisible, "").trim());
    return match ? [{ id: match[1]!, label: match[2]!.trim() }] : [];
  });
}

export const listCursorModels = async (options: ListOptions): Promise<ModelEntry[]> =>
  parseCursorModels(await run([options.command ?? "cursor-agent", "models"], options, childEnv(options.env ?? process.env)));

/**
 * `pi --list-models`: a table of `provider model ...`. pi takes `provider/model` and also patterns
 * (`sonnet:high`), so this is a list of names it accepts, not all of them.
 */
export function parsePiModels(output: string): ModelEntry[] {
  return output.split("\n").slice(1).flatMap((line) => {
    const [provider, model] = line.trim().split(/\s+/);
    return provider && model ? [{ id: `${provider}/${model}` }] : [];
  });
}

/** pi keeps its sign-in under PI_CODING_AGENT_DIR, which passes when set. */
export const listPiModels = async (options: ListOptions): Promise<ModelEntry[]> =>
  parsePiModels(await run([options.command ?? "pi", "--list-models"], options, childEnv(options.env ?? process.env, ["PI_CODING_AGENT_DIR"])));

/**
 * OpenCode 2's `GET /api/model`: the models of the providers that are signed in, `provider/model` each
 * (a `#variant` after a model name runs it and is not listed here). Not a complete list: it is what the
 * server has loaded when it is asked, and the TUI accepts any `provider/model` text (an unknown one fails at the first prompt).
 */
export function parseOpencodeModels(body: unknown): ModelEntry[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((model: { providerID?: unknown; id?: unknown }) =>
    typeof model?.providerID === "string" && typeof model.id === "string" && /^[^\s/#]+$/.test(model.providerID) && /^\S+$/.test(model.id) && !model.id.includes("#") ? [{ id: `${model.providerID}/${model.id}` }] : []);
}

/**
 * Asks a private `opencode serve` of its own, not the person's shared background service (which any command
 * without --standalone would start). `opencode models --standalone` asks once, and a server that has just
 * started answers `[]` until its providers have loaded (seen on 2.0.26), so this polls (the free models of the OpenCode provider show up too, after a second).
 * A 1.x opencode is refused by its version first: its `serve` would answer in another shape.
 */
export async function listOpencodeModels(options: ListOptions): Promise<ModelEntry[]> {
  emptyWorkDir(options.workDir);
  const command = options.command ?? "opencode";
  const env = { ...childEnv(options.env ?? process.env), OPENCODE_DISABLE_AUTOUPDATE: "true" };
  const version = Bun.spawnSync([command, "--version"], { cwd: options.workDir, env, stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 10_000 });
  if (!/(?:^|\s)v?2\.\d+\.\d+/.test(version.stdout.toString())) throw new Error(`${command} is not OpenCode 2`);
  const child = Bun.spawn([command, "serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: options.workDir, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
  try {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    let found: RegExpExecArray | null = null;
    while (!found) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`${command} serve quit before it listened`);
      seen += decoder.decode(value, { stream: true });
      found = /server listening on (http:\/\/127\.0\.0\.1:\d+)\s+server password (\S+)/.exec(seen);
    }
    const [, url, password] = found as unknown as [string, string, string];
    const headers = { authorization: `Basic ${btoa(`opencode:${password}`)}` };
    let models: ModelEntry[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await fetch(`${url}/api/model?location%5Bdirectory%5D=${encodeURIComponent(options.workDir)}`, { headers });
      if (!response.ok) throw new Error(`${command} serve answered ${response.status}`);
      const asked = parseOpencodeModels(await response.json());
      // providers load one after another: the list is taken once two answers in a row agree
      if (asked.length > 0 && asked.length === models.length) return asked;
      models = asked;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return models;
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

/** codex's `model/list` result: the models of one page, and where the next begins. */
export function parseCodexModels(result: unknown): { models: ModelEntry[]; next?: string } {
  const page = result as { data?: Array<{ model?: unknown; displayName?: unknown }>; nextCursor?: unknown } | null;
  const models = (page?.data ?? []).flatMap((each) => (typeof each.model === "string" && each.model ? [{ id: each.model, ...(typeof each.displayName === "string" && each.displayName ? { label: each.displayName } : {}) }] : []));
  return { models, ...(typeof page?.nextCursor === "string" && page.nextCursor ? { next: page.nextCursor } : {}) };
}

/**
 * `codex app-server` over stdio: initialize, then `model/list` page by page (hidden models too:
 * they run). A model's `model` is its slug, what `--model` takes; `id` is the same and `displayName` is its label.
 */
export async function listCodexModels(options: ListOptions): Promise<ModelEntry[]> {
  emptyWorkDir(options.workDir);
  // codex keeps its sign-in under CODEX_HOME, which passes when set
  const env = childEnv(options.env ?? process.env, ["CODEX_HOME"]);
  const child = Bun.spawn([options.command ?? "codex", "app-server"], { cwd: options.workDir, env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
  try {
    const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "herdr-fleet", version: "0" } } });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    const models: ModelEntry[] = [];
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("codex app-server closed before it answered");
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: { id?: number; method?: string; result?: unknown; error?: { message?: string } };
        try { message = JSON.parse(line); } catch { continue; }
        // a notification or a request of the server's own is not an answer to ours
        if (message.method !== undefined || (message.result === undefined && message.error === undefined)) continue;
        if (message.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "model/list", params: { includeHidden: true } });
        } else if (message.id !== undefined && message.id >= 2) {
          if (message.error) throw new Error(`codex: ${message.error.message ?? "models unavailable"}`);
          const page = parseCodexModels(message.result);
          models.push(...page.models);
          if (!page.next || message.id > 50) return models;
          send({ id: message.id + 1, method: "model/list", params: { includeHidden: true, cursor: page.next } });
        }
      }
    }
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}
