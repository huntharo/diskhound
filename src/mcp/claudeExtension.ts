import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { promisify } from "node:util";
import * as Zlib from "node:zlib";

import { AGENT_ACCESS_PORT, MCP_SERVER_NAME } from "../shared/agentAccess";

const deflateRaw = promisify(Zlib.deflateRaw);

/**
 * Claude Desktop adds local MCP servers from MCP Bundles (.mcpb,
 * https://github.com/modelcontextprotocol/mcpb): a zip holding a
 * manifest.json and the server. Opening one in Claude shows Claude's own
 * install dialog, so DiskHound never edits Claude's configuration.
 *
 * The bundle carries a copy of the stdio helper, which Claude runs from
 * its extensions folder. DiskHound builds it from its own helper when the
 * user asks, so the copy matches the app that made it.
 */
export function claudeExtensionManifest(version: string, port: number, platform: NodeJS.Platform, icon: boolean) {
  const binary = platform === "win32" ? "diskhound-mcp.exe" : "diskhound-mcp";
  return {
    manifest_version: "0.2",
    name: MCP_SERVER_NAME,
    display_name: "DiskHound",
    version,
    description: "Let Claude see what is using your disk and help clean it up, with DiskHound open alongside.",
    long_description: "Connects Claude to the DiskHound app on this computer. DiskHound asks you to approve the connection, "
      + "and the role you choose there decides what Claude can do: read scan results, run scans, or move files to the Trash. "
      + "DiskHound must be running with Settings > AI Agents turned on.",
    author: { name: "DiskHound" },
    homepage: "https://github.com/tzarebczan/diskhound",
    ...(icon ? { icon: "icon.png" } : {}),
    server: {
      type: "binary",
      entry_point: `server/${binary}`,
      mcp_config: {
        command: `\${__dirname}/server/${binary}`,
        args: port === AGENT_ACCESS_PORT ? [] : ["--port", String(port)],
        env: {},
      },
    },
    // The tools depend on the role the user grants, after approval.
    tools_generated: true,
    compatibility: { platforms: [platform] },
    license: "MIT",
  };
}

export interface ZipEntry {
  name: string;
  data: Buffer;
  /** Unix mode bits, so the helper stays executable once Claude unpacks it. */
  mode: number;
}

/** A deflated zip, without zip64: a bundle is a few MB. */
export async function zip(entries: readonly ZipEntry[], at = new Date()): Promise<Buffer> {
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1);
  const date = ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = await deflateRaw(entry.data);
    const crc = Zlib.crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: deflate
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so unzip honors the mode
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((0o100000 | entry.mode) << 16) >>> 0, 38); // regular file + mode
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export interface ClaudeExtensionSource {
  helperPath: string;
  iconPath: string | null;
  version: string;
  port: number;
  platform: NodeJS.Platform;
}

/** Build DiskHound's Claude extension from its own helper and write it to `file`. */
export async function writeClaudeExtension(file: string, source: ClaudeExtensionSource): Promise<void> {
  const [helper, icon] = await Promise.all([
    FS.readFile(source.helperPath),
    source.iconPath ? FS.readFile(source.iconPath).catch(() => null) : null,
  ]);
  const manifest = claudeExtensionManifest(source.version, source.port, source.platform, icon !== null);
  const bundle = await zip([
    { name: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), mode: 0o644 },
    ...(icon ? [{ name: "icon.png", data: icon, mode: 0o644 }] : []),
    { name: manifest.server.entry_point, data: helper, mode: 0o755 },
  ]);
  await FS.mkdir(Path.dirname(file), { recursive: true });
  await FS.writeFile(file, bundle);
}
