import { api } from '@/server/api';
import { joinInfoQuerySchema } from '@/lib/validation';
import { getJoinInfo } from '@/server/services/invites';
import { assertNotLocked, recordFailure } from '@/server/auth/lockout';
import { AppError } from '@/lib/errors';

export const runtime = 'nodejs';

export const GET = api({ auth: false, schema: joinInfoQuerySchema }, async ({ db, body, ip }) => {
  const keys = ip === 'unknown' ? [] : [`invite:${ip}`];
  if (keys.length) await assertNotLocked(db, keys);
  try {
    return { body: await getJoinInfo(db, body.token) };
  } catch (e) {
    if (keys.length && e instanceof AppError && e.code === 'NOT_FOUND') await recordFailure(db, keys, { max: 20 });
    throw e;
  }
});
