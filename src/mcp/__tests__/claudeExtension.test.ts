import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { unzip } from "../../test/zipReader";
import { writeClaudeExtension, zip } from "../claudeExtension";

const dirs: string[] = [];
const scratch = () => {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "dh-claude-ext-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) FS.rmSync(dir, { recursive: true, force: true });
});

describe("Claude extension", () => {
  it("bundles the helper as an executable, with a manifest Claude can install", async () => {
    const dir = scratch();
    const helper = Path.join(dir, "diskhound-mcp");
    const icon = Path.join(dir, "icon.png");
    // Compressible like a real binary, and big enough to span deflate blocks.
    FS.writeFileSync(helper, Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7) % 251)));
    FS.writeFileSync(icon, Buffer.from("png"));
    const file = Path.join(dir, "out", "DiskHound.mcpb");

    await writeClaudeExtension(file, { helperPath: helper, iconPath: icon, version: "0.6.4", port: 51735, platform: "darwin" });

    const entries = unzip(FS.readFileSync(file));
    expect(entries.map((entry) => [entry.name, entry.mode.toString(8)])).toEqual([
      ["manifest.json", "644"],
      ["icon.png", "644"],
      ["server/diskhound-mcp", "755"],
    ]);
    expect(entries[2]!.data.equals(FS.readFileSync(helper))).toBe(true);
    expect(JSON.parse(entries[0]!.data.toString("utf8"))).toMatchObject({
      manifest_version: "0.2",
      name: "diskhound",
      display_name: "DiskHound",
      version: "0.6.4",
      icon: "icon.png",
      server: {
        type: "binary",
        entry_point: "server/diskhound-mcp",
        mcp_config: { command: "${__dirname}/server/diskhound-mcp", args: [] },
      },
      tools_generated: true,
      compatibility: { platforms: ["darwin"] },
    });
  });

  it("names the Windows helper .exe, passes a non-default port, and skips a missing icon", async () => {
    const dir = scratch();
    const helper = Path.join(dir, "diskhound-mcp.exe");
    FS.writeFileSync(helper, "MZ");
    const file = Path.join(dir, "DiskHound.mcpb");

    await writeClaudeExtension(file, { helperPath: helper, iconPath: Path.join(dir, "missing.png"), version: "1.2.3-beta.4", port: 51999, platform: "win32" });

    const entries = unzip(FS.readFileSync(file));
    expect(entries.map((entry) => entry.name)).toEqual(["manifest.json", "server/diskhound-mcp.exe"]);
    const manifest = JSON.parse(entries[0]!.data.toString("utf8"));
    expect(manifest.icon).toBeUndefined();
    expect(manifest.server.mcp_config).toEqual({ command: "${__dirname}/server/diskhound-mcp.exe", args: ["--port", "51999"], env: {} });
  });

  it("fails without writing anything when the helper is missing", async () => {
    const dir = scratch();
    const file = Path.join(dir, "out", "DiskHound.mcpb");
    await expect(writeClaudeExtension(file, { helperPath: Path.join(dir, "nope"), iconPath: null, version: "0.6.4", port: 51735, platform: "darwin" }))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(FS.existsSync(Path.join(dir, "out"))).toBe(false);
  });

  it("writes an empty entry and UTF-8 names", async () => {
    const entries = unzip(await zip([{ name: "é/empty", data: Buffer.alloc(0), mode: 0o600 }]));
    expect(entries).toEqual([{ name: "é/empty", data: Buffer.alloc(0), mode: 0o600 }]);
  });
});
