import { api } from '@/server/api';
import { removeMemberQuerySchema } from '@/lib/validation';
import { removeMember } from '@/server/services/members';
import { uuidParam } from '@/server/params';

export const runtime = 'nodejs';

export const DELETE = api({ auth: true, schema: removeMemberQuerySchema }, async ({ db, actor, body, params }) => {
  const id = uuidParam(params.id);
  await removeMember(db, actor!, id, { eventsPolicy: body.events === 'reassign' ? { reassignTo: body.to! } : body.events });
  return { body: { ok: true } };
});
