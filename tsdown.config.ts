import { defineConfig } from "tsdown";

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: true,
  outExtensions: () => ({ js: ".cjs" }),
  // blake2 is a native addon (vrza/node-blake2) — keep it external so
  // the bundler doesn't try to inline the require, and so the runtime
  // resolves it from node_modules/blake2/ at load time (which is
  // app.asar.unpacked/node_modules/blake2/ once electron-builder runs).
  external: ["electron", "electron-updater", "blake2"],
};

// Rolldown only allows this on a single entry. Shared chunks from a
// multi-entry worker build land in dist-electron/ (chunk-*.cjs) while
// electron-builder unpacks dist-electron/scan/**. The unpacked worker
// then require('../chunk-….cjs') from app.asar.unpacked and crashes.
const noCodeSplitting = {
  outputOptions: {
    codeSplitting: false,
  },
};

const scanWorkers = [
  "scanWorker",
  "fullDiffWorker",
  "folderTreeWorker",
  "devArtifactsWorker",
  "permanentDeleteWorker",
] as const;

export default defineConfig([
  {
    ...shared,
    ...noCodeSplitting,
    entry: ["src/main.ts"],
    clean: true,
  },
  {
    ...shared,
    entry: ["src/preload.ts"],
  },
  {
    // Local-agent (MCP) runtime. Separate so main.cjs doesn't require
    // the MCP SDK and Express at startup; electronHost.ts loads it by
    // path the first time AI Agents is turned on.
    ...shared,
    ...noCodeSplitting,
    entry: {
      "mcp/agentRuntime": "src/mcp/agentRuntime.ts",
    },
  },
  ...scanWorkers.map((name) => ({
    ...shared,
    ...noCodeSplitting,
    // Named output keeps files at dist-electron/scan/*.cjs. A bare
    // `src/scan/*.ts` entry would flatten to dist-electron/*.cjs, which
    // asarUnpack and resolveBundledWorkerScript would miss.
    entry: {
      [`scan/${name}`]: `src/scan/${name}.ts`,
    },
  })),
]);
