import type { SideChatEvent } from "../shared/side-chat.ts";
import { errorResponse, isJsonObject, jsonResponse } from "./http.ts";
import { SideChatError, type SideChats } from "./side-chat.ts";

const PANE_ID = /^[\w:.-]{1,64}$/;
const CHAT_ID = /^[0-9a-f]{8}$/;

const STATUS: Record<SideChatError["code"], number> = {
  pane_not_found: 404, side_chat_not_found: 404, pane_without_folder: 409, side_chat_ended: 409, side_chat_busy: 429, missing_text: 400,
};

const fail = (code: string, message: string, status: number) => jsonResponse({ error: { code, message } }, status);

/**
 * The side chats' HTTP API, behind the same gate and origin check as the rest of /api:
 *  GET    /api/side-chats/events?pane_id=   -> server-sent SideChatEvent: the pane's side chat now and after each change
 *  POST   /api/side-chats           { pane_id, text } -> 201 { chat }; a new side chat, asked its first question
 *  POST   /api/side-chats/:id/messages  { text }  -> { chat }; the next question
 *  POST   /api/side-chats/:id/interrupt           -> { chat }; stops the turn under way
 *  DELETE /api/side-chats/:id                     -> 204; ends it, and nothing of it is kept
 */
export async function handleSideChatRequest(request: Request, url: URL, chats: SideChats, onRevoke?: (close: () => void) => () => void): Promise<Response> {
  const parts = url.pathname.slice("/api/side-chats".length).split("/").filter(Boolean);
  const method = request.method;
  const body = async (): Promise<Record<string, unknown> | null> => {
    try {
      const value: unknown = await request.json();
      return isJsonObject(value) ? value as Record<string, unknown> : null;
    } catch {
      return null;
    }
  };
  try {
    if (parts.length === 1 && parts[0] === "events") {
      if (method !== "GET") return fail("method_not_allowed", "use GET", 405);
      const paneId = url.searchParams.get("pane_id") ?? "";
      if (!PANE_ID.test(paneId)) return fail("invalid_pane_id", "pane_id must be a herdr pane id", 400);
      return events(request, (send) => chats.watch(paneId, (chat) => send({ chat })), onRevoke);
    }
    if (parts.length === 0) {
      if (method !== "POST") return fail("method_not_allowed", "use POST", 405);
      const payload = await body();
      if (payload === null) return fail("invalid_body", "request body must be a JSON object", 400);
      const paneId = payload["pane_id"];
      const text = payload["text"];
      if (typeof paneId !== "string" || !PANE_ID.test(paneId)) return fail("invalid_pane_id", "pane_id must be a herdr pane id", 400);
      if (typeof text !== "string") return fail("missing_text", "text is required", 400);
      return jsonResponse({ chat: await chats.start(paneId, text) }, 201);
    }
    const id = parts[0]!;
    if (!CHAT_ID.test(id)) return fail("side_chat_not_found", "That side chat is gone.", 404);
    if (parts.length === 1 && method === "DELETE") {
      chats.close(id);
      return new Response(null, { status: 204 });
    }
    if (parts.length === 2 && parts[1] === "messages" && method === "POST") {
      const payload = await body();
      const text = payload?.["text"];
      if (typeof text !== "string") return fail("missing_text", "text is required", 400);
      return jsonResponse({ chat: chats.send(id, text) });
    }
    if (parts.length === 2 && parts[1] === "interrupt" && method === "POST") return jsonResponse({ chat: chats.interrupt(id) });
    return fail("not_found", "Unknown side chat endpoint", 404);
  } catch (error) {
    if (error instanceof SideChatError) return fail(error.code, error.message, STATUS[error.code]);
    return errorResponse(error);
  }
}

/** A server-sent stream of `subscribe`'s events, until the page goes away or its device is revoked. */
function events(request: Request, subscribe: (send: (event: SideChatEvent) => void) => () => void, onRevoke?: (close: () => void) => () => void): Response {
  let stop: (() => void) | undefined;
  let unwatchDevice: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let close = () => {};
  const cleanup = () => {
    stop?.(); unwatchDevice?.(); clearInterval(heartbeat);
    request.signal.removeEventListener("abort", close);
  };
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      close = () => { if (closed) return; closed = true; cleanup(); try { controller.close(); } catch {} };
      unwatchDevice = onRevoke?.(close);
      if (closed) return;
      // a page that stopped reading is let go of, not buffered for
      const send = (text: string) => { if (closed) return; if ((controller.desiredSize ?? 0) < -4) { close(); return; } try { controller.enqueue(encoder.encode(text)); } catch { close(); } };
      stop = subscribe((event) => send(`data: ${JSON.stringify(event)}\n\n`));
      if (closed) { cleanup(); return; }
      heartbeat = setInterval(() => send(": heartbeat\n\n"), 15_000);
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) close();
    },
    cancel() { close(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
