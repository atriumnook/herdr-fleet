//! A thread's worktree, git and the project's setup command; from `server/fleet/thread.ts`.
//!
//! A thread is one piece of a project's work with its own herdr workspace and, in a repository,
//! its own worktree on a branch. git runs through child-process's [`git::command`] (core.fsmonitor
//! off, paths unquoted, no optional locks, no prompt) and the caller's [`Runner`]; the setup
//! command through the same runner, with the server's environment (ADR 0242-phase-3-split, "子プロセス").

use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

use child_process::{Command, Env, EnvPolicy, RunError, Runner, StreamLimit, git};
use protocol::DiffStat;
use tokio_util::sync::CancellationToken;

/// Where a thread's worktree goes: inside the repository, which the agent CLIs already trust
/// (claude, codex and cursor ask nothing there).
pub const THREAD_WORKTREES: &str = ".herdr-fleet/worktrees";

/// The most of a thread's diff the fleet hands the screen.
pub const DIFF_MAX_BYTES: usize = 1024 * 1024;

/// How long the setup command may run (`SETUP_TIMEOUT_MS`, `server/fleet/thread.ts:10`).
pub const SETUP_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// The lines of the setup command's output kept (`SETUP_TAIL_LINES`, `server/fleet/thread.ts:11`).
pub const SETUP_TAIL_LINES: usize = 20;

/// A thread's change as a unified diff, cut at [`DIFF_MAX_BYTES`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffText {
    pub diff: String,
    pub truncated: bool,
}

/// The worktree's state beside the branch it lands on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchState {
    /// What no commit holds (`git status`), the first 20 paths.
    pub uncommitted: Vec<String>,
    /// Commits the worktree's HEAD has that the base does not.
    pub ahead: u64,
    /// Commits the base has that the worktree's HEAD does not.
    pub behind: u64,
}

/// How [`remove_thread`] treats work that is not merged.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RemoveOptions {
    /// Throws the thread away, whatever it holds.
    pub force: bool,
    /// The fleet saw the branch's commits merged where git cannot (a pull request on GitHub).
    pub branch_merged: bool,
}

/// What the setup command did: whether it exited 0, and the end of what it wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupOutcome {
    pub ok: bool,
    pub output: String,
}

/// The repository `cwd` lies in, or `None`. The folder may be one nobody vetted, so git runs with
/// core.fsmonitor off, as everywhere here.
pub async fn git_root(runner: &Runner, cwd: &Path) -> Option<PathBuf> {
    let outcome = run_git(
        runner,
        cwd,
        &["rev-parse", "--show-toplevel"],
        git::QUICK_TIMEOUT,
    )
    .await;
    let root = outcome.output.trim();
    (outcome.ok && !root.is_empty()).then(|| PathBuf::from(root))
}

/// The commit `cwd` is at: a thread's change is later measured against it.
pub async fn git_head(runner: &Runner, cwd: &Path) -> Option<String> {
    let head = git_output(runner, cwd, &["rev-parse", "HEAD"]).await?;
    let head = head.trim();
    let hex = head
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    ((7..=64).contains(&head.len()) && hex).then(|| head.to_owned())
}

/// The branch `cwd` is on; `None` when it is on none (a detached HEAD).
pub async fn git_branch(runner: &Runner, cwd: &Path) -> Option<String> {
    let branch = git_output(runner, cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await?;
    non_empty(branch.trim())
}

/// What the worktree at `cwd` changed since it left `base` (a commit, or a branch it forked from),
/// committed or not, in the files git tracks (a binary file counts no lines).
pub async fn diff_stat(runner: &Runner, cwd: &Path, base: &str) -> Option<DiffStat> {
    let output = git_output(
        runner,
        cwd,
        &["diff", "--numstat", "--merge-base", base, "--"],
    )
    .await?;
    // a count is digits; a binary file's "-" counts none
    let count = |value: Option<&str>| match value {
        Some(value) if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => {
            value.parse::<u64>().unwrap_or(0)
        }
        _ => 0,
    };
    let mut stat = DiffStat {
        added: 0,
        removed: 0,
        files: 0,
    };
    for row in output.split('\n').filter(|line| !line.is_empty()) {
        let mut fields = row.split('\t');
        stat.added += count(fields.next());
        stat.removed += count(fields.next());
        stat.files += 1;
    }
    Some(stat)
}

/// The same change as [`diff_stat`], as a unified diff with a/ and b/ before the paths from the
/// repository's top whatever the person's git config says, cut at [`DIFF_MAX_BYTES`]; `None`
/// when git cannot say.
pub async fn diff_text(runner: &Runner, cwd: &Path, base: &str) -> Option<DiffText> {
    let args = [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-relative",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--merge-base",
        base,
        "--",
    ];
    // one byte past the cut tells whether there was more; the rest is read and dropped
    let command = git::command(cwd, &args)
        .timeout(Duration::from_secs(15))
        .stdout_limit(StreamLimit::Head(DIFF_MAX_BYTES + 1));
    let output = runner.run(command, &CancellationToken::new()).await.ok()?;
    if output.code != Some(0) {
        return None;
    }
    let truncated = output.stdout.len() > DIFF_MAX_BYTES;
    let kept = &output.stdout[..output.stdout.len().min(DIFF_MAX_BYTES)];
    Some(DiffText {
        diff: String::from_utf8_lossy(kept).into_owned(),
        truncated,
    })
}

/// The first this many paths of what no commit holds (`UNCOMMITTED_MAX`, `thread.ts:91`).
const UNCOMMITTED_MAX: usize = 20;

/// The worktree's state beside the branch it lands on: what no commit holds, and the commits
/// either side has that the other does not.
pub async fn branch_state(runner: &Runner, cwd: &Path, base: &str) -> Option<BranchState> {
    let range = format!("{base}...HEAD");
    // only the first lines are kept: a long status is cut, not failed
    let status = git::command(cwd, &["status", "--porcelain=v1", "--untracked-files=all"])
        .stdout_limit(StreamLimit::Head(DEFAULT_STDOUT_LIMIT_BYTES));
    let status = async {
        let output = runner.run(status, &CancellationToken::new()).await.ok()?;
        (output.code == Some(0)).then(|| String::from_utf8_lossy(&output.stdout).into_owned())
    };
    let counts_args = ["rev-list", "--left-right", "--count", &range];
    let counts = git_output(runner, cwd, &counts_args);
    let (status, counts) = tokio::join!(status, counts);
    let (status, counts) = (status?, counts?);
    let mut numbers = counts.split_whitespace().map(str::parse::<u64>);
    let (Some(Ok(behind)), Some(Ok(ahead))) = (numbers.next(), numbers.next()) else {
        return None;
    };
    let uncommitted = status
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(|line| line.get(3..).unwrap_or("").to_owned())
        .take(UNCOMMITTED_MAX)
        .collect();
    Some(BranchState {
        uncommitted,
        ahead,
        behind,
    })
}

/// The commit a branch points at, or `None`.
pub async fn branch_head(runner: &Runner, repo: &Path, branch: &str) -> Option<String> {
    let reference = format!("refs/heads/{branch}");
    let head = git_output(
        runner,
        repo,
        &["rev-parse", "--verify", "--quiet", &reference],
    )
    .await?;
    non_empty(head.trim())
}

/// Whether every commit of `branch` is in `into`.
pub async fn is_merged(runner: &Runner, repo: &Path, branch: &str, into: &str) -> bool {
    let (branch, into) = (format!("refs/heads/{branch}"), format!("refs/heads/{into}"));
    let args = ["merge-base", "--is-ancestor", &branch, &into];
    run_git(runner, repo, &args, git::TIMEOUT).await.ok
}

/// Removes a thread's worktree and then its branch. A worktree holding work no commit has stays
/// (files git ignores, such as installed dependencies, do not count), and so does a branch git does
/// not call merged into the checked-out branch, unless `force` says to throw the thread away, or
/// `branch_merged` says the fleet saw its commits merged where git cannot (a pull request on
/// GitHub). Answers what stayed and why.
pub async fn remove_thread(
    runner: &Runner,
    repo: &Path,
    worktree: &Path,
    branch: &str,
    options: RemoveOptions,
) -> Option<String> {
    if worktree.exists() {
        let mut args = vec![OsStr::new("worktree"), OsStr::new("remove")];
        if options.force {
            args.push(OsStr::new("--force"));
        }
        args.push(worktree.as_os_str());
        let removed = run_git(runner, repo, &args, Duration::from_secs(60)).await;
        if !removed.ok {
            let why = or(&removed.error, "git could not remove it");
            return Some(format!(
                "The worktree {} was kept: {why}",
                worktree.display()
            ));
        }
    }
    let flag = if options.force || options.branch_merged {
        "-D"
    } else {
        "-d"
    };
    let deleted = run_git(runner, repo, &["branch", flag, branch], git::TIMEOUT).await;
    if !deleted.ok && !deleted.error.contains("not found") {
        let why = or(&deleted.error, "git could not delete it");
        return Some(format!("The branch {branch} was kept: {why}"));
    }
    None
}

/// The git folder a repository's worktrees share (`<repo>/.git`), from any of its worktrees.
async fn git_common_dir(runner: &Runner, cwd: &Path) -> Option<PathBuf> {
    let args = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
    let outcome = run_git(runner, cwd, &args, git::TIMEOUT).await;
    let common = outcome.output.trim();
    (outcome.ok && !common.is_empty()).then(|| PathBuf::from(common))
}

/// The repository's main worktree, from any of its worktrees: a thread's worktree gives the project
/// its fleet knows it by. A bare repository, which has no main worktree, gives the folder's own root.
pub async fn main_worktree(runner: &Runner, cwd: &Path) -> Option<PathBuf> {
    let (root, common) = tokio::join!(git_root(runner, cwd), git_common_dir(runner, cwd));
    let root = root?;
    match common {
        Some(common) if common.file_name() == Some(OsStr::new(".git")) => {
            common.parent().map(Path::to_path_buf)
        }
        _ => Some(root),
    }
}

/// Keeps the threads' worktrees out of the repository's own `git status`, through its local
/// `info/exclude`: the repository's .gitignore stays as it is, and nothing of this is committed.
/// Nothing outside a repository; an error when the file cannot be read or written.
pub async fn exclude_worktrees(runner: &Runner, repo: &Path) -> io::Result<()> {
    let Some(common) = git_common_dir(runner, repo).await else {
        return Ok(());
    };
    let file = common.join("info").join("exclude");
    let line = format!("/{THREAD_WORKTREES}/");
    let current = match fs::read(&file) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error),
    };
    if current.split('\n').any(|entry| entry.trim() == line) {
        return Ok(());
    }
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    let separator = if !current.is_empty() && !current.ends_with('\n') {
        "\n"
    } else {
        ""
    };
    let mut exclude = OpenOptions::new().create(true).append(true).open(&file)?;
    exclude.write_all(format!("{separator}{line}\n").as_bytes())
}

/// What the setup command keeps of each stream: its end, enough for [`SETUP_TAIL_LINES`] lines
/// of any usual length.
const SETUP_STREAM_TAIL: usize = 1024 * 1024;

/// The user's setup command for a fresh worktree (dependencies are not in a new checkout), in a
/// shell there, with the server's environment and no git prompt. It comes from the user's own
/// fleet.json only (config.rs): never from the repository. Stopped after [`SETUP_TIMEOUT`] or
/// once `cancel` is cancelled, which does not count as done. The output is the standard output,
/// then the standard error, its last [`SETUP_TAIL_LINES`] lines; a command stopped or not
/// started says why instead (the runner keeps no output of a stopped child).
pub async fn run_setup(
    runner: &Runner,
    cwd: &Path,
    command: &str,
    cancel: &CancellationToken,
) -> SetupOutcome {
    let env: Env = [("GIT_TERMINAL_PROMPT".into(), "0".into())].into();
    let setup = Command::new("sh", cwd, EnvPolicy::Inherit(env), SETUP_TIMEOUT)
        .args(["-c", command])
        .stdout_limit(StreamLimit::Tail(SETUP_STREAM_TAIL))
        .stderr_limit(StreamLimit::Tail(SETUP_STREAM_TAIL));
    match runner.run(setup, cancel).await {
        Ok(output) => {
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let lines: Vec<&str> = text.trim_end().split('\n').collect();
            let tail = &lines[lines.len().saturating_sub(SETUP_TAIL_LINES)..];
            SetupOutcome {
                ok: output.code == Some(0),
                output: tail.join("\n"),
            }
        }
        Err(RunError::TimedOut) => SetupOutcome {
            ok: false,
            output: format!(
                "It ran longer than {} minutes, and was stopped.",
                SETUP_TIMEOUT.as_secs() / 60
            ),
        },
        Err(error) => SetupOutcome {
            ok: false,
            output: error.to_string(),
        },
    }
}

/// The limit of the status read: the runner's own default size, kept instead of failed.
const DEFAULT_STDOUT_LIMIT_BYTES: usize = 8 * 1024 * 1024;

/// A git command's outcome: whether it exited 0, its output, and what it said went wrong
/// (trimmed). A git that could not start or ran past `timeout` fails, saying why.
struct GitOutcome {
    ok: bool,
    output: String,
    error: String,
}

async fn run_git<S: AsRef<OsStr>>(
    runner: &Runner,
    cwd: &Path,
    args: &[S],
    timeout: Duration,
) -> GitOutcome {
    let command = git::command(cwd, args).timeout(timeout);
    match runner.run(command, &CancellationToken::new()).await {
        Ok(output) => GitOutcome {
            ok: output.code == Some(0),
            output: String::from_utf8_lossy(&output.stdout).into_owned(),
            error: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        },
        Err(error) => GitOutcome {
            ok: false,
            output: String::new(),
            error: error.to_string(),
        },
    }
}

/// A git command's output, or `None` when it fails or takes longer than [`git::TIMEOUT`].
async fn git_output(runner: &Runner, cwd: &Path, args: &[&str]) -> Option<String> {
    let outcome = run_git(runner, cwd, args, git::TIMEOUT).await;
    outcome.ok.then_some(outcome.output)
}

fn non_empty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_owned())
}

/// `value`, or `fallback` when it is empty (TypeScript's `value || fallback`).
fn or<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.is_empty() { fallback } else { value }
}
