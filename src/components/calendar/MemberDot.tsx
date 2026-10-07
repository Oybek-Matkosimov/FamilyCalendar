import type { MemberDTO } from '@/lib/client/types';

export const initial = (name: string) => (name.trim()[0] ?? '?').toUpperCase();

/** A member's coloured initial, like a fridge magnet. */
export function MemberDot({ name, color, size = 30 }: { name: string; color: string; size?: number }) {
  return (
    <span className="member-dot" style={{ background: color, width: size, height: size, fontSize: size * 0.45 }} aria-hidden="true">
      {initial(name)}
    </span>
  );
}

export function colorOf(members: MemberDTO[], id: string): string {
  return members.find((m) => m.id === id)?.color ?? '#6b7686';
}
