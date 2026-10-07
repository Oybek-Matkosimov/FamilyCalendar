import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** Number of trusted reverse proxies in front of the app (X-Forwarded-For hops counted from the right). */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).max(5).default(1),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});
export type Env = z.infer<typeof schema>;

export function parseEnv(raw: Record<string, string | undefined>): Env {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new Error('Invalid environment: ' + r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  if (r.data.NODE_ENV === 'production' && !r.data.APP_ORIGIN.startsWith('https://')) {
    throw new Error('Invalid environment: APP_ORIGIN must be https in production');
  }
  return r.data;
}

let cached: Env | undefined;
export function getEnv(): Env {
  return (cached ??= parseEnv(process.env));
}
export function resetEnvCache() {
  cached = undefined;
}
