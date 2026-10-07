import { api } from '@/server/api';
import { restoreEvent } from '@/server/services/events';
import { uuidParam } from '@/server/params';

export const runtime = 'nodejs';

export const POST = api({ auth: true }, async ({ db, actor, params }) => ({
  body: await restoreEvent(db, actor!, uuidParam(params.id)),
}));
