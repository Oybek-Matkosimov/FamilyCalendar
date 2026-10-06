import { describe, it, expect } from 'vitest';
import { parseEnv } from '@/config/env';

describe('parseEnv', () => {
  it('requires DATABASE_URL', () => {
    expect(() => parseEnv({ NODE_ENV: 'test' })).toThrow(/DATABASE_URL/);
  });
  it('parses defaults', () => {
    const env = parseEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://x/y', APP_ORIGIN: 'http://localhost:3000' });
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.LOG_LEVEL).toBe('info');
  });
  it('requires https APP_ORIGIN in production', () => {
    expect(() => parseEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', APP_ORIGIN: 'http://a.com' })).toThrow(/https/);
  });
});
