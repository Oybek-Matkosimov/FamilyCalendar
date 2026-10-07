import { api } from '@/server/api';
import { conflictsQuerySchema } from '@/lib/validation';
import { getConflicts } from '@/server/services/events';

export const runtime = 'nodejs';

export const GET = api({ auth: true, schema: conflictsQuerySchema }, async ({ db, actor, body }) => ({
  body: await getConflicts(db, actor!, body.from, body.to),
}));
