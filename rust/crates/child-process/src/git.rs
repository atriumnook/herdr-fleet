//! How the server runs git (`server/fleet/thread.ts:15-43`, `server/files.ts:9-27`).
//!
//! A folder git looks at may be a repository nobody vetted, and its config can name commands git
//! runs on its own: `core.fsmonitor` runs on `status`, `diff` and `ls-files`. It is turned off
//! here, on the command line, which wins over every config file and `GIT_CONFIG_COUNT`.
//! `GIT_OPTIONAL_LOCKS=0` keeps git from rewriting the index while it looks, and
//! `GIT_TERMINAL_PROMPT=0` from asking for a password nobody would type.

use std::ffi::OsStr;
use std::path::Path;
use std::time::Duration;

use crate::{Command, Env, EnvPolicy};

/// A git command's time limit unless its caller says otherwise (`server/fleet/thread.ts:31`).
pub const TIMEOUT: Duration = Duration::from_secs(5);

/// The limit of the quick reads: the repository a folder lies in and the files of a pane's folder
/// (`gitRoot`, `server/fleet/thread.ts:21`; `gitFiles`, `server/files.ts:20`).
pub const QUICK_TIMEOUT: Duration = Duration::from_secs(3);

/// `git <args>` in `cwd`: `git -c core.fsmonitor=false -c core.quotepath=false -C <cwd> <args>`
/// (paths as they are, not octal-escaped, for the person to read), with the server's environment
/// and `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0` over it, and [`TIMEOUT`]. The caller runs
/// it with a [`Runner`](crate::Runner), and may change its time limit or output limits first.
pub fn command<S: AsRef<OsStr>>(cwd: &Path, args: &[S]) -> Command {
    let env: Env = [("GIT_OPTIONAL_LOCKS", "0"), ("GIT_TERMINAL_PROMPT", "0")]
        .into_iter()
        .map(|(name, value)| (name.into(), value.into()))
        .collect();
    Command::new("git", cwd, EnvPolicy::Inherit(env), TIMEOUT)
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.quotepath=false",
            "-C",
        ])
        .arg(cwd)
        .args(args.iter().map(AsRef::as_ref))
}
