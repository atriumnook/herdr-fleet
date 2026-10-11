/**
 * The fleet skill, put where agent CLIs read skills from, so that an agent in a pane's conversation
 * hands work to the project's coordinator (`fleet project`). The file names only the fleet command
 * and this server's address; the instructions come from `fleet guide`, so they match the herdr-fleet
 * that runs. A file the fleet did not write is never overwritten or removed.
 */

import { mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FleetEntrance, FleetEntrances } from "../../shared/fleet.ts";
import { FleetError } from "./runtime.ts";

const SKILL = "herdr-fleet";
/** how the fleet knows the file as its own */
const MARK = "<!-- herdr-fleet entrance: written by herdr-fleet's Settings page, which updates and removes it -->";

/** Each folder, and the CLIs that read it (Claude Code, Cursor, pi, Codex and agy each document theirs). */
const FOLDERS: ReadonlyArray<Pick<FleetEntrance, "id" | "readers"> & { dir: string[] }> = [
  { id: "claude", dir: [".claude", "skills"], readers: ["claude", "cursor"] },
  { id: "agents", dir: [".agents", "skills"], readers: ["pi", "codex", "cursor"] },
  { id: "gemini", dir: [".gemini", "config", "skills"], readers: ["agy"] },
];

export interface EntranceDeps {
  /** the fleet command, as agents the fleet starts are given it */
  command: string;
  /** this server's address */
  url: () => string;
  /** the server wants a token */
  tokenRequired: boolean;
  /** whose skill folders; the person's home unless a test says otherwise */
  home?: string;
}

export class EntranceStore {
  constructor(private readonly deps: EntranceDeps) {}

  /** The skill as the fleet writes it now. */
  skill(): string {
    return [
      "---",
      `name: ${SKILL}`,
      "description: Hand work in this repository to herdr-fleet, or check on work handed to it. Use when the person says to ask, hand or delegate something to the fleet (for example 「fleet に頼んで」), or asks how the fleet's threads are going.",
      "---",
      MARK,
      "",
      "If HERDR_FLEET_RUN is set, you are one of the fleet's own agents: do not use this skill.",
      "",
      "Run this, and follow what it prints:",
      "",
      `    HERDR_FLEET_URL=${this.deps.url()} ${this.deps.command} guide`,
      "",
    ].join("\n");
  }

  list(): FleetEntrances {
    const skill = this.skill();
    const entrances = FOLDERS.map(({ id, readers }): FleetEntrance => {
      const file = this.file(id);
      const text = read(file);
      const state = text === undefined ? "missing" : text === skill ? "installed" : text.includes(MARK) ? "outdated" : "taken";
      return { id, file, readers: [...readers], state };
    });
    return { entrances, tokenRequired: this.deps.tokenRequired };
  }

  /** Writes the skill into `id`'s folder; one the fleet wrote before is brought up to date. */
  install(id: string): FleetEntrances {
    const file = this.owned(id);
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, this.skill(), { mode: 0o644 });
    renameSync(temp, file);
    return this.list();
  }

  /** Removes the skill from `id`'s folder, and its folder when nothing else is in it. */
  remove(id: string): FleetEntrances {
    const file = this.owned(id);
    try { unlinkSync(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try { rmdirSync(dirname(file)); } catch { /* the person keeps files of their own there */ }
    return this.list();
  }

  private file(id: string): string {
    const folder = FOLDERS.find((each) => each.id === id);
    if (!folder) throw new FleetError("unknown_entrance", `Unknown entrance: ${id}`);
    return join(this.deps.home ?? homedir(), ...folder.dir, SKILL, "SKILL.md");
  }

  /** `id`'s file, refused when a file the fleet did not write is there. */
  private owned(id: string): string {
    const file = this.file(id);
    const text = read(file);
    if (text !== undefined && !text.includes(MARK)) throw new FleetError("entrance_taken", `${file} was not written by herdr-fleet. Move it away by hand first.`);
    return file;
  }
}

function read(file: string): string | undefined {
  try { return readFileSync(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new FleetError("entrance_unreadable", `Cannot read ${file}: ${(error as Error).message}`);
  }
}
