'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiFetch } from '@/lib/client/api';
import {
  addDays, fmtDayLong, fmtMonthTitle, rangeFor, shift, today, weekDays, type View,
} from '@/lib/client/dateUtils';
import { useCalendarData } from '@/lib/client/useCalendarData';
import { useRealtime } from '@/lib/client/useRealtime';
import type { OccurrenceDTO } from '@/lib/client/types';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';
import { MemberDot } from './MemberDot';
import { MemberFilter, SearchBox, Toolbar } from './Toolbar';
import { MonthView } from './MonthView';
import { WeekView } from './WeekView';
import { DayView } from './DayView';
import { DaySheet } from './DaySheet';
import { EventForm } from './EventForm';
import { ConflictsPanel, TodayPanel, UpcomingPanel } from './Panels';
import { MembersDialog } from './MembersDialog';
import { InviteDialog } from './InviteDialog';
import { SettingsDialog } from './SettingsDialog';

interface FormState { open: boolean; mode: 'create' | 'edit'; scope?: 'this' | 'series'; event?: OccurrenceDTO; date: string }
type Pending = { ev: OccurrenceDTO; action: 'edit' | 'delete' } | null;

function titleFor(view: View, anchor: string, tz: string): string {
  if (view === 'month') return fmtMonthTitle(anchor);
  if (view === 'day') return fmtDayLong(anchor);
  const days = weekDays(anchor, tz);
  const a = days[0]!;
  const b = days[6]!;
  const monthA = fmtMonthTitle(a).split(' ')[0]!.slice(0, 3);
  const monthB = fmtMonthTitle(b).split(' ')[0]!.slice(0, 3);
  return `${monthA} ${Number(a.slice(8))} – ${monthA === monthB ? '' : monthB + ' '}${Number(b.slice(8))}, ${b.slice(0, 4)}`;
}

export function CalendarShell() {
  const toast = useToast();
  const [view, setView] = useState<View>('month');
  const [anchor, setAnchor] = useState<string | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({ open: false, mode: 'create', date: '' });
  const [pending, setPending] = useState<Pending>(null);
  const [deleting, setDeleting] = useState<{ ev: OccurrenceDTO; scope: 'this' | 'series' } | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [dlg, setDlg] = useState<'members' | 'invite' | 'settings' | null>(null);

  // The anchor is initialised once the calendar timezone is known; until then use a stable placeholder.
  const data = useCalendarData({ view, anchor: anchor ?? '', memberId, search });
  const { info, members, main, agenda, status, error, refetch, tz } = data;

  useEffect(() => {
    if (info && anchor === null) setAnchor(today(info.timezone));
  }, [info, anchor]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useRealtime(refetch);

  // While we cannot reach the server keep trying in the background.
  useEffect(() => {
    if (status !== 'offline') return;
    const t = setInterval(() => void refetch(), 15000);
    return () => clearInterval(t);
  }, [status, refetch]);

  const loadLatest = useCallback(
    async (ev: OccurrenceDTO): Promise<OccurrenceDTO | null> => {
      const from = rangeFor('day', addDays(ev.occurrenceDate, -1), tz).from;
      const to = rangeFor('day', addDays(ev.occurrenceDate, 2), tz).from;
      const r = await apiFetch<{ occurrences: OccurrenceDTO[] }>(`/api/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
      void refetch();
      return r.occurrences.find((o) => o.eventId === ev.eventId) ?? null;
    },
    [tz, refetch],
  );

  if (!info || !main || !agenda || anchor === null) {
    return (
      <main className="boot" aria-busy={status === 'loading'}>
        {status === 'loading' && <p>Loading your calendar…</p>}
        {(status === 'offline' || status === 'error') && (
          <div className="auth-card">
            <h1>Can’t load the calendar</h1>
            <p className="form-error" role="alert">{error}</p>
            <button type="button" className="btn btn-primary" onClick={() => void refetch()}>Try again</button>
          </div>
        )}
      </main>
    );
  }

  const me = info.me;
  const todayKey = today(tz);
  const editAll = info.settings.membersCanEditAll;

  function openAdd(day: string) {
    setSelectedDay(null);
    setForm({ open: true, mode: 'create', date: day });
  }
  function startEdit(ev: OccurrenceDTO) {
    if (ev.isRecurring) setPending({ ev, action: 'edit' });
    else openEdit(ev, 'series');
  }
  function openEdit(ev: OccurrenceDTO, scope: 'this' | 'series') {
    setSelectedDay(null);
    setForm({ open: true, mode: 'edit', scope, event: ev, date: ev.occurrenceDate });
  }
  function startDelete(ev: OccurrenceDTO) {
    if (ev.isRecurring) setPending({ ev, action: 'delete' });
    else {
      setDeleteError('');
      setDeleting({ ev, scope: 'series' });
    }
  }
  async function confirmDelete() {
    if (!deleting || deletePending) return;
    setDeletePending(true);
    setDeleteError('');
    try {
      const { ev, scope } = deleting;
      const q = new URLSearchParams({ version: String(ev.version), scope });
      if (scope === 'this') q.set('occurrenceDate', ev.occurrenceDate);
      await apiFetch(`/api/events/${ev.eventId}?${q}`, { method: 'DELETE' });
      toast.show(`Deleted “${ev.title}”`);
      setDeleting(null);
      void refetch();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT') {
        setDeleteError('This event was just changed by someone else. Close this and review the latest version first.');
        void refetch();
      } else {
        setDeleteError(e instanceof ApiError ? e.message : 'Could not delete the event');
      }
    } finally {
      setDeletePending(false);
    }
  }

  const onSelectDay = (day: string) => {
    if (view === 'month') setSelectedDay(day);
    else if (view === 'week') {
      setAnchor(day);
      setView('day');
    } else setSelectedDay(day);
  };

  return (
    <div className="dash">
      <header className="topbar">
        <div className="topbar-name">
          <span className="brand-mark" aria-hidden="true">▦</span>
          <div>
            <p className="topbar-family">{info.name}</p>
            <p className="topbar-id">ID {info.code}</p>
          </div>
        </div>
        <div className="topbar-actions">
          <span className="me-chip" title="You are signed in as">
            <MemberDot name={me.name} color={me.color} size={26} /> {me.name}
          </span>
          <button type="button" className="btn btn-small" onClick={() => setDlg('members')}>Members</button>
          {me.role === 'owner' && <button type="button" className="btn btn-small" onClick={() => setDlg('invite')}>Invite</button>}
          <button type="button" className="btn btn-small" onClick={() => setDlg('settings')}>Settings</button>
          <button type="button" className="btn btn-primary btn-small" onClick={() => openAdd(view === 'day' ? anchor : todayKey)}>Add event</button>
        </div>
      </header>

      {status === 'offline' && (
        <div className="banner" role="alert">
          <span>You’re offline or the server can’t be reached. Showing the last loaded data. Trying again…</span>
          <button type="button" className="btn btn-small" onClick={() => void refetch()}>Retry now</button>
        </div>
      )}
      {status === 'error' && (
        <div className="banner banner-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-small" onClick={() => void refetch()}>Retry</button>
        </div>
      )}

      <div className="dash-grid">
        <main className="dash-main">
          <Toolbar
            title={titleFor(view, anchor, tz)} view={view} onView={setView}
            onPrev={() => setAnchor(shift(view, anchor, -1))} onNext={() => setAnchor(shift(view, anchor, 1))} onToday={() => setAnchor(todayKey)}
          />
          <div className="filters">
            <MemberFilter members={members} value={memberId} onChange={setMemberId} />
            <SearchBox value={searchInput} onChange={setSearchInput} />
          </div>
          {(memberId || search.trim()) && <p className="filter-note" role="status">Showing {memberId ? members.find((m) => m.id === memberId)?.name ?? 'one person' : 'everyone'}{search.trim() ? ` matching “${search.trim()}”` : ''}. Day colours and conflicts always cover the whole family.</p>}
          {view === 'month' && (
            <MonthView anchor={anchor} tz={tz} todayKey={todayKey} occurrences={main.occurrences} dayStatus={main.dayStatus} members={members} onSelectDay={onSelectDay} />
          )}
          {view === 'week' && (
            <WeekView anchor={anchor} tz={tz} todayKey={todayKey} occurrences={main.occurrences} dayStatus={main.dayStatus} conflicts={main.conflicts} members={members} onSelectDay={onSelectDay} />
          )}
          {view === 'day' && (
            <DayView day={anchor} tz={tz} isToday={anchor === todayKey} occurrences={main.occurrences} dayStatus={main.dayStatus} conflicts={main.conflicts} members={members} onOpen={(d) => setSelectedDay(d)} />
          )}
          <ul className="legend" aria-label="What the day markers mean">
            <li><span className="badge badge-scheduled"><span aria-hidden="true">✓</span> Scheduled</span></li>
            <li><span className="badge badge-conflict"><span aria-hidden="true">⚠</span> Conflict</span></li>
            <li><span className="legend-empty">No marker</span> Nothing planned</li>
          </ul>
        </main>
        <aside className="dash-side" aria-label="Family overview">
          <ConflictsPanel conflicts={agenda.conflicts} onOpen={(d) => { setAnchor(d); setSelectedDay(d); }} />
          <TodayPanel occurrences={agenda.occurrences} tz={tz} members={members} todayKey={todayKey} onOpen={setSelectedDay} />
          <UpcomingPanel occurrences={agenda.occurrences} tz={tz} members={members} todayKey={todayKey} onOpen={setSelectedDay} />
        </aside>
      </div>

      <DaySheet
        day={selectedDay} tz={tz} occurrences={main.occurrences} dayStatus={main.dayStatus} conflicts={main.conflicts}
        members={members} me={me} membersCanEditAll={editAll} onClose={() => setSelectedDay(null)}
        onAdd={openAdd} onEdit={startEdit} onDelete={startDelete}
      />

      <EventForm
        open={form.open} mode={form.mode} scope={form.scope} event={form.event} defaultDate={form.date || todayKey}
        me={me} members={members} tz={tz} onClose={() => setForm((f) => ({ ...f, open: false }))}
        onSaved={() => { toast.show(form.mode === 'create' ? 'Event added' : 'Event saved'); void refetch(); }}
        loadLatest={() => (form.event ? loadLatest(form.event) : Promise.resolve(null))}
      />

      <Dialog open={pending !== null} title={pending?.action === 'delete' ? 'Delete a repeating event' : 'Edit a repeating event'} onClose={() => setPending(null)}>
        <p><b>{pending?.ev.title}</b> repeats. What do you want to {pending?.action}?</p>
        <div className="stack">
          <button type="button" className="btn" onClick={() => { const p = pending!; setPending(null); if (p.action === 'edit') openEdit(p.ev, 'this'); else { setDeleteError(''); setDeleting({ ev: p.ev, scope: 'this' }); } }}>
            Only this one ({fmtDayLong(pending?.ev.occurrenceDate ?? todayKey)})
          </button>
          <button type="button" className="btn" onClick={() => { const p = pending!; setPending(null); if (p.action === 'edit') openEdit(p.ev, 'series'); else { setDeleteError(''); setDeleting({ ev: p.ev, scope: 'series' }); } }}>
            The whole series
          </button>
        </div>
      </Dialog>

      <Dialog open={deleting !== null} title="Delete this event?" onClose={() => setDeleting(null)} locked={deletePending}>
        <p>
          {deleting?.scope === 'this'
            ? <>Delete <b>{deleting.ev.title}</b> on {fmtDayLong(deleting.ev.occurrenceDate)}? The other dates stay.</>
            : <>Delete <b>{deleting?.ev.title}</b>{deleting?.ev.isRecurring ? ' and every repeat' : ''}? Everyone in the family will stop seeing it.</>}
        </p>
        {deleteError && <p className="form-error" role="alert">{deleteError}</p>}
        <div className="dlg-foot">
          <button type="button" className="btn" onClick={() => setDeleting(null)} disabled={deletePending}>Keep it</button>
          <button type="button" className="btn btn-danger" onClick={() => void confirmDelete()} disabled={deletePending}>{deletePending ? 'Deleting…' : 'Delete'}</button>
        </div>
      </Dialog>

      <MembersDialog open={dlg === 'members'} onClose={() => setDlg(null)} members={members} me={me} onChanged={() => void refetch()} />
      <InviteDialog open={dlg === 'invite'} onClose={() => setDlg(null)} calendarName={info.name} code={info.code} tz={tz} />
      <SettingsDialog key={`${info.updatedAt}`} open={dlg === 'settings'} onClose={() => setDlg(null)} calendar={info} me={me} onChanged={() => void refetch()} />
    </div>
  );
}
