import { getEnv } from '@/config/env';

export const SESSION_COOKIE = 'fc_session';

export function readSessionToken(req: Request): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE) return decodeURIComponent(part.slice(idx + 1).trim()) || null;
  }
  return null;
}

const secure = () => (getEnv().NODE_ENV === 'production' ? '; Secure' : '');

export function sessionCookie(token: string, expires: Date): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Expires=${expires.toUTCString()}${secure()}`;
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure()}`;
}

/**
 * Client IP. X-Forwarded-For is only used when TRUST_PROXY=true. Each trusted proxy appends the address it saw, so
 * the entries we can believe are the right-most ones: with `hops` trusted proxies the client is `hops` from the right.
 * Anything to its left was supplied by the client and is ignored (it can be forged to dodge rate limits).
 */
export function clientIp(req: Request, trustProxy: boolean, hops = 1): string {
  if (trustProxy) {
    const parts = (req.headers.get('x-forwarded-for') ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    const ip = parts[Math.max(0, parts.length - hops)];
    if (ip) return ip;
  }
  return 'unknown';
}
