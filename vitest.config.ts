import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: { globalSetup: ['tests/helpers/global-setup.ts'], include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'], testTimeout: 60000, hookTimeout: 120000, pool: 'forks', maxWorkers: 4 },
});
