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

/** Client IP. Only trusts X-Forwarded-For when TRUST_PROXY=true (i.e. behind a proxy that sets it). */
export function clientIp(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers.get('x-forwarded-for');
    const first = xff?.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}
