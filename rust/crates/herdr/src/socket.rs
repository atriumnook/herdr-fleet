//! Where herdr's socket is (`herdrSocketPath` and `socketAddress` in `server/herdr/client.ts`).

use std::ffi::OsString;
use std::path::PathBuf;

/// herdr's socket: `HERDR_SOCKET`, else `~/.config/herdr/herdr.sock` (`%APPDATA%\herdr\herdr.sock`
/// on Windows), with the environment read through `env` (the core passes
/// `|name| std::env::var_os(name)`; tests cannot set the process's environment under
/// `forbid(unsafe_code)`).
///
/// An empty `HERDR_SOCKET` counts as unset, and a missing `HOME` (`APPDATA`) as empty, as the
/// TypeScript reads them.
pub fn socket_path(env: impl Fn(&str) -> Option<OsString>) -> PathBuf {
    if let Some(path) = env("HERDR_SOCKET").filter(|path| !path.is_empty()) {
        return PathBuf::from(path);
    }
    #[cfg(windows)]
    let (base, rest) = (env("APPDATA"), "\\herdr\\herdr.sock");
    #[cfg(not(windows))]
    let (base, rest) = (env("HOME"), "/.config/herdr/herdr.sock");
    // joined as text, not with `Path::join`: an empty HOME gives `/.config/…` as in TypeScript
    let mut path = base.unwrap_or_default();
    path.push(rest);
    PathBuf::from(path)
}

/// On Windows herdr.sock is a marker file (`pid:start`, see [`crate::marker`]), and the server
/// listens on a named pipe of the same name: `\\.\pipe\C:\Users\…\herdr.sock` (live-verified,
/// herdr 0.9.3). A path that already names a pipe is kept.
#[cfg(windows)]
pub fn pipe_name(socket_path: &std::path::Path) -> OsString {
    const PIPE_PREFIX: &str = r"\\.\pipe\";
    let path = socket_path.as_os_str();
    if path.to_string_lossy().starts_with(PIPE_PREFIX) {
        return path.to_owned();
    }
    let mut name = OsString::from(PIPE_PREFIX);
    name.push(path);
    name
}
