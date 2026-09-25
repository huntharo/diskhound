/**
 * Decode the body of a JSON string literal holding a path, as captured
 * by the scan-index and folder-tree-sidecar fast paths (the text between
 * the quotes, still escaped).
 *
 * Single pass over `\\` and `\"`, the only escapes on ordinary paths
 * (every Windows separator is one). The native writer
 * (`append_json_escaped`) also emits `\n`, `\r`, `\t` and `\u00XX` for
 * control characters in names, and `JSON.stringify` emits `\b` and `\f`;
 * any of those sends the whole string through JSON.parse.
 *
 * Returns null for an escape JSON does not define, so the caller can
 * treat the line like any other it cannot parse.
 */
export function unescapeJsonPath(escaped: string): string | null {
  let i = escaped.indexOf("\\");
  if (i === -1) return escaped;
  let out = "";
  let start = 0;
  for (; i !== -1; i = escaped.indexOf("\\", start)) {
    const next = escaped[i + 1];
    if (next !== "\\" && next !== '"') {
      try {
        return JSON.parse(`"${escaped}"`) as string;
      } catch {
        return null;
      }
    }
    out += escaped.slice(start, i) + next;
    start = i + 2;
  }
  return out + escaped.slice(start);
}
