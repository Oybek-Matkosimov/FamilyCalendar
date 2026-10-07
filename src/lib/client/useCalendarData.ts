'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch } from './api';
import { addDays, rangeFor, today, type View } from './dateUtils';
import type { CalendarDTO, ConflictDTO, DayStatus, MemberDTO, OccurrenceDTO } from './types';

export interface RangeData {
  occurrences: OccurrenceDTO[];
  dayStatus: Record<string, DayStatus>;
  conflicts: ConflictDTO[];
}
export type Status = 'loading' | 'ready' | 'offline' | 'error';
export type CalendarInfo = CalendarDTO & { me: MemberDTO };

interface Params {
  view: View;
  anchor: string;
  memberId: string | null;
  search: string;
}

const qs = (from: Date, to: Date, extra: Record<string, string | null> = {}) => {
  const p = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return p.toString();
};

/**
 * Loads everything the dashboard shows. The server is the source of truth: after any change (ours or someone
 * else's, via realtime) we simply refetch. Stale responses are discarded.
 */
export function useCalendarData({ view, anchor, memberId, search }: Params) {
  const [info, setInfo] = useState<CalendarInfo | null>(null);
  const [members, setMembers] = useState<MemberDTO[]>([]);
  const [main, setMain] = useState<RangeData | null>(null);
  const [agenda, setAgenda] = useState<RangeData | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState('');
  const seq = useRef(0);
  const params = useRef({ view, anchor, memberId, search });
  params.current = { view, anchor, memberId, search };

  const load = useCallback(async () => {
    const id = ++seq.current;
    try {
      const me = await apiFetch<CalendarInfo>('/api/auth/me');
      const p = params.current;
      const range = rangeFor(p.view, p.anchor || today(me.timezone), me.timezone);
      const t0 = today(me.timezone);
      const agendaRange = rangeFor('day', t0, me.timezone);
      const agendaTo = rangeFor('day', addDays(t0, 7), me.timezone).to;
      const [mem, mainData, agendaData] = await Promise.all([
        apiFetch<{ members: MemberDTO[] }>('/api/members'),
        apiFetch<RangeData>(`/api/events?${qs(range.from, range.to, { member: p.memberId, q: p.search.trim() || null })}`),
        apiFetch<RangeData>(`/api/events?${qs(agendaRange.from, agendaTo)}`),
      ]);
      if (id !== seq.current) return;
      setInfo(me);
      setMembers(mem.members);
      setMain(mainData);
      setAgenda(agendaData);
      setStatus('ready');
      setError('');
    } catch (e) {
      if (id !== seq.current) return;
      if (e instanceof ApiError && e.code === 'UNAUTHENTICATED') {
        window.location.assign('/');
        return;
      }
      const offline = e instanceof ApiError && (e.code === 'NETWORK' || e.code === 'UNAVAILABLE');
      setStatus(offline ? 'offline' : 'error');
      setError(e instanceof ApiError ? e.message : 'Something went wrong');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, view, anchor, memberId, search]);

  return { info, members, main, agenda, status, error, refetch: load, tz: info?.timezone ?? 'UTC' };
}
