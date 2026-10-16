/**
 * Entry point for the lazily loaded half of agent access. Built as its
 * own bundle (dist-electron/mcp/agentRuntime.cjs, see tsdown.config.ts)
 * so the MCP SDK, Express, and zod are required only when the user
 * turns AI Agents on — not on every DiskHound launch.
 */
export { AgentAccessService } from "./agentAccessService";
export { loadSkillCatalog } from "./skills";
