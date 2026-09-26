import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as Path from "node:path";

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { SKILLS_EXTENSION_ID } from "../shared/agentAccess";

/**
 * Agent Skills served over MCP per SEP-2640 ("Skills Extension").
 *
 * Skills are plain directories under `<repo>/skills/<name>/` with a
 * `SKILL.md` at the root (agentskills.io format). At startup we read
 * every file once, compute its SHA-256, and expose it three ways:
 *
 *   - as a resource at `skill://<name>/<relative path>` (resources/read),
 *   - through `skills/list` / `skills/get`, which return each skill's
 *     verbatim frontmatter plus a complete `{uri, digest, size}`
 *     manifest so hosts can verify what they load,
 *   - through `resources/directory/read`, so a SKILL.md that says "see
 *     references/" can be navigated without enumerating the server.
 *
 * Content is static for the life of the process, so digests are stable
 * and `resources` is always the enumerated array form (never "dynamic").
 */

export interface SkillFile {
  uri: string;
  relativePath: string;
  mimeType: string;
  text: string;
  size: number;
  digest: string;
}

export interface SkillEntry {
  name: string;
  /** `skill://<name>/SKILL.md` */
  uri: string;
  /** `skill://<name>` — the skill's root directory resource. */
  rootUri: string;
  frontmatter: Record<string, string>;
  files: SkillFile[];
}

export interface SkillCatalog {
  skills: SkillEntry[];
}

interface DirectoryChild {
  uri: string;
  name: string;
  mimeType: string;
  description?: string;
}

// agentskills.io: 1–64 chars, lowercase alnum + single hyphens.
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_FILES_PER_SKILL = 512;
const MAX_BYTES_PER_SKILL = 16 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".sh": "text/x-shellscript",
  ".ps1": "text/plain",
};

/**
 * Parse the flat `key: value` YAML frontmatter our skills use. This is
 * deliberately not a general YAML parser: anything beyond flat scalars
 * throws, and the catalog test runs every bundled skill through it, so
 * an unsupported construct fails CI instead of shipping a skill whose
 * `frontmatter` isn't a verbatim copy of what's on disk.
 */
export function parseSkillFrontmatter(markdown: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error("SKILL.md must begin with YAML frontmatter");
  const fields: Record<string, string> = {};
  for (const rawLine of match[1]!.split(/\r?\n/)) {
    if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) continue;
    const line = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(rawLine);
    if (!line) throw new Error(`Unsupported frontmatter line: ${rawLine}`);
    const key = line[1]!;
    let value = line[2]!.trim();
    if (value === "" || value === "|" || value === ">" || value.startsWith("|") || value.startsWith(">")) {
      throw new Error(`Frontmatter field "${key}" must be a single-line scalar`);
    }
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key in fields) throw new Error(`Duplicate frontmatter field "${key}"`);
    fields[key] = value;
  }
  return fields;
}

function listFiles(directory: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = Path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

export function loadSkillCatalog(skillsRoot: string): SkillCatalog {
  let names: string[];
  try {
    names = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { skills: [] };
  }

  const skills: SkillEntry[] = [];
  for (const directoryName of names) {
    const directory = Path.join(skillsRoot, directoryName);
    try {
      statSync(Path.join(directory, "SKILL.md"));
    } catch {
      continue;
    }
    const skillMd = readFileSync(Path.join(directory, "SKILL.md"), "utf8");
    const frontmatter = parseSkillFrontmatter(skillMd);
    const name = frontmatter.name;
    const description = frontmatter.description;
    if (!name || !SKILL_NAME.test(name) || name.length > 64) {
      throw new Error(`Skill ${directoryName}: name must be 1-64 lowercase letters, digits, and single hyphens`);
    }
    if (name !== directoryName) {
      throw new Error(`Skill ${directoryName}: frontmatter name "${name}" must match its directory`);
    }
    if (!description || description.length > 1024) {
      throw new Error(`Skill ${name}: description is required and must be at most 1024 characters`);
    }

    const files: SkillFile[] = listFiles(directory).map((relativePath) => {
      const bytes = readFileSync(Path.join(directory, ...relativePath.split("/")));
      return {
        uri: `skill://${name}/${relativePath}`,
        relativePath,
        mimeType: MIME_BY_EXTENSION[Path.extname(relativePath).toLowerCase()] ?? "application/octet-stream",
        text: bytes.toString("utf8"),
        size: bytes.byteLength,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      };
    });
    if (files.length > MAX_FILES_PER_SKILL) throw new Error(`Skill ${name}: more than ${MAX_FILES_PER_SKILL} files`);
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_BYTES_PER_SKILL) {
      throw new Error(`Skill ${name}: larger than 16 MiB`);
    }

    skills.push({
      name,
      uri: `skill://${name}/SKILL.md`,
      rootUri: `skill://${name}`,
      frontmatter,
      files,
    });
  }
  return { skills };
}

/** The `skills/list` / `skills/get` entry shape from SEP-2640. */
export function skillListEntry(skill: SkillEntry) {
  return {
    uri: skill.uri,
    frontmatter: { ...skill.frontmatter },
    resources: skill.files.map((file) => ({ uri: file.uri, digest: file.digest, size: file.size })),
  };
}

/**
 * Direct children of a directory resource (`skill://name` or
 * `skill://name/references`). Returns null when the URI isn't a
 * directory we serve.
 */
export function readSkillDirectory(catalog: SkillCatalog, uri: string): DirectoryChild[] | null {
  const trimmed = uri.replace(/\/+$/, "");
  const skill = catalog.skills.find((candidate) => trimmed === candidate.rootUri || trimmed.startsWith(`${candidate.rootUri}/`));
  if (!skill) return null;
  const prefix = trimmed === skill.rootUri ? "" : trimmed.slice(skill.rootUri.length + 1);
  const children = new Map<string, DirectoryChild>();
  let isDirectory = prefix === "";
  for (const file of skill.files) {
    if (prefix && !file.relativePath.startsWith(`${prefix}/`)) continue;
    isDirectory = true;
    const rest = prefix ? file.relativePath.slice(prefix.length + 1) : file.relativePath;
    const [head, ...tail] = rest.split("/");
    if (!head) continue;
    if (tail.length === 0) {
      children.set(head, {
        uri: file.uri,
        name: head,
        mimeType: file.mimeType,
        ...(file.relativePath === "SKILL.md" ? { description: skill.frontmatter.description } : {}),
      });
    } else if (!children.has(head)) {
      children.set(head, {
        uri: `${skill.rootUri}/${prefix ? `${prefix}/` : ""}${head}`,
        name: head,
        mimeType: "inode/directory",
      });
    }
  }
  return isDirectory ? [...children.values()] : null;
}

const SkillsListRequestSchema = z.object({
  method: z.literal("skills/list"),
  params: z.object({ cursor: z.string().optional() }).passthrough().optional(),
});
const SkillsGetRequestSchema = z.object({
  method: z.literal("skills/get"),
  params: z.object({ uri: z.string() }).passthrough(),
});
const DirectoryReadRequestSchema = z.object({
  method: z.literal("resources/directory/read"),
  params: z.object({ uri: z.string(), cursor: z.string().optional() }).passthrough(),
});

/**
 * Declare the extension and wire its three methods plus one resource
 * per skill file. Must run before `connect()` — capabilities are fixed
 * at initialize time.
 */
export function registerSkills(mcp: McpServer, catalog: SkillCatalog): void {
  // Nothing to serve: don't advertise resources or the skills extension.
  if (catalog.skills.length === 0) return;
  mcp.server.registerCapabilities({
    resources: {},
    extensions: { [SKILLS_EXTENSION_ID]: { directoryRead: true } },
  });

  for (const skill of catalog.skills) {
    for (const file of skill.files) {
      const isSkillMd = file.relativePath === "SKILL.md";
      mcp.registerResource(
        isSkillMd ? skill.name : `${skill.name}/${file.relativePath}`,
        file.uri,
        {
          mimeType: file.mimeType,
          ...(isSkillMd
            ? { title: `Skill: ${skill.name}`, description: skill.frontmatter.description }
            : { description: `Supporting file for the ${skill.name} skill.` }),
        },
        async () => ({ contents: [{ uri: file.uri, mimeType: file.mimeType, text: file.text }] }),
      );
    }
  }

  mcp.server.setRequestHandler(SkillsListRequestSchema, async () => ({
    resultType: "complete",
    skills: catalog.skills.map(skillListEntry),
  }));

  mcp.server.setRequestHandler(SkillsGetRequestSchema, async (request) => {
    const skill = catalog.skills.find((candidate) => candidate.uri === request.params.uri);
    if (!skill) throw new McpError(ErrorCode.InvalidParams, `Unknown skill: ${request.params.uri}`);
    return { resultType: "complete", skill: skillListEntry(skill) };
  });

  mcp.server.setRequestHandler(DirectoryReadRequestSchema, async (request) => {
    const children = readSkillDirectory(catalog, request.params.uri);
    if (!children) throw new McpError(ErrorCode.InvalidParams, `Not a directory resource: ${request.params.uri}`);
    return { resultType: "complete", resources: children };
  });
}
