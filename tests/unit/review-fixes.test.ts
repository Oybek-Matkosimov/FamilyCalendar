import { describe, it, expect } from 'vitest';
import { clientIp } from '@/server/auth/request';
import { cleanText, nameKey, rangeSchema, createCalendarSchema } from '@/lib/validation';
import { expandSeries } from '@/lib/recurrence';

const reqWith = (xff?: string) => new Request('http://x/', { headers: xff ? { 'x-forwarded-for': xff } : {} });

describe('clientIp', () => {
  it('ignores X-Forwarded-For unless a proxy is trusted', () => {
    expect(clientIp(reqWith('6.6.6.6'), false)).toBe('unknown');
    expect(clientIp(reqWith(), true)).toBe('unknown');
  });
  it('takes the hop added by our own proxy (right-most), not the spoofable client-supplied value', () => {
    expect(clientIp(reqWith('6.6.6.6, 203.0.113.5'), true)).toBe('203.0.113.5');
    expect(clientIp(reqWith('203.0.113.5'), true)).toBe('203.0.113.5');
  });
  it('supports several trusted proxy hops', () => {
    expect(clientIp(reqWith('6.6.6.6, 203.0.113.5, 10.0.0.2'), true, 2)).toBe('203.0.113.5');
    expect(clientIp(reqWith('203.0.113.5'), true, 3)).toBe('203.0.113.5');
  });
});

describe('date range limits', () => {
  it('rejects ranges in far-away years that would make the server do huge amounts of work', () => {
    expect(rangeSchema.safeParse({ from: '9999-01-01T00:00:00Z', to: '9999-12-31T00:00:00Z' }).success).toBe(false);
    expect(rangeSchema.safeParse({ from: '1900-01-01T00:00:00Z', to: '1900-06-01T00:00:00Z' }).success).toBe(false);
    expect(rangeSchema.safeParse({ from: '-100000-01-01T00:00:00Z', to: '-100000-02-01T00:00:00Z' }).success).toBe(false);
  });
  it('accepts ordinary ranges around today', () => {
    const from = new Date(); const to = new Date(Date.now() + 40 * 86400000);
    expect(rangeSchema.safeParse({ from, to }).success).toBe(true);
  });
  it('expanding a series across the whole supported window stays fast', () => {
    const start = new Date(Date.now() - 29 * 365 * 86400000).toISOString().slice(0, 10);
    const t0 = Date.now();
    const out = expandSeries(
      { id: 's', memberId: 'm', title: 't', allDay: false, tz: 'UTC', localStart: `${start}T09:00`, localEnd: `${start}T10:00`, rrule: 'FREQ=DAILY', exceptions: [], recurUntil: null },
      new Date(), new Date(Date.now() + 40 * 86400000),
    );
    expect(out.length).toBeGreaterThan(30);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('invisible characters in names', () => {
  it('strips zero-width, bidi and C1 control characters', () => {
    expect(cleanText('Mo​m')).toBe('Mom');
    expect(cleanText('‮evil‬')).toBe('evil');
    expect(cleanText('a\u0085b﻿c⁠d')).toBe('abcd');
  });
  it('a zero-width variant of a name has the same key', () => {
    expect(nameKey('Mo​m')).toBe(nameKey('Mom'));
  });
  it('rejects names that are empty once invisible characters are removed', () => {
    const base = { familyName: 'Fam', password: 'correct horse', timezone: 'UTC' };
    expect(createCalendarSchema.safeParse({ ...base, memberName: '​‍⁠' }).success).toBe(false);
    expect(createCalendarSchema.safeParse({ ...base, memberName: 'Mom' }).success).toBe(true);
  });
});
