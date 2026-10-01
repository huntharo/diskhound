import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    env: { DISKHOUND_DISABLE_UPDATES: "1" },
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // Windows runner stalls delayed unrelated tests together in CI run 36201370158.
    testTimeout: process.platform === "win32" ? 20_000 : undefined,
  },
});
