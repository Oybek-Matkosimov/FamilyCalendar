import { api } from '@/server/api';
import { changePasswordSchema } from '@/lib/validation';
import { changePassword } from '@/server/services/calendars';

export const runtime = 'nodejs';

export const POST = api({ auth: true, schema: changePasswordSchema }, async ({ db, actor, body, token }) => {
  await changePassword(db, actor!, body.currentPassword, body.newPassword, token ?? undefined);
  return { body: { ok: true } };
});
