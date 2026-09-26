import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  BUILT_IN_MCP_ROLES,
  MCP_AGENT_CAPABILITIES,
  type McpAgentCapability,
  type McpAgentRole,
  type McpAgentSession,
} from "../shared/agentAccess";

/**
 * Session store for local agents, ported from PwrGit's MCP policy file.
 *
 * - Only a SHA-256 of each bearer token is written; the token itself is
 *   handed to the agent once, at OAuth code exchange, and never again.
 * - Every authorization re-reads the file, so a revoke or role change
 *   in Settings applies to the very next tool call without a restart.
 * - Roles live in code (BUILT_IN_MCP_ROLES). The file holds Sessions.
 * - Writes are temp-file + rename with 0600 perms in a 0700 directory.
 */

export const MCP_POLICY_PROTOCOL = "diskhound.mcp-policy/v1" as const;
export const MCP_POLICY_VERSION = 1 as const;

const MAX_SESSIONS = 256;
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const TOKEN_PREFIX = "dhmcp_";

interface McpAgentSessionRecord extends McpAgentSession {
  tokenHash: string;
}

interface McpPolicyFile {
  protocol: typeof MCP_POLICY_PROTOCOL;
  version: typeof MCP_POLICY_VERSION;
  sessions: McpAgentSessionRecord[];
}

export interface McpAuthorization {
  sessionId: string;
  sessionName: string;
  roleId: string;
  roleName: string;
  capabilities: readonly McpAgentCapability[];
}

export interface McpAuthorizer {
  authorize(capabilities?: readonly McpAgentCapability[]): Promise<McpAuthorization>;
}

export type McpAccessErrorCode =
  | "policy_unavailable"
  | "invalid_policy"
  | "invalid_session"
  | "revoked_session"
  | "invalid_role"
  | "missing_capability"
  | "invalid_input";

export class McpAccessError extends Error {
  constructor(readonly code: McpAccessErrorCode, message: string) {
    super(message);
    this.name = "McpAccessError";
  }
}

export function isCapability(value: unknown): value is McpAgentCapability {
  return typeof value === "string" && (MCP_AGENT_CAPABILITIES as readonly string[]).includes(value);
}

export function findRole(roleId: string): McpAgentRole | undefined {
  return BUILT_IN_MCP_ROLES.find((role) => role.id === roleId);
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function publicSession(session: McpAgentSessionRecord): McpAgentSession {
  return {
    id: session.id,
    name: session.name,
    roleId: session.roleId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    revokedAt: session.revokedAt,
    ...(session.oauth ? { oauth: { clientId: session.oauth.clientId, scopes: [...session.oauth.scopes] } } : {}),
  };
}

function parseSession(value: unknown): McpAgentSessionRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new McpAccessError("invalid_policy", "policy contains an invalid session");
  }
  const session = value as Partial<McpAgentSessionRecord>;
  if (
    typeof session.id !== "string" || !ID_PATTERN.test(session.id) ||
    typeof session.name !== "string" || session.name.trim().length === 0 || session.name.length > 200 ||
    typeof session.roleId !== "string" || !ID_PATTERN.test(session.roleId) ||
    typeof session.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(session.tokenHash) ||
    typeof session.createdAt !== "string" ||
    typeof session.updatedAt !== "string" ||
    !(session.revokedAt === null || typeof session.revokedAt === "string")
  ) {
    throw new McpAccessError("invalid_policy", "policy contains an invalid session");
  }
  if (session.oauth !== undefined && (
    session.oauth === null || typeof session.oauth !== "object" ||
    typeof session.oauth.clientId !== "string" || !ID_PATTERN.test(session.oauth.clientId) ||
    !Array.isArray(session.oauth.scopes) || !session.oauth.scopes.every(isCapability)
  )) {
    throw new McpAccessError("invalid_policy", "invalid OAuth session binding");
  }
  return session as McpAgentSessionRecord;
}

function parsePolicy(value: unknown): McpPolicyFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new McpAccessError("invalid_policy", "MCP policy must be a JSON object");
  }
  const input = value as Partial<McpPolicyFile>;
  if (
    input.protocol !== MCP_POLICY_PROTOCOL ||
    input.version !== MCP_POLICY_VERSION ||
    !Array.isArray(input.sessions) ||
    input.sessions.length > MAX_SESSIONS
  ) {
    throw new McpAccessError("invalid_policy", "MCP policy protocol, version, or session limit is invalid");
  }
  const sessions = input.sessions.map(parseSession);
  if (new Set(sessions.map((session) => session.id)).size !== sessions.length) {
    throw new McpAccessError("invalid_policy", "MCP policy contains duplicate session ids");
  }
  return { protocol: MCP_POLICY_PROTOCOL, version: MCP_POLICY_VERSION, sessions };
}

function emptyPolicy(): McpPolicyFile {
  return { protocol: MCP_POLICY_PROTOCOL, version: MCP_POLICY_VERSION, sessions: [] };
}

export class McpPolicyStore {
  constructor(
    readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  sessions(): McpAgentSession[] {
    return this.read().sessions.map(publicSession);
  }

  createSession(
    nameInput: string,
    roleId: string,
    oauth: { clientId: string; scopes: McpAgentCapability[] },
  ): { session: McpAgentSession; token: string } {
    const policy = this.read();
    const name = nameInput.trim();
    if (name.length === 0 || name.length > 200) {
      throw new McpAccessError("invalid_input", "session name must contain 1 to 200 characters");
    }
    if (!findRole(roleId)) {
      throw new McpAccessError("invalid_input", "selected role does not exist");
    }
    // Keep revoked history, but never let it crowd out new approvals.
    if (policy.sessions.length >= MAX_SESSIONS) {
      const revokedIndex = policy.sessions.findIndex((session) => session.revokedAt !== null);
      if (revokedIndex < 0) throw new McpAccessError("invalid_input", `session limit reached (${MAX_SESSIONS})`);
      policy.sessions.splice(revokedIndex, 1);
    }
    const timestamp = this.now().toISOString();
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const record: McpAgentSessionRecord = {
      id: `session_${randomUUID()}`,
      name,
      roleId,
      tokenHash: tokenHash(token).toString("hex"),
      createdAt: timestamp,
      updatedAt: timestamp,
      revokedAt: null,
      oauth: { clientId: oauth.clientId, scopes: [...oauth.scopes] },
    };
    policy.sessions.push(record);
    this.write(policy);
    return { session: publicSession(record), token };
  }

  revokeSession(id: string): McpAgentSession {
    const policy = this.read();
    const session = policy.sessions.find((candidate) => candidate.id === id);
    if (!session) throw new McpAccessError("invalid_input", "session does not exist");
    const timestamp = this.now().toISOString();
    session.revokedAt ??= timestamp;
    session.updatedAt = timestamp;
    this.write(policy);
    return publicSession(session);
  }

  assignRole(sessionId: string, roleId: string): McpAgentSession {
    const policy = this.read();
    const session = policy.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new McpAccessError("invalid_input", "session does not exist");
    if (!findRole(roleId)) throw new McpAccessError("invalid_input", "selected role does not exist");
    session.roleId = roleId;
    session.updatedAt = this.now().toISOString();
    this.write(policy);
    return publicSession(session);
  }

  /** Drop revoked sessions from the file entirely. */
  forgetRevoked(): number {
    const policy = this.read();
    const before = policy.sessions.length;
    policy.sessions = policy.sessions.filter((session) => session.revokedAt === null);
    if (policy.sessions.length !== before) this.write(policy);
    return before - policy.sessions.length;
  }

  authorize(token: string, required: readonly McpAgentCapability[] = []): McpAuthorization {
    const policy = this.read();
    const supplied = tokenHash(token);
    const session = policy.sessions.find((candidate) => {
      const stored = Buffer.from(candidate.tokenHash, "hex");
      return stored.length === supplied.length && timingSafeEqual(stored, supplied);
    });
    if (!session) throw new McpAccessError("invalid_session", "MCP session token is invalid");
    if (session.revokedAt !== null) throw new McpAccessError("revoked_session", "MCP session has been revoked");
    const role = findRole(session.roleId);
    if (!role) throw new McpAccessError("invalid_role", "MCP session has no valid role");
    const permissions = role.permissions.filter((capability) =>
      session.oauth === undefined || session.oauth.scopes.includes(capability),
    );
    const missing = required.filter((capability) => !permissions.includes(capability));
    if (missing.length > 0) {
      throw new McpAccessError(
        "missing_capability",
        `This DiskHound Session (${role.name}) does not grant: ${missing.join(", ")}. ` +
          "The user can change the Session's role in DiskHound → Settings → AI Agents.",
      );
    }
    return {
      sessionId: session.id,
      sessionName: session.name,
      roleId: role.id,
      roleName: role.name,
      capabilities: [...permissions],
    };
  }

  private read(): McpPolicyFile {
    let contents: string;
    try {
      contents = readFileSync(this.filePath, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return emptyPolicy();
      throw new McpAccessError("policy_unavailable", `MCP policy is unavailable at ${this.filePath}`);
    }
    try {
      return parsePolicy(JSON.parse(contents) as unknown);
    } catch (cause) {
      if (cause instanceof McpAccessError) throw cause;
      throw new McpAccessError("invalid_policy", "MCP policy is not valid JSON");
    }
  }

  private write(policy: McpPolicyFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(policy, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.filePath);
    if (process.platform !== "win32") chmodSync(this.filePath, 0o600);
  }

  exists(): boolean {
    return existsSync(this.filePath);
  }
}

/** Authorizer bound to one bearer token; used per MCP request. */
export class PolicyFileAuthorizer implements McpAuthorizer {
  constructor(private readonly store: McpPolicyStore, private readonly token: string) {}

  async authorize(capabilities: readonly McpAgentCapability[] = []): Promise<McpAuthorization> {
    return this.store.authorize(this.token, capabilities);
  }
}

/** Fixed authorization for tests and trusted in-process embedders. */
export class FixedMcpAuthorizer implements McpAuthorizer {
  constructor(private readonly authorization: McpAuthorization) {}

  async authorize(capabilities: readonly McpAgentCapability[] = []): Promise<McpAuthorization> {
    const missing = capabilities.filter((capability) => !this.authorization.capabilities.includes(capability));
    if (missing.length > 0) {
      throw new McpAccessError("missing_capability", `MCP role does not grant: ${missing.join(", ")}`);
    }
    return this.authorization;
  }
}
