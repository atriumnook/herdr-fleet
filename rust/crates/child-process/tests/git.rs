//! How the server runs git (`server/fleet/thread.ts:15-43`, `server/files.ts:9-27`): with
//! `core.fsmonitor` off, paths unquoted, no optional locks, no prompt, and a time limit.
//!
//! The fsmonitor test is `server/files.test.ts`'s "never runs a command the repository's own config
//! names (core.fsmonitor)", which ADR 0122-parity-criteria sends to this crate for the git of
//! `server/fleet/thread.ts`; it also runs git without these rules first, so that it is seen to fail
//! when the rule is missing. The other expected values are worked out by hand from the TypeScript.

#![cfg(unix)]

mod common;

use std::path::Path;
use std::process::Command as StdCommand;
use std::time::{Duration, Instant};

use common::{TempDir, fake, sh_quote};
use herdr_fleet_child_process::git::{self, QUICK_TIMEOUT, TIMEOUT};
use herdr_fleet_child_process::{RunError, Runner};
use tokio_util::sync::CancellationToken;

/// A repository with one commit of README.md.
fn repository(label: &str) -> TempDir {
    let root = TempDir::new(label);
    let git = |args: &[&str]| {
        let status = StdCommand::new("git")
            .arg("-C")
            .arg(root.path())
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    };
    git(&["init", "-q"]);
    std::fs::write(root.join("README.md"), "hello\n").unwrap();
    git(&["add", "README.md"]);
    git(&[
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=t",
        "commit",
        "-qm",
        "init",
    ]);
    root
}

async fn run_git(cwd: &Path, args: &[&str]) -> herdr_fleet_child_process::Output {
    Runner::new(1)
        .run(git::command(cwd, args), &CancellationToken::new())
        .await
        .unwrap()
}

#[test]
fn the_time_limits_are_the_servers() {
    // server/fleet/thread.ts:31 (`timeoutMs = 5_000`); server/files.ts:20 and thread.ts:21 (`3_000`)
    assert_eq!(TIMEOUT, Duration::from_secs(5));
    assert_eq!(QUICK_TIMEOUT, Duration::from_secs(3));
}

/// `server/files.test.ts`: "never runs a command the repository's own config names (core.fsmonitor)".
#[tokio::test]
async fn never_runs_the_fsmonitor_the_repository_names() {
    let root = repository("fsmonitor");
    let marker = root.join("fsmonitor-ran");
    let hook = fake(
        root.path(),
        "hook.sh",
        &format!("touch {}", sh_quote(&marker)),
    );
    let status = StdCommand::new("git")
        .arg("-C")
        .arg(root.path())
        .args(["config", "core.fsmonitor"])
        .arg(&hook)
        .status()
        .unwrap();
    assert!(status.success());
    // without the rule, git runs the hook: the test can fail
    let plain = StdCommand::new("git")
        .arg("-C")
        .arg(root.path())
        .args(["status", "--porcelain"])
        .output()
        .unwrap();
    assert!(plain.status.success());
    assert!(
        marker.exists(),
        "git did not run the fsmonitor hook: this test would prove nothing"
    );
    std::fs::remove_file(&marker).unwrap();

    for args in [
        &["status", "--porcelain"][..],
        &["ls-files", "-z", "-co", "--exclude-standard"],
        &["diff", "--numstat"],
    ] {
        let output = run_git(root.path(), args).await;
        assert_eq!(
            output.code,
            Some(0),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!marker.exists(), "git {args:?} ran the fsmonitor hook");
    }
}

/// The settings and variables git runs with, as git's own alias shows them to the shell it starts:
/// `-c` settings reach it in GIT_CONFIG_PARAMETERS.
#[tokio::test]
async fn runs_with_the_servers_settings_and_variables() {
    let root = repository("settings");
    let output = run_git(root.path(), &["-c", "alias.showenv=!env", "showenv"]).await;
    let text = String::from_utf8(output.stdout).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert!(lines.contains(&"GIT_OPTIONAL_LOCKS=0"), "{text}");
    assert!(lines.contains(&"GIT_TERMINAL_PROMPT=0"), "{text}");
    let parameters = lines
        .iter()
        .find(|line| line.starts_with("GIT_CONFIG_PARAMETERS="))
        .expect(&text);
    assert!(
        parameters.contains("'core.fsmonitor'='false'"),
        "{parameters}"
    );
    assert!(
        parameters.contains("'core.quotepath'='false'"),
        "{parameters}"
    );
    // the server's environment is kept (server/fleet/thread.ts:34 `...process.env`)
    let home = std::env::var("HOME").unwrap();
    assert!(lines.contains(&format!("HOME={home}").as_str()), "{text}");
}

/// Paths as they are, not octal-escaped, for the person to read (server/fleet/thread.ts:32).
#[tokio::test]
async fn paths_are_not_quoted() {
    let root = repository("quotepath");
    std::fs::write(root.join("é.txt"), "x").unwrap();
    let output = run_git(root.path(), &["status", "--porcelain"]).await;
    assert_eq!(String::from_utf8(output.stdout).unwrap(), "?? é.txt\n");
}

/// git runs in the folder it is given (`-C <cwd>`), wherever the server is.
#[tokio::test]
async fn runs_in_the_folder_it_is_given() {
    let root = repository("toplevel");
    std::fs::create_dir(root.join("sub")).unwrap();
    let output = run_git(&root.join("sub"), &["rev-parse", "--show-toplevel"]).await;
    let top = std::fs::canonicalize(root.path()).unwrap();
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim_end(),
        top.to_str().unwrap()
    );
}

/// A git that takes longer than its limit is stopped (server/fleet/thread.ts:36).
#[tokio::test]
async fn a_git_past_its_limit_is_stopped() {
    let root = repository("timeout");
    let started = Instant::now();
    let error = Runner::new(1)
        .run(
            git::command(root.path(), &["-c", "alias.wait=!exec sleep 30", "wait"])
                .timeout(Duration::from_millis(300))
                .kill_grace(Duration::from_millis(300)),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(matches!(error, RunError::TimedOut), "{error:?}");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
}

/// A folder given as a relative path is taken from the server's folder once, as TypeScript's
/// `-C <cwd>` took it (`/code-review high`: the folder was also the child's own, and git looked
/// for `<cwd>/<cwd>`). cargo runs the tests in the crate's folder.
#[tokio::test]
async fn a_relative_folder_is_taken_once() {
    let output = run_git(Path::new("src"), &["rev-parse", "--show-prefix"]).await;
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        "rust/crates/child-process/src/\n",
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
