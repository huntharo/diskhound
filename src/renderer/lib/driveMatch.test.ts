import { describe, expect, it } from "vitest";

import { owningDrive, rootKeyFor } from "./driveMatch";

const LINUX = ["/", "/home", "/var/log", "/var/cache/pacman/pkg", "/mnt/windows"];

describe("rootKeyFor", () => {
  it("keeps the unix root", () => {
    expect(rootKeyFor("/", "linux")).toBe("/");
    expect(rootKeyFor("//", "linux")).toBe("/");
  });

  it("trims a trailing slash on a normal path", () => {
    expect(rootKeyFor("/home/tom/", "linux")).toBe("/home/tom");
  });

  it("keeps a windows drive root and ignores case", () => {
    expect(rootKeyFor("C:\\", "win32")).toBe("c:");
    expect(rootKeyFor("C:\\Users\\", "win32")).toBe("c:\\users");
  });
});

describe("owningDrive", () => {
  it("assigns a root scan to / only", () => {
    expect(owningDrive(LINUX, "/", "linux")).toBe("/");
  });

  it("assigns a home path to /home, not /", () => {
    expect(owningDrive(LINUX, "/home/tom", "linux")).toBe("/home");
  });

  it("prefers the longer mount", () => {
    expect(owningDrive(LINUX, "/var/log/journal", "linux")).toBe("/var/log");
    expect(owningDrive(LINUX, "/var/cache/pacman/pkg/foo", "linux")).toBe("/var/cache/pacman/pkg");
  });

  it("does not treat /mnt/windows-backup as the windows mount", () => {
    expect(owningDrive(LINUX, "/mnt/windows-backup", "linux")).toBe("/");
    expect(owningDrive(LINUX, "/mnt/windows/Users", "linux")).toBe("/mnt/windows");
  });

  it("assigns windows paths to the drive letter", () => {
    const drives = ["C:\\", "D:\\"];
    expect(owningDrive(drives, "C:\\Users\\tom", "win32")).toBe("C:\\");
    expect(owningDrive(drives, "D:\\", "win32")).toBe("D:\\");
  });
});
