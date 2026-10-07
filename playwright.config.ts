import { defineConfig, devices } from '@playwright/test';

// Locally we reuse the installed Microsoft Edge so no browser download is needed; CI installs Chromium.
const channel = process.env.PW_CHANNEL ?? (process.env.CI ? undefined : 'msedge');

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3100', trace: 'retain-on-failure', channel },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } }, testIgnore: /responsive/ },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel }, testMatch: /responsive/ },
  ],
  webServer: {
    command: 'npx tsx scripts/e2e-server.ts',
    url: 'http://localhost:3100/api/health',
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
