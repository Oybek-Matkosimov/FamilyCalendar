import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema';
import { getEnv } from '@/config/env';

export type Db = PostgresJsDatabase<typeof schema>;
export type Sql = postgres.Sql;

export function createDb(url: string, max = 10) {
  const sql = postgres(url, { max, idle_timeout: 20, connect_timeout: 10 });
  return { sql, db: drizzle(sql, { schema }) };
}

const g = globalThis as unknown as { __fcDb?: ReturnType<typeof createDb> };
function shared() {
  return (g.__fcDb ??= createDb(getEnv().DATABASE_URL));
}
export const getDb = (): Db => shared().db;
export const getSql = (): Sql => shared().sql;
