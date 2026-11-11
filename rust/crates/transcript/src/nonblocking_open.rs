//! Opens a regular file for reading without waiting for a FIFO's writer (ADR
//! 0225-nonblocking-image-open; the flag's value from rustix, ADR 0318-rustix-open-flags).
//!
//! `clippy.toml` bans `OpenOptionsExt::custom_flags`, because a flag such as `O_TRUNC` would let
//! this crate open a file for more than reading (ADR 0107-crate-split). This module is the one
//! place in `src/` allowed to use it, and only with `O_NONBLOCK`: the function takes no flags, so
//! no caller can pass another, and a non-blocking descriptor leaves this module only when it is a
//! regular file. The CI's step that keeps the lint's exceptions out of `src/` excepts this file
//! alone.

use std::fs::{File, Metadata};
use std::io;
use std::path::Path;

/// The file `path` names, opened for reading, and its `fstat`, when it is a regular file; a FIFO
/// answers `InvalidInput` without waiting for a writer, as does anything else that is not a
/// regular file (`server/codex-images.ts:61-64`). A symlink is followed.
pub(crate) fn open_regular_file(path: &Path) -> io::Result<(File, Metadata)> {
    let file = open_without_waiting(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok((file, meta))
}

#[cfg(unix)]
fn open_without_waiting(path: &Path) -> io::Result<File> {
    use rustix::fs::OFlags;
    use std::os::unix::fs::OpenOptionsExt as _;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    // The exception covers this one statement: any other banned method in this function stays an
    // error.
    #[expect(
        clippy::disallowed_methods,
        reason = "custom_flags with O_NONBLOCK alone opens for reading only (ADR 0225-nonblocking-image-open)"
    )]
    // rustix holds each target's value as its C library defines it; std adds O_CLOEXEC
    // (ADR 0318-rustix-open-flags).
    options.custom_flags(OFlags::NONBLOCK.bits().cast_signed());
    options.open(path)
}

/// Off unix there is no FIFO that opening a path waits on.
#[cfg(not(unix))]
fn open_without_waiting(path: &Path) -> io::Result<File> {
    File::open(path)
}
