import { HerdrError, herdrRpc } from "../herdr/client.ts";
import type { AgentKind, AgentState } from "./types.ts";

export interface RuntimeLocation { paneId: string; workspaceId?: string; cwd: string }

export interface CreateLocationOptions {
  cwd: string;
  label: string;
  worktree: boolean;
  branch?: string;
  direction?: "right" | "down";
  /** the caller's pane: the agent's pane opens beside it; without one, in a workspace of its own */
  callerPaneId?: string;
  env: Record<string, string>;
}

export interface AgentMetadata { paneId: string; title: string; displayAgent: string; tokens: Record<string, string> }

export interface StartOptions {
  kind: AgentKind;
  name: string;
  paneId: string;
  args: string[];
  /** a line the agent CLI prints when it gives up at startup (an unknown model): its message, or undefined */
  startupError: (screen: string) => string | undefined;
  signal?: AbortSignal;
}

/** What the orchestrator asks of herdr. Tests stand in a fake. */
export interface AgentRuntime {
  createLocation(options: CreateLocationOptions, signal?: AbortSignal): Promise<RuntimeLocation>;
  /** starts the agent and resolves once it takes input (idle) or stops at a question first (blocked) */
  start(options: StartOptions): Promise<AgentState>;
  closePane(paneId: string): Promise<void>;
  prompt(name: string, text: string, signal?: AbortSignal): Promise<AgentState>;
  get(name: string): Promise<AgentState>;
  read(name: string, lines: number): Promise<string>;
  interrupt(name: string): Promise<void>;
  focus(name: string): Promise<void>;
  reportMetadata(metadata: AgentMetadata): Promise<void>;
}

/** The agent CLI quit while it started, with this message (FleetError code agent_start_failed). */
export class FleetError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "FleetError"; }
}

export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(abortError(signal)); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** herdr's status words, as the fleet keeps them; anything else is unknown. */
export function toAgentState(status: unknown): AgentState {
  return status === "working" || status === "idle" || status === "done" || status === "blocked" ? status : "unknown";
}

interface AgentInfo { agent_status?: string; interactive_ready?: boolean; launch_pending?: boolean; agent?: string | null }
interface PaneInfo { pane_id: string; workspace_id?: string; agent?: string | null }

const START_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
const FAILURE_POLL_MS = 500;

/** herdr's socket API (server/herdr/client.ts): one request per connection. */
export class HerdrRuntime implements AgentRuntime {
  constructor(private readonly socketPath?: string) {}

  private rpc<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return herdrRpc<T>(method, params, this.socketPath, timeoutMs);
  }

  async createLocation(options: CreateLocationOptions, signal?: AbortSignal): Promise<RuntimeLocation> {
    if (signal?.aborted) throw abortError(signal);
    const leftover: string[] = [];
    try {
      if (options.worktree) {
        if (!options.branch) throw new Error("A worktree run needs a branch name.");
        const created = await this.rpc<{ workspace?: { workspace_id?: string }; root_pane?: { pane_id?: string }; worktree?: { path?: string } }>(
          "worktree.create", { cwd: options.cwd, branch: options.branch, label: options.label, focus: false });
        const rootPaneId = created.root_pane?.pane_id;
        if (!rootPaneId) throw new Error("herdr worktree.create returned no root pane.");
        leftover.push(rootPaneId);
        const cwd = created.worktree?.path ?? options.cwd;
        // worktree.create takes no env: the agent gets a pane split off the root, which then goes
        const split = await this.rpc<{ pane?: PaneInfo }>("pane.split", { target_pane_id: rootPaneId, direction: options.direction ?? "right", cwd, env: options.env, focus: false });
        const paneId = split.pane?.pane_id;
        if (!paneId) throw new Error("herdr pane.split returned no pane.");
        leftover.push(paneId);
        await this.rpc("pane.close", { pane_id: rootPaneId });
        leftover.splice(leftover.indexOf(rootPaneId), 1);
        return { paneId, workspaceId: created.workspace?.workspace_id, cwd };
      }
      if (options.callerPaneId) {
        const split = await this.rpc<{ pane?: PaneInfo }>("pane.split", { target_pane_id: options.callerPaneId, direction: options.direction ?? "right", cwd: options.cwd, env: options.env, focus: false });
        const paneId = split.pane?.pane_id;
        if (!paneId) throw new Error("herdr pane.split returned no pane.");
        return { paneId, workspaceId: split.pane?.workspace_id, cwd: options.cwd };
      }
      const created = await this.rpc<{ workspace?: { workspace_id?: string }; root_pane?: PaneInfo }>(
        "workspace.create", { cwd: options.cwd, label: options.label, env: options.env, focus: false });
      const paneId = created.root_pane?.pane_id;
      if (!paneId) throw new Error("herdr workspace.create returned no root pane.");
      return { paneId, workspaceId: created.workspace?.workspace_id, cwd: options.cwd };
    } catch (error) {
      if (isAbortError(error)) for (const paneId of leftover.reverse()) await this.closePane(paneId).catch(() => undefined);
      throw error;
    }
  }

  async start(options: StartOptions): Promise<AgentState> {
    const { signal } = options;
    // a freshly split pane takes a moment to reach its shell prompt; herdr refuses to start an agent before
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw abortError(signal);
      try {
        await this.rpc("agent.start", { name: options.name, kind: options.kind, pane_id: options.paneId, args: options.args });
        break;
      } catch (error) {
        if (attempt < 4 && error instanceof HerdrError && /not an available shell/i.test(error.message)) { await abortableDelay(300 * (attempt + 1), signal); continue; }
        throw error;
      }
    }
    // agent.start answers at once (launch_pending); readiness is ours to wait for, and a CLI
    // that prints an error and exits would otherwise keep us waiting the whole timeout
    const control = new AbortController();
    const stop = () => control.abort();
    signal?.addEventListener("abort", stop, { once: true });
    const ready = this.waitReady(options.name, control.signal);
    const failed = this.watchStartupFailure(options.paneId, options.startupError, control.signal);
    ready.catch(() => undefined);
    failed.catch(() => undefined);
    try {
      const outcome = await Promise.race([ready.then((state) => ({ state })), failed.then((message) => ({ message }))]);
      if ("message" in outcome) throw new FleetError("agent_start_failed", outcome.message);
      return outcome.state;
    } finally {
      control.abort();
      signal?.removeEventListener("abort", stop);
    }
  }

  private async waitReady(name: string, signal: AbortSignal): Promise<AgentState> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const info = await this.rpc<{ agent?: AgentInfo }>("agent.get", { target: name }).then((r) => r.agent).catch(() => undefined);
      if (info?.interactive_ready) return toAgentState(info.agent_status);
      // a question before the first prompt (a trust dialog): the caller decides, never the fleet
      if (info?.agent_status === "blocked") return "blocked";
      await abortableDelay(READY_POLL_MS, signal);
    }
    throw new FleetError("agent_not_ready", `${name} did not become ready within ${START_TIMEOUT_MS / 1000}s`);
  }

  private async watchStartupFailure(paneId: string, startupError: StartOptions["startupError"], signal: AbortSignal): Promise<string> {
    while (!signal.aborted) {
      await abortableDelay(FAILURE_POLL_MS, signal);
      const pane = await this.rpc<{ pane?: PaneInfo }>("pane.get", { pane_id: paneId }).then((r) => r.pane).catch(() => undefined);
      if (!pane || pane.agent) continue;
      const screen = await this.rpc<{ read?: { text?: string } }>("pane.read", { pane_id: paneId, source: "recent", lines: 40 }).then((r) => r.read?.text ?? "").catch(() => "");
      const message = startupError(screen);
      if (message) return message;
    }
    throw abortError(signal);
  }

  async closePane(paneId: string): Promise<void> {
    await this.rpc("pane.close", { pane_id: paneId });
  }

  async prompt(name: string, text: string, signal?: AbortSignal): Promise<AgentState> {
    if (signal?.aborted) throw abortError(signal);
    await this.rpc("agent.prompt", { target: name, text });
    return this.get(name);
  }

  async get(name: string): Promise<AgentState> {
    const result = await this.rpc<{ agent?: AgentInfo }>("agent.get", { target: name });
    return toAgentState(result.agent?.agent_status);
  }

  async read(name: string, lines: number): Promise<string> {
    const result = await this.rpc<{ read?: { text?: string } }>("agent.read", { target: name, source: "recent_unwrapped", lines });
    return result.read?.text ?? "";
  }

  async interrupt(name: string): Promise<void> {
    await this.rpc("agent.send_keys", { target: name, keys: ["esc"] });
  }

  async focus(name: string): Promise<void> {
    await this.rpc("agent.focus", { target: name });
  }

  async reportMetadata(metadata: AgentMetadata): Promise<void> {
    await this.rpc("pane.report_metadata", { pane_id: metadata.paneId, source: "herdr-fleet", title: metadata.title, display_agent: metadata.displayAgent, tokens: metadata.tokens });
  }
}
