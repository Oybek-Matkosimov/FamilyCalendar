'use client';

import type { MemberDTO, OccurrenceDTO } from '@/lib/client/types';
import { fmtDateTime, fmtRange } from '@/lib/client/dateUtils';
import { canDeleteEvent, canEditEvent } from '@/lib/client/permissions';
import { colorOf, MemberDot } from './MemberDot';
import { HistoryPopover } from './HistoryPopover';

interface Props {
  ev: OccurrenceDTO;
  tz: string;
  members: MemberDTO[];
  me: MemberDTO;
  membersCanEditAll: boolean;
  inConflict?: boolean;
  onEdit?: (ev: OccurrenceDTO) => void;
  onDelete?: (ev: OccurrenceDTO) => void;
  /** Compact cards omit comments/history (used in side panels). */
  compact?: boolean;
  showDate?: string;
}

export function EventCard({ ev, tz, members, me, membersCanEditAll, inConflict, onEdit, onDelete, compact, showDate }: Props) {
  const who = ev.memberRemoved ? `${ev.memberName} (former member)` : ev.memberName;
  const edited = ev.version > 1 || ev.updatedBy.id !== ev.createdBy.id;
  return (
    <article className={`event-card${inConflict ? ' in-conflict' : ''}`} style={{ borderLeftColor: colorOf(members, ev.memberId) }}>
      <header className="event-top">
        <div>
          <p className="event-time">
            {showDate ? `${showDate} · ` : ''}
            {fmtRange(ev.start, ev.end, tz, ev.allDay)}
            {ev.isRecurring && <span className="repeat-tag" title="Repeats"> ↻ Repeats</span>}
          </p>
          <h3 className="event-title">{ev.title}</h3>
        </div>
        {inConflict && <span className="badge badge-conflict"><span aria-hidden="true">⚠</span> Conflict</span>}
      </header>
      <p className="event-who">
        <MemberDot name={ev.memberName} color={colorOf(members, ev.memberId)} size={22} />
        <span>{who}</span>
      </p>
      {!compact && ev.location && <p className="event-meta">Location: {ev.location}</p>}
      {!compact && ev.description && <p className="event-meta">Comment: {ev.description}</p>}
      {!compact && (
        <p className="event-edited">
          {edited ? `Last edited by ${ev.updatedBy.name}` : `Created by ${ev.createdBy.name}`} · {fmtDateTime(ev.updatedAt, tz)}
        </p>
      )}
      {!compact && <HistoryPopover eventId={ev.eventId} tz={tz} />}
      {!compact && (onEdit || onDelete) && (
        <div className="row event-actions">
          {onEdit && canEditEvent(me, ev, membersCanEditAll) && (
            <button type="button" className="btn btn-small" onClick={() => onEdit(ev)} aria-label={`Edit ${ev.title}`}>Edit</button>
          )}
          {onDelete && canDeleteEvent(me, ev) && (
            <button type="button" className="btn btn-small btn-quiet" onClick={() => onDelete(ev)} aria-label={`Delete ${ev.title}`}>Delete</button>
          )}
        </div>
      )}
    </article>
  );
}
