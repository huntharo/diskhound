# VM and installer file inventory

Largest Files and Overview offer a **Virtual machines** filter separate
from developer artifacts and installers. It recognizes VM disk formats,
snapshot/state formats and conventional VM bundles/paths:

| Systems/layouts | Evidence |
| --- | --- |
| Tart | `.tart/vms/<name>/…` |
| VMware Fusion / Workstation / ESXi | `.vmwarevm` bundles; VMDK, VMX/VMXF and VMSD/VMSN/VMSS/VMEM formats |
| VirtualBox | `VirtualBox VMs/<name>/…`, VDI and VBOX files |
| Parallels | `.pvm` / `.hdd` bundles, HDS disk parts |
| UTM / QEMU | `.utm` bundles, QCOW/QCOW2 and QED formats |
| Hyper-V / WSL and compatible virtual disks | VHD/VHDX, AVHD/AVHDX, VMCX/VMRS/VMGS formats |
| Exported appliances | OVA, OVF, XVA |
| Container VM backends | Docker Desktop `com.docker.docker/Data/vms`, Minikube machines, known Lima/Colima disk filenames |

File format recognition does not prove which hypervisor owns a standalone
disk. A disk may have moved or be used by a compatible system. Ordinary
`.img`, camera `.raw` and game `.sav` files require VM path context before
matching. The classifier reads path strings only; it opens no images and
does not contact or start a VM manager. Custom locations for raw disks
remain unclassified until stronger evidence is available.

The filters use existing scan sizes (allocated sizes when the scan records
them), without interpreting a virtual disk's maximum capacity as host disk
usage. They do not claim unique reclaimable bytes or identify independent
snapshots. Snapshot chains may share blocks and require merges on deletion.
The UI directs users to manage snapshots in the VM application. This is an
inventory category, not a new VM cleanup recommendation or automatic deletion.
Known VM contents are excluded from Easy Mode's generic cache, temp, old
download and media suggestions. A Docker VM disk is not a Docker image.

ISO and DMG files already appeared in the Installers file filter. Easy Mode
now shares that extension set (including ISO), and ISO no longer also
appears under Archives or Large Media. Recognized VM-owned media remain
under Virtual machines. Installer-like extensions are candidates, not
proof that content is expendable: an EXE may be a portable program and an
ISO/DMG may contain valuable data. Old installer suggestions therefore say
to review contents and use medium risk rather than assuming installation.

Category switches run over existing file records, with no new filesystem
walk. Tests count operations at N and 8N, including path depth, directory
counts and extension diversity, with absolute caps. Integration tests scan
synthetic VM bundles, raw photos, ISOs and DMGs and check both UI filters
and cleanup analysis. Snapshot and streamed-index cleanup are tested for
agreement.

See [VirtualBox differencing images](https://docs.oracle.com/en/virtualization/virtualbox/7.1/user/storage.html),
[VMware snapshot design](https://www.vmware.com/docs/vsphere-vm-snapshots-perf),
and [Tart storage notes](https://tart.run/faq/) for the storage-sharing limits.
