//! A thread's git and setup command (`thread.rs`), in temporary git repositories.
//!
//! The first seven tests are `server/fleet/thread.test.ts`'s `describe("thread helpers")`, one per
//! `it`, named in each test's comment, with the TypeScript's expected values. The tests after them
//! check what the TypeScript test leaves out (the setup command's limits, the diff's cut), with
//! values worked out by hand from `server/fleet/thread.ts`. No herdr and no network.

#![cfg(unix)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use herdr_fleet_orchestrator::thread::{
    self, BranchState, DIFF_MAX_BYTES, RemoveOptions, SETUP_TAIL_LINES, SETUP_TIMEOUT,
    SetupOutcome, THREAD_WORKTREES,
};
use protocol::DiffStat;
use tokio_util::sync::CancellationToken;

/// A new empty folder under the system's temporary folder (its real path, as `realpathSync`),
/// removed with what it holds when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        use std::hash::{BuildHasher as _, Hasher as _};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(n);
        let dir = std::env::temp_dir().join(format!(
            "herdr-fleet-thread-{label}-{}-{n}-{:016x}",
            std::process::id(),
            hasher.finish()
        ));
        fs::create_dir(&dir).unwrap_or_else(|error| panic!("{}: {error}", dir.display()));
        Self(dir.canonicalize().unwrap())
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// `git init -q <root>` in a new temporary folder (`repo()` of the TypeScript test).
fn repo(label: &str) -> TempDir {
    let root = TempDir::new(label);
    run_git(root.path(), &["init", "-q"]);
    root
}

/// `git -C <cwd> -c user.email=… -c user.name=t <args>`, which must succeed.
fn run_git(cwd: &Path, args: &[&str]) {
    let status = StdCommand::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["-c", "user.email=t@example.invalid", "-c", "user.name=t"])
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} in {}", cwd.display());
}

fn is_hex_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn temp_dir() -> PathBuf {
    std::env::temp_dir()
}

/// thread.test.ts: "find the repository's main worktree from a thread's worktree, from a
/// subfolder, and nothing outside a repository"
#[tokio::test]
async fn find_the_main_worktree_from_a_threads_worktree_from_a_subfolder_and_nothing_outside() {
    let root = repo("main-worktree");
    fs::write(root.join("a.txt"), "one\n").unwrap();
    run_git(root.path(), &["add", "a.txt"]);
    run_git(root.path(), &["commit", "-q", "-m", "base"]);
    let worktree = thread::worktree_path(root.path(), "t1");
    run_git(
        root.path(),
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "fleet/t1",
            worktree.to_str().unwrap(),
        ],
    );
    fs::create_dir(root.join("sub")).unwrap();
    let main = thread::git_root(root.path()).await;
    assert_eq!(main.as_deref(), Some(root.path()));
    assert_eq!(thread::main_worktree(&worktree).await, main);
    assert_eq!(thread::main_worktree(&root.join("sub")).await, main);
    assert_ne!(thread::git_root(&worktree).await, main);
    assert_eq!(thread::main_worktree(&temp_dir()).await, None);
}

/// thread.test.ts: "measure a worktree's change since a commit, committed or not, in the files git
/// tracks"
#[tokio::test]
async fn measure_a_worktrees_change_since_a_commit_committed_or_not_in_tracked_files() {
    let root = repo("diff-stat");
    fs::write(root.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    run_git(root.path(), &["add", "a.txt"]);
    run_git(root.path(), &["commit", "-q", "-m", "base"]);
    let base = thread::git_head(root.path()).await.unwrap();
    assert!(is_hex_sha(&base), "{base}");
    fs::write(root.join("a.txt"), "one\n2\nthree\nfour\n").unwrap();
    fs::write(root.join("b.txt"), "new\n").unwrap();
    run_git(root.path(), &["add", "b.txt"]);
    run_git(root.path(), &["commit", "-q", "-m", "b"]);
    fs::write(root.join("untracked.txt"), "not counted\n").unwrap();
    assert_eq!(
        thread::diff_stat(root.path(), &base).await,
        Some(DiffStat {
            added: 3,
            removed: 1,
            files: 2
        })
    );
    assert_eq!(thread::diff_stat(root.path(), "0000000").await, None);
    assert_eq!(thread::git_head(&temp_dir()).await, None);
}

/// thread.test.ts: "measure a thread's change from where it left its base branch, however far the
/// base branch moved on"
#[tokio::test]
async fn measure_a_threads_change_from_where_it_left_its_base_branch() {
    let root = repo("base-moved");
    fs::write(root.join("a.txt"), "one\n").unwrap();
    run_git(root.path(), &["add", "a.txt"]);
    run_git(root.path(), &["commit", "-q", "-m", "base"]);
    run_git(root.path(), &["branch", "-M", "main"]);
    assert_eq!(
        thread::git_branch(root.path()).await.as_deref(),
        Some("main")
    );
    let worktree = thread::worktree_path(root.path(), "t1");
    run_git(
        root.path(),
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "fleet/t1",
            worktree.to_str().unwrap(),
        ],
    );
    fs::write(worktree.join("b.txt"), "thread\n").unwrap();
    run_git(&worktree, &["add", "b.txt"]);
    run_git(&worktree, &["commit", "-q", "-m", "thread"]);
    fs::write(root.join("c.txt"), "main moved\n").unwrap();
    run_git(root.path(), &["add", "c.txt"]);
    run_git(root.path(), &["commit", "-q", "-m", "main"]);
    fs::write(worktree.join("new.txt"), "uncommitted\n").unwrap();
    assert_eq!(
        thread::diff_stat(&worktree, "main").await,
        Some(DiffStat {
            added: 1,
            removed: 0,
            files: 1
        })
    );
    let diff = thread::diff_text(&worktree, "main").await.unwrap();
    assert!(!diff.truncated);
    assert!(diff.diff.contains("+++ b/b.txt"), "{}", diff.diff);
    assert!(!diff.diff.contains("c.txt"), "{}", diff.diff);
    assert_eq!(
        thread::branch_state(&worktree, "main").await,
        Some(BranchState {
            uncommitted: vec!["new.txt".into()],
            ahead: 1,
            behind: 1
        })
    );
    let head = thread::branch_head(root.path(), "fleet/t1").await;
    assert!(head.as_deref().is_some_and(is_hex_sha), "{head:?}");
    assert_eq!(thread::branch_head(root.path(), "fleet/none").await, None);
    assert!(!thread::is_merged(root.path(), "fleet/t1", "main").await);
    // work no commit holds keeps the worktree, and so does an unmerged branch
    let kept =
        thread::remove_thread(root.path(), &worktree, "fleet/t1", RemoveOptions::default()).await;
    assert!(
        kept.as_ref().is_err_and(|kept| kept.contains("was kept")),
        "{kept:?}"
    );
    assert!(worktree.exists());
    fs::remove_file(worktree.join("new.txt")).unwrap();
    let kept =
        thread::remove_thread(root.path(), &worktree, "fleet/t1", RemoveOptions::default()).await;
    assert!(
        kept.as_ref()
            .is_err_and(|kept| kept.contains("The branch fleet/t1 was kept")),
        "{kept:?}"
    );
    assert!(!worktree.exists());
    run_git(
        root.path(),
        &["merge", "-q", "--no-ff", "-m", "merge", "fleet/t1"],
    );
    assert!(thread::is_merged(root.path(), "fleet/t1", "main").await);
    assert_eq!(
        thread::remove_thread(root.path(), &worktree, "fleet/t1", RemoveOptions::default()).await,
        Ok(())
    );
    assert_eq!(thread::branch_head(root.path(), "fleet/t1").await, None);
}

/// thread.test.ts: "throw a thread away whatever it holds"
#[tokio::test]
async fn throw_a_thread_away_whatever_it_holds() {
    let root = repo("discard");
    fs::write(root.join("a.txt"), "one\n").unwrap();
    run_git(root.path(), &["add", "a.txt"]);
    run_git(root.path(), &["commit", "-q", "-m", "base"]);
    let worktree = root.join("w");
    run_git(
        root.path(),
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "fleet/t2",
            worktree.to_str().unwrap(),
        ],
    );
    fs::write(worktree.join("a.txt"), "changed\n").unwrap();
    fs::write(worktree.join("new.txt"), "new\n").unwrap();
    let force = RemoveOptions {
        force: true,
        branch_merged: false,
    };
    assert_eq!(
        thread::remove_thread(root.path(), &worktree, "fleet/t2", force).await,
        Ok(())
    );
    assert!(!worktree.exists());
    assert_eq!(thread::branch_head(root.path(), "fleet/t2").await, None);
}

/// thread.test.ts: "find a folder's repository, and none outside one"
#[tokio::test]
async fn find_a_folders_repository_and_none_outside_one() {
    let root = repo("git-root");
    assert_eq!(
        thread::git_root(root.path()).await.as_deref(),
        Some(root.path())
    );
    assert_eq!(thread::git_root(&temp_dir()).await, None);
}

/// thread.test.ts: "keep the threads' worktrees out of git status with one line in info/exclude,
/// however often asked"
#[tokio::test]
async fn keep_the_threads_worktrees_out_of_git_status_with_one_line_however_often_asked() {
    let root = repo("exclude");
    let exclude = root.path().join(".git").join("info").join("exclude");
    fs::write(&exclude, "# local\n*.log").unwrap();
    thread::exclude_worktrees(root.path()).await.unwrap();
    thread::exclude_worktrees(root.path()).await.unwrap();
    assert_eq!(
        fs::read_to_string(&exclude).unwrap(),
        "# local\n*.log\n/.herdr-fleet/worktrees/\n"
    );
}

/// thread.test.ts: "run the setup command in the worktree, and keep the tail of a failure's output"
#[tokio::test]
async fn run_the_setup_command_in_the_worktree_and_keep_the_tail_of_a_failures_output() {
    let root = repo("setup");
    let cancel = CancellationToken::new();
    assert_eq!(
        thread::run_setup(root.path(), "pwd", &cancel).await,
        SetupOutcome {
            ok: true,
            output: root.path().to_str().unwrap().into()
        }
    );
    let failed = thread::run_setup(
        root.path(),
        "echo installing; echo 'npm ERR! missing script' >&2; exit 3",
        &cancel,
    )
    .await;
    assert!(!failed.ok);
    assert!(
        failed.output.contains("npm ERR! missing script"),
        "{}",
        failed.output
    );
}

// What thread.test.ts leaves out, worked out by hand from server/fleet/thread.ts.

#[test]
fn the_limits_are_the_typescripts() {
    // thread.ts:10-11 (`10 * 60_000`, `20`), :80 (`1024 * 1024`), :129 (".herdr-fleet/worktrees")
    assert_eq!(SETUP_TIMEOUT, Duration::from_secs(600));
    assert_eq!(SETUP_TAIL_LINES, 20);
    assert_eq!(DIFF_MAX_BYTES, 1_048_576);
    assert_eq!(THREAD_WORKTREES, ".herdr-fleet/worktrees");
    // orchestrator.ts:528 and :1146: join(project, THREAD_WORKTREES, threadId)
    assert_eq!(
        thread::worktree_path(Path::new("/repo"), "4705104e"),
        PathBuf::from("/repo/.herdr-fleet/worktrees/4705104e")
    );
}

/// The orchestrator's ports take boxed futures that are `Send` (ADR 0242-phase-3-split): every
/// future here must be one.
#[test]
fn every_future_is_send() {
    fn send<T: Send>(_: T) {}
    let (path, cancel) = (Path::new("/nonexistent"), CancellationToken::new());
    send(thread::git_root(path));
    send(thread::git_head(path));
    send(thread::git_branch(path));
    send(thread::diff_stat(path, "main"));
    send(thread::diff_text(path, "main"));
    send(thread::branch_state(path, "main"));
    send(thread::branch_head(path, "fleet/t1"));
    send(thread::is_merged(path, "fleet/t1", "main"));
    send(thread::remove_thread(
        path,
        path,
        "fleet/t1",
        RemoveOptions::default(),
    ));
    send(thread::main_worktree(path));
    send(thread::exclude_worktrees(path));
    send(thread::run_setup(path, "true", &cancel));
}

/// thread.ts:177: the output is stdout, then stderr, trimmed at the end, its last 20 lines.
#[tokio::test]
async fn the_setup_output_is_stdout_then_stderr_its_last_20_lines() {
    let root = TempDir::new("setup-tail");
    let outcome = thread::run_setup(
        root.path(),
        "i=1; while [ $i -le 30 ]; do echo out$i; i=$((i+1)); done; echo err1 >&2; echo err2 >&2; printf '\\n\\n'",
        &CancellationToken::new(),
    )
    .await;
    // stdout "out1\n…out30\n\n\n", then stderr "err1\nerr2\n"; trimEnd drops the last newline
    // only, and the 34 lines end in out15…out30, two blank lines (stdout's), err1, err2
    let expected = format!(
        "{}\n\n\nerr1\nerr2",
        (15..=30)
            .map(|n| format!("out{n}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    assert_eq!(
        outcome,
        SetupOutcome {
            ok: true,
            output: expected
        }
    );
}

/// thread.ts:177: even when each of the last 20 lines is long, none of them is cut before the
/// line-tail operation. The 60,000-byte width and 20 lines are counted by hand: 1,200,000 bytes
/// of content and 20 newlines, followed by two blank lines that trimEnd removes.
#[tokio::test]
async fn the_setup_output_keeps_twenty_long_lines_whole() {
    let root = TempDir::new("setup-long-tail");
    let outcome = thread::run_setup(
        root.path(),
        "i=0; while [ $i -lt 20 ]; do printf '%60000s\\n' x; i=$((i+1)); done; printf '\\n\\n'",
        &CancellationToken::new(),
    )
    .await;
    let line = format!("{}x", " ".repeat(59_999));
    let lines: Vec<&str> = outcome.output.split('\n').collect();
    assert!(outcome.ok, "{outcome:?}");
    assert_eq!(outcome.output.len(), 1_200_019);
    assert_eq!(lines.len(), 20);
    assert!(lines.iter().all(|actual| *actual == line));
}

/// thread.ts:173: the server's environment with `GIT_TERMINAL_PROMPT=0` over it, and nothing to read.
#[tokio::test]
async fn the_setup_command_has_the_servers_environment_no_git_prompt_and_no_input() {
    let root = TempDir::new("setup-env");
    let outcome = thread::run_setup(
        root.path(),
        r#"printf '%s|%s|' "$GIT_TERMINAL_PROMPT" "${PATH:+path}"; cat; echo end"#,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(
        outcome,
        SetupOutcome {
            ok: true,
            output: "0|path|end".into()
        }
    );
}

/// thread.ts:175-176: a cancel stops the command, which does not count as done.
#[tokio::test]
async fn a_cancelled_setup_command_is_stopped_and_fails() {
    let root = TempDir::new("setup-cancel");
    let cancel = CancellationToken::new();
    let started = Instant::now();
    let stopper = {
        let cancel = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            cancel.cancel();
        })
    };
    let outcome = thread::run_setup(root.path(), "sleep 30", &cancel).await;
    stopper.await.unwrap();
    assert!(!outcome.ok, "{outcome:?}");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
}

/// thread.ts:84-89: a diff over 1 MiB is cut at 1 MiB and says so.
#[tokio::test]
async fn a_diff_over_a_mebibyte_is_cut_there() {
    let root = repo("diff-cut");
    fs::write(root.join("a.txt"), "one\n").unwrap();
    run_git(root.path(), &["add", "a.txt"]);
    run_git(root.path(), &["commit", "-q", "-m", "base"]);
    let base = thread::git_head(root.path()).await.unwrap();
    // 20,000 lines of 99 bytes: about 2 MB of diff
    let line = "x".repeat(98);
    let big: String = (0..20_000).map(|_| format!("{line}\n")).collect();
    fs::write(root.join("a.txt"), big).unwrap();
    let diff = thread::diff_text(root.path(), &base).await.unwrap();
    assert!(diff.truncated);
    assert_eq!(diff.diff.len(), 1_048_576);
    assert!(
        diff.diff.starts_with("diff --git a/a.txt b/a.txt\n"),
        "{}",
        &diff.diff[..80]
    );
}

/// thread.ts:94-101: the first 20 paths no commit holds, and none of the rest.
#[tokio::test]
async fn the_uncommitted_paths_are_the_first_20() {
    let root = repo("uncommitted");
    fs::write(root.join("a.txt"), "one\n").unwrap();
    run_git(root.path(), &["add", "a.txt"]);
    run_git(root.path(), &["commit", "-q", "-m", "base"]);
    run_git(root.path(), &["branch", "-M", "main"]);
    for n in 0..25 {
        fs::write(root.join(&format!("f{n:02}.txt")), "x\n").unwrap();
    }
    let state = thread::branch_state(root.path(), "main").await.unwrap();
    let expected: Vec<String> = (0..20).map(|n| format!("f{n:02}.txt")).collect();
    assert_eq!(
        state,
        BranchState {
            uncommitted: expected,
            ahead: 0,
            behind: 0
        }
    );
    assert_eq!(
        thread::branch_state(root.path(), "no-such-branch").await,
        None
    );
}

/// thread.ts:94-101: the first 20 status rows stay whole when each rename row holds two paths
/// near Linux's path limit. Twenty rows are about 145 KiB, which crossed the former 128 KiB cut.
#[tokio::test]
async fn the_first_twenty_long_rename_paths_are_whole() {
    let root = repo("long-renames");
    run_git(root.path(), &["branch", "-M", "main"]);
    let component = "d".repeat(200);
    let mut old = root.join("old");
    for _ in 0..18 {
        old = old.join(&component);
    }
    fs::create_dir_all(&old).unwrap();
    for n in 0..20 {
        fs::write(old.join(format!("f{n:02}.txt")), "x\n").unwrap();
    }
    run_git(root.path(), &["add", "old"]);
    run_git(root.path(), &["commit", "-q", "-m", "base"]);
    run_git(root.path(), &["mv", "old", "new"]);

    let state = thread::branch_state(root.path(), "main").await.unwrap();
    assert_eq!(state.uncommitted.len(), 20, "{:?}", state.uncommitted);
    assert!(
        state
            .uncommitted
            .iter()
            .all(|path| path.starts_with("old/") && path.contains(" -> new/"))
    );
}

/// thread.ts:118-122: a branch the fleet saw merged on GitHub goes with `-D`, though git does not
/// call it merged.
#[tokio::test]
async fn a_branch_merged_on_github_is_deleted_though_git_does_not_see_it_merged() {
    let root = repo("branch-merged");
    fs::write(root.join("a.txt"), "one\n").unwrap();
    run_git(root.path(), &["add", "a.txt"]);
    run_git(root.path(), &["commit", "-q", "-m", "base"]);
    let worktree = root.join("w");
    run_git(
        root.path(),
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "fleet/t3",
            worktree.to_str().unwrap(),
        ],
    );
    fs::write(worktree.join("b.txt"), "b\n").unwrap();
    run_git(&worktree, &["add", "b.txt"]);
    run_git(&worktree, &["commit", "-q", "-m", "b"]);
    let merged = RemoveOptions {
        force: false,
        branch_merged: true,
    };
    assert_eq!(
        thread::remove_thread(root.path(), &worktree, "fleet/t3", merged).await,
        Ok(())
    );
    assert!(!worktree.exists());
    assert_eq!(thread::branch_head(root.path(), "fleet/t3").await, None);
    // gone already: the worktree is skipped, and a branch git does not find is no failure
    assert_eq!(
        thread::remove_thread(root.path(), &worktree, "fleet/t3", merged).await,
        Ok(())
    );
}

/// thread.ts:57-59: on no branch (a detached HEAD), none.
#[tokio::test]
async fn a_detached_head_is_on_no_branch() {
    let root = repo("detached");
    fs::write(root.join("a.txt"), "one\n").unwrap();
    run_git(root.path(), &["add", "a.txt"]);
    run_git(root.path(), &["commit", "-q", "-m", "base"]);
    run_git(root.path(), &["checkout", "-q", "--detach"]);
    assert_eq!(thread::git_branch(root.path()).await, None);
}

/// Threads started at once for one repository each keep the worktrees out of `git status`: the
/// line goes in once all the same (TypeScript's read and append ran on one event loop, so two
/// calls could not interleave; /code-review high on #294).
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn threads_started_at_once_add_the_exclude_line_once() {
    for _ in 0..5 {
        let root = repo("exclude-race");
        let exclude = root.path().join(".git").join("info").join("exclude");
        fs::write(&exclude, "# local\n").unwrap();
        let calls: Vec<_> = (0..16)
            .map(|_| {
                let path = root.path().to_path_buf();
                tokio::spawn(async move { thread::exclude_worktrees(&path).await })
            })
            .collect();
        for call in calls {
            call.await.unwrap().unwrap();
        }
        assert_eq!(
            fs::read_to_string(&exclude).unwrap(),
            "# local\n/.herdr-fleet/worktrees/\n"
        );
    }
}
