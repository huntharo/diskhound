import { Session } from "node:inspector";

/**
 * A Chrome DevTools Protocol connection to the calling thread's own V8
 * isolate. In main that is the main thread only: worker_threads have
 * isolates of their own that this session never sees.
 *
 * node:inspector speaks the same Profiler and HeapProfiler domains a
 * renderer's webContents.debugger does, so the profiler logic ported
 * from PwrAgnt runs unchanged. An in-process session answers each
 * command before `post` returns, which `postSync` relies on.
 */
export interface InspectorTarget {
  attach(): void;
  detach(): void;
  isAttached(): boolean;
  post<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** For paths that may not get another turn of the event loop. */
  postSync<T = unknown>(method: string, params?: Record<string, unknown>): T;
}

export function createMainInspector(): InspectorTarget {
  let session: Session | null = null;

  const send = (
    method: string,
    params: Record<string, unknown> | undefined,
    done: (error: Error | null, result: unknown) => void,
  ): void => {
    if (session === null) {
      done(new Error("main-process inspector session not attached"), undefined);
      return;
    }
    // node:inspector's typed overloads don't cover a dynamic method name.
    (session.post as (m: string, p: object, cb: (e: Error | null, r: unknown) => void) => void)(
      method,
      params ?? {},
      (error, result) => done(error, result),
    );
  };

  return {
    attach: () => {
      if (session !== null) throw new Error("main-process inspector session already attached");
      const next = new Session();
      next.connect();
      session = next;
    },
    detach: () => {
      const current = session;
      session = null;
      current?.disconnect();
    },
    isAttached: () => session !== null,
    post: <T>(method: string, params?: Record<string, unknown>) =>
      new Promise<T>((resolve, reject) => {
        send(method, params, (error, result) => (error ? reject(error) : resolve(result as T)));
      }),
    postSync: <T>(method: string, params?: Record<string, unknown>): T => {
      let outcome: { error: Error | null; result: unknown } | null = null;
      send(method, params, (error, result) => {
        outcome = { error, result };
      });
      const settled = outcome as { error: Error | null; result: unknown } | null;
      if (settled === null) throw new Error(`${method} did not answer synchronously`);
      if (settled.error) throw settled.error;
      return settled.result as T;
    },
  };
}
