import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EntranceStore } from "./entrances.ts";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "fleet-entrances-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const store = (url = "http://127.0.0.1:7317", tokenRequired = false) => new EntranceStore({ command: "/usr/bin/bun /opt/herdr-fleet/bin/fleet.ts", url: () => url, tokenRequired, home });
const skillFile = (...dir: string[]) => join(home, ...dir, "herdr-fleet", "SKILL.md");
const states = (entrances: EntranceStore) => Object.fromEntries(entrances.list().entrances.map((entrance) => [entrance.id, entrance.state]));

describe("the fleet skill's entrances", () => {
  it("are the three folders the five CLIs read, none installed at first", () => {
    const { entrances, tokenRequired } = store().list();
    expect(entrances).toEqual([
      { id: "claude", file: skillFile(".claude", "skills"), readers: ["claude", "cursor"], state: "missing" },
      { id: "agents", file: skillFile(".agents", "skills"), readers: ["pi", "codex", "cursor"], state: "missing" },
      { id: "gemini", file: skillFile(".gemini", "config", "skills"), readers: ["agy"], state: "missing" },
    ]);
    expect(tokenRequired).toBe(false);
    expect(store("http://127.0.0.1:7317", true).list().tokenRequired).toBe(true);
  });

  it("write a skill that names the fleet command and this server, and leaves the instructions to fleet guide", () => {
    const entrances = store();
    entrances.install("agents");
    const text = readFileSync(skillFile(".agents", "skills"), "utf8");
    expect(text.startsWith("---\nname: herdr-fleet\ndescription: ")).toBe(true);
    expect(text).toContain("    HERDR_FLEET_URL=http://127.0.0.1:7317 /usr/bin/bun /opt/herdr-fleet/bin/fleet.ts guide\n");
    expect(text).toContain("If HERDR_FLEET_RUN is set");
    expect(statSync(skillFile(".agents", "skills")).mode & 0o777).toBe(0o644);
    expect(states(entrances)).toEqual({ claude: "missing", agents: "installed", gemini: "missing" });
  });

  it("say a skill written for another address is outdated, and bring it up to date", () => {
    store("http://127.0.0.1:7318").install("claude");
    const now = store();
    expect(states(now).claude).toBe("outdated");
    now.install("claude");
    expect(states(now).claude).toBe("installed");
    expect(readFileSync(skillFile(".claude", "skills"), "utf8")).toContain("127.0.0.1:7317");
  });

  it("never overwrite or remove a file the fleet did not write", () => {
    const file = skillFile(".gemini", "config", "skills");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "---\nname: herdr-fleet\ndescription: my own\n---\n");
    const entrances = store();
    expect(states(entrances).gemini).toBe("taken");
    expect(() => entrances.install("gemini")).toThrow(expect.objectContaining({ code: "entrance_taken" }));
    expect(() => entrances.remove("gemini")).toThrow(expect.objectContaining({ code: "entrance_taken" }));
    expect(readFileSync(file, "utf8")).toContain("my own");
  });

  it("remove the skill and its folder, but keep the person's files beside it", () => {
    const entrances = store();
    entrances.install("claude");
    entrances.remove("claude");
    expect(existsSync(join(home, ".claude", "skills", "herdr-fleet"))).toBe(false);
    expect(existsSync(join(home, ".claude", "skills"))).toBe(true);
    entrances.install("agents");
    writeFileSync(join(home, ".agents", "skills", "herdr-fleet", "notes.md"), "mine");
    entrances.remove("agents");
    expect(existsSync(skillFile(".agents", "skills"))).toBe(false);
    expect(readFileSync(join(home, ".agents", "skills", "herdr-fleet", "notes.md"), "utf8")).toBe("mine");
    // removing one that is not there changes nothing
    expect(states(entrances.remove("gemini") && entrances).gemini).toBe("missing");
  });

  it("refuse a folder they do not know", () => {
    expect(() => store().install("../../etc")).toThrow(expect.objectContaining({ code: "unknown_entrance" }));
  });
});
