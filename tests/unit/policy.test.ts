import { describe, it, expect } from 'vitest';
import { authorize, type Actor } from '@/server/authz/policy';

const owner: Actor = { calendarId: 'c', memberId: 'o', role: 'owner' };
const mom: Actor = { calendarId: 'c', memberId: 'm', role: 'member' };
const ev = { createdBy: 'o', memberId: 'o' };

describe('authorize', () => {
  it('owner can do admin actions; member cannot', () => {
    for (const a of ['calendar.update', 'calendar.delete', 'password.change', 'member.remove', 'invite.manage', 'event.restore'] as const) {
      expect(() => authorize(owner, a)).not.toThrow();
      expect(() => authorize(mom, a)).toThrow(/permission/i);
    }
  });
  it('everyone can view and create events', () => {
    expect(() => authorize(mom, 'event.view')).not.toThrow();
    expect(() => authorize(mom, 'event.create')).not.toThrow();
  });
  it('member edits others events only if membersCanEditAll (default true)', () => {
    expect(() => authorize(mom, 'event.update', { settings: { membersCanEditAll: true }, event: ev })).not.toThrow();
    expect(() => authorize(mom, 'event.update', { event: ev })).not.toThrow();
    expect(() => authorize(mom, 'event.update', { settings: { membersCanEditAll: false }, event: ev })).toThrow();
    expect(() => authorize(mom, 'event.update', { settings: { membersCanEditAll: false }, event: { createdBy: 'm', memberId: 'o' } })).not.toThrow();
  });
  it('member deletes only own events (created or assigned); owner deletes any', () => {
    expect(() => authorize(mom, 'event.delete', { event: ev })).toThrow();
    expect(() => authorize(mom, 'event.delete', { event: { createdBy: 'm', memberId: 'o' } })).not.toThrow();
    expect(() => authorize(mom, 'event.delete', { event: { createdBy: 'o', memberId: 'm' } })).not.toThrow();
    expect(() => authorize(owner, 'event.delete', { event: { createdBy: 'm', memberId: 'm' } })).not.toThrow();
  });
});
