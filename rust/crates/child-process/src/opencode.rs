//! Reads of the person's running OpenCode 2 background service through the CLI's own
//! `opencode api`, which finds the service and signs in to it, so this process holds no credential
//! (`server/opencode-cli.ts`). The one place the CLI is run from, for the model list and the
//! conversation.
//!
//! `opencode api` starts the service when none runs: `opencode service status` (a read) asks
//! first, and no service means no read. A 1.x `opencode` does not know `service`, exits with an
//! error, and counts as no service.
//!
//! The signatures are final (ADR 0246-child-process-interface); issue #253 (C2) writes the bodies
//! with the runner. There is no trait here: the conversation reader takes transcript's
//! `OpencodeApi`, which the core implements by wrapping [`OpencodeCli`] (ADR 0107-crate-split).
//! transcript's trait is synchronous: the core calls these functions with tokio's
//! `Handle::block_on` from inside `spawn_blocking` only (from an async task it panics).

use std::ffi::OsString;
use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

use crate::Env;

/// A model list is tens of KB: far less than a page of messages (`MODEL_REPLY_BYTES`,
/// `server/opencode-cli.ts:175`). [`opencode_api_get`]'s limit when the options name none.
#[allow(dead_code, reason = "#253 reads it in opencode_api_get")]
const MODEL_REPLY_BYTES: usize = 8 * 1024 * 1024;

/// A GET that did not answer with a body: the same two cases as transcript's `OpencodeError`, so
/// the core's conversion copies the fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpencodeError {
    /// The CLI answered with an HTTP error: its status code (0 when it named none), and the body's
    /// `_tag` ("" when it had none).
    Http { status: u16, tag: String },
    /// The read failed some other way: no service, no JSON, a time-out, a reply too large.
    Other(String),
}

impl fmt::Display for OpencodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http { status, tag } if tag.is_empty() => {
                write!(formatter, "opencode api answered {status}")
            }
            Self::Http { status, tag } => write!(formatter, "opencode api answered {status} {tag}"),
            Self::Other(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for OpencodeError {}

/// Where and how the CLI runs (`OpencodeCliOptions`, `server/opencode-cli.ts:38`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodeCliOptions {
    /// the CLI's own folder, emptied before the first run; the CLI runs nowhere else
    pub work_dir: PathBuf,
    /// `opencode` unless told otherwise
    pub command: OsString,
    /// the server's environment, of which the CLI gets `child_env` and
    /// `OPENCODE_DISABLE_AUTOUPDATE=true`
    pub env: Env,
    /// how often a reply that exited 0 but is not JSON is read in all (3)
    pub attempts: u32,
    /// 20 seconds
    pub timeout: Duration,
    /// [`KILL_GRACE`](crate::KILL_GRACE)
    pub kill_grace: Duration,
    /// a reply larger than this is no reply; `None`: 32 MiB for [`OpencodeCli`], 8 MiB for
    /// [`opencode_api_get`] (a model list), as `server/opencode-cli.ts:179` puts it in when the
    /// caller names none
    pub max_reply_bytes: Option<usize>,
    /// CLIs running at once, whatever the number of panels and panes asking (4)
    pub max_children: usize,
}

impl OpencodeCliOptions {
    /// The options of `server/opencode-cli.ts` for a CLI in `work_dir`, given the server's `env`.
    pub fn new(work_dir: impl Into<PathBuf>, env: Env) -> Self {
        let _ = (work_dir.into(), env);
        todo!("#253")
    }
}

/// `opencode api GET <path>` and `opencode service status` (`opencodeCli`,
/// `server/opencode-cli.ts:85`).
#[derive(Debug)]
pub struct OpencodeCli {}

impl OpencodeCli {
    pub fn new(options: OpencodeCliOptions) -> Self {
        let _ = options;
        todo!("#253")
    }

    /// The parsed JSON body of a GET.
    pub async fn get(&self, path: &str) -> Result<serde_json::Value, OpencodeError> {
        let _ = path;
        todo!("#253")
    }

    /// Whether the background service answers; never starts it. The answer is kept for a second,
    /// and callers asking at once share one question.
    pub async fn service_running(&self) -> bool {
        todo!("#253")
    }
}

/// The JSON body of `opencode api GET <path>` on the running service, in a folder emptied for the
/// call; fails when no service runs, or it answers with an error or no JSON (`opencodeApiGet`,
/// `server/opencode-cli.ts:178`). With no `max_reply_bytes`, a reply is at most 8 MiB.
pub async fn opencode_api_get(
    options: OpencodeCliOptions,
    path: &str,
) -> Result<serde_json::Value, OpencodeError> {
    let _ = (options, path);
    todo!("#253")
}
