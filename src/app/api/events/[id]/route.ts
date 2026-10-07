import { api } from '@/server/api';
import { deleteEventQuerySchema, eventPatchSchema } from '@/lib/validation';
import { deleteEvent, updateEvent } from '@/server/services/events';
import { uuidParam } from '@/server/params';

export const runtime = 'nodejs';

export const PATCH = api({ auth: true, schema: eventPatchSchema }, async ({ db, actor, body, params }) => ({
  body: await updateEvent(db, actor!, uuidParam(params.id), body),
}));

export const DELETE = api({ auth: true, schema: deleteEventQuerySchema }, async ({ db, actor, body, params }) => {
  await deleteEvent(db, actor!, uuidParam(params.id), body);
  return { body: { ok: true } };
});
