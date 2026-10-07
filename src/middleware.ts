import { NextResponse, type NextRequest } from 'next/server';
import { securityHeaders } from '@/server/security-headers';

export function middleware(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const headers = securityHeaders(nonce, process.env.NODE_ENV === 'production');
  const requestHeaders = new Headers(req.headers);
  // Next.js reads the nonce from the request CSP header and applies it to its own inline scripts.
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', headers['Content-Security-Policy']!);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image|favicon.ico).*)' }],
};
