import { describe, it, expect } from 'vitest';
import { cleanText, nameKey, createCalendarSchema, rangeSchema, eventInputSchema, joinSchema } from '@/lib/validation';

describe('text', () => {
  it('strips control chars and trims', () => { expect(cleanText('  a\u0000b\u0007  ')).toBe('ab'); });
  it('keeps newlines', () => { expect(cleanText('a\nb')).toBe('a\nb'); });
  it('nameKey treats composed/decomposed and case alike', () => {
    expect(nameKey('Éa')).toBe(nameKey('ÉA'));
    expect(nameKey('  Mom   Smith ')).toBe('mom smith');
  });
});

describe('schemas', () => {
  const base = { familyName: 'Fam', memberName: 'Dad', password: 'correct horse', timezone: 'Australia/Melbourne' };
  it('accepts valid create', () => { expect(createCalendarSchema.safeParse(base).success).toBe(true); });
  it('rejects whitespace-only names', () => {
    expect(createCalendarSchema.safeParse({ ...base, memberName: '   ' }).success).toBe(false);
    expect(createCalendarSchema.safeParse({ ...base, familyName: '\u0000\u0001' }).success).toBe(false);
  });
  it('rejects short and 129-char passwords', () => {
    expect(createCalendarSchema.safeParse({ ...base, password: 'short' }).success).toBe(false);
    expect(createCalendarSchema.safeParse({ ...base, password: 'x'.repeat(129) }).success).toBe(false);
  });
  it('rejects invalid timezone', () => {
    expect(createCalendarSchema.safeParse({ ...base, timezone: 'Mars/Olympus' }).success).toBe(false);
  });
  it('join accepts short legacy password but not 129 chars; normalizes code', () => {
    const j = joinSchema.safeParse({ code: ' matk-4829 ', memberName: 'Mom', password: 'abc' });
    expect(j.success && j.data.code).toBe('MATK-4829');
    expect(joinSchema.safeParse({ code: 'MATK-4829', memberName: 'Mom', password: 'x'.repeat(129) }).success).toBe(false);
    expect(joinSchema.safeParse({ code: 'bad', memberName: 'Mom', password: 'abc' }).success).toBe(false);
  });
  it('rejects 10000-char title', () => {
    const r = eventInputSchema.safeParse({ title: 'x'.repeat(10000), memberId: crypto.randomUUID(), allDay: false, start: '2026-10-10T18:00', end: '2026-10-10T19:00' });
    expect(r.success).toBe(false);
  });
  it('rejects range with from after to and >366 days', () => {
    expect(rangeSchema.safeParse({ from: '2026-10-10', to: '2026-10-01' }).success).toBe(false);
    expect(rangeSchema.safeParse({ from: '2020-01-01', to: '2026-01-01' }).success).toBe(false);
    expect(rangeSchema.safeParse({ from: '2026-10-01', to: '2026-11-01' }).success).toBe(true);
  });
});
