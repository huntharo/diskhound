import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

import type { DevArtifactReport } from "./contracts";
import {
  createDevAcc,
  noteDevFile,
  reportFromSidecar,
  sidecarFromAcc,
} from "./devArtifactSidecar";
import { attachPipeErrorHandlers } from "./streamSafety";

async function accumulateIndex(indexPath: string, rootPath: string) {
  const acc = createDevAcc();
  if (!existsSync(indexPath)) return sidecarFromAcc(acc, rootPath);

  const gunzip = createGunzip();
  const source = createReadStream(indexPath);
  attachPipeErrorHandlers([source, gunzip]);
  source.pipe(gunzip);
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line) continue;
      let rec: { p?: string; s?: number; t?: string; h?: number };
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec || typeof rec.p !== "string" || rec.t === "d" || typeof rec.s !== "number") continue;
      noteDevFile(acc, rec.p, rec.s, rec.h === 1);
    }
  } catch { /* partial */ }
  finally {
    try { gunzip.destroy(); } catch { /* ok */ }
    try { source.destroy(); } catch { /* ok */ }
  }

  return sidecarFromAcc(acc, rootPath);
}

export async function analyzeDevArtifacts(
  rootPath: string,
  currentIndexPath: string,
  previousIndexPath?: string | null,
): Promise<DevArtifactReport> {
  const current = await accumulateIndex(currentIndexPath, rootPath);
  const previous = previousIndexPath ? await accumulateIndex(previousIndexPath, rootPath) : null;
  return reportFromSidecar(current, previous);
}
