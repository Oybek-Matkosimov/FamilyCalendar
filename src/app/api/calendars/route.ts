import { api } from '@/server/api';
import { createCalendarSchema } from '@/lib/validation';
import { createCalendar } from '@/server/services/calendars';

export const runtime = 'nodejs';

export const POST = api({ auth: false, schema: createCalendarSchema }, async ({ req, body, db, ip }) => {
  const r = await createCalendar(db, body, { ip, ua: req.headers.get('user-agent') ?? undefined });
  return {
    status: 201,
    body: { calendar: r.calendar, member: r.member, recoveryCode: r.recoveryCode },
    setSession: { token: r.sessionToken, expires: r.sessionExpiresAt },
  };
});
