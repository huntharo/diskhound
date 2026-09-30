Vendored from `dua-core` 4.1.0 (MIT, Sebastian Thiel).

DiskHound adds `ATTR_CMNEXT_REALDEVID` to the existing APFS bulk directory
read and exposes it as `Metadata::real_dev()`. APFS System and Data volumes
can share the ordinary `st_dev`, while clone IDs are scoped to the real
volume. Keep the crate local until the upstream API exposes this identity.
