'use client';

import { useState } from 'react';
import { ApiError, apiFetch } from '@/lib/client/api';
import type { MemberDTO } from '@/lib/client/types';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { MemberDot } from './MemberDot';

interface Props {
  open: boolean;
  onClose: () => void;
  members: MemberDTO[];
  me: MemberDTO;
  onChanged: () => void;
}

export function MembersDialog({ open, onClose, members, me, onChanged }: Props) {
  const toast = useToast();
  const [removing, setRemoving] = useState<MemberDTO | null>(null);
  const [policy, setPolicy] = useState<'keep' | 'delete' | 'reassign'>('keep');
  const [reassignTo, setReassignTo] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  const others = removing ? members.filter((m) => m.id !== removing.id) : [];

  async function confirmRemove() {
    if (!removing || pending) return;
    if (policy === 'reassign' && !reassignTo) {
      setError('Choose who should take over these events');
      return;
    }
    setPending(true);
    setError('');
    try {
      const q = policy === 'reassign' ? `events=reassign&to=${reassignTo}` : `events=${policy}`;
      await apiFetch(`/api/members/${removing.id}?${q}`, { method: 'DELETE' });
      toast.show(`${removing.name} was removed`);
      setRemoving(null);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not remove this member');
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Dialog open={open && !removing} title="Family members" onClose={onClose}>
        <ul className="member-list">
          {members.map((m) => (
            <li key={m.id}>
              <MemberDot name={m.name} color={m.color} />
              <span className="member-name">{m.name}{m.id === me.id ? ' (you)' : ''}</span>
              <span className="role-tag">{m.role === 'owner' ? 'Owner' : 'Member'}</span>
              {me.role === 'owner' && m.role !== 'owner' && (
                <button type="button" className="btn btn-small btn-quiet" onClick={() => { setRemoving(m); setPolicy('keep'); setReassignTo(''); setError(''); }} aria-label={`Remove ${m.name}`}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="dlg-foot"><button type="button" className="btn" onClick={onClose}>Done</button></div>
      </Dialog>

      <Dialog open={open && !!removing} title={removing ? `Remove ${removing.name}?` : ''} onClose={() => setRemoving(null)} locked={pending}>
        <p>They will be signed out and can no longer see the calendar. What should happen to their events?</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <fieldset className="fieldset stack">
          <legend>Their events</legend>
          <label className="check"><input type="radio" name="policy" checked={policy === 'keep'} onChange={() => setPolicy('keep')} /><span>Keep them (shown as “former member”)</span></label>
          <label className="check"><input type="radio" name="policy" checked={policy === 'reassign'} onChange={() => setPolicy('reassign')} /><span>Give them to another member</span></label>
          <label className="check"><input type="radio" name="policy" checked={policy === 'delete'} onChange={() => setPolicy('delete')} /><span>Delete them</span></label>
        </fieldset>
        {policy === 'reassign' && (
          <SelectField label="Give events to" value={reassignTo} onChange={(e) => setReassignTo(e.target.value)}>
            <option value="">Choose a member</option>
            {others.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </SelectField>
        )}
        <div className="dlg-foot">
          <button type="button" className="btn" onClick={() => setRemoving(null)} disabled={pending}>Cancel</button>
          <button type="button" className="btn btn-danger" onClick={() => void confirmRemove()} disabled={pending}>{pending ? 'Removing…' : 'Remove member'}</button>
        </div>
      </Dialog>
    </>
  );
}
