import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractivePrompt } from "../shared/protocol.ts";

import { answerKeys, parseFallbackPrompt, parseInteractivePrompt } from "./prompt.ts";
import { handlePromptRequest, promptWaitEnded } from "./prompt-api.ts";

const labels = (prompt: InteractivePrompt | null) => prompt?.options.map((option) => option.label);
const CLAUDE_BACKGROUND_APPROVAL_FOOTER = "Esc to cancel · ctrl+x ctrl+k twice to stop background agents";
const claudeBackgroundApproval = (selected: number, footer = CLAUDE_BACKGROUND_APPROVAL_FOOTER) => {
  const row = (index: number, label: string) => `${index === selected ? " ❯ " : "   "}${index + 1}. ${label}`;
  return [
    "✻ Waiting for 1 background agent to finish",
    "",
    "─".repeat(80),
    " Bash command · from the general-purpose agent",
    " Run shell command",
    "╌".repeat(80),
    " │ systemctl --user start demo.service",
    "╌".repeat(80),
    " │ Permission rule Bash(systemctl --user start:*) requires confirmation for this command.",
    " /permissions to update rules",
    "",
    " Do you want to proceed?",
    row(0, "Yes"),
    row(1, "Yes, and don't ask again for: systemctl --user start demo.service"),
    row(2, "No"),
    "",
    ` ${footer}`,
    "",
  ].join("\n");
};

describe("interactive prompt answers", () => {
  const claudeQuestion = () => parseInteractivePrompt("claude", `
☐ Dataset

Which evaluation dataset should we use?

❯ 1. LM-O
  2. YCB-V
  3. T-LESS
  4. Type something.
────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`)!;

  test("rejects invalid answer shapes", () => {
    expect(() => answerKeys(claudeQuestion(), { option_index: 0, custom_text: "also" })).toThrow("Exactly one answer");
    expect(() => answerKeys(claudeQuestion(), { option_indices: [0] })).toThrow("requires one or more selections");
    expect(() => answerKeys(claudeQuestion(), { option_index: 99 })).toThrow("valid option index");
    expect(() => answerKeys(claudeQuestion(), { custom_text: 42 } as never)).toThrow("must be a string");
    expect(() => answerKeys(claudeQuestion(), { option_indices: null } as never)).toThrow("must be an array");
  });
});

describe("Claude's question with option previews", () => {
  // live-captured from Claude Code 2.1.288 in a 120-column herdr pane: the selected option's
  // preview is boxed to the right of the options, and the form has no "Type something" row
  const withPreview = `────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☐ Layout  ☐ Features  ✔ Submit  →

Which layout?

❯ 1. Grid                         ┌──────────────────────────────────────────┐
  2. List                         │ ┌──┐ ┌──┐                                │
                                  │ │  │ │  │                                │
                                  │ └──┘ └──┘                                │
                                  │ ┌──┐ ┌──┐                                │
                                  └──────────────────────────────────────────┘

                                  Notes: press n to add notes

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Chat about this

Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel
`;

  test("reads the options without the preview box and offers no typed answer", () => {
    const prompt = parseInteractivePrompt("claude", withPreview);
    expect(prompt).toMatchObject({
      kind: "question", title: "Layout · 1 of 2", question: "Which layout?",
      options: [{ label: "Grid", description: null }, { label: "List", description: null }],
      multi_select: false, custom_option_index: null,
    });
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(() => answerKeys(prompt!, { custom_text: "x" })).toThrow();
  });

});

describe("Claude's unnumbered menus", () => {
  // Claude Code 2.1.285 on a folder it has not seen, as herdr's pane read shows it (live)
  const trust = (selected: 0 | 1 = 0, after = "") => `
❯ claude --model claude-haiku-4-5-20251001

────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 /home/user/projects/new-app

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ${selected === 0 ? "❯" : " "} No, exit
 ${selected === 1 ? "❯" : " "} Yes, I trust this folder

 Enter to confirm · Esc to cancel
${after}`;

  test("answers from the native cursor, and keeps its id when only the cursor moves", () => {
    const prompt = parseInteractivePrompt("claude", trust())!;
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    const moved = parseInteractivePrompt("claude", trust(1))!;
    expect(moved.id).toBe(prompt.id);
    expect(answerKeys(moved, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
    expect(() => answerKeys(prompt, { custom_text: "maybe" })).toThrow();
  });

});

describe("the fallback card for a blocked pane no reader knows", () => {
  test("offers a numbered menu at the screen's end as options answered by their number", () => {
    const prompt = parseFallbackPrompt("cursor", `
 Apply these 3 file changes?
 src/a.ts, src/b.ts, src/c.ts

 › 1. Apply all
   2. Review each
   3. Discard

 ↵ choose · esc back
`);
    expect(prompt.kind).toBe("menu");
    expect(prompt.fallback).toBe(true);
    expect(prompt.question).toBe("Apply these 3 file changes?");
    expect(prompt.body).toBe("src/a.ts, src/b.ts, src/c.ts");
    expect(labels(prompt)).toEqual(["Apply all", "Review each", "Discard", "Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ text: "3" }]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ text: "1" }]);
    expect(() => answerKeys(prompt, { custom_text: "no" })).toThrow();
  });

});

describe("Claude's suggestion on a prompt poll", () => {
  /** a herdr with one Claude pane whose ANSI reads never answer */
  async function stalledAnsiHerdr(status: string, run: (reads: string[]) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "herdr-prompt-suggestion-"));
    const path = join(root, "herdr.sock");
    const reads: string[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        if (!input.includes("\n")) return;
        const request = JSON.parse(input.split("\n")[0]!) as { id: string; method: string; params: { format?: string } };
        const answer = (result: unknown) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
        if (request.method === "session.snapshot") {
          return answer({ snapshot: { panes: [{ pane_id: "p_1", agent: "claude", agent_status: status }], layouts: [] } });
        }
        if (request.method !== "pane.read") throw new Error(`unexpected fixture RPC: ${request.method}`);
        reads.push(request.params.format ?? "");
        if (request.params.format === "text") answer({ read: { text: "Done.\n\n────────\n❯ \n────────\n" } });
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    const previous = process.env["HERDR_SOCKET"];
    process.env["HERDR_SOCKET"] = path;
    try { await run(reads); } finally {
      if (previous === undefined) delete process.env["HERDR_SOCKET"];
      else process.env["HERDR_SOCKET"] = previous;
      for (const socket of sockets) socket.destroy();
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  async function poll(): Promise<{ body: unknown; ms: number }> {
    const url = new URL("http://127.0.0.1/api/pane/prompt?pane_id=p_1");
    const started = Date.now();
    const response = await handlePromptRequest(new Request(url), url);
    return { body: await response!.json(), ms: Date.now() - started };
  }

  test("answers without it once its read is late, rather than waiting on herdr", async () => {
    await stalledAnsiHerdr("idle", async (reads) => {
      const { body, ms } = await poll();
      expect(body).toEqual({ prompt: null, suggestion: null });
      expect(reads).toEqual(["text", "ansi"]);
      expect(ms).toBeLessThan(2_500);
    });
  }, 4_000);

  test("is not read while Claude works", async () => {
    await stalledAnsiHerdr("working", async (reads) => {
      const { body, ms } = await poll();
      expect(body).toEqual({ prompt: null, suggestion: null });
      expect(reads).toEqual(["text"]);
      expect(ms).toBeLessThan(1_000);
    });
  }, 4_000);
});

// The answer route against a herdr that only holds a screen: what the pane shows is the test's to
// change, between two reads or under an answer's own keys, and every key the route sends is kept.
describe("an answer and the menu it was made for", () => {
  interface Pane {
    agent: string; status: string; screen: string; sent: string[]; onSent?: (sent: string) => void;
    /** the pane's folder and its Codex rollout, for a prompt named by the agent's own call */
    cwd?: string; rollout?: string;
    /** how long herdr takes over each screen read from now on */
    readDelay?: number;
    onRead?: () => void;
    /** herdr never answers what it is asked about the pane's agent */
    agentUnanswered?: boolean;
    /** the next screen read alone answers with this, that much later */
    nextRead?: { text: string; delay: number };
    /** herdr presses this key and its reply is lost on the way */
    replyLostOn?: string;
    /** more panes showing the same screen: p_2 … */
    more?: number;
    /** the next snapshot alone takes this long */
    nextSnapshotDelay?: number;
    root: string;
  }

  async function withPane(agent: string, status: string, screen: string, run: (pane: Pane) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "herdr-prompt-answer-"));
    const path = join(root, "herdr.sock");
    const pane: Pane = { agent, status, screen, sent: [], root };
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        if (!input.includes("\n")) return;
        const request = JSON.parse(input.split("\n")[0]!) as { id: string; method: string; params: { keys?: string[]; text?: string } };
        const answer = (result: unknown) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
        const snapshotDelay = request.method === "session.snapshot" ? pane.nextSnapshotDelay : undefined;
        if (snapshotDelay !== undefined) pane.nextSnapshotDelay = undefined;
        if (request.method === "session.snapshot") return void setTimeout(() => answer({ snapshot: { panes: Array.from({ length: 1 + (pane.more ?? 0) }, (_, index) => ({ pane_id: `p_${index + 1}`, agent: pane.agent, agent_status: pane.status, cwd: pane.cwd })), layouts: [] } }), snapshotDelay ?? 0);
        if (request.method === "pane.read") {
          pane.onRead?.();
          const once = pane.nextRead;
          pane.nextRead = undefined;
          if (once) return void setTimeout(() => answer({ read: { text: once.text } }), once.delay);
          return void setTimeout(() => answer({ read: { text: pane.screen } }), pane.readDelay ?? 0);
        }
        // no Codex process runs here: the queue's rollout is looked for in the default store
        if (request.method === "pane.process_info") return answer({ process_info: { foreground_processes: [] } });
        if (request.method === "agent.get" && pane.agentUnanswered) return;
        if (request.method === "agent.get") return answer({ agent: pane.rollout ? { agent_session: { kind: "path", value: pane.rollout } } : {} });
        if (request.method !== "pane.send_keys" && request.method !== "pane.send_text") throw new Error(`unexpected fixture RPC: ${request.method}`);
        let lost = false;
        for (const sent of request.params.keys ?? [`text:${request.params.text}`]) {
          pane.sent.push(sent);
          pane.onSent?.(sent);
          lost ||= sent === pane.replyLostOn;
        }
        if (lost) return void socket.destroy();
        answer({});
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    const previous = process.env["HERDR_SOCKET"];
    process.env["HERDR_SOCKET"] = path;
    try { await run(pane); } finally {
      if (previous === undefined) delete process.env["HERDR_SOCKET"];
      else process.env["HERDR_SOCKET"] = previous;
      for (const socket of sockets) socket.destroy();
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  async function card(codexHome?: string, paneId = "p_1"): Promise<InteractivePrompt | null> {
    const url = new URL(`http://127.0.0.1/api/pane/prompt?pane_id=${paneId}`);
    return ((await (await handlePromptRequest(new Request(url), url, { codexHome }))!.json()) as { prompt: InteractivePrompt | null }).prompt;
  }

  async function answer(promptId: string, choice: { option_index?: number; option_indices?: number[]; custom_text?: string }, more: { signal?: AbortSignal; codexHome?: string } = {}): Promise<{ status: number; code?: string }> {
    const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
    const response = (await handlePromptRequest(new Request(url, { method: "POST", signal: more.signal, body: JSON.stringify({ pane_id: "p_1", prompt_id: promptId, ...choice }) }), url, { codexHome: more.codexHome }))!;
    const body = await response.json() as { error?: { code: string } };
    return { status: response.status, code: body.error?.code };
  }

  /** Codex's continue menu with its cursor on `at` */
  const menu = (rows: string[], at = 0, above = "Conversation interrupted") =>
    `${above}\n\n${rows.map((row, index) => `${index === at ? "›" : " "} ${index + 1}. ${row}`).join("\n")}\n\nPress enter to continue\n`;
  const RESUME = ["Resume the task", "Start over", "Quit"];
  const DELETE = ["Keep the branch", "Delete the branch", "Quit"];

  /** the pane as a menu would run it: ↓ and ↑ move the cursor, and the screen shows it */
  function moving(pane: Pane, rows: string[], draw: (at: number) => string = (at) => menu(rows, at), start = 0): void {
    let at = start;
    pane.onSent = (sent) => {
      if (sent === "down") at = Math.min(rows.length - 1, at + 1);
      if (sent === "up") at = Math.max(0, at - 1);
      // what is typed shows in the menu's own row
      pane.screen = draw(at) + (sent.startsWith("text:") ? `\n${sent.slice(5)}\n` : "");
    };
  }

  test("moves to the row and confirms it while the menu stays the card's", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      moving(pane, RESUME);
      const prompt = (await card())!;
      expect(labels(prompt)).toEqual(RESUME);
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "enter"]);
    });
  });

  /** Claude's question with option previews, its cursor on `at`: the box is redrawn for the option under it */
  const previewQuestion = (at: number): string => {
    const rows = ["Grid", "List"];
    const box = ["┌──────────────────┐", `│ ${rows[at]!.padEnd(16)} │`, "└──────────────────┘"];
    const option = (row: string, index: number) => `${index === at ? "❯" : " "} ${index + 1}. ${row.padEnd(20)}${box[index] ?? ""}`;
    return `${"─".repeat(80)}\n←  ☐ Layout  ✔ Submit  →\n\nWhich layout?\n\n${rows.map(option).join("\n")}\n${" ".repeat(25)}${box[2]}\n\n${" ".repeat(25)}Notes: press n to add notes\n\n${"─".repeat(80)}\n  Chat about this\n\nEnter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel\n`;
  };

  test("moves to a previewed option and confirms it while the box is redrawn for it", async () => {
    await withPane("claude", "blocked", previewQuestion(0), async (pane) => {
      moving(pane, ["Grid", "List"], previewQuestion);
      const prompt = (await card())!;
      expect(labels(prompt)).toEqual(["Grid", "List"]);
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "enter"]);
    });
  });

  test("waits out a screen caught half drawn after a move", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const prompt = (await card())!;
      // the ↓ clears the menu before it draws it again: a read in between finds no menu at all
      pane.onSent = (sent) => {
        if (sent !== "down") return;
        pane.screen = "";
        setTimeout(() => { pane.screen = menu(RESUME, 1); }, 80);
      };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "enter"]);
    });
  });

  test("presses no Enter into a menu that took the place of the card's under its moves", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const prompt = (await card())!;
      // answered in the terminal as the answer's ↓ went out, and another menu asks under it:
      // its second row, which the Enter would take, deletes a branch
      pane.onSent = () => { pane.screen = menu(DELETE, 1, "Branch cleanup"); };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  });

  test("presses no Enter on a row an arrow key typed in the terminal moved the cursor to", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = () => { pane.screen = menu(RESUME, 2); };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  });

  const QUESTION = (rows: string[], at: number) => `
☐ Dataset

Which evaluation dataset should we use?

${rows.map((row, index) => `${index === at ? "❯" : " "} ${index + 1}. ${row}`).join("\n")}
────────────────────────────
  ${rows.length + 1}. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
  const DATASETS = ["LM-O", "YCB-V", "Type something."];

  test("types a custom answer only into the question it was written for", async () => {
    await withPane("claude", "blocked", QUESTION(DATASETS, 0), async (pane) => {
      moving(pane, DATASETS, (at) => QUESTION(DATASETS, at));
      const prompt = (await card())!;
      expect(await answer(prompt.id, { custom_text: "the internal set" })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "text:the internal set", "enter"]);
    });
    await withPane("claude", "blocked", QUESTION(DATASETS, 0), async (pane) => {
      const prompt = (await card())!;
      // another question by the time the cursor is down: the text would be typed into its row
      pane.onSent = () => { pane.screen = QUESTION(["main", "release", "Type something."], 2); };
      expect(await answer(prompt.id, { custom_text: "the internal set" })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down", "down"]);
    });
  });

  const FOOTER = "\n────────────────────────────────────────\n/tmp/app\n0.0%/215k (auto)                                        some-model • medium\n";
  const dialog = (title: string, rows: string[], at: number) =>
    `────────────────────────────────────────\n\n ${title}\n\n${rows.map((row, index) => `${index === at ? " → " : "   "}${row}`).join("\n")}\n ↑↓ navigate  enter select  escape/ctrl+c cancel\n────────────────────────────────────────${FOOTER}`;
  const ALLOW = ["Allow once", "Always allow", "Block"];

  test("answers pi's dialog once its cursor is on the row, and no other dialog in its place", async () => {
    // pi stays idle while a dialog waits, and a dialog with its cursor off the first row has no card
    await withPane("pi", "idle", dialog("Allow dangerous command?", ALLOW, 0), async (pane) => {
      moving(pane, ALLOW, (at) => dialog("Allow dangerous command?", ALLOW, at));
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "enter"]);
    });
    await withPane("pi", "idle", dialog("Allow dangerous command?", ALLOW, 0), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = () => { pane.screen = dialog("Delete the session?", ["Keep it", "Delete it"], 1); };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  });

  test("presses no Enter once the asking ended under its moves, though the same menu shows again", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const prompt = (await card())!;
      // herdr reports the agent back at work as the ↓ goes out (answered in the terminal), and the
      // same menu is asked again with its cursor on the very row: the screen alone says nothing
      pane.onSent = () => { promptWaitEnded("p_1"); pane.screen = menu(RESUME, 1); };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
    await withPane("pi", "idle", dialog("Allow dangerous command?", ALLOW, 0), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = () => { promptWaitEnded("p_1"); pane.screen = dialog("Allow dangerous command?", ALLOW, 1); };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  });

  test("a read by another device while the answer redraws the menu ends no asking", async () => {
    await withPane("pi", "idle", dialog("Allow dangerous command?", ALLOW, 0), async (pane) => {
      const prompt = (await card())!;
      let at = 0;
      let polled: Promise<InteractivePrompt | null> | undefined;
      pane.onSent = (sent) => {
        if (sent === "down") at += 1;
        pane.screen = dialog("Allow dangerous command?", ALLOW, at);
        // pi's dialog with its cursor off the first row has no card: this poll reads none
        polled ??= card();
      };
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "enter"]);
      expect(await polled).toBeNull();
    });
  });

  test("starts nothing that cannot be undone for a request that was given up", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      moving(pane, RESUME);
      const prompt = (await card())!;
      const abort = new AbortController();
      const moved = pane.onSent!;
      pane.onSent = (sent) => { moved(sent); abort.abort(); };
      const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
      const response = (await handlePromptRequest(new Request(url, { method: "POST", signal: abort.signal, body: JSON.stringify({ pane_id: "p_1", prompt_id: prompt.id, option_index: 1 }) }), url))!;
      expect(response.status).toBe(409);
      expect(pane.sent).toEqual(["down"]);
    });
  });

  const OMP = (rows: string[], at: number, question = "Which target?") => `
╭─ Ask ───────────────────╮
│ ${question}
├─────────────────────────┤
${rows.map((row, index) => `│${index === at ? "❯" : " "} ○ ${row}`).join("\n")}
├─────────────────────────┤
│ Enter select · n note · ↑/↓ move · Esc cancel
╰─────────────────────────╯
`;
  const TARGETS = ["Jetson Orin", "RK3588", "Other (type your own)"];

  test("types omp's custom answer into the row its Enter opens", async () => {
    await withPane("omp", "blocked", OMP(TARGETS, 0), async (pane) => {
      let at = 0;
      pane.onSent = (sent) => {
        if (sent === "down") at += 1;
        // the row's Enter opens an editor no reader knows, and what is typed shows in it
        pane.screen = sent === "enter" ? "Other:\n> \n" : sent.startsWith("text:") ? `Other:\n> ${sent.slice(5)}\n` : OMP(TARGETS, at);
      };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { custom_text: "an x86 box" })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "enter", "text:an x86 box", "enter"]);
    });
  });

  const input = (question: string, typed = "") => `────────────────────────────────────────\n\n ${question}\n\n> ${typed}\n enter submit  escape/ctrl+c cancel\n────────────────────────────────────────${FOOTER}`;

  test("answers pi's text dialog", async () => {
    await withPane("pi", "idle", input("Branch name?"), async (pane) => {
      pane.onSent = (sent) => { if (sent.startsWith("text:")) pane.screen = input("Branch name?", sent.slice(5)); };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { custom_text: "fix/answers" })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["ctrl+k", "ctrl+u", "text:fix/answers", "enter"]);
    });
  });

  const CHECKS = (rows: string[], at: number, ticked: number[] = [], question = "Which checks should run?") => `
☐ Checks

${question}

${rows.map((row, index) => `${index === at ? "❯" : " "} ${index + 1}. ${index < rows.length - 1 ? `[${ticked.includes(index) ? "✓" : " "}] ` : ""}${row}`).join("\n")}
────────────────────────────
  ${rows.length + 1}. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
  const KINDS = ["Lint", "Tests", "Type something."];

  test("ticks a multiple choice row by row", async () => {
    await withPane("claude", "blocked", CHECKS(KINDS, 0), async (pane) => {
      let at = 0;
      const ticked: number[] = [];
      pane.onSent = (sent) => { if (sent === "down") at += 1; if (sent === "enter") ticked.push(at); pane.screen = CHECKS(KINDS, at, ticked); };
      const prompt = (await card())!;
      expect(prompt.multi_select).toBe(true);
      expect(await answer(prompt.id, { option_indices: [0, 1] })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["enter", "down", "enter", "right"]);
    });
  });

  // This route looks at the screen before the first key that is not a move, and never after it:
  // from there on an answer's keys are the ones it always sent, whatever the screen shows.
  test("after its first key that is not a move, an answer sends the rest of its keys unseen", async () => {
    const cases: { agent: string; status: string; screen: string; choice: Parameters<typeof answer>[1] }[] = [
      { agent: "claude", status: "blocked", screen: QUESTION(DATASETS, 2), choice: { custom_text: "the internal set" } },
      { agent: "claude", status: "blocked", screen: CHECKS(KINDS, 0), choice: { option_indices: [0, 1] } },
      { agent: "pi", status: "idle", screen: input("Branch name?"), choice: { custom_text: "fix/answers" } },
      { agent: "omp", status: "blocked", screen: OMP(TARGETS, 2), choice: { custom_text: "an x86 box" } },
    ];
    for (const { agent, status, screen, choice } of cases) {
      await withPane(agent, status, screen, async (pane) => {
        // what the answer's keys are, as main sends them
        const keys = answerKeys(parseInteractivePrompt(agent, screen)!, choice).flatMap((step) => step.keys ?? [`text:${step.text}`]);
        expect(keys.length).toBeGreaterThan(1);
        const prompt = (await card())!;
        // the screen is something else from the first key on
        pane.onSent = () => { pane.screen = "Working…\n"; };
        expect(await answer(prompt.id, choice)).toEqual({ status: 200, code: undefined });
        expect(pane.sent).toEqual(keys);
      });
    }
  });

  test("leaves Codex's queue alone while the question just answered is still on the screen", async () => {
    const open = "\n• Queued follow-up inputs\n  Which split?\n  › 1. train\n    2. test\n    3. Other\n  enter submit   ctrl+] skip   alt+↓ main prompt\n";
    await withPane("codex", "working", open, async (pane) => {
      // Codex takes the Enter a moment later: the question is still drawn at the first look,
      // then the main prompt has the input back, with nothing left to close
      pane.onSent = (sent) => { if (sent === "enter") setTimeout(() => { pane.screen = "› Ask Codex to do anything\n"; }, 150); };
      const prompt = (await card())!;
      expect(prompt.queued).toBe("open");
      expect(await answer(prompt.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["enter"]);
    });
  });

  test("Codex back at work says nothing about a question in its queue", async () => {
    const open = "\n• Queued follow-up inputs\n  Which split?\n  › 1. train\n    2. test\n    3. Other\n  enter submit   ctrl+] skip   alt+↓ main prompt\n";
    await withPane("codex", "working", open, async (pane) => {
      let at = 0;
      pane.onSent = (sent) => {
        if (sent === "down") { at += 1; pane.screen = open.replace("› 1. train\n    2. test", "  1. train\n  › 2. test"); }
        // Codex asks while it works, and herdr reports it working again under the answer's move
        promptWaitEnded("p_1");
        if (sent === "enter") pane.screen = "› Ask Codex to do anything\n";
      };
      const prompt = (await card())!;
      promptWaitEnded("p_1");
      expect((await card())!.id).toBe(prompt.id);
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(at).toBe(1);
      expect(pane.sent).toEqual(["down", "enter"]);
    });
  });

  test("sends nothing for a request given up before its turn, even to the row the cursor is on", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const prompt = (await card())!;
      const abort = new AbortController();
      abort.abort();
      expect((await answer(prompt.id, { option_index: 0 }, { signal: abort.signal })).status).toBe(409);
      expect(pane.sent).toEqual([]);
    });
    // and a fallback card's single key
    await withPane("gjc", "blocked", "Which environment?\n\n  1. Staging\n  2. Production\n\nEnter a number, or Esc to cancel\n", async (pane) => {
      const prompt = (await card())!;
      expect(prompt.fallback).toBe(true);
      const abort = new AbortController();
      abort.abort();
      expect((await answer(prompt.id, { option_index: 0 }, { signal: abort.signal })).status).toBe(409);
      expect(pane.sent).toEqual([]);
    });
  });

  // An ordinary answer that needs a move, on a screen drawn again the way each agent draws it
  // with the cursor on another row: every reader must still know its own menu there.
  describe("moves to a row that is not the cursor's and answers it", () => {
    const mark = (at: number, row: number, on = "❯") => at === row ? on : " ";
    const cases: { name: string; agent: string; status?: string; rows: number; start?: number; draw: (at: number, ticked: number[]) => string; choice: Parameters<typeof answer>[1]; sent: string[] }[] = [
      {
        name: "omp's permission: Deny", agent: "omp", rows: 2, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `\n╭─ Permission ────────────╮\n│ Allow tool: bash        │\n│ curl -I example.com     │\n│${mark(at, 0)} Approve               │\n│${mark(at, 1)} Deny                  │\n╰─────────────────────────╯\n`,
      },
      {
        name: "omp's question", agent: "omp", rows: 3, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => OMP(TARGETS, at),
      },
      {
        name: "omp's multiple choice", agent: "omp", rows: 4, choice: { option_indices: [0, 2] }, sent: ["space", "down", "down", "space", "tab", "enter"],
        draw: (at, ticked) => `\n╭─ Ask ───────────────────╮\n│ Which checks?           │\n├─────────────────────────┤\n${["Lint", "Tests", "Build", "Other (type your own)"].map((row, index) => `│${mark(at, index)} ${ticked.includes(index) ? "☑" : "☐"} ${row}`).join("\n")}\n├─────────────────────────┤\n│ Space/Enter toggle · n note · ↑/↓ move · Tab/←/→ · Esc cancel\n╰─────────────────────────╯\n`,
      },
      {
        name: "Codex's approval", agent: "codex", rows: 3, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `\nWould you like to run the following command?\necho first\n${mark(at, 0, "›")} 1. Yes, proceed\n${mark(at, 1, "›")} 2. Yes, and don't ask again for this command\n${mark(at, 2, "›")} 3. No, cancel\nPress enter to confirm or esc to cancel\n`,
      },
      {
        name: "Codex's question", agent: "codex", rows: 3, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `\nWhich backend?\n\n${mark(at, 0, "›")} 1. CUDA\n${mark(at, 1, "›")} 2. CPU\n${mark(at, 2, "›")} 3. None of the above  Add details in notes (tab).\n\ntab to add notes | enter to submit answer | esc to interrupt\n`,
      },
      {
        name: "Claude's approval, to its last row", agent: "claude", rows: 3, choice: { option_index: 2 }, sent: ["down", "down", "enter"],
        draw: (at) => `\nBash command\n\n  curl -I https://example.com\n  Fetch HTTP headers.\n\nThis command requires approval\n\nDo you want to proceed?\n${mark(at, 0)} 1. Yes\n${mark(at, 1)} 2. Yes, and don’t ask again for: curl *\n${mark(at, 2)} 3. No\n\nEsc to cancel · Tab to amend · ctrl+e to explain\n`,
      },
      {
        name: "Claude's plan", agent: "claude", rows: 4, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `\nReady to code?\n\nHere is Claude's plan:\nAdd a heading to the README file.\n\nClaude has written up a plan and is ready to execute. Would you like to proceed?\n\n${mark(at, 0)} 1. Yes, auto-accept edits\n${mark(at, 1)} 2. Yes, manually approve edits\n${mark(at, 2)} 3. No, refine with Ultraplan on Claude Code on the web\n${mark(at, 3)} 4. Tell Claude what to change\n     shift+tab to approve with this feedback\n`,
      },
      {
        name: "Claude's review of its answers: Cancel", agent: "claude", rows: 2, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `\n←  ☒ Route  ☒ Author  ✔ Submit  →\nReview your answers\n ● Which way should the PR go?\n   → Log in as owner\n ● Who should author the commits?\n   → Repo owner\nReady to submit your answers?\n${mark(at, 0)} 1. Submit answers\n${mark(at, 1)} 2. Cancel\n`,
      },
      {
        name: "Claude's folder-trust check", agent: "claude", rows: 2, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `\n Accessing workspace:\n\n /home/user/projects/new-app\n\n Quick safety check: Is this a project you created or one you trust?\n\n ${mark(at, 0)} No, exit\n ${mark(at, 1)} Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n`,
      },
      {
        name: "pi's confirmation: No", agent: "pi", status: "idle", rows: 2, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `────────────────────────────────────────\n\n Clear session?\n All messages will be lost.\n\n${[" Yes", " No"].map((row, index) => `${at === index ? " →" : "  "}${row}`).join("\n")}\n ↑↓ navigate  enter select  escape/ctrl+c cancel\n────────────────────────────────────────${FOOTER}`,
      },
      {
        name: "pi's model list", agent: "pi", status: "idle", rows: 2, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `────────────────────────────────────────\n\nOnly showing models from configured providers. Use /login to add providers.\n>\n\n${at === 0 ? "→" : " "} ✓ vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default\n${at === 1 ? "→" : " "}   vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]\n Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel\n────────────────────────────────────────${FOOTER}`,
      },
    ];
    for (const { name, agent, status = "blocked", rows, start = 0, draw, choice, sent } of cases) {
      test(name, async () => {
        await withPane(agent, status, draw(start, []), async (pane) => {
          let at = start;
          const ticked: number[] = [];
          pane.onSent = (key) => {
            if (key === "down") at = Math.min(rows - 1, at + 1);
            if (key === "up") at = Math.max(0, at - 1);
            if (key === "space") ticked.push(at);
            pane.screen = draw(at, ticked);
          };
          const prompt = (await card())!;
          expect(prompt).not.toBeNull();
          expect(await answer(prompt.id, choice)).toEqual({ status: 200, code: undefined });
          expect(pane.sent).toEqual(sent);
        });
      });
    }
  });

  test("answers Claude's second option after redrawing its background-agent footer", async () => {
    await withPane("claude", "blocked", claudeBackgroundApproval(0), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = (sent) => {
        if (sent === "down") pane.screen = claudeBackgroundApproval(1);
      };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "enter"]);
      expect(pane.sent.some((sent) => sent.startsWith("text:") || /^\d+$/.test(sent))).toBe(false);
    });
  });

  test("a screen read that comes back after the wait authorises no key", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      moving(pane, RESUME);
      const prompt = (await card())!;
      const moved = pane.onSent!;
      pane.onSent = (sent) => { moved(sent); pane.readDelay = 1_800; };
      const started = Date.now();
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
      // cut off when the wait is over, not waited out
      expect(Date.now() - started).toBeLessThan(1_790);
    });
  }, 6_000);

  test("a lookup that herdr never answers is cut off with the wait", async () => {
    const collapsed = "\n• WAITING\n• Queued follow-up inputs\n  ? 1 question · 8s\n    alt+↑ to answer\n› Ask Codex to do anything\n  GPT-6-Sol xhigh · ~/lab · Context 97% left\n";
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      pane.cwd = pane.root;
      const prompt = (await card())!;
      // under the move the screen is Codex's collapsed queue, whose card needs the pane's
      // rollout, and herdr does not say which one it is
      pane.onSent = () => { pane.agentUnanswered = true; pane.screen = collapsed; };
      const started = Date.now();
      expect((await answer(prompt.id, { option_index: 1 })).status).toBe(409);
      expect(pane.sent).toEqual(["down"]);
      expect(Date.now() - started).toBeLessThan(2_500);
    });
  }, 6_000);

  test("answers pi's text dialog on a herdr whose screen reads take 400 ms", async () => {
    await withPane("pi", "idle", input("Branch name?"), async (pane) => {
      pane.onSent = (sent) => { if (sent.startsWith("text:")) pane.screen = input("Branch name?", sent.slice(5)); };
      const prompt = (await card())!;
      pane.readDelay = 400;
      expect(await answer(prompt.id, { custom_text: "fix/answers" })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["ctrl+k", "ctrl+u", "text:fix/answers", "enter"]);
    });
  }, 10_000);

  test("goes on ticking a multiple choice whose descriptions a narrowed pane wraps", async () => {
    const described = (at: number, ticked: number[], narrow: boolean) => `
☐ Checks

Which checks should run?

${at === 0 ? "❯" : " "} 1. [${ticked.includes(0) ? "✓" : " "}] Lint
     ${narrow ? "Run the linters over\n     the whole repository" : "Run the linters over the whole repository"}
${at === 1 ? "❯" : " "} 2. [${ticked.includes(1) ? "✓" : " "}] ${narrow ? "Tests, unit and\n     integration" : "Tests, unit and integration"}
     ${narrow ? "Run every suite, which takes\n     about ten minutes" : "Run every suite, which takes about ten minutes"}
${at === 2 ? "❯" : " "} 3. Type something.
────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
    await withPane("claude", "blocked", described(0, [], false), async (pane) => {
      let at = 0;
      const ticked: number[] = [];
      // the pane is narrowed as the first tick goes out: the same options, wrapped
      pane.onSent = (sent) => { if (sent === "down") at += 1; if (sent === "enter") ticked.push(at); pane.screen = described(at, ticked, true); };
      const prompt = (await card())!;
      expect(prompt.options[0]!.description).toBe("Run the linters over the whole repository");
      expect(await answer(prompt.id, { option_indices: [0, 1] })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["enter", "down", "enter", "right"]);
    });
  });

  test("answers a question of Codex's collapsed queue, and opens no queue for a request given up", async () => {
    const collapsed = "\n• WAITING\n• Queued follow-up inputs\n  ? 2 questions · 8s\n    alt+↑ to answer\n› Ask Codex to do anything\n  GPT-6-Sol xhigh · ~/lab · Context 97% left\n";
    const open = (at: number) => `\n• Queued follow-up inputs\n  1 of 2\n  Which split?\n  ${at === 0 ? "›" : " "} 1. train\n  ${at === 1 ? "›" : " "} 2. test\n  ${at === 2 ? "›" : " "} 3. Other\n  enter submit   ctrl+] skip   alt+↓ main prompt\n`;
    const item = (payload: unknown) => `${JSON.stringify({ type: "response_item", payload })}\n`;
    const ask = (call: string, count = 1) => item({ type: "function_call", name: "request_user_input_async", call_id: call, arguments: JSON.stringify({ questions: Array.from({ length: count }, () => ({ title: "Which split?", options: ["train", "test"] })) }) });
    await withPane("codex", "working", collapsed, async (pane) => {
      const home = join(pane.root, "codex");
      mkdirSync(join(home, "sessions"), { recursive: true });
      pane.rollout = join(home, "sessions", "rollout.jsonl");
      pane.cwd = pane.root;
      // one call asks the same question twice: the card is the first of the two
      writeFileSync(pane.rollout, `${JSON.stringify({ type: "session_meta", payload: { id: "t", source: "cli" } })}\n${ask("call_1", 2)}`);
      const queued = (await card(home))!;
      expect(queued.queued).toBe("collapsed");
      // another terminal client opens the queue between this answer's first read and its read
      // before alt+↑: the answer is refused, and the queue it did not open is not its to close
      let reads = 0;
      pane.onRead = () => { reads += 1; if (reads === 2) pane.screen = open(0); };
      expect(await answer(queued.id, { option_index: 1 }, { codexHome: home })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
      pane.screen = collapsed;
      pane.onRead = undefined;
      // refused with nothing sent, the card is still the one that was read
      expect((await card(home))!.id).toBe(queued.id);
      // a request given up while the screen is read before alt+↑ (the answer's second read,
      // after the one that finds the card) opens no queue
      const abort = new AbortController();
      reads = 0;
      pane.onRead = () => { reads += 1; if (reads === 2) abort.abort(); };
      expect((await answer(queued.id, { option_index: 1 }, { signal: abort.signal, codexHome: home })).status).toBe(409);
      expect(pane.sent).toEqual([]);
      pane.onRead = undefined;
      // given up with nothing sent: the same card still
      expect((await card(home))!.id).toBe(queued.id);
      let at = 0;
      pane.onSent = (sent) => {
        if (sent === "alt+up") pane.screen = open(0);
        if (sent === "down") {
          at += 1;
          // the rollout catches up under the answer: another call asking the same thing
          appendFileSync(pane.rollout!, ask("call_2"));
          pane.screen = open(at);
        }
        if (sent === "enter") pane.screen = "› Ask Codex to do anything\n";
      };
      // neither the twin nor the rollout's news under the answer is a reason to refuse: the
      // question on the screen is the card's
      expect(await answer(queued.id, { option_index: 1 }, { codexHome: home })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["alt+up", "down", "enter"]);

      // The queue opens on another question than the card's, and the alt+↓ that closes it
      // again is pressed with its reply lost; another client has the queue open after that.
      // This request closes it no second time
      pane.sent.length = 0;
      pane.screen = collapsed;
      const later = (await card(home))!;
      const other = open(0).replace("Which split?", "Which metric?");
      pane.replyLostOn = "alt+down";
      pane.onSent = (sent) => { pane.screen = sent === "alt+up" || sent === "alt+down" ? other : pane.screen; };
      expect((await answer(later.id, { option_index: 0 }, { codexHome: home })).status).not.toBe(200);
      expect(pane.sent).toEqual(["alt+up", "alt+down"]);
    });
  });

  test("a key herdr may have pressed, its reply lost, has ended the asking", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const first = (await card())!;
      pane.replyLostOn = "enter";
      // herdr pressed the Enter and the answer never heard so: the route fails
      expect((await answer(first.id, { option_index: 0 })).status).not.toBe(200);
      expect(pane.sent).toEqual(["enter"]);
      pane.replyLostOn = undefined;
      // the same menu asked again is another asking: the old card's id answers nothing
      expect((await card())!.id).not.toBe(first.id);
      expect(await answer(first.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["enter"]);
    });
  });

  test("a key that never reached herdr has ended nothing", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const first = (await card())!;
      // herdr is gone between the answer's read and its Enter: nothing is pressed
      const socket = process.env["HERDR_SOCKET"]!;
      pane.onRead = () => { process.env["HERDR_SOCKET"] = join(pane.root, "gone.sock"); };
      try {
        expect((await answer(first.id, { option_index: 0 })).status).toBe(502);
      } finally { process.env["HERDR_SOCKET"] = socket; }
      pane.onRead = undefined;
      expect(pane.sent).toEqual([]);
      // the card is still the one to answer, with whatever was picked in it
      expect((await card())!.id).toBe(first.id);
    });
  });

  test("a read held up before its screen read ends the asking its empty screen shows", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const first = (await card())!;
      // another device's read waits on herdr's snapshot
      pane.nextSnapshotDelay = 300;
      const held = card();
      // meanwhile an answer begins and is given up, with nothing sent
      const abort = new AbortController();
      pane.onRead = () => abort.abort();
      expect((await answer(first.id, { option_index: 0 }, { signal: abort.signal })).status).toBe(409);
      pane.onRead = undefined;
      expect(pane.sent).toEqual([]);
      // the menu is answered in the terminal: the held read finds no prompt, and says so
      pane.screen = "Working…\n";
      pane.status = "working";
      expect(await held).toBeNull();
      // asked again as it was, it is another asking
      pane.screen = menu(RESUME);
      pane.status = "blocked";
      expect((await card())!.id).not.toBe(first.id);
    });
  });

  test("a read that began under an answer and comes back after it changes nothing", async () => {
    await withPane("pi", "idle", input("Branch name?"), async (pane) => {
      const prompt = (await card())!;
      let late: Promise<InteractivePrompt | null> | undefined;
      pane.onSent = (sent) => {
        // another device reads the pane as the answer empties the line, catches the screen
        // between two draws, and herdr is slow to say so
        if (sent === "ctrl+k") { pane.nextRead = { text: "", delay: 400 }; late = card(); }
        if (sent.startsWith("text:")) pane.screen = input("Branch name?", sent.slice(5));
        if (sent === "enter") pane.screen = input("Delete which branch?");
      };
      expect(await answer(prompt.id, { custom_text: "fix/answers" })).toEqual({ status: 200, code: undefined });
      // the next dialog has its card before that read is back
      const next = (await card())!;
      expect(next.question).toBe("Delete which branch?");
      expect(await late!).toBeNull();
      // and it is still that card: the late read ended no asking
      expect((await card())!.id).toBe(next.id);
      pane.onSent = undefined;
      expect((await answer(next.id, { custom_text: "old/one" })).status).toBe(200);
    });
  });

  test("an asking is kept however many panes ask", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      pane.more = 257;
      const first = (await card())!;
      for (let index = 2; index <= 258; index += 1) expect(await card(undefined, `p_${index}`)).not.toBeNull();
      expect((await card())!.id).toBe(first.id);
    });
  }, 20_000);

  test("a prompt keeps its id from read to read while it waits", async () => {
    await withPane("codex", "blocked", menu(RESUME), async () => {
      const first = (await card())!;
      expect((await card())!.id).toBe(first.id);
      // and it is not the hash of its text alone
      expect(first.id).not.toBe(parseInteractivePrompt("codex", menu(RESUME))!.id);
    });
  });

  test("refuses an answer to a prompt that went away and was asked again", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const first = (await card())!;
      // answered in the terminal: a read finds no menu, then the same menu asked again
      pane.screen = "Working…\n";
      pane.status = "working";
      expect(await card()).toBeNull();
      pane.screen = menu(RESUME);
      pane.status = "blocked";
      const second = (await card())!;
      expect(labels(second)).toEqual(labels(first));
      expect(second.id).not.toBe(first.id);
      // the first asking's card, still open on another device (or its typed pick's Confirm)
      expect(await answer(first.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
      expect(await answer(second.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["enter"]);
    });
  });

  test("refuses a second answer to the id of a prompt already answered, the same one asked again", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const first = (await card())!;
      // the screen never changes: answered, the menu is asked again as it was
      expect(await answer(first.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(await answer(first.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["enter"]);
      expect((await card())!.id).not.toBe(first.id);
    });
  });

  test("refuses an answer to a prompt asked again after the agent went back to work unseen", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const first = (await card())!;
      // answered in the terminal and asked again between two reads: only herdr's status says so
      promptWaitEnded("p_1");
      expect(await answer(first.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
      expect((await card())!.id).not.toBe(first.id);
    });
  });

  test("logs prompt answer requests with pane_id, prompt_matched and outcome", async () => {
    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    try {
      await withPane("codex", "blocked", menu(RESUME), async (pane) => {
        const prompt = (await card())!;
        logged.length = 0;
        expect(await answer(prompt.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
        expect(logged.some((line) => line.includes("[prompt/answer]") && line.includes("pane=\"p_1\"") && line.includes("prompt_matched=true") && line.includes("outcome=ok"))).toBe(true);
        logged.length = 0;
        expect(await answer(prompt.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
        expect(logged.some((line) => line.includes("[prompt/answer]") && line.includes("pane=\"p_1\"") && line.includes("prompt_matched=false") && line.includes("outcome=prompt_changed"))).toBe(true);
        // the pane id is the client's until the snapshot has checked it: no newline or escape of it reaches the log
        logged.length = 0;
        const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
        const forged = "p_1\nFORGED \u001b[2J prompt_matched=true outcome=ok";
        const response = (await handlePromptRequest(new Request(url, { method: "POST", body: JSON.stringify({ pane_id: forged, prompt_id: prompt.id, option_index: 0 }) }), url, {}))!;
        expect(response.ok).toBe(false);
        const line = logged.find((entry) => entry.includes("[prompt/answer]"));
        expect(line).toBeDefined();
        expect(line!.includes("\n")).toBe(false);
        expect(line!.includes("\u001b")).toBe(false);
        // the forged fields stay inside the quoted id; the line's own fields follow it
        if (!line!.includes(`pane=${JSON.stringify(forged)} prompt_matched=false outcome=`)) throw new Error(`unexpected log line: ${line}`);
      });
    } finally { console.log = originalLog; }
  });
});

describe("Claude's multiple choice ticked in the terminal", () => {
  const screen = (ticked: boolean, at: "A" | "B" | "Submit" | "Chat") => [
    `←  ${ticked ? "☒" : "☐"} Pick  ✔ Submit  →`,
    "Which ones?",
    `${at === "A" ? "❯" : " "} 1. [${ticked ? "✔" : " "}] Option A`,
    "         First description",
    `${at === "B" ? "❯" : " "} 2. [${ticked ? "✔" : " "}] Option B`,
    "         Second description",
    "  3. [ ] Type something",
    `${at === "Submit" ? "❯" : " "}    Submit`,
    "─".repeat(40),
    `${at === "Chat" ? "❯" : " "} 4. Chat about this`,
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");

  test("regression: takes no typed answer where the card offers none, its Submit row out of view", () => {
    const cut = screen(false, "A").split("\n").filter((line) => line.trim() !== "Submit").join("\n");
    const prompt = parseInteractivePrompt("claude", cut)!;
    expect(prompt).toMatchObject({ multi_select: true, custom_option_index: null });
    expect(() => answerKeys(prompt, { custom_text: "Kiwi" })).toThrow("does not accept a custom answer");
  });

});

