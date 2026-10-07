'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/client/api';
import { PasswordField, SelectField, TextField } from '@/components/ui/Field';
import { RecoveryCodePanel } from '@/components/RecoveryCodePanel';
import { useToast } from '@/components/ui/Toast';
import { timezones } from '@/lib/client/timezones';

interface Created { calendar: { code: string; name: string }; recoveryCode: string }

export function CreateCalendarForm() {
  const router = useRouter();
  const toast = useToast();
  const tz = useMemo(() => timezones(), []);
  const [familyName, setFamilyName] = useState('');
  const [memberName, setMemberName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [timezone, setTimezone] = useState(tz.current);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    const next: Record<string, string> = {};
    if (!familyName.trim()) next.familyName = 'Enter a name for your family calendar';
    if (!memberName.trim()) next.memberName = 'Enter your name';
    if (password.length < 8) next.password = 'Use at least 8 characters';
    if (password.length > 128) next.password = 'Use at most 128 characters';
    if (confirm !== password) next.confirm = 'The passwords do not match';
    setErrors(next);
    setFormError('');
    if (Object.keys(next).length > 0) return;

    setPending(true);
    try {
      const r = await apiFetch<Created>('/api/calendars', {
        method: 'POST',
        body: { familyName, memberName, password, timezone },
      });
      setPassword('');
      setConfirm('');
      setCreated(r);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
      setFormError(msg);
      toast.show(msg, { error: true });
    } finally {
      setPending(false);
    }
  }

  if (created) {
    return (
      <section className="auth-card" aria-labelledby="created-title">
        <h1 id="created-title">{created.calendar.name} is ready</h1>
        <div className="stack">
          <div>
            <p className="sub">Calendar ID. Share this with your family:</p>
            <p className="big-code" aria-label={`Calendar ID ${created.calendar.code}`}>{created.calendar.code}</p>
          </div>
          <p className="sub">They will also need the password you just chose. We never show it again.</p>
          <RecoveryCodePanel code={created.recoveryCode} onDone={() => router.push('/calendar')} />
        </div>
      </section>
    );
  }

  return (
    <form className="auth-card" onSubmit={onSubmit} noValidate aria-labelledby="create-title">
      <div>
        <h1 id="create-title">Create a family calendar</h1>
        <p className="sub">You will be the owner. Everyone else joins with the calendar ID and password.</p>
      </div>
      {formError && <p className="form-error" role="alert">{formError}</p>}
      <TextField label="Family or calendar name" value={familyName} onChange={(e) => setFamilyName(e.target.value)} error={errors.familyName} maxLength={60} autoComplete="off" />
      <TextField label="Your name" value={memberName} onChange={(e) => setMemberName(e.target.value)} error={errors.memberName} maxLength={40} autoComplete="given-name" />
      <PasswordField label="Calendar password" hint="Shared with your family. At least 8 characters." value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} autoComplete="new-password" />
      <PasswordField label="Confirm password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={errors.confirm} autoComplete="new-password" />
      <SelectField label="Time zone" hint="Event times are shown in this zone for everyone. The owner can change it later." value={timezone} onChange={(e) => setTimezone(e.target.value)}>
        {tz.all.map((z) => <option key={z} value={z}>{z.replaceAll('_', ' ')}</option>)}
      </SelectField>
      <button type="submit" className="btn btn-primary btn-big" disabled={pending}>
        {pending ? 'Creating…' : 'Create calendar'}
      </button>
    </form>
  );
}
