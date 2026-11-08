import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** What a notice is, when it is written. */
export interface NoticeInput {
  /** the run the notice is about: whoever hears that run when the notice goes out hears it */
  about: string;
  /** a later notice of the same `about` and `slot` replaces one not yet delivered */
  slot: string;
  /** the header it is listed under, in a message with others */
  section: string;
  text: string;
  /** the landing step it hands on, by the time the person pressed it */
  landingAt?: number;
}

/** A notice in the outbox: numbered in the order written, which is the order it goes out in. */
export interface Notice extends NoticeInput {
  seq: number;
  at: number;
}

/** A notice sent at once: kept in the file only while it is typed. */
interface Immediate {
  seq: number;
  at: number;
  to: string;
  text: string;
  now: true;
}

type Entry = Notice | Immediate;

const isImmediate = (entry: Entry): entry is Immediate => "now" in entry;

/**
 * The fleet's notices to its agents ([fleet] messages to a coordinator or a thread's lead), kept in
 * one JSON file (0600) that is written, a temp file renamed over it, before a notice is typed.
 *
 * A queued notice (`put`) waits until whoever hears its run is free, survives a restart, and goes out
 * with the others due to the same agent, in the order written; once the message is typed, the
 * delivered notices leave the file in one write, so a restart neither loses nor repeats one. A crash
 * while the message is being typed sends it again after the restart: a repeat over a loss, as the
 * coordinator waits on this news.
 *
 * A notice sent at once (`sendNow`: a button the person pressed, the standstill call) is in the file
 * only while it is typed. One a crash left behind is dropped on load: the person saw the press fail
 * and presses again, and the supervisor finds a standstill again.
 */
export class Outbox {
  private entries: Entry[] = [];
  private next = 1;

  constructor(readonly filePath: string | null) {
    if (!filePath) return;
    let stored: unknown;
    try { stored = JSON.parse(readFileSync(filePath, "utf8")); } catch { return; }
    if (!Array.isArray(stored)) return;
    const valid = (stored as Entry[]).filter((entry) => typeof entry?.seq === "number" && typeof entry.text === "string");
    this.entries = valid.filter((entry) => !isImmediate(entry)).sort((a, b) => a.seq - b.seq);
    this.next = Math.max(0, ...valid.map((entry) => entry.seq)) + 1;
    if (this.entries.length !== stored.length) this.commit(this.entries);
  }

  /** Queues a notice, in place of one of the same run and slot not yet delivered. */
  put(input: NoticeInput): Notice {
    const notice: Notice = { ...input, seq: this.next++, at: Date.now() };
    this.commit([...this.entries.filter((entry) => isImmediate(entry) || entry.about !== input.about || entry.slot !== input.slot), notice]);
    return notice;
  }

  /** The run's notice of `slot` is no longer news: the person answered it, or the run went on. */
  drop(about: string, slot: string): void {
    this.remove((entry) => !isImmediate(entry) && entry.about === about && entry.slot === slot);
  }

  /**
   * The queued notices about `from` are about `to` now, in their place: a thread's new lead took them
   * over. One of a slot `to` already holds is older, and goes.
   */
  move(from: string, to: string): void {
    const held = new Set(this.pending((notice) => notice.about === to).map((notice) => notice.slot));
    this.commit(this.entries
      .filter((entry) => isImmediate(entry) || entry.about !== from || !held.has(entry.slot))
      .map((entry) => !isImmediate(entry) && entry.about === from ? { ...entry, about: to } : entry));
  }

  /** The queued notices `keep` turns down leave the outbox. */
  prune(keep: (notice: Notice) => boolean): void {
    this.remove((entry) => !isImmediate(entry) && !keep(entry));
  }

  /** The queued notices, in the order written. */
  pending(filter: (notice: Notice) => boolean = () => true): Notice[] {
    return this.entries.filter((entry): entry is Notice => !isImmediate(entry) && filter(entry));
  }

  /** whether a queued notice about the run waits */
  holds(about: string): boolean {
    return this.pending((notice) => notice.about === about).length > 0;
  }

  /**
   * `due` in one message, through `send` (true once it was typed); delivered, they leave the outbox.
   * A notice that replaced one of them meanwhile stays for the next message.
   */
  async deliver(due: Notice[], headers: Record<string, string>, send: (text: string) => Promise<boolean>): Promise<boolean> {
    if (!due.length || !(await send(message(due, headers)))) return false;
    const sent = new Set(due.map((notice) => notice.seq));
    this.remove((entry) => sent.has(entry.seq));
    return true;
  }

  /** `text` to the run `to` now, through `send`; written before it is typed, gone after, whatever came of it. */
  async sendNow(to: string, text: string, send: (text: string) => Promise<boolean>): Promise<boolean> {
    const entry: Immediate = { seq: this.next++, at: Date.now(), to, text, now: true };
    this.commit([...this.entries, entry]);
    try {
      return await send(text);
    } finally {
      this.remove((each) => each === entry);
    }
  }

  private remove(match: (entry: Entry) => boolean): void {
    const kept = this.entries.filter((entry) => !match(entry));
    if (kept.length !== this.entries.length) this.commit(kept);
  }

  /** `entries` on disk, then in memory: a notice the file did not take is never sent */
  private commit(entries: Entry[]): void {
    if (this.filePath) {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.filePath);
    }
    this.entries = entries;
  }
}

/** The notices as one message: each under its section's header, which comes again when the section changes. */
export function message(notices: Notice[], headers: Record<string, string>): string {
  const lines: string[] = [];
  let section: string | undefined;
  for (const notice of notices) {
    if (notice.section !== section) {
      section = notice.section;
      const header = headers[section];
      if (header) lines.push(header);
    }
    lines.push(`- ${notice.text}`);
  }
  return lines.join("\n");
}
