import { join } from "node:path";
import { modelListed, type ModelListing } from "../../shared/fleet.ts";
import { adapterFor, AGENT_KINDS, type AgentAdapter } from "./adapters.ts";
import type { AgentKind } from "./types.ts";


const TTL_MS = 10 * 60_000;
/** a CLI that failed is not asked again for this long */
const FAILURE_TTL_MS = 60_000;
/** the longest a spawn waits for a CLI's list: past it the model is let through */
const SPAWN_WAIT_MS = 3_000;

/** Each CLI's list of its models (adapters.ts `models`), asked once in a while and kept. */
export class ModelCatalog {
  private readonly kept = new Map<AgentKind, { at: number; listing: ModelListing }>();
  private readonly asking = new Map<AgentKind, Promise<ModelListing>>();

  /** `workDir`: the folder holding a folder per CLI, each emptied before the CLI runs in it. `adapter`, `now`, `spawnWaitMs` and `env` are for tests to stand in */
  constructor(private readonly options: { workDir: string; env?: Record<string, string | undefined>; adapter?: (kind: AgentKind) => Pick<AgentAdapter, "models">; now?: () => number; spawnWaitMs?: number }) {}

  private adapter(kind: AgentKind): Pick<AgentAdapter, "models"> {
    return (this.options.adapter ?? adapterFor)(kind);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** A CLI that cannot be asked gives an empty listing with the reason, kept for a minute. `fresh` asks anew whatever is kept or under way. */
  list(agent: AgentKind, fresh = false): Promise<ModelListing> {
    const kept = this.kept.get(agent);
    if (kept && !fresh && this.now() - kept.at < (kept.listing.error ? FAILURE_TTL_MS : TTL_MS)) return Promise.resolve(kept.listing);
    const asking = this.asking.get(agent);
    if (asking && !fresh) return asking;
    const source = this.adapter(agent).models;
    const ask: Promise<ModelListing> = (async (): Promise<ModelListing> => {
      if (!source) return { agent, models: [], complete: false };
      let listing: ModelListing;
      try {
        listing = { agent, models: await source.list({ workDir: join(this.options.workDir, agent), env: this.options.env }), complete: source.complete };
        if (listing.models.length === 0) listing = { ...listing, complete: false, error: `${agent} listed no models` };
      } catch (error) {
        listing = { agent, models: [], complete: false, error: error instanceof Error ? error.message : String(error) };
      }
      this.kept.set(agent, { at: this.now(), listing });
      return listing;
    })();
    this.asking.set(agent, ask);
    // a later fresh ask may have taken the place: only one's own entry is removed
    void ask.finally(() => { if (this.asking.get(agent) === ask) this.asking.delete(agent); });
    return ask;
  }

  listAll(): Promise<ModelListing[]> {
    return Promise.all(AGENT_KINDS.map((agent) => this.list(agent)));
  }

  /**
   * Why `model` will not run on `agent`, when the CLI's list is complete and lacks it; nothing when
   * it is there, when the CLI gives no complete list, or when it cannot be asked. A model missing
   * from a kept list is looked up again first: the CLI may have gained it since. A spawn waits for
   * the CLI only so long (`spawnWaitMs`); past that the model is let through.
   */
  async unknown(agent: AgentKind, model: string | undefined): Promise<string | undefined> {
    if (!model || !this.adapter(agent).models?.complete) return undefined;
    let timer: unknown;
    const deadline = new Promise<undefined>((resolve) => { timer = setTimeout(resolve, this.options.spawnWaitMs ?? SPAWN_WAIT_MS); });
    const within = (listing: Promise<ModelListing>) => Promise.race([listing, deadline]);
    try {
      let listing = await within(this.list(agent));
      if (!listing || listing.error || modelListed(listing, model)) return undefined;
      listing = await within(this.list(agent, true));
      if (!listing || listing.error || modelListed(listing, model)) return undefined;
      return `${agent} does not offer a model named ${model}`;
    } finally {
      clearTimeout(timer as never);
    }
  }
}
