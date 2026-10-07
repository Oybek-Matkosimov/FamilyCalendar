'use client';

import { useMemo, useState } from 'react';
import type { ConflictDTO, MemberDTO, OccurrenceDTO } from '@/lib/client/types';
import { addDays, fmtDayLong, fmtDayShort, fmtRange } from '@/lib/client/dateUtils';
import { occurrencesByDay } from '@/lib/client/grouping';
import { colorOf, MemberDot } from './MemberDot';

interface Common { tz: string; members: MemberDTO[]; todayKey: string }

function Row({ ev, tz, members, onOpen, day }: { ev: OccurrenceDTO; tz: string; members: MemberDTO[]; onOpen: (day: string) => void; day: string }) {
  return (
    <li>
      <button type="button" className="panel-row" onClick={() => onOpen(day)} style={{ borderLeftColor: colorOf(members, ev.memberId) }}>
        <MemberDot name={ev.memberName} color={colorOf(members, ev.memberId)} size={26} />
        <span className="panel-row-text">
          <b>{ev.title}</b>
          <small>{ev.memberName} · {fmtRange(ev.start, ev.end, tz, ev.allDay)}</small>
        </span>
      </button>
    </li>
  );
}

export function TodayPanel({ occurrences, tz, members, todayKey, onOpen }: Common & { occurrences: OccurrenceDTO[]; onOpen: (day: string) => void }) {
  const list = useMemo(() => occurrencesByDay(occurrences, tz).get(todayKey) ?? [], [occurrences, tz, todayKey]);
  return (
    <section className="panel" aria-labelledby="today-h">
      <h2 id="today-h">Today’s schedule</h2>
      <p className="panel-sub">{fmtDayLong(todayKey)}</p>
      {list.length === 0 ? (
        <p className="empty">Nobody has anything planned today.</p>
      ) : (
        <ul className="panel-list">{list.map((ev) => <Row key={ev.eventId + ev.start} ev={ev} tz={tz} members={members} onOpen={onOpen} day={todayKey} />)}</ul>
      )}
    </section>
  );
}

export function UpcomingPanel({ occurrences, tz, members, todayKey, onOpen }: Common & { occurrences: OccurrenceDTO[]; onOpen: (day: string) => void }) {
  const byDay = useMemo(() => occurrencesByDay(occurrences, tz), [occurrences, tz]);
  const days = Array.from({ length: 7 }, (_, i) => addDays(todayKey, i + 1)).filter((d) => byDay.has(d));
  return (
    <section className="panel" aria-labelledby="upcoming-h">
      <h2 id="upcoming-h">Upcoming</h2>
      <p className="panel-sub">Next 7 days</p>
      {days.length === 0 ? (
        <p className="empty">Nothing coming up this week.</p>
      ) : (
        days.map((d) => (
          <div key={d} className="panel-day">
            <h3>{fmtDayShort(d)}</h3>
            <ul className="panel-list">{byDay.get(d)!.map((ev) => <Row key={ev.eventId + ev.start} ev={ev} tz={tz} members={members} onOpen={onOpen} day={d} />)}</ul>
          </div>
        ))
      )}
    </section>
  );
}

export function ConflictsPanel({ conflicts, onOpen }: { conflicts: ConflictDTO[]; onOpen: (day: string) => void }) {
  const [open, setOpen] = useState(false);
  const n = conflicts.length;
  return (
    <section className={`panel${n > 0 ? ' panel-conflict' : ''}`} aria-labelledby="conf-h">
      <h2 id="conf-h">Conflicts</h2>
      {n === 0 ? (
        <p className="empty"><span aria-hidden="true">✓</span> No scheduling conflicts in the next 7 days.</p>
      ) : (
        <>
          <button type="button" className="conflict-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <span aria-hidden="true">⚠</span> {n === 1 ? '1 scheduling conflict' : `${n} scheduling conflicts`} in the next 7 days
          </button>
          {open && (
            <ul className="panel-list">
              {conflicts.map((c) => (
                <li key={c.id} className="conflict-item">
                  {c.overlaps.map((o, i) => <p key={i}>{o.summary}</p>)}
                  <p className="conflict-events">{c.occurrences.map((o) => `${o.title} (${o.memberName})`).join(' · ')}</p>
                  <button type="button" className="btn btn-small" onClick={() => onOpen(c.days[0]!)}>Show {fmtDayShort(c.days[0]!)}</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
