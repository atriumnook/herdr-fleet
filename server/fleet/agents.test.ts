import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_AGENTS_DIR, discoverAgents, findAgent, parseFrontmatter } from "./agents.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(project: Record<string, string> = {}, user: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "fleet-agents-"));
  roots.push(root);
  const userDir = join(root, "user-agents");
  const projectDir = join(root, "repo", ".herdr-fleet", "agents");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  for (const [name, text] of Object.entries(user)) writeFileSync(join(userDir, name), text);
  for (const [name, text] of Object.entries(project)) writeFileSync(join(projectDir, name), text);
  return { cwd: join(root, "repo"), dirs: { bundled: BUNDLED_AGENTS_DIR, user: userDir } };
}

describe("role discovery", () => {
  it("loads the bundled scout, planner, worker and reviewer as pi roles, and a thread's lead on claude then codex", () => {
    const { cwd, dirs } = fixture();
    const agents = discoverAgents(cwd, [], dirs);
    expect(agents.map((a) => a.name).sort()).toEqual(["lead", "planner", "reviewer", "scout", "worker"]);
    expect(findAgent(agents, "lead")).toMatchObject({ agent: "claude", fallbackModels: ["codex:"], interactive: true, spawning: true });
    expect(findAgent(agents, "Worker")).toMatchObject({ agent: "pi", source: "bundled", interactive: false, thinking: "high" });
    expect(findAgent(agents, "worker")!.tools).toContain("bash");
  });

  it("lets the user's role, then the project's, replace a bundled one of the same name", () => {
    const role = (who: string) => `---\nname: worker\ndescription: ${who}\n---\n${who} worker`;
    const { cwd, dirs } = fixture({ "worker.md": role("project") }, { "worker.md": role("user") });
    const worker = findAgent(discoverAgents(cwd, [], dirs), "worker")!;
    expect(worker).toMatchObject({ source: "project", description: "project", systemPrompt: "project worker" });
  });

  it("skips a broken role file with a warning and keeps the rest", () => {
    const { cwd, dirs } = fixture({
      // an unquoted colon inside a value is invalid YAML
      "scout.md": "---\nname: scout\ndescription: Fast: locate files\n---\nbroken",
      "odd.md": "---\nname: odd\nagent: vim\n---\nunknown agent",
      "helper.md": '---\nname: helper\ndescription: "A valid project role"\nfallbackModels: p/a, p/b\n---\nYou are a helper.',
    });
    const warnings: string[] = [];
    const agents = discoverAgents(cwd, warnings, dirs);
    expect(findAgent(agents, "scout")!.source).toBe("bundled");
    expect(findAgent(agents, "helper")).toMatchObject({ fallbackModels: ["p/a", "p/b"], systemPrompt: "You are a helper." });
    expect(findAgent(agents, "odd")).toBeUndefined();
    expect(warnings.filter((w) => w.startsWith("fleet: skipping invalid role file")).map((w) => w.includes("scout.md") || w.includes("odd.md"))).toEqual([true, true]);
  });

  it("reads a file without frontmatter as all body", () => {
    expect(parseFrontmatter("just text")).toEqual({ frontmatter: {}, body: "just text" });
    expect(parseFrontmatter("---\nname: x\n---\nbody")).toEqual({ frontmatter: { name: "x" }, body: "body" });
  });
});
