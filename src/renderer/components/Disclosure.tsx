/**
 * The expand/collapse chevron. It points right when closed and down
 * when open, and it always leads its row, before any checkbox or icon.
 * Navigation arrows (drill into a folder, rescan a recent root) point
 * right at the trailing edge and are not this.
 */
export function DisclosureChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`disclosure-chevron ${expanded ? "expanded" : ""}`}
      width="10" height="10" viewBox="0 0 10 10"
      fill="none" stroke="currentColor"
      aria-hidden="true"
    >
      <path d="M3.5 2L7 5L3.5 8" />
    </svg>
  );
}

/**
 * The chevron as its own button, for rows that also toggle on a click
 * anywhere. The row click is a mouse shortcut; this is the control
 * keyboard and screen reader users reach.
 */
export function DisclosureToggle({ expanded, label, onToggle }: {
  expanded: boolean;
  /** What opens, e.g. "Copies of report.pdf". Screen readers add the state. */
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="disclosure-toggle"
      aria-expanded={expanded}
      aria-label={label}
      title={expanded ? "Collapse" : "Expand"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <DisclosureChevron expanded={expanded} />
    </button>
  );
}
