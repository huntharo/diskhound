/**
 * Split a path-like label for a CSS middle ellipsis. The head is allowed
 * to shrink and show "…"; the tail stays pinned so the part that tells
 * two mounts apart survives: `/Library/Developer/…/iOS_21A342`.
 *
 * The tail is the last segment with its leading separator. When that
 * segment is longer than `maxTail` characters, only its last `maxTail`
 * characters are kept, so the head always has room to show where the
 * path starts. That shorter tail starts on a word break (space, `.`,
 * `-`, `_`) when one is close, so `/Volumes/My Passport for Mac` reads
 * `/Volumes/My… for Mac` rather than `/Volum…port for Mac`. Short labels
 * (`C:`, `/`, `/home`) end up entirely in the tail and render unchanged.
 */
export function splitForMiddleEllipsis(
  label: string,
  maxTail = 16,
): { head: string; tail: string } {
  const sep = Math.max(label.lastIndexOf("/"), label.lastIndexOf("\\"));
  // A trailing separator (`/Volumes/Backup/`) would leave an empty last
  // segment; treat it as part of the segment before it.
  const cut = sep > 0 && sep === label.length - 1
    ? Math.max(label.lastIndexOf("/", sep - 1), label.lastIndexOf("\\", sep - 1))
    : sep;
  let start = Math.max(cut, 0);
  if (label.length - start > maxTail) {
    start = Math.max(label.length - maxTail, 0);
    // Don't cut between the halves of a surrogate pair (emoji in a
    // volume name); step forward to the start of the next character.
    if (/[\uDC00-\uDFFF]/.test(label[start] ?? "")) start += 1;
    const wordBreak = label.slice(start).search(/[\s._-]/);
    if (wordBreak >= 0 && wordBreak <= maxTail / 2) start += wordBreak;
  }
  return { head: label.slice(0, start), tail: label.slice(start) };
}
