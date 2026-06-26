import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL: 'http://localhost:5173' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Enable Resynthesis so the form a11y test runs (it skips itself if the flag is off).
    command: 'VITE_RESYNTH_ENABLED=true pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
  },
})
