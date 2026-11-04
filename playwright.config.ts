import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests against the production build of the capture PWA
 * (`vite preview`, with the real security headers). Synthetic documents only.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  expect: { timeout: 90_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    // PDE_E2E_BASE_URL runs the suite against another server (e.g. Caddy on a VPS).
    baseURL: process.env.PDE_E2E_BASE_URL ?? "http://localhost:4173/",
    trace: "retain-on-failure",
    launchOptions: process.env.PDE_CHROMIUM ? { executablePath: process.env.PDE_CHROMIUM } : {},
  },
  webServer: process.env.PDE_E2E_BASE_URL
    ? undefined
    : {
        command: "pnpm --filter @pde/capture-pwa run preview",
        url: "http://localhost:4173/",
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
