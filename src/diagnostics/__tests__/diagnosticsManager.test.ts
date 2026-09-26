import * as FS from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultSettings, type DiagnosticsSettings } from "../../shared/contracts";
import { DiagnosticsManager, type DiagnosticsManagerOptions } from "../diagnosticsManager";
import { formatSessionPrefix } from "../diagnosticsSession";
import { fakeInspector, heapReading, tempDir, TEST_VERSIONS } from "./diagnosticsTestKit";

const cleanups: Array<() => Promise<void>> = [];
const managers: DiagnosticsManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop("test-cleanup")));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const off = (): DiagnosticsSettings => defaultSettings().diagnostics;

async function makeManager(settings: DiagnosticsSettings, overrides: Partial<DiagnosticsManagerOptions> = {}) {
  const dir = await tempDir();
  cleanups.push(dir.cleanup);
  const inspectors: Array<ReturnType<typeof fakeInspector>> = [];
  const heap = { usedMb: 300 };
  const log = vi.fn();
  const manager = new DiagnosticsManager({
    userDataPath: dir.path,
    settings,
    versions: TEST_VERSIONS,
    env: {},
    log,
    createInspector: () => {
      const created = fakeInspector();
      inspectors.push(created);
      return created.inspector;
    },
    readCpu: () => ({ threadMicros: 0, processMicros: 0 }),
    readHeap: (at) => heapReading(heap.usedMb, at),
    readWorkerHeaps: async () => [],
    liveWorkerCount: () => 0,
    writeHeapSnapshot: (filePath) => {
      writeFileSync(filePath, "{}");
      return filePath;
    },
    ...overrides,
  });
  managers.push(manager);
  return { manager, userData: dir.path, root: Path.join(dir.path, "diagnostics"), inspectors, heap, log };
}

async function seedSession(root: string, name: string, files: Record<string, string>): Promise<void> {
  await FS.mkdir(Path.join(root, name), { recursive: true });
  for (const [file, text] of Object.entries(files)) await FS.writeFile(Path.join(root, name, file), text);
}

describe("DiagnosticsManager", () => {
  it("starts with everything off, creates nothing, and sweeps empty sessions from earlier launches", async () => {
    const { manager, root, inspectors } = await makeManager(off());
    const stale = `hot-cpu-${formatSessionPrefix(new Date(Date.now() - 60_000))}-0a0a0a`;
    await seedSession(root, stale, { "session.json": "{}", "events.ndjson": "" });
    manager.start();
    const status = await manager.status();
    expect(status.hotCpu).toMatchObject({ enabled: false, state: "off" });
    expect(status.heap).toMatchObject({ enabled: false, state: "off" });
    expect(status.sessions).toEqual([]);
    expect(await FS.readdir(root)).toEqual([]);
    // Only the heap monitor's inspector exists, and it's never attached while off.
    expect(inspectors).toHaveLength(1);
    expect(inspectors[0].inspector.attach).not.toHaveBeenCalled();
  });

  it("starts the profiler from Settings and restarts it when its settings change", async () => {
    const { manager, inspectors } = await makeManager(off());
    manager.start();
    manager.applySettings({ ...off(), hotCpuProfiling: true });
    await vi.waitUntil(async () => (await manager.status()).hotCpu.state === "recording");
    expect(inspectors).toHaveLength(2);
    expect(inspectors[1].calls("Profiler.start")).toBe(1);

    // An unrelated settings save changes nothing.
    manager.applySettings({ ...off(), hotCpuProfiling: true });
    expect(inspectors).toHaveLength(2);

    manager.applySettings({ ...off(), hotCpuProfiling: true, hotCpuThresholdPercent: 80 });
    await vi.waitUntil(async () => inspectors.length === 3 && (await manager.status()).hotCpu.state === "recording");
    expect(inspectors[1].inspector.isAttached()).toBe(false);
    expect((await manager.status()).hotCpu.thresholdPercent).toBe(80);

    manager.applySettings(off());
    await vi.waitUntil(() => !inspectors[2].inspector.isAttached());
    expect((await manager.status()).hotCpu.state).toBe("off");
  });

  it("keeps the per-launch profile cap when Settings restart the profiler", async () => {
    let micros = 0;
    const { manager, root, log } = await makeManager(off(), {
      env: {
        DISKHOUND_HOT_CPU_PROFILING_START_DELAY_MS: "0",
        DISKHOUND_HOT_CPU_PROFILING_INTERVAL_MS: "5",
        DISKHOUND_HOT_CPU_PROFILING_CONSECUTIVE_SAMPLES: "1",
        DISKHOUND_HOT_CPU_PROFILING_DURATION_MS: "5",
        DISKHOUND_HOT_CPU_PROFILING_MAX_PROFILES: "1",
      },
      // Every sample is hot.
      readCpu: () => ({ threadMicros: (micros += 1e9), processMicros: micros }),
    });
    manager.start();
    manager.applySettings({ ...off(), hotCpuProfiling: true });
    await vi.waitUntil(async () => (await manager.status()).hotCpu.state === "capped", { timeout: 5_000 });
    expect((await manager.status()).hotCpu.profilesWritten).toBe(1);

    manager.applySettings({ ...off(), hotCpuProfiling: true, hotCpuThresholdPercent: 90 });
    await vi.waitUntil(async () => (await manager.status()).hotCpu.thresholdPercent === 90);
    const status = await manager.status();
    expect(status.hotCpu).toMatchObject({ state: "capped", profilesWritten: 1 });
    const [session] = status.sessions;
    expect(session.artifacts.map((artifact) => artifact.filename)).toEqual(["main-hot-0001.cpuprofile"]);
    expect(session.path.startsWith(root)).toBe(true);
    // "capped" counts the commit; the saved line follows it.
    await vi.waitUntil(() => log.mock.calls.some(([tag, message]) =>
      tag === "hot-cpu" && /^saved .*main-hot-0001\.cpuprofile \(\d+ KB\): /.test(String(message))), { timeout: 5_000 });
  });

  it("only reveals the diagnostics folder or a session in it", async () => {
    const { manager, root } = await makeManager(off());
    expect(manager.resolveRevealPath()).toBe(root);
    expect(manager.resolveRevealPath("hot-cpu-2026-09-25-1412-a1b2c3")).toBe(Path.join(root, "hot-cpu-2026-09-25-1412-a1b2c3"));
    for (const hostile of ["..", "../../etc", "/etc/passwd", "hot-cpu-2026-09-25-1412-a1b2c3/../../x", "heap-gate-state.json", 42, {}]) {
      expect(manager.resolveRevealPath(hostile)).toBeNull();
    }
  });

  it("lists captures in the handoff text with their paths and summaries", async () => {
    const { manager, root } = await makeManager(off());
    const cpu = "hot-cpu-2026-09-25-1412-a1b2c3";
    const heapName = "heap-2026-09-25-1520-d4e5f6";
    await seedSession(root, cpu, {
      "main-hot-0001.cpuprofile": "x".repeat(2048),
      "session.json": JSON.stringify({ artifacts: [{ filename: "main-hot-0001.cpuprofile", summary: "74 s, 60 s before a 97% main-thread trigger" }] }),
    });
    await seedSession(root, heapName, { "main-gate-0001.heapprofile": "y".repeat(4096), "main-gate-0001-a.heapsnapshot": "{}" });
    manager.start();
    const status = await manager.status();
    expect(status.sessions.map((session) => session.name)).toEqual([heapName, cpu]);
    expect(status.handoffText).toBe([
      "DiskHound 0.6.2 diagnostics (Electron 40.6.0, Node 24.13.1, darwin arm64)",
      `Folder: ${root}`,
      "",
      `${heapName} (4 KB)`,
      `  ${Path.join(root, heapName, "main-gate-0001-a.heapsnapshot")} (1 KB)`,
      `  ${Path.join(root, heapName, "main-gate-0001.heapprofile")} (4 KB)`,
      `${cpu} (2 KB)`,
      `  ${Path.join(root, cpu, "main-hot-0001.cpuprofile")} (2 KB) - 74 s, 60 s before a 97% main-thread trigger`,
      "",
      "Open .cpuprofile in Chrome DevTools (Performance > Load profile) or https://www.speedscope.app.",
      "Open .heapsnapshot and .heapprofile in Chrome DevTools (Memory > Load). For a gate pair, select B and compare it against A.",
    ].join("\n"));
  });

  it("takes a manual snapshot, deletes everything on request, and starts a fresh folder after", async () => {
    const { manager, root, log } = await makeManager(off());
    manager.start();
    const first = await manager.captureHeapSnapshot();
    expect(first.ok).toBe(true);
    expect(existsSync(first.path!)).toBe(true);
    expect((await manager.status()).sessions).toHaveLength(1);

    const cleared = await manager.clear();
    expect(cleared.removed).toBe(1);
    expect((await manager.status()).sessions).toEqual([]);
    expect(log).toHaveBeenCalledWith("diagnostics", expect.stringMatching(/^deleted 1 session\(s\)/));

    const second = await manager.captureHeapSnapshot();
    expect(second.ok).toBe(true);
    expect(Path.basename(second.path!)).toBe("main-manual-0002.heapsnapshot");
    expect(await FS.readdir(Path.dirname(second.path!))).toEqual(expect.arrayContaining(["main-manual-0002.heapsnapshot", "session.json"]));
    expect(Path.dirname(Path.dirname(second.path!))).toBe(root);
  });

  it("lists a capture as soon as it is committed, even one that doesn't call back", async () => {
    const MB = 1024 * 1024;
    // The gate at its 3 GB maximum stays out of this: its capture calls back.
    const { manager, heap } = await makeManager({ ...off(), heapDiagnostics: true, heapGateMb: 3072 }, {
      env: { DISKHOUND_HEAP_INTERVAL_MS: "20" },
      readWorkerHeaps: async () => [{ label: "folder-tree", threadId: 2, usedBytes: 1600 * MB, limitBytes: 4096 * MB }],
      liveWorkerCount: () => 1,
    });
    manager.start();
    expect((await manager.status()).sessions).toEqual([]);
    // Main 2,000 MB + the 1,600 MB worker is 88% of the cage: the
    // near-limit dump, which is written synchronously with no callback.
    heap.usedMb = 2000;
    await vi.waitUntil(
      async () => (await manager.status()).sessions.some((session) =>
        session.artifacts.some((artifact) => artifact.filename === "main-near-limit-0001.heapprofile")),
      { timeout: 5_000 },
    );
  });

  it("reports env overrides in the status and the handoff", async () => {
    const { manager } = await makeManager(off(), { env: { DISKHOUND_HEAP_GATE_MB: "256" } });
    manager.start();
    const status = await manager.status();
    expect(status.envOverrides).toEqual(["DISKHOUND_HEAP_GATE_MB=256"]);
    expect(status.heap).toMatchObject({ enabled: true, gateBytes: 256 * 1024 * 1024 });
    expect(status.handoffText).toContain("Env: DISKHOUND_HEAP_GATE_MB=256");
  });
});
