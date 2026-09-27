import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixedMcpAuthorizer } from "../accessPolicy";
import { createDiskhoundMcpServer } from "../server";
import { loadSkillCatalog } from "../skills";
import { createFakeBackend, NOW, ROOT, SKILLS_DIR, roleAuthorization } from "./fakeBackend";

const skills = loadSkillCatalog(SKILLS_DIR);

/** Count array slots and record fields throughout backend results, including nested
 * lists. Set up outside measurement; count the actual MCP request, not fixture work. */
function counter() {
  let reads = 0;
  const cache = new WeakMap<object, object>();
  function wrap<T>(value: T): T {
    if (value === null || typeof value !== "object") return value;
    const cached = cache.get(value);
    if (cached) return cached as T;
    const proxy = new Proxy(value, {
      get(target, key, receiver) { reads++; return wrap(Reflect.get(target, key, receiver)); },
    });
    cache.set(value, proxy);
    return proxy;
  }
  return { wrap, reset: () => { reads = 0; }, reads: () => reads };
}

/** Scramble sort keys so an already sorted fixture cannot hide sort work. */
function rows<T extends object>(template: T, n: number): T[] {
  return Array.from({ length: n }, (_, i) => ({ ...template,
    ...("size" in template ? { size: (i * 31337) % n + 1 } : {}),
    ...("deltaBytes" in template ? { deltaBytes: (i * 31337) % n - n / 2 } : {}),
  }));
}

const cases = [
  "diskhound_status", "diskhound_scan_summary", "diskhound_list_folder", "diskhound_search_files",
  "diskhound_cleanup_suggestions", "diskhound_dev_artifacts", "diskhound_scan_history",
  "diskhound_changes", "diskhound_changes_files", "diskhound_duplicates",
] as const;

async function measure(name: typeof cases[number], factor: number) {
  const n = 128 * factor;
  // Limits grow eightfold along with files/folders, rather than masking N*limit.
  const limit = 8 * factor;
  const c = counter();
  const backend = createFakeBackend();
  const snapshot = (await backend.latestSnapshot(ROOT))!;
  const children = await backend.folderChildren(ROOT, ROOT);
  const history = backend.scanHistory(ROOT);
  const cleanup = await backend.cleanupSuggestions(ROOT);
  const dev = (await backend.devArtifacts(ROOT))!;
  const diff = (await backend.diff("scan-2", "scan-3"))!;
  const full = (await backend.fullDiff("scan-2", "scan-3", 200))!;
  backend.scannedRoots.mockReturnValue(c.wrap(rows(history[0]!, n)));
  backend.activeScans.mockResolvedValue(c.wrap(rows(snapshot, n)));
  backend.scanHistory.mockReturnValue(c.wrap(rows(history[0]!, n).map((entry, i) => ({ ...entry,
    id: `scan-${i}`, scannedAt: NOW - (i + 1) * 3600_000 }))));
  backend.latestSnapshot.mockResolvedValue(c.wrap({ ...snapshot,
    largestFiles: rows(snapshot.largestFiles[0]!, n), hottestDirectories: rows(snapshot.hottestDirectories[0]!, n),
    topExtensions: rows(snapshot.topExtensions[0]!, n) }));
  backend.folderChildren.mockResolvedValue(c.wrap({ ...children, visibleDirCount: n,
    dirs: rows(children.dirs[0]!, n), files: rows(children.files[0]!, n) }));
  backend.searchIndex.mockResolvedValue(c.wrap({ hits: rows(children.files[0]!, n), truncated: false, filesScanned: n }));
  // A fixed set of categories each holds a growing collection of paths; both
  // that collection and pathsPerSuggestion grow 8x (total input grows 8x).
  backend.cleanupSuggestions.mockResolvedValue(c.wrap({ ...cleanup,
    suggestions: Array.from({ length: 4 }, () => ({ ...cleanup.suggestions[0]!,
      paths: Array.from({ length: n }, (_, i) => `${ROOT}/file-${i}`) })) }));
  backend.devArtifacts.mockResolvedValue(c.wrap({ ...dev, artifacts: rows(dev.artifacts[0]!, n),
    kindTotals: rows(dev.kindTotals[0]!, n), projectCount: n }));
  backend.diff.mockResolvedValue(c.wrap({ ...diff, fileDeltas: rows(diff.fileDeltas[0]!, n),
    directoryDeltas: rows(diff.directoryDeltas[0]!, n), extensionDeltas: rows(diff.extensionDeltas[0]!, n) }));
  backend.fullDiff.mockResolvedValue(c.wrap({ ...full, changes: rows(full.changes[0]!, n) }));
  backend.duplicates.mockReturnValue(c.wrap({ running: false, progress: null, analysis: {
    rootPath: ROOT, analyzedAt: NOW, filesWalked: n * 16, filesHashed: n * 16, elapsedMs: 1,
    totalGroups: n, totalDuplicateFiles: n * 16, totalWastedBytes: n * 100,
    groups: Array.from({ length: n }, (_, i) => ({ hash: `hash-${i}`, size: i + 1,
      reclaimableBytes: (i * 31337) % n,
      files: Array.from({ length: 16 }, (_, j) => ({ path: `${ROOT}/${i}/${j}`, name: `${j}`, parentPath: `${ROOT}/${i}`,
        modifiedAt: NOW, reclaimableBytes: j, sharing: "clone" as const })) })),
  } }));
  const server = createDiskhoundMcpServer({ backend, skills, activity: { record: () => undefined }, authorizer: new FixedMcpAuthorizer(roleAuthorization("builtin.reader")), now: () => NOW });
  const client = new Client({ name: "scaling-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    c.reset();
    const result = await client.callTool({ name: name === "diskhound_changes_files" ? "diskhound_changes" : name,
      arguments: { path: ROOT, query: "file", limit, pathsPerSuggestion: 4 * factor,
        ...(name.startsWith("diskhound_changes") ? { baselineId: "scan-1", currentId: "scan-0", detail: name.endsWith("_files") ? "files" : "summary" } : {}) } });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toBeDefined();
    return c.reads();
  } finally { await client.close(); await server.close(); }
}

it.each(cases)("%s projections stay near linear as collections and limits grow 8x", async (name) => {
  const small = await measure(name, 1);
  const large = await measure(name, 8);
  if (process.env.MCP_SCALING_REPORT) console.log(`${name}: ${small} -> ${large} (${(large / small).toFixed(2)}x)`);
  expect(small).toBeGreaterThan(0);
  expect(large).toBeGreaterThan(small);
  expect(large).toBeLessThanOrEqual(small * 16);
  expect(large).toBeLessThanOrEqual(100_000);
});
