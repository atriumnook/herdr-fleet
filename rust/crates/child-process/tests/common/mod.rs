//! What the child-process tests share: a temporary folder removed when the test ends, and fake
//! executables written into it. The tests never start a real agent CLI or `gh` (issue #246): a
//! real CLI may call a model, read the usage or update itself.

// Each test binary uses a part of this module.
#![allow(dead_code)]

pub mod json;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// A new empty folder under the system's temporary folder, removed with what it holds when dropped.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(label: &str) -> Self {
        use std::hash::{BuildHasher as _, Hasher as _};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        // a name nobody can guess, made with create_dir, which fails on anything already there
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(n);
        let dir = std::env::temp_dir().join(format!(
            "herdr-fleet-child-process-{label}-{}-{n}-{:016x}",
            std::process::id(),
            hasher.finish()
        ));
        fs::create_dir(&dir).unwrap_or_else(|error| panic!("{}: {error}", dir.display()));
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Writes `body` as a `/bin/sh` script named `name` in `dir`, executable, and returns its path.
///
/// A shell writes the file, not this process: a file this process held open for writing would be
/// inherited by a child another test forks at that moment, and executing it before that child's
/// own exec closes it fails with ETXTBSY ("Text file busy").
#[cfg(unix)]
pub fn fake(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    let status = std::process::Command::new("/bin/sh")
        .args([
            "-c",
            r#"printf '#!/bin/sh\n%s\n' "$2" > "$1" && chmod 755 "$1""#,
            "sh",
        ])
        .arg(&path)
        .arg(body)
        .status()
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    assert!(
        status.success(),
        "{}: could not write the fake",
        path.display()
    );
    path
}

/// A path as a single-quoted shell word, for a fake script to name a file of the test.
pub fn sh_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', r"'\''"))
}

/// What a file holds, or "" when there is none.
pub fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

/// Whether the process `pid` is still alive (a zombie counts as gone: it runs nothing).
#[cfg(target_os = "linux")]
pub fn alive(pid: u32) -> bool {
    match fs::read_to_string(format!("/proc/{pid}/stat")) {
        // the state is the field after the command's name in parentheses
        Ok(stat) => stat
            .rsplit_once(')')
            .is_some_and(|(_, rest)| !rest.trim_start().starts_with('Z')),
        Err(_) => false,
    }
}
