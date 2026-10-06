import { describe, it, expect } from 'vitest';
import { buildRRule, expandSeries, type SeriesSource } from '@/lib/recurrence';

const base = (over: Partial<SeriesSource> = {}): SeriesSource => ({
  id: 's', memberId: 'm', title: 'School', allDay: false, tz: 'Australia/Melbourne',
  localStart: '2026-10-05T08:30', localEnd: '2026-10-05T15:30', rrule: buildRRule({ freq: 'weekdays' }),
  exceptions: [], recurUntil: null, ...over,
});
const days = (os: { occurrenceDate: string }[]) => os.map((o) => o.occurrenceDate);

describe('buildRRule', () => {
  it('maps presets', () => {
    expect(buildRRule({ freq: 'daily' })).toBe('FREQ=DAILY');
    expect(buildRRule({ freq: 'weekdays' })).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    expect(buildRRule({ freq: 'weekly', interval: 2, count: 4 })).toBe('FREQ=WEEKLY;INTERVAL=2;COUNT=4');
    expect(buildRRule({ freq: 'monthly' })).toBe('FREQ=MONTHLY');
    expect(buildRRule({ freq: 'custom', interval: 1, byDay: ['MO', 'WE'], until: '2026-12-31' })).toBe('FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T235959Z');
  });
});

describe('expandSeries', () => {
  it('weekdays only, keeps wall clock', () => {
    const os = expandSeries(base(), new Date('2026-10-04T13:00:00Z'), new Date('2026-10-12T13:00:00Z'));
    expect(days(os)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12']);
    expect(os[0]!.start.toISOString()).toBe('2026-10-04T21:30:00.000Z'); // 08:30 AEDT(+11) on Oct 5
  });
  it('skips exceptions', () => {
    expect(days(expandSeries(base({ exceptions: ['2026-10-06'] }), new Date('2026-10-04T13:00:00Z'), new Date('2026-10-07T13:00:00Z')))).toEqual(['2026-10-05', '2026-10-07']);
  });
  it('respects recurUntil and COUNT', () => {
    expect(expandSeries(base({ rrule: 'FREQ=DAILY;COUNT=2' }), new Date('2026-10-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z'))).toHaveLength(2);
    expect(expandSeries(base({ rrule: 'FREQ=DAILY', recurUntil: new Date('2026-10-06T00:00:00Z') }), new Date('2026-10-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z'))).toHaveLength(2);
  });
  it('wall-clock stays 09:00 across a DST change (Melbourne spring forward 2026-10-04)', () => {
    const os = expandSeries(base({ rrule: 'FREQ=DAILY', localStart: '2026-10-01T09:00', localEnd: '2026-10-01T10:00' }), new Date('2026-09-30T00:00:00Z'), new Date('2026-10-08T00:00:00Z'));
    const before = os.find((o) => o.occurrenceDate === '2026-10-03')!;
    const after = os.find((o) => o.occurrenceDate === '2026-10-05')!;
    expect(before.start.toISOString()).toBe('2026-10-02T23:00:00.000Z'); // +10
    expect(after.start.toISOString()).toBe('2026-10-04T22:00:00.000Z'); // +11
  });
  it('02:30 daily in New York on spring-forward day still occurs once that day', () => {
    const os = expandSeries(base({ tz: 'America/New_York', rrule: 'FREQ=DAILY', localStart: '2026-03-07T02:30', localEnd: '2026-03-07T03:00' }), new Date('2026-03-07T00:00:00Z'), new Date('2026-03-10T00:00:00Z'));
    expect(os.filter((o) => o.occurrenceDate === '2026-03-08')).toHaveLength(1);
  });
  it('event crossing midnight keeps duration', () => {
    const os = expandSeries(base({ rrule: 'FREQ=DAILY', localStart: '2026-10-05T22:00', localEnd: '2026-10-06T02:00' }), new Date('2026-10-04T00:00:00Z'), new Date('2026-10-08T00:00:00Z'));
    expect((os[0]!.end.getTime() - os[0]!.start.getTime()) / 3600000).toBe(4);
  });
  it('includes an occurrence that started before the window but ends inside it', () => {
    const os = expandSeries(base({ rrule: 'FREQ=DAILY', localStart: '2026-10-05T22:00', localEnd: '2026-10-06T02:00', tz: 'UTC' }), new Date('2026-10-06T01:00:00Z'), new Date('2026-10-06T05:00:00Z'));
    expect(days(os)).toEqual(['2026-10-05']);
  });
  it('caps results at limit', () => {
    expect(expandSeries(base({ rrule: 'FREQ=DAILY' }), new Date('2026-01-01T00:00:00Z'), new Date('2026-12-31T00:00:00Z'), 10)).toHaveLength(10);
  });
});
