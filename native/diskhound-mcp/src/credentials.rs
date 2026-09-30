//! Only the OS credential store holds bearer tokens. The file is a process lock.
use crate::Result;
use std::{
    fs::{self, File, OpenOptions},
    path::PathBuf,
    time::{Duration, Instant},
};

const UNAVAILABLE: &str = "Unlock your OS credential store (Keychain, Credential Manager, or Secret Service), or use --ephemeral to approve each connection without saving credentials.";
const SERVICE: &str = "com.diskhound.mcp.stdio.v1";

pub struct Credentials {
    entry: std::sync::Arc<keyring::Entry>,
    directory: PathBuf,
}
impl Credentials {
    #[cfg(test)]
    pub fn for_test(entry: keyring::Entry, directory: PathBuf) -> Self {
        Self {
            entry: std::sync::Arc::new(entry),
            directory,
        }
    }

    pub fn new(origin: &str) -> Result<Self> {
        let directory = dirs::data_local_dir()
            .ok_or(UNAVAILABLE)?
            .join("DiskHound")
            .join("mcp-bridge-locks");
        Ok(Self {
            entry: std::sync::Arc::new(
                keyring::Entry::new(SERVICE, origin).map_err(|_| UNAVAILABLE)?,
            ),
            directory,
        })
    }
    pub async fn lock(&self, port: u16) -> Result<File> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::{DirBuilderExt, MetadataExt};
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&self.directory)
                .map_err(|_| UNAVAILABLE)?;
            let info = fs::symlink_metadata(&self.directory).map_err(|_| UNAVAILABLE)?;
            if !info.is_dir()
                || info.uid() != unsafe { libc::geteuid() }
                || info.mode() & 0o777 != 0o700
            {
                return Err("Unsafe bridge lock directory");
            }
        }
        #[cfg(windows)]
        {
            fs::create_dir_all(&self.directory).map_err(|_| UNAVAILABLE)?;
            if fs::symlink_metadata(&self.directory)
                .map_err(|_| UNAVAILABLE)?
                .file_type()
                .is_symlink()
            {
                return Err("Unsafe bridge lock directory");
            }
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let file = options
            .open(self.directory.join(format!("{port}.lock")))
            .map_err(|_| UNAVAILABLE)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let info = file.metadata().map_err(|_| UNAVAILABLE)?;
            if !info.is_file()
                || info.uid() != unsafe { libc::geteuid() }
                || info.mode() & 0o777 != 0o600
                || info.nlink() != 1
            {
                return Err("Unsafe bridge lock file");
            }
        }
        let deadline = Instant::now() + Duration::from_secs(130);
        loop {
            match fs2::FileExt::try_lock_exclusive(&file) {
                Ok(()) => return Ok(file),
                Err(e) if e.raw_os_error() == fs2::lock_contended_error().raw_os_error() && Instant::now() < deadline =>
                    tokio::time::sleep(Duration::from_millis(100)).await,
                _ => return Err("Another connection is awaiting approval. Finish it in DiskHound and reconnect."),
            }
        }
    }
    // Keychain / Secret Service may prompt or block. Keep stdin closure and
    // signals responsive while the OS owns that work.
    pub async fn load(&self) -> Result<Option<String>> {
        let entry = self.entry.clone();
        tokio::task::spawn_blocking(move || match entry.get_password() {
            Ok(token) if valid_token(&token) => Ok(Some(token)),
            Ok(_) => Err("Invalid saved credential; run diskhound-mcp --forget and reconnect."),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(UNAVAILABLE),
        })
        .await
        .map_err(|_| UNAVAILABLE)?
    }
    pub async fn save(&self, token: &str) -> Result<()> {
        let entry = self.entry.clone();
        let token = token.to_owned();
        tokio::task::spawn_blocking(move || entry.set_password(&token).map_err(|_| UNAVAILABLE))
            .await
            .map_err(|_| UNAVAILABLE)?
    }
    pub async fn clear(&self) -> Result<()> {
        let entry = self.entry.clone();
        tokio::task::spawn_blocking(move || match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(UNAVAILABLE),
        })
        .await
        .map_err(|_| UNAVAILABLE)?
    }
}
pub fn valid_token(token: &str) -> bool {
    token.starts_with("dhmcp_")
        && token.len() == 49
        && token[6..]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
