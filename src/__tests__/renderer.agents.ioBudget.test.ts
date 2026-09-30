// @vitest-environment happy-dom
import "node:fs/promises";
import * as FS from "node:fs";
import * as HTTP from "node:http";
import * as NET from "node:net";
import * as Path from "node:path";

import { Fragment, h } from "preact";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { McpPolicyStore } from "../mcp/accessPolicy";
import { AgentButton } from "../renderer/components/AgentButton";
import { AgentsSection } from "../renderer/components/AgentsSection";
import { focusAgentSettings } from "../renderer/lib/agentAccessStore";
import { nativeApi } from "../renderer/nativeApi";
import { MCP_AGENT_CAPABILITIES } from "../shared/agentAccess";
import { expectIoBudget, measureFsIo } from "../test/ioBudget";
import { bootMainProcess, type MainProcess } from "../test/mainProcessHarness";
import { hostRoot, seedProfile } from "../test/mainProfileFixture";
import { bootRenderer, button, click, one, type Renderer, withText } from "../test/rendererHarness";
import { unzip } from "../test/zipReader";

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
// main requires the agent runtime as its own bundle (mcp/agentRuntime.cjs),
// which vitest doesn't build. Hand it the source module instead, loaded
// in beforeAll, so turning agents on starts the real listener.
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

// The header agent button and Settings → AI Agents share one snapshot
// that main pushes changes into. Opening the popover, switching client
// tabs and following links between them should never ask main for
// anything, and an agent's blocked request should reach the UI as a
// push, costing one append to the security log.

vi.setConfig({ testTimeout: 30_000 });

const ROOT = hostRoot("/Volumes/Data");
const ALL = [...MCP_AGENT_CAPABILITIES];

let main: MainProcess;
let ui: Renderer;
let port: number;
let guideToken: string;
// Claude Desktop isn't made for Linux, so DiskHound doesn't offer it there.
const hasClaudeDesktop = process.platform !== "linux";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NET.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port: free } = server.address() as NET.AddressInfo;
      server.close(() => resolve(free));
    });
  });
}

/** One JSON-RPC POST to /mcp, as Codex sends it. node:http so Host is exact. */
function mcpPost(token: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = HTTP.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/mcp",
      agent: false,
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "content-length": Buffer.byteLength(payload),
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(text) }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

beforeAll(async () => {
  runtime.module = await import("../mcp/agentRuntime");
  port = await freePort();
  process.env.DISKHOUND_AGENT_PORT = String(port);
  main = await bootMainProcess({
    seed: async (userData) => {
      await seedProfile(userData, { roots: [{ rootPath: ROOT, scans: 1 }] });
      // A stand-in for the stdio helper, which a checkout under test may not
      // have built: a release build's 1.4 MB (one architecture), half noise
      // so it deflates to about the real one's 0.7 MB.
      const helper = Path.join(Path.dirname(userData), "helper", "diskhound-mcp");
      const noise = Buffer.alloc(700_000);
      for (let i = 0, x = 2_463_534_242; i < noise.length; i++) {
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5; // xorshift32
        noise[i] = x & 0xff;
      }
      FS.mkdirSync(Path.dirname(helper), { recursive: true });
      FS.writeFileSync(helper, Buffer.concat([noise, Buffer.alloc(700_000)]));
      process.env.DISKHOUND_MCP_PATH = helper;
      const settingsFile = Path.join(userData, "settings.json");
      const settings = JSON.parse(FS.readFileSync(settingsFile, "utf8"));
      FS.writeFileSync(settingsFile, JSON.stringify({ ...settings, agents: { enabled: true } }, null, 2));

      // A profile that has used agents for a while: three live sessions,
      // a revoked one, and refusals from earlier runs.
      const policy = new McpPolicyStore(Path.join(userData, "mcp-policy.json"));
      guideToken = policy.createSession("Claude Code — diskhound", "builtin.guide", { clientId: "client_cc", scopes: ALL },
        { name: "Claude Code", via: "stdio" }).token;
      policy.createSession("Codex", "builtin.operator", { clientId: "client_codex", scopes: ALL }, { name: "Codex", via: "http" });
      policy.createSession("Claude Desktop", "builtin.reader", { clientId: "client_cd", scopes: ["disk.read", "scan.run", "app.navigate"] },
        { name: "Claude Desktop", via: "stdio" });
      const old = policy.createSession("Old agent", "builtin.guide", { clientId: "client_old", scopes: ALL });
      policy.revokeSession(old.session.id);
      const at = Date.now() - 3 * 24 * 60 * 60_000;
      const lines = Array.from({ length: 40 }, (_, i) => JSON.stringify({
        id: `security-old-${i}`,
        at: at + i * 60_000,
        sessionId: old.session.id,
        sessionName: "Old agent",
        roleName: "Cleanup Guide",
        kind: "tool_not_allowed",
        tool: "diskhound_move_to_trash",
        detail: `Tried to move items to the Trash; Cleanup Guide doesn't allow it. (${i})`,
        count: 1,
      }));
      FS.writeFileSync(Path.join(userData, "agent-security.log"), `${lines.join("\n")}\n`, { mode: 0o600 });
    },
  });
  ui = await bootRenderer();
}, 60_000);

function mountAgentUi(): HTMLElement {
  return ui.mount(h(Fragment, null,
    h(AgentButton, { onOpenSettings: (target) => focusAgentSettings(target) }),
    h(AgentsSection, null),
  ));
}

describe("AI Agents UI", () => {
  it("loads the snapshot once, then opens the popover, switches client tabs and follows links from memory", async () => {
    const view = mountAgentUi();
    await ui.settle();
    // One load shared by the header button and Settings.
    expect(ui.takeIpc()).toEqual(["diskhound:agent-access-get"]);
    expect(view.querySelectorAll(".agent-session-row")).toHaveLength(3);
    // Connected agents fold the connect guide.
    expect(view.querySelector(".agent-connect")).toBeNull();
    // The popover's clock is the renderer's first visible poll here, and
    // the first poll asks main once whether the window is shown. In the
    // app, the header's disk polls did that at launch.
    await click(one(view, ".agent-btn"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await ui.settle();
    expect(ui.takeIpc()).toEqual(["diskhound:is-window-shown"]);

    const seen: Record<string, unknown> = {};
    const { io } = await measureFsIo(async () => {
      for (let i = 0; i < 3; i++) {
        await click(one(view, ".agent-btn"));
        seen.popoverRows = view.querySelectorAll(".agent-pop-row").length;
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        await ui.settle();
      }
      seen.popoverClosed = view.querySelector(".agent-pop") === null;
      await click(one(view, ".agent-btn"));
      await click(button(view, "Connect an agent…"));
      seen.connectOpen = view.querySelector(".agent-connect") !== null;
      const tabs = hasClaudeDesktop
        ? ["Claude Desktop", "Codex", "Other MCP clients", "Claude Desktop", "Claude Code"]
        : ["Codex", "Other MCP clients", "Claude Code"];
      for (const tab of tabs) {
        await click(withText(view, ".agent-client-tabs button", tab));
        seen[`tab:${tab}`] = view.querySelector(".agent-prompt-text")?.textContent ?? null;
        seen[`add:${tab}`] = view.querySelector(".agent-step-action button")?.textContent ?? null;
      }
      seen.tabs = [...view.querySelectorAll(".agent-client-tabs button")].map((tab) => tab.textContent);
      await click(button(view, "Show command"));
      seen.command = view.querySelectorAll(".agent-command-text").length;
      await click(button(view, "Hide command"));
      await ui.settle();
    }, { countProcesses: true });

    expect(seen.popoverRows).toBe(3);
    expect(seen.popoverClosed).toBe(true);
    expect(seen.connectOpen).toBe(true);
    // Each tab hands the user a prompt for the agent to set itself up;
    // DiskHound never writes another app's configuration.
    expect(seen["tab:Codex"]).toContain("Add diskhound to my Codex user configuration");
    expect(seen["tab:Claude Code"]).toContain("Add diskhound to my Claude Code user configuration");
    expect(seen.command).toBe(2);
    if (hasClaudeDesktop) {
      // Claude's chat can't run commands: Claude installs DiskHound's extension itself.
      expect(seen["tab:Claude Desktop"]).toBeNull();
      expect(seen["add:Claude Desktop"]).toBe("Add to Claude");
    } else {
      expect(seen.tabs).toEqual(["Claude Code", "Codex", "Other MCP clients"]);
    }
    expect(ui.takeIpc()).toEqual([]);
    expectIoBudget({
      scenario: "renderer-agents-browse",
      note: "Header popover opened 4 times, 3-5 client tabs, a command disclosure and a link into Settings with 3 sessions and 40 logged refusals: "
        + "local state, 0 IPC, 0 reads and 0 writes/day at any monitoring interval.",
      io,
    });
    ui.unmount();
  });

  it("refuses an agent's delete its role doesn't grant, and shows it without a read", async () => {
    const view = mountAgentUi();
    await ui.settle();
    ui.takeIpc();

    let reply!: { status: number; json: any };
    const { io } = await measureFsIo(async () => {
      reply = await mcpPost(guideToken, {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "diskhound_delete_permanently", arguments: { paths: [`${ROOT}/Downloads`] } },
      });
      // The log appends 2 s after the first refusal.
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      await ui.settle();
    }, { countProcesses: true });

    expect(reply.status).toBe(200);
    expect(reply.json.result.isError).toBe(true);
    expect(reply.json.result.content[0].text).toContain("isn't available to this DiskHound session (Cleanup Guide doesn't grant files.delete)");
    // Pushed into Settings (blocked list, the session's link) and the header.
    expect(view.querySelector(".agent-blocked-row")?.textContent).toContain("Tried to delete items permanently; Cleanup Guide doesn't allow it.");
    expect(withText(view, ".agent-session-row", "Claude Code — diskhound").querySelector(".agent-blocked-link")?.textContent)
      .toContain("1 blocked");
    // The header turns into the agent's pill, red because the call was refused.
    const pill = one(view, ".agent-pill.failed");
    expect(pill.textContent).toContain("Claude Code — diskhound");
    await click(pill);
    expect(one(view, ".agent-pop-blocked").textContent).toBe("1 blocked request today");
    expect(ui.takeIpc()).toEqual([]);
    const log = FS.readFileSync(Path.join(main.userData, "agent-security.log"), "utf8").trim().split("\n");
    expect(JSON.parse(log.at(-1)!)).toMatchObject({ tool: "diskhound_delete_permanently", sessionName: "Claude Code — diskhound", count: 1 });
    expectIoBudget({
      scenario: "renderer-agents-blocked-delete",
      note: "A Cleanup Guide agent calls diskhound_delete_permanently over HTTP: refused before any tool runs, one append to "
        + "agent-security.log and the crash.log line, pushed to the UI with 0 IPC. Writes happen only when an agent is refused "
        + "(not per monitoring tick), and the log caps them at 288 appends and ~0.5 MB/day even for an agent refused nonstop.",
      io,
    });
    ui.unmount();
  });

  it("builds DiskHound's Claude extension from its helper and opens it in Claude", async () => {
    const view = mountAgentUi();
    await ui.settle();
    await click(withText(view, ".agent-disclose", "Connect another agent"));
    ui.takeIpc();
    // Imported once main has booted: the fake electron belongs to the harness.
    const { shell } = await import("electron");
    const opened: string[] = [];
    shell.openPath = async (target: string) => {
      opened.push(target);
      return "";
    };

    const { io } = await measureFsIo(async () => {
      if (hasClaudeDesktop) {
        await click(withText(view, ".agent-client-tabs button", "Claude Desktop"));
        await click(button(view, "Add to Claude"));
      } else {
        // No tab on Linux; the handler is the same everywhere.
        await nativeApi.addAgentToClaude();
      }
      await ui.settle();
    }, { countProcesses: true });

    expect(ui.takeIpc()).toEqual(["diskhound:agent-access-add-to-claude"]);
    if (hasClaudeDesktop) expect(one(view, ".agent-step-result").textContent).toBe("Opened in Claude.");
    expect(opened).toHaveLength(1);
    const entries = unzip(FS.readFileSync(opened[0]!));
    expect(entries.map((entry) => entry.name)).toContain(`server/${process.platform === "win32" ? "diskhound-mcp.exe" : "diskhound-mcp"}`);
    expect(JSON.parse(entries[0]!.data.toString("utf8")).server.mcp_config.args).toEqual(["--port", String(port)]);
    expectIoBudget({
      scenario: "renderer-agents-add-to-claude",
      note: "Add to Claude: reads the helper (1.4 MB), the icon and, unpackaged, package.json, then writes the ~0.7 MB "
        + "bundle to temp once and hands it to Claude. A user click, about once per setup, so 0 writes/day and 0 MB/day "
        + "from monitoring at the default or the 1-minute interval.",
      io,
    });
    ui.unmount();
  });

  it("changes a session's role and revokes one with one policy write each", async () => {
    const view = mountAgentUi();
    await ui.settle();
    ui.takeIpc();
    const row = withText(view, ".agent-session-row", "Codex");
    const select = one<HTMLSelectElement>(row, "select");

    const { io } = await measureFsIo(async () => {
      select.value = "builtin.admin";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await ui.settle();
      await click(button(withText(view, ".agent-session-row", "Claude Desktop"), "Revoke"));
      await ui.settle();
    }, { countProcesses: true });

    expect(ui.takeIpc()).toEqual(["diskhound:agent-access-assign-role", "diskhound:agent-access-revoke"]);
    expect(view.querySelectorAll(".agent-session-row")).toHaveLength(2);
    expect(one<HTMLSelectElement>(withText(view, ".agent-session-row", "Codex"), "select").value).toBe("builtin.admin");
    expectIoBudget({
      scenario: "renderer-agents-role-change-revoke",
      note: "One role change and one revoke from Settings: each replaces mcp-policy.json once (atomic write + rename). "
        + "User clicks only, so a few writes/day and well under 0.1 MB/day at any monitoring interval.",
      io,
    });
    ui.unmount();
  });
});
