import { describe, expect, it } from "vitest";
import { expectNearLinear, measureOps } from "../../testing/opCounter";
import { MacSystemMetadataTracker, macSystemMetadataPaths } from "../macSystemMetadata";

const events = "/System/Volumes/Data/.fseventsd";
const spotlight = "/System/Volumes/Data/.Spotlight-V100";

describe("macOS system metadata coverage", () => {
  it("uses canonical Data paths and external volume scope", () => {
    expect(macSystemMetadataPaths("/Users/me")).toEqual([events, spotlight]);
    expect(macSystemMetadataPaths("/Volumes/My Disk/photos"))
      .toEqual(["/Volumes/My Disk/.fseventsd", "/Volumes/My Disk/.Spotlight-V100"]);
    expect(new MacSystemMetadataTracker("/Users/me").snapshot(true)[0].status).toBe("outside-scan");
    expect(new MacSystemMetadataTracker(events).snapshot(true)[0].status).toBe("unavailable");
  });

  it("never equates failed, unobserved or unfinished collection with zero", () => {
    const t = new MacSystemMetadataTracker("/");
    expect(t.snapshot(true)[0]).toMatchObject({ bytes: null, status: "unavailable" });
    t.directory(events);
    expect(t.snapshot(false)[0]).toMatchObject({ bytes: null, status: "unavailable" });
    t.uncertain(events);
    expect(t.snapshot(true)[0]).toMatchObject({ bytes: null, status: "unavailable" });
    t.file(`${events}/log`, 20_585_635_840);
    expect(t.snapshot(true)[0]).toMatchObject({ bytes: 20_585_635_840, status: "incomplete" });
  });

  it("measures uncapped allocated bytes without firmlink aliases or prefix lookalikes", () => {
    const t = new MacSystemMetadataTracker("/");
    t.file(`${spotlight}/store`, 8_597_852_160);
    t.file(`/.Spotlight-V100/store`, 8_597_852_160);
    t.file(`${spotlight}-copy/store`, 8_597_852_160);
    t.file(`${spotlight}/hardlink`, 0);
    t.uncertain("/Users/unreadable");
    expect(t.snapshot(true)[1]).toMatchObject({ bytes: 8_597_852_160, status: "complete" });
    t.uncertain(null);
    expect(t.snapshot(true)[1].status).toBe("incomplete");
  });

  it("only reports zero for an observed, complete empty store", () => {
    const t = new MacSystemMetadataTracker("/");
    t.directory(events);
    expect(t.snapshot(true)[0]).toMatchObject({ bytes: 0, status: "complete" });
  });

  it("always walks stores and their ancestors rather than reusing directory mtimes", () => {
    const t = new MacSystemMetadataTracker("/");
    expect(t.requiresWalk("/")).toBe(true);
    expect(t.requiresWalk("/System")).toBe(true);
    expect(t.requiresWalk(`${spotlight}/nested`)).toBe(true);
    expect(t.requiresWalk("/Users")).toBe(false);
  });

  it("tracks file and folder operations near linearly at N and 8N", async () => {
    const run = (n: number) => {
      const t = new MacSystemMetadataTracker("/");
      for (let i = 0; i < n; i++) {
        t.file(`${events}/log`, 4096);
        t.file("/Users/me/file", 4096);
        t.directory("/Users/me/folder");
        t.requiresWalk("/Users/me/folder");
      }
      return t.snapshot(true);
    };
    const small = await measureOps(() => run(1000));
    const large = await measureOps(() => run(8000));
    expectNearLinear("system metadata", small.ops, large.ops, { maxTotal: 200_000 });
    expect(large.result[0].bytes).toBe(8000 * 4096);
  });
});
