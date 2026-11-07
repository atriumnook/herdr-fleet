//! Builds libghostty-vt from Ghostty's source with Zig and links it statically.
//!
//! What this runs:
//!
//! 1. The source: `$GHOSTTY_SOURCE_DIR` when it is set, which must be a git
//!    checkout whose `git rev-parse HEAD` is `GHOSTTY_COMMIT` (the build
//!    fails otherwise, so the fixtures are never checked against another
//!    Ghostty). Zig writes its `.zig-cache` into that folder.
//!    Otherwise `git init`, `git fetch --depth 1 <GHOSTTY_REPO> <GHOSTTY_COMMIT>`
//!    and `git checkout FETCH_HEAD` in `$OUT_DIR/ghostty-src`, once.
//! 2. `zig build -Demit-lib-vt -Doptimize=ReleaseFast --prefix $OUT_DIR/ghostty-vt`
//!    in the source folder. `zig` is `$ZIG` when it is set, otherwise `zig`
//!    on PATH; Ghostty 1.4.0 needs Zig 0.17.0 (`minimum_zig_version`). Zig
//!    fetches Ghostty's pinned dependencies (by hash, from `build.zig.zon`)
//!    into its global cache.
//! 3. Links `$OUT_DIR/ghostty-vt/lib/libghostty-vt.a`, which needs only libc
//!    and libm.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Ghostty v1.4.0, the version of the Ghostty on the PC the fixtures came from.
const GHOSTTY_REPO: &str = "https://github.com/ghostty-org/ghostty.git";
const GHOSTTY_COMMIT: &str = "83fb95624b0439ee660c2679b43b38c8b63769cd";

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=GHOSTTY_SOURCE_DIR");
    println!("cargo:rerun-if-env-changed=ZIG");

    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let source = match env::var_os("GHOSTTY_SOURCE_DIR") {
        Some(dir) => {
            let dir = PathBuf::from(dir);
            check_commit(&dir);
            dir
        }
        None => fetch(&out.join("ghostty-src")),
    };

    let prefix = out.join("ghostty-vt");
    let zig = env::var_os("ZIG").unwrap_or_else(|| "zig".into());
    run(Command::new(&zig)
        .current_dir(&source)
        .args([
            "build",
            "-Demit-lib-vt",
            "-Doptimize=ReleaseFast",
            "--prefix",
        ])
        .arg(&prefix));

    println!(
        "cargo:rustc-link-search=native={}",
        prefix.join("lib").display()
    );
    println!("cargo:rustc-link-lib=static=ghostty-vt");
    println!("cargo:rustc-link-lib=m");
    println!("cargo:rustc-link-lib=c");
}

/// Fetches exactly `GHOSTTY_COMMIT` into `dir`, unless it is already there.
fn fetch(dir: &Path) -> PathBuf {
    if head(dir).as_deref() == Some(GHOSTTY_COMMIT) {
        return dir.to_path_buf();
    }
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).expect("create the Ghostty source folder");
    run(git(dir).args(["init", "-q"]));
    run(git(dir).args(["fetch", "-q", "--depth", "1", GHOSTTY_REPO, GHOSTTY_COMMIT]));
    run(git(dir).args(["checkout", "-q", "FETCH_HEAD"]));
    assert_eq!(
        head(dir).as_deref(),
        Some(GHOSTTY_COMMIT),
        "fetched the wrong commit"
    );
    dir.to_path_buf()
}

fn check_commit(dir: &Path) {
    let found = head(dir);
    assert_eq!(
        found.as_deref(),
        Some(GHOSTTY_COMMIT),
        "GHOSTTY_SOURCE_DIR ({}) must be a git checkout of {GHOSTTY_COMMIT}",
        dir.display()
    );
}

fn head(dir: &Path) -> Option<String> {
    let out = git(dir).args(["rev-parse", "HEAD"]).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn git(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir).args(["-c", "core.fsmonitor=false"]);
    cmd
}

fn run(cmd: &mut Command) {
    let status = cmd
        .status()
        .unwrap_or_else(|e| panic!("could not run {cmd:?}: {e}"));
    assert!(status.success(), "{cmd:?} failed: {status}");
}
