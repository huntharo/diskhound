import { describe, expect, it } from "vitest";

import { devBranchDisplay } from "../devBranchDisplay";

describe("devBranchDisplay", () => {
  it("shows and copies the branch name", () => {
    const display = devBranchDisplay({ name: "feat/dev-branch-chip", detached: false });
    expect(display.label).toBe("feat/dev-branch-chip");
    expect(display.copyText).toBe("feat/dev-branch-chip");
    expect(display.title).toBe("feat/dev-branch-chip\nClick to copy the branch name");
  });

  it("keeps five leading characters, the ellipsis and the tail at the narrowest", () => {
    // Narrowest: "codex…-214447" and "feat/…-chip".
    const long = devBranchDisplay({ name: "codex/branch-name-ui-display-214447", detached: false });
    expect(long.tailChars).toBe(7);
    expect(long.minChars).toBe(5 + 1 + 7);
    const short = devBranchDisplay({ name: "feat/dev-branch-chip", detached: false });
    expect(short.tailChars).toBe(5);
    expect(short.minChars).toBe(5 + 1 + 5);
  });

  it("never elides a short name", () => {
    expect(devBranchDisplay({ name: "main", detached: false }).minChars).toBe(4);
    expect(devBranchDisplay({ name: "fix/abc", detached: false }).minChars).toBe(7);
  });

  it("shows a short SHA on a detached HEAD but copies the full one", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const display = devBranchDisplay({ name: sha, detached: true });
    expect(display.label).toBe("HEAD 01234567");
    expect(display.copyText).toBe(sha);
    expect(display.ariaLabel).toBe(`Copy commit ${sha}`);
  });
});
