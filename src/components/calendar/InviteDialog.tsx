'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiFetch } from '@/lib/client/api';
import { fmtDateTime } from '@/lib/client/dateUtils';
import type { InviteSummary } from '@/lib/client/types';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';

interface Props { open: boolean; onClose: () => void; calendarName: string; code: string; tz: string }

export function InviteDialog({ open, onClose, calendarName, code, tz }: Props) {
  const toast = useToast();
  const [hours, setHours] = useState('168');
  const [maxUses, setMaxUses] = useState('');
  const [fresh, setFresh] = useState<{ url: string } | null>(null);
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      setInvites((await apiFetch<{ invites: InviteSummary[] }>('/api/invites')).invites);
    } catch {
      /* the list is optional; creation errors are shown separately */
    }
  }, []);
  useEffect(() => {
    if (open) {
      setFresh(null);
      setError('');
      void reload();
    }
  }, [open, reload]);

  const shareText = (url: string) => `Join the ${calendarName} Family Calendar\nCalendar ID: ${code}\n${url}`;

  async function create() {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      const r = await apiFetch<{ token: string }>('/api/invites', {
        method: 'POST',
        body: { expiresInHours: Number(hours), maxUses: maxUses ? Number(maxUses) : null },
      });
      setFresh({ url: `${window.location.origin}/join?invite=${encodeURIComponent(r.token)}` });
      void reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create the invite');
    } finally {
      setPending(false);
    }
  }

  async function revoke(id: string) {
    try {
      await apiFetch(`/api/invites/${id}`, { method: 'DELETE' });
      toast.show('Invite revoked');
      void reload();
    } catch (e) {
      toast.show(e instanceof ApiError ? e.message : 'Could not revoke the invite', { error: true });
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.show('Copied');
    } catch {
      toast.show('Could not copy. Select the text and copy it by hand.', { error: true });
    }
  }

  return (
    <Dialog open={open} title="Invite family" onClose={onClose}>
      <p>Share the calendar ID, or send an invite link that fills it in. People always need the calendar password too. It is never part of a link.</p>
      <p className="big-code" aria-label={`Calendar ID ${code}`}>{code}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="field-row">
        <SelectField label="Link expires after" value={hours} onChange={(e) => setHours(e.target.value)}>
          <option value="24">1 day</option>
          <option value="168">7 days</option>
          <option value="720">30 days</option>
        </SelectField>
        <SelectField label="Uses" value={maxUses} onChange={(e) => setMaxUses(e.target.value)}>
          <option value="">Unlimited</option>
          <option value="1">1 person</option>
          <option value="5">5 people</option>
          <option value="10">10 people</option>
        </SelectField>
      </div>
      <button type="button" className="btn btn-primary" onClick={() => void create()} disabled={pending}>{pending ? 'Creating…' : 'Create invite link'}</button>
      {fresh && (
        <div className="stack">
          <label className="field">
            <span className="label">Message to send</span>
            <textarea readOnly rows={4} value={shareText(fresh.url)} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <div className="row">
            <button type="button" className="btn btn-small" onClick={() => void copy(shareText(fresh.url))}>Copy message</button>
            {typeof navigator !== 'undefined' && 'share' in navigator && (
              <button type="button" className="btn btn-small" onClick={() => void navigator.share({ title: `${calendarName} Family Calendar`, text: shareText(fresh.url) }).catch(() => {})}>Share…</button>
            )}
          </div>
          <p className="hint">This link is only shown now. You can revoke it below at any time.</p>
        </div>
      )}
      {invites.length > 0 && (
        <div className="stack">
          <h3>Active links</h3>
          <ul className="member-list">
            {invites.map((i) => {
              const dead = !!i.revokedAt || new Date(i.expiresAt) < new Date() || (i.maxUses !== null && i.uses >= i.maxUses);
              return (
                <li key={i.id}>
                  <span className="member-name">
                    {i.revokedAt ? 'Revoked' : dead ? 'Expired or used up' : 'Active'} · {i.uses}{i.maxUses ? ` of ${i.maxUses}` : ''} used · expires {fmtDateTime(i.expiresAt, tz)}
                  </span>
                  {!i.revokedAt && <button type="button" className="btn btn-small btn-quiet" onClick={() => void revoke(i.id)}>Revoke</button>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="dlg-foot"><button type="button" className="btn" onClick={onClose}>Done</button></div>
    </Dialog>
  );
}
