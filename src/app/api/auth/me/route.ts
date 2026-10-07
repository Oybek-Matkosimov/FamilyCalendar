import { api } from '@/server/api';
import { getCalendar } from '@/server/services/calendars';

export const runtime = 'nodejs';

export const GET = api({ auth: true }, async ({ db, actor }) => ({ body: await getCalendar(db, actor!) }));
