import { defineConfig, devices } from '@playwright/test';

const ci = !!process.env.CI;

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
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !ci,
  },
});
