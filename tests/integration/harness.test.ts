import { describe, it, expect, afterAll } from 'vitest';
import postgres from 'postgres';
import { createTestDb, stopTestServer } from '../helpers/db';

afterAll(stopTestServer);

describe('test harness', () => {
  it('provides an isolated real postgres database', async () => {
    const { url } = await createTestDb();
    const sql = postgres(url, { max: 1 });
    const [row] = await sql`select 1 as x`;
    expect(row!.x).toBe(1);
    await sql.end();
  });
});
