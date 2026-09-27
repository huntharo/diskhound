/** Keep Electron alive for an active capture, but never wait forever on I/O. */
export function createDiagnosticsShutdown(options: {
  stop: () => void | Promise<void>;
  resumeQuit: () => void;
  warn: (message: string) => void;
  timeoutMs?: number;
}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  let complete = false;
  let resumingQuit = false;
  let pending: Promise<void> | null = null;

  const flush = (): Promise<void> => {
    pending ??= new Promise<void>((resolve) => {
      const finish = (warning?: string) => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        try {
          if (warning) options.warn(warning);
        } catch {
          // A failing logger must not prevent exit either.
        }
        resolve();
      };
      // Keep this timer referenced: it must release a prevented quit even
      // when no windows remain. The deadline covers the entire stop call.
      const timer = setTimeout(() => finish(`diagnostics shutdown exceeded ${timeoutMs} ms; continuing quit`), timeoutMs);
      void Promise.resolve().then(options.stop).then(
        () => finish(),
        (error: unknown) => finish(`diagnostics shutdown failed: ${error instanceof Error ? error.message : String(error)}; continuing quit`),
      );
    });
    return pending;
  };

  return {
    // Explicit updater installs flush first, then let the updater own quit.
    flush,
    /** True means this quit was prevented; the caller should skip teardown. */
    beforeQuit(event: { preventDefault(): void }): boolean {
      if (complete) return false;
      event.preventDefault();
      if (!resumingQuit) {
        resumingQuit = true;
        void flush().then(options.resumeQuit);
      }
      return true;
    },
  };
}
