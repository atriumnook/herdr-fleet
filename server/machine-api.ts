import { MachineManager } from "./machines.ts";
import { jsonResponse, sameOrigin } from "./http.ts";

const fail = (code: string, message: string, status: number) => jsonResponse({ error: { code, message } }, status);

/** GET /api/machines (this PC) and GET /api/machines/events (its roster as server-sent events). */
export async function handleMachineRequest(request: Request, manager: MachineManager, onRevoke?: (close: () => void) => () => void): Promise<Response> {
  const url = new URL(request.url);
  if (!sameOrigin(request)) return fail("invalid_origin", "Use PC controls from this app", 403);
  // an empty segment is never a route
  if (url.pathname.includes("//")) return fail("not_found", "not found", 404);
  const parts = url.pathname.slice("/api/machines".length).split("/").filter(Boolean);
  if (request.method !== "GET") return fail("method_not_allowed", "Use GET", 405);
  if (!parts.length) return jsonResponse({ machines: manager.list() });
  if (parts[0] === "events" && parts.length === 1) {
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
        const send = (text: string) => { if (closed) return; if ((controller.desiredSize ?? 0) < -4) { close(); return; } try { controller.enqueue(encoder.encode(text)); } catch { close(); } };
        stop = manager.subscribe((event) => send(`data: ${JSON.stringify(event)}\n\n`));
        if (closed) { cleanup(); return; }
        heartbeat = setInterval(() => send(": heartbeat\n\n"), 15_000);
        request.signal.addEventListener("abort", close, { once: true });
        if (request.signal.aborted) close();
      },
      cancel() { close(); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
  }
  return fail("not_found", "Unknown PC endpoint", 404);
}
