import { api } from '@/server/api';
import { getEventHistory } from '@/server/services/events';
import { uuidParam } from '@/server/params';

export const runtime = 'nodejs';

export const GET = api({ auth: true }, async ({ db, actor, params }) => ({
  body: { history: await getEventHistory(db, actor!, uuidParam(params.id)) },
}));
