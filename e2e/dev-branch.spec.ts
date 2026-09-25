import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "./fixtures/electron-app";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** What the header chip should show for this checkout. CI checks out a
 *  pull request as a detached merge commit, so both cases get run. */
function checkout(): { label: string; copyText: string; accessibleName: string } {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const branch = git("symbolic-ref", "--quiet", "--short", "HEAD");
    return { label: branch, copyText: branch, accessibleName: `Copy branch name ${branch}` };
  } catch {
    const sha = git("rev-parse", "HEAD");
    return { label: `HEAD ${sha.slice(0, 8)}`, copyText: sha, accessibleName: `Copy commit ${sha}` };
  }
}

test("names the checkout's branch in the header and copies it on click", async ({ launch }) => {
  const { app, page } = await launch();
  const expected = checkout();

  const chip = page.locator(".header").getByRole("button", { name: expected.accessibleName, exact: true });
  await expect(chip).toBeVisible();
  // The elision is CSS only, so the DOM holds the whole label.
  await expect(chip).toHaveText(expected.label);

  await chip.click();
  await expect(page.locator(".dev-branch-chip.copied")).toBeVisible();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(expected.copyText);
});

test("the branch chip stays clear of the header buttons at the minimum width", async ({ launch }) => {
  const { app, page } = await launch();
  const chip = page.locator(".dev-branch-chip");
  await expect(chip).toBeVisible();

  // Content size, not window size: 960 is the window's minWidth, and
  // on Windows the frame would take a few pixels of it.
  await (await app.browserWindow(page)).evaluate((win) => win.setContentSize(960, 720));
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(960);

  const [chipBox, utilitiesBox, pillsBox] = await Promise.all(
    [chip, page.locator(".header-utilities"), page.locator(".drive-pills")].map((locator) => locator.boundingBox()),
  );
  expect(chipBox && utilitiesBox && pillsBox).toBeTruthy();
  expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(utilitiesBox!.x);
  expect(chipBox!.x).toBeGreaterThanOrEqual(pillsBox!.x + pillsBox!.width);
});
