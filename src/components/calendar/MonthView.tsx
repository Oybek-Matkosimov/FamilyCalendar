'use client';

import { useMemo, type KeyboardEvent } from 'react';
import type { DayStatus, MemberDTO, OccurrenceDTO } from '@/lib/client/types';
import { dayNumber, fmtDayLong, monthGrid } from '@/lib/client/dateUtils';
import { occurrencesByDay } from '@/lib/client/grouping';
import { colorOf } from './MemberDot';
import { DayStatusBadge } from './DayStatusBadge';

interface Props {
  anchor: string;
  tz: string;
  todayKey: string;
  occurrences: OccurrenceDTO[];
  dayStatus: Record<string, DayStatus>;
  members: MemberDTO[];
  onSelectDay: (day: string) => void;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function MonthView({ anchor, tz, todayKey, occurrences, dayStatus, members, onSelectDay }: Props) {
  const grid = useMemo(() => monthGrid(anchor, tz), [anchor, tz]);
  const byDay = useMemo(() => occurrencesByDay(occurrences, tz), [occurrences, tz]);
  const month = anchor.slice(0, 7);

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const deltas: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const d = deltas[e.key];
    if (!d) return;
    const cur = (e.target as HTMLElement).closest<HTMLElement>('[data-day]');
    if (!cur) return;
    const flat = grid.flat();
    const idx = flat.indexOf(cur.dataset.day!);
    const next = flat[idx + d];
    if (!next) return;
    e.preventDefault();
    e.currentTarget.querySelector<HTMLElement>(`[data-day="${next}"]`)?.focus();
  }

  return (
    <div className="month" role="grid" aria-label="Month calendar" onKeyDown={onKey}>
      <div className="month-head" role="row">
        {WEEKDAYS.map((d) => (
          <div key={d} role="columnheader" className="month-dow">{d}</div>
        ))}
      </div>
      {grid.map((week, wi) => (
        <div className="month-week" role="row" key={wi}>
          {week.map((day) => {
            const list = byDay.get(day) ?? [];
            const status = dayStatus[day];
            const statusText = status === 'conflict' ? ', schedule conflict' : status === 'scheduled' ? ', scheduled' : ', no events';
            const label = `${fmtDayLong(day)}, ${list.length === 1 ? '1 event' : `${list.length} events`}${statusText}`;
            return (
              <div role="gridcell" key={day} className="month-cell-wrap">
                <button
                  type="button"
                  data-day={day}
                  tabIndex={day === (todayKey.startsWith(month) ? todayKey : `${month}-01`) ? 0 : -1}
                  className={`month-cell${day.slice(0, 7) !== month ? ' is-outside' : ''}${day === todayKey ? ' is-today' : ''}${status ? ` is-${status}` : ''}`}
                  aria-label={label}
                  aria-current={day === todayKey ? 'date' : undefined}
                  onClick={() => onSelectDay(day)}
                >
                  <span className="cell-top">
                    <span className="cell-num">{dayNumber(day)}</span>
                    <DayStatusBadge status={status} count={list.length || undefined} compact />
                  </span>
                  <span className="cell-chips" aria-hidden="true">
                    {list.slice(0, 3).map((o) => (
                      <span key={o.eventId + o.start} className="chip" style={{ borderLeftColor: colorOf(members, o.memberId) }}>
                        {o.title}
                      </span>
                    ))}
                    {list.length > 3 && <span className="chip-more">+{list.length - 3} more</span>}
                  </span>
                  <span className="cell-dots" aria-hidden="true">
                    {list.slice(0, 4).map((o) => (
                      <span key={o.eventId + o.start} className="dot" style={{ background: colorOf(members, o.memberId) }} />
                    ))}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
