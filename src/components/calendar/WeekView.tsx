'use client';

import { useMemo } from 'react';
import type { ConflictDTO, DayStatus, MemberDTO, OccurrenceDTO } from '@/lib/client/types';
import { fmtDayShort, fmtRange, weekDays } from '@/lib/client/dateUtils';
import { inConflictOn, occurrencesByDay } from '@/lib/client/grouping';
import { colorOf, MemberDot } from './MemberDot';
import { DayStatusBadge } from './DayStatusBadge';

interface Props {
  anchor: string;
  tz: string;
  todayKey: string;
  occurrences: OccurrenceDTO[];
  dayStatus: Record<string, DayStatus>;
  conflicts: ConflictDTO[];
  members: MemberDTO[];
  onSelectDay: (day: string) => void;
}

export function WeekView({ anchor, tz, todayKey, occurrences, dayStatus, conflicts, members, onSelectDay }: Props) {
  const days = useMemo(() => weekDays(anchor, tz), [anchor, tz]);
  const byDay = useMemo(() => occurrencesByDay(occurrences, tz), [occurrences, tz]);
  return (
    <div className="week" aria-label="Week calendar">
      {days.map((day) => {
        const list = byDay.get(day) ?? [];
        const status = dayStatus[day];
        return (
          <section key={day} className={`week-day${day === todayKey ? ' is-today' : ''}${status ? ` is-${status}` : ''}`} aria-label={fmtDayShort(day)}>
            <button type="button" className="week-day-head" onClick={() => onSelectDay(day)} aria-current={day === todayKey ? 'date' : undefined}>
              <span className="week-day-name">{fmtDayShort(day)}</span>
              <DayStatusBadge status={status} count={list.length || undefined} />
            </button>
            {list.length === 0 ? (
              <p className="week-empty">Nothing planned</p>
            ) : (
              <ul className="week-list">
                {list.map((o) => (
                  <li key={o.eventId + o.start}>
                    <button
                      type="button"
                      className={`week-event${inConflictOn(o, day, conflicts) ? ' in-conflict' : ''}`}
                      style={{ borderLeftColor: colorOf(members, o.memberId) }}
                      onClick={() => onSelectDay(day)}
                    >
                      <span className="week-event-time">{fmtRange(o.start, o.end, tz, o.allDay)}</span>
                      <span className="week-event-title">
                        {inConflictOn(o, day, conflicts) && <span aria-label="Conflict">⚠ </span>}
                        {o.title}
                      </span>
                      <span className="week-event-who"><MemberDot name={o.memberName} color={colorOf(members, o.memberId)} size={18} /> {o.memberName}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
