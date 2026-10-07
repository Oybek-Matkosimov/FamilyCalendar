'use client';

import { useState } from 'react';
import { ApiError, apiFetch } from '@/lib/client/api';
import { fmtDateTime } from '@/lib/client/dateUtils';

interface Entry { action: string; actorName: string; at: string }
const VERB: Record<string, string> = { create: 'Created', update: 'Edited', delete: 'Deleted', restore: 'Restored' };

export function HistoryPopover({ eventId, tz }: { eventId: string; tz: string }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState('');

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;
    try {
      const r = await apiFetch<{ history: Entry[] }>(`/api/events/${eventId}/history`);
      setEntries(r.history);
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load history');
    }
  }

  return (
    <div className="history">
      <button type="button" className="link-btn" aria-expanded={open} onClick={() => void toggle()}>
        {open ? 'Hide history' : 'History'}
      </button>
      {open && (
        <ul className="history-list" aria-live="polite">
          {error && <li className="error">{error}</li>}
          {!error && !entries && <li>Loading…</li>}
          {entries?.map((h, i) => (
            <li key={i}>{VERB[h.action] ?? h.action} by {h.actorName} — {fmtDateTime(h.at, tz)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
