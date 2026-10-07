'use client';

import { useState } from 'react';
import { useToast } from '@/components/ui/Toast';

export function RecoveryCodePanel({ code, onDone, doneLabel = 'Open calendar' }: { code: string; onDone: () => void; doneLabel?: string }) {
  const [saved, setSaved] = useState(false);
  const toast = useToast();
  return (
    <div className="recovery">
      <p><b>Recovery code</b>. If the family forgets the password, this is the only way to reset it. It is shown once.</p>
      <code aria-label={`Recovery code ${code.split('').join(' ')}`}>{code}</code>
      <div className="row">
        <button
          type="button"
          className="btn btn-small"
          onClick={() => {
            navigator.clipboard?.writeText(code).then(
              () => toast.show('Recovery code copied'),
              () => toast.show('Could not copy. Write it down instead.', { error: true }),
            );
          }}
        >
          Copy code
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I saved my recovery code somewhere safe</span>
      </label>
      <button type="button" className="btn btn-primary" disabled={!saved} onClick={onDone}>{doneLabel}</button>
    </div>
  );
}
