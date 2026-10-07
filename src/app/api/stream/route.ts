import { getDb } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { errorResponse } from '@/server/api';
import { readSessionToken } from '@/server/auth/request';
import { resolveSession } from '@/server/auth/session';
import { ensureHub, registerStream, subscribe, type Change } from '@/server/realtime/hub';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Server-Sent Events: the client refetches whatever it is showing whenever a `change` event arrives. */
export async function GET(req: Request): Promise<Response> {
  try {
    const db = getDb();
    const token = readSessionToken(req);
    const actor = token ? await resolveSession(db, token) : null;
    if (!actor || !token) throw new AppError('UNAUTHENTICATED', 'Please sign in');
    await ensureHub().catch(() => {
      throw new AppError('UNAVAILABLE', 'Live updates are temporarily unavailable');
    });

    const enc = new TextEncoder();
    let cleanup: () => void = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const send = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(chunk));
          } catch {
            close();
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(ping);
          unsubscribe();
          unregister();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        const onChange = (c: Change) => {
          send(`event: change\ndata: ${JSON.stringify(c)}\n\n`);
          if (c.type === 'deleted') return close();
          if (c.type === 'member') {
            // A removed member's stream must not outlive their session.
            void resolveSession(db, token).then((a) => { if (!a) close(); }, () => {});
          }
        };
        const unsubscribe = subscribe(actor.calendarId, onChange);
        const unregister = registerStream(actor.memberId, close);
        const ping = setInterval(() => send(': ping\n\n'), 25000);
        cleanup = close;
        req.signal.addEventListener('abort', close);
        send('retry: 3000\nevent: ready\ndata: {}\n\n');
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
