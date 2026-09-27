import { IterableMapper } from "@shutterstock/p-map-iterable";

import type { PathActionResult } from "../../shared/contracts";
import { toast } from "../components/Toasts";
import { formatCount } from "./format";

let batchSequence = 0;

/** One progress card per batch, retained until the user dismisses the result. */
export async function runBulkPathAction(
  paths: readonly string[],
  label: "trash" | "delete",
  action: (path: string) => Promise<PathActionResult>,
  skipped = 0,
  options?: {
    isCancelled: () => boolean;
    onProgress: (completed: number, total: number) => void;
    onComplete?: (summary: string) => void;
  },
): Promise<string[]> {
  const id = `bulk-path-${++batchSequence}`;
  const verb = label === "trash" ? "Moving to Trash" : "Deleting";
  const ok: string[] = [];
  let failed = 0;
  let firstFailure = "";
  let lastUpdate = Date.now();
  const progress = (completed: number) => {
    options?.onProgress(completed, paths.length);
    toast(
      "info", `${verb}: ${formatCount(completed)} of ${formatCount(paths.length)} files`,
      failed > 0 ? `${formatCount(failed)} failed so far.` : "Please wait…",
      { id, dismissAfterMs: 0 },
    );
  };
  progress(0);
  function* source() {
    for (const path of paths) {
      if (options?.isCancelled()) return;
      yield path;
    }
  }
  const mapped = new IterableMapper(source(), async (path) => {
    if (options?.isCancelled()) return null;
    let result: PathActionResult;
    try {
      result = await action(path);
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (result.ok) ok.push(path);
    else {
      failed++;
      if (!firstFailure) firstFailure = `${path}: ${result.message}`;
    }
    // Avoid repainting the file list or flooding the toast provider per file.
    if (Date.now() - lastUpdate >= 100) {
      progress(ok.length + failed);
      lastUpdate = Date.now();
    }
    return null;
  }, { concurrency: 4, maxUnread: 4 });
  // Drain so cancellation waits for every already-started operation.
  for await (const _ of mapped) { /* Results are counted as they settle. */ }
  const remaining = paths.length - ok.length - failed;
  const notes = [
    remaining > 0 ? `${formatCount(remaining)} files left unprocessed.` : "",
    failed > 0 ? `${formatCount(failed)} failed. ${firstFailure}` : "",
    skipped > 0 ? `${formatCount(skipped)} protected or already-deleted file(s) skipped.` : "",
    label === "trash" && ok.length > 0 ? "Files remain in Trash until it is emptied." : "",
  ].filter(Boolean).join("\n");
  const summary = `${remaining > 0 ? "Cancelled — " : "Done — "}${label === "trash" ? "Trashed" : "Deleted"} ${formatCount(ok.length)} of ${formatCount(paths.length)} files${failed > 0 ? `; ${formatCount(failed)} failed` : ""}${remaining > 0 ? `; ${formatCount(remaining)} unprocessed` : ""}`;
  options?.onComplete?.(summary);
  toast(
    failed > 0 ? (ok.length > 0 ? "warning" : "error") : skipped > 0 ? "warning" : "success",
    summary,
    notes || undefined,
    { id, dismissAfterMs: 0 },
  );
  return ok;
}
