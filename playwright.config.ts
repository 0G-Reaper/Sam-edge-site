import { defineConfig, devices } from '@playwright/test'
import { readdirSync, existsSync } from 'node:fs'

// Uses the Chromium that ships with the sandbox/CI image when present; falls back to
// Playwright's own download otherwise. SwiftShader flags keep WebGL (globe, Sam) working headless.
const pwDir = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers'
const chromiumDir = existsSync(pwDir) ? readdirSync(pwDir).find((d) => d.startsWith('chromium-')) : undefined
const executablePath = chromiumDir ? `${pwDir}/${chromiumDir}/chrome-linux/chrome` : undefined
const port = Number(process.env.E2E_PORT ?? 8089)
const baseURL = process.env.SITE_URL ?? `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
    },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], defaultBrowserType: 'chromium' }, testMatch: /home\.spec\.ts/ },
  ],
  webServer: process.env.SITE_URL
    ? undefined
    : {
        command: `node dist/server/index.js`,
        url: `${baseURL}/healthz`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
        env: { PORT: String(port), DB_PATH: '.e2e/waitlist.sqlite', NODE_ENV: 'production' },
      },
})
