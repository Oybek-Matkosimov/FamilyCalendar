import type { MemberDTO, OccurrenceDTO } from './types';

/** UI hints only. The server enforces the real policy in src/server/authz/policy.ts. */
export function canEditEvent(me: MemberDTO, ev: OccurrenceDTO, membersCanEditAll: boolean): boolean {
  if (me.role === 'owner') return true;
  return membersCanEditAll || ev.createdBy.id === me.id || ev.memberId === me.id;
}

export function canDeleteEvent(me: MemberDTO, ev: OccurrenceDTO): boolean {
  if (me.role === 'owner') return true;
  return ev.createdBy.id === me.id || ev.memberId === me.id;
}
