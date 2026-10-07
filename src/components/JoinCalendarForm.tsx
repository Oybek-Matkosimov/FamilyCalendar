'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/client/api';
import { PasswordField, TextField } from '@/components/ui/Field';
import { Dialog } from '@/components/ui/Dialog';

export function JoinCalendarForm() {
  const router = useRouter();
  const params = useSearchParams();
  const invite = params.get('invite') ?? undefined;
  const [code, setCode] = useState((params.get('code') ?? '').toUpperCase());
  const [inviteName, setInviteName] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState('');
  const [memberName, setMemberName] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [pending, setPending] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [proofOpen, setProofOpen] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');

  useEffect(() => {
    if (!invite) return;
    let cancelled = false;
    apiFetch<{ calendarName: string; code: string }>(`/api/join-info?token=${encodeURIComponent(invite)}`).then(
      (info) => { if (!cancelled) { setInviteName(info.calendarName); setCode(info.code); } },
      (err) => { if (!cancelled) setInviteError(err instanceof ApiError ? err.message : 'Could not check this invite'); },
    );
    return () => { cancelled = true; };
  }, [invite]);

  async function submit(confirmExisting: boolean, proof?: string) {
    if (pending) return;
    setPending(true);
    setFormError('');
    try {
      const r = await apiFetch<{ status: 'joined' | 'needs_confirmation' | 'needs_owner_proof' }>('/api/auth/join', {
        method: 'POST',
        body: { code, memberName, password, confirmExisting: confirmExisting || undefined, inviteToken: invite, recoveryCode: proof || undefined },
      });
      if (r.status === 'needs_confirmation') {
        setConfirmOpen(true);
        return;
      }
      if (r.status === 'needs_owner_proof') {
        setConfirmOpen(false);
        setProofOpen(true);
        return;
      }
      router.push('/calendar');
    } catch (err) {
      setConfirmOpen(false);
      setProofOpen(false);
      if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
        setFormError('Too many attempts. Wait a few minutes, then try again.');
      } else {
        setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      }
    } finally {
      setPending(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!/^[A-Za-z]{4}-\d{4}$/.test(code.trim())) next.code = 'Enter the calendar ID, like MATK-4829';
    if (!memberName.trim()) next.memberName = 'Enter your name';
    if (!password) next.password = 'Enter the calendar password';
    setErrors(next);
    if (Object.keys(next).length === 0) void submit(false);
  }

  return (
    <>
      <form className="auth-card" onSubmit={onSubmit} noValidate aria-labelledby="join-title">
        <div>
          <h1 id="join-title">{inviteName ? `Join the ${inviteName} calendar` : 'Join a family calendar'}</h1>
          <p className="sub">Ask whoever set up the calendar for the ID and password.</p>
        </div>
        {inviteError && <p className="form-error" role="alert">{inviteError}. You can still join with the calendar ID and password.</p>}
        {formError && <p className="form-error" role="alert">{formError}</p>}
        <TextField
          label="Calendar ID" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
          error={errors.code} readOnly={!!inviteName} autoCapitalize="characters" autoComplete="off" maxLength={9} placeholder="MATK-4829"
        />
        <TextField label="Your name" value={memberName} onChange={(e) => setMemberName(e.target.value)} error={errors.memberName} maxLength={40} autoComplete="given-name" />
        <PasswordField label="Calendar password" value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} autoComplete="current-password" />
        <button type="submit" className="btn btn-primary btn-big" disabled={pending}>{pending ? 'Joining…' : 'Join calendar'}</button>
      </form>

      <Dialog open={proofOpen} title="Sign in as the owner" onClose={() => setProofOpen(false)} locked={pending}>
        <p><b>{memberName.trim()}</b> is the calendar owner. To sign in as the owner on a new device, enter the recovery code you saved when the calendar was created.</p>
        <TextField label="Recovery code" value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())} autoComplete="off" placeholder="XXXX-XXXX-XXXX" />
        <p className="hint">Not the owner? Close this and join with a different name.</p>
        <div className="dlg-foot">
          <button type="button" className="btn" onClick={() => setProofOpen(false)} disabled={pending}>Use a different name</button>
          <button type="button" className="btn btn-primary" onClick={() => void submit(true, recoveryCode)} disabled={pending || recoveryCode.trim().length < 8}>Sign in as owner</button>
        </div>
      </Dialog>

      <Dialog open={confirmOpen} title="Is this you?" onClose={() => setConfirmOpen(false)} locked={pending}>
        <p>A member named <b>{memberName.trim()}</b> is already on this calendar. If that is you on another device, continue as them.</p>
        <div className="dlg-foot">
          <button type="button" className="btn" onClick={() => setConfirmOpen(false)} disabled={pending}>No, use a different name</button>
          <button type="button" className="btn btn-primary" onClick={() => void submit(true)} disabled={pending}>Yes, that’s me</button>
        </div>
      </Dialog>
    </>
  );
}
