import { describe, expect, it } from "bun:test";
import { adapterFor, isAgentKind, piTurnError, withThinking } from "./adapters.ts";

describe("pi adapter", () => {
  const pi = adapterFor("pi");

  it("launches with the model at its thinking level, the role's tools, a fleet name and the instruction file", () => {
    expect(pi.launchArgs({ model: "p/m", thinking: "low", tools: ["read", "bash"], name: "impl", systemPromptFile: "/tmp/i.md" }))
      .toEqual(["--model", "p/m:low", "--tools", "read,bash", "--name", "fleet:impl", "--append-system-prompt", "/tmp/i.md"]);
    expect(pi.launchArgs({ name: "impl", systemPromptFile: "/tmp/i.md" })).toEqual(["--name", "fleet:impl", "--append-system-prompt", "/tmp/i.md"]);
  });

  it("keeps a :level the model already carries", () => {
    expect(withThinking("p/m:high", "low")).toBe("p/m:high");
    expect(withThinking("p/m")).toBe("p/m");
  });

  it("reads the last Error: line pi printed when it gave up at startup", () => {
    expect(pi.startupError('$ pi --model x\nError: Model "x" not found\n$ ')).toBe('Model "x" not found');
    expect(pi.startupError("$ pi\n")).toBeUndefined();
  });

  it("calls a turn failed by its last Error: line only when no HANDOFF follows", () => {
    expect(piTurnError("working...\nError: 401 unauthorized\n")).toBe("401 unauthorized");
    expect(piTurnError("Error: first\nmore\nError: second")).toBe("second");
    expect(piTurnError("Error: test failed earlier\nHANDOFF\noutcome: fixed")).toBeUndefined();
    expect(piTurnError(undefined)).toBeUndefined();
  });

  it("knows only the kinds it has an adapter for", () => {
    expect(isAgentKind("pi")).toBe(true);
    expect(isAgentKind("claude")).toBe(false);
    expect(isAgentKind("toString")).toBe(false);
  });
});
