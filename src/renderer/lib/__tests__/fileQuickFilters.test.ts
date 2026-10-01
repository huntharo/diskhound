import { describe, expect, it } from "vitest";

import { fileMatchesCategory, matchesFileCategory, filteredExtensionBuckets, overviewExtensionInventory } from "../fileQuickFilters";

describe("file category chips", () => {
  it("All matches every extension", () => {
    expect(matchesFileCategory(".mp4", "all")).toBe(true);
    expect(matchesFileCategory(".zzz", "all")).toBe(true);
  });

  it("filters a single category by extension", () => {
    expect(fileMatchesCategory({ extension: ".mp4" }, "video")).toBe(true);
    expect(fileMatchesCategory({ extension: ".MP4" }, "video")).toBe(true);
    expect(fileMatchesCategory({ extension: ".pdf" }, "video")).toBe(false);
    expect(fileMatchesCategory({ extension: ".pdf" }, "documents")).toBe(true);
    expect(fileMatchesCategory({ extension: ".zip" }, "archives")).toBe(true);
    expect(fileMatchesCategory({ extension: ".msi" }, "installers")).toBe(true);
  });
});

it("gives VM-owned raw images and ISOs the VM category", () => {
  const disk = { path: "/Users/me/.tart/vms/dev/disk.img", extension: ".img" };
  expect(fileMatchesCategory(disk, "virtual-machines")).toBe(true);
  expect(fileMatchesCategory(disk, "installers")).toBe(false);
  expect(fileMatchesCategory({ path: "/VM/Linux.utm/installer.iso", extension: ".iso" }, "installers")).toBe(false);
  expect(fileMatchesCategory({ path: "/Downloads/linux.iso", extension: ".iso" }, "installers")).toBe(true);
  expect(fileMatchesCategory({ path: "/Downloads/linux.iso", extension: ".iso" }, "archives")).toBe(false);
  expect(fileMatchesCategory({ path: "/photos/a.raw", extension: ".raw" }, "images")).toBe(true);
  expect(fileMatchesCategory({ path: "/VM/Linux.utm/a.raw", extension: ".raw" }, "images")).toBe(false);
});


it("builds VM extension totals from filtered files with linear work", () => {
  const count = (n: number) => {
    let reads = 0;
    const files = Array.from({ length: n }, (_, i) => ({
      get extension() { reads++; return `.vm-${i}`; },
      get size() { reads++; return 4096; },
    }));
    const buckets = filteredExtensionBuckets(files);
    expect(buckets).toHaveLength(n);
    expect(buckets.reduce((sum, b) => sum + b.size, 0)).toBe(n * 4096);
    return reads;
  };
  const small = count(100), large = count(800);
  expect(large).toBeLessThanOrEqual(small * 16);
  expect(large).toBeLessThanOrEqual(2_000);
});


it("preserves scan totals when matching files fall below the overview sample", () => {
  // The loaded largest-file sample contains no installers, but the
  // complete scan has smaller ISOs. Empty sample != empty category.
  const scanTotals = [{ extension: ".iso", size: 20_000, count: 20 }];
  expect(overviewExtensionInventory(scanTotals, [], "installers")).toEqual({ scope: "sample", buckets: [] });
  const all = overviewExtensionInventory(scanTotals, [], "all");
  expect(all.scope).toBe("scan");
  expect(all.buckets).toBe(scanTotals);
  expect(overviewExtensionInventory(scanTotals, [{ extension: ".iso", size: 1_000 }], "installers"))
    .toEqual({ scope: "sample", buckets: [{ extension: ".iso", size: 1_000, count: 1 }] });
});
