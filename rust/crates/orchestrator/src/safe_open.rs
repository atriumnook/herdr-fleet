//! Opening a file the server reads without following a symlink in the last place or waiting for a
//! FIFO's writer, as `server/fleet/report.ts` and `server/fleet/plan.ts` open theirs with
//! `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` (ADR 0284-report-rustix, ADR 0318-rustix-open-flags).
//! What the opened file must be (its `fstat`) is the caller's to check: each answers a file that is
//! not a regular one in its own words.

use std::fs::File;
use std::io;
use std::path::Path;

/// `path` opened for reading: a symlink in the last place fails with `ELOOP`, and a FIFO opens
/// without waiting for a writer. std adds `O_CLOEXEC` and takes the access mode from `read`;
/// rustix names the two flags std does not export, for each target as its C library defines them.
#[cfg(unix)]
pub(crate) fn open_no_follow(path: &Path) -> io::Result<File> {
    use rustix::fs::OFlags;
    use std::os::unix::fs::OpenOptionsExt as _;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags((OFlags::NOFOLLOW | OFlags::NONBLOCK).bits().cast_signed())
        .open(path)
}

/// Whether [`open_no_follow`] failed because `path` is a symlink. std's
/// `ErrorKind::FilesystemLoop` is unstable in the Rust release this workspace builds with.
#[cfg(unix)]
pub(crate) fn is_symlink_loop(error: &io::Error) -> bool {
    error.raw_os_error() == Some(rustix::io::Errno::LOOP.raw_os_error())
}

// Linux's and Apple's open(2) fail with `ELOOP` on a symlink under `O_NOFOLLOW`; other systems
// answer otherwise (FreeBSD's open(2) documents `EMLINK`), and a symlinked report.json would then
// read as "cannot be read" rather than "is not a regular file".
#[cfg(all(unix, not(any(target_os = "linux", target_vendor = "apple"))))]
compile_error!(
    "check which error this target's open(2) gives a symlink under O_NOFOLLOW, and teach is_symlink_loop in orchestrator's src/safe_open.rs"
);

/// Off unix there is no `O_NOFOLLOW`: a symlink is turned down before the file is opened.
#[cfg(not(unix))]
pub(crate) fn open_no_follow(path: &Path) -> io::Result<File> {
    if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(io::Error::other(SymlinkRefused));
    }
    File::open(path)
}

#[cfg(not(unix))]
#[derive(Debug)]
struct SymlinkRefused;

#[cfg(not(unix))]
impl std::fmt::Display for SymlinkRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a symlink, which is not opened")
    }
}

#[cfg(not(unix))]
impl std::error::Error for SymlinkRefused {}

#[cfg(not(unix))]
pub(crate) fn is_symlink_loop(error: &io::Error) -> bool {
    error
        .get_ref()
        .is_some_and(|inner| inner.is::<SymlinkRefused>())
}
