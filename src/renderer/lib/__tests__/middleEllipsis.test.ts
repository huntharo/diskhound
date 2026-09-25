import { describe, expect, it } from "vitest";

import { splitForMiddleEllipsis } from "../middleEllipsis";

const join = ({ head, tail }: { head: string; tail: string }) => head + tail;

describe("splitForMiddleEllipsis", () => {
  it("keeps short drive labels whole in the tail", () => {
    expect(splitForMiddleEllipsis("C:")).toEqual({ head: "", tail: "C:" });
    expect(splitForMiddleEllipsis("C:\\")).toEqual({ head: "", tail: "C:\\" });
    expect(splitForMiddleEllipsis("/")).toEqual({ head: "", tail: "/" });
    expect(splitForMiddleEllipsis("/home")).toEqual({ head: "", tail: "/home" });
  });

  it("pins the last segment of a mount path", () => {
    expect(splitForMiddleEllipsis("/mnt/data")).toEqual({ head: "/mnt", tail: "/data" });
    expect(splitForMiddleEllipsis("/media/user/USB")).toEqual({ head: "/media/user", tail: "/USB" });
    expect(splitForMiddleEllipsis("/Library/Developer/CoreSimulator/Volumes/iOS_21A342")).toEqual({
      head: "/Library/Developer/CoreSimulator/Volumes",
      tail: "/iOS_21A342",
    });
  });

  it("treats a trailing separator as part of the last segment", () => {
    expect(splitForMiddleEllipsis("/Volumes/Backup/")).toEqual({ head: "/Volumes", tail: "/Backup/" });
  });

  it("splits windows UNC paths on backslashes", () => {
    expect(splitForMiddleEllipsis("\\\\nas\\share")).toEqual({ head: "\\\\nas", tail: "\\share" });
  });

  it("caps a long last segment, starting the tail on a word break", () => {
    const cryptex =
      "/private/var/run/com.apple.security.cryptexd/mnt/com.apple.MobileAsset.MetalToolchain-v17.6.42.0.rIDLaA";
    expect(splitForMiddleEllipsis(cryptex, 12).tail).toBe(".42.0.rIDLaA");
    expect(splitForMiddleEllipsis(cryptex, 24).tail).toBe("-v17.6.42.0.rIDLaA");
    expect(splitForMiddleEllipsis("/Volumes/My Passport for Mac", 12).tail).toBe(" for Mac");
    expect(splitForMiddleEllipsis("/Volumes/SanDisk Extreme Pro 2TB Backup", 24).tail)
      .toBe(" Extreme Pro 2TB Backup");
  });

  it("hard-cuts a long segment when no word break is close", () => {
    expect(splitForMiddleEllipsis("/Volumes/ABCDEFGHIJKLMNOPQRSTUVWXYZ", 12)).toEqual({
      head: "/Volumes/ABCDEFGHIJKLMN",
      tail: "OPQRSTUVWXYZ",
    });
    // A break near the end would leave a stub tail, so it is ignored.
    expect(splitForMiddleEllipsis("/Volumes/ABCDEFGHIJKLMNOPQRSTUVW.X", 12).tail).toBe("NOPQRSTUVW.X");
  });

  it("always reassembles to the original label", () => {
    for (const label of ["", "/", "C:", "/a/b/c", "no-separators-but-quite-long-label", "/x/"]) {
      expect(join(splitForMiddleEllipsis(label, 8))).toBe(label);
    }
  });
});
