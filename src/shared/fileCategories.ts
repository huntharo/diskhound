/** File inventory categories, not evidence that a file is disposable. */
export const INSTALLER_EXTENSIONS = new Set([
  ".appx", ".appxbundle", ".dmg", ".exe", ".iso", ".msi", ".msix", ".msixbundle",
  ".pkg", ".deb", ".rpm", ".apk", ".appimage",
]);

export const VM_EXTENSIONS = new Set([
  ".vdi", ".vmdk", ".vhd", ".vhdx", ".avhd", ".avhdx", ".qcow", ".qcow2", ".qed",
  ".vbox", ".vbox-prev", ".vmx", ".vmxf", ".vmsd", ".vmsn", ".vmss", ".vmem",
  ".vmcx", ".vmrs", ".vmgs", ".hds", ".hdd", ".pvm", ".vmwarevm", ".utm", ".ova", ".ovf", ".xva",
]);

export const VM_SPACE_NOTE = "VM disks and snapshots can share blocks and depend on one another. Displayed size is not guaranteed reclaimable space. Manage snapshots in the VM application.";

/** Test-only operation counter for path-depth and file-count scaling. */
export interface FileCategoryWork { segments: number }

export function isVirtualMachineFile(path: string, extension?: string, work?: FileCategoryWork): boolean {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const last = parts.at(-1) ?? "";
  const dot = last.lastIndexOf(".");
  const ext = (extension ?? (dot >= 0 ? last.slice(dot) : "")).toLowerCase();
  if (VM_EXTENSIONS.has(ext)) return true;
  for (let i = 0; i < parts.length; i++) {
    if (work) work.segments++;
    const part = /^[\x00-\x7f]*$/.test(parts[i]!) ? parts[i]!.toLowerCase() : parts[i]!;
    // Bundles contain raw disks, memory snapshots and metadata whose
    // individual extensions do not establish VM ownership.
    if (/\.(?:vmwarevm|pvm|utm|hdd)$/.test(part)) return true;
    const next = (parts[i + 1] ?? "").toLowerCase();
    if (part === ".tart" && next === "vms" && i + 3 < parts.length) return true;
    if (part === "virtualbox vms" && i + 2 < parts.length) return true;
    if (part === ".minikube" && next === "machines" && i + 3 < parts.length) return true;
    if (part === "com.docker.docker" && next === "data"
      && (parts[i + 2] ?? "").toLowerCase() === "vms" && i + 4 < parts.length) return true;
    // Lima/Colima use extensionless disk files. Do not classify their
    // entire configuration/tool home as a VM.
    const limaDisk = part === ".lima" && !next.startsWith("_") && parts.length === i + 3;
    const colimaDisk = part === ".colima" && next === "_lima" && parts.length === i + 4;
    if ((limaDisk || colimaDisk) && /^(?:diffdisk|basedisk|cidata\.iso)$/.test(last.toLowerCase())) return true;
  }
  return false;
}

export function isInstallerFile(path: string, extension: string): boolean {
  return INSTALLER_EXTENSIONS.has(extension.toLowerCase()) && !isVirtualMachineFile(path, extension);
}
