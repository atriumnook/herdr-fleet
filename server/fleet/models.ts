import { modelListed, type ModelListing } from "../../shared/fleet.ts";
import { adapterFor, AGENT_KINDS, type AgentAdapter } from "./adapters.ts";
import type { AgentKind } from "./types.ts";

const TTL_MS = 10 * 60_000;

/** Each CLI's list of its models (adapters.ts `models`), asked once in a while and kept. */
export class ModelCatalog {
  private readonly kept = new Map<AgentKind, { at: number; listing: ModelListing }>();
  private readonly asking = new Map<AgentKind, Promise<ModelListing>>();

  /** `adapter` and `now` are for tests to stand in */
  constructor(private readonly options: { adapter?: (kind: AgentKind) => Pick<AgentAdapter, "models">; now?: () => number } = {}) {}

  private adapter(kind: AgentKind): Pick<AgentAdapter, "models"> {
    return (this.options.adapter ?? adapterFor)(kind);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** A CLI that cannot be asked gives an empty listing with the reason, and is asked again next time. */
  list(agent: AgentKind, fresh = false): Promise<ModelListing> {
    const kept = this.kept.get(agent);
    if (kept && !fresh && this.now() - kept.at < TTL_MS) return Promise.resolve(kept.listing);
    const asking = this.asking.get(agent);
    if (asking) return asking;
    const source = this.adapter(agent).models;
    const ask = (async (): Promise<ModelListing> => {
      if (!source) return { agent, models: [], complete: false };
      try {
        const listing: ModelListing = { agent, models: await source.list(), complete: source.complete };
        if (listing.models.length === 0) return { ...listing, complete: false, error: `${agent} listed no models` };
        this.kept.set(agent, { at: this.now(), listing });
        return listing;
      } catch (error) {
        return { agent, models: [], complete: false, error: error instanceof Error ? error.message : String(error) };
      }
    })().finally(() => this.asking.delete(agent));
    this.asking.set(agent, ask);
    return ask;
  }

  listAll(): Promise<ModelListing[]> {
    return Promise.all(AGENT_KINDS.map((agent) => this.list(agent)));
  }

  /**
   * Why `model` will not run on `agent`, when the CLI's list is complete and lacks it; nothing when
   * it is there, when the CLI gives no complete list, or when it cannot be asked. A model missing
   * from a kept list is looked up again first: the CLI may have gained it since.
   */
  async unknown(agent: AgentKind, model: string | undefined): Promise<string | undefined> {
    if (!model || !this.adapter(agent).models?.complete) return undefined;
    let listing = await this.list(agent);
    if (listing.error || modelListed(listing, model)) return undefined;
    listing = await this.list(agent, true);
    if (listing.error || modelListed(listing, model)) return undefined;
    return `${agent} does not offer a model named ${model}`;
  }
}
