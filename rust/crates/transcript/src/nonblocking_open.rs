//! Opens a regular file for reading without waiting for a FIFO's writer (ADR
//! 0225-nonblocking-image-open).
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

// `O_NONBLOCK` of the target, as its C library defines it: std does not export it, and this
// crate depends on no libc binding (ADR 0225-nonblocking-image-open). Only the targets the plan
// builds for are listed.
// libc 0.2.191: src/unix/linux_like/linux/gnu/b64/x86_64/mod.rs:294 and aarch64/mod.rs:206 say
// 2048.
#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
const O_NONBLOCK: i32 = 0o4000;
// libc 0.2.191: src/unix/bsd/mod.rs:275 says 0x4 (Apple's targets among them).
#[cfg(target_vendor = "apple")]
const O_NONBLOCK: i32 = 0x4;
#[cfg(all(
    unix,
    not(any(
        all(
            target_os = "linux",
            any(target_arch = "x86_64", target_arch = "aarch64")
        ),
        target_vendor = "apple",
    ))
))]
compile_error!(
    "add this target's O_NONBLOCK, taken from libc, to src/nonblocking_open.rs (ADR 0225-nonblocking-image-open)"
);

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
#[expect(
    clippy::disallowed_methods,
    reason = "custom_flags with O_NONBLOCK alone opens for reading only (ADR 0225-nonblocking-image-open)"
)]
fn open_without_waiting(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt as _;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(O_NONBLOCK)
        .open(path)
}

/// Off unix there is no FIFO that opening a path waits on.
#[cfg(not(unix))]
fn open_without_waiting(path: &Path) -> io::Result<File> {
    File::open(path)
}
