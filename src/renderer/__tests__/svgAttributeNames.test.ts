import * as FS from "node:fs";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const srcRoot = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "../..");

// SVG presentation attributes are kebab-case: stroke-width, fill-rule.
// React and preact/compat rename the camelCase spelling, but the app
// renders with Preact core, which writes the name as given. SVG
// attribute names are case-sensitive, so `strokeWidth="1.5"` does
// nothing and the icon draws a 1px stroke with butt caps.
//
// This is compat's own list (CAMEL_PROPS in preact/compat's render.js),
// with its `image(!S)` typo fixed to the lookahead it means.
const COMPAT_CAMEL_PROPS =
  /^(?:accent|alignment|arabic|baseline|cap|clip(?!PathU)|color|dominant|fill|flood|font|glyph(?!R)|horiz|image(?!S)|letter|lighting|marker(?!H|W|U)|overline|paint|pointer|shape|stop|strikethrough|stroke|text(?!L)|transform|underline|unicode|units|v|vector|vert|word|writing|x(?!C))[A-Z]/;

function kebabCase(name: string): string {
  return name.replace(/[A-Z0-9]/g, "-$&").toLowerCase();
}

/** One `file:line <tag> name → kebab-name` line per camelCase
 *  presentation attribute on a DOM element. A component's own props,
 *  such as `<Chart strokeWidth={2} />`, are left alone. */
function findCamelCaseAttributes(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      // Same test as compat: a lowercase tag with no dash.
      if (/^[a-z][A-Za-z0-9]*$/.test(tag)) {
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) continue;
          const name = attr.name.getText(source);
          if (!COMPAT_CAMEL_PROPS.test(name)) continue;
          const { line } = source.getLineAndCharacterOfPosition(attr.getStart(source));
          found.push(`${fileName}:${line + 1} <${tag}> ${name} → ${kebabCase(name)}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("SVG attribute names in JSX", () => {
  it("flags camelCase presentation attributes on DOM elements only", () => {
    const text = [
      `const a = <svg viewBox="0 0 14 14" strokeWidth="1.3" stroke-linecap="round">`,
      `  <path fillRule="evenodd" d="M0 0" />`,
      `  <clipPath clipPathUnits="userSpaceOnUse"><rect /></clipPath>`,
      `  <marker markerWidth="4" />`,
      `</svg>;`,
      `const b = <Sparkline strokeWidth={2} />;`,
    ].join("\n");
    expect(findCamelCaseAttributes("icon.tsx", text)).toEqual([
      "icon.tsx:1 <svg> strokeWidth → stroke-width",
      "icon.tsx:2 <path> fillRule → fill-rule",
    ]);
  });

  it("no .tsx file under src uses a camelCase presentation attribute", () => {
    const files = (FS.readdirSync(srcRoot, { recursive: true }) as string[])
      .filter((file) => file.endsWith(".tsx"))
      .sort();
    expect(files).toContain(Path.join("renderer", "App.tsx"));
    const found = files.flatMap((file) =>
      findCamelCaseAttributes(
        Path.posix.join("src", ...file.split(Path.sep)),
        FS.readFileSync(Path.join(srcRoot, file), "utf8"),
      ));
    expect(found).toEqual([]);
  });
});
