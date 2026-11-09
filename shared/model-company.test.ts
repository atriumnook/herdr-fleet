import { describe, expect, it } from "bun:test";
import type { FleetAgentKind } from "./fleet.ts";
import { independentCompany, modelCompany } from "./model-company.ts";

describe("the company whose model a run used", () => {
  // [CLI, model as the run records it, the company that makes that model]
  const table: Array<[FleetAgentKind, string | undefined, string | undefined]> = [
    // claude and codex run their own company's models, whatever model they are given
    ["claude", undefined, "Anthropic"],
    ["claude", "opus", "Anthropic"],
    ["claude", "claude-sonnet-5-5", "Anthropic"],
    ["codex", undefined, "OpenAI"],
    ["codex", "gpt-5.6-sol", "OpenAI"],
    // agy runs several companies' models: its model name tells
    ["agy", "claude-opus-5-5-high", "Anthropic"],
    ["agy", "gemini-3.8-flash-low", "Google"],
    ["agy", "gpt-oss-120b", "OpenAI"],
    ["agy", undefined, undefined],
    ["agy", "something-new", undefined],
    // pi and opencode name provider/model: the model, not the provider, tells
    ["pi", "anthropic/claude-sonnet-5-5", "Anthropic"],
    ["pi", "openrouter/anthropic/claude-opus-5-5:high", "Anthropic"],
    ["pi", "google/gemini-3-pro", "Google"],
    ["pi", "openai/gpt-6", "OpenAI"],
    ["pi", "openai/o4-mini", "OpenAI"],
    ["pi", "groq/gpt-oss-120b", "OpenAI"],
    ["pi", "openrouter/auto", undefined],
    ["pi", undefined, undefined],
    ["opencode", "opencode-go/mimo-v2.6-pro", "Xiaomi"],
    ["opencode", "opencode-go/deepseek-v4-pro", "DeepSeek"],
    ["opencode", "opencode-go/kimi-k3#high", "Moonshot AI"],
    ["opencode", "zai/glm-5", "Zhipu AI"],
    ["opencode", "openrouter/qwen3-coder-480b", "Alibaba"],
    ["opencode", "xai/grok-5", "xAI"],
    ["opencode", "groq/llama-4-maverick", "Meta"],
    ["opencode", "mistral/devstral-medium", "Mistral AI"],
    ["opencode", "minimax/MiniMax-M3", "MiniMax"],
    ["opencode", "google/gemma-4-27b", "Google"],
    ["opencode", "opencode/big-pickle", undefined],
    // a name that only starts like a family's is not one of its models
    ["opencode", "opencode/gptx", undefined],
    ["opencode", "opencode/o3x", undefined],
    // cursor's models, auto among them, route across companies
    ["cursor", "gpt-5", undefined],
    ["cursor", "auto", undefined],
  ];
  for (const [agent, model, company] of table) {
    it(`${agent}${model ? `:${model}` : ""} is ${company ?? "not known"}`, () => {
      expect(modelCompany(agent, model)).toBe(company as never);
    });
  }
});

describe("a review's company against the change's writers", () => {
  it("is the reviewer's when none of the writers' models is from it", () => {
    expect(independentCompany([{ agent: "claude" }], { agent: "agy", model: "gemini-3.8-pro-high" })).toBe("Google");
    expect(independentCompany([{ agent: "claude" }], { agent: "codex", model: "gpt-5.6-sol" })).toBe("OpenAI");
  });

  it("is none when a writer's model is from the reviewer's company", () => {
    expect(independentCompany([{ agent: "claude" }], { agent: "agy", model: "claude-opus-5-5-high" })).toBeUndefined();
    expect(independentCompany([{ agent: "claude" }, { agent: "pi", model: "openai/gpt-6" }], { agent: "codex" })).toBeUndefined();
  });

  it("is none when a writer's or the reviewer's company is not known", () => {
    expect(independentCompany([{ agent: "claude" }, { agent: "agy" }], { agent: "codex" })).toBeUndefined();
    expect(independentCompany([{ agent: "claude" }, { agent: "cursor", model: "gpt-5" }], { agent: "codex" })).toBeUndefined();
    expect(independentCompany([{ agent: "claude" }], { agent: "pi", model: "openrouter/auto" })).toBeUndefined();
  });
});
