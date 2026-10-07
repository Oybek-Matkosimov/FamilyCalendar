import postgres from 'postgres';
import { getEnv } from '@/config/env';
import { logger } from '@/server/logger';

export interface Change {
  type: 'event' | 'member' | 'calendar' | 'deleted';
  id?: string;
}
type Listener = (c: Change) => void;

const CHANNEL = 'calendar_changes';

// Shared through globalThis: with hot reloading (and multiple route bundles) this module can be evaluated more than
// once in one process. The listener registry must be the same object everywhere or subscribers stop hearing changes.
const g = globalThis as unknown as {
  __fcHub?: Promise<{ stop(): Promise<void> }>;
  __fcListeners?: Map<string, Set<Listener>>;
  __fcStreams?: Map<string, Set<() => void>>;
};
const listeners = (g.__fcListeners ??= new Map<string, Set<Listener>>());

export function subscribe(calendarId: string, cb: Listener): () => void {
  let set = listeners.get(calendarId);
  if (!set) listeners.set(calendarId, (set = new Set()));
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) listeners.delete(calendarId);
  };
}

function dispatch(calendarId: string, change: Change) {
  for (const cb of listeners.get(calendarId) ?? []) {
    try {
      cb(change);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'realtime listener failed');
    }
  }
}

/** One dedicated LISTEN connection per server process. postgres.js re-LISTENs automatically after a reconnect. */
export async function startHub(url: string): Promise<{ stop(): Promise<void> }> {
  const sql = postgres(url, { max: 1, connection: { application_name: 'fc-hub' }, onnotice: () => {} });
  let first = true;
  const sub = await sql.listen(
    CHANNEL,
    (payload) => {
      try {
        const p = JSON.parse(payload) as { c: string; t: Change['type']; i?: string };
        dispatch(p.c, { type: p.t, ...(p.i ? { id: p.i } : {}) });
      } catch {
        logger.warn('ignored malformed realtime payload');
      }
    },
    () => {
      // Runs on every (re)connect. After a reconnect we may have missed notifications: tell everyone to refetch.
      if (!first) for (const id of [...listeners.keys()]) dispatch(id, { type: 'calendar' });
      first = false;
    },
  );
  return {
    async stop() {
      await sub.unlisten().catch(() => {});
      await sql.end({ timeout: 2 });
    },
  };
}

/** Lazily start the process-wide hub; retries on the next call if the database was unavailable. */
export function ensureHub(): Promise<{ stop(): Promise<void> }> {
  if (!g.__fcHub) {
    g.__fcHub = startHub(getEnv().DATABASE_URL).catch((err) => {
      g.__fcHub = undefined;
      throw err;
    });
  }
  return g.__fcHub;
}

// ---- per-member stream cap (a runaway client cannot hold unlimited connections) ----
const MAX_STREAMS_PER_MEMBER = 20;
const streams = (g.__fcStreams ??= new Map<string, Set<() => void>>());

export function registerStream(memberId: string, close: () => void): () => void {
  let set = streams.get(memberId);
  if (!set) streams.set(memberId, (set = new Set()));
  set.add(close);
  while (set.size > MAX_STREAMS_PER_MEMBER) {
    const oldest = set.values().next().value as () => void;
    set.delete(oldest);
    oldest();
  }
  return () => {
    set!.delete(close);
    if (set!.size === 0) streams.delete(memberId);
  };
}
