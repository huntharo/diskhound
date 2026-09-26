import { describe, expect, it } from "vitest";

import { parsePlist, parsePlistDict, plistDicts, plistNumber, plistString } from "../plist";

describe("parsePlist", () => {
  it("reads every scalar type diskutil emits", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<!-- comment -->
	<key>Name</key><string>Macintosh HD &amp; Data &lt;1&gt; &#x2014;</string>
	<key>Size</key><integer>1995165736960</integer>
	<key>Ratio</key><real>0.25</real>
	<key>Yes</key><true/>
	<key>No</key><false/>
	<key>When</key><date>2026-09-24T07:35:21Z</date>
	<key>Blob</key><data>
		AAEC
	</data>
	<key>Empty</key><string/>
	<key>List</key><array><integer>1</integer><dict><key>A</key><string>b</string></dict></array>
</dict>
</plist>`;
    expect(parsePlist(xml)).toEqual({
      Name: "Macintosh HD & Data <1> \u2014",
      Size: 1995165736960,
      Ratio: 0.25,
      Yes: true,
      No: false,
      When: Date.parse("2026-09-24T07:35:21Z"),
      Blob: "AAEC",
      Empty: "",
      List: [1, { A: "b" }],
    });
  });

  it("returns null for malformed or empty input", () => {
    expect(parsePlist("")).toBeNull();
    expect(parsePlist("Could not find disk for /Volumes/NotThere")).toBeNull();
    expect(parsePlist("<plist><dict><key>A</key></dict></plist>")).toBeNull();
    expect(parsePlist("<plist><dict><key>A</key><string>x</dict></plist>")).toBeNull();
  });

  it("typed accessors ignore missing keys and wrong types", () => {
    const dict = parsePlistDict("<plist><dict><key>N</key><string>7</string><key>L</key><array><string>x</string><dict/></array></dict></plist>");
    expect(plistNumber(dict, "N")).toBeNull();
    expect(plistString(dict, "N")).toBe("7");
    expect(plistString(dict, "missing")).toBeNull();
    expect(plistDicts(dict, "L")).toEqual([{}]);
    expect(parsePlistDict("<plist><array/></plist>")).toBeNull();
  });
});
