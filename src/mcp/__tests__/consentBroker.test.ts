import { beforeEach, describe, expect, it, vi } from "vitest";

import { BUILT_IN_MCP_ROLES, MCP_AGENT_CAPABILITIES, type McpAgentCapability } from "../../shared/agentAccess";
import type { ConsentDecision } from "../agentOAuth";
import { AGENT_CONSENT_STATE_CHANNEL, ConsentBroker, type ConsentSender, type ConsentWindow } from "../consentBroker";

const ALL: McpAgentCapability[] = [...MCP_AGENT_CAPABILITIES];

/** Stand-in for the Electron BrowserWindow slice the broker uses. */
class FakeWindow implements ConsentWindow {
  private static nextId = 100;
  readonly webContentsId = FakeWindow.nextId++;
  private readonly closedListeners: (() => void)[] = [];
  private destroyed = false;
  closeCalls = 0;
  focusCalls = 0;
  readonly sent: { channel: string; payload: unknown }[] = [];

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

  focus(): void {
    this.focusCalls++;
  }

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }

  get main(): ConsentSender {
    return { webContentsId: this.webContentsId, isMainFrame: true };
  }
}

let windows: FakeWindow[];
let activeNames: string[];
let changes: number;
let broker: ConsentBroker;
let createWindow: ReturnType<typeof vi.fn<() => ConsentWindow>>;

beforeEach(() => {
  windows = [];
  activeNames = [];
  changes = 0;
  createWindow = vi.fn(() => {
    const window = new FakeWindow();
    windows.push(window);
    return window;
  });
  broker = new ConsentBroker(createWindow, () => activeNames, () => changes++);
});

/** Let the broker open the next sheet (createWindow may be async). */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

interface AskOptions {
  scopes?: McpAgentCapability[];
  signal?: AbortSignal;
  via?: "stdio" | "http";
  waiting?: () => boolean;
}

/** Ask for consent; `window` is the sheet opened for it, if it's the one shown. */
async function ask(clientName = "Claude Code", options: AskOptions = {}) {
  const before = windows.length;
  const decision = broker.request({
    clientName,
    via: options.via ?? "stdio",
    scopes: options.scopes ?? ALL,
    signal: options.signal ?? new AbortController().signal,
    clientWaiting: options.waiting ?? (() => true),
  });
  await flush();
  const window = windows.length > before ? windows.at(-1)! : undefined;
  return { decision, window };
}

/** Ask, and deny whatever is on screen first so this request is the one shown. */
async function show(clientName = "Claude Code", options: AskOptions = {}) {
  for (const window of windows) if (!window.isDestroyed()) window.close();
  await flush();
  const asked = await ask(clientName, options);
  if (!asked.window) throw new Error(`${clientName} was queued, not shown`);
  return { decision: asked.decision, window: asked.window };
}

/** Whether a promise has settled after the current microtasks drain. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true), () => (done = true));
  await flush();
  return done;
}

const DENY: ConsentDecision = { decision: "deny", sessionName: "", roleId: "" };

describe("ConsentBroker.request / read", () => {
  it("opens a sheet for the request and shows the prompt only to its main frame", async () => {
    const { window } = await show();
    expect(createWindow).toHaveBeenCalledTimes(1);
    const prompt = broker.read(window.main);
    expect(prompt).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      clientName: "Claude Code",
      via: "stdio",
      sessionName: "Claude Code",
      requestedScopes: ALL,
      roles: [
        expect.objectContaining({ id: "builtin.reader" }),
        expect.objectContaining({ id: "builtin.guide" }),
        expect.objectContaining({ id: "builtin.operator" }),
        expect.objectContaining({ id: "builtin.admin" }),
      ],
      defaultRoleId: "builtin.guide",
      stale: false,
      next: null,
    });

    expect(broker.read({ webContentsId: window.webContentsId, isMainFrame: false })).toBeNull();
    expect(broker.read({ webContentsId: 1, isMainFrame: true })).toBeNull();
  });

  it("offers only roles that fit inside the requested scopes", async () => {
    const readOnly = await show("Reader", { scopes: ["disk.read"] });
    expect(broker.read(readOnly.window.main)).toMatchObject({
      roles: [expect.objectContaining({ id: "builtin.reader" })],
      defaultRoleId: "builtin.reader",
    });

    const noNavigate = await show("Scanner", { scopes: ["disk.read", "scan.run"] });
    expect(broker.read(noNavigate.window.main)?.roles.map((role) => role.id)).toEqual(["builtin.reader"]);

    const guide = await show("Guide", { scopes: ["disk.read", "scan.run", "app.navigate"] });
    expect(broker.read(guide.window.main)).toMatchObject({
      roles: [expect.objectContaining({ id: "builtin.reader" }), expect.objectContaining({ id: "builtin.guide" })],
      defaultRoleId: "builtin.guide",
    });

    // Signed in before permanent delete existed: no Cleanup Admin.
    const trash = await show("Older Codex", { scopes: ["disk.read", "scan.run", "app.navigate", "files.trash"] });
    expect(broker.read(trash.window.main)?.roles.map((role) => role.id)).toEqual([
      "builtin.reader",
      "builtin.guide",
      "builtin.operator",
    ]);

    const nothing = await show("Trash only", { scopes: ["files.trash"] });
    expect(broker.read(nothing.window.main)).toMatchObject({ roles: [], defaultRoleId: "" });
  });

  it("copies roles into the prompt so the built-in role table cannot be mutated through it", async () => {
    const { window } = await show();
    const prompt = broker.read(window.main)!;
    prompt.roles[0]!.permissions.push("files.trash");
    expect(BUILT_IN_MCP_ROLES[0]!.permissions).toEqual(["disk.read"]);
  });

  it("de-duplicates the suggested Session name against active and waiting Sessions", async () => {
    activeNames = ["Claude Code", "Claude Code 2", "Codex"];
    const { window } = await ask("Claude Code");
    expect(broker.read(window!.main)?.sessionName).toBe("Claude Code 3");
    // Queued behind the first, and named around it.
    await ask("Claude Code");
    expect(broker.pending().map((pending) => pending.clientName)).toEqual(["Claude Code", "Claude Code"]);
    window!.close();
    await flush();
    expect(broker.read(windows.at(-1)!.main)?.sessionName).toBe("Claude Code 4");

    const other = await show("Cursor");
    expect(broker.read(other.window.main)?.sessionName).toBe("Cursor");
  });

  it("trims the suggested Session name to 180 characters", async () => {
    const { window } = await show("x".repeat(500));
    const prompt = broker.read(window.main)!;
    expect(prompt.clientName).toHaveLength(500);
    expect(prompt.sessionName).toHaveLength(180);
  });
});

describe("ConsentBroker.decide", () => {
  it("resolves the request with the chosen name and role and closes the sheet", async () => {
    const { decision, window } = await show();
    const prompt = broker.read(window.main)!;
    expect(
      broker.decide(window.main, { requestId: prompt.requestId, decision: "allow", sessionName: "My Claude", roleId: "builtin.admin" }),
    ).toEqual({ ok: true });
    await expect(decision).resolves.toEqual({ decision: "allow", sessionName: "My Claude", roleId: "builtin.admin" });
    expect(window.isDestroyed()).toBe(true);
    expect(broker.read(window.main)).toBeNull();
    // Deciding twice is refused.
    expect(broker.decide(window.main, { requestId: prompt.requestId, decision: "deny", sessionName: "", roleId: "" }).ok).toBe(false);
  });

  it("rejects decisions from other windows, subframes, or for another request", async () => {
    const { decision, window } = await show();
    // Queued: no sheet yet, so nothing can decide it.
    const queued = await ask("Codex");
    expect(queued.window).toBeUndefined();
    const prompt = broker.read(window.main)!;
    const allow = { requestId: prompt.requestId, decision: "allow" as const, sessionName: "X", roleId: "builtin.reader" };

    expect(broker.decide({ webContentsId: window.webContentsId, isMainFrame: false }, allow)).toMatchObject({ ok: false });
    expect(broker.decide({ webContentsId: 424242, isMainFrame: true }, allow)).toMatchObject({ ok: false });
    expect(broker.decide(window.main, { ...allow, requestId: "not-the-request" })).toMatchObject({ ok: false });
    const queuedId = broker.pending()[1]!.requestId;
    expect(broker.decide(window.main, { ...allow, requestId: queuedId })).toMatchObject({ ok: false });

    expect(await settled(decision)).toBe(false);
    expect(await settled(queued.decision)).toBe(false);
    expect(window.isDestroyed()).toBe(false);
  });

  it("requires a name and one of the offered roles to allow", async () => {
    const { decision, window } = await show("Reader", { scopes: ["disk.read"] });
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
    const { decision, window } = await show();
    const { requestId } = broker.read(window.main)!;
    expect(broker.decide(window.main, { requestId, decision: "deny", sessionName: "", roleId: "" })).toEqual({ ok: true });
    await expect(decision).resolves.toMatchObject({ decision: "deny" });
    expect(window.isDestroyed()).toBe(true);
  });

  it("tolerates a malformed IPC payload", async () => {
    const { window } = await show();
    expect(broker.decide(window.main, undefined as never)).toMatchObject({ ok: false });
    expect(broker.decide(window.main, null as never)).toMatchObject({ ok: false });
  });
});

describe("ConsentBroker queue", () => {
  it("shows requests one at a time, oldest first", async () => {
    const first = await ask("Claude Code");
    const second = await ask("Codex", { via: "http" });
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(first.window).toBeDefined();
    expect(second.window).toBeUndefined();
    expect(broker.pending()).toEqual([
      expect.objectContaining({ clientName: "Claude Code", via: "stdio", stale: false }),
      expect.objectContaining({ clientName: "Codex", via: "http", stale: false }),
    ]);
    expect(broker.read(first.window!.main)?.next).toBe("Codex");

    const { requestId } = broker.read(first.window!.main)!;
    broker.decide(first.window!.main, { requestId, decision: "deny", sessionName: "", roleId: "" });
    await first.decision;
    await flush();
    expect(createWindow).toHaveBeenCalledTimes(2);
    const shown = windows.at(-1)!;
    expect(broker.read(shown.main)).toMatchObject({ clientName: "Codex", next: null });
  });

  it("tells the sheet on screen when the queue behind it changes", async () => {
    const { window } = await ask("Claude Code");
    await ask("Codex");
    expect(window!.sent.at(-1)).toEqual({
      channel: AGENT_CONSENT_STATE_CHANNEL,
      payload: expect.objectContaining({ stale: false, next: "Codex" }),
    });
    broker.dismiss(broker.pending()[1]!.requestId);
    expect(window!.sent.at(-1)?.payload).toEqual(expect.objectContaining({ next: null }));
  });

  it("dismiss() denies one waiting request and leaves the rest", async () => {
    const first = await ask("Claude Code");
    const second = await ask("Codex");
    const before = changes;
    broker.dismiss(broker.pending()[1]!.requestId);
    await expect(second.decision).resolves.toEqual(DENY);
    expect(await settled(first.decision)).toBe(false);
    expect(first.window!.isDestroyed()).toBe(false);
    expect(broker.pending()).toHaveLength(1);
    expect(changes).toBeGreaterThan(before);

    // Dismissing the one on screen closes its sheet.
    broker.dismiss(broker.pending()[0]!.requestId);
    await expect(first.decision).resolves.toEqual(DENY);
    expect(first.window!.isDestroyed()).toBe(true);
  });

  it("focus() brings the sheet on screen forward", async () => {
    expect(broker.focus()).toBe(false);
    const { window } = await ask();
    expect(broker.focus()).toBe(true);
    expect(window!.focusCalls).toBe(1);
  });

  it("marks a request stale when its agent stops checking back, and fresh when it returns", async () => {
    let waiting = true;
    const { window } = await ask("Claude Code", { waiting: () => waiting });
    const before = changes;
    broker.checkStale();
    expect(broker.pending()[0]!.stale).toBe(false);
    expect(changes).toBe(before);

    waiting = false;
    broker.checkStale();
    expect(broker.pending()[0]!.stale).toBe(true);
    expect(broker.read(window!.main)?.stale).toBe(true);
    expect(window!.sent.at(-1)).toEqual({
      channel: AGENT_CONSENT_STATE_CHANNEL,
      payload: expect.objectContaining({ stale: true }),
    });
    expect(changes).toBe(before + 1);

    waiting = true;
    broker.checkStale();
    expect(broker.pending()[0]!.stale).toBe(false);
    expect(window!.sent.at(-1)?.payload).toEqual(expect.objectContaining({ stale: false }));
  });

  it("denies a request whose sheet can't be opened and shows the next one", async () => {
    createWindow.mockImplementationOnce(() => {
      throw new Error("main window is gone");
    });
    const first = await ask("Claude Code");
    const second = await ask("Codex");
    await expect(first.decision).resolves.toEqual(DENY);
    await flush();
    expect(broker.read(windows.at(-1)!.main)?.clientName).toBe("Codex");
    expect(await settled(second.decision)).toBe(false);
  });
});

describe("ConsentBroker deny paths", () => {
  it("treats closing the sheet as a deny", async () => {
    const { decision, window } = await show();
    window.close();
    await expect(decision).resolves.toEqual(DENY);
    expect(broker.read(window.main)).toBeNull();
  });

  it("treats an aborted request (expired OAuth approval) as a deny and closes the sheet", async () => {
    const controller = new AbortController();
    const { decision, window } = await show("Claude Code", { signal: controller.signal });
    controller.abort();
    await expect(decision).resolves.toEqual(DENY);
    expect(window.isDestroyed()).toBe(true);
    expect(window.closeCalls).toBe(1);
  });

  it("drops an aborted request from the queue without opening a sheet", async () => {
    await ask("Claude Code");
    const controller = new AbortController();
    const queued = await ask("Codex", { signal: controller.signal });
    controller.abort();
    await expect(queued.decision).resolves.toEqual(DENY);
    expect(broker.pending().map((pending) => pending.clientName)).toEqual(["Claude Code"]);
    expect(createWindow).toHaveBeenCalledTimes(1);
  });

  it("denies an already-aborted request without opening a sheet", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(broker.request({
      clientName: "Late",
      via: "http",
      scopes: ALL,
      signal: controller.signal,
      clientWaiting: () => true,
    })).resolves.toEqual(DENY);
    expect(createWindow).not.toHaveBeenCalled();
  });

  it("caps waiting approvals at 8", async () => {
    const pending = [];
    for (let index = 0; index < 8; index++) pending.push(await ask(`Agent ${index}`));
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(broker.pending()).toHaveLength(8);
    await expect(broker.request({
      clientName: "Ninth",
      via: "stdio",
      scopes: ALL,
      signal: new AbortController().signal,
      clientWaiting: () => true,
    })).resolves.toEqual(DENY);

    // Finishing one frees a slot.
    pending[0]!.window!.close();
    await pending[0]!.decision;
    await ask("Ninth again");
    expect(broker.pending()).toHaveLength(8);
  });

  it("close() denies everything waiting and closes the sheet", async () => {
    const first = await ask("One");
    const second = await ask("Two");
    broker.close();
    await expect(first.decision).resolves.toEqual(DENY);
    await expect(second.decision).resolves.toEqual(DENY);
    expect(first.window!.isDestroyed()).toBe(true);
    expect(broker.pending()).toEqual([]);
  });
});
