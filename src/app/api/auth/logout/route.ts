import { api } from '@/server/api';
import { revokeSession } from '@/server/auth/session';

export const runtime = 'nodejs';

export const POST = api({ auth: false }, async ({ db, token }) => {
  if (token) await revokeSession(db, token);
  return { body: { ok: true }, clearSession: true };
});
