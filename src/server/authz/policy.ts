import { AppError } from '@/lib/errors';

export interface Actor {
  calendarId: string;
  memberId: string;
  role: 'owner' | 'member';
}

export type Action =
  | 'calendar.update' | 'calendar.delete' | 'password.change' | 'member.remove' | 'invite.manage'
  | 'event.create' | 'event.update' | 'event.delete' | 'event.view' | 'event.restore';

export interface PolicyContext {
  settings?: { membersCanEditAll: boolean };
  event?: { createdBy: string; memberId: string };
}

const ADMIN: Action[] = ['calendar.update', 'calendar.delete', 'password.change', 'member.remove', 'invite.manage', 'event.restore'];

/** Single source of truth for who may do what. Throws FORBIDDEN. */
export function authorize(actor: Actor, action: Action, ctx: PolicyContext = {}): void {
  const deny = (): never => {
    throw new AppError('FORBIDDEN', 'You do not have permission to do that');
  };
  if (ADMIN.includes(action)) {
    if (actor.role !== 'owner') deny();
    return;
  }
  if (actor.role === 'owner') return;
  const mine = !!ctx.event && (ctx.event.createdBy === actor.memberId || ctx.event.memberId === actor.memberId);
  if (action === 'event.update' && !mine && !(ctx.settings?.membersCanEditAll ?? true)) deny();
  if (action === 'event.delete' && !mine) deny();
}
