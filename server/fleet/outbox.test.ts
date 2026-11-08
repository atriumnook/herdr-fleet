import { afterEach, describe, expect, it } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { message, Outbox } from "./outbox.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "fleet-outbox-"));
  roots.push(root);
  return root;
}

const HEADERS = { news: "[fleet] News:", steps: "[fleet] Steps:" };
const texts = (outbox: Outbox) => outbox.pending().map((notice) => notice.text);

describe("outbox", () => {
  it("keeps queued notices across a restart and delivers each once, in the order written", async () => {
    const file = join(folder(), "state", "fleet-outbox.json");
    const before = new Outbox(file);
    before.put({ about: "t2", slot: "news", section: "news", text: "Two asks" });
    before.put({ about: "t1", slot: "news", section: "news", text: "One asks" });
    before.put({ about: "t1", slot: "landing", section: "steps", text: "Merge One", landingAt: 7 });
    before.put({ about: "t3", slot: "news", section: "news", text: "Three ended" });
    const after = new Outbox(file);
    expect(texts(after)).toEqual(["Two asks", "One asks", "Merge One", "Three ended"]);
    const sent: string[] = [];
    expect(await after.deliver(after.pending(), HEADERS, async (text) => { sent.push(text); return true; })).toBe(true);
    expect(sent).toEqual(["[fleet] News:\n- Two asks\n- One asks\n[fleet] Steps:\n- Merge One\n[fleet] News:\n- Three ended"]);
    expect(texts(after)).toEqual([]);
    expect(texts(new Outbox(file))).toEqual([]);
  });

  it("keeps the notices of a message that was not typed for the next one", async () => {
    const file = join(folder(), "fleet-outbox.json");
    const outbox = new Outbox(file);
    outbox.put({ about: "t1", slot: "news", section: "news", text: "One asks" });
    expect(await outbox.deliver(outbox.pending(), HEADERS, async () => false)).toBe(false);
    expect(texts(new Outbox(file))).toEqual(["One asks"]);
  });

  it("sends a notice written while a message went out with the next one", async () => {
    const file = join(folder(), "fleet-outbox.json");
    const outbox = new Outbox(file);
    outbox.put({ about: "t1", slot: "news", section: "news", text: "One asks" });
    await outbox.deliver(outbox.pending(), HEADERS, async () => {
      outbox.put({ about: "t1", slot: "news", section: "news", text: "One asks again" });
      outbox.put({ about: "t2", slot: "news", section: "news", text: "Two asks" });
      return true;
    });
    expect(texts(new Outbox(file))).toEqual(["One asks again", "Two asks"]);
  });

  it("puts a run's newer notice of a slot in place of one not yet delivered, after the others, and drops one no longer news", () => {
    const file = join(folder(), "fleet-outbox.json");
    const outbox = new Outbox(file);
    outbox.put({ about: "t1", slot: "news", section: "news", text: "One asks" });
    outbox.put({ about: "t2", slot: "news", section: "news", text: "Two asks" });
    outbox.put({ about: "t1", slot: "landing", section: "steps", text: "Merge One" });
    outbox.put({ about: "t1", slot: "news", section: "news", text: "One merged" });
    expect(texts(outbox)).toEqual(["Two asks", "Merge One", "One merged"]);
    outbox.drop("t2", "news");
    expect(texts(new Outbox(file))).toEqual(["Merge One", "One merged"]);
    expect(outbox.holds("t1")).toBe(true);
    expect(outbox.holds("t2")).toBe(false);
  });

  it("hands a run's notices to the run that took over, in their place, so a newer one of theirs replaces them", () => {
    const file = join(folder(), "fleet-outbox.json");
    const outbox = new Outbox(file);
    outbox.put({ about: "t1", slot: "landing", section: "steps", text: "Merge One", landingAt: 7 });
    outbox.put({ about: "t2", slot: "news", section: "news", text: "Two asks" });
    outbox.move("t1", "t1b");
    expect(new Outbox(file).pending().map((notice) => [notice.about, notice.text])).toEqual([["t1b", "Merge One"], ["t2", "Two asks"]]);
    outbox.put({ about: "t1b", slot: "landing", section: "steps", text: "Merge PR One", landingAt: 7 });
    expect(texts(new Outbox(file))).toEqual(["Two asks", "Merge PR One"]);
  });

  it("keeps the newer notice of a slot the run that took over already holds", () => {
    const file = join(folder(), "fleet-outbox.json");
    const outbox = new Outbox(file);
    outbox.put({ about: "t1", slot: "landing", section: "steps", text: "Merge One", landingAt: 7 });
    outbox.put({ about: "t1", slot: "news", section: "news", text: "One asks" });
    outbox.put({ about: "t1b", slot: "landing", section: "steps", text: "Merge PR One", landingAt: 9 });
    outbox.move("t1", "t1b");
    expect(new Outbox(file).pending().map((notice) => [notice.about, notice.text])).toEqual([["t1b", "One asks"], ["t1b", "Merge PR One"]]);
  });

  it("drops the queued notices a prune turns down, on disk too", () => {
    const file = join(folder(), "fleet-outbox.json");
    const outbox = new Outbox(file);
    outbox.put({ about: "gone", slot: "news", section: "news", text: "Gone asks" });
    outbox.put({ about: "t1", slot: "news", section: "news", text: "One asks" });
    outbox.prune((notice) => notice.about !== "gone");
    expect(texts(new Outbox(file))).toEqual(["One asks"]);
  });

  it("writes a notice sent now before it is typed, removes it after, and drops one a crash left behind on load", async () => {
    const root = folder();
    const file = join(root, "fleet-outbox.json");
    const outbox = new Outbox(file);
    outbox.put({ about: "t1", slot: "news", section: "news", text: "One asks" });
    let typed = "";
    const told = await outbox.sendNow("lead", "Merge main into the branch", async (text) => {
      typed = text;
      // the server dies here: what the file holds while the text is typed
      copyFileSync(file, join(root, "crashed.json"));
      return true;
    });
    expect(told).toBe(true);
    expect(typed).toBe("Merge main into the branch");
    expect(readFileSync(join(root, "crashed.json"), "utf8")).toContain("Merge main into the branch");
    expect(readFileSync(file, "utf8")).not.toContain("Merge main into the branch");
    // after the crash: the queued notice stays, the press the person saw fail does not go out later
    const restarted = new Outbox(join(root, "crashed.json"));
    expect(texts(restarted)).toEqual(["One asks"]);
    expect(readFileSync(join(root, "crashed.json"), "utf8")).not.toContain("Merge main into the branch");
    // a refused or failed send leaves nothing behind either
    await outbox.sendNow("lead", "Fix CI", async () => false);
    await expect(outbox.sendNow("lead", "Fix CI", async () => { throw new Error("pane gone"); })).rejects.toThrow("pane gone");
    expect(readFileSync(file, "utf8")).not.toContain("Fix CI");
  });

  it("writes its file whole: renamed into place, 0600, no temp file left", () => {
    const root = folder();
    const file = join(root, "fleet-outbox.json");
    new Outbox(file).put({ about: "t1", slot: "news", section: "news", text: "One asks" });
    expect(readdirSync(root)).toEqual(["fleet-outbox.json"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject([{ about: "t1", text: "One asks", seq: 1 }]);
  });

  it("numbers notices after the highest kept, so ones written after a restart go out after", () => {
    const file = join(folder(), "fleet-outbox.json");
    const before = new Outbox(file);
    before.put({ about: "t1", slot: "news", section: "news", text: "One asks" });
    before.put({ about: "t2", slot: "news", section: "news", text: "Two asks" });
    before.drop("t1", "news");
    const after = new Outbox(file);
    after.put({ about: "t3", slot: "news", section: "news", text: "Three asks" });
    expect(after.pending().map((notice) => [notice.text, notice.seq])).toEqual([["Two asks", 2], ["Three asks", 3]]);
  });

  it("sends nothing the file did not take", async () => {
    const root = folder();
    writeFileSync(join(root, "not-a-folder"), "");
    const outbox = new Outbox(join(root, "not-a-folder", "fleet-outbox.json"));
    expect(() => outbox.put({ about: "t1", slot: "news", section: "news", text: "One asks" })).toThrow();
    expect(texts(outbox)).toEqual([]);
    let sent = false;
    await expect(outbox.sendNow("lead", "Fix CI", async () => { sent = true; return true; })).rejects.toThrow();
    expect(sent).toBe(false);
  });

  it("starts empty from a missing or unreadable file", () => {
    const root = folder();
    expect(texts(new Outbox(join(root, "none.json")))).toEqual([]);
    expect(texts(new Outbox(null))).toEqual([]);
  });
});

describe("message", () => {
  it("lists each notice under its section's header, again when the section changes", () => {
    const at = 0;
    expect(message([
      { seq: 1, at, about: "a", slot: "news", section: "news", text: "A" },
      { seq: 2, at, about: "b", slot: "landing", section: "steps", text: "B" },
    ], HEADERS)).toBe("[fleet] News:\n- A\n[fleet] Steps:\n- B");
  });
});
