import { api } from '@/server/api';
import { joinSchema } from '@/lib/validation';
import { joinCalendar } from '@/server/services/calendars';

export const runtime = 'nodejs';

export const POST = api({ auth: false, schema: joinSchema }, async ({ req, body, db, ip }) => {
  const r = await joinCalendar(db, body, { ip, ua: req.headers.get('user-agent') ?? undefined });
  if (r.status === 'needs_confirmation') return { status: 200, body: { status: r.status } };
  return {
    body: { status: r.status, calendar: r.calendar, member: r.member },
    setSession: { token: r.sessionToken!, expires: r.sessionExpiresAt! },
  };
});
