// @vitest-environment happy-dom
import "node:fs/promises";
import * as FS from "node:fs";
import * as Path from "node:path";

import { Fragment, h } from "preact";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { McpPolicyStore } from "../mcp/accessPolicy";
import { RemovalQueue } from "../mcp/removalQueue";
import { AgentButton } from "../renderer/components/AgentButton";
import { RemovalReviewSheet } from "../renderer/components/RemovalReviewSheet";
import { useRemovalReviewOpen } from "../renderer/lib/agentAccessStore";
import { formatBytes } from "../renderer/lib/format";
import { nativeApi } from "../renderer/nativeApi";
import { MCP_AGENT_CAPABILITIES } from "../shared/agentAccess";
import { trashName, type RemovalVolumeCheck } from "../shared/agentRemovals";
import { expectIoBudget, measureFsIo } from "../test/ioBudget";
import { bootMainProcess, type MainProcess } from "../test/mainProcessHarness";
import { hostRoot, seedProfile } from "../test/mainProfileFixture";
import { bootRenderer, button, click, one, type Renderer, withText } from "../test/rendererHarness";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFsPromises(await importOriginal()));
vi.mock("node:child_process", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentChildProcess(await importOriginal()));
vi.mock("node:worker_threads", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentWorkerThreads(await importOriginal()));
vi.mock("electron", async () =>
  (await import("../test/mainProcessHarness")).fakeElectron());
vi.mock("../shared/crashLog", async (importOriginal) =>
  (await import("../test/mainProcessHarness")).settledCrashLog(await importOriginal()));
// The volume check reads the mount table (mount, /proc/self/mountinfo or
// PowerShell) and stats each item, differently on each platform. Its own
// tests and the E2E suite cover it; here it answers from a fixed table so
// the counts are the same everywhere. A path under no-trash/ is on a
// volume without a Trash.
vi.mock("../mcp/trashSupport", async (importOriginal) => {
  const original = await importOriginal<typeof import("../mcp/trashSupport")>();
  class FixedProbe {
    invalidate(): void {}
    async mountedAt(): Promise<string | null> {
      return null;
    }
    async check(items: readonly { path: string }[]): Promise<RemovalVolumeCheck[]> {
      return items.map((item) => item.path.includes("no-trash")
        ? { volume: "scratch", trash: "no", trashWhy: "scratch has no Trash.", readOnly: false, mountsInside: [], checkedAt: 0 }
        : { volume: "the startup disk", trash: "yes", readOnly: false, mountsInside: [], checkedAt: 0 });
    }
  }
  return { ...original, TrashProbe: FixedProbe };
});
const runtime = vi.hoisted(() => ({ module: null as unknown }));
vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>();
  const createRequire = (from: string | URL) => {
    const real = original.createRequire(from);
    return Object.assign(
      (id: string) => (id.replaceAll("\\", "/").endsWith("/mcp/agentRuntime.cjs") ? runtime.module : real(id)),
      real,
    ) as NodeJS.Require;
  };
  return { ...original, createRequire, default: { ...original, createRequire } };
});

// The review list comes with the agent snapshot, so reading it, ticking,
// unticking and switching an item's action are local: no IPC and no
// reads. Approving is one IPC, and main writes agent-removals.json once
// however many items it decides.

vi.setConfig({ testTimeout: 30_000 });

const ROOT = hostRoot("/Volumes/Data");
const BIN = trashName(process.platform);
const BIN_BUTTON = process.platform === "win32" ? "Recycle" : "Trash";
const ALL = [...MCP_AGENT_CAPABILITIES];

let main: MainProcess;
let ui: Renderer;
let files: string;
let trash: string;

const OK: RemovalVolumeCheck = { volume: "the startup disk", trash: "yes", readOnly: false, mountsInside: [], checkedAt: 0 };
const NO_TRASH: RemovalVolumeCheck = { volume: "scratch", trash: "no", trashWhy: "scratch has no Trash.", readOnly: false, mountsInside: [], checkedAt: 0 };

beforeAll(async () => {
  runtime.module = await import("../mcp/agentRuntime");
  process.env.DISKHOUND_AGENT_PORT = "0";
  main = await bootMainProcess({
    seed: async (userData) => {
      await seedProfile(userData, { roots: [{ rootPath: ROOT, scans: 1 }] });
      const settingsFile = Path.join(userData, "settings.json");
      const settings = JSON.parse(FS.readFileSync(settingsFile, "utf8"));
      // macOS's temp folder is under /private, which the default exclusions protect.
      FS.writeFileSync(settingsFile, JSON.stringify({
        ...settings,
        agents: { enabled: true },
        scanning: { ...settings.scanning, excludedFolderPaths: [] },
      }, null, 2));

      // What the agents asked for, on disk. Canonical paths: approval
      // refuses a path that resolves somewhere else than it did. The
      // native realpath expands Windows 8.3 names (RUNNER~1), as the app's does.
      files = Path.join(FS.realpathSync.native(Path.dirname(userData)), "projects");
      trash = Path.join(Path.dirname(userData), "Trash");
      FS.mkdirSync(trash, { recursive: true });
      for (const dir of ["old-app/node_modules/left-pad", "old-app/dist", "logs", "no-trash", "stale-checkout"]) {
        FS.mkdirSync(Path.join(files, dir), { recursive: true });
      }
      FS.writeFileSync(Path.join(files, "old-app/node_modules/left-pad/index.js"), "module.exports = () => {};\n");
      FS.writeFileSync(Path.join(files, "old-app/dist/app.js"), "x".repeat(4096));
      FS.writeFileSync(Path.join(files, "cache.bin"), Buffer.alloc(16_384));
      FS.writeFileSync(Path.join(files, "logs/huge.log"), "line\n".repeat(2048));
      FS.writeFileSync(Path.join(files, "no-trash/build.tar"), Buffer.alloc(8192));

      const policy = new McpPolicyStore(Path.join(userData, "mcp-policy.json"));
      const codex = policy.createSession("Codex", "builtin.operator", { clientId: "client_codex", scopes: ALL }, { name: "Codex", via: "http" });
      const claude = policy.createSession("Claude Code — cleanup", "builtin.admin", { clientId: "client_cc", scopes: ALL },
        { name: "Claude Code", via: "stdio" });
      const old = policy.createSession("Old agent", "builtin.operator", { clientId: "client_old", scopes: ALL });
      policy.revokeSession(old.session.id);

      const queue = new RemovalQueue(Path.join(userData, "agent-removals.json"));
      const at = (path: string, sizeBytes: number) => ({ path: Path.join(files, path), sizeBytes, check: path.startsWith("no-trash") ? NO_TRASH : OK });
      queue.add({
        sessionId: codex.session.id, sessionName: "Codex", roleName: "Cleanup Operator", asked: "trash",
        reason: "Build output from old-app, untouched since March.",
        items: [at("old-app/node_modules", 412_000_000), at("old-app/dist", 38_000_000), at("cache.bin", 2_100_000_000)],
      });
      queue.add({
        sessionId: claude.session.id, sessionName: "Claude Code — cleanup", roleName: "Cleanup Admin", asked: "delete",
        reason: "Logs and a build archive you can regenerate.",
        items: [at("logs/huge.log", 9_800_000_000), at("no-trash/build.tar", 1_200_000_000)],
      });
      queue.add({
        sessionId: old.session.id, sessionName: "Old agent", roleName: "Cleanup Operator", asked: "trash", reason: null,
        items: [at("stale-checkout", 450_000_000)],
      });
      await queue.flush();
    },
  });
  ui = await bootRenderer();
  // The real Trash is native code DiskHound doesn't count; this one
  // moves the item aside with the uncounted fs, so only DiskHound's own
  // reads and writes are budgeted.
  const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const { shell } = await import("electron");
  shell.trashItem = async (target: string) => {
    realFs.renameSync(target, Path.join(trash, Path.basename(target)));
  };
}, 60_000);

function ReviewHost() {
  return useRemovalReviewOpen() ? h(RemovalReviewSheet, null) : null;
}

function mountReviewUi(): HTMLElement {
  return ui.mount(h(Fragment, null, h(AgentButton, { onOpenSettings: () => {} }), h(ReviewHost, null)));
}

const row = (view: HTMLElement, name: string) => withText(view, ".rv-row", name);
const tick = async (view: HTMLElement, name: string) => click(one(row(view, name), ".rv-check"));

describe("Agent review list", () => {
  it("opens from the header, ticks, unticks and switches actions without asking main", async () => {
    const view = mountReviewUi();
    await ui.settle();
    expect(ui.takeIpc()).toEqual(["diskhound:agent-access-get"]);
    // The popover's clock asks main once whether the window is shown.
    await click(one(view, ".agent-pill.review"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await ui.settle();
    ui.takeIpc();

    const seen: Record<string, unknown> = {};
    const { io } = await measureFsIo(async () => {
      seen.pill = one(view, ".agent-pill.review").textContent;
      for (let i = 0; i < 3; i++) {
        await click(one(view, ".agent-pill.review"));
        await click(button(view, "Review…"));
        seen.groups = [...view.querySelectorAll(".rv-group-name")].map((name) => name.textContent);
        seen.primary = view.querySelector(".scan-btn-primary")?.textContent;
        seen.oldAgent = row(view, "stale-checkout").querySelector(".rv-check")?.hasAttribute("disabled");
        seen.noTrash = row(view, "build.tar").querySelector(".rv-action")?.textContent;
        await tick(view, "dist");
        await click(withText(row(view, "huge.log"), ".rv-segb", BIN_BUTTON));
        seen.afterSwitch = one(view, ".scan-btn-primary").textContent;
        seen.switchedNote = row(view, "huge.log").querySelector(".rv-meta")?.textContent;
        await click(withText(row(view, "huge.log"), ".rv-segb", "Delete"));
        await tick(view, "dist");
        await click(button(view, "Later"));
        seen.closed = view.querySelector(".rv-sheet") === null;
      }
      await ui.settle();
    }, { countProcesses: true });

    // The revoked agent's item counts: it waits until the user clears it.
    expect(seen.pill).toBe("6to review");
    expect(seen.groups).toEqual(["Codex", "Claude Code — cleanup", "Old agent"]);
    expect(seen.primary).toBe(`Move 3 to ${BIN} · Delete 2`);
    expect(seen.oldAgent).toBe(true);
    // No Trash there, and the agent asked for a delete: delete is the only choice.
    expect(seen.noTrash).toBe("Delete");
    expect(seen.afterSwitch).toBe(`Move 3 to ${BIN} · Delete 1`);
    expect(seen.switchedNote).toContain(`You changed this to the ${BIN}.`);
    expect(seen.closed).toBe(true);
    expect(ui.takeIpc()).toEqual([]);
    expectIoBudget({
      scenario: "renderer-agent-removals-browse",
      note: "Header pill → popover → review sheet, three times, with 3 agents' requests (6 items): untick one, switch one "
        + "delete to the Trash and back, close. The list came with the agent snapshot, so 0 IPC, 0 reads and 0 processes, "
        + "and 0 writes/day at the default or the 1-minute monitoring interval.",
      io,
    });
    ui.unmount();
  });

  it("refuses a revoked agent's item at approval", async () => {
    const view = mountReviewUi();
    await ui.settle();
    const stale = JSON.parse(FS.readFileSync(Path.join(main.userData, "agent-removals.json"), "utf8")).requests
      .flatMap((request: any) => request.items).find((item: any) => item.path.endsWith("stale-checkout"));
    // The sheet never offers it; a stale renderer or a raced revoke could.
    const result = await nativeApi.approveAgentRemovals([{ itemId: stale.id, run: true, action: "trash" }]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await ui.settle();
    expect(result).toMatchObject({ refused: 1, moved: { items: 0 }, sessions: 0 });
    expect(FS.existsSync(Path.join(files, "stale-checkout"))).toBe(true);
    expect(one(view, ".agent-pill.review").textContent).toBe("5to review");
    ui.unmount();
  });

  it("approves with one IPC, runs what's ticked and writes the list once", async () => {
    const view = mountReviewUi();
    await ui.settle();
    await click(one(view, ".agent-pill.review"));
    await click(button(view, "Review…"));
    ui.takeIpc();

    const { io } = await measureFsIo(async () => {
      await tick(view, "dist");
      await click(withText(row(view, "huge.log"), ".rv-segb", BIN_BUTTON));
      await click(one(view, ".scan-btn-primary"));
      // Main pushes the decided list at most every 100 ms.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await ui.settle();
    });

    expect(ui.takeIpc()).toEqual(["diskhound:agent-removals-approve"]);
    expect(one(view, ".rv-done").textContent).toBe(`Removed 4 items for 2 agents. Deleted 1: ${formatBytes(1_200_000_000)} free now. `
      + `Moved 3 to the ${BIN}: ${formatBytes(12_312_000_000)} more once you empty it. 1 skipped.`);
    expect(row(view, "dist").querySelector(".rv-result")?.textContent).toBe("Skipped");
    expect(row(view, "huge.log").querySelector(".rv-result")?.textContent).toBe(`Moved to the ${BIN}`);
    expect(FS.readdirSync(trash).sort()).toEqual(["cache.bin", "huge.log", "node_modules"]);
    expect(FS.existsSync(Path.join(files, "no-trash/build.tar"))).toBe(false);
    expect(FS.existsSync(Path.join(files, "old-app/dist/app.js"))).toBe(true);
    const saved = JSON.parse(FS.readFileSync(Path.join(main.userData, "agent-removals.json"), "utf8"));
    const outcomes = Object.fromEntries(saved.requests.flatMap((request: any) =>
      request.items.map((item: any) => [Path.basename(item.path), [item.status, item.outcome?.message]])));
    expect(outcomes).toEqual({
      node_modules: ["moved", `Moved to the ${BIN}.`],
      dist: ["skipped", "You skipped it."],
      "cache.bin": ["moved", `Moved to the ${BIN}.`],
      "huge.log": ["moved", `Moved to the ${BIN} instead of deleted, as you chose.`],
      "build.tar": ["deleted", "Deleted permanently."],
      "stale-checkout": ["refused", "Old agent's session was revoked, so DiskHound didn't act on its request."],
    });
    expectIoBudget({
      scenario: "renderer-agent-removals-approve",
      note: "Approve 4 of 5 waiting items (3 to the Trash, one switched from delete; 1 file deleted; 1 skipped): one IPC; "
        + "one read of mcp-policy.json for the agents' current roles; per item an lstat to resolve it, an lstat before "
        + "and after the Trash, or the delete's own lstats and unlink; one atomic write of agent-removals.json and one "
        + "crash.log append. The folders agents may never remove resolve once per run, in the approval before this. "
        + "A user click, a few a day, so a few writes/day and well under 0.1 MB/day at the default or the 1-minute "
        + "monitoring interval.",
      io,
    });
    ui.unmount();
  });
});
