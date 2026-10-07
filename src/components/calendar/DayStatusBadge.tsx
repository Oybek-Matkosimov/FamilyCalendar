import type { DayStatus } from '@/lib/client/types';

/**
 * Status is conveyed by icon + text + shape, never by colour alone:
 * scheduled = check mark and "N events"; conflict = warning triangle and "Conflict".
 */
export function DayStatusBadge({ status, count, compact }: { status: DayStatus | undefined; count?: number; compact?: boolean }) {
  if (!status) return null;
  if (status === 'conflict') {
    return (
      <span className="badge badge-conflict">
        <span aria-hidden="true">⚠</span>
        <span className={compact ? 'badge-text-wide' : undefined}>Conflict</span>
      </span>
    );
  }
  const label = count === undefined ? 'Scheduled' : count === 1 ? '1 event' : `${count} events`;
  return (
    <span className="badge badge-scheduled">
      <span aria-hidden="true">✓</span>
      <span className={compact ? 'badge-text-wide' : undefined}>{label}</span>
    </span>
  );
}
