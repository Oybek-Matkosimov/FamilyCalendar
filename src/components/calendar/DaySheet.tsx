'use client';

import { useMemo } from 'react';
import type { ConflictDTO, DayStatus, MemberDTO, OccurrenceDTO } from '@/lib/client/types';
import { fmtDayLong } from '@/lib/client/dateUtils';
import { conflictsOnDay, inConflictOn, occurrencesByDay } from '@/lib/client/grouping';
import { Dialog } from '@/components/ui/Dialog';
import { DayStatusBadge } from './DayStatusBadge';
import { EventCard } from './EventCard';

interface Props {
  day: string | null;
  tz: string;
  occurrences: OccurrenceDTO[];
  dayStatus: Record<string, DayStatus>;
  conflicts: ConflictDTO[];
  members: MemberDTO[];
  me: MemberDTO;
  membersCanEditAll: boolean;
  onClose: () => void;
  onAdd: (day: string) => void;
  onEdit: (ev: OccurrenceDTO) => void;
  onDelete: (ev: OccurrenceDTO) => void;
}

export function DaySheet({ day, tz, occurrences, dayStatus, conflicts, members, me, membersCanEditAll, onClose, onAdd, onEdit, onDelete }: Props) {
  const list = useMemo(() => (day ? occurrencesByDay(occurrences, tz).get(day) ?? [] : []), [day, occurrences, tz]);
  const dayConflicts = day ? conflictsOnDay(day, conflicts) : [];
  return (
    <Dialog open={day !== null} title={day ? fmtDayLong(day) : ''} onClose={onClose} sheet>
      {day && (
        <>
          <div className="row">
            <DayStatusBadge status={dayStatus[day]} count={list.length || undefined} />
            <button type="button" className="btn btn-primary btn-small" onClick={() => onAdd(day)}>Add event</button>
          </div>
          {dayConflicts.map((c) => (
            <div key={c.id} className="conflict-banner" role="note">
              <b><span aria-hidden="true">⚠</span> Schedule conflict</b>
              {c.overlaps.map((o, i) => <p key={i}>{o.summary}</p>)}
            </div>
          ))}
          {list.length === 0 ? (
            <p className="empty">Nothing planned for this day yet.</p>
          ) : (
            <div className="stack">
              {list.map((ev) => (
                <EventCard
                  key={ev.eventId + ev.start}
                  ev={ev} tz={tz} members={members} me={me} membersCanEditAll={membersCanEditAll}
                  inConflict={inConflictOn(ev, day, conflicts)} onEdit={onEdit} onDelete={onDelete}
                />
              ))}
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
