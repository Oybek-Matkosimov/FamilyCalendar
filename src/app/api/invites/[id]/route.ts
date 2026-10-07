import { api } from '@/server/api';
import { revokeInvite } from '@/server/services/invites';
import { uuidParam } from '@/server/params';

export const runtime = 'nodejs';

export const DELETE = api({ auth: true }, async ({ db, actor, params }) => {
  await revokeInvite(db, actor!, uuidParam(params.id));
  return { body: { ok: true } };
});
