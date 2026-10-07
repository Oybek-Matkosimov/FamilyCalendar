'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { ApiError, apiFetch } from '@/lib/client/api';
import { timezones } from '@/lib/client/timezones';
import type { CalendarDTO, MemberDTO } from '@/lib/client/types';
import { Dialog } from '@/components/ui/Dialog';
import { PasswordField, SelectField, TextField } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';

interface Props {
  open: boolean;
  onClose: () => void;
  calendar: CalendarDTO;
  me: MemberDTO;
  onChanged: () => void;
}

export function SettingsDialog({ open, onClose, calendar, me, onChanged }: Props) {
  const toast = useToast();
  const isOwner = me.role === 'owner';
  const tz = useMemo(() => timezones(calendar.timezone), [calendar.timezone]);
  const [name, setName] = useState(calendar.name);
  const [timezone, setTimezone] = useState(calendar.timezone);
  const [editAll, setEditAll] = useState(calendar.settings.membersCanEditAll);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [pwPending, setPwPending] = useState(false);
  const [pwError, setPwError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [delPending, setDelPending] = useState(false);
  const [delError, setDelError] = useState('');

  async function save(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await apiFetch('/api/calendar', { method: 'PATCH', body: { name, timezone, settings: { membersCanEditAll: editAll } } });
      toast.show('Settings saved');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save settings');
    } finally {
      setSaving(false);
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    if (pwPending) return;
    if (next.length < 8) return setPwError('Use at least 8 characters');
    setPwPending(true);
    setPwError('');
    try {
      await apiFetch('/api/calendar/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      setCurrent('');
      setNext('');
      toast.show('Password changed. Other devices were signed out.');
    } catch (err) {
      setPwError(err instanceof ApiError ? err.message : 'Could not change the password');
    } finally {
      setPwPending(false);
    }
  }

  async function deleteCalendar() {
    if (delPending) return;
    setDelPending(true);
    setDelError('');
    try {
      await apiFetch('/api/calendar', { method: 'DELETE', body: { confirmName } });
      window.location.assign('/');
    } catch (err) {
      setDelError(err instanceof ApiError ? err.message : 'Could not delete the calendar');
      setDelPending(false);
    }
  }

  async function signOut() {
    await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.assign('/');
  }

  return (
    <>
      <Dialog open={open && !confirmDelete} title="Settings" onClose={onClose}>
        <p>Signed in as <b>{me.name}</b>. Calendar ID: <b>{calendar.code}</b>.</p>
        {isOwner ? (
          <>
            <form className="stack" onSubmit={save}>
              {error && <p className="form-error" role="alert">{error}</p>}
              <TextField label="Calendar name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
              <SelectField label="Time zone" hint="Event times are shown in this zone for everyone." value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {tz.all.map((z) => <option key={z} value={z}>{z.replaceAll('_', ' ')}</option>)}
              </SelectField>
              <label className="check">
                <input type="checkbox" checked={editAll} onChange={(e) => setEditAll(e.target.checked)} />
                <span>Members can edit each other’s events. Members can always delete only their own.</span>
              </label>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
            </form>
            <form className="stack" onSubmit={changePassword}>
              <h3>Change password</h3>
              {pwError && <p className="form-error" role="alert">{pwError}</p>}
              <PasswordField label="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
              <PasswordField label="New password" hint="At least 8 characters. Everyone else is signed out." value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
              <button type="submit" className="btn" disabled={pwPending || !current || !next}>{pwPending ? 'Changing…' : 'Change password'}</button>
            </form>
            <div className="danger-zone stack">
              <h3>Delete this calendar</h3>
              <p>This permanently deletes every event, member and invite. It cannot be undone.</p>
              <button type="button" className="btn btn-danger" onClick={() => { setConfirmDelete(true); setConfirmName(''); setDelError(''); }}>Delete calendar…</button>
            </div>
          </>
        ) : (
          <p className="hint">Only the calendar owner can change calendar settings.</p>
        )}
        <div className="dlg-foot">
          <button type="button" className="btn" onClick={() => void signOut()}>Sign out</button>
          <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </Dialog>

      <Dialog open={open && confirmDelete} title="Delete the calendar?" onClose={() => setConfirmDelete(false)} locked={delPending}>
        <p>Type <b>{calendar.name}</b> to confirm. Everything will be erased for the whole family.</p>
        {delError && <p className="form-error" role="alert">{delError}</p>}
        <TextField label="Calendar name" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
        <div className="dlg-foot">
          <button type="button" className="btn" onClick={() => setConfirmDelete(false)} disabled={delPending}>Keep calendar</button>
          <button type="button" className="btn btn-danger" onClick={() => void deleteCalendar()} disabled={delPending || confirmName.trim() !== calendar.name}>
            {delPending ? 'Deleting…' : 'Delete everything'}
          </button>
        </div>
      </Dialog>
    </>
  );
}
