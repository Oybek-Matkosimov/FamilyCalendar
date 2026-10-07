'use client';

import { useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiFetch } from '@/lib/client/api';
import { addDays, addMinutesLocal, fmtDateTime, localParts } from '@/lib/client/dateUtils';
import type { MemberDTO, OccurrenceDTO, RecurrenceInput } from '@/lib/client/types';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField, TextAreaField, TextField } from '@/components/ui/Field';

type Day = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';
const DAYS: { id: Day; label: string }[] = [
  { id: 'MO', label: 'Mon' }, { id: 'TU', label: 'Tue' }, { id: 'WE', label: 'Wed' }, { id: 'TH', label: 'Thu' },
  { id: 'FR', label: 'Fri' }, { id: 'SA', label: 'Sat' }, { id: 'SU', label: 'Sun' },
];
type Repeat = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

interface Props {
  open: boolean;
  mode: 'create' | 'edit';
  /** For edits of a repeating event: change just this date, or the whole series. */
  scope?: 'this' | 'series';
  event?: OccurrenceDTO;
  defaultDate: string;
  me: MemberDTO;
  members: MemberDTO[];
  tz: string;
  onClose: () => void;
  onSaved: () => void;
  /** Re-fetch the current server version of an event (used after an edit conflict). */
  loadLatest: (eventId: string) => Promise<OccurrenceDTO | null>;
}

interface Initial {
  title: string; memberId: string; description: string; location: string; allDay: boolean;
  date: string; startTime: string; endDate: string; endTime: string;
  repeat: Repeat; interval: number; byDay: Day[]; endsType: 'never' | 'on' | 'after'; until: string; count: number;
}

function initialFor(p: Props): Initial {
  const base: Initial = {
    title: '', memberId: p.me.id, description: '', location: '', allDay: false,
    date: p.defaultDate, startTime: '09:00', endDate: p.defaultDate, endTime: '10:00',
    repeat: 'none', interval: 1, byDay: [], endsType: 'never', until: '', count: 10,
  };
  const ev = p.event;
  if (p.mode !== 'edit' || !ev) return base;
  let start: { date: string; time: string };
  let end: { date: string; time: string };
  if (p.scope === 'this' || !ev.isRecurring) {
    start = localParts(ev.start, p.tz);
    end = localParts(ev.end, p.tz);
  } else {
    start = { date: ev.localStart.slice(0, 10), time: ev.localStart.slice(11, 16) };
    end = { date: ev.localEnd.slice(0, 10), time: ev.localEnd.slice(11, 16) };
  }
  let endDate = end.date;
  if (ev.allDay && end.time === '00:00' && endDate > start.date) endDate = addDays(endDate, -1); // exclusive -> inclusive
  const rec = ev.recurrence;
  return {
    ...base,
    title: ev.title, memberId: ev.memberId, description: ev.description ?? '', location: ev.location ?? '', allDay: ev.allDay,
    date: start.date, startTime: start.time, endDate, endTime: end.time,
    repeat: rec ? rec.freq : 'none', interval: rec?.interval ?? 1, byDay: (rec?.byDay as Day[] | undefined) ?? [],
    endsType: rec?.until ? 'on' : rec?.count ? 'after' : 'never', until: rec?.until ?? '', count: rec?.count ?? 10,
  };
}

export function EventForm(props: Props) {
  const { open, mode, scope, event, me, members, tz, onClose, onSaved, loadLatest } = props;
  // Remount the form body whenever it is (re)opened so state always starts from the right event.
  const initial = useMemo(() => initialFor(props), [props.event?.eventId, props.event?.version, props.open, props.defaultDate, props.mode, props.scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = `${open}-${mode}-${event?.eventId ?? 'new'}-${scope ?? ''}`;
  return (
    <Dialog open={open} title={mode === 'create' ? 'Add event' : scope === 'this' ? 'Edit this occurrence' : event?.isRecurring ? 'Edit repeating event' : 'Edit event'} onClose={onClose} sheet>
      {open && <FormBody key={key} initial={initial} {...{ mode, scope, event, me, members, tz, onClose, onSaved, loadLatest }} />}
    </Dialog>
  );
}

function FormBody({ initial, mode, scope, event, me, members, tz, onClose, onSaved, loadLatest }: Omit<Props, 'open' | 'defaultDate'> & { initial: Initial }) {
  const [f, setF] = useState<Initial>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const version = useRef(event?.version ?? 1);
  const idemKey = useRef(crypto.randomUUID());
  const set = <K extends keyof Initial>(k: K, v: Initial[K]) => setF((cur) => ({ ...cur, [k]: v }));
  const showRepeat = scope !== 'this';

  function changeStartDate(date: string) {
    setF((cur) => {
      const delta = Math.round((Date.parse(date) - Date.parse(cur.date)) / 86400000);
      return { ...cur, date, endDate: Number.isNaN(delta) ? cur.endDate : addDays(cur.endDate, delta) };
    });
  }
  function changeStartTime(t: string) {
    setF((cur) => {
      // keep the same duration when the start moves
      const dur = (Date.parse(`${cur.endDate}T${cur.endTime}:00Z`) - Date.parse(`${cur.date}T${cur.startTime}:00Z`)) / 60000;
      if (!t || Number.isNaN(dur) || dur <= 0) return { ...cur, startTime: t };
      const end = addMinutesLocal(cur.date, t, dur);
      return { ...cur, startTime: t, endDate: end.date, endTime: end.time };
    });
  }

  function recurrence(): RecurrenceInput | null {
    if (f.repeat === 'none') return null;
    const r: RecurrenceInput = { freq: f.repeat };
    if (f.repeat === 'custom') {
      r.interval = f.interval;
      if (f.byDay.length) r.byDay = f.byDay;
    }
    if (f.endsType === 'on' && f.until) r.until = f.until;
    if (f.endsType === 'after') r.count = f.count;
    return r;
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!f.title.trim()) next.title = 'Enter a title';
    if (!f.date) next.date = 'Choose a date';
    if (!f.allDay) {
      if (!f.startTime) next.startTime = 'Choose a start time';
      if (!f.endTime) next.endTime = 'Choose an end time';
      if (f.date && f.startTime && f.endTime && `${f.endDate}T${f.endTime}` <= `${f.date}T${f.startTime}`) next.endTime = 'The end must be after the start';
    } else if (f.endDate < f.date) {
      next.endDate = 'The end date cannot be before the start';
    }
    if (f.repeat === 'custom' && (f.interval < 1 || f.interval > 52)) next.interval = 'Enter a number from 1 to 52';
    if (f.endsType === 'on' && f.repeat !== 'none' && !f.until) next.until = 'Choose when the repeat ends';
    if (f.endsType === 'after' && (f.count < 1 || f.count > 1000)) next.count = 'Enter a number from 1 to 1000';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    setFormError('');
    setNotice('');
    if (!validate()) return;
    const start = f.allDay ? `${f.date}T00:00` : `${f.date}T${f.startTime}`;
    const end = f.allDay ? `${addDays(f.endDate, 1)}T00:00` : `${f.endDate}T${f.endTime}`;
    const common = { title: f.title, memberId: f.memberId, description: f.description, location: f.location, allDay: f.allDay, start, end };
    setPending(true);
    try {
      if (mode === 'create') {
        const rec = recurrence();
        await apiFetch('/api/events', { method: 'POST', body: { ...common, ...(rec ? { recurrence: rec } : {}) }, idempotencyKey: idemKey.current });
      } else {
        await apiFetch(`/api/events/${event!.eventId}`, {
          method: 'PATCH',
          body: {
            ...common, version: version.current, scope: scope ?? 'series',
            ...(scope === 'this' ? { occurrenceDate: event!.occurrenceDate } : { recurrence: recurrence() }),
          },
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT' && mode === 'edit') {
        const latest = await loadLatest(event!.eventId).catch(() => null);
        if (latest) {
          version.current = latest.version;
          setNotice(`${latest.updatedBy.name} changed this event at ${fmtDateTime(latest.updatedAt, tz)} (now “${latest.title}”). Your edits are still in the form. Check them, then save again to replace their version.`);
        } else {
          setFormError('This event was deleted or changed by someone else. Close this form to see the latest calendar.');
        }
      } else if (err instanceof ApiError && err.code === 'NETWORK') {
        setFormError('Cannot reach the server. Nothing was lost. Your changes are still here, so try saving again.');
      } else {
        setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      }
    } finally {
      setPending(false);
    }
  }

  const toggleDay = (d: Day) => set('byDay', f.byDay.includes(d) ? f.byDay.filter((x) => x !== d) : [...f.byDay, d]);

  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      {notice && <p className="form-notice" role="alert">{notice}</p>}
      {formError && <p className="form-error" role="alert">{formError}</p>}
      <TextField label="Title" value={f.title} onChange={(e) => set('title', e.target.value)} error={errors.title} maxLength={120} autoFocus={mode === 'create'} autoComplete="off" />
      <SelectField label="Who is this for?" value={f.memberId} onChange={(e) => set('memberId', e.target.value)}>
        {members.map((m) => <option key={m.id} value={m.id}>{m.name}{m.id === me.id ? ' (you)' : ''}</option>)}
      </SelectField>
      <label className="check">
        <input type="checkbox" checked={f.allDay} onChange={(e) => set('allDay', e.target.checked)} />
        <span>All day</span>
      </label>
      <fieldset className="field-row fieldset">
        <legend>Starts</legend>
        <TextField label="Date" type="date" value={f.date} onChange={(e) => changeStartDate(e.target.value)} error={errors.date} />
        {!f.allDay && <TextField label="Time" type="time" value={f.startTime} onChange={(e) => changeStartTime(e.target.value)} error={errors.startTime} />}
      </fieldset>
      <fieldset className="field-row fieldset">
        <legend>Ends</legend>
        <TextField label="Date" type="date" value={f.endDate} onChange={(e) => set('endDate', e.target.value)} error={errors.endDate} />
        {!f.allDay && <TextField label="Time" type="time" value={f.endTime} onChange={(e) => set('endTime', e.target.value)} error={errors.endTime} hint={f.endDate > f.date ? 'Ends on a later day' : undefined} />}
      </fieldset>
      <TextField label="Location (optional)" value={f.location} onChange={(e) => set('location', e.target.value)} maxLength={200} autoComplete="off" />
      <TextAreaField label="Comment (optional)" value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} />
      {showRepeat && (
        <>
          <SelectField label="Repeat" value={f.repeat} onChange={(e) => set('repeat', e.target.value as Repeat)}>
            <option value="none">Does not repeat</option>
            <option value="daily">Every day</option>
            <option value="weekdays">Every weekday (Mon–Fri)</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
            <option value="custom">Custom</option>
          </SelectField>
          {f.repeat === 'custom' && (
            <div className="stack">
              <TextField label="Repeat every (weeks)" type="number" min={1} max={52} value={f.interval} onChange={(e) => set('interval', Number(e.target.value))} error={errors.interval} />
              <fieldset className="fieldset">
                <legend>On these days</legend>
                <div className="days-row">
                  {DAYS.map((d) => (
                    <label key={d.id} className={`day-toggle${f.byDay.includes(d.id) ? ' is-on' : ''}`}>
                      <input type="checkbox" checked={f.byDay.includes(d.id)} onChange={() => toggleDay(d.id)} />
                      <span>{d.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          )}
          {f.repeat !== 'none' && (
            <div className="stack">
              <SelectField label="Ends" value={f.endsType} onChange={(e) => set('endsType', e.target.value as Initial['endsType'])}>
                <option value="never">Never</option>
                <option value="on">On a date</option>
                <option value="after">After a number of times</option>
              </SelectField>
              {f.endsType === 'on' && <TextField label="Last day" type="date" value={f.until} onChange={(e) => set('until', e.target.value)} error={errors.until} />}
              {f.endsType === 'after' && <TextField label="Number of times" type="number" min={1} max={1000} value={f.count} onChange={(e) => set('count', Number(e.target.value))} error={errors.count} />}
            </div>
          )}
        </>
      )}
      <div className="dlg-foot">
        <button type="button" className="btn" onClick={onClose} disabled={pending}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'Saving…' : mode === 'create' ? 'Add event' : 'Save changes'}</button>
      </div>
    </form>
  );
}
