import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
// Exercise the installed provider with an executor that cannot open a socket.
const { GitHubProvider } = require("electron-updater/out/providers/GitHubProvider");
const { parse } = require("semver");
const { HttpError } = require("builder-util-runtime");

it.each([
  ["0.6.2", false, false, 3],
  ["0.6.4", false, false, 3],
  ["0.6.4", true, false, 2],
  ["0.6.5-beta.1", true, false, 2],
  ["0.6.5-beta.1", true, true, 3],
] as const)("counts public release requests: version=%s beta=%s fallback=%s", async (version, beta, fallback, count) => {
  const paths: string[] = [];
  const headers: Record<string, string>[] = [];
  const provider = new GitHubProvider({ owner: "tzarebczan", repo: "diskhound", provider: "github" },
    { allowPrerelease: beta, currentVersion: parse(version), fullChangelog: false }, {
      platform: "darwin",
      executor: { request: async (options: { hostname: string; path: string; headers?: Record<string, string> }) => {
        paths.push(`https://${options.hostname}${options.path}`);
        headers.push(options.headers ?? {});
        expect(options.hostname).toBe("github.com");
        if (options.path.endsWith(".atom")) return `<feed><entry><title>Beta</title><link href="https://github.com/tzarebczan/diskhound/releases/tag/v0.6.5-beta.2"/><content>Beta notes</content></entry><entry><title>Stable</title><link href="https://github.com/tzarebczan/diskhound/releases/tag/v0.6.4"/><content>Stable notes</content></entry></feed>`;
        if (options.path.endsWith("/latest")) return JSON.stringify({ tag_name: "v0.6.4" });
        if (fallback && options.path.endsWith("beta-mac.yml")) throw new HttpError(404, "missing beta metadata");
        return "version: 0.6.5\nfiles:\n  - url: DiskHound-universal.zip\n    sha512: test\n    size: 100\n";
      } },
    });
  await provider.getLatestVersion();
  expect(paths).toHaveLength(count);
  expect(paths[0]).toBe("https://github.com/tzarebczan/diskhound/releases.atom");
  if (!beta) expect(paths[1]).toBe("https://github.com/tzarebczan/diskhound/releases/latest");
  expect(paths.at(-1)).toContain(`/releases/download/${beta ? "v0.6.5-beta.2" : "v0.6.4"}/${beta && !fallback ? "beta" : "latest"}-mac.yml`);
  expect(headers.every(h => !("If-None-Match" in h) && !("If-Modified-Since" in h))).toBe(true);
});
