import { createHash } from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FREE_UP_SPACE_SKILL, INVESTIGATE_GROWTH_SKILL } from "../server";
import {
  loadSkillCatalog,
  parseSkillFrontmatter,
  readSkillDirectory,
  skillListEntry,
  type SkillCatalog,
} from "../skills";
import { SERVER_SOURCE, SKILLS_DIR } from "./fakeBackend";

/** GitHub-style heading anchor: lowercase, drop punctuation, spaces → hyphens. */
function headingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

function headingSlugs(markdown: string): Set<string> {
  return new Set(
    markdown
      .split(/\r?\n/)
      .map((line) => /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1])
      .filter((heading): heading is string => heading !== undefined)
      .map(headingSlug),
  );
}

/** Every `skill://…` mention in a text, minus any `#fragment` and trailing prose punctuation. */
function skillUris(text: string): string[] {
  return [...text.matchAll(/skill:\/\/[A-Za-z0-9._\/#-]+/g)]
    .map((match) => match[0].replace(/[.,;:]+$/, "").split("#")[0]!)
    .filter((uri) => !uri.includes("…/"));
}

describe("bundled skill catalog", () => {
  const catalog = loadSkillCatalog(SKILLS_DIR);
  const fileUris = new Set(catalog.skills.flatMap((skill) => skill.files.map((file) => file.uri)));

  it("loads every skill directory, named after its directory", () => {
    const directories = FS.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
    expect(directories).toEqual(["diskhound-free-up-space", "diskhound-investigate-growth"]);
    expect(catalog.skills.map((skill) => skill.name)).toEqual(directories);
    for (const skill of catalog.skills) {
      expect(skill.frontmatter.name).toBe(skill.name);
      expect(skill.uri).toBe(`skill://${skill.name}/SKILL.md`);
      expect(skill.rootUri).toBe(`skill://${skill.name}`);
      expect(skill.files.some((file) => file.relativePath === "SKILL.md")).toBe(true);
    }
  });

  it("gives every skill a description of at most 1024 characters", () => {
    for (const skill of catalog.skills) {
      const description = skill.frontmatter.description ?? "";
      expect(description.length, skill.name).toBeGreaterThan(0);
      expect(description.length, skill.name).toBeLessThanOrEqual(1024);
    }
  });

  it("serves exactly the files on disk, with URIs, sizes, and sha256 digests matching their bytes", () => {
    const freeUp = catalog.skills.find((skill) => skill.name === "diskhound-free-up-space")!;
    // Order comes from localeCompare, so compare as a sorted list.
    expect(freeUp.files.map((file) => file.relativePath).sort()).toEqual([
      "SKILL.md",
      "references/developer-caches.md",
      "references/linux.md",
      "references/macos.md",
      "references/windows.md",
    ]);
    for (const skill of catalog.skills) {
      for (const file of skill.files) {
        const bytes = FS.readFileSync(Path.join(SKILLS_DIR, skill.name, ...file.relativePath.split("/")));
        expect(file.uri).toBe(`skill://${skill.name}/${file.relativePath}`);
        expect(file.size).toBe(bytes.byteLength);
        expect(file.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(file.digest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
        expect(file.text).toBe(bytes.toString("utf8"));
        expect(file.mimeType).toBe("text/markdown");
      }
    }
  });

  it("has no broken relative markdown links (including #anchors)", () => {
    const problems: string[] = [];
    for (const skill of catalog.skills) {
      const byPath = new Map(skill.files.map((file) => [file.relativePath, file]));
      for (const file of skill.files) {
        for (const match of file.text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
          const target = match[1]!;
          if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
          const [targetPath, fragment] = target.split("#") as [string, string | undefined];
          const resolved = Path.posix.normalize(Path.posix.join(Path.posix.dirname(file.relativePath), targetPath));
          const linked = byPath.get(resolved);
          if (!linked) {
            problems.push(`${skill.name}/${file.relativePath}: ${target} → ${resolved} (missing)`);
            continue;
          }
          if (fragment && !headingSlugs(linked.text).has(fragment)) {
            problems.push(`${skill.name}/${file.relativePath}: ${target} (no heading #${fragment})`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("resolves every skill:// URI mentioned in the skills and in server.ts", () => {
    const directoryUris = new Set(
      catalog.skills.flatMap((skill) => [
        skill.rootUri,
        ...skill.files
          .map((file) => file.relativePath.split("/").slice(0, -1))
          .filter((parts) => parts.length > 0)
          .map((parts) => `${skill.rootUri}/${parts.join("/")}`),
      ]),
    );
    const sources = [
      ...catalog.skills.flatMap((skill) => skill.files.map((file) => ({ where: file.uri, text: file.text }))),
      { where: "src/mcp/server.ts", text: FS.readFileSync(SERVER_SOURCE, "utf8") },
    ];
    const mentioned = sources.flatMap(({ where, text }) => skillUris(text).map((uri) => ({ where, uri })));
    // Sanity: the scan actually finds the mentions we know exist.
    expect(mentioned.some(({ uri }) => uri === "skill://diskhound-free-up-space/references/macos.md")).toBe(true);
    expect(mentioned.some(({ where }) => where === "src/mcp/server.ts")).toBe(true);

    const unresolved = mentioned.filter(({ uri }) => !fileUris.has(uri) && !directoryUris.has(uri.replace(/\/+$/, "")));
    expect(unresolved).toEqual([]);

    expect(fileUris.has(FREE_UP_SPACE_SKILL)).toBe(true);
    expect(fileUris.has(INVESTIGATE_GROWTH_SKILL)).toBe(true);
  });

  it("lists each skill with its verbatim frontmatter and a full resource manifest", () => {
    for (const skill of catalog.skills) {
      const entry = skillListEntry(skill);
      expect(entry.uri).toBe(skill.uri);
      expect(entry.frontmatter).toEqual(skill.frontmatter);
      expect(entry.frontmatter).not.toBe(skill.frontmatter);
      expect(entry.resources).toEqual(skill.files.map((file) => ({ uri: file.uri, digest: file.digest, size: file.size })));
    }
  });

  it("navigates skill directories", () => {
    const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    expect(readSkillDirectory(catalog, "skill://diskhound-free-up-space")?.sort(byName)).toEqual([
      {
        uri: "skill://diskhound-free-up-space/SKILL.md",
        name: "SKILL.md",
        mimeType: "text/markdown",
        description: catalog.skills[0]!.frontmatter.description,
      },
      { uri: "skill://diskhound-free-up-space/references", name: "references", mimeType: "inode/directory" },
    ]);
    const references = readSkillDirectory(catalog, "skill://diskhound-free-up-space/references/");
    expect(references?.map((child) => child.uri).sort()).toEqual([
      "skill://diskhound-free-up-space/references/developer-caches.md",
      "skill://diskhound-free-up-space/references/linux.md",
      "skill://diskhound-free-up-space/references/macos.md",
      "skill://diskhound-free-up-space/references/windows.md",
    ]);
    expect(references?.every((child) => child.description === undefined)).toBe(true);

    expect(readSkillDirectory(catalog, "skill://diskhound-free-up-space/SKILL.md")).toBeNull();
    expect(readSkillDirectory(catalog, "skill://diskhound-free-up-space/refer")).toBeNull();
    expect(readSkillDirectory(catalog, "skill://diskhound-free-up")).toBeNull();
    expect(readSkillDirectory(catalog, "skill://nope")).toBeNull();
    expect(readSkillDirectory(catalog, "file:///etc")).toBeNull();
  });
});

describe("parseSkillFrontmatter", () => {
  it("parses flat key: value pairs and strips matching quotes", () => {
    const markdown = [
      "---",
      "name: my-skill",
      'description: "Does things: carefully"',
      "license: 'MIT'",
      "# a comment",
      "",
      "compatibility: Needs: the app",
      "---",
      "# Body",
    ].join("\n");
    expect(parseSkillFrontmatter(markdown)).toEqual({
      name: "my-skill",
      description: "Does things: carefully",
      license: "MIT",
      compatibility: "Needs: the app",
    });
  });

  it("accepts CRLF line endings", () => {
    expect(parseSkillFrontmatter("---\r\nname: crlf\r\ndescription: ok\r\n---\r\nBody")).toEqual({
      name: "crlf",
      description: "ok",
    });
  });

  it("rejects anything that is not flat single-line scalars", () => {
    expect(() => parseSkillFrontmatter("# No frontmatter")).toThrow(/must begin with YAML frontmatter/);
    expect(() => parseSkillFrontmatter("---\nname: a\ndescription: |\n  multi\n---\n")).toThrow();
    expect(() => parseSkillFrontmatter("---\nname: a\ndescription: >-\n---\n")).toThrow(/single-line scalar/);
    expect(() => parseSkillFrontmatter("---\nname: a\ndescription:\n---\n")).toThrow(/single-line scalar/);
    expect(() => parseSkillFrontmatter("---\nname: a\nname: b\n---\n")).toThrow(/Duplicate frontmatter field/);
    expect(() => parseSkillFrontmatter("---\nname: a\n  - list\n---\n")).toThrow(/Unsupported frontmatter line/);
  });
});

describe("loadSkillCatalog fixtures", () => {
  let root: string;

  beforeEach(() => {
    root = FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-skills-test-"));
  });

  afterEach(() => {
    FS.rmSync(root, { recursive: true, force: true });
  });

  function writeSkill(directory: string, files: Record<string, string>): void {
    for (const [relative, text] of Object.entries(files)) {
      const target = Path.join(root, directory, ...relative.split("/"));
      FS.mkdirSync(Path.dirname(target), { recursive: true });
      FS.writeFileSync(target, text);
    }
  }

  const skillMd = (name: string, description = "A test skill.") =>
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`;

  it("returns an empty catalog when the skills directory does not exist", () => {
    expect(loadSkillCatalog(Path.join(root, "missing"))).toEqual({ skills: [] });
  });

  it("loads nested files and skips dotfiles and directories without SKILL.md", () => {
    writeSkill("alpha", {
      "SKILL.md": skillMd("alpha"),
      "scripts/run.sh": "echo hi\n",
      "references/b.md": "# B\n",
      "references/a.md": "# A\n",
      "data.json": "{}",
      "blob.bin": "\u0000",
      ".DS_Store": "junk",
    });
    writeSkill("not-a-skill", { "README.md": "# nope\n" });
    writeSkill(".hidden", { "SKILL.md": skillMd(".hidden") });

    const catalog: SkillCatalog = loadSkillCatalog(root);
    expect(catalog.skills.map((skill) => skill.name)).toEqual(["alpha"]);
    const files = catalog.skills[0]!.files;
    expect(files.map((file) => [file.relativePath, file.mimeType]).sort()).toEqual([
      ["SKILL.md", "text/markdown"],
      ["blob.bin", "application/octet-stream"],
      ["data.json", "application/json"],
      ["references/a.md", "text/markdown"],
      ["references/b.md", "text/markdown"],
      ["scripts/run.sh", "text/x-shellscript"],
    ]);
  });

  it("rejects a frontmatter name that does not match its directory", () => {
    writeSkill("alpha", { "SKILL.md": skillMd("beta") });
    expect(() => loadSkillCatalog(root)).toThrow(/must match its directory/);
  });

  it("rejects a missing description", () => {
    writeSkill("alpha", { "SKILL.md": "---\nname: alpha\n---\n# alpha\n" });
    expect(() => loadSkillCatalog(root)).toThrow(/description is required/);
  });

  it("rejects a description over 1024 characters", () => {
    writeSkill("alpha", { "SKILL.md": skillMd("alpha", "x".repeat(1025)) });
    expect(() => loadSkillCatalog(root)).toThrow(/at most 1024 characters/);
  });

  it("accepts a description of exactly 1024 characters", () => {
    writeSkill("alpha", { "SKILL.md": skillMd("alpha", "x".repeat(1024)) });
    expect(loadSkillCatalog(root).skills[0]!.frontmatter.description).toHaveLength(1024);
  });

  it("rejects names that are not lowercase-hyphenated", () => {
    writeSkill("Alpha", { "SKILL.md": skillMd("Alpha") });
    expect(() => loadSkillCatalog(root)).toThrow(/lowercase letters, digits, and single hyphens/);
  });

  it("rejects double hyphens and names over 64 characters", () => {
    writeSkill("a--b", { "SKILL.md": skillMd("a--b") });
    expect(() => loadSkillCatalog(root)).toThrow(/single hyphens/);
    FS.rmSync(Path.join(root, "a--b"), { recursive: true });

    const long = "a".repeat(65);
    writeSkill(long, { "SKILL.md": skillMd(long) });
    expect(() => loadSkillCatalog(root)).toThrow(/1-64/);
  });
});
