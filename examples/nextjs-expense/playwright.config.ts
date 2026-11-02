import { defineConfig, devices } from "@playwright/test";

const port = 3100;

/**
 * Runs against a production build: `pnpm build` first. Without DEMO_PUBLIC=1 this is the local
 * demo; with it, the online demo, and `public.e2e.ts` runs too.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec next start -p ${port}`,
    url: `http://localhost:${port}/login`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
