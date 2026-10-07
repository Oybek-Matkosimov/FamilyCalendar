import { api } from '@/server/api';
import { listMembers } from '@/server/services/members';

export const runtime = 'nodejs';

export const GET = api({ auth: true }, async ({ db, actor }) => ({ body: { members: await listMembers(db, actor!) } }));
