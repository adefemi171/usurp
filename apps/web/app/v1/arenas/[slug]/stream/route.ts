import { arenas, getDb, getSql } from "@usurp/db";
import { eq } from "drizzle-orm";
import { currentUser } from "../../../../../lib/session";
import { canViewArena } from "../../../../../lib/arena-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
let activeStreams = 0;

/** Invalidate the view, never broadcast raw ranks, user IDs or private deltas. */
export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug } = await context.params;
  if (!(await canViewArena(slug, (await currentUser())?.id)))
    return Response.json({ error: "arena_not_found" }, { status: 404 });
  if (activeStreams >= 200)
    return Response.json(
      { error: "stream_capacity" },
      { status: 503, headers: { "retry-after": "60" } },
    );
  const [arena] = await getDb()
    .select({ id: arenas.id })
    .from(arenas)
    .where(eq(arenas.slug, slug));
  if (!arena)
    return Response.json({ error: "arena_not_found" }, { status: 404 });
  const encoder = new TextEncoder();
  let close = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      activeStreams++;
      let closed = false;
      let unsubscribe: (() => Promise<void>) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let expiry: ReturnType<typeof setTimeout> | undefined;
      close = () => {
        if (closed) return;
        closed = true;
        activeStreams--;
        clearInterval(heartbeat);
        clearTimeout(expiry);
        request.signal.removeEventListener("abort", close);
        void unsubscribe?.().catch(() => {});
        // cancel() is called after the controller is already closed by the
        // consumer; release the listener without throwing during disconnect.
        try {
          controller.close();
        } catch {
          /* already cancelled */
        }
      };
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) {
        close();
        return;
      }
      try {
        const listener = await getSql().listen("usurp_board_changed", (id) => {
          if (!closed && id === arena.id)
            controller.enqueue(
              encoder.encode('event: refresh\ndata: {"refresh":true}\n\n'),
            );
        });
        unsubscribe = listener.unlisten;
        if (closed) {
          await unsubscribe();
          return;
        }
        controller.enqueue(
          encoder.encode("retry: 3000\nevent: ready\ndata: {}\n\n"),
        );
        heartbeat = setInterval(
          () => controller.enqueue(encoder.encode(": heartbeat\n\n")),
          15_000,
        );
        // Reconnect periodically: membership and session authorization are rechecked.
        expiry = setTimeout(close, 55_000);
      } catch {
        close();
      }
    },
    cancel() {
      close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
