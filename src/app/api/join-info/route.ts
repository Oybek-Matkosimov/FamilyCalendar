import { api } from '@/server/api';
import { joinInfoQuerySchema } from '@/lib/validation';
import { getJoinInfo } from '@/server/services/invites';
import { assertNotLocked, recordFailure } from '@/server/auth/lockout';
import { AppError } from '@/lib/errors';

export const runtime = 'nodejs';

export const GET = api({ auth: false, schema: joinInfoQuerySchema }, async ({ db, body, ip }) => {
  const key = `invite:${ip}`;
  await assertNotLocked(db, [key]);
  try {
    return { body: await getJoinInfo(db, body.token) };
  } catch (e) {
    if (e instanceof AppError && e.code === 'NOT_FOUND') await recordFailure(db, [key], { max: 20 });
    throw e;
  }
});
