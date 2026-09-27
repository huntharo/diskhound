# Docker inventory

The Docker tab is independent of filesystem scans. Refresh explicitly invokes the installed Docker CLI; it never starts Docker Desktop or the daemon. The CLI must be on DiskHound's PATH. A stopped daemon, missing CLI, unsupported response, timeout, or output overflow produces an error instead of a filesystem-based estimate.

## Evidence and provenance

The existing filesystem artifact detector has no Docker-aware inventory; a Docker.raw fixture describes a VM disk, not disposable images. This feature adds no path-based Docker classification and never deletes Docker.raw, VHDX, volumes, or VM bundles.

Docker's [image inspection API](https://docs.docker.com/reference/api/engine/version/v1.40/#tag/Image/operation/ImageInspect) exposes image configuration, tags, digests, layers and creation metadata, but no authoritative local acquisition history. [Build attestations](https://docs.docker.com/build/metadata/attestations/) describe how an image was built, and can accompany distributed images; they do not establish that this host built it. A tag, digest, label, creation time or build-history entry is insufficient to distinguish a local build from a pull, load, or an image that was both built and pulled. Consequently every image's acquisition provenance is **unknown**. There is no guessed pulled/local classification.

## Inventory and sizes

Context resolution follows DOCKER_CONTEXT, then DOCKER_HOST, then `docker context show` / `context inspect`. Only absolute Unix sockets and local Windows named pipes are accepted. TCP (including localhost), SSH and remote named pipes are rejected before daemon requests. A local socket may itself be a user-managed proxy; the app cannot establish the physical location behind it.

The endpoint is pinned with `--host` and conflicting Docker context/host/TLS environment variables are removed for daemon commands. Read-only commands:

- `docker --host ENDPOINT system df --verbose --format '{{json .Images}}'`
- `docker --host ENDPOINT system df --format '{{json .}}'`

The verbose formatter exposes full IDs, first tag, logical/shared/unique sizes and container reference count. These are Docker-formatted sizes, not exact byte counts. The [Docker CLI formatter](https://github.com/docker/cli/blob/v28.5.1/cli/command/formatter/disk_usage.go) supplies image rows separately from container, volume and build-cache summaries. Image tags shown are only the first tag Docker reports. Unknown usage prevents removal.

[Docker documents shared versus unique size](https://docs.docker.com/reference/cli/docker/system/df/). Logical sizes cannot be summed without double-counting layers. Unique size is not promised reclaimable space, and Docker's aggregate reclaimable estimate is not promised host filesystem savings. Separate requests may see different moments in time. External buildx builders can hold additional cache not covered here. Removing image content need not shrink Docker Desktop's virtual disk.

## Scoped cleanup

An unused image's Remove action opens a native confirmation naming the full ID, endpoint, unknown provenance and potential loss of an unreproducible local build. After confirmation the app re-reads image references on the pinned endpoint, then executes only:

`docker --host ENDPOINT image rm --no-prune sha256:FULL_ID`

[Docker enforces removal conflicts](https://docs.docker.com/reference/cli/docker/image/rm/) including multiple tags and container references. There is no `--force`, tag-by-tag fallback, parent pruning, broad prune, or volume/container/build-cache deletion. All local platform variants of the selected image are targeted. Cancellation or timeout during removal does not imply rollback; refresh before retrying. A user could replace the daemon behind the same socket; endpoint pinning does not lock daemon identity.

## Work and I/O bounds

One operation runs at a time. Each CLI invocation is asynchronous, cancellable, limited to 20 seconds and 8 MiB of output. Context resolution adds up to two CLI calls; refresh uses two daemon requests. Unmount and app quit abort active work. Image normalization is one pass, capped at 50,000 images; the renderer shows at most 100 image rows per page. Operation-count tests cover 1,000 and 8,000 images with an absolute read-count cap. No recurring polls, inventory persistence or application filesystem writes are added, so there is no recurring SSD write budget to record. Explicit image deletion changes Docker-owned storage and is only tested with a fake runner; development does not delete real Docker data.

Tests cover CLI bounds/environment/cancellation, local and remote endpoint selection, unknown provenance, shared size display, stopped/unavailable daemon behavior, in-use images, stale usage, invalid IDs, confirmation cancellation, conflict propagation and operation-count scaling. The Electron UI spec stubs Docker IPC before opening the tab, so it cannot contact or mutate a real daemon.
