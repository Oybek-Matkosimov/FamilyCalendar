import type { ZodType } from 'zod';
import { AppError } from '@/lib/errors';
import { getEnv } from '@/config/env';
import { getDb, type Db } from './db/client';
import { logger } from './logger';
import { clearedCookie, clientIp, readSessionToken, sessionCookie } from './auth/request';
import { resolveSession } from './auth/session';
import type { Actor } from './authz/policy';

export interface ApiResult {
  status?: number;
  body?: unknown;
  setSession?: { token: string; expires: Date };
  clearSession?: true;
}
export interface ApiContext<T> {
  req: Request;
  actor: Actor | null;
  /** Raw session token of the caller, if any (for "keep this session" operations). */
  token: string | null;
  body: T;
  db: Db;
  ip: string;
  params: Record<string, string>;
}
type RouteCtx = { params: Promise<Record<string, string>> };

export function api<T = undefined>(
  opts: { auth: boolean; schema?: ZodType<T> },
  fn: (c: ApiContext<T>) => Promise<ApiResult>,
) {
  return async (req: Request, ctx: RouteCtx): Promise<Response> => {
    try {
      const env = getEnv();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) assertSameOrigin(req, env.APP_ORIGIN);
      const db = getDb();
      const token = readSessionToken(req);
      const actor = token ? await resolveSession(db, token) : null;
      if (opts.auth && !actor) throw new AppError('UNAUTHENTICATED', 'Please sign in');

      let body = undefined as T;
      if (opts.schema) {
        const query = Object.fromEntries(new URL(req.url).searchParams);
        let raw: unknown = query;
        if (req.method !== 'GET') {
          const text = await req.text();
          if (text) {
            try {
              raw = JSON.parse(text);
            } catch {
              throw new AppError('VALIDATION', 'Invalid JSON body');
            }
          } else if (req.method !== 'DELETE') {
            throw new AppError('VALIDATION', 'Invalid JSON body');
          }
        }
        const r = opts.schema.safeParse(raw);
        if (!r.success) {
          throw new AppError('VALIDATION', r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
        }
        body = r.data;
      }
      const params = ctx?.params ? await ctx.params : {};
      const out = await fn({ req, actor, token, body, db, ip: clientIp(req, env.TRUST_PROXY), params });
      const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
      if (out.setSession) headers.append('set-cookie', sessionCookie(out.setSession.token, out.setSession.expires));
      if (out.clearSession) headers.append('set-cookie', clearedCookie());
      return new Response(out.body === undefined ? null : JSON.stringify(out.body), { status: out.status ?? 200, headers });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

function assertSameOrigin(req: Request, origin: string) {
  const o = req.headers.get('origin');
  let ok = false;
  try {
    ok = !!o && new URL(o).origin === new URL(origin).origin;
  } catch {
    ok = false;
  }
  if (!ok || req.headers.get('x-requested-with') !== 'fetch') throw new AppError('FORBIDDEN', 'Cross-site request blocked');
}

const DB_DOWN = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_DESTROYED', '57P01', '08006', '08001', '08004', '53300']);

export function errorResponse(e: unknown): Response {
  if (e instanceof AppError) return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status });
  const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : '';
  logger.error({ err: e instanceof Error ? { message: e.message, stack: e.stack, code } : String(e) }, 'unhandled error');
  if (DB_DOWN.has(code)) {
    return Response.json({ error: { code: 'UNAVAILABLE', message: 'The service is temporarily unavailable. Please try again.' } }, { status: 503 });
  }
  return Response.json({ error: { code: 'INTERNAL', message: 'Something went wrong' } }, { status: 500 });
}
