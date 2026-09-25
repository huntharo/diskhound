import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ICON_SIZES, integrateLinuxDesktop } from "../linuxDesktopIntegration";
import { expectIoBudget, measureFsIo } from "../test/ioBudget";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFsPromises(await importOriginal()));

const spawned = vi.hoisted(() => [] as string[]);
vi.mock("node:child_process", () => ({
  spawn: (command: string) => {
    spawned.push(command);
    return { on: () => undefined, unref: () => undefined };
  },
}));

let tempDir: string;
let homeDir: string;
let iconsDir: string;
const platform = process.platform;

beforeEach(async () => {
  tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-linux-io-"));
  homeDir = Path.join(tempDir, "home");
  iconsDir = Path.join(tempDir, "resources", "icons");
  await FSP.mkdir(iconsDir, { recursive: true });
  for (const size of ICON_SIZES) {
    await FSP.writeFile(Path.join(iconsDir, `${size}x${size}.png`), Buffer.alloc(size * 8, size % 251));
  }
  Object.defineProperty(process, "platform", { value: "linux" });
  spawned.length = 0;
});

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: platform });
  await FSP.rm(tempDir, { recursive: true, force: true });
});

const launch = () => integrateLinuxDesktop({ homeDir, iconsDir, execPath: "/opt/DiskHound/diskhound" });
const installedIcon = (size: number) =>
  Path.join(homeDir, ".local", "share", "icons", "hicolor", `${size}x${size}`, "apps", "diskhound.png");

describe("Linux desktop integration", () => {
  it("installs the icons and the .desktop file on first launch", async () => {
    const { io } = await measureFsIo(launch);

    expectIoBudget({
      scenario: "linux-integration-first-launch",
      note: "first launch: 10 hicolor icons, the .desktop file, then update-desktop-database and gtk-update-icon-cache",
      io,
    });
    expect(FS.readFileSync(installedIcon(512))).toEqual(FS.readFileSync(Path.join(iconsDir, "512x512.png")));
    expect(spawned).toEqual(["update-desktop-database", "gtk-update-icon-cache"]);
  });

  it("writes nothing and refreshes no cache when a later launch finds everything in place", async () => {
    await launch();
    spawned.length = 0;

    const { io } = await measureFsIo(launch);

    expectIoBudget({
      scenario: "linux-integration-relaunch",
      note: "every later launch with the same icons and exec path: reads to compare, 0 writes, no cache refresh",
      io,
    });
    expect(spawned).toEqual([]);
  });

  it("recopies only the icons that changed", async () => {
    await launch();
    spawned.length = 0;
    await FSP.writeFile(Path.join(iconsDir, "48x48.png"), Buffer.alloc(999, 1));

    const { io } = await measureFsIo(launch);

    expectIoBudget({
      scenario: "linux-integration-icon-changed",
      note: "a launch after an update changed one icon: 1 icon copied, then gtk-update-icon-cache",
      io,
    });
    expect(FS.readFileSync(installedIcon(48))).toHaveLength(999);
    expect(spawned).toEqual(["gtk-update-icon-cache"]);
  });
});
