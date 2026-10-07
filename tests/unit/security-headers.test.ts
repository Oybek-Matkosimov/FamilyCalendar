import { describe, it, expect } from 'vitest';
import { securityHeaders } from '@/server/security-headers';
import { createLimiter } from '@/server/rate-limit';

describe('securityHeaders', () => {
  const prod = securityHeaders('abc', true);
  it('sets a strict CSP with the nonce', () => {
    const csp = prod['Content-Security-Policy']!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'nonce-abc'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("connect-src 'self'");
  });
  it('sets the other hardening headers; HSTS only in production', () => {
    expect(prod['Strict-Transport-Security']).toBe('max-age=63072000; includeSubDomains');
    expect(prod['X-Content-Type-Options']).toBe('nosniff');
    expect(prod['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(prod['Permissions-Policy']).toMatch(/camera=\(\)/);
    expect(prod['Permissions-Policy']).toMatch(/microphone=\(\)/);
    expect(prod['Permissions-Policy']).toMatch(/geolocation=\(\)/);
    const dev = securityHeaders('abc', false);
    expect(dev['Strict-Transport-Security']).toBeUndefined();
    expect(dev['Content-Security-Policy']).toContain("'unsafe-eval'");
  });
});

describe('rate limiter', () => {
  it('allows bursts up to capacity, then refills over time', () => {
    let t = 0;
    const l = createLimiter({ capacity: 3, refillPerSec: 1, now: () => t });
    expect([l.take('k'), l.take('k'), l.take('k'), l.take('k')]).toEqual([true, true, true, false]);
    expect(l.take('other')).toBe(true);
    t = 2000;
    expect([l.take('k'), l.take('k'), l.take('k')]).toEqual([true, true, false]);
  });
});
