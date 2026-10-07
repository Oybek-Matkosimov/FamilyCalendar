'use client';

import { useMemo } from 'react';
import type { ConflictDTO, DayStatus, MemberDTO, OccurrenceDTO } from '@/lib/client/types';
import { fmtDayLong, fmtRange, minutesFromDayStart } from '@/lib/client/dateUtils';
import { conflictsOnDay, inConflictOn, occurrencesByDay } from '@/lib/client/grouping';
import { colorOf } from './MemberDot';
import { DayStatusBadge } from './DayStatusBadge';

interface Props {
  day: string;
  tz: string;
  isToday: boolean;
  occurrences: OccurrenceDTO[];
  dayStatus: Record<string, DayStatus>;
  conflicts: ConflictDTO[];
  members: MemberDTO[];
  onOpen: (day: string) => void;
}

const HOUR_PX = 56;

interface Placed { ev: OccurrenceDTO; top: number; height: number; lane: number; lanes: number }

/** Greedy lane assignment so overlapping events sit side by side. */
function layout(list: OccurrenceDTO[], day: string, tz: string): Placed[] {
  const items = list
    .map((ev) => ({ ev, s: minutesFromDayStart(ev.start, day, tz), e: minutesFromDayStart(ev.end, day, tz) }))
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const placed: Placed[] = [];
  let cluster: { item: (typeof items)[number]; lane: number }[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((c) => c.lane + 1));
    for (const c of cluster) {
      placed.push({ ev: c.item.ev, top: (c.item.s / 60) * HOUR_PX, height: Math.max(24, ((c.item.e - c.item.s) / 60) * HOUR_PX), lane: c.lane, lanes });
    }
    cluster = [];
  };
  const laneEnds: number[] = [];
  for (const item of items) {
    if (item.s >= clusterEnd && cluster.length) {
      flush();
      laneEnds.length = 0;
    }
    let lane = laneEnds.findIndex((end) => end <= item.s);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = item.e;
    cluster.push({ item, lane });
    clusterEnd = Math.max(clusterEnd, item.e);
  }
  if (cluster.length) flush();
  return placed;
}

export function DayView({ day, tz, isToday, occurrences, dayStatus, conflicts, members, onOpen }: Props) {
  const list = useMemo(() => occurrencesByDay(occurrences, tz).get(day) ?? [], [occurrences, tz, day]);
  const allDay = list.filter((o) => o.allDay);
  const timed = list.filter((o) => !o.allDay);
  const placed = useMemo(() => layout(timed, day, tz), [timed, day, tz]);
  const startHour = Math.min(6, ...timed.map((o) => Math.floor(minutesFromDayStart(o.start, day, tz) / 60)));
  const endHour = Math.max(22, ...timed.map((o) => Math.ceil(minutesFromDayStart(o.end, day, tz) / 60)));
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const dayConflicts = conflictsOnDay(day, conflicts);

  return (
    <section className="dayview" aria-label={fmtDayLong(day)}>
      <header className="dayview-head">
        <h2>{fmtDayLong(day)}{isToday ? ' (today)' : ''}</h2>
        <DayStatusBadge status={dayStatus[day]} count={list.length || undefined} />
        <button type="button" className="btn btn-small" onClick={() => onOpen(day)}>Details and add event</button>
      </header>
      {dayConflicts.map((c) => (
        <div key={c.id} className="conflict-banner" role="note">
          <b><span aria-hidden="true">⚠</span> Schedule conflict</b>
          {c.overlaps.map((o, i) => <p key={i}>{o.summary}</p>)}
        </div>
      ))}
      {allDay.length > 0 && (
        <ul className="allday">
          {allDay.map((o) => (
            <li key={o.eventId + o.start} style={{ borderLeftColor: colorOf(members, o.memberId) }}>All day: {o.title} ({o.memberName})</li>
          ))}
        </ul>
      )}
      <div className="timeline" style={{ height: hours.length * HOUR_PX }}>
        {hours.map((h) => (
          <div key={h} className="hour" style={{ top: (h - startHour) * HOUR_PX, height: HOUR_PX }}>
            <span className="hour-label">{new Date(2000, 0, 1, h).toLocaleTimeString('en-US', { hour: 'numeric' })}</span>
          </div>
        ))}
        <div className="events-layer">
          {placed.map(({ ev, top, height, lane, lanes }) => {
            const conflict = inConflictOn(ev, day, conflicts);
            return (
              <button
                type="button"
                key={ev.eventId + ev.start}
                className={`tl-event${conflict ? ' in-conflict' : ''}`}
                style={{
                  top: top - startHour * HOUR_PX, height, left: `${(lane / lanes) * 100}%`, width: `${100 / lanes}%`,
                  borderLeftColor: colorOf(members, ev.memberId),
                }}
                onClick={() => onOpen(day)}
              >
                <b>{conflict && <span aria-label="Conflict">⚠ </span>}{ev.title}</b>
                <span>{ev.memberName} · {fmtRange(ev.start, ev.end, tz, ev.allDay)}</span>
              </button>
            );
          })}
        </div>
      </div>
      {list.length === 0 && <p className="week-empty">Nothing planned. Use “Details and add event” to add something.</p>}
    </section>
  );
}
