export interface DockerImage {
  id: string;
  name: string;
  logicalSize: string;
  sharedSize: string;
  uniqueSize: string;
  containers: number | null;
  provenance: "unknown";
}
export interface DockerUsage {
  type: string;
  total: string;
  active: string;
  size: string;
  reclaimable: string;
}
export interface DockerInventory {
  context: string;
  endpoint: string;
  images: DockerImage[];
  usage: DockerUsage[];
  collectedAt: string;
}
export type DockerResult = { ok: true; inventory: DockerInventory } | { ok: false; message: string };
