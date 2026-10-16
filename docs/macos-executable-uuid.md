# macOS launcher UUIDs

DiskHound personalizes only the staged `Contents/MacOS/DiskHound` executable's
`LC_UUID` commands in electron-builder's `afterPack` hook. The bundle ID remains
`com.diskhound.app`. Installed applications are never patched.

The UUID is SHA-256 of the JSON array `[appId, appVersion, electronVersion]`, a NUL,
the decimal CPU type, a NUL, and the decimal CPU subtype, truncated to 16 bytes
with RFC 9562 version 8 and variant bits. It separates apps, releases, Electron
versions and architectures while remaining deterministic. Repeated thin and
universal `afterPack` calls produce the same bytes and do not rewrite an unchanged
file. Little-endian 64-bit Intel/ARM executables and big-endian FAT/FAT64 containers
are supported; unexpected or malformed layouts fail the build.

Apple's [TN3178](https://developer.apple.com/documentation/technotes/tn3178-checking-for-and-resolving-build-uuid-problems)
and [TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)
describe build UUID collisions and local network privacy. This fixes the observed
launcher collision; we have not reproduced a DiskHound networking failure.

## Signing contract

Changing `LC_UUID` invalidates the executable's existing signature. The hook runs
before electron-builder signs the final bundle, including after its universal
merge. `mac.identity: "-"` explicitly requests ad-hoc signing, including Intel-only
builds, where builder otherwise may skip signing without a certificate. This does
not provide Developer ID trust or notarization.

The hook rejects a missing/null signing identity and cases where the installed
builder's `isSignAllowed` would skip signing (for example PR builds without
`CSC_FOR_PULL_REQUEST=true`). This uses the same helper as the locked builder;
recheck that contract when upgrading electron-builder. The `afterSign` hook checks
that the launcher still has its expected UUIDs, then runs:

```sh
codesign --verify --deep --strict --all-architectures path/to/DiskHound.app
```

Any failure aborts packaging before the DMG is created. Do not disable these hooks
or use `--prepackaged` to bypass UUID processing. When Developer ID signing is
introduced, replace `mac.identity: "-"` with the certificate identity and configure
notarization; retain both hooks. Do not rewrite signed release artifacts.

## Symbols

The upstream Electron **launcher** dSYM and Breakpad symbol identifiers no longer
match the personalized launcher. If launcher symbols are distributed or uploaded,
create app-specific copies with each architecture's UUID matching the packaged
launcher before generating/uploading symbols; retain the stock-to-app mapping.
Do not claim stock launcher symbols match. DiskHound currently has no launcher
symbol publishing pipeline. Electron Framework and helper UUIDs are unchanged, so
their upstream symbol identities remain usable.

## Release audit and validation

Inspected the published [v0.6.2 universal DMG](https://github.com/tzarebczan/diskhound/releases/tag/v0.6.2)
and the exact [Electron 40.6.0](https://github.com/electron/electron/releases/tag/v40.6.0)
macOS executables. Mounted the DMG read-only with `hdiutil attach -readonly
-nobrowse -noautoopen`; read the stock executables directly from their ZIPs. No
application was launched or installed.

| Architecture | Published DiskHound and stock Electron UUID | Personalized local v0.6.2 build |
| --- | --- | --- |
| x86_64 | `4C4C44BF-5555-3144-A132-1C6F3A38859E` | `0EBE3624-DD5B-814D-9FEB-07C8FF18CB29` |
| arm64 | `4C4C445A-5555-3144-A135-D1BBDECA15FC` | `39593F01-30C4-80AA-ABEE-5D12CD0A21C9` |

Published artifact SHA-256:

```text
DiskHound-universal.dmg
2a3c5896186b9227d53ee7efd593d73a1c2a92d70b0eab0cf2abcfe94a2619d3
electron-v40.6.0-darwin-x64.zip
3d87f73c023ca2799c54f6b70f4d4a93de6b499d1e30ae1051ac16fcba0ab47c
electron-v40.6.0-darwin-arm64.zip
50eb91f1ecd5113b8b2483f00116f5c4a0a473f4684fac37da4293abcd7beef3
```

The published app reports `Signature=adhoc`, `TeamIdentifier=not set`, and
`Identifier=com.diskhound.app`; deep/strict signature verification passes.

Local validation used locked electron-builder 26.8.1 and Electron 40.6.0:

- Built the renderer/Electron code and packaged the actual universal DMG with
  `CSC_IDENTITY_AUTO_DISCOVERY=false bunx electron-builder --config
  electron-builder.yml --mac --publish never`. Reused the published universal
  Rust scanner as a packaging input; the scanner was not rebuilt or changed.
- Mounted the newly built DMG read-only. Its app passes deep/strict signature
  verification for **all architectures**, reports an ad-hoc signature with the
  unchanged bundle ID, and has the personalized UUIDs above. Electron Framework
  UUIDs match the original release on both architectures.
- Parser tests cover thin, FAT/FAT64, architecture/version separation, idempotency,
  unchanged non-UUID bytes, and malformed input rejection.
- macOS tests compile inert Intel, ARM and universal fixture launchers without
  running them. They demonstrate that UUID mutation invalidates an existing
  signature, that final verification rejects it, that ad-hoc re-signing restores
  validity, and that a repeated hook preserves the signature and file mtime.
  These run through the existing macOS Vitest CI job; no signing credentials are
  needed. Non-macOS CI runs the parser and signing-policy tests.

This is packaging-only filesystem I/O, with no new runtime event/timer writes or
per-file/per-folder scan loops.
