import { describe, expect, it, vi } from "vitest";
import { DockerService, isLocalEndpoint, parseImages, type DockerRunner } from "./inventory";

const id = `sha256:${"a".repeat(64)}`;
const endpoint = "unix:///var/run/docker.sock";
const image = (extra = {}) => ({ ID: id, Repository: "example/local", Tag: "latest", Containers: "0", Size: "100MB", SharedSize: "80MB", UniqueSize: "20MB", ...extra });
function fixture(rows = [image()]) {
  const run = vi.fn<DockerRunner>(async (args) => {
    if (args[0] === "context" && args[1] === "show") return "desktop-linux\n";
    if (args[0] === "context") return JSON.stringify([{ Endpoints: { docker: { Host: endpoint } } }]);
    if (args.includes("--verbose")) return JSON.stringify(rows);
    if (args.includes("rm")) return "Deleted";
    return ["Images", "Containers", "Local Volumes", "Build Cache"].map(Type => JSON.stringify({ Type, TotalCount: "1", Active: "0", Size: "100MB", Reclaimable: "20MB (20%)" })).join("\n");
  });
  return { run, service: new DockerService(run, {}) };
}

describe("Docker inventory", () => {
  it("keeps provenance unknown regardless of tag or registry metadata", async () => {
    const { service, run } = fixture([image({ RepoDigests: ["registry/repo@sha256:123"], Labels: { builder: "local" } })]);
    const result = await service.refresh();
    expect(result.images[0]).toMatchObject({ provenance: "unknown", logicalSize: "100MB", sharedSize: "80MB", uniqueSize: "20MB", containers: 0 });
    expect(result.usage.map(x => x.type)).toEqual(["Images", "Containers", "Local Volumes", "Build Cache"]);
    expect(run).toHaveBeenCalledTimes(4);
    expect(run.mock.calls.slice(2).every(([args, , pinned]) => args[1] === endpoint && pinned)).toBe(true);
  });
  it.each(["tcp://localhost:2375", "ssh://host", "npipe://remote/pipe/docker_engine", "unix://host/socket"])("rejects remote or ambiguous endpoint %s without contacting it", async (host) => {
    const run = vi.fn<DockerRunner>();
    const service = new DockerService(run, { DOCKER_HOST: host });
    await expect(service.refresh()).rejects.toThrow("Remote Docker");
    expect(run).not.toHaveBeenCalled();
  });
  it("honors DOCKER_CONTEXT over DOCKER_HOST and permits local named pipes", async () => {
    const { run } = fixture();
    const service = new DockerService(run, { DOCKER_CONTEXT: "chosen", DOCKER_HOST: "ssh://remote" });
    await service.refresh();
    expect(run.mock.calls[0][0]).toEqual(["context", "inspect", "chosen"]);
    expect(isLocalEndpoint("npipe:////./pipe/docker_engine")).toBe(true);
    expect(isLocalEndpoint("npipe://./pipe/docker_engine")).toBe(true);
  });
  it("handles empty inventory and unknown usage conservatively", () => {
    expect(parseImages([])).toEqual([]);
    expect(parseImages([image({ Containers: "N/A" })])[0].containers).toBeNull();
    expect(() => parseImages([image({ ID: "short-id" })])).toThrow();
    expect(() => parseImages([image(), image()])).toThrow();
  });
  it("does not substitute filesystem data when Docker is unavailable", async () => {
    const service = new DockerService(async () => { throw new Error("Cannot connect"); }, {});
    await expect(service.refresh()).rejects.toThrow("Cannot connect");
    await expect(service.remove(id, async () => true)).rejects.toThrow("Refresh");
  });
  it("cancels active requests and rejects overlapping refreshes", async () => {
    let signal: AbortSignal | undefined;
    const service = new DockerService(async (_args, s) => {
      signal = s;
      return new Promise((_resolve, reject) => s.addEventListener("abort", () => reject(new Error("Cancelled"))));
    }, {});
    const pending = service.refresh();
    await expect(service.refresh()).rejects.toThrow("already running");
    service.cancel();
    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow("Cancelled");
  });
});

describe("scoped image removal", () => {
  it("requires native confirmation and revalidation then only removes a full ID without prune/force", async () => {
    const { service, run } = fixture();
    const inventory = await service.refresh();
    const confirm = vi.fn(async () => true);
    await expect(service.remove(id, confirm)).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith(inventory.images[0], inventory);
    expect(run.mock.calls.at(-2)?.[0]).toContain("--verbose");
    expect(run.mock.calls.at(-1)?.[0]).toEqual(["--host", endpoint, "image", "rm", "--no-prune", id]);
    await expect(service.remove(id, confirm)).rejects.toThrow("Refresh");
  });
  it.each(["1", "N/A", "-1"])("blocks in-use or unknown images (%s)", async (Containers) => {
    const { service, run } = fixture([image({ Containers })]);
    await service.refresh();
    const confirm = vi.fn(async () => true);
    await expect(service.remove(id, confirm)).rejects.toThrow("in use");
    expect(confirm).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(4);
  });
  it("does not remove anything after cancelled confirmation, injected ID or cancellation", async () => {
    const { service, run } = fixture();
    await service.refresh();
    expect(await service.remove(id, async () => false)).toBe(false);
    await expect(service.remove("--force", async () => true)).rejects.toThrow("Refresh");
    await expect(service.remove(id, async () => { service.cancel(); return true; })).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(4);
  });
  it("blocks images acquired by a container after confirmation", async () => {
    const rows = [image()];
    const { service, run } = fixture(rows);
    await service.refresh();
    await expect(service.remove(id, async () => { rows[0].Containers = "1"; return true; })).rejects.toThrow("usage changed");
    expect(run.mock.calls.some(([args]) => args.includes("rm"))).toBe(false);
  });
  it("propagates Docker conflicts without a force fallback", async () => {
    const { service, run } = fixture();
    await service.refresh();
    run.mockImplementationOnce(async () => JSON.stringify([image()]));
    run.mockImplementationOnce(async () => { throw new Error("multiple repositories"); });
    await expect(service.remove(id, async () => true)).rejects.toThrow("multiple repositories");
    expect(run).toHaveBeenCalledTimes(6);
  });
});

it("image normalization scales by property reads at N and 8N", () => {
  const measure = (n: number) => {
    let reads = 0;
    const rows = Array.from({ length: n }, (_, i) => new Proxy(image({ ID: `sha256:${i.toString(16).padStart(64, "0")}` }), { get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); } }));
    expect(parseImages(rows)).toHaveLength(n);
    return reads;
  };
  const small = measure(1000), large = measure(8000);
  expect(large).toBeLessThanOrEqual(small * 16);
  expect(large).toBeLessThanOrEqual(64_000);
});
