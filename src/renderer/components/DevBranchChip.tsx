import { useEffect, useState } from "preact/hooks";

import type { DevBranch } from "../../shared/contracts";
import { DEV_BRANCH_TAIL_CHARS, devBranchDisplay } from "../lib/devBranchDisplay";
import { nativeApi } from "../nativeApi";
import { MiddleEllipsis } from "./MiddleEllipsis";
import { toast } from "./Toasts";

const COPIED_MS = 1500;

/**
 * Header chip naming the Git branch a development build runs from, so
 * a dev instance can't be mistaken for another one or for the
 * installed app. Renders nothing in packaged builds. A click copies
 * the name. The name elides in the middle, and the header gives the
 * chip only the room the drive pills leave, so it shrinks first.
 */
export function DevBranchChip() {
  const [branch, setBranch] = useState<DevBranch | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void nativeApi.getDevBranch().then(
      (next) => { if (!cancelled) setBranch(next); },
      () => {},
    );
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!branch) return null;
  const display = devBranchDisplay(branch);

  return (
    <button
      type="button"
      className={`dev-branch-chip${copied ? " copied" : ""}`}
      style={`--dev-branch-min-ch: ${display.minChars}; --dev-branch-tail-ch: ${display.tailChars}`}
      title={display.title}
      aria-label={display.ariaLabel}
      onClick={() => {
        void navigator.clipboard.writeText(display.copyText).then(
          () => {
            setCopied(true);
            toast("success", branch.detached ? "Commit copied" : "Branch name copied", display.copyText);
          },
          () => toast("error", "Couldn't copy branch name"),
        );
      }}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {copied ? (
          <path d="M2.5 6.5L5 9L9.5 3.5" />
        ) : (
          <>
            <circle cx="3.5" cy="2.5" r="1.3" />
            <circle cx="3.5" cy="9.5" r="1.3" />
            <circle cx="8.5" cy="4" r="1.3" />
            <path d="M3.5 3.8V8.2" />
            <path d="M8.5 5.3C8.5 7.2 3.5 6.4 3.5 8.2" />
          </>
        )}
      </svg>
      <MiddleEllipsis text={display.label} maxTail={DEV_BRANCH_TAIL_CHARS} />
    </button>
  );
}
