import { explainFreedShortfall, FREED_CHECK_MIN_BYTES } from "../../shared/storageSharing";
import { toast } from "../components/Toasts";
import { nativeApi } from "../nativeApi";
import { formatBytes } from "./format";
import { dispatchStorageAccountingStale } from "./uiEvents";

/**
 * After a permanent delete, check that free space actually moved.
 *
 * On APFS a delete can free nothing: a local Time Machine snapshot
 * still references the blocks, or the files were clones sharing blocks
 * with copies that remain. Users then see "Deleted 40 GB" while `df`
 * and Finder stay put. This measures statfs free space before and after,
 * and when the gap is large, names the likely holder in a warning toast.
 *
 * macOS only for now — the explanation relies on the snapshot list from
 * macStorageAccounting.ts. Other platforms return early.
 */

/** APFS frees asynchronously; give it a moment before judging. */
const SETTLE_MS = 1_500;
const SECOND_LOOK_MS = 2_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * How a permanent delete confirm dialog should describe freeing space.
 * On APFS "the OS frees the bytes immediately" is false whenever a
 * local snapshot or a clone still references them.
 */
export function permanentDeleteFreesNote(): string {
  return nativeApi.platform === "darwin"
    ? "space returns once no local snapshot or APFS clone still references it"
    : "the OS will free the bytes immediately";
}

export function freedSpaceCheckEnabled(expectedBytes: number): boolean {
  return nativeApi.platform === "darwin" && expectedBytes >= FREED_CHECK_MIN_BYTES;
}

/** Free bytes on the volume holding `path`, or null when unknown. */
export async function captureFreeBytes(path: string): Promise<number | null> {
  try {
    const free = await nativeApi.getVolumeFreeBytes(path);
    return typeof free === "number" && Number.isFinite(free) ? free : null;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget: compare free space with `freeBefore` and toast when a
 * delete of `expectedBytes` came back far short. `sharedBytes` is the
 * clone-shared part the Dev view already knew about, if any.
 */
export async function checkFreedSpace(opts: {
  path: string;
  expectedBytes: number;
  freeBefore: number | null;
  sharedBytes?: number;
}): Promise<void> {
  dispatchStorageAccountingStale();
  if (!freedSpaceCheckEnabled(opts.expectedBytes) || opts.freeBefore === null) return;

  await sleep(SETTLE_MS);
  let freeAfter = await captureFreeBytes(opts.path);
  const firstLook = explainFreedShortfall(
    { expectedBytes: opts.expectedBytes, freeBefore: opts.freeBefore, freeAfter, report: null },
    formatBytes,
  );
  if (!firstLook) return;

  // Large trees can take a few seconds for APFS to hand blocks back.
  await sleep(SECOND_LOOK_MS);
  freeAfter = await captureFreeBytes(opts.path);
  const report = await nativeApi.getStorageAccounting(opts.path, { fresh: true }).catch(() => null);
  const explanation = explainFreedShortfall(
    {
      expectedBytes: opts.expectedBytes,
      freeBefore: opts.freeBefore,
      freeAfter,
      report,
      sharedBytes: opts.sharedBytes,
    },
    (bytes) => formatBytes(Math.max(0, bytes)),
  );
  dispatchStorageAccountingStale();
  if (!explanation) return;
  toast("warning", explanation.title, explanation.body, { dismissAfterMs: 20_000 });
}
