import { api } from '@/server/api';
import { createInviteSchema } from '@/lib/validation';
import { createInvite, listInvites } from '@/server/services/invites';

export const runtime = 'nodejs';

export const GET = api({ auth: true }, async ({ db, actor }) => ({ body: { invites: await listInvites(db, actor!) } }));

export const POST = api({ auth: true, schema: createInviteSchema }, async ({ db, actor, body }) => ({
  status: 201,
  body: await createInvite(db, actor!, body),
}));
