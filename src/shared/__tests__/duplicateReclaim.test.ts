import { describe, expect, it } from "vitest";

import type { DuplicateGroup } from "../contracts";
import { duplicateGroupReclaimable, fileReclaim, groupReclaim, groupSharing } from "../duplicateReclaim";

const entry = (path: string, extra: Partial<DuplicateGroup["files"][number]> = {}) => ({
  path,
  name: path,
  parentPath: "/",
  modifiedAt: 0,
  ...extra,
});

describe("fileReclaim", () => {
  it("frees nothing for a name of a hardlinked file", () => {
    expect(fileReclaim({ size: 100, linkId: "1:2" })).toEqual({ bytes: 0, sharing: "hardlink" });
    // A hardlinked clone is still a hardlink first.
    expect(fileReclaim({ size: 100, linkId: "1:2", privateBytes: 40 })).toEqual({ bytes: 0, sharing: "hardlink" });
  });

  it("frees a clone's private bytes, and the full size when nothing is shared", () => {
    expect(fileReclaim({ size: 100, privateBytes: 40 })).toEqual({ bytes: 40, sharing: "clone" });
    expect(fileReclaim({ size: 100, privateBytes: 100 })).toEqual({ bytes: 100 });
    expect(fileReclaim({ size: 100 })).toEqual({ bytes: 100 });
  });
});

describe("groupReclaim", () => {
  it("keeps the copy whose deletion frees least", () => {
    expect(groupReclaim([{ reclaimableBytes: 0 }, {}, {}], 100)).toBe(200);
    expect(groupReclaim([{ reclaimableBytes: 0 }, { reclaimableBytes: 0 }], 100)).toBe(0);
    expect(groupReclaim([{}, {}, {}], 100)).toBe(200);
    expect(groupReclaim([{}], 100)).toBe(0);
  });
});

describe("duplicateGroupReclaimable", () => {
  it("uses the scan's figure, or (copies − 1) × size for older results", () => {
    const files = [entry("/a"), entry("/b"), entry("/c")];
    expect(duplicateGroupReclaimable({ hash: "h", size: 10, files })).toBe(20);
    expect(duplicateGroupReclaimable({ hash: "h", size: 10, files, reclaimableBytes: 0 })).toBe(0);
  });

  it("counts shared copies by kind", () => {
    const group: DuplicateGroup = {
      hash: "h",
      size: 10,
      files: [entry("/a", { sharing: "hardlink" }), entry("/b", { sharing: "clone" }), entry("/c")],
    };
    expect(groupSharing(group)).toEqual({ hardlinks: 1, clones: 1 });
  });
});
