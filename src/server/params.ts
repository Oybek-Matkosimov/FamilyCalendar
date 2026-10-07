import { z } from 'zod';
import { AppError } from '@/lib/errors';

const uuid = z.string().uuid();

/** Route ids that are not UUIDs can never match a row; report them as 404 instead of leaking a DB error. */
export function uuidParam(v: string | undefined): string {
  const r = uuid.safeParse(v);
  if (!r.success) throw new AppError('NOT_FOUND', 'Not found');
  return r.data;
}
