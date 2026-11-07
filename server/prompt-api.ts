import { createHash, randomBytes } from "node:crypto";

import type { HerdrPane, InteractivePrompt, PromptAnswer } from "../shared/protocol.ts";
import { codexTranscriptPath, paneCodexHome, unansweredCodexQuestions } from "./codex.ts";
import { HerdrError, paneRead, paneSendKeys, paneSendText, sessionSnapshot } from "./herdr/client.ts";
import { badRequest, errorResponse, jsonResponse } from "./http.ts";
import {
  answerKeys, codexQueuedPrompt, codexQuestionsCollapsed, InvalidAnswer, KEY, parseClaudeSuggestion, parsedByPublicPrompt,
  parseFallbackPrompt, parseInteractivePrompt, parsePiDialog, parsePrompt, promptTailIsActive, publicPrompt, queuedQuestionCount,
  sameText, type AnswerStep, type ParsedPrompt, type QueueFront,
} from "./prompt.ts";

/**
 * The panes whose current wait on an unknown screen is logged: once per wait, not per screen,
 * so a screen that keeps changing (a clock, a spinner) cannot log on every poll.
 */
const fallbackLogged = new Set<string>();
/** panes whose wait is logged at most; past it a new wait goes unlogged rather than relogging one */
const FALLBACK_LOGGED_MAX = 256;

/**
 * The question each pane's queue opened on when that was not the card's (a skipped
 * question leaves the rollout's newest-first guess behind): the next card shows it.
 */
const queueFronts = new Map<string, QueueFront & { rollout: string }>();

/**
 * Which asking of its prompt each pane shows. A prompt's own id is a hash of what it says, so the
 * same question asked twice in a row would be one card: an answer tapped for the first asking (or
 * a typed pick left waiting for Confirm) would go to the second. The id a card carries therefore
 * names the asking too, and a
 * new asking starts on any evidence that the last one ended: a read that showed no prompt or
 * another one, an answer sent from here, the agent back at work. With none of these (answered in
 * a terminal and asked again between two reads, by an agent that reports no work in between)
 * two askings cannot be told apart from the screen.
 */
interface Asking { content: string | null; n: number; queued: boolean }
const askings = new Map<string, Asking>();
/** counted across panes and never reused: a pane forgotten here starts no asking over */
let askingCount = 0;
/** this run of the server: a card read before a restart is not one of this run's askings */
const SERVER_RUN = randomBytes(6).toString("hex");
/**
 * The panes an answer is on its way to. Its keys redraw the menu (a move, a row opened for typing,
 * pi's dialog with its cursor off the first row), so what another read finds meanwhile says
 * nothing about the asking: it neither ends it nor starts one. The answer reads the screen
 * itself before its first key that is not a move, and promptWaitEnded still ends the asking
 * under it.
 */
const answersUnderWay = new Set<string>();
/**
 * How many answers have begun or ended on each pane. A read takes its time: one that began
 * before or under an answer and comes back after it shows a screen of that answer's, not of now,
 * so a read during which this number moved changes nothing either.
 */
const answerTurns = new Map<string, number>();

/**
 * The prompt a read found, under the id of its asking; a read without one ends the pane's asking.
 * `turns`: the pane's answerTurns when the read began.
 */
function asked(paneId: string, prompt: InteractivePrompt | null, turns: number): InteractivePrompt | null {
  let asking = askings.get(paneId);
  if (!answersUnderWay.has(paneId) && (answerTurns.get(paneId) ?? 0) === turns) {
    if (prompt === null) {
      if (asking) asking.content = null;
      return null;
    }
    if (asking?.content !== prompt.id) {
      // kept until its pane closes (readPrompt): a live asking is never dropped to make room
      asking = { content: prompt.id, n: askingCount += 1, queued: prompt.queued !== undefined };
      askings.set(paneId, asking);
    }
  }
  if (prompt === null) return null;
  prompt.id = createHash("sha256").update(JSON.stringify([prompt.id, SERVER_RUN, asking?.n ?? 0])).digest("hex").slice(0, 12);
  return prompt;
}

/** The pane's prompt was answered: the same prompt on its screen after this is asked anew. */
function askingEnded(paneId: string): void {
  const asking = askings.get(paneId);
  if (asking) asking.content = null;
}

/**
 * The pane's agent is back at work: it has had its answer, maybe from a terminal, and the same
 * prompt on its screen after this is asked anew. Not so for a question in Codex's queue, which
 * Codex asks while it works and goes on working under: its status says nothing about the
 * question.
 */
export function promptWaitEnded(paneId: string): void {
  if (!askings.get(paneId)?.queued) askingEnded(paneId);
}

/** A prompt's id as its text alone makes it, whichever asking it is. */
function contentId(prompt: InteractivePrompt | null): string | undefined {
  return prompt ? parsedByPublicPrompt.get(prompt)?.id : undefined;
}

/** Each pane's rollout, resolved for its collapsed queue: a poll every 2s would otherwise redo it. */
const queueRollouts = new Map<string, { path: string | null; at: number }>();
const QUEUE_ROLLOUT_MS = 15_000;

/** how long a prompt poll waits for the ANSI read behind Claude's suggestion before going without it */
const SUGGESTION_READ_MS = 1_500;

async function readPrompt(paneId: string, codexHome?: string): Promise<{ agent: string; status: string; prompt: InteractivePrompt | null; pane: HerdrPane }> {
  const { panes } = await sessionSnapshot();
  // a closed pane's wait has ended too
  for (const logged of fallbackLogged) if (!panes.some((candidate) => candidate.pane_id === logged)) fallbackLogged.delete(logged);
  for (const known of askings.keys()) if (!panes.some((candidate) => candidate.pane_id === known)) askings.delete(known);
  for (const known of answerTurns.keys()) if (!panes.some((candidate) => candidate.pane_id === known)) answerTurns.delete(known);
  const pane = panes.find((candidate) => candidate.pane_id === paneId);
  if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
  const agent = pane.agent ?? "";
  const status = pane.agent_status;
  // counted right before the screen is read, after the snapshot: what matters is whether an
  // answer ran while the screen was being read
  const turns = answerTurns.get(paneId) ?? 0;
  const known = await readKnownPrompt(paneId, pane, agent, codexHome);
  if (known.prompt !== null || status !== "blocked" || !agent) {
    fallbackLogged.delete(paneId);
    return { agent, status, prompt: asked(paneId, known.prompt, turns), pane };
  }
  // herdr says the agent waits on the user and no reader knows the screen: the fallback card
  const screen = known.screen ?? await liveScreen(paneId);
  // Codex's collapsed question queue reads blocked while its main prompt takes a message
  if (agent === "codex" && codexQuestionsCollapsed(screen)) {
    fallbackLogged.delete(paneId);
    return { agent, status, prompt: asked(paneId, null, turns), pane };
  }
  const prompt = asked(paneId, parseFallbackPrompt(agent, screen), turns)!;
  if (!fallbackLogged.has(paneId) && fallbackLogged.size < FALLBACK_LOGGED_MAX) {
    fallbackLogged.add(paneId);
    console.warn(`prompt: ${agent} pane ${paneId} is blocked on a screen no reader knows; fallback card (${prompt.options.length} options)`);
  }
  return { agent, status, prompt, pane };
}

/**
 * The pane's live screen as text: herdr's bottom screen, whatever part of the history the pane's
 * viewport shows. A pane scrolled up (a drag or the wheel in a terminal) stays scrolled while the
 * agent draws its next menu at the bottom, out of that viewport. herdr 0.9.1 fills it for a
 * shell, a reported agent, a scrolled pane and an alternate screen alike; the pane's
 * `screen_detection_skipped` is about the agent's state, not this read.
 */
export async function liveScreen(paneId: string): Promise<string> {
  return (await paneRead({ paneId, source: "detection", format: "text" })).text;
}

async function readKnownPrompt(
  paneId: string,
  pane: { cwd?: string | null },
  agent: string,
  codexHome?: string,
): Promise<{ prompt: InteractivePrompt | null; screen?: string }> {
  if (!["claude", "omp", "codex", "pi", ""].includes(agent)) return { prompt: null };
  const screen = await liveScreen(paneId);
  const prompt = parseInteractivePrompt(agent, screen);
  const count = agent === "codex" && prompt === null ? queuedQuestionCount(screen) : 0;
  if (count === 0 || !pane.cwd) return { prompt, screen };
  let rollout = queueRollouts.get(paneId);
  if (!rollout || Date.now() - rollout.at > QUEUE_ROLLOUT_MS) {
    rollout = { path: await codexTranscriptPath(paneId, pane.cwd, await paneCodexHome(paneId, codexHome)), at: Date.now() };
    queueRollouts.set(paneId, rollout);
    if (queueRollouts.size > 64) queueRollouts.delete(queueRollouts.keys().next().value!);
  }
  try {
    // a question remembered from another rollout (a new session) means nothing here
    const front = queueFronts.get(paneId);
    if (front && front.rollout !== rollout.path) queueFronts.delete(paneId);
    return {
      prompt: rollout.path ? codexQueuedPrompt(screen, await unansweredCodexQuestions(rollout.path), front?.rollout === rollout.path ? front : null) : null,
      screen,
    };
  } catch {
    return { prompt: null, screen }; // the rollout went away
  }
}

/**
 * After an answer from the chat: if Codex opened its next question, close the queue, so
 * the main prompt has the input back. Only once another question shows (`answered` is the
 * id of the one just answered, which can still be on screen for a moment). alt+↓ elsewhere,
 * on the main prompt or an approval, changes nothing (checked on Codex 0.156.1).
 */
async function closeQueue(paneId: string, answered: string): Promise<void> {
  const since = Date.now();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await Bun.sleep(100);
    const screen = await liveScreen(paneId);
    const shown = parsePrompt("codex", screen);
    if (shown?.responder === "codex-async-question") {
      // the question just answered, a moment ago; still there after 600ms, it is its twin
      // (Codex takes the Enter at once, and questions may repeat a title and options)
      if (shown.id === answered && Date.now() - since < 600) continue;
      await paneSendKeys(paneId, [KEY.closeQueue]);
      return;
    }
    if (queuedQuestionCount(screen) > 0 || shown === null) return;
  }
}

/**
 * Opens Codex's collapsed queue on its first question and returns that question, only
 * if it is the one the card showed (title and options). Another one stays open, so the
 * chat's next read shows the question actually waiting (a skip can leave the rollout's
 * guess behind); a queue that does not open is left alone.
 */
async function openQueuedQuestion(paneId: string, queued: ParsedPrompt, givenUp: () => boolean = () => false, opens: (open: boolean) => void = () => undefined): Promise<InteractivePrompt | null> {
  // the key only once the screen still shows the questions' count, nothing of the user's queued,
  // and while somebody still waits for the answer (asked after the read, which takes its time)
  if (queuedQuestionCount(await liveScreen(paneId)) === 0 || givenUp()) return null;
  // told before the key goes: it may be pressed and its reply still be lost
  opens(true);
  await paneSendKeys(paneId, [KEY.openQueue]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Bun.sleep(100);
    const opened = parsePrompt("codex", await liveScreen(paneId));
    if (opened?.responder !== "codex-async-question") continue;
    if (sameText(opened.question, queued.question) && opened.options.length === queued.options.length
      && opened.options.every((option, index) => sameText(option.label, queued.options[index]!.label))) return publicPrompt(opened);
    const rollout = queueRollouts.get(paneId)?.path;
    if (rollout) queueFronts.set(paneId, { question: opened.question, options: opened.options.map((option) => option.label), rollout });
    if (queueFronts.size > 64) queueFronts.delete(queueFronts.keys().next().value!);
    break;
  }
  // not the card's question (a skip can leave the rollout's guess behind), or nothing opened:
  // never leave the queue open, where it would hold the input a message goes to. The one
  // close of this request's opening, told before it is tried: if its reply is lost, nobody
  // closes a second time what another client may have opened since
  opens(false);
  await closeOpenQuestion(paneId);
  return null;
}

/** Closes Codex's queue if a question shows open in it. */
async function closeOpenQuestion(paneId: string): Promise<void> {
  const screen = await liveScreen(paneId);
  if (parsePrompt("codex", screen)?.responder === "codex-async-question") await paneSendKeys(paneId, [KEY.closeQueue]);
}

/** How long an answer waits for the menu to show the cursor on its row, before it is refused. */
const SETTLE_MS = 1_500;

function promptChanged(): Response {
  return jsonResponse({ error: { code: "prompt_changed", message: "The interactive prompt changed; reopen it and try again." } }, 409);
}

export interface PromptRequestOptions {
  /** runs a pane's answer after the input already queued for it (a composer message in flight) */
  serialize?: <T>(paneId: string, task: () => Promise<T>) => Promise<T>;
  /** Native Codex store, for the rollout behind a collapsed queue; defaults to CODEX_HOME */
  codexHome?: string;
}

export async function handlePromptRequest(request: Request, url: URL, options: PromptRequestOptions = {}): Promise<Response | null> {
  if (url.pathname !== "/api/pane/prompt" && url.pathname !== "/api/pane/prompt/answer") return null;
  // the answer being handled, once its body was read: what the log line says even when the handling throws
  let answerLog: { paneId: string; matched: boolean } | null = null;
  try {
    if (url.pathname === "/api/pane/prompt") {
      if (request.method !== "GET") return badRequest("method_not_allowed", "GET is required.");
      const paneId = url.searchParams.get("pane_id")?.trim();
      if (!paneId) return badRequest("missing_pane_id", "pane_id is required.");
      const { agent, status, prompt } = await readPrompt(paneId, options.codexHome);
      // no menu up: what Claude suggests typing next, for the composer's placeholder. Only a
      // nicety: it is read only while Claude waits for the next prompt (a working agent shows
      // none), and a failed or slow read of it (a herdr without ansi reads, a busy one) leaves
      // the prompt answer as it is, on time. The viewport: the grey takes colors, which the
      // live-screen read does not give, and Claude's alternate screen does not scroll.
      const suggestion = prompt === null && agent === "claude" && (status === "idle" || status === "done")
        ? await paneRead({ paneId, source: "visible", format: "ansi", timeoutMs: SUGGESTION_READ_MS })
          .then((read) => parseClaudeSuggestion(read.text), () => null)
        : null;
      return jsonResponse({ prompt, suggestion });
    }

    if (request.method !== "POST") return badRequest("method_not_allowed", "POST is required.");
    let body: PromptAnswer;
    try {
      body = await request.json() as PromptAnswer;
    } catch {
      return badRequest("invalid_json", "The request body must be valid JSON.");
    }
    if (!body || typeof body !== "object") return badRequest("invalid_answer", "The answer body is required.");
    if (typeof body.pane_id !== "string" || !body.pane_id.trim()) return badRequest("missing_pane_id", "pane_id is required.");
    if (typeof body.prompt_id !== "string" || !body.prompt_id) return badRequest("invalid_answer", "prompt_id is required.");

    // read, checked and answered in the pane's turn: a message still in flight goes first, and
    // one sent meanwhile waits until the queue is opened, answered and closed again
    const serialize = options.serialize ?? (<T>(_paneId: string, task: () => Promise<T>) => task());
    const log = { paneId: body.pane_id, matched: false };
    answerLog = log;
    const response = await serialize(body.pane_id, async () => {
      // given up while it waited its turn: nothing is read, opened or sent for it
      if (request.signal.aborted) return promptChanged();
      const { prompt, agent, pane } = await readPrompt(body.pane_id, options.codexHome);
      if (!prompt || prompt.id !== body.prompt_id) return promptChanged();
      log.matched = true;
      // checked against the card before anything is sent: an invalid answer never opens the queue
      let steps: AnswerStep[];
      try {
        steps = answerKeys(prompt, body);
      } catch (error) {
        if (error instanceof InvalidAnswer) return badRequest("invalid_answer", error.message);
        throw error;
      }
      // The asking this answer is for, held to its last key: once anything says it ended (the
      // agent back at work), no key of this answer goes out any more, whatever the screen shows.
      const asking = askings.get(body.pane_id);
      // read while another answer was under way, the card names no asking this one can hold to
      if (!asking) return promptChanged();
      const asks = (): boolean => askings.get(body.pane_id) === asking && asking.content !== null;
      let target = prompt;
      const opensQueue = parsedByPublicPrompt.get(prompt)?.responder === "codex-queued-question";
      let answered = false;
      let committed = false;
      // whether this request's alt+↑ may have left the queue open
      let queueOpened = false;
      answersUnderWay.add(body.pane_id);
      answerTurns.set(body.pane_id, (answerTurns.get(body.pane_id) ?? 0) + 1);
      try {
        if (request.signal.aborted) return promptChanged();
        if (opensQueue) {
          // the card came from the rollout: answer it in the open queue, once it shows this question
          const opened = await openQueuedQuestion(body.pane_id, parsedByPublicPrompt.get(prompt)!, () => request.signal.aborted, (open) => { queueOpened = open; });
          // a queue it could not answer in it has closed again itself, or never opened: a
          // queue another client opened meanwhile is that client's to close
          if (!opened) return promptChanged();
          if (!asks()) return promptChanged();
          target = opened;
        }
        // the keys for the question as it shows in the open queue
        if (target !== prompt) steps = answerKeys(target, body);
        const parsed = parsedByPublicPrompt.get(target)!;
        const responder = parsed.responder;
        // where the moves sent so far leave the cursor (↑ stops at the first row)
        let cursor = parsed.selectedIndex;
        // Claude's unnumbered rows and pi's models are read with no number to aim at: looked at
        // again before the Enter even when it needs no move
        let moved = responder === "claude-confirm" || responder === "pi-model";
        /** Whether the screen is the card's own menu, with the cursor on the row the moves were for. */
        const aimed = (shown: ParsedPrompt | null, screen: string): boolean => {
          // pi's catalogue shows ten rows of a longer list and scrolls under the cursor, so the
          // rows on screen, and with them the card's id, change on the way down: what must
          // hold is the model under the cursor, by name. A wrong model, unlike a wrong menu
          // entry, answers every later turn silently
          if (responder === "pi-model") return shown?.responder === "pi-model" && shown.options[shown.selectedIndex]?.label === parsed.options[cursor]?.label;
          // a dialog of pi's has a card only with its cursor on the first row (parsePiDialog),
          // which the answer's own moves have just left: read off the screen itself
          if ((responder === "pi-question" || responder === "pi-confirm") && cursor !== 0) {
            const dialog = parsePiDialog(screen, true);
            return dialog?.id === parsed.id && dialog.selectedIndex === cursor && promptTailIsActive(dialog, screen);
          }
          return shown?.id === parsed.id && shown.selectedIndex === cursor;
        };
        for (let index = 0; index < steps.length; index += 1) {
          const step = steps[index]!;
          const move = step.keys?.every((key) => key === KEY.up || key === KEY.down) ?? false;
          // the asking ended under the answer: no further key, whatever the screen shows
          if (!asks()) return promptChanged();
          if (!move && !committed) {
            // An answer is only as good as the menu and the cursor it moves from, and both are
            // as old as the read above by the time its moves are done: the menu answered in the
            // terminal, with another one in its place, would take the Enter meant for this one,
            // and an arrow key typed there sends it to the wrong row. Moves change nothing; the
            // first key that does (the Enter, a toggle, the row opened for typing) goes only
            // once the screen shows this menu again, with the cursor on the row the moves were
            // for. The keys after that one follow as they always did: the menu itself changes
            // under them.
            if (moved) {
              const deadline = Date.now() + SETTLE_MS;
              for (;;) {
                // nobody waits for this answer any more: nothing that cannot be undone is started
                if (!asks() || request.signal.aborted) return promptChanged();
                const left = deadline - Date.now();
                if (left <= 0) return promptChanged();
                // a read that outlasts the wait is no read
                const reading = readKnownPrompt(body.pane_id, pane, agent, options.codexHome);
                reading.catch(() => undefined);
                const read = await Promise.race([reading, Bun.sleep(left).then(() => null)]);
                if (!read || Date.now() > deadline) return promptChanged();
                const shown = read.prompt ? parsedByPublicPrompt.get(read.prompt) ?? null : null;
                if (asks() && aimed(shown, read.screen ?? "")) break;
                await Bun.sleep(50);
              }
            }
            // given up before anything that cannot be undone, with or without a move before it
            if (request.signal.aborted) return promptChanged();
          }
          // before the key goes: herdr may press it and the reply still be lost, and a key that
          // may have been pressed has ended the asking as much as one that was
          const first = !move && !committed;
          if (!move) committed = true;
          try {
            if (step.keys) await paneSendKeys(body.pane_id, step.keys);
            else if (step.text !== undefined) await paneSendText(body.pane_id, step.text);
          } catch (error) {
            // herdr was never reached, so nothing was pressed: the card is still to be answered
            if (first && error instanceof HerdrError && error.code === "connect_failed") committed = false;
            throw error;
          }
          if (move) {
            moved = true;
            for (const key of step.keys!) cursor = key === KEY.down ? cursor + 1 : Math.max(0, cursor - 1);
          }
          if (index < steps.length - 1) await Bun.sleep(30);
        }
        answered = true;
      } catch (error) {
        if (error instanceof InvalidAnswer) return badRequest("invalid_answer", error.message);
        throw error;
      } finally {
        answersUnderWay.delete(body.pane_id);
        answerTurns.set(body.pane_id, (answerTurns.get(body.pane_id) ?? 0) + 1);
        // the queue this request opened never stays open, whatever failed on the way
        if (queueOpened && !answered) await closeOpenQuestion(body.pane_id).catch(() => undefined);
        // answered, or as good as: the same prompt on the screen after this is asked anew
        if (committed) askingEnded(body.pane_id);
      }
      // answered from the chat, the queue closes again: the next question waits collapsed, and
      // the main prompt (where a message typed in the chat goes) has the input back
      if (parsedByPublicPrompt.get(target)?.responder === "codex-async-question") {
        queueFronts.delete(body.pane_id);
        // by what it says, as closeQueue reads it off the screen
        await closeQueue(body.pane_id, contentId(target)!);
      }
      return jsonResponse({ ok: true });
    });
    await logAnswer(log, response);
    return response;
  } catch (error) {
    // a read or a send that threw (a herdr timeout, 502) is an outcome too
    const response = errorResponse(error);
    if (answerLog !== null) await logAnswer(answerLog, response);
    return response;
  }
}

/** One line per answer that got as far as the pane: the pane, whether the card's prompt still stood, and the
 * refusal's own code (prompt_changed, invalid_answer, agent_blocked, a herdr error...). Never the answer. The pane
 * id is the client's until the snapshot has checked it, so it is logged as a JSON string: one field, whatever it holds. */
async function logAnswer(log: { paneId: string; matched: boolean }, response: Response): Promise<void> {
  const outcome = response.ok ? "ok" : ((await response.clone().json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code ?? `status_${response.status}`;
  // quoted as JSON: a space or a newline in the client's id cannot pass for a field of the line
  const pane = JSON.stringify(log.paneId.slice(0, 80));
  console.log(`[prompt/answer] pane=${pane} prompt_matched=${log.matched} outcome=${outcome}`);
}
