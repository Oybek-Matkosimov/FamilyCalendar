'use client';

import type { MemberDTO } from '@/lib/client/types';
import type { View } from '@/lib/client/dateUtils';
import { MemberDot } from './MemberDot';

const VIEWS: { id: View; label: string }[] = [
  { id: 'month', label: 'Month' },
  { id: 'week', label: 'Week' },
  { id: 'day', label: 'Day' },
];

interface Props {
  title: string;
  view: View;
  onView: (v: View) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}

export function Toolbar({ title, view, onView, onPrev, onNext, onToday }: Props) {
  return (
    <div className="toolbar">
      <div className="toolbar-nav">
        <button type="button" className="btn btn-small" onClick={onToday}>Today</button>
        <button type="button" className="btn btn-small" onClick={onPrev} aria-label={`Previous ${view}`}>‹</button>
        <button type="button" className="btn btn-small" onClick={onNext} aria-label={`Next ${view}`}>›</button>
        <h1 className="toolbar-title" aria-live="polite">{title}</h1>
      </div>
      <div className="tabs" role="tablist" aria-label="Calendar view">
        {VIEWS.map((v) => (
          <button key={v.id} type="button" role="tab" aria-selected={view === v.id} className={`tab${view === v.id ? ' is-on' : ''}`} onClick={() => onView(v.id)}>
            {v.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function MemberFilter({ members, value, onChange }: { members: MemberDTO[]; value: string | null; onChange: (id: string | null) => void }) {
  return (
    <div className="filter" role="group" aria-label="Show events for">
      <button type="button" className={`filter-chip${value === null ? ' is-on' : ''}`} aria-pressed={value === null} onClick={() => onChange(null)}>Everyone</button>
      {members.map((m) => (
        <button key={m.id} type="button" className={`filter-chip${value === m.id ? ' is-on' : ''}`} aria-pressed={value === m.id} onClick={() => onChange(value === m.id ? null : m.id)}>
          <MemberDot name={m.name} color={m.color} size={20} />
          {m.name}
        </button>
      ))}
    </div>
  );
}

export function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="search">
      <label className="sr-only" htmlFor="event-search">Search events</label>
      <input id="event-search" type="search" placeholder="Search title or comment" value={value} onChange={(e) => onChange(e.target.value)} maxLength={100} />
    </div>
  );
}
