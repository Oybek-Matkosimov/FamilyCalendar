import { api } from '@/server/api';
import { eventInputSchema, eventsQuerySchema } from '@/lib/validation';
import { createEvent, listEvents } from '@/server/services/events';

export const runtime = 'nodejs';

export const GET = api({ auth: true, schema: eventsQuerySchema }, async ({ db, actor, body }) => ({
  body: await listEvents(db, actor!, { from: body.from, to: body.to, memberId: body.member, search: body.q }),
}));

export const POST = api({ auth: true, schema: eventInputSchema }, async ({ db, actor, body, req }) => ({
  status: 201,
  body: await createEvent(db, actor!, body, req.headers.get('idempotency-key') ?? undefined),
}));
