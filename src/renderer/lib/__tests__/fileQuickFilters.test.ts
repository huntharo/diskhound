import { describe, expect, it } from "vitest";

import { fileMatchesCategory, matchesFileCategory } from "../fileQuickFilters";

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
