import { execFile } from "node:child_process";
import type { DockerImage, DockerInventory, DockerUsage } from "../shared/docker";

export type DockerRunner = (args: string[], signal: AbortSignal, pinned?: boolean) => Promise<string>;
export const runDocker: DockerRunner = (args, signal, pinned = false) => new Promise((resolve, reject) => {
  const env = { ...process.env };
  // A pinned local endpoint must never be redirected by the environment/context.
  if (pinned) {
    delete env.DOCKER_CONTEXT;
    delete env.DOCKER_HOST;
    delete env.DOCKER_TLS;
    delete env.DOCKER_TLS_VERIFY;
    delete env.DOCKER_CERT_PATH;
  }
  execFile("docker", args, { env, signal, timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
    if (error) reject(new Error(signal.aborted ? "Docker operation cancelled. Refresh before retrying." :
      error.killed ? "Docker timed out or exceeded the output limit. Refresh before retrying." :
      `Docker unavailable or command failed. Check the CLI and running daemon. ${error.message.slice(0, 500)}`));
    else resolve(stdout);
  });
});

export function isLocalEndpoint(endpoint: string): boolean {
  return /^unix:\/\/\/[^\0\r\n]+$/.test(endpoint) || /^npipe:\/\/(?:\/\/)?\.\/pipe\/[^\0\r\n]+$/.test(endpoint);
}
export const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const field = (value: unknown): string => typeof value === "string" ? value.slice(0, 2048) : "Unknown";
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unsupported Docker inventory response.");
  return value as Record<string, unknown>;
}

// One pass over each collection. No tag-based guesses or pairwise layer accounting.
export function parseImages(value: unknown): DockerImage[] {
  if (!Array.isArray(value) || value.length > 50_000) throw new Error("Unsupported or oversized Docker image inventory.");
  const seen = new Set<string>();
  return value.map((entry) => {
    const item = row(entry);
    const id = field(item.ID);
    if (!IMAGE_ID.test(id) || seen.has(id)) throw new Error("Invalid or duplicate Docker image ID.");
    seen.add(id);
    const count = item.Containers;
    const containers = typeof count === "string" && /^\d+$/.test(count) && Number.isSafeInteger(Number(count)) ? Number(count) : null;
    return { id, name: `${field(item.Repository)}:${field(item.Tag)}`, logicalSize: field(item.Size), sharedSize: field(item.SharedSize), uniqueSize: field(item.UniqueSize), containers, provenance: "unknown" as const };
  });
}
function parseUsage(text: string): DockerUsage[] {
  return text.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const item = row(JSON.parse(line));
    return { type: field(item.Type), total: field(item.TotalCount), active: field(item.Active), size: field(item.Size), reclaimable: field(item.Reclaimable) };
  });
}

export class DockerService {
  private controller: AbortController | null = null;
  private inventory: DockerInventory | null = null;
  constructor(private run: DockerRunner = runDocker, private env: NodeJS.ProcessEnv = process.env) {}
  cancel(): void { this.controller?.abort(); this.inventory = null; }
  private async operation<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.controller) throw new Error("A Docker operation is already running.");
    this.controller = new AbortController();
    try { return await work(this.controller.signal); }
    finally { this.controller = null; }
  }
  private async endpoint(signal: AbortSignal): Promise<{ context: string; endpoint: string }> {
    let context = this.env.DOCKER_CONTEXT;
    if (!context && this.env.DOCKER_HOST) return { context: "DOCKER_HOST", endpoint: this.env.DOCKER_HOST };
    context ||= (await this.run(["context", "show"], signal)).trim();
    if (!context || context.startsWith("-") || context.length > 256) throw new Error("Invalid Docker context name.");
    const data = JSON.parse(await this.run(["context", "inspect", context], signal));
    const endpoint = data?.[0]?.Endpoints?.docker?.Host;
    if (typeof endpoint !== "string") throw new Error("Docker context has no endpoint.");
    return { context, endpoint };
  }
  refresh(): Promise<DockerInventory> {
    return this.operation(async (signal) => {
      this.inventory = null;
      const target = await this.endpoint(signal);
      if (!isLocalEndpoint(target.endpoint)) throw new Error(`Remote Docker endpoint is not inventoried or cleaned: ${target.context} (${target.endpoint}). Select a local context in Docker and refresh.`);
      const args = ["--host", target.endpoint];
      const images = parseImages(JSON.parse(await this.run([...args, "system", "df", "--verbose", "--format", "{{json .Images}}"], signal, true)));
      const usage = parseUsage(await this.run([...args, "system", "df", "--format", "{{json .}}"], signal, true));
      signal.throwIfAborted();
      return this.inventory = { ...target, images, usage, collectedAt: new Date().toISOString() };
    });
  }
  remove(id: unknown, confirm: (image: DockerImage, inventory: DockerInventory) => Promise<boolean>): Promise<boolean> {
    return this.operation(async (signal) => {
      const inventory = this.inventory;
      if (typeof id !== "string" || !IMAGE_ID.test(id) || !inventory) throw new Error("Refresh Docker inventory before removing an image.");
      const image = inventory.images.find((entry) => entry.id === id);
      if (!image || image.containers !== 0) throw new Error("Image is in use or its usage is unknown.");
      if (!await confirm(image, inventory)) return false;
      signal.throwIfAborted();
      // Pin the endpoint displayed in the confirmation; context changes cannot retarget deletion.
      const args = ["--host", inventory.endpoint];
      const images = parseImages(JSON.parse(await this.run([...args, "system", "df", "--verbose", "--format", "{{json .Images}}"], signal, true)));
      const current = images.find((entry) => entry.id === id);
      if (!current || current.containers !== 0) throw new Error("Image usage changed. Refresh before retrying.");
      this.inventory = null;
      // Docker enforces conflicts atomically, including stopped containers and multiple tags.
      // Never force, remove tags individually, prune parents, or touch volumes/VM files.
      await this.run([...args, "image", "rm", "--no-prune", id], signal, true);
      return true;
    });
  }
}
