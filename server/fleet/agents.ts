import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isAgentKind } from "./adapters.ts";
import { findProjectPath, userFleetDir } from "./config.ts";
import { parseThinkingLevel, type AgentDefinition } from "./types.ts";

/** The roles that ship with the fleet: agents/*.md at the repository root. */
export const BUNDLED_AGENTS_DIR = resolve(import.meta.dir, "..", "..", "agents");

/** `---\n<yaml>\n---\n<body>`; a file without frontmatter is all body. */
export function parseFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { frontmatter: {}, body: text };
  const parsed: unknown = Bun.YAML.parse(match[1]!);
  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) throw new Error("frontmatter must be a mapping");
  return { frontmatter: (parsed ?? {}) as Record<string, unknown>, body: text.slice(match[0].length) };
}

function parseList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const out = raw.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

function loadDir(dir: string, source: AgentDefinition["source"], warnings?: string[]): AgentDefinition[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const result: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const filePath = join(dir, entry.name);
    try {
      const { frontmatter: fm, body } = parseFrontmatter(readFileSync(filePath, "utf8"));
      const name = typeof fm["name"] === "string" ? fm["name"] : basename(entry.name, ".md");
      if (fm["agent"] !== undefined && !isAgentKind(fm["agent"])) throw new Error(`unknown agent ${JSON.stringify(fm["agent"])}`);
      result.push({
        name,
        description: typeof fm["description"] === "string" ? fm["description"] : name,
        agent: isAgentKind(fm["agent"]) ? fm["agent"] : "pi",
        model: typeof fm["model"] === "string" ? fm["model"] : undefined,
        thinking: parseThinkingLevel(fm["thinking"]),
        fallbackModels: parseList(fm["fallbackModels"]),
        tools: parseList(fm["tools"]),
        worktree: typeof fm["worktree"] === "boolean" ? fm["worktree"] : undefined,
        interactive: typeof fm["interactive"] === "boolean" ? fm["interactive"] : undefined,
        spawning: typeof fm["spawning"] === "boolean" ? fm["spawning"] : undefined,
        systemPrompt: body.trim(),
        source,
        filePath,
      });
    } catch (error) {
      // one broken role file must not hide the others
      warnings?.push(`fleet: skipping invalid role file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

/** Bundled roles, then the user's, then the project's: a later one of the same name wins. */
export function discoverAgents(cwd: string, warnings?: string[], dirs = { bundled: BUNDLED_AGENTS_DIR, user: join(userFleetDir(), "agents") }): AgentDefinition[] {
  const map = new Map<string, AgentDefinition>();
  for (const agent of loadDir(dirs.bundled, "bundled", warnings)) map.set(agent.name.toLowerCase(), agent);
  for (const agent of loadDir(dirs.user, "user", warnings)) map.set(agent.name.toLowerCase(), agent);
  const project = findProjectPath(cwd, "agents");
  if (project) for (const agent of loadDir(project, "project", warnings)) map.set(agent.name.toLowerCase(), agent);
  return [...map.values()];
}

export function findAgent(agents: AgentDefinition[], role: string): AgentDefinition | undefined {
  return agents.find((a) => a.name.toLowerCase() === role.toLowerCase());
}
