import type { SlashCommand } from "../../shared/protocol.ts";

/** A pane's slash commands are read again after this: an agent's skills change rarely. */
const COMMAND_CACHE_MS = 60_000;
const SLASH_USAGE_KEY = "herdr-fleet:slash-usage";

const commandCache = new Map<string, { loadedAt: number; commands: SlashCommand[] }>();

/** A pane's slash commands, kept a minute by its storage id. */
export async function cachedPaneCommands(owner: string, fetchCommands: () => Promise<SlashCommand[]>): Promise<SlashCommand[]> {
  const cached = commandCache.get(owner);
  if (cached && Date.now() - cached.loadedAt < COMMAND_CACHE_MS) return cached.commands;
  const commands = await fetchCommands();
  commandCache.set(owner, { loadedAt: Date.now(), commands });
  return commands;
}

/** How often each slash command was chosen on this device, for the menu's order. */
export function readSlashUsage(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SLASH_USAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
    );
  } catch {
    return {};
  }
}

export function saveSlashUsage(usage: Record<string, number>): void {
  try {
    window.localStorage.setItem(SLASH_USAGE_KEY, JSON.stringify(usage));
  } catch {
    // Completion still works when storage is unavailable.
  }
}
