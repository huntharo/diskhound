/**
 * Minimal XML property-list reader for `diskutil … -plist` output.
 *
 * Why not `plutil -convert json`? It refuses plists that carry `<date>`
 * or `<data>` values ("invalid object in plist for destination format"),
 * and a second subprocess per query doubles the latency of the
 * storage-accounting card. The `diskutil` plists we read are a few KB of
 * machine-generated XML, so a small tokenizer is enough:
 *
 *   - supports dict / array / string / integer / real / true / false /
 *     date (→ epoch ms) / data (→ base64 string, left undecoded)
 *   - decodes the five XML entities plus numeric character references
 *   - ignores the XML prolog, DOCTYPE and comments
 *
 * Anything malformed returns `null` rather than throwing — callers treat
 * a missing plist the same as a failed command.
 */

export type PlistValue =
  | string
  | number
  | boolean
  | PlistValue[]
  | { [key: string]: PlistValue };

export type PlistDict = { [key: string]: PlistValue };

interface Token {
  /** Tag name without angle brackets / slash, e.g. `dict`, `key`. */
  name: string;
  kind: "open" | "close" | "empty";
  /** Text between this open tag and the next tag (open tags only). */
  text: string;
}

const TAG_RE = /<(\/?)([A-Za-z][\w.-]*)[^>]*?(\/?)>/g;

function decodeEntities(raw: string): string {
  if (raw.indexOf("&") === -1) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, entity: string) => {
    switch (entity) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return "\"";
      case "apos": return "'";
      default: {
        const code = entity.startsWith("#x")
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : "";
      }
    }
  });
}

function tokenize(xml: string): Token[] | null {
  // Drop comments, the prolog and DOCTYPE so the tag regex only sees
  // plist elements.
  const body = xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  const tokens: Token[] = [];
  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(body)) !== null) {
    const [, closing, name, selfClosing] = match;
    const kind: Token["kind"] = closing ? "close" : selfClosing ? "empty" : "open";
    let text = "";
    if (kind === "open") {
      const next = body.indexOf("<", TAG_RE.lastIndex);
      text = next === -1 ? "" : body.slice(TAG_RE.lastIndex, next);
    }
    tokens.push({ name: name!, kind, text });
  }
  return tokens.length > 0 ? tokens : null;
}

class Reader {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  /** Parse the value that starts at the current token. */
  value(): PlistValue | undefined {
    const tok = this.tokens[this.i];
    if (!tok) return undefined;
    this.i += 1;
    if (tok.kind === "empty") {
      switch (tok.name) {
        case "true": return true;
        case "false": return false;
        case "dict": return {};
        case "array": return [];
        case "string":
        case "data": return "";
        default: return undefined;
      }
    }
    if (tok.kind !== "open") return undefined;
    switch (tok.name) {
      case "dict": return this.dict();
      case "array": return this.array();
      case "string": return this.scalarEnd("string", decodeEntities(tok.text));
      case "data": return this.scalarEnd("data", tok.text.replace(/\s+/g, ""));
      case "integer": {
        const n = Number.parseInt(tok.text.trim(), 10);
        return this.scalarEnd("integer", Number.isFinite(n) ? n : 0);
      }
      case "real": {
        const n = Number.parseFloat(tok.text.trim());
        return this.scalarEnd("real", Number.isFinite(n) ? n : 0);
      }
      case "date": {
        const ms = Date.parse(tok.text.trim());
        return this.scalarEnd("date", Number.isFinite(ms) ? ms : 0);
      }
      // `<true></true>` is legal if unusual.
      case "true": return this.scalarEnd("true", true);
      case "false": return this.scalarEnd("false", false);
      default: return undefined;
    }
  }

  private scalarEnd<T extends PlistValue>(name: string, value: T): T | undefined {
    const tok = this.tokens[this.i];
    if (!tok || tok.kind !== "close" || tok.name !== name) return undefined;
    this.i += 1;
    return value;
  }

  private dict(): PlistDict | undefined {
    const out: PlistDict = {};
    while (true) {
      const tok = this.tokens[this.i];
      if (!tok) return undefined;
      if (tok.kind === "close" && tok.name === "dict") {
        this.i += 1;
        return out;
      }
      if (tok.kind !== "open" || tok.name !== "key") return undefined;
      const key = decodeEntities(tok.text);
      this.i += 1;
      const close = this.tokens[this.i];
      if (!close || close.kind !== "close" || close.name !== "key") return undefined;
      this.i += 1;
      const value = this.value();
      if (value === undefined) return undefined;
      out[key] = value;
    }
  }

  private array(): PlistValue[] | undefined {
    const out: PlistValue[] = [];
    while (true) {
      const tok = this.tokens[this.i];
      if (!tok) return undefined;
      if (tok.kind === "close" && tok.name === "array") {
        this.i += 1;
        return out;
      }
      const value = this.value();
      if (value === undefined) return undefined;
      out.push(value);
    }
  }

  root(): PlistValue | undefined {
    const first = this.tokens[this.i];
    if (!first || first.name !== "plist") return this.value();
    this.i += 1;
    if (first.kind === "empty") return undefined;
    return this.value();
  }
}

/** Parse an XML plist document. Returns null on anything malformed. */
export function parsePlist(xml: string): PlistValue | null {
  if (typeof xml !== "string" || xml.trim() === "") return null;
  const tokens = tokenize(xml);
  if (!tokens) return null;
  const value = new Reader(tokens).root();
  return value === undefined ? null : value;
}

/** Parse a plist whose root must be a `<dict>`. */
export function parsePlistDict(xml: string): PlistDict | null {
  const value = parsePlist(xml);
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

// ── Typed field accessors ────────────────────────────────────
//
// diskutil output drifts between macOS releases (keys appear, vanish or
// change type), so every read goes through these narrow helpers instead
// of casting the whole dict to an interface.

export function plistString(dict: PlistDict | null | undefined, key: string): string | null {
  const value = dict?.[key];
  return typeof value === "string" ? value : null;
}

export function plistNumber(dict: PlistDict | null | undefined, key: string): number | null {
  const value = dict?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function plistBool(dict: PlistDict | null | undefined, key: string): boolean | null {
  const value = dict?.[key];
  return typeof value === "boolean" ? value : null;
}

export function plistArray(dict: PlistDict | null | undefined, key: string): PlistValue[] {
  const value = dict?.[key];
  return Array.isArray(value) ? value : [];
}

export function plistDicts(dict: PlistDict | null | undefined, key: string): PlistDict[] {
  return plistArray(dict, key).filter(
    (v): v is PlistDict => !!v && typeof v === "object" && !Array.isArray(v),
  );
}
