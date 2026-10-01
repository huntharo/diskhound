import { describe, expect, it } from "vitest";

import { AGENT_ACCESS_PORT, agentClientGuides, agentSetupPrompt } from "../agentAccess";

const helper = "/Applications/DiskHound.app/Contents/Resources/native/diskhound-mcp";
const guide = (id: string, port = AGENT_ACCESS_PORT, platform = "darwin") =>
  agentClientGuides(port, helper, platform).find((candidate) => candidate.id === id)!;

describe("agentClientGuides", () => {
  it("asks each agent to add DiskHound to its own user configuration", () => {
    expect(guide("claude-code").steps[0]!.prompt).toBe(
      `Add diskhound to my Claude Code user configuration using the stdio executable "${helper}", with no arguments. `
      + "Preserve my other MCP servers, then help me connect and approve access in DiskHound.",
    );
    expect(guide("codex").steps[0]!.prompt).toBe(
      "Add diskhound to my Codex user configuration using the HTTP MCP endpoint http://127.0.0.1:51735/mcp with OAuth. "
      + "Preserve my other MCP servers, then help me connect and approve access in DiskHound.",
    );
    expect(guide("other").steps[0]!.prompt).toContain("Add diskhound to this agent's user configuration");
    expect(agentSetupPrompt(AGENT_ACCESS_PORT, helper)).toBe(
      `Set up diskhound as a user-level MCP server for this agent. For Claude, use the stdio executable "${helper}" with no arguments. `
      + "For other clients, use the HTTP MCP endpoint http://127.0.0.1:51735/mcp with OAuth. "
      + "Preserve my other MCP servers, then help me connect and approve access in DiskHound.",
    );
  });

  it("keeps the command for doing it by hand behind a Show button", () => {
    const code = guide("claude-code").steps[0]!.manual!;
    expect(code.toggle).toBe("command");
    expect(code.items[0]!.snippet).toBe(`claude mcp add --scope user --transport stdio diskhound -- '${helper}'`);
    expect(guide("codex").steps[0]!.manual!.items[0]!.snippet)
      .toBe("codex mcp add diskhound --url http://127.0.0.1:51735/mcp --oauth-client-registration dcr");
  });

  it("adds Claude Desktop with its own install dialog, where Claude Desktop exists", () => {
    // Its chat can't run commands, so there's no prompt to paste, and
    // nothing to merge into Claude's config by hand.
    for (const platform of ["darwin", "win32"]) {
      const desktop = guide("claude-desktop", AGENT_ACCESS_PORT, platform);
      expect(desktop.steps.map((step) => step.action ?? null)).toEqual(["add-to-claude", null]);
      expect(desktop.steps.some((step) => step.prompt || step.manual)).toBe(false);
      expect(desktop.note).toBe("The extension works in the Claude app's chats and its Code sessions.");
      // Both would give the app's Code sessions two DiskHounds.
      expect(guide("claude-code", AGENT_ACCESS_PORT, platform).note).toContain("use the Claude Desktop extension instead");
    }
    expect(guide("claude-code", AGENT_ACCESS_PORT, "linux").note).toBeUndefined();
    expect(agentClientGuides(AGENT_ACCESS_PORT, helper, "linux").map((candidate) => candidate.id))
      .toEqual(["claude-code", "codex", "other"]);
  });

  it("passes a non-default port everywhere", () => {
    expect(guide("claude-code", 51999).steps[0]!.prompt).toContain("with the arguments --port 51999");
    expect(guide("claude-code", 51999).steps[0]!.manual!.items[0]!.snippet).toMatch(/ --port 51999$/);
    expect(guide("codex", 51999).steps[0]!.prompt).toContain("http://127.0.0.1:51999/mcp");
    expect(agentSetupPrompt(51999, helper)).toContain("with the arguments --port 51999");
  });
});
