import { nativeApi } from "../nativeApi";

/**
 * Forwards a failed poll to crash.log. Without a catch, a handler that
 * starts rejecting surfaces as an unhandled rejection on every tick.
 * Main counts identical repeats instead of writing each one, so a poll
 * that keeps failing costs a few lines a day.
 */
export function reportPollFailure(source: string, error: unknown): void {
  const err = error instanceof Error ? error : null;
  nativeApi.reportRendererError({
    message: `${source} poll failed: ${err ? err.message : String(error)}`,
    stack: err?.stack,
  });
}
