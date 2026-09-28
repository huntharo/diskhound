import { useEffect, useRef } from "preact/hooks";

import type { DiskhoundNativeApi } from "../../shared/contracts";
import { nativeApi } from "../nativeApi";

/**
 * Renderer polling that stops while its window can't be seen.
 *
 * DiskHound sits in the tray for days. Several polls start a process
 * in main on every tick: df or PowerShell for disk space, the process
 * sampler for memory and disk I/O, nvidia-smi or PowerShell for the
 * GPU. A hidden or minimized window makes none of those calls. Shown
 * again, it ticks at once so the numbers are fresh, then resumes its
 * interval.
 *
 * `document.hidden` alone isn't enough. Main's background switches
 * keep a window hidden to the tray "visible" to the page, so main
 * reports hide, show, minimize and restore itself.
 */

export interface VisibilityTarget {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

type WindowShownApi = Pick<DiskhoundNativeApi, "isWindowShown" | "onWindowShownChanged">;

/** Hidden when main says the window is hidden or minimized, or the page itself is hidden. */
export function createWindowVisibility(api: WindowShownApi, doc: VisibilityTarget): VisibilityTarget {
  const listeners = new Set<() => void>();
  let shown = true;
  let started = false;
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const setShown = (next: boolean) => {
    if (next === shown) return;
    shown = next;
    emit();
  };
  const start = () => {
    if (started) return;
    started = true;
    api.onWindowShownChanged(setShown);
    doc.addEventListener("visibilitychange", emit);
    // Until main answers, assume shown: a window is created visible
    // unless DiskHound launched to the tray.
    void api.isWindowShown().then((answer) => {
      if (typeof answer === "boolean") setShown(answer);
    }, () => undefined);
  };
  return {
    get hidden() {
      return !shown || doc.hidden;
    },
    addEventListener(_type, listener) {
      start();
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };
}

let windowVisibility: VisibilityTarget | null = null;

function currentWindowVisibility(): VisibilityTarget {
  windowVisibility ??= createWindowVisibility(nativeApi, document);
  return windowVisibility;
}

export interface VisiblePollOptions {
  /** Tick now if the window is visible, or as soon as it is shown. */
  immediate?: boolean;
  /** Defaults to this renderer's window. */
  target?: VisibilityTarget;
}

/** Starts polling; the returned function stops it. */
export function startVisiblePoll(
  tick: () => void,
  intervalMs: number,
  options: VisiblePollOptions = {},
): () => void {
  const target = options.target ?? currentWindowVisibility();
  let timer: ReturnType<typeof setInterval> | null = null;
  const resume = () => {
    if (timer === null) timer = setInterval(tick, intervalMs);
  };
  const pause = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };
  const onVisibilityChange = () => {
    if (target.hidden) {
      pause();
    } else if (timer === null) {
      tick();
      resume();
    }
  };

  target.addEventListener("visibilitychange", onVisibilityChange);
  if (!target.hidden) {
    if (options.immediate) tick();
    resume();
  }
  return () => {
    pause();
    target.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

/**
 * `setInterval` for a component, paused while the window can't be
 * seen. Always calls the latest `tick`; pass `null` to stop.
 */
export function useVisibleInterval(tick: () => void, intervalMs: number | null, options?: { immediate?: boolean }): void {
  const latest = useRef(tick);
  latest.current = tick;
  const immediate = options?.immediate ?? false;
  useEffect(() => {
    if (intervalMs === null) return;
    return startVisiblePoll(() => latest.current(), intervalMs, { immediate });
  }, [intervalMs, immediate]);
}
