//! Owned Windows test fixtures. Only files created in this directory are
//! changed; the volume is opened read-only and no journal settings are set.
use super::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{DACL_SECURITY_INFORMATION, GetFileSecurityW, SetFileSecurityW};

struct Volume(HANDLE);
impl Drop for Volume {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

struct OwnedDir(PathBuf);
impl OwnedDir {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "diskhound-usn-test-{}-{nonce}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        // Never reuse an existing directory, even after a crashed test.
        std::fs::create_dir(&path).unwrap();
        let mut dir = Self(path);
        // Expand Windows TEMP's 8.3 aliases before constructing expectations.
        let canonical = std::fs::canonicalize(&dir.0).unwrap();
        let text = canonical.to_str().unwrap();
        dir.0 = PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(text));
        dir
    }
}
impl Drop for OwnedDir {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            eprintln!(
                "USN fixture cleanup failed at {}: {error}",
                self.0.display()
            );
        }
    }
}

pub(super) struct Fixture {
    volume: Volume,
    dir: OwnedDir,
}
impl Fixture {
    pub(super) fn new() -> Option<Self> {
        let dir = OwnedDir::new();
        let drive = dir.0.to_str().unwrap().chars().next().unwrap();
        let volume = match open_volume(drive) {
            Ok(handle) => Volume(handle),
            Err(error) => return Self::unavailable(format!("cannot open volume {drive}: {error}")),
        };
        if let Err(error) = query_journal(volume.0) {
            return Self::unavailable(format!("no readable USN journal on {drive}: {error}"));
        }
        Some(Self { volume, dir })
    }

    fn unavailable(reason: String) -> Option<Self> {
        assert!(
            std::env::var("DISKHOUND_REQUIRE_USN_TESTS").as_deref() != Ok("1"),
            "required Windows USN test unavailable: {reason}"
        );
        eprintln!(
            "USN test skipped: {reason}; set DISKHOUND_REQUIRE_USN_TESTS=1 to require access"
        );
        None
    }

    pub(super) fn root(&self) -> &Path {
        &self.dir.0
    }
    pub(super) fn volume(&self) -> HANDLE {
        self.volume.0
    }
    pub(super) fn cursor(&self) -> JournalInfo {
        query_journal(self.volume()).unwrap()
    }
    pub(super) fn changes(&self, before: JournalInfo) -> Vec<OutputLine> {
        collect_changes(
            self.volume(),
            before.journal_id,
            before.next_usn,
            self.cursor().next_usn,
        )
        .unwrap()
    }

    /// Deny FILE_READ_ATTRIBUTES on a brand-new fixture file only. No
    /// inheritance, privileges, parent ACLs or pre-existing files are changed.
    pub(super) fn deny_attributes_on_new_file(&self) -> DeniedAttributes {
        let path = self.root().join("permission.bin");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        file.write_all(b"owned USN permission fixture").unwrap();
        drop(file);
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut needed = 0;
        unsafe {
            GetFileSecurityW(
                wide.as_ptr(),
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                0,
                &mut needed,
            )
        };
        assert!(
            needed > 0,
            "cannot size fixture DACL: {}",
            io::Error::last_os_error()
        );
        let mut original = vec![0u8; needed as usize];
        assert_ne!(
            unsafe {
                GetFileSecurityW(
                    wide.as_ptr(),
                    DACL_SECURITY_INFORMATION,
                    original.as_mut_ptr().cast(),
                    needed,
                    &mut needed,
                )
            },
            0,
            "cannot save fixture DACL: {}",
            io::Error::last_os_error()
        );

        // Deny attribute reads to everyone; retain full control for the
        // owner so the guard can restore the original ACL even after a panic.
        let sddl: Vec<u16> = "D:(D;;0x80;;;WD)(A;;FA;;;OW)"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                )
            },
            0,
            "cannot construct fixture DACL: {}",
            io::Error::last_os_error()
        );
        let mut guard = DeniedAttributes {
            path,
            wide,
            original,
            active: true,
        };
        let ok =
            unsafe { SetFileSecurityW(guard.wide.as_ptr(), DACL_SECURITY_INFORMATION, descriptor) };
        let error = io::Error::last_os_error();
        unsafe { LocalFree(descriptor) };
        if ok == 0 {
            guard.active = false;
            panic!("cannot deny fixture attribute reads: {error}");
        }
        guard
    }
}

pub(super) struct DeniedAttributes {
    pub(super) path: PathBuf,
    wide: Vec<u16>,
    original: Vec<u8>,
    active: bool,
}
impl DeniedAttributes {
    pub(super) fn restore(&mut self) -> io::Result<()> {
        if self.active {
            if unsafe {
                SetFileSecurityW(
                    self.wide.as_ptr(),
                    DACL_SECURITY_INFORMATION,
                    self.original.as_mut_ptr().cast(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            self.active = false;
        }
        Ok(())
    }
}
impl Drop for DeniedAttributes {
    fn drop(&mut self) {
        if let Err(error) = self.restore() {
            eprintln!(
                "cannot restore test-file DACL at {}: {error}",
                self.path.display()
            );
        }
    }
}
