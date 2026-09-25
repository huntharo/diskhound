import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FolderTreeSidecarQueryInput, FolderTreeSidecarQueryResult } from "../folderTreeSidecarQuery";
import { runFolderTreeQueryWorker } from "../folderTreeWorkerRuntime";

// runFolderTreeQueryWorker is driven against a real worker thread that
// runs a tiny script speaking the folder-tree protocol. The runner
// terminates the worker after it replies, and a terminated worker exits
// with code 1. These tests pin that a reply still wins over that exit.

let workerDir: string;
let workerCount = 0;

beforeAll(async () => {
  workerDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-tree-query-worker-"));
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

const input: FolderTreeSidecarQueryInput = {
  sidecarPath: "/unused.folder-tree.ndjson.gz",
  targetKey: "/scan/src",
  anchorKey: "/scan",
  separator: "/",
  maxDepth: 4,
  maxBytes: 1024,
};

const result: FolderTreeSidecarQueryResult = {
  anchorKey: "/scan",
  entries: [["/scan/src", { dirs: [], files: [{ name: "a.ts", size: 10, modifiedAt: 1 }] }]],
  coveredDepth: 4,
  linesScanned: 12,
  bytesKept: 80,
};

describe("runFolderTreeQueryWorker", () => {
  it("resolves with the worker's result and passes the query through", async () => {
    const workerPath = await fakeWorker(
      `if (request.type !== "query" || request.input.anchorKey !== "/scan") throw new Error("bad request");
       parentPort.postMessage({ type: "query-result", requestId: request.requestId, result: ${JSON.stringify(result)} });`,
    );
    await expect(runFolderTreeQueryWorker(input, { workerPath })).resolves.toEqual(result);
  });

  it("keeps a result the worker sends right before it exits with code 1", async () => {
    const workerPath = await fakeWorker(
      `parentPort.postMessage({ type: "query-result", requestId: request.requestId, result: ${JSON.stringify(result)} });
       setImmediate(() => process.exit(1));`,
    );
    await expect(runFolderTreeQueryWorker(input, { workerPath })).resolves.toEqual(result);
  });

  it("rejects with the worker's error message", async () => {
    const workerPath = await fakeWorker(
      `parentPort.postMessage({ type: "error", requestId: request.requestId, message: "ENOENT: sidecar gone" });`,
    );
    await expect(runFolderTreeQueryWorker(input, { workerPath })).rejects.toThrow("ENOENT: sidecar gone");
  });

  it("rejects when the worker throws or exits without replying", async () => {
    const throws = await fakeWorker(`throw new Error("boom");`);
    await expect(runFolderTreeQueryWorker(input, { workerPath: throws })).rejects.toThrow("boom");
    const exits = await fakeWorker(`process.exit(3);`);
    await expect(runFolderTreeQueryWorker(input, { workerPath: exits })).rejects.toThrow("code 3");
  });

  it("rejects on abort", async () => {
    const workerPath = await fakeWorker(`/* never replies */`);
    const controller = new AbortController();
    const pending = runFolderTreeQueryWorker(input, { workerPath, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
  });
});
