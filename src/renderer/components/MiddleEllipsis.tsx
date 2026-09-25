import { splitForMiddleEllipsis } from "../lib/middleEllipsis";

/**
 * Single-line path label that truncates in the middle. The head shrinks
 * with "…" while the last segment stays visible, and the whole thing is
 * clipped to its box, so a long mount point never escapes its container.
 * Callers put the full path in a `title` on whatever element owns the
 * hover.
 */
export function MiddleEllipsis({ text, className, maxTail }: {
  text: string;
  className?: string;
  maxTail?: number;
}) {
  const { head, tail } = splitForMiddleEllipsis(text, maxTail);
  return (
    <span className={className ? `middle-ellipsis ${className}` : "middle-ellipsis"}>
      {head && <span className="middle-ellipsis-head">{head}</span>}
      <span className="middle-ellipsis-tail">{tail}</span>
    </span>
  );
}
