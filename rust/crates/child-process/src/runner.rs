//! The bounded runner every child outside a pane goes through (ADR 0242-phase-3-split, "子プロセス"):
//! usage probes, model lists, `opencode api`, git, `gh` and the person's setup command.
//!
//! Past its time limit, or once cancelled, a child gets SIGTERM, then SIGKILL [`KILL_GRACE`] later,
//! and the read is given up as long again after that: a CLI that ignores SIGTERM, or a launcher
//! whose own child holds the pipe, must not hold a read for ever (`server/opencode-cli.ts:119-122`).
//! The signals go to the child's pid alone, not to a process group, as TypeScript's `child.kill`
//! does.

use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::pin::pin;
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWriteExt as _};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;

use crate::EnvPolicy;

/// After SIGTERM a child has this long before SIGKILL, and then as long again before the read is
/// given up (`KILL_GRACE_MS`, `server/opencode-cli.ts:16`).
pub const KILL_GRACE: Duration = Duration::from_secs(2);

/// What a [`Command`] keeps of its standard output unless told otherwise: 8 MiB, and a child that
/// writes more fails (the model list's limit, `server/opencode-cli.ts:175`; ADR
/// 0242-phase-3-split).
pub const DEFAULT_STDOUT_LIMIT: StreamLimit = StreamLimit::Fail(8 * 1024 * 1024);

/// What a [`Command`] keeps of its standard error unless told otherwise: the first 4 KiB, the rest
/// read and dropped (`readUpTo(child.stderr, 4096)`, `server/opencode-cli.ts:128`).
pub const DEFAULT_STDERR_LIMIT: StreamLimit = StreamLimit::Head(4096);

/// How much of a stream is kept, and what happens to the rest. The stream is read to its end in
/// each case, so a child never blocks on a full pipe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamLimit {
    /// Keeps up to this many bytes; one more fails the run ([`RunError::TooLarge`]) and kills the
    /// child: a reply that large is no reply.
    Fail(usize),
    /// Keeps the first this many bytes and drops the rest.
    Head(usize),
    /// Keeps the last this many bytes: the end of a long log, where a failure is said.
    Tail(usize),
}

impl StreamLimit {
    fn bytes(self) -> usize {
        match self {
            StreamLimit::Fail(bytes) | StreamLimit::Head(bytes) | StreamLimit::Tail(bytes) => bytes,
        }
    }
}

/// One of a child's two output streams.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

/// Why a run gave no [`Output`].
#[derive(Debug)]
pub enum RunError {
    /// The child could not be started (the program is not there, or not executable).
    Spawn(io::Error),
    /// Reading from or writing to the child failed.
    Io(io::Error),
    /// The child did not end within its time limit, and was stopped.
    TimedOut,
    /// The run was cancelled, and the child stopped.
    Cancelled,
    /// The child wrote more than a [`StreamLimit::Fail`] allows, and was killed.
    TooLarge { stream: Stream, limit: usize },
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunError::Spawn(error) => write!(f, "could not start: {error}"),
            RunError::Io(error) => write!(f, "{error}"),
            RunError::TimedOut => f.write_str("timed out"),
            RunError::Cancelled => f.write_str("cancelled"),
            RunError::TooLarge { stream, limit } => {
                let name = match stream {
                    Stream::Stdout => "output",
                    Stream::Stderr => "error output",
                };
                write!(f, "wrote more than {limit} bytes of {name}")
            }
        }
    }
}

impl std::error::Error for RunError {}

/// What a child that ended said, and how it ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
    /// The exit code; `None` when a signal ended it.
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// A child to start: the program, its arguments, the folder, the environment policy and the time
/// limit, which every start names, and the rest with defaults.
#[derive(Debug, Clone)]
pub struct Command {
    program: OsString,
    args: Vec<OsString>,
    cwd: PathBuf,
    env: EnvPolicy,
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    kill_grace: Duration,
    stdout_limit: StreamLimit,
    stderr_limit: StreamLimit,
}

impl Command {
    /// `program` (a path, or a name looked up in the child's `PATH`) in `cwd`, with the
    /// environment `env` names, stopped once it has run for `timeout`.
    pub fn new(
        program: impl Into<OsString>,
        cwd: impl Into<PathBuf>,
        env: EnvPolicy,
        timeout: Duration,
    ) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: cwd.into(),
            env,
            stdin: None,
            timeout,
            kill_grace: KILL_GRACE,
            stdout_limit: DEFAULT_STDOUT_LIMIT,
            stderr_limit: DEFAULT_STDERR_LIMIT,
        }
    }

    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn args<S: Into<OsString>>(mut self, args: impl IntoIterator<Item = S>) -> Self {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    /// Written to the child's standard input, which is then closed. Without it the child reads
    /// nothing (`/dev/null`). A [`Session`] writes its own lines instead.
    pub fn stdin(mut self, input: Vec<u8>) -> Self {
        self.stdin = Some(input);
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// How long after SIGTERM SIGKILL comes, and after SIGKILL the read is given up
    /// ([`KILL_GRACE`] unless told otherwise).
    pub fn kill_grace(mut self, grace: Duration) -> Self {
        self.kill_grace = grace;
        self
    }

    /// [`DEFAULT_STDOUT_LIMIT`] unless told otherwise. In a [`Session`], the limit's bytes are the
    /// longest line, whatever the variant: a longer line fails the session and kills the child.
    pub fn stdout_limit(mut self, limit: StreamLimit) -> Self {
        self.stdout_limit = limit;
        self
    }

    /// [`DEFAULT_STDERR_LIMIT`] unless told otherwise. A [`Session`] does not read the standard
    /// error: it goes to `/dev/null`, as for `codex app-server` (`server/fleet/usage.ts:426`).
    pub fn stderr_limit(mut self, limit: StreamLimit) -> Self {
        self.stderr_limit = limit;
        self
    }

    fn spawn(&self, stdin: Stdio, stderr: Stdio) -> Result<Child, RunError> {
        let mut command = tokio::process::Command::new(&self.program);
        command
            .args(&self.args)
            .current_dir(&self.cwd)
            .stdin(stdin)
            .stdout(Stdio::piped())
            .stderr(stderr)
            // a child left behind by a dropped run is killed, and reaped by tokio
            .kill_on_drop(true);
        match &self.env {
            EnvPolicy::Only(env) => {
                command.env_clear().envs(env);
            }
            EnvPolicy::Inherit(env) => {
                command.envs(env);
            }
        }
        command.spawn().map_err(RunError::Spawn)
    }
}

/// Starts children, no more at once than its limit: each use has its own (`opencode api` runs 4 at
/// once, `MAX_CHILDREN`, `server/opencode-cli.ts:19`), and its clones share it. A run waits for its
/// turn before its time limit starts.
#[derive(Debug, Clone)]
pub struct Runner {
    slots: Arc<Semaphore>,
}

impl Runner {
    /// A runner with `max_children` children at most at once. A number past what tokio's
    /// semaphore can count (`Semaphore::MAX_PERMITS`) is taken as that many: in practice, no
    /// limit (git and `gh` have none in TypeScript).
    ///
    /// # Panics
    ///
    /// When `max_children` is 0: nothing would ever run.
    pub fn new(max_children: usize) -> Self {
        assert!(max_children > 0, "a runner must let one child run");
        Self {
            slots: Arc::new(Semaphore::new(max_children.min(Semaphore::MAX_PERMITS))),
        }
    }

    async fn slot(&self, cancel: &CancellationToken) -> Result<OwnedSemaphorePermit, RunError> {
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(RunError::Cancelled),
            permit = Arc::clone(&self.slots).acquire_owned() => {
                Ok(permit.expect("the runner never closes its semaphore"))
            }
        }
    }

    /// Runs `command` to its end and returns what it wrote and its exit code (an exit code that is
    /// not 0 is an [`Output`], not an error). Past the time limit, or once `cancel` is cancelled,
    /// the child is stopped (SIGTERM, then SIGKILL) and the run fails.
    pub async fn run(
        &self,
        command: Command,
        cancel: &CancellationToken,
    ) -> Result<Output, RunError> {
        let _slot = self.slot(cancel).await?;
        let stdin = if command.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        };
        let mut child = command.spawn(stdin, Stdio::piped())?;
        let input = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let mut reads = pin!(async {
            let (stdout, stderr, ()) = tokio::try_join!(
                read_stream(stdout, command.stdout_limit, Stream::Stdout),
                read_stream(stderr, command.stderr_limit, Stream::Stderr),
                write_input(input, command.stdin.as_deref().unwrap_or_default()),
            )?;
            Ok::<_, RunError>((stdout, stderr))
        });
        let mut read: Option<(Vec<u8>, Vec<u8>)> = None;
        let mut status: Option<ExitStatus> = None;
        let mut stopping = Stopping::new(command.timeout, command.kill_grace);
        while read.is_none() || status.is_none() {
            tokio::select! {
                outcome = &mut reads, if read.is_none() => match outcome {
                    Ok(both) => read = Some(both),
                    Err(error) => {
                        // a reply too large is dropped: SIGKILL at once (opencode-cli.ts:131), and the
                        // slot is kept until the child is reaped, at most a grace
                        let _ = child.start_kill();
                        let _ = tokio::time::timeout(stopping.grace, child.wait()).await;
                        return Err(stopping.reason.unwrap_or(error));
                    }
                },
                ended = child.wait(), if status.is_none() => {
                    status = Some(ended.map_err(RunError::Io)?);
                }
                () = until(stopping.at) => {
                    if !stopping.next(&mut child, RunError::TimedOut) {
                        break;
                    }
                }
                () = cancel.cancelled(), if stopping.reason.is_none() => {
                    stopping.next(&mut child, RunError::Cancelled);
                }
            }
        }
        if let Some(reason) = stopping.reason {
            let _ = child.start_kill();
            return Err(reason);
        }
        let (stdout, stderr) = read.expect("the loop ends with both or a reason");
        let status = status.expect("the loop ends with both or a reason");
        Ok(Output {
            code: status.code(),
            stdout,
            stderr,
        })
    }

    /// Starts `command` for an exchange of lines on its standard input and output (the JSON-RPC
    /// of `codex app-server`). The time limit covers the whole session, from its start to
    /// [`Session::close`], and the session holds its place among the runner's children until then.
    pub async fn session(
        &self,
        command: Command,
        cancel: &CancellationToken,
    ) -> Result<Session, RunError> {
        let slot = self.slot(cancel).await?;
        let mut child = command.spawn(Stdio::piped(), Stdio::null())?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout is piped");
        let (state, watching) = watch::channel(Ended::Running);
        let closing = CancellationToken::new();
        let killing = CancellationToken::new();
        let stopping = Stopping::new(command.timeout, command.kill_grace);
        let deadline = stopping.at;
        let watcher = tokio::spawn(watch_session(
            child,
            stopping,
            cancel.clone(),
            closing.clone(),
            killing.clone(),
            state,
            slot,
        ));
        Ok(Session {
            stdin,
            stdout,
            buffer: Vec::new(),
            start: 0,
            scanned: 0,
            chunk: vec![0; 64 * 1024].into_boxed_slice(),
            max_line: command.stdout_limit.bytes(),
            ended: None,
            deadline,
            cancel: cancel.clone(),
            state: watching,
            closing,
            killing,
            watcher: Some(watcher),
        })
    }
}

/// The steps that stop a child: SIGTERM at the time limit (or on cancel), SIGKILL a grace later,
/// and the read given up a grace after that.
struct Stopping {
    /// when the next step is due; `None` for a time too far off to reach
    at: Option<Instant>,
    grace: Duration,
    /// set once the child is being stopped: what the run then fails with
    reason: Option<RunError>,
    killed: bool,
}

impl Stopping {
    fn new(timeout: Duration, grace: Duration) -> Self {
        Self {
            at: Instant::now().checked_add(timeout),
            grace,
            reason: None,
            killed: false,
        }
    }

    /// Takes the next step; false when there is none left and the read is given up. `reason` is
    /// what the run fails with when this starts the stopping.
    fn next(&mut self, child: &mut Child, reason: RunError) -> bool {
        self.at = Instant::now().checked_add(self.grace);
        if self.reason.is_none() {
            self.reason = Some(reason);
            terminate(child);
            true
        } else if !self.killed {
            self.killed = true;
            let _ = child.start_kill();
            true
        } else {
            false
        }
    }
}

/// Waits until `at`, or for ever without one (a time limit too far off to add to the clock, as
/// tokio's own `timeout` takes it).
async fn until(at: Option<Instant>) {
    match at {
        Some(at) => sleep_until(at).await,
        None => std::future::pending().await,
    }
}

/// SIGTERM to the child's pid alone (ADR 0242-phase-3-split: no process group). Nothing when it
/// has been reaped: its pid may belong to another process by now.
#[cfg(unix)]
fn terminate(child: &mut Child) {
    use rustix::process::{Pid, Signal, kill_process};
    // `id` is None once the child has been reaped
    if let Some(pid) = child
        .id()
        .and_then(|pid| i32::try_from(pid).ok())
        .and_then(Pid::from_raw)
    {
        let _ = kill_process(pid, Signal::TERM);
    }
}

/// Windows has no SIGTERM: the child is ended at once (ADR 0242-phase-3-split).
#[cfg(not(unix))]
fn terminate(child: &mut Child) {
    let _ = child.start_kill();
}

/// Reads `pipe` to its end, keeping what `limit` says.
async fn read_stream(
    mut pipe: impl AsyncRead + Unpin,
    limit: StreamLimit,
    stream: Stream,
) -> Result<Vec<u8>, RunError> {
    let mut kept = Vec::new();
    let mut chunk = vec![0; 64 * 1024];
    loop {
        let n = pipe.read(&mut chunk).await.map_err(RunError::Io)?;
        if n == 0 {
            break;
        }
        let chunk = &chunk[..n];
        match limit {
            StreamLimit::Fail(max) => {
                if kept.len() + n > max {
                    return Err(RunError::TooLarge { stream, limit: max });
                }
                kept.extend_from_slice(chunk);
            }
            StreamLimit::Head(max) => {
                let room = max.saturating_sub(kept.len());
                kept.extend_from_slice(&chunk[..n.min(room)]);
            }
            StreamLimit::Tail(max) => {
                kept.extend_from_slice(chunk);
                // trimmed now and then, not at every chunk, so a long log is not copied over and over
                if kept.len() > max.saturating_mul(2).max(64 * 1024) {
                    kept.drain(..kept.len() - max);
                }
            }
        }
    }
    if let StreamLimit::Tail(max) = limit
        && kept.len() > max
    {
        kept.drain(..kept.len() - max);
    }
    Ok(kept)
}

/// Writes `input` to the child's standard input and closes it. A child that ends without reading
/// it all is not an error: what it wrote is still read.
async fn write_input(stdin: Option<ChildStdin>, input: &[u8]) -> Result<(), RunError> {
    if let Some(mut stdin) = stdin {
        let _ = stdin.write_all(input).await;
    }
    Ok(())
}

/// Why a session ended before `close`; `Running` while it has not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ended {
    Running,
    /// the child ended on its own: what it wrote is still read, until the time limit or the
    /// cancel, which end the session all the same
    Exited,
    TimedOut,
    Cancelled,
    /// a line past the limit: the child is killed
    TooLarge,
    /// closed, or dropped
    Closed,
}

/// Holds a session's child: stops it at the time limit or on cancel (SIGTERM, then SIGKILL a
/// grace later), kills it at once when the session found a line too long or was dropped, and
/// frees the runner's place once the child is reaped or given up. It runs whether the session
/// reads, writes, or does neither.
async fn watch_session(
    mut child: Child,
    mut stopping: Stopping,
    cancel: CancellationToken,
    closing: CancellationToken,
    killing: CancellationToken,
    state: watch::Sender<Ended>,
    _slot: OwnedSemaphorePermit,
) {
    let set = |ended: Ended| {
        state.send_if_modified(|now| {
            let first = matches!(*now, Ended::Running | Ended::Exited);
            if first {
                *now = ended;
            }
            first
        });
    };
    let first = tokio::select! {
        _ = child.wait() => None,
        () = until(stopping.at) => Some((Ended::TimedOut, false)),
        () = cancel.cancelled() => Some((Ended::Cancelled, false)),
        () = closing.cancelled() => Some((Ended::Closed, false)),
        () = killing.cancelled() => Some((Ended::TooLarge, true)),
    };
    let Some((ended, kill)) = first else {
        // The child ended on its own: its place among the runner's children is free, and its
        // output is still read. A process it started may hold that output open, so the time
        // limit and the cancel still end the session.
        set(Ended::Exited);
        drop(_slot);
        let ended = tokio::select! {
            () = until(stopping.at) => Ended::TimedOut,
            () = cancel.cancelled() => Ended::Cancelled,
            () = closing.cancelled() => Ended::Closed,
            () = killing.cancelled() => Ended::TooLarge,
        };
        set(ended);
        return;
    };
    set(ended);
    let grace = stopping.grace;
    if kill {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(grace, child.wait()).await;
        return;
    }
    // SIGTERM, then SIGKILL a grace later (at once when the session is dropped meanwhile), then
    // given up a grace after that
    stopping.next(&mut child, RunError::TimedOut);
    let ended = tokio::select! {
        ended = tokio::time::timeout(grace, child.wait()) => ended.is_ok(),
        () = killing.cancelled() => false,
    };
    if !ended {
        stopping.next(&mut child, RunError::TimedOut);
        let _ = tokio::time::timeout(grace, child.wait()).await;
    }
}

/// A child started for an exchange of lines ([`Runner::session`]). Its time limit and the cancel
/// stop the child whether the session reads, writes, or does neither; after that, and after a
/// line past the limit (which kills the child at once), every call fails the same way. Dropped
/// without [`Session::close`], the child is killed at once.
#[derive(Debug)]
pub struct Session {
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
    /// what has been read; the lines handed out end at `start`
    buffer: Vec<u8>,
    /// where the next line begins in `buffer`
    start: usize,
    /// `buffer[start..scanned]` holds no newline
    scanned: usize,
    /// where a read lands before it joins `buffer`
    chunk: Box<[u8]>,
    max_line: usize,
    /// why the session ended, once a call has seen it: set at once when this side ends it (a line
    /// too long), before the watcher has seen it, and kept so every later call fails alike
    ended: Option<Ended>,
    /// the time limit and the cancel, also checked here: the watcher may not have run yet
    deadline: Option<Instant>,
    cancel: CancellationToken,
    /// what the watcher saw
    state: watch::Receiver<Ended>,
    closing: CancellationToken,
    killing: CancellationToken,
    watcher: Option<JoinHandle<()>>,
}

impl Session {
    /// Writes `line` and a newline to the child's standard input.
    pub async fn send_line(&mut self, line: &str) -> Result<(), RunError> {
        self.check()?;
        let Some(stdin) = self.stdin.as_mut() else {
            return Err(RunError::Io(io::Error::from(io::ErrorKind::BrokenPipe)));
        };
        let mut bytes = Vec::with_capacity(line.len() + 1);
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
        let state = &mut self.state;
        let written = tokio::select! {
            written = async { stdin.write_all(&bytes).await?; stdin.flush().await } => Some(written),
            // the session ended while the write waited: what it ended with is the answer
            () = ended(state) => None,
        };
        match written {
            Some(written) => written.map_err(RunError::Io),
            None => self.check(),
        }
    }

    /// The next line the child wrote, without its newline (a last line without one counts too);
    /// `None` once the child closed its output. A line longer than the stdout limit fails and
    /// kills the child, and so does the session past its time limit or once cancelled, also with
    /// lines read before. Bytes that are not UTF-8 are replaced with U+FFFD.
    pub async fn next_line(&mut self) -> Result<Option<String>, RunError> {
        loop {
            self.check()?;
            // only the bytes not looked at before: a long line is not scanned again at every read
            let newline = self.buffer[self.scanned..]
                .iter()
                .position(|&byte| byte == b'\n');
            let end = newline.map_or(self.buffer.len(), |at| self.scanned + at);
            if end - self.start > self.max_line {
                self.ended = Some(Ended::TooLarge);
                self.killing.cancel();
                return self.check().map(|()| None);
            }
            if newline.is_some() {
                let line = String::from_utf8_lossy(&self.buffer[self.start..end]).into_owned();
                self.start = end + 1;
                self.scanned = self.start;
                return Ok(Some(line));
            }
            // the lines handed out leave the buffer once per read, not once per line
            self.buffer.drain(..self.start);
            self.start = 0;
            self.scanned = self.buffer.len();
            let state = &mut self.state;
            let n = tokio::select! {
                n = self.stdout.read(&mut self.chunk) => n.map_err(RunError::Io)?,
                // the session ended while the read waited: the loop's check says how
                () = ended(state) => continue,
            };
            if n == 0 {
                self.check()?;
                if self.buffer.is_empty() {
                    return Ok(None);
                }
                self.scanned = 0;
                let line = std::mem::take(&mut self.buffer);
                return Ok(Some(String::from_utf8_lossy(&line).into_owned()));
            }
            self.buffer.extend_from_slice(&self.chunk[..n]);
        }
    }

    /// Ends the session: closes the child's input and sends SIGTERM at once, as the `finally` of
    /// TypeScript's exchange does (`server/fleet/usage.ts:456`), then SIGKILL a grace later to a
    /// child that has not ended, waiting at most two graces.
    pub async fn close(mut self) {
        self.stdin = None;
        self.closing.cancel();
        if let Some(watcher) = self.watcher.take() {
            let _ = watcher.await;
        }
    }

    /// Fails when the session has ended: past its time limit, cancelled, or a line too long.
    fn check(&mut self) -> Result<(), RunError> {
        let ended = self.ended.unwrap_or_else(|| {
            let now = *self.state.borrow();
            if now != Ended::Running && now != Ended::Exited {
                now
            } else if self.cancel.is_cancelled() {
                Ended::Cancelled
            } else if self.deadline.is_some_and(|at| Instant::now() >= at) {
                Ended::TimedOut
            } else {
                now
            }
        });
        // the first reason found stays the reason, whatever the watcher or the token say later
        if !matches!(ended, Ended::Running | Ended::Exited) {
            self.ended = Some(ended);
        }
        match ended {
            Ended::Running | Ended::Exited => Ok(()),
            Ended::TimedOut => Err(RunError::TimedOut),
            Ended::Cancelled | Ended::Closed => Err(RunError::Cancelled),
            Ended::TooLarge => Err(RunError::TooLarge {
                stream: Stream::Stdout,
                limit: self.max_line,
            }),
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // a session dropped without close: its child is killed at once
        if self.watcher.is_some() {
            self.killing.cancel();
        }
    }
}

/// Returns once the watcher has seen the session end (not when the child merely exited, whose
/// output is still read); never when the watcher is gone without that.
async fn ended(state: &mut watch::Receiver<Ended>) {
    let ended = state
        .wait_for(|ended| !matches!(ended, Ended::Running | Ended::Exited))
        .await;
    if ended.is_err() {
        std::future::pending::<()>().await;
    }
}
