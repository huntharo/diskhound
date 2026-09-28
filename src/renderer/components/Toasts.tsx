import { useCallback, useEffect, useState } from "preact/hooks";

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

let externalAddToast: ((toast: RendererToast) => void) | null = null;
let externalDismissToast: ((id: string) => void) | null = null;
let toastSeq = 0;
export function toast(
  level: ToastMessage["level"],
  title: string,
  body?: string,
  opts?: { id?: string; dismissAfterMs?: number; action?: ToastAction },
) {
  const msg: RendererToast = {
    id: opts?.id ?? `local-${++toastSeq}`,
    level,
    title,
    body,
    dismissAfterMs: opts?.dismissAfterMs ?? (opts?.action ? 8000 : 4000),
    action: opts?.action,
  };
  externalAddToast?.(msg);
}

export function dismissToast(id: string): void {
  externalDismissToast?.(id);
}

export function ToastProvider({ children }: { children: any }) {
  const [toasts, setToasts] = useState<(RendererToast & { exiting?: boolean })[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, exiting: true } : x)));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 220);
  }, []);

  const addToast = useCallback((t: RendererToast) => {
    setToasts((prev) => {
      // Upsert by id: if the id already exists, replace the entry
      // in-place. Keeps progress toasts to a single visible card.
      const existing = prev.findIndex((x) => x.id === t.id);
      if (existing >= 0) {
        const next = prev.slice();
        next[existing] = t;
        return next;
      }
      return [...prev.slice(-6), t];
    });
    // Sticky toasts pass 0 — don't auto-dismiss. Non-positive is
    // treated the same so callers can pass 0, null, or undefined.
    if (t.dismissAfterMs && t.dismissAfterMs > 0) {
      setTimeout(() => dismiss(t.id), t.dismissAfterMs);
    }
  }, [dismiss]);

  useEffect(() => {
    externalAddToast = addToast;
    externalDismissToast = dismiss;
    return nativeApi.onNotification(addToast);
  }, [addToast, dismiss]);

  return (
    <>
      {children}
      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.exiting ? "exiting" : ""}`}>
              <div className={`toast-icon ${t.level}`} />
              <div className="toast-content">
                <div className="toast-title">{t.title}</div>
                {t.body && <div className="toast-body">{t.body}</div>}
                {t.action && (
                  <button
                    className="toast-action"
                    onClick={() => {
                      dismiss(t.id);
                      t.action?.run();
                    }}
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
              <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">&times;</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
