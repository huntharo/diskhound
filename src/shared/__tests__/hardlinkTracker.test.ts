import { describe, expect, it } from "vitest";

import { compareEntryNames, HardlinkTracker } from "../hardlinkTracker";

describe("HardlinkTracker", () => {
  it("never flags single-link files", () => {
    const tracker = new HardlinkTracker();
    expect(tracker.isExtraLink({ dev: 1, ino: 10, nlink: 1 })).toBe(false);
    expect(tracker.isExtraLink({ dev: 1, ino: 10, nlink: 1 })).toBe(false);
    expect(tracker.inodesWithUnseenLinks).toBe(0);
  });

  it("lets the first link own the bytes and flags the rest", () => {
    const tracker = new HardlinkTracker();
    expect(tracker.isExtraLink({ dev: 1, ino: 10, nlink: 3 })).toBe(false);
    expect(tracker.isExtraLink({ dev: 1, ino: 10, nlink: 3 })).toBe(true);
    expect(tracker.isExtraLink({ dev: 1, ino: 10, nlink: 3 })).toBe(true);
    expect(tracker.extraLinks).toBe(2);
  });

  it("forgets an inode once every link is seen", () => {
    const tracker = new HardlinkTracker();
    tracker.isExtraLink({ dev: 1, ino: 10, nlink: 2 });
    expect(tracker.inodesWithUnseenLinks).toBe(1);
    tracker.isExtraLink({ dev: 1, ino: 10, nlink: 2 });
    expect(tracker.inodesWithUnseenLinks).toBe(0);
  });

  it("keeps inodes whose other links are outside the scan", () => {
    const tracker = new HardlinkTracker();
    tracker.isExtraLink({ dev: 1, ino: 10, nlink: 5 });
    tracker.isExtraLink({ dev: 1, ino: 10, nlink: 5 });
    expect(tracker.inodesWithUnseenLinks).toBe(1);
  });

  it("treats the same inode number on another device as another file", () => {
    const tracker = new HardlinkTracker();
    expect(tracker.isExtraLink({ dev: 1, ino: 10, nlink: 2 })).toBe(false);
    expect(tracker.isExtraLink({ dev: 2, ino: 10, nlink: 2 })).toBe(false);
  });

  it("matches number and bigint ids for the same inode", () => {
    const tracker = new HardlinkTracker();
    tracker.isExtraLink({ dev: 1, ino: 10, nlink: 2 });
    expect(tracker.isExtraLink({ dev: 1n, ino: 10n, nlink: 2 })).toBe(true);
  });
});

describe("compareEntryNames", () => {
  it("sorts by UTF-8 bytes like Rust's OsStr", () => {
    const names = ["b", "a.txt", "B", "\u{1F600}", "Ａ", "é", "a"];
    const utf8 = [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    expect([...names].sort(compareEntryNames)).toEqual(utf8);
  });
});
