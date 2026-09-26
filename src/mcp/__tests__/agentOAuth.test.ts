import { createHash, randomBytes } from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import type { Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

import { McpPolicyStore } from "../accessPolicy";
import { AgentOAuth, type ConsentDecision, type ConsentRequest } from "../agentOAuth";

const RESOURCE = new URL("http://127.0.0.1:51733/mcp");
const REDIRECT_URI = "http://127.0.0.1:47999/callback";
const TTL_MS = 5 * 60_000;

/** Just enough of an Express Response to capture what AgentOAuth sends. */
class FakeResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  location: string | undefined;
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  type(_type: string) {
    return this;
  }
  send(body: string) {
    this.body = body;
    return this;
  }
  redirect(code: number, url: string) {
    this.statusCode = code;
    this.location = url;
  }
  get asExpress(): Response {
    return this as unknown as Response;
  }
}

let tempDir: string;
let policy: McpPolicyStore;
let requests: ConsentRequest[];
let consent: (request: ConsentRequest) => Promise<ConsentDecision>;
let oauth: AgentOAuth;
let onChanged: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  tempDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-oauth-test-"));
  policy = new McpPolicyStore(Path.join(tempDir, "mcp-policy.json"));
  requests = [];
  consent = async () => ({ decision: "allow", sessionName: "Agent", roleId: "builtin.guide" });
  onChanged = vi.fn<() => void>();
  oauth = new AgentOAuth({
    policy,
    clientsFile: Path.join(tempDir, "clients.json"),
    resource: RESOURCE,
    requestConsent: (request) => {
      requests.push(request);
      return consent(request);
    },
    onChanged,
  });
});

afterEach(() => {
  vi.useRealTimers();
  oauth.close();
  FS.rmSync(tempDir, { recursive: true, force: true });
});

async function registerClient(name = "Test Agent"): Promise<OAuthClientInformationFull> {
  return (await oauth.clientsStore.registerClient!({
    client_name: name,
    redirect_uris: [REDIRECT_URI],
  } as OAuthClientInformationFull)) as OAuthClientInformationFull;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function params(challenge: string, extra: Partial<AuthorizationParams> = {}): AuthorizationParams {
  return {
    state: "s1",
    scopes: ["disk.read", "scan.run", "app.navigate", "files.trash"],
    codeChallenge: challenge,
    redirectUri: REDIRECT_URI,
    resource: RESOURCE,
    ...extra,
  };
}

/** Start an authorization and return the approval id from the waiting page. */
async function begin(client: OAuthClientInformationFull, challenge = pkce().challenge, extra: Partial<AuthorizationParams> = {}) {
  const response = new FakeResponse();
  await oauth.authorize(client, params(challenge, extra), response.asExpress);
  const id = /status\?id=([A-Za-z0-9_-]+)/.exec(response.body)?.[1];
  if (!id) throw new Error("no approval id in the waiting page");
  return id;
}

/** Let the consent promise chain settle. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function poll(id: string): FakeResponse {
  const response = new FakeResponse();
  oauth.status(id, response.asExpress);
  return response;
}

describe("AgentOAuth", () => {
  it("issues a single-use code bound to the client and creates the Session at exchange", async () => {
    const client = await registerClient();
    const { verifier, challenge } = pkce();
    const id = await begin(client, challenge);
    await flush();
    const redirect = poll(id);
    expect(redirect.statusCode).toBe(302);
    const code = new URL(redirect.location!).searchParams.get("code")!;

    expect(await oauth.challengeForAuthorizationCode(client, code)).toBe(challenge);
    const other = await registerClient("Other");
    await expect(oauth.challengeForAuthorizationCode(other, code)).rejects.toBeInstanceOf(InvalidGrantError);

    const tokens = await oauth.exchangeAuthorizationCode(client, code, verifier, REDIRECT_URI, RESOURCE);
    expect(tokens).toMatchObject({ token_type: "bearer", scope: "disk.read scan.run app.navigate files.trash" });
    expect(onChanged).toHaveBeenCalledTimes(1);
    await expect(oauth.exchangeAuthorizationCode(client, code, verifier, REDIRECT_URI, RESOURCE)).rejects.toBeInstanceOf(InvalidGrantError);

    const info = await oauth.verifyAccessToken(tokens.access_token);
    expect(info).toEqual({
      token: tokens.access_token,
      clientId: client.client_id,
      scopes: ["disk.read", "scan.run", "app.navigate"],
      resource: RESOURCE,
    });
  });

  it("aborts the consent request and forgets the approval when it expires", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    consent = (request) => {
      signal = request.signal;
      return new Promise<ConsentDecision>(() => undefined);
    };
    const id = await begin(await registerClient());
    expect(signal?.aborted).toBe(false);
    expect(poll(id).statusCode).toBe(200);

    vi.advanceTimersByTime(TTL_MS);
    expect(signal?.aborted).toBe(true);
    expect(poll(id).statusCode).toBe(404);
  });

  it("ignores an approval that arrives after the request expired", async () => {
    vi.useFakeTimers();
    let decide: ((decision: ConsentDecision) => void) | undefined;
    consent = () => new Promise<ConsentDecision>((resolve) => (decide = resolve));
    const id = await begin(await registerClient());
    vi.advanceTimersByTime(TTL_MS + 1);
    decide!({ decision: "allow", sessionName: "Late", roleId: "builtin.guide" });
    await flush();
    expect(poll(id).statusCode).toBe(404);
    expect(policy.sessions()).toEqual([]);
  });

  it("expires unused authorization codes after five minutes", async () => {
    vi.useFakeTimers();
    const client = await registerClient();
    const { verifier, challenge } = pkce();
    const id = await begin(client, challenge);
    await flush();
    const code = new URL(poll(id).location!).searchParams.get("code")!;
    vi.advanceTimersByTime(TTL_MS);
    await expect(oauth.exchangeAuthorizationCode(client, code, verifier, REDIRECT_URI, RESOURCE)).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("denies, as defense in depth, decisions the approval window should never produce", async () => {
    const client = await registerClient();
    const cases: [string, () => Promise<ConsentDecision>, Partial<AuthorizationParams>][] = [
      ["role beyond the requested scopes", async () => ({ decision: "allow", sessionName: "A", roleId: "builtin.operator" }), { scopes: ["disk.read"] }],
      ["blank session name", async () => ({ decision: "allow", sessionName: "   ", roleId: "builtin.reader" }), {}],
      ["unknown role", async () => ({ decision: "allow", sessionName: "A", roleId: "builtin.root" }), {}],
      ["consent callback throws", async () => {
        throw new Error("window crashed");
      }, {}],
    ];
    for (const [label, decide, extra] of cases) {
      consent = decide;
      const id = await begin(client, pkce().challenge, extra);
      await flush();
      const redirect = poll(id);
      expect(redirect.statusCode, label).toBe(302);
      const location = new URL(redirect.location!);
      expect(location.searchParams.get("error"), label).toBe("access_denied");
      expect(location.searchParams.get("state"), label).toBe("s1");
    }
    expect(policy.sessions()).toEqual([]);
  });

  it("passes the client name and requested scopes to the consent callback", async () => {
    await begin(await registerClient("  Claude Code  "), pkce().challenge, { scopes: ["disk.read"] });
    await begin(await registerClient("   "), pkce().challenge, { scopes: [] });
    expect(requests.map((request) => [request.clientName, request.scopes])).toEqual([
      ["Claude Code", ["disk.read"]],
      ["Local MCP client", ["disk.read", "scan.run", "app.navigate", "files.trash"]],
    ]);
  });

  it("limits pending approvals to 64", async () => {
    consent = () => new Promise<ConsentDecision>(() => undefined);
    const client = await registerClient();
    for (let i = 0; i < 64; i++) await begin(client);
    await expect(oauth.authorize(client, params(pkce().challenge), new FakeResponse().asExpress)).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("close() aborts every pending approval", async () => {
    const signals: AbortSignal[] = [];
    consent = (request) => {
      signals.push(request.signal);
      return new Promise<ConsentDecision>(() => undefined);
    };
    const client = await registerClient();
    await begin(client);
    await begin(client);
    oauth.close();
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
  });

  it("rejects revoked or unknown tokens and treats revoking them as a no-op", async () => {
    await expect(oauth.verifyAccessToken("dhmcp_unknown")).rejects.toBeInstanceOf(InvalidTokenError);
    const client = await registerClient();
    await expect(oauth.revokeToken(client, { token: "dhmcp_unknown" })).resolves.toBeUndefined();
    await expect(oauth.exchangeRefreshToken()).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("recovers from a corrupt client store by starting empty", () => {
    const file = Path.join(tempDir, "corrupt-clients.json");
    FS.writeFileSync(file, "{oops");
    const fresh = new AgentOAuth({ policy, clientsFile: file, resource: RESOURCE, requestConsent: consent, onChanged });
    expect(fresh.clientsStore.getClient("anything")).toBeUndefined();
  });
});
