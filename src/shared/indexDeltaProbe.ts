import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { normPath } from "./pathUtils";

export interface IndexDeltas {
  deletes: Set<string>;
  updates: Map<string, { size: number; mtime: number; extraHardlink?: boolean }>;
}

/** Bounded by the delta count, independent of the size of the baseline. */
export class IndexDeltaProbe {
  private readonly pending: IndexDeltas["updates"];

  constructor(private readonly deltas: IndexDeltas) {
    this.pending = new Map(deltas.updates);
  }

  changesRow(rec: { p: string; s?: number; m?: number; t?: string }): boolean {
    // Match the writer: directory metadata passes through unchanged.
    if (rec.t === "d") return false;
    const key = normPath(rec.p);
    if (this.deltas.deletes.has(key)) return true;
    const update = this.pending.get(key);
    if (!update) return false;
    this.pending.delete(key);
    return update.size !== (rec.s ?? 0) || update.mtime !== (rec.m ?? 0);
  }

  get hasAdditions(): boolean { return this.pending.size > 0; }
}

/** Check before opening an output file. Changed ticks reread the immutable
 * baseline; ineffective tombstones and identical updates cause zero writes. */
export async function indexNeedsRewrite(path: string, deltas: IndexDeltas): Promise<boolean> {
  const probe = new IndexDeltaProbe(deltas);
  const source = createReadStream(path);
  const gunzip = createGunzip();
  source.on("error", (error) => gunzip.destroy(error));
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  // Start iteration before piping so read/decompression errors reject it.
  const lines = rl[Symbol.asyncIterator]();
  source.pipe(gunzip);
  try {
    for await (const line of { [Symbol.asyncIterator]: () => lines }) {
      let rec: { p?: string; s?: number; m?: number; t?: string };
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec || typeof rec.p !== "string") continue;
      if (probe.changesRow({ ...rec, p: rec.p })) return true;
    }
    return probe.hasAdditions;
  } finally {
    rl.close();
    source.destroy();
    gunzip.destroy();
  }
}
