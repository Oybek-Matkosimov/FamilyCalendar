import { api } from '@/server/api';
import { recoverSchema } from '@/lib/validation';
import { recoverPassword } from '@/server/services/calendars';

export const runtime = 'nodejs';

export const POST = api({ auth: false, schema: recoverSchema }, async ({ body, db, ip }) => ({
  body: await recoverPassword(db, body.code, body.recoveryCode, body.newPassword, { ip }),
}));
