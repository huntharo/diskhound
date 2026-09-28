import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import type { ToastMessage } from "../../shared/contracts";
import { nativeApi } from "../nativeApi";

// Imperative toast helper for use within the renderer.
//
// Pass `opts.id` to UPSERT by a stable identifier — if a toast with
// that id already exists it's replaced in place (title/body
// updated) rather than a second toast appearing. Used by the
// EasyMove progress hook to show a live-updating progress toast
// with a single entry.
//
// Pass `opts.dismissAfterMs: 0` to make the toast sticky (no auto-
// dismiss). Progress toasts use this since they dismiss themselves
// on the final "done" phase.
//
// Pass `opts.action` for one button under the body (e.g. "Rescan now").
// Pressing it runs the action and dismisses the toast. Renderer-only: a
// toast from main has no action.
interface ToastAction {
  label: string;
  run: () => void;
}
type RendererToast = ToastMessage & { action?: ToastAction };
type ToastTimer = ReturnType<typeof setTimeout>;

function clearToastTimer(timers: Map<string, ToastTimer>, id: string): void {
  const timer = timers.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  timers.delete(id);
}

let externalAddToast: ((toast: RendererToast) => void) | null = null;
let externalDismissToast: ((id: string) => void) | null = null;
let toastSeq = 0;
export function toast(
  level: ToastMessage["level"],
  title: string,
  body?: string,
  opts?: { id?: string; dismissAfterMs?: number; action?: ToastAction; copyText?: string },
) {
  const msg: RendererToast = {
    id: opts?.id ?? `local-${++toastSeq}`,
    level,
    title,
    body,
    dismissAfterMs: opts?.dismissAfterMs ?? (opts?.action ? 8000 : 4000),
    action: opts?.action,
    copyText: opts?.copyText,
  };
  externalAddToast?.(msg);
}

export function dismissToast(id: string): void {
  externalDismissToast?.(id);
}

export function ToastProvider({ children }: { children: any }) {
  const [toasts, setToasts] = useState<(RendererToast & { exiting?: boolean })[]>([]);
  const dismissTimers = useRef(new Map<string, ToastTimer>());
  const removeTimers = useRef(new Map<string, ToastTimer>());

  const dismiss = useCallback((id: string) => {
    clearToastTimer(dismissTimers.current, id);
    clearToastTimer(removeTimers.current, id);
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, exiting: true } : x)));
    const timer = setTimeout(() => {
      removeTimers.current.delete(id);
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 220);
    removeTimers.current.set(id, timer);
  }, []);

  const addToast = useCallback((t: RendererToast) => {
    // An upsert starts a fresh lifetime. Also cancel a pending exit
    // removal in case the replacement arrived during the fade-out.
    clearToastTimer(dismissTimers.current, t.id);
    clearToastTimer(removeTimers.current, t.id);
    setToasts((prev) => {
      // Upsert by id: if the id already exists, replace the entry
      // in-place. Keeps progress toasts to a single visible card.
      const existing = prev.findIndex((x) => x.id === t.id);
      if (existing >= 0) {
        const next = prev.slice();
        next[existing] = t;
        return next;
      }
      // Bound transient messages without evicting sticky captures/progress.
      const recent = new Set(prev.filter((x) => (x.dismissAfterMs ?? 0) > 0).slice(-6).map((x) => x.id));
      return [...prev.filter((x) => !(x.dismissAfterMs && x.dismissAfterMs > 0) || recent.has(x.id)), t];
    });
    // Sticky toasts pass 0 — don't auto-dismiss. Non-positive is
    // treated the same so callers can pass 0, null, or undefined.
    if (t.dismissAfterMs && t.dismissAfterMs > 0) {
      const timer = setTimeout(() => {
        dismissTimers.current.delete(t.id);
        dismiss(t.id);
      }, t.dismissAfterMs);
      dismissTimers.current.set(t.id, timer);
    }
  }, [dismiss]);

  useEffect(() => {
    externalAddToast = addToast;
    externalDismissToast = dismiss;
    const unsubscribe = nativeApi.onNotification(addToast);
    return () => {
      unsubscribe();
      if (externalAddToast === addToast) externalAddToast = null;
      if (externalDismissToast === dismiss) externalDismissToast = null;
      for (const timer of dismissTimers.current.values()) clearTimeout(timer);
      for (const timer of removeTimers.current.values()) clearTimeout(timer);
      dismissTimers.current.clear();
      removeTimers.current.clear();
    };
  }, [addToast, dismiss]);

  return (
    <>
      {children}
      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map((t) => (
            <ToastCard key={t.id} message={t} dismiss={dismiss} />
          ))}
        </div>
      )}
    </>
  );
}

function ToastCard({ message, dismiss }: {
  message: RendererToast & { exiting?: boolean };
  dismiss: (id: string) => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  useEffect(() => setCopyState("idle"), [message.copyText]);
  const copy = async () => {
    if (message.copyText === undefined) return;
    setCopyState("copying");
    try {
      await navigator.clipboard.writeText(message.copyText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  return (
    <div className={`toast ${message.exiting ? "exiting" : ""}`}>
      <div className={`toast-icon ${message.level}`} />
      <div className="toast-content">
        <div className="toast-title">{message.title}</div>
        {message.body && <div className="toast-body">{message.body}</div>}
        {message.action && (
          <button
            className="toast-action"
            onClick={() => {
              dismiss(message.id);
              message.action?.run();
            }}
          >
            {message.action.label}
          </button>
        )}
        {message.copyText !== undefined && (
          <div className="toast-actions">
            <button className="btn btn-sm" onClick={() => void copy()} disabled={copyState === "copying"}>
              {copyState === "copied" ? "Copied!" : "Copy details"}
            </button>
            {copyState === "failed" && <span role="status">Couldn't copy. Try again.</span>}
          </div>
        )}
      </div>
      <button className="toast-close" onClick={() => dismiss(message.id)} aria-label="Dismiss">&times;</button>
    </div>
  );
}
