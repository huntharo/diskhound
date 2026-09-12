import * as FS from "node:fs";
import * as Path from "node:path";

/**
 * Worker threads cannot execute scripts inside app.asar. electron-builder
 * copies `dist-electron/scan/**` to app.asar.unpacked; __dirname still
 * points at the asar, so rewrite when the unpacked file is present.
 *
 * tsdown must emit each worker as one file (codeSplitting: false). Shared
 * chunks land in dist-electron/, not scan/, and stay inside the asar.
 */
export function resolveBundledWorkerScript(baseDir: string, fileName: string): string {
  const packed = Path.join(baseDir, "scan", fileName);
  const marker = `${Path.sep}app.asar${Path.sep}`;
  const at = packed.toLowerCase().indexOf(marker.toLowerCase());
  if (at === -1) return packed;
  const unpacked =
    packed.slice(0, at) + `${Path.sep}app.asar.unpacked${Path.sep}` + packed.slice(at + marker.length);
  return FS.existsSync(unpacked) ? unpacked : packed;
}
