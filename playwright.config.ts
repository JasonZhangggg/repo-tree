import { defineConfig, devices } from '@playwright/test';

const ci = !!process.env.CI;
const HISTORY = /history-compute\.spec\.ts$/;

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    launchOptions: {
      // Lets a sandbox point at a preinstalled Chromium when its revision differs from this Playwright's.
      executablePath: process.env.PW_CHROMIUM_PATH,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: HISTORY },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testIgnore: HISTORY },
    // Sign-in and compute against a fake GitHub and the real Worker (e2e/history-stack.mjs).
    {
      name: 'history',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4176' },
      testMatch: HISTORY,
    },
  ],
  webServer: [
    {
      command: 'npm run build && npm run preview',
      url: 'http://localhost:4173',
      reuseExistingServer: !ci,
    },
    {
      command: 'node e2e/history-stack.mjs 4176 4177 4178',
      url: 'http://localhost:4176',
      reuseExistingServer: !ci,
      timeout: 120_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
  ],
});
