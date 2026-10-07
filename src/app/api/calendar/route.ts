import { api } from '@/server/api';
import { deleteCalendarSchema, updateCalendarSchema } from '@/lib/validation';
import { deleteCalendar, getCalendar, updateCalendar } from '@/server/services/calendars';

export const runtime = 'nodejs';

export const GET = api({ auth: true }, async ({ db, actor }) => ({ body: await getCalendar(db, actor!) }));

export const PATCH = api({ auth: true, schema: updateCalendarSchema }, async ({ db, actor, body }) => ({
  body: await updateCalendar(db, actor!, body),
}));

export const DELETE = api({ auth: true, schema: deleteCalendarSchema }, async ({ db, actor, body }) => {
  await deleteCalendar(db, actor!, body.confirmName);
  return { body: { ok: true }, clearSession: true };
});
