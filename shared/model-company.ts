/**
 * The company whose model a run used, told from the run's CLI and model. The merge gate counts a
 * review only by a model from another company than every model that wrote the change: one company's
 * models tend to miss the same things (server/fleet/merge-mode.ts).
 */
import type { FleetAgentKind, Writer } from "./fleet.ts";

export type ModelCompany = "Anthropic" | "OpenAI" | "Google" | "DeepSeek" | "Xiaomi" | "Moonshot AI" | "Zhipu AI" | "Alibaba" | "xAI" | "Meta" | "Mistral AI" | "MiniMax";

/** model families by the start of the model's own name, lowercased */
const FAMILIES: ReadonlyArray<readonly [RegExp, ModelCompany]> = [
  [/^claude-/, "Anthropic"],
  [/^(gpt-|o\d+(-|$))/, "OpenAI"],
  [/^(gemini|gemma)-/, "Google"],
  [/^deepseek-/, "DeepSeek"],
  [/^mimo-/, "Xiaomi"],
  [/^kimi-/, "Moonshot AI"],
  [/^glm-/, "Zhipu AI"],
  [/^qwen/, "Alibaba"],
  [/^grok-/, "xAI"],
  [/^llama/, "Meta"],
  [/^(mistral|codestral|devstral|magistral|ministral)/, "Mistral AI"],
  [/^minimax-/, "MiniMax"],
];

/** The company that makes the model a run used; undefined when that cannot be told. */
export function modelCompany(agent: FleetAgentKind, model?: string): ModelCompany | undefined {
  // claude and codex run only their own company's models
  if (agent === "claude") return "Anthropic";
  if (agent === "codex") return "OpenAI";
  // cursor's models, auto among them, route across companies
  if (agent === "cursor" || !model) return undefined;
  // agy names the model; pi and opencode name provider/model, and the model, not the provider, tells
  const name = model.slice(model.lastIndexOf("/") + 1).toLowerCase();
  return FAMILIES.find(([family]) => family.test(name))?.[1];
}

/**
 * The company of a reviewer's model when its review counts against the change's writers: one none
 * of their models is from. Undefined when it is one of theirs, or when any company is not known.
 */
export function independentCompany(writers: readonly Writer[], reviewer: Writer): ModelCompany | undefined {
  const company = modelCompany(reviewer.agent, reviewer.model);
  const theirs = writers.map((writer) => modelCompany(writer.agent, writer.model));
  return company && theirs.every((each) => each !== undefined && each !== company) ? company : undefined;
}

/** A run's CLI and model as people name them: `agy:gemini-3-pro`, or the CLI alone. */
export const modelLabel = ({ agent, model }: Writer): string => (model ? `${agent}:${model}` : agent);
