import { beforeEach, describe, expect, it, vi } from "vitest";

import { BUILT_IN_MCP_ROLES, MCP_AGENT_CAPABILITIES, type McpAgentCapability } from "../../shared/agentAccess";
import type { ConsentDecision } from "../agentOAuth";
import { ConsentBroker, type ConsentSender, type ConsentWindow } from "../consentBroker";

const ALL: McpAgentCapability[] = [...MCP_AGENT_CAPABILITIES];

/** Stand-in for the Electron BrowserWindow slice the broker uses. */
class FakeWindow implements ConsentWindow {
  private static nextId = 100;
  readonly webContentsId = FakeWindow.nextId++;
  private readonly closedListeners: (() => void)[] = [];
  private destroyed = false;
  closeCalls = 0;

  onClosed(listener: () => void): void {
    this.closedListeners.push(listener);
  }

  /** Programmatic close (the broker) or the user clicking the close button. */
  close(): void {
    this.closeCalls++;
    if (this.destroyed) return;
    this.destroyed = true;
    for (const listener of this.closedListeners.splice(0)) listener();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  get main(): ConsentSender {
    return { webContentsId: this.webContentsId, isMainFrame: true };
  }
}

let windows: FakeWindow[];
let activeNames: string[];
let broker: ConsentBroker;
let createWindow: ReturnType<typeof vi.fn<() => ConsentWindow>>;

beforeEach(() => {
  windows = [];
  activeNames = [];
  createWindow = vi.fn(() => {
    const window = new FakeWindow();
    windows.push(window);
    return window;
  });
  broker = new ConsentBroker(createWindow, () => activeNames);
});

function ask(clientName = "Claude Code", scopes: McpAgentCapability[] = ALL, signal = new AbortController().signal) {
  const decision = broker.request({ clientName, scopes, signal });
  const window = windows.at(-1)!;
  return { decision, window };
}

/** Whether a promise has settled after the current microtasks drain. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true), () => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

const DENY: ConsentDecision = { decision: "deny", sessionName: "", roleId: "" };

describe("ConsentBroker.request / read", () => {
  it("opens one window per request and shows the prompt only to its main frame", async () => {
    const { window } = ask();
    expect(createWindow).toHaveBeenCalledTimes(1);
    const prompt = broker.read(window.main);
    expect(prompt).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      clientName: "Claude Code",
      sessionName: "Claude Code",
      requestedScopes: ALL,
      roles: [
        expect.objectContaining({ id: "builtin.reader" }),
        expect.objectContaining({ id: "builtin.guide" }),
        expect.objectContaining({ id: "builtin.operator" }),
      ],
      defaultRoleId: "builtin.guide",
    });

    expect(broker.read({ webContentsId: window.webContentsId, isMainFrame: false })).toBeNull();
    expect(broker.read({ webContentsId: 1, isMainFrame: true })).toBeNull();
  });

  it("offers only roles that fit inside the requested scopes", () => {
    const readOnly = ask("Reader", ["disk.read"]);
    expect(broker.read(readOnly.window.main)).toMatchObject({
      roles: [expect.objectContaining({ id: "builtin.reader" })],
      defaultRoleId: "builtin.reader",
    });

    const noNavigate = ask("Scanner", ["disk.read", "scan.run"]);
    expect(broker.read(noNavigate.window.main)?.roles.map((role) => role.id)).toEqual(["builtin.reader"]);

    const guide = ask("Guide", ["disk.read", "scan.run", "app.navigate"]);
    expect(broker.read(guide.window.main)).toMatchObject({
      roles: [expect.objectContaining({ id: "builtin.reader" }), expect.objectContaining({ id: "builtin.guide" })],
      defaultRoleId: "builtin.guide",
    });

    const nothing = ask("Trash only", ["files.trash"]);
    expect(broker.read(nothing.window.main)).toMatchObject({ roles: [], defaultRoleId: "" });
  });

  it("copies roles into the prompt so the built-in role table cannot be mutated through it", () => {
    const { window } = ask();
    const prompt = broker.read(window.main)!;
    prompt.roles[0]!.permissions.push("files.trash");
    expect(BUILT_IN_MCP_ROLES[0]!.permissions).toEqual(["disk.read"]);
  });

  it("de-duplicates the suggested Session name against active Sessions", () => {
    activeNames = ["Claude Code", "Claude Code 2", "Codex"];
    const { window } = ask("Claude Code");
    expect(broker.read(window.main)?.sessionName).toBe("Claude Code 3");

    const other = ask("Cursor");
    expect(broker.read(other.window.main)?.sessionName).toBe("Cursor");
  });

  it("trims the suggested Session name to 180 characters", () => {
    const { window } = ask("x".repeat(500));
    const prompt = broker.read(window.main)!;
    expect(prompt.clientName).toHaveLength(500);
    expect(prompt.sessionName).toHaveLength(180);
  });
});

describe("ConsentBroker.decide", () => {
  it("resolves the request with the chosen name and role and closes the window", async () => {
    const { decision, window } = ask();
    const prompt = broker.read(window.main)!;
    expect(
      broker.decide(window.main, { requestId: prompt.requestId, decision: "allow", sessionName: "My Claude", roleId: "builtin.operator" }),
    ).toEqual({ ok: true });
    await expect(decision).resolves.toEqual({ decision: "allow", sessionName: "My Claude", roleId: "builtin.operator" });
    expect(window.isDestroyed()).toBe(true);
    expect(broker.read(window.main)).toBeNull();
    // Deciding twice is refused.
    expect(broker.decide(window.main, { requestId: prompt.requestId, decision: "deny", sessionName: "", roleId: "" }).ok).toBe(false);
  });

  it("rejects decisions from other windows, subframes, or for another request", async () => {
    const { decision, window } = ask();
    const other = ask("Codex").window;
    const prompt = broker.read(window.main)!;
    const allow = { requestId: prompt.requestId, decision: "allow" as const, sessionName: "X", roleId: "builtin.reader" };

    expect(broker.decide(other.main, allow)).toMatchObject({ ok: false });
    expect(broker.decide({ webContentsId: window.webContentsId, isMainFrame: false }, allow)).toMatchObject({ ok: false });
    expect(broker.decide({ webContentsId: 424242, isMainFrame: true }, allow)).toMatchObject({ ok: false });
    expect(broker.decide(window.main, { ...allow, requestId: "not-the-request" })).toMatchObject({ ok: false });

    expect(await settled(decision)).toBe(false);
    expect(window.isDestroyed()).toBe(false);
  });

  it("requires a name and one of the offered roles to allow", async () => {
    const { decision, window } = ask("Reader", ["disk.read"]);
    const { requestId } = broker.read(window.main)!;
    const base = { requestId, decision: "allow" as const };
    expect(broker.decide(window.main, { ...base, sessionName: "   ", roleId: "builtin.reader" }).ok).toBe(false);
    expect(broker.decide(window.main, { ...base, sessionName: "x".repeat(201), roleId: "builtin.reader" }).ok).toBe(false);
    // builtin.operator exists but was not offered for a read-only request.
    expect(broker.decide(window.main, { ...base, sessionName: "Reader", roleId: "builtin.operator" }).ok).toBe(false);
    expect(broker.decide(window.main, { ...base, sessionName: "Reader", roleId: "builtin.nope" }).ok).toBe(false);
    expect(
      broker.decide(window.main, { requestId, decision: "maybe" as never, sessionName: "Reader", roleId: "builtin.reader" }).ok,
    ).toBe(false);
    expect(await settled(decision)).toBe(false);

    expect(broker.decide(window.main, { ...base, sessionName: "Reader", roleId: "builtin.reader" })).toEqual({ ok: true });
    await expect(decision).resolves.toMatchObject({ decision: "allow", roleId: "builtin.reader" });
  });

  it("accepts a deny without a name or role", async () => {
    const { decision, window } = ask();
    const { requestId } = broker.read(window.main)!;
    expect(broker.decide(window.main, { requestId, decision: "deny", sessionName: "", roleId: "" })).toEqual({ ok: true });
    await expect(decision).resolves.toMatchObject({ decision: "deny" });
    expect(window.isDestroyed()).toBe(true);
  });

  it("tolerates a malformed IPC payload", () => {
    const { window } = ask();
    expect(broker.decide(window.main, undefined as never)).toMatchObject({ ok: false });
    expect(broker.decide(window.main, null as never)).toMatchObject({ ok: false });
  });
});

describe("ConsentBroker deny paths", () => {
  it("treats closing the window as a deny", async () => {
    const { decision, window } = ask();
    window.close();
    await expect(decision).resolves.toEqual(DENY);
    expect(broker.read(window.main)).toBeNull();
  });

  it("treats an aborted request (expired OAuth approval) as a deny and closes the window", async () => {
    const controller = new AbortController();
    const { decision, window } = ask("Claude Code", ALL, controller.signal);
    controller.abort();
    await expect(decision).resolves.toEqual(DENY);
    expect(window.isDestroyed()).toBe(true);
    expect(window.closeCalls).toBe(1);
  });

  it("denies an already-aborted request without opening a window", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(broker.request({ clientName: "Late", scopes: ALL, signal: controller.signal })).resolves.toEqual(DENY);
    expect(createWindow).not.toHaveBeenCalled();
  });

  it("caps pending approvals at 8", async () => {
    const pending = Array.from({ length: 8 }, (_, index) => ask(`Agent ${index}`));
    expect(createWindow).toHaveBeenCalledTimes(8);
    await expect(broker.request({ clientName: "Ninth", scopes: ALL, signal: new AbortController().signal })).resolves.toEqual(DENY);
    expect(createWindow).toHaveBeenCalledTimes(8);

    // Finishing one frees a slot.
    pending[0]!.window.close();
    await pending[0]!.decision;
    ask("Ninth again");
    expect(createWindow).toHaveBeenCalledTimes(9);
  });

  it("close() denies everything pending and closes every window", async () => {
    const first = ask("One");
    const second = ask("Two");
    broker.close();
    await expect(first.decision).resolves.toEqual(DENY);
    await expect(second.decision).resolves.toEqual(DENY);
    expect(first.window.isDestroyed()).toBe(true);
    expect(second.window.isDestroyed()).toBe(true);
  });
});
