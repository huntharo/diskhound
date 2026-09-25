import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Each test starts a real Electron app, and a scan starts the native
  // scanner as well.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // One app at a time. Each window is a real desktop window, and two
  // running at once compete for focus.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  // A test that passes on retry is reported as flaky, not hidden.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
});
