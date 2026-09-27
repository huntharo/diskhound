import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DevArtifactReport, FullDiffResult } from "../contracts";
import type { DevArtifactsRescanProgress } from "../devArtifactSidecar";
import {
  runDevArtifactsClassifyWorker,
  runDevArtifactsRescanWorker,
} from "../devArtifactsWorkerRuntime";
import type { SerializedFolderTree } from "../folderTreeWorkerProtocol";
import { runFolderTreeWorker } from "../folderTreeWorkerRuntime";
import { runFullDiffSortWorker, runFullDiffWorker } from "../fullDiffWorkerRuntime";

// Each runtime is driven against a real worker thread running a tiny
// script that speaks the runtime's protocol. The runtime terminates the
// worker after it replies, and a terminated worker exits with code 1
// before terminate() resolves. These tests pin that a reply still wins.

let workerDir: string;
let workerCount = 0;

beforeAll(async () => {
  workerDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-worker-runtimes-"));
});

afterAll(async () => {
  await FSP.rm(workerDir, { recursive: true, force: true });
});

async function fakeWorker(onRequest: string): Promise<string> {
  const workerPath = Path.join(workerDir, `worker-${workerCount++}.cjs`);
  await FSP.writeFile(
    workerPath,
    [
      `const { parentPort } = require("node:worker_threads");`,
      `parentPort.on("message", (request) => {`,
      onRequest,
      `});`,
    ].join("\n"),
  );
  return workerPath;
}

function reply(fields: Record<string, unknown>): string {
  return `parentPort.postMessage({ requestId: request.requestId, ...${JSON.stringify(fields)} });`;
}

const HEAP_LIMIT_KILL = [
  `const error = new Error("Worker terminated due to reaching memory limit: JS heap out of memory");`,
  `error.code = "ERR_WORKER_OUT_OF_MEMORY";`,
  `throw error;`,
].join("\n");

const tree: SerializedFolderTree = [
  ["/scan", {
    dirs: [{ path: "/scan/src", size: 300, fileCount: 2 }],
    files: [{ name: "disk.img", size: 500, modifiedAt: 1_700_000_000_000 }],
  }],
  ["/scan/src", {
    dirs: [],
    files: [
      { name: "a.bin", size: 200, modifiedAt: 1_700_000_000_000 },
      { name: "b.bin", size: 100, modifiedAt: 1_700_000_000_000 },
    ],
  }],
];

const diff: FullDiffResult = {
  baselineId: "baseline",
  currentId: "current",
  totalChanges: 0,
  totalAdded: 0,
  totalRemoved: 0,
  totalGrew: 0,
  totalShrank: 0,
  totalBytesAdded: 0,
  totalBytesRemoved: 0,
  changes: [],
  truncated: false,
};

const report: DevArtifactReport = {
  artifacts: [],
  totalBytes: 4096,
  totalFiles: 3,
  projectCount: 1,
  kindTotals: [],
  generatedAt: 1_700_000_000_000,
  rootPath: "/scan",
};

interface RuntimeCase {
  name: string;
  label: string;
  resultField: string;
  /** The success message's type, when it isn't "result". */
  resultType?: string;
  payload: unknown;
  run: (workerPath: string, signal?: AbortSignal) => Promise<unknown>;
}

const runtimes: RuntimeCase[] = [
  {
    name: "runFolderTreeWorker",
    label: "Folder tree worker",
    resultField: "tree",
    payload: tree,
    run: (workerPath, signal) =>
      runFolderTreeWorker({ indexPath: "/unused/index.ndjson.gz" }, { workerPath, signal }),
  },
  {
    name: "runFullDiffWorker",
    label: "Full diff worker",
    resultField: "result",
    payload: diff,
    run: (workerPath, signal) =>
      runFullDiffWorker(
        {
          baselineId: "baseline",
          currentId: "current",
          baselinePath: "/unused/baseline.ndjson.gz",
          currentPath: "/unused/current.ndjson.gz",
          limit: 10,
        },
        { workerPath, signal },
      ),
  },
  {
    name: "runFullDiffSortWorker",
    label: "Full diff worker",
    resultField: "sorted",
    resultType: "sorted",
    payload: { exists: true, runs: ["/tmp/diff/b/run-0.bin", "/tmp/diff/b/run-1.bin"] },
    run: (workerPath, signal) =>
      runFullDiffSortWorker(
        {
          indexPath: "/unused/baseline.ndjson.gz",
          caseSensitive: true,
          runDir: "/unused/runs",
          sortChunkRecords: 120_000,
        },
        { workerPath, signal },
      ),
  },
  {
    name: "runDevArtifactsClassifyWorker",
    label: "Dev artifacts worker",
    resultField: "report",
    payload: report,
    run: (workerPath, signal) =>
      runDevArtifactsClassifyWorker(
        {
          rootPath: "/scan",
          folderTreePath: "/unused/folder-tree.ndjson.gz",
          destSidecarPath: "/unused/dev-artifacts.json",
        },
        { workerPath, signal },
      ),
  },
  {
    name: "runDevArtifactsRescanWorker",
    label: "Dev artifacts worker",
    resultField: "report",
    payload: report,
    run: (workerPath, signal) =>
      runDevArtifactsRescanWorker(
        {
          rootPath: "/scan",
          sidecarPath: "/unused/dev-artifacts.json",
          indexPath: "/unused/index.ndjson.gz",
        },
        { workerPath, signal },
      ),
  },
];

describe.each(runtimes)("$name", (runtime) => {
  it("resolves with the worker's result", async () => {
    const workerPath = await fakeWorker(
      reply({ type: runtime.resultType ?? "result", [runtime.resultField]: runtime.payload }),
    );
    await expect(runtime.run(workerPath)).resolves.toEqual(runtime.payload);
  });

  it("rejects with the worker's error message", async () => {
    const workerPath = await fakeWorker(reply({ type: "error", message: "index is unreadable" }));
    await expect(runtime.run(workerPath)).rejects.toThrow("index is unreadable");
  });

  it("reports a heap-limit kill as out of memory", async () => {
    const workerPath = await fakeWorker(HEAP_LIMIT_KILL);
    await expect(runtime.run(workerPath)).rejects.toThrow(`${runtime.label} out of memory`);
  });

  it("reports a bare exit code 1 as an exit, not out of memory", async () => {
    const workerPath = await fakeWorker(`process.exit(1);`);
    await expect(runtime.run(workerPath)).rejects.toThrow(`${runtime.label} exited with code 1`);
  });

  it("rejects as aborted when the signal is already aborted", async () => {
    const workerPath = await fakeWorker(`// never replies`);
    await expect(runtime.run(workerPath, AbortSignal.abort())).rejects.toThrow(`${runtime.label} aborted`);
  });

  it("rejects as aborted when the signal fires mid-run", async () => {
    // Abort only once the worker is running. A worker terminated before
    // it starts exits with code 0, which would not exercise the race.
    const channelName = `diskhound-worker-running-${workerCount}`;
    const workerPath = await fakeWorker(
      `new BroadcastChannel(${JSON.stringify(channelName)}).postMessage("running");`,
    );
    const channel = new BroadcastChannel(channelName);
    const running = new Promise((resolve) => {
      channel.onmessage = resolve;
    });
    const controller = new AbortController();
    const pending = runtime.run(workerPath, controller.signal);
    await running;
    channel.close();
    controller.abort();
    await expect(pending).rejects.toThrow(`${runtime.label} aborted`);
  });
});

describe("runDevArtifactsRescanWorker progress", () => {
  it("forwards progress and still resolves with the report", async () => {
    const progress: DevArtifactsRescanProgress = {
      treesWalked: 1,
      treesTotal: 2,
      currentPath: "/scan/node_modules",
      filesSoFar: 10,
      bytesSoFar: 2048,
      elapsedMs: 5,
    };
    const workerPath = await fakeWorker([
      reply({ type: "progress", progress }),
      reply({ type: "result", report }),
    ].join("\n"));
    const seen: DevArtifactsRescanProgress[] = [];
    const result = await runDevArtifactsRescanWorker(
      {
        rootPath: "/scan",
        sidecarPath: "/unused/dev-artifacts.json",
        indexPath: "/unused/index.ndjson.gz",
      },
      { workerPath, onProgress: (next) => seen.push(next) },
    );
    expect(seen).toEqual([progress]);
    expect(result).toEqual(report);
  });
});

describe("Dev Artifacts worker heap", () => {
  it("runs under its own limit, well inside the 4 GB cage it shares with main", async () => {
    // The worker replies with the limits it was started under.
    const workerPath = await fakeWorker(
      `parentPort.postMessage({ requestId: request.requestId, type: "result", report: require("node:worker_threads").resourceLimits });`,
    );
    const devRuntimes = runtimes.filter((runtime) => runtime.label === "Dev artifacts worker");
    expect(devRuntimes).toHaveLength(2);
    for (const runtime of devRuntimes) {
      const limits = await runtime.run(workerPath) as { maxOldGenerationSizeMb: number; maxYoungGenerationSizeMb: number };
      expect(limits.maxOldGenerationSizeMb).toBe(1024);
      expect(limits.maxYoungGenerationSizeMb).toBe(64);
    }
  });
});
