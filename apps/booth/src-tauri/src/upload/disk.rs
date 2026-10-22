//! Free space on the volume holding the outbox, for the operator's low-disk warning
//! (DESIGN §10: below 1 GB). `statvfs` on Unix, which includes Android; elsewhere (the
//! Windows desktop build, a development tool) free space is reported as unknown, never low.

use std::io;
use std::path::Path;

use photobooth_core::outbox::DiskSpace;

/// This platform's [`DiskSpace`].
#[derive(Clone, Copy, Debug, Default)]
pub struct PlatformDiskSpace;

#[cfg(unix)]
impl DiskSpace for PlatformDiskSpace {
    fn free_bytes(&self, dir: &Path) -> io::Result<u64> {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let path = CString::new(dir.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
        let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        // SAFETY: `path` is a valid NUL-terminated string and `stats` points to writable
        // memory the size of a `statvfs`, which the call fills in when it returns 0.
        let rc = unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the call succeeded, so the struct is initialised.
        let stats = unsafe { stats.assume_init() };
        // Blocks available to an unprivileged process, in fragment-size units.
        Ok(widen(stats.f_bavail).saturating_mul(widen(stats.f_frsize)))
    }
}

/// The field types differ between Unix targets (`u32` or `u64`); all fit a `u64` today.
#[cfg(unix)]
fn widen<T: TryInto<u64>>(value: T) -> u64 {
    value.try_into().unwrap_or(u64::MAX)
}

#[cfg(not(unix))]
impl DiskSpace for PlatformDiskSpace {
    fn free_bytes(&self, _dir: &Path) -> io::Result<u64> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "free space is only read on Unix and Android",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn free_space_is_read_for_a_real_directory() {
        let dir = tempfile::tempdir().unwrap();
        let free = PlatformDiskSpace.free_bytes(dir.path()).unwrap();
        assert!(free > 0);
        assert!(PlatformDiskSpace
            .free_bytes(&dir.path().join("missing"))
            .is_err());
    }

    #[cfg(not(unix))]
    #[test]
    fn free_space_is_unknown_off_unix() {
        let dir = tempfile::tempdir().unwrap();
        assert!(PlatformDiskSpace.free_bytes(dir.path()).is_err());
    }
}
