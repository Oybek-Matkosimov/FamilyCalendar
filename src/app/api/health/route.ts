import { sql } from 'drizzle-orm';
import { getDb } from '@/server/db/client';
import { errorResponse } from '@/server/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    await getDb().execute(sql`select 1`);
    return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    const res = errorResponse(e);
    return res.status === 503 ? res : Response.json({ ok: false }, { status: 503 });
  }
}
