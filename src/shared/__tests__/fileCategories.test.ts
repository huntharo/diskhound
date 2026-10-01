import { describe, expect, it } from "vitest";
import { isInstallerFile, isVirtualMachineFile } from "../fileCategories";

const vmPaths = [
  "/Users/me/.tart/vms/build/disk.img", "/Users/me/.tart/vms/build/state.json",
  "/Users/me/VMs/Windows.vmwarevm/disk-s001.vmdk", "/Users/me/VMs/Windows.vmwarevm/snapshot.vmem",
  "/Users/me/VMs/Windows.vmwarevm/installer.iso", "/VM/Work.vmx", "/VM/Work-000001.vmdk",
  "/Users/me/VirtualBox VMs/Linux/Snapshots/uuid.sav", "/VM/Linux.vdi",
  "/VM/Windows.pvm/disk.hdd/snapshot.hds", "/VM/Linux.utm/Data/disk.img",
  "/VM/Linux.qcow2", "/VM/checkpoint.avhdx", "/VM/export.ova", "/VM/export.ovf",
  "/VM/guest.vhd", "/VM/guest.vhdx", "/VM/guest.vmcx", "/VM/guest.vmrs",
  "/Users/me/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw",
  "/Users/me/.minikube/machines/dev/disk.img", "/Users/me/.lima/default/diffdisk",
  "/Users/me/.colima/_lima/colima/basedisk",
];

describe("VM and installer file inventory", () => {
  it("recognizes VM formats, bundles and raw disks only in known layouts", () => {
    for (const path of vmPaths) {
      for (const spelled of [path, path.toUpperCase(), `C:${path.replaceAll("/", "\\")}`, `\\\\nas\\share${path.replaceAll("/", "\\")}`]) {
        expect(isVirtualMachineFile(spelled), spelled).toBe(true);
      }
    }
    for (const path of [
      "/photos/camera.raw", "/downloads/image.img", "/games/save.sav", "/source/vms/disk.img",
      "/Users/me/.tart/config.json", "/Users/me/.tart/vms-notes/disk.img",
      "/Users/me/.lima/_config/diffdisk", "/Users/me/.colima/default/config.yaml",
      "/VM/archive.vmwarevm-backup/disk.img", "/VM/disk.vmdk.txt",
      "/Users/me/.miniKube/machines/dev/disk.img",
    ]) expect(isVirtualMachineFile(path), path).toBe(false);
  });

  it("keeps ISO/DMG installers separate from VM-owned installation media", () => {
    for (const extension of [".iso", ".dmg", ".msi", ".pkg", ".deb", ".rpm", ".msixbundle"]) {
      expect(isInstallerFile(`/downloads/setup${extension}`, extension.toUpperCase())).toBe(true);
      expect(isInstallerFile(`/VM/work.utm/setup${extension}`, extension)).toBe(false);
    }
    expect(isInstallerFile("/VM/disk.vmdk", ".vmdk")).toBe(false);
    expect(isInstallerFile("/photos/camera.raw", ".raw")).toBe(false);
  });

  it("scales linearly with file count and ambiguous path depth", () => {
    const count = (files: number, depth: number) => {
      const path = `/data${"/vms/not-a-vm".repeat(depth)}/photo.raw`;
      const work = { segments: 0 };
      for (let i = 0; i < files; i++) expect(isVirtualMachineFile(path, undefined, work)).toBe(false);
      return work.segments;
    };
    const small = count(100, 10);
    expect(count(800, 10)).toBeLessThanOrEqual(small * 16);
    expect(count(100, 80)).toBeLessThanOrEqual(small * 16);
    expect(count(800, 80)).toBeLessThanOrEqual(140_000);
  });
});
