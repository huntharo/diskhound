import { createHash, randomBytes } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Locator, Page } from "@playwright/test";

import { BUILT_IN_MCP_ROLES, MCP_AGENT_CAPABILITIES } from "../../src/shared/agentAccess";
import { expect, type AppHandle } from "./electron-app";
import { openTab } from "./steps";

/** Where a CLI agent's login listens. Nothing needs to: the spec reads
 *  the code from the 302 instead of following it. */
const REDIRECT_URI = "http://127.0.0.1:47999/callback";

export function agentBaseUrl(handle: AppHandle): string {
  return `http://127.0.0.1:${handle.agentPort}`;
}

/** Wait for the MCP server. With agents seeded on, it starts after the
 *  main window, so it can lag the fixture's `.app-shell` wait. */
export async function waitForAgentServer(handle: AppHandle): Promise<void> {
  const metadata = `${agentBaseUrl(handle)}/.well-known/oauth-authorization-server`;
  await expect
    .poll(() => fetch(metadata).then((response) => response.status, () => 0))
    .toBe(200);
}

/** Settings → AI Agents, then flip "Allow local AI agents" on. */
export async function turnOnAgents(page: Page): Promise<void> {
  await openTab(page, "Settings");
  const section = page.locator("#settings-ai-agents");
  await section.locator("label.toggle").click();
  await expect(section.locator(".agent-status-chip")).toHaveText("On");
}

type Authorization = {
  /** The approval window DiskHound opened for this request. */
  approval: Page;
  /** Poll the waiting page's status URL until the window has decided. */
  redirect: () => Promise<URL>;
  clientId: string;
  verifier: string;
};

/**
 * Click Approve or Deny. DiskHound closes the window as soon as it has
 * the decision, and on Windows that can land before the click returns,
 * so a click cut short by the window closing is the expected outcome.
 * The redirect still says what was decided.
 */
async function decide(approval: Page, button: "Approve" | "Deny"): Promise<void> {
  const closed = approval.waitForEvent("close");
  try {
    await approval.getByRole("button", { name: button }).click();
  } catch (error) {
    if (!approval.isClosed()) throw error;
  }
  await closed;
}

/**
 * The first half of `claude mcp login`: register the client, open
 * /authorize, and catch the approval window it opens in DiskHound.
 */
async function authorize(handle: AppHandle, clientName: string): Promise<Authorization> {
  await waitForAgentServer(handle);
  const base = agentBaseUrl(handle);
  const registered = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
  });
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };

  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(`${base}/authorize`);
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "e2e",
    resource: `${base}/mcp`,
    scope: MCP_AGENT_CAPABILITIES.join(" "),
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const [approval, waiting] = await Promise.all([
    handle.app.waitForEvent("window", {
      predicate: async (page) => {
        await page.waitForLoadState("domcontentloaded");
        return /[?&]consent=1\b/.test(page.url());
      },
    }),
    fetch(url, { redirect: "manual" }),
  ]);
  // The browser only gets an inert page that polls for the decision.
  expect(waiting.status).toBe(200);
  const id = /url=\/authorize\/status\?id=([A-Za-z0-9_-]+)/.exec(await waiting.text())?.[1];
  expect(id, "the waiting page names its status URL").toBeTruthy();

  const redirect = async () => {
    let location: string | null = null;
    await expect
      .poll(async () => {
        const response = await fetch(`${base}/authorize/status?id=${id}`, { redirect: "manual" });
        location = response.headers.get("location");
        await response.body?.cancel();
        return response.status;
      })
      .toBe(302);
    return new URL(location!);
  };

  await expect(approval.locator(".agent-consent")).toContainText(clientName);
  return { approval, redirect, clientId, verifier };
}

export type SignInOptions = {
  clientName?: string;
  /** Typed over the suggested name (the client's own) when set. */
  sessionName?: string;
  /** Picked from the role cards. The window preselects Cleanup Guide. */
  roleId?: string;
};

/**
 * The whole login an agent such as Claude Code runs, with the user's
 * part played in DiskHound's approval window. Returns the bearer token.
 */
export async function signIn(handle: AppHandle, opts: SignInOptions = {}): Promise<string> {
  const clientName = opts.clientName ?? "E2E Agent";
  const { approval, redirect, clientId, verifier } = await authorize(handle, clientName);

  const name = approval.locator(".agent-consent-field input");
  await expect(name).toHaveValue(clientName);
  if (opts.sessionName) await name.fill(opts.sessionName);
  if (opts.roleId) {
    const role = BUILT_IN_MCP_ROLES.find((candidate) => candidate.id === opts.roleId);
    if (!role) throw new Error(`unknown role ${opts.roleId}`);
    const card = approval.locator(".agent-role-card", { has: approval.locator(".agent-role-name", { hasText: role.name }) });
    await card.click();
    await expect(card).toHaveAttribute("aria-checked", "true");
    await expect(approval.getByRole("button", { name: `Approve as ${role.name}` })).toBeEnabled();
    // Anything past the default says what it adds; a delete says it can't be undone.
    if (role.permissions.includes("files.delete")) {
      await expect(approval.locator(".agent-consent-delta.destructive")).toContainText("can't be restored");
    }
  }
  await decide(approval, "Approve");

  const callback = await redirect();
  expect(callback.searchParams.get("state")).toBe("e2e");
  const code = callback.searchParams.get("code");
  expect(code, `approval redirect ${callback.href}`).toBeTruthy();

  const base = agentBaseUrl(handle);
  const response = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource: `${base}/mcp`,
    }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

/** Start a login and click Deny. Returns where the agent is sent. */
export async function signInDenied(handle: AppHandle, clientName: string): Promise<URL> {
  const { approval, redirect } = await authorize(handle, clientName);
  await decide(approval, "Deny");
  return redirect();
}

export async function connectAgent(handle: AppHandle, token: string): Promise<Client> {
  await waitForAgentServer(handle);
  const transport = new StreamableHTTPClientTransport(new URL(`${agentBaseUrl(handle)}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "diskhound-e2e", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** The first text block: the tool's one-paragraph summary or error. */
export function resultText(result: CallToolResult): string {
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
}

/** HTTP status of a bare MCP initialize with this token. */
export async function mcpStatus(handle: AppHandle, token: string): Promise<number> {
  const response = await fetch(`${agentBaseUrl(handle)}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "diskhound-e2e", version: "1" } },
    }),
  });
  await response.body?.cancel();
  return response.status;
}

export type TrashStub = {
  /**
   * Every native message box main showed since the stub went in. Agents'
   * removals wait on DiskHound's review list instead, so specs expect
   * none.
   */
  dialogs: () => Promise<string[]>;
};

type StubbedDialog = {
  __e2eDialogs: string[];
  showMessageBox: (...args: unknown[]) => Promise<{ response: number; checkboxChecked: boolean }>;
};

/**
 * Stub the Trash in main: `shell.trashItem` moves the item into
 * `trashDir` instead of the developer's real Trash or Recycle Bin.
 * `dialog.showMessageBox` records what it was asked and answers with
 * the last button (Cancel), so a dialog that shouldn't appear can't
 * remove anything.
 */
export async function stubTrash(handle: AppHandle, trashDir: string): Promise<TrashStub> {
  await handle.app.evaluate(({ dialog, shell }, dir) => {
    const fs = process.getBuiltinModule("node:fs");
    const path = process.getBuiltinModule("node:path");
    const stub = dialog as unknown as StubbedDialog;
    stub.__e2eDialogs = [];
    stub.showMessageBox = async (...args) => {
      // showMessageBox([window,] options)
      const options = args.at(-1) as { message?: string; buttons?: string[] };
      stub.__e2eDialogs.push(options.message ?? "");
      return { response: Math.max(0, (options.buttons?.length ?? 1) - 1), checkboxChecked: false };
    };
    (shell as unknown as { trashItem: (target: string) => Promise<void> }).trashItem = async (target) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(target, path.join(dir, path.basename(target)));
    };
  }, trashDir);

  return {
    dialogs: () => handle.app.evaluate(({ dialog }) => (dialog as unknown as StubbedDialog).__e2eDialogs),
  };
}

/** The Trash's name in DiskHound's text on this OS. */
export const BIN = process.platform === "win32" ? "Recycle Bin" : "Trash";

/** Open the review list from the header pill, as the user does. */
export async function openReview(page: Page): Promise<Locator> {
  await page.locator(".agent-pill.review").click();
  await page.locator(".agent-pop").getByRole("button", { name: "Review…" }).click();
  const sheet = page.locator(".rv-sheet");
  await expect(sheet).toBeVisible();
  return sheet;
}

/** One item's row on the review sheet. */
export function reviewRow(sheet: Locator, path: string): Locator {
  return sheet.locator(".rv-row").filter({ has: sheet.page().getByTitle(path, { exact: true }) });
}

/** Switch an item between the Trash and a permanent delete. */
export async function chooseAction(row: Locator, action: "trash" | "delete"): Promise<void> {
  const label = action === "delete" ? "Delete" : process.platform === "win32" ? "Recycle" : "Trash";
  const button = row.getByRole("radio", { name: label });
  await button.click();
  await expect(button).toHaveAttribute("aria-checked", "true");
}
