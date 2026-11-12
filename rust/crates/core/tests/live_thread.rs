//! The minimal Rust core starts one thread in an isolated herdr session and ends it (issue #270;
//! ADR 0242-phase-3-split, "Rust の core が thread を 1 つ起動して終える").
//!
//! The test starts a headless herdr of its own, the core (`herdr-fleet`) and, with the Rust fleet
//! CLI (`fleet`), a thread whose lead is a real `pi` agent on `opencode-go/deepseek-v4.1-flash`
//! (the `.herdr-fleet/fleet.json` of a temporary git repository). The lead is asked to write a
//! `report.json` that says state `ready`, with a summary and evidence, and to end its turn. Then:
//!
//! - `fleet wait` returns once that turn has ended;
//! - `fleet list --json` shows the run with `outcome.report.state == "ready"`;
//! - `POST /api/fleet/runs/<id>/land {"action":"discard"}` ends the thread;
//! - its worktree, its branch and its pane are gone: herdr's `pane list` is JSON, and its pane ids
//!   are compared whole (`w2:p2` is not `w2:p20`);
//! - the core, sent SIGTERM, ends with status 0 within 10 s.
//!
//! The lead is pi, not the `claude:haiku` the issue names: claude asks "Is this a project you
//! created or one you trust?" in a repository it was not told to trust, and the lead then stops
//! at that question before its first prompt. A linked worktree of a repository claude trusts would
//! not ask, but herdr 0.9.1 refuses `worktree.create` from a linked worktree
//! (`linked_worktree_source`), and answering the question instead would write the person's
//! `~/.claude.json`, which this test must not do. Pi has no trust or approval screen.
//!
//! The requests of the CLI (`fleet thread` is a POST, `fleet wait` and `fleet list` are GETs) all go
//! through the core's access control; the discard is a POST of a raw HTTP/1.1 request.
//!
//! `live_thread` is `#[ignore]`: CI has no herdr, and the lead is a real agent that uses a little of
//! the person's `opencode-go` subscription (the `pi` CLI; no API key). Run it by hand, from `rust/`:
//!
//! ```text
//! env $(env | grep -oE '^HERDR[A-Z_]*' | sed 's/^/-u /') \
//!   cargo test --locked -p herdr-fleet-core --test live_thread -- --ignored --nocapture
//! ```
//!
//! `--nocapture` prints each command, its exit status and its output. The output can hold what the
//! lead's screen shows (`last_output` of the run), such as an account's name or email or a folder's
//! path: read it before it goes into a pull request.
//!
//! The other tests here start neither herdr nor an agent, and run with the rest: they read a run's
//! JSON and herdr's pane list, name the variables a child does not get, decide which folder a
//! failed run keeps, stop a shell with SIGTERM as the last step does the core, and check which roles
//! and standing orders the run's folder gives the lead.
//!
//! The core looks for the nearest `.herdr-fleet/agents` and `.herdr-fleet/standing.md` from the
//! working folder upward, without stopping at a repository's root. The run folder lies in this
//! checkout, which has the Rust project's own lead role and standing orders, so the run folder has
//! an empty `standing.md` and an empty `agents/` of its own under `.herdr-fleet/`: they are the
//! nearer ones, and the lead gets neither of the checkout's.
//!
//! Isolation (`.herdr-fleet/standing.md`, "The factory must keep running"):
//!
//! - no variable of `removed_variables` reaches a child: `HERDR_*`, as the pane this runs in
//!   carries variables that point at the person's herdr and their running fleet; the model
//!   providers' settings and keys (`ANTHROPIC_*`, `OPENAI_*`, `GEMINI_*`, `GOOGLE_*`, `AWS_*`,
//!   `CLAUDE_CODE_USE_*`, `*_API_KEY`), so that the agent runs on the subscription; and the
//!   person's credentials (`*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `GH_*`, `GITHUB_*`, `OPENCODE_*`).
//!   The core and the CLI get only the `HERDR_*` ones this test sets (`HERDR_FLEET_URL`,
//!   `HERDR_FLEET_STATE_DIR`, `HERDR_SOCKET`, `HERDR_FLEET_GROUP`);
//! - herdr runs as the session `herdr-fleet-rs-<run id>` (`<run id>` is `<pid>-<unix seconds>`),
//!   every herdr command names it with `--session`, and it is stopped at the end, also when an
//!   assertion fails;
//! - the core listens on a port from 7400 to 7499, never the running fleet's 7317;
//! - the state folder, the repository, the logs and the empty `.herdr-fleet/` are in
//!   `rust/.dev-state/<run id>/`, which stays after the run as its evidence;
//! - `XDG_CONFIG_HOME` is never the person's `~/.config`. The core's is `<run folder>/config`, where
//!   it looks for the person's fleet config, roles and standing orders
//!   (`$XDG_CONFIG_HOME/herdr-fleet`, issue #270). Every other child's, herdr's and so its panes'
//!   included, is a short folder of this run's own under `/tmp`, where herdr puts the session's
//!   socket: a Unix socket's path ends at 107 bytes (103 on macOS), and herdr's socket under
//!   `<run folder>/config` would be about 160 bytes in a worktree
//!   (`server/reattach.contract.test.ts` has the same reason). It is removed at the end, unless
//!   herdr ran and the run failed or herdr did not stop (`keeps_session_folder`).

#![cfg(unix)]

use std::ffi::OsStr;
use std::fs::{self, DirBuilder, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::net::UnixStream;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

/// What the lead is asked to do: the report is all that is checked.
const TASK: &str = concat!(
    "Write report.json in the result folder your instructions name, as a JSON object with ",
    "\"state\": \"ready\", a non-empty \"summary\" string and a non-empty \"evidence\" list of ",
    "strings, then end your turn. Do nothing else: no code, no commits, no other agents.",
);

/// The repository's `.herdr-fleet/fleet.json`: the thread's lead on pi's
/// `opencode-go/deepseek-v4.1-flash`, with no fallback to another CLI or model.
const FLEET_JSON: &str = r#"{"roles":{"lead":{"agent":"pi","model":"opencode-go/deepseek-v4.1-flash","fallbackModels":[]}}}"#;

/// A Unix socket's path ends at 107 bytes on Linux and 103 on macOS.
const SOCKET_PATH_MAX: usize = 103;

/// Where the core puts the worktree of the thread `id` in the repository `repo`.
fn thread_worktree(repo: &Path, id: &str) -> PathBuf {
    repo.join(".herdr-fleet").join("worktrees").join(id)
}

/// What this run started, and where. Dropping it stops what it started, so that a failed assertion
/// cleans up as a passed run does.
struct Live {
    /// The herdr session, `herdr-fleet-rs-<run id>`.
    session: String,
    /// `XDG_CONFIG_HOME` of every child but the core: herdr's session folder is under it. Short
    /// (see the top of this file), and removed unless [`keeps_session_folder`] says to keep it.
    config_home: PathBuf,
    /// `rust/.dev-state/<run id>/`: `state/` (`HERDR_FLEET_STATE_DIR`), `config/` (the core's
    /// `XDG_CONFIG_HOME`), `zsh/` (`ZDOTDIR`), `repo/`, `.herdr-fleet/` (empty, see the top of this
    /// file), and the logs of herdr and the core. Kept.
    base: PathBuf,
    herdr: Option<Child>,
    core: Option<Child>,
}

impl Live {
    /// Makes the run's folders, which are empty or hold only what this run puts there.
    fn new(run_id: &str) -> Live {
        let rust_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .expect("rust/crates/core is two folders below rust/");
        let base = rust_dir.join(".dev-state").join(run_id);
        make_run_folders(&base);
        let base = fs::canonicalize(&base).expect("the run's folder is there");
        let config_home = PathBuf::from(format!("/tmp/hfrs-{run_id}"));
        // 0700 as `mkdtemp` makes it: herdr's socket is in it, and a socket is a way into its panes
        DirBuilder::new()
            .mode(0o700)
            .create(&config_home)
            .unwrap_or_else(|error| panic!("cannot create {}: {error}", config_home.display()));
        Live {
            session: format!("herdr-fleet-rs-{run_id}"),
            config_home,
            base,
            herdr: None,
            core: None,
        }
    }

    /// A command of this run: the test's own environment without the variables of
    /// [`removed_variables`], and with `XDG_CONFIG_HOME` on this run's own folder.
    fn command(&self, program: impl AsRef<OsStr>) -> Command {
        let mut command = Command::new(program);
        for name in removed_variables() {
            command.env_remove(name);
        }
        command.env("XDG_CONFIG_HOME", &self.config_home);
        command
    }

    /// `herdr --session <this run's session> <args>`: every herdr command names the session, so
    /// that none can reach the person's own.
    fn herdr_command(&self, args: &[&str]) -> Command {
        assert!(
            self.session.starts_with("herdr-fleet-rs-"),
            "the session {} is not one of this project's runs",
            self.session
        );
        let mut command = self.command("herdr");
        command.arg("--session").arg(&self.session).args(args);
        command
    }

    /// Where herdr puts the socket of the session (it follows `XDG_CONFIG_HOME`).
    fn socket(&self) -> PathBuf {
        self.config_home
            .join("herdr")
            .join("sessions")
            .join(&self.session)
            .join("herdr.sock")
    }
}

/// Makes the folders of a run in `base` (see [`Live::base`]), which are empty or hold only what
/// this run puts there.
fn make_run_folders(base: &Path) {
    for folder in ["state", "config", "zsh", "repo", ".herdr-fleet/agents"] {
        let path = base.join(folder);
        fs::create_dir_all(&path)
            .unwrap_or_else(|error| panic!("cannot create {}: {error}", path.display()));
    }
    // empty, so that zsh does not ask its new-user questions in herdr's panes; `ZDOTDIR` keeps
    // those panes from reading the person's zsh files
    fs::write(base.join("zsh").join(".zshrc"), "").expect("an empty .zshrc");
    // empty: the core finds the nearest `.herdr-fleet/standing.md` and `.herdr-fleet/agents` from
    // the working folder upward, so without these it would find this checkout's own
    fs::write(base.join(".herdr-fleet").join("standing.md"), "").expect("an empty standing.md");
}

impl Drop for Live {
    fn drop(&mut self) {
        // the core first, so that it does not go on talking to a herdr that is going away
        if let Some(mut core) = self.core.take() {
            let _ = core.kill();
            let _ = core.wait();
        }
        let herdr_started = self.herdr.is_some();
        let mut stopped = true;
        if let Some(mut server) = self.herdr.take() {
            let _ = execute(
                self.herdr_command(&["server", "stop"]),
                Duration::from_secs(30),
            );
            // the server ends once it is told to stop; one that does not is this run's to kill
            let deadline = Instant::now() + Duration::from_secs(10);
            while matches!(server.try_wait(), Ok(None)) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(100));
            }
            if matches!(server.try_wait(), Ok(None)) {
                stopped = false;
                let _ = server.kill();
            }
            let _ = server.wait();
        }
        let failed = thread::panicking();
        if failed {
            for log in ["core.log", "herdr.log"] {
                print_tail(&self.base.join(log), 40);
            }
        }
        if keeps_session_folder(herdr_started, stopped, failed) {
            println!(
                "kept for the evidence: {} and herdr's session folder {}",
                self.base.display(),
                self.config_home.display()
            );
        } else {
            let _ = fs::remove_dir_all(&self.config_home);
        }
    }
}

/// Does a run leave `/tmp/hfrs-<run id>`, herdr's session folder, as evidence? Only when herdr ran
/// and the run failed or herdr did not stop: a run that never started it has nothing of the
/// session to keep.
fn keeps_session_folder(herdr_started: bool, herdr_stopped: bool, failed: bool) -> bool {
    herdr_started && (failed || !herdr_stopped)
}

/// The prefixes of the variables no child of this run gets. `server/cli-child.ts` passes a CLI a
/// short list of names only, so none of these reaches it: `HERDR_*` points at the person's herdr
/// and their running fleet; `ANTHROPIC_*` to `CLAUDE_CODE_USE_*` are a model provider's keys and
/// settings (a project, a region, the switch to Bedrock or Vertex), which would send an agent
/// somewhere other than the person's subscription (standing orders: the agents run on the
/// person's subscriptions only); `GH_*`, `GITHUB_*` and `OPENCODE_*` are the person's GitHub and
/// OpenCode settings and tokens.
const REMOVED_PREFIXES: [&str; 10] = [
    "HERDR_",
    "ANTHROPIC_",
    "OPENAI_",
    "GEMINI_",
    "GOOGLE_",
    "AWS_",
    "CLAUDE_CODE_USE_",
    "GH_",
    "GITHUB_",
    "OPENCODE_",
];

/// The endings of the variables no child of this run gets, whatever they are for: a key, a token,
/// a secret or a password (`CLAUDE_CODE_MESSAGING_TOKEN` of a Claude Code pane is one).
const REMOVED_SUFFIXES: [&str; 4] = ["_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD"];

/// Does no child of this run get the variable `name`? That is so for a name that starts with one
/// of [`REMOVED_PREFIXES`] and for one that ends with one of [`REMOVED_SUFFIXES`], in any case.
fn is_removed(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    REMOVED_PREFIXES
        .iter()
        .any(|prefix| upper.starts_with(prefix))
        || REMOVED_SUFFIXES
            .iter()
            .any(|suffix| upper.ends_with(suffix))
}

/// The names of the variables no child of this run gets (see [`is_removed`]).
fn removed_variables() -> Vec<String> {
    let mut names: Vec<String> = std::env::vars_os()
        .map(|(name, _)| name.to_string_lossy().into_owned())
        .filter(|name| is_removed(name))
        .collect();
    names.sort();
    names
}

/// The first port from 7400 to 7499 that is free, the range the standing orders give for what a
/// run serves (never the running fleet's 7317). The listener is dropped before this returns, so
/// that the core can take the port.
fn free_port() -> u16 {
    (7400..7500)
        .find(|port| TcpListener::bind(("127.0.0.1", *port)).is_ok())
        .expect("a free port from 7400 to 7499")
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock is after 1970")
        .as_secs()
}

/// What a command that ended printed, and how it ended.
struct Finished {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

fn status_text(status: ExitStatus) -> String {
    status
        .code()
        .map_or_else(|| status.to_string(), |code| code.to_string())
}

/// The command as a shell would take it: its folder, the variables set for it (not the removed
/// ones), the program and its arguments.
fn describe(command: &Command) -> String {
    let mut parts = Vec::new();
    if let Some(dir) = command.get_current_dir() {
        parts.push(format!("cd {} &&", dir.display()));
    }
    for (name, value) in command.get_envs() {
        if let Some(value) = value {
            parts.push(format!(
                "{}={}",
                name.to_string_lossy(),
                value.to_string_lossy()
            ));
        }
    }
    parts.push(command.get_program().to_string_lossy().into_owned());
    parts.extend(command.get_args().map(|arg| format!("{arg:?}")));
    parts.join(" ")
}

fn show(name: &str, text: &str) {
    if text.trim().is_empty() {
        println!("{name}: (empty)");
    } else {
        println!("{name}:");
        for line in text.trim_end().lines() {
            println!("  {line}");
        }
    }
}

/// Reads a pipe to its end on a thread of its own, so that a full pipe never stops the command.
fn drain(mut pipe: impl Read + Send + 'static) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

/// Runs `command` to its end, and prints it, how it ended and what it wrote. One that is still
/// running after `limit` is killed.
fn execute(mut command: Command, limit: Duration) -> Result<Finished, String> {
    println!("$ {}", describe(&command));
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        format!(
            "cannot start {}: {error}",
            command.get_program().to_string_lossy()
        )
    })?;
    let stdout = drain(child.stdout.take().ok_or("no stdout pipe")?);
    let stderr = drain(child.stderr.take().ok_or("no stderr pipe")?);
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("still running after {limit:?}; killed it"));
            }
            Err(error) => return Err(format!("cannot wait for it: {error}")),
        }
    };
    let finished = Finished {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    };
    println!("exit: {}", status_text(status));
    show("stdout", &finished.stdout);
    show("stderr", &finished.stderr);
    Ok(finished)
}

fn run(command: Command, limit: Duration) -> Finished {
    execute(command, limit).unwrap_or_else(|problem| panic!("{problem}"))
}

/// Runs `command` and fails unless it exits with 0.
fn run_ok(what: &str, command: Command, limit: Duration) -> Finished {
    let finished = run(command, limit);
    assert!(
        finished.status.success(),
        "{what} ended with {}",
        status_text(finished.status)
    );
    finished
}

/// Starts a command that stays up (herdr, the core) with its output in `log`.
fn spawn_logged(mut command: Command, log: &Path) -> Child {
    println!("$ {}   (output in {})", describe(&command), log.display());
    let file = File::create(log)
        .unwrap_or_else(|error| panic!("cannot create {}: {error}", log.display()));
    command
        .stdin(Stdio::null())
        .stdout(file.try_clone().expect("the log file is duplicated"))
        .stderr(file);
    command.spawn().unwrap_or_else(|error| {
        panic!(
            "cannot start {}: {error}",
            command.get_program().to_string_lossy()
        )
    })
}

/// Prints the last `lines` of a log, for a run that failed.
fn print_tail(log: &Path, lines: usize) {
    let text = fs::read_to_string(log).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    println!("--- {} (last {lines} lines) ---", log.display());
    for line in &all[all.len().saturating_sub(lines)..] {
        println!("{line}");
    }
}

/// Polls `ready` every `every` until it says yes; fails after `limit`.
fn wait_for(what: &str, limit: Duration, every: Duration, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + limit;
    while !ready() {
        assert!(
            Instant::now() < deadline,
            "timed out after {limit:?}: {what}"
        );
        thread::sleep(every);
    }
}

/// The answer of a raw HTTP/1.1 response: its status code and its body.
fn split_response(response: &str) -> (u16, &str) {
    let (head, body) = response.split_once("\r\n\r\n").unwrap_or((response, ""));
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .unwrap_or_else(|| panic!("not an HTTP response: {response:?}"));
    (status, body)
}

/// One POST of a JSON body to the core over a plain `TcpStream`, with the headers the CLI sends
/// (`x-herdr-fleet: 1`) and no `Origin` or forwarding header: the status code and the body.
fn post_json(port: u16, path: &str, body: &str, limit: Duration) -> (u16, String) {
    println!("$ POST http://127.0.0.1:{port}{path}   {body}");
    let mut stream =
        TcpStream::connect(("127.0.0.1", port)).expect("the core accepts a connection");
    stream
        .set_read_timeout(Some(limit))
        .expect("a read timeout is set");
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nx-herdr-fleet: 1\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .expect("the request is sent");
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .expect("the core answers and closes the connection");
    let response = String::from_utf8_lossy(&response);
    let (status, body) = split_response(&response);
    println!("status: {status}");
    show("body", body);
    (status, body.to_owned())
}

/// Is `id` the id of a pane in `listed`, the standard output of `herdr pane list`? That is one JSON
/// object, `{"id":"cli:pane:list","result":{"panes":[{"pane_id":"w1:p1",…},…],"type":"pane_list"}}`.
/// The ids are compared whole: `w2:p2` is not `w2:p20`, and the id that another field of a pane
/// shows (its tab, its title) is not a pane. Output of another shape, or a pane without its id
/// (nothing could be told gone from it), is an error that shows the output.
fn lists_pane(listed: &str, id: &str) -> Result<bool, String> {
    let json: Value = serde_json::from_str(listed.trim())
        .map_err(|error| format!("herdr's pane list is not JSON ({error}): {listed}"))?;
    let panes = json
        .pointer("/result/panes")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("herdr's pane list has no result.panes array: {listed}"))?;
    let ids = panes
        .iter()
        .map(|pane| {
            pane["pane_id"]
                .as_str()
                .ok_or_else(|| format!("a pane of herdr's pane list has no pane_id: {listed}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids.contains(&id))
}

/// Stops `child` with SIGTERM, as `kill <pid>` does (the crate has no libc to send it itself), and
/// waits up to `limit` for it to end: how it ended, or why it could not be stopped.
fn terminate(child: &mut Child, limit: Duration) -> Result<ExitStatus, String> {
    let pid = child.id().to_string();
    let mut kill = Command::new("kill");
    kill.args(["-TERM", &pid]);
    let sent = execute(kill, Duration::from_secs(10))?;
    if !sent.status.success() {
        return Err(format!(
            "kill -TERM {pid} ended with {}",
            status_text(sent.status)
        ));
    }
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Ok(None) => return Err(format!("still running {limit:?} after SIGTERM")),
            Err(error) => return Err(format!("cannot wait for it: {error}")),
        }
    }
}

/// A string field of a run's JSON; fails with the whole run when it is missing or empty.
fn text<'a>(run: &'a Value, field: &str) -> &'a str {
    run[field]
        .as_str()
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| panic!("the run has no {field}: {run:#}"))
}

/// The JSON a command printed on its standard output.
fn json_of(what: &str, finished: &Finished) -> Value {
    serde_json::from_str(finished.stdout.trim())
        .unwrap_or_else(|error| panic!("{what} did not print JSON ({error})"))
}

/// What the test reads of a run, as `fleet thread --json` and `fleet list --json` print it: the
/// core's `AgentRun`, whose keys are camelCase.
struct ListedRun<'a> {
    id: &'a str,
    /// the thread's own fleet, which `fleet wait` and `fleet list` name
    group: &'a str,
    pane_id: &'a str,
    /// the repository the thread works for: the run's repository
    project: &'a str,
    /// the thread's branch
    branch: &'a str,
    /// `outcome.report.state`: what the lead's last settled turn reported, if it reported
    report_state: Option<&'a str>,
}

/// The fields of a run that the test reads; fails with the whole run when one is missing or empty.
fn listed_run(run: &Value) -> ListedRun<'_> {
    ListedRun {
        id: text(run, "id"),
        group: text(run, "group"),
        pane_id: text(run, "paneId"),
        project: text(run, "project"),
        branch: text(run, "branch"),
        report_state: run.pointer("/outcome/report/state").and_then(Value::as_str),
    }
}

#[test]
#[ignore = "starts herdr and a real pi agent (opencode-go/deepseek-v4.1-flash); run by hand"]
fn live_thread() {
    // 14. each command is printed with its exit status and output by `execute`, a command that
    // stays up by `spawn_logged` (its output is in the run's folder), the raw request by `post_json`

    // 1. and 4.: the run's names and folders, and the guard that stops what the run starts (it
    // exists before anything is started)
    let run_id = format!("{}-{}", std::process::id(), unix_seconds());
    let mut live = Live::new(&run_id);
    let socket = live.socket();
    println!(
        "run {run_id}: herdr session {}, folder {}, XDG_CONFIG_HOME {}",
        live.session,
        live.base.display(),
        live.config_home.display()
    );
    // 2. the environment of every child (`Live::command`): the names only
    println!(
        "removed from every child's environment: {}",
        removed_variables().join(", ")
    );
    println!(
        "to stop herdr by hand: XDG_CONFIG_HOME={} herdr --session {} server stop",
        live.config_home.display(),
        live.session
    );
    // before the build, which takes minutes: herdr cannot bind a socket at a longer path
    assert!(
        socket.as_os_str().len() <= SOCKET_PATH_MAX,
        "{} is longer than a Unix socket's path may be ({SOCKET_PATH_MAX} bytes)",
        socket.display()
    );

    // 3. the Rust fleet CLI, built beside the core (which gives it to the lead as its fleet command)
    let mut build = live.command(env!("CARGO"));
    build
        .args([
            "build",
            "--locked",
            "-p",
            "herdr-fleet-cli",
            "--bin",
            "fleet",
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"));
    run_ok(
        "cargo build of the fleet CLI",
        build,
        Duration::from_secs(900),
    );
    let core_bin = Path::new(env!("CARGO_BIN_EXE_herdr-fleet"));
    let fleet = core_bin.with_file_name("fleet");
    assert!(
        fleet.exists(),
        "{} is not there after the build: run the test with the default profile and target folder",
        fleet.display()
    );

    // 5. herdr: a headless server of the run's session, which zsh in its panes does not read the
    // person's files for
    let mut server = live.herdr_command(&["server"]);
    server
        .env("ZDOTDIR", live.base.join("zsh"))
        .current_dir(&live.base);
    live.herdr = Some(spawn_logged(server, &live.base.join("herdr.log")));
    wait_for(
        "herdr's socket accepts a connection (see herdr.log)",
        Duration::from_secs(15),
        Duration::from_millis(100),
        || {
            let server = live.herdr.as_mut().expect("herdr was started");
            if let Ok(Some(status)) = server.try_wait()
                && !status.success()
            {
                panic!(
                    "herdr ended with {} before its socket answered",
                    status_text(status)
                );
            }
            UnixStream::connect(&socket).is_ok()
        },
    );

    // 6. a repository of its own, with the fleet's config and one commit
    let repo = live.base.join("repo");
    let git = |args: &[&str]| {
        let mut command = live.command("git");
        command.current_dir(&repo).args(args);
        run_ok("git", command, Duration::from_secs(60))
    };
    git(&["init", "-b", "main"]);
    fs::create_dir_all(repo.join(".herdr-fleet")).expect("the .herdr-fleet folder");
    fs::write(repo.join(".herdr-fleet").join("fleet.json"), FLEET_JSON).expect("fleet.json");
    fs::write(
        repo.join("README.md"),
        "# live thread\n\nA repository for tests/live_thread.rs.\n",
    )
    .expect("README.md");
    git(&["add", "-A"]);
    // the author is given to this commit alone, so that no `git config` is written. No signing and
    // no hooks of the person's own git config, which the repository would not have.
    git(&[
        "-c",
        "user.name=live thread",
        "-c",
        "user.email=live-thread@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-m",
        "initial commit",
    ]);

    // 7. a port from 7400 to 7499
    let port = free_port();

    // 8. the core, listening on that port, with herdr's socket, its own state folder and its own
    // folder for the person's fleet config
    let mut core = live.command(core_bin);
    core.env("PORT", port.to_string())
        .env("HERDR_FLEET_STATE_DIR", live.base.join("state"))
        .env("XDG_CONFIG_HOME", live.base.join("config"))
        .env("HERDR_SOCKET", &socket)
        .current_dir(&live.base);
    live.core = Some(spawn_logged(core, &live.base.join("core.log")));
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    wait_for(
        "the core accepts a TCP connection (see core.log)",
        Duration::from_secs(30),
        Duration::from_millis(100),
        || {
            let core = live.core.as_mut().expect("the core was started");
            if let Ok(Some(status)) = core.try_wait() {
                panic!(
                    "the core ended with {} before it listened",
                    status_text(status)
                );
            }
            TcpStream::connect_timeout(&address, Duration::from_secs(1)).is_ok()
        },
    );

    // 9. a thread, started by the Rust CLI against the Rust core
    let url = format!("http://127.0.0.1:{port}");
    let fleet_command = |group: Option<&str>, args: &[&str]| {
        let mut command = live.command(&fleet);
        command
            .current_dir(&repo)
            .env("HERDR_FLEET_URL", &url)
            .args(args);
        if let Some(group) = group {
            command.env("HERDR_FLEET_GROUP", group);
        }
        command
    };
    let started = run_ok(
        "fleet thread",
        fleet_command(
            None,
            &["thread", "--title", "live thread", "--task", TASK, "--json"],
        ),
        Duration::from_secs(300),
    );
    let first = json_of("fleet thread --json", &started);
    let first_run = listed_run(&first);
    let (id, group) = (first_run.id.to_owned(), first_run.group.to_owned());

    // 10. the turn the thread handed its lead ends
    let waited = run(
        fleet_command(Some(&group), &["wait", &id, "--timeout", "900000"]),
        Duration::from_secs(960),
    );
    assert!(
        waited.status.success(),
        "fleet wait ended with {} (4: the lead is blocked on a question, 1: it failed or stopped, \
         124: the wait timed out)",
        status_text(waited.status)
    );

    // 11. what the lead reported
    let listed = run_ok(
        "fleet list",
        fleet_command(Some(&group), &["list", "--json"]),
        Duration::from_secs(60),
    );
    let runs = json_of("fleet list --json", &listed);
    let run = runs
        .as_array()
        .and_then(|runs| runs.iter().find(|run| run["id"] == id.as_str()))
        .unwrap_or_else(|| panic!("fleet list --json has no run {id}: {runs:#}"));
    println!("run {id}:\n{run:#}");
    let lead = listed_run(run);
    assert_eq!(
        lead.report_state,
        Some("ready"),
        "the lead's report is not `ready`: see its outcome in the run above"
    );
    let pane_id = lead.pane_id;

    // 12. the thread ends. While it lives its pane is listed: otherwise "not listed" after the
    // discard would prove nothing.
    let open = run_ok(
        "herdr pane list",
        live.herdr_command(&["pane", "list"]),
        Duration::from_secs(30),
    );
    assert!(
        lists_pane(&open.stdout, pane_id).unwrap_or_else(|problem| panic!("{problem}")),
        "herdr's pane list does not name the lead's pane {pane_id} while its thread lives"
    );
    let (status, body) = post_json(
        port,
        &format!("/api/fleet/runs/{id}/land"),
        r#"{"action":"discard"}"#,
        Duration::from_secs(300),
    );
    assert_eq!(status, 200, "the discard answered {status}: {body}");

    // 13. nothing of the thread is left: no worktree, no branch, no pane (herdr closes it after
    // the answer, so that is polled)
    let (project, branch) = (lead.project, lead.branch);
    let worktree = thread_worktree(Path::new(project), &id);
    assert!(
        !worktree.exists(),
        "the worktree {} is still there",
        worktree.display()
    );
    let mut branches = live.command("git");
    branches.args(["-C", project, "branch", "--list", branch]);
    let branches = run_ok("git branch --list", branches, Duration::from_secs(60));
    assert!(
        branches.stdout.trim().is_empty(),
        "the branch {branch} is still there: {}",
        branches.stdout
    );
    wait_for(
        "the lead's pane is gone from herdr's pane list",
        Duration::from_secs(15),
        Duration::from_secs(1),
        || {
            execute(
                live.herdr_command(&["pane", "list"]),
                Duration::from_secs(30),
            )
            .is_ok_and(|listed| {
                listed.status.success()
                    && !lists_pane(&listed.stdout, pane_id)
                        .unwrap_or_else(|problem| panic!("{problem}"))
            })
        },
    );

    // 15. the core stops on SIGTERM, as the person's `kill` stops it: it ends within 10 s, with 0
    // (`main.rs` ends the process 2 s after the first signal at the latest). The guard's `kill` is
    // for a failed run: it finds the core already gone after this.
    let status = terminate(
        live.core.as_mut().expect("the core was started"),
        Duration::from_secs(10),
    )
    .unwrap_or_else(|problem| panic!("the core did not stop on SIGTERM: {problem}"));
    println!("the core ended with {} after SIGTERM", status_text(status));
    assert!(
        status.success(),
        "the core ended with {} after SIGTERM, not with 0",
        status_text(status)
    );
    println!(
        "live_thread: thread {id} reported ready and was discarded; its pane {pane_id}, its \
         worktree {} and its branch {branch} are gone; the core ended with {} on SIGTERM",
        worktree.display(),
        status_text(status)
    );
}

/// A run as `fleet thread --json` printed it in the first live run of this test (the core's
/// `AgentRun`, camelCase keys), with its paths shortened. Its lead was a claude agent on `haiku`
/// then, before the lead became pi. The lead had not reported in that run, so `outcome` is written
/// as `protocol::TurnOutcome` documents its wire form: `{ report: {…} }`.
const RUN: &str = r#"{
  "id": "1ac7c234",
  "name": "live thread",
  "role": "lead",
  "agent": "claude",
  "group": "fleet-7f683341",
  "herdrName": "f7f683341-lead-1ac7",
  "paneId": "w2:p2",
  "workspaceId": "w2",
  "cwd": "/work/repo/.herdr-fleet/worktrees/1ac7c234",
  "model": "haiku",
  "thinking": "high",
  "state": "blocked",
  "depth": 1,
  "interactive": true,
  "worktree": true,
  "startedAt": 1794474108625,
  "updatedAt": 1794474112501,
  "outcome": { "report": { "state": "ready", "summary": "done", "evidence": ["wrote report.json"] } },
  "branch": "fleet/1ac7c234",
  "project": "/work/repo",
  "base": "e314485361b8a997a483b4f268a9f7a632a131ab",
  "baseBranch": "main"
}"#;

#[test]
fn a_run_is_read_by_the_keys_the_core_writes() {
    let run: Value = serde_json::from_str(RUN).expect("the sample is JSON");
    let read = listed_run(&run);
    assert_eq!(read.id, "1ac7c234");
    assert_eq!(read.group, "fleet-7f683341");
    assert_eq!(read.pane_id, "w2:p2");
    assert_eq!(read.project, "/work/repo");
    assert_eq!(read.branch, "fleet/1ac7c234");
    assert_eq!(read.report_state, Some("ready"));
}

#[test]
fn a_run_that_has_not_reported_has_no_report_state() {
    let mut run: Value = serde_json::from_str(RUN).expect("the sample is JSON");
    run.as_object_mut()
        .expect("the sample is an object")
        .remove("outcome");
    assert_eq!(listed_run(&run).report_state, None);
}

#[test]
fn herdr_and_provider_variables_are_removed_and_the_others_kept() {
    // the prefixes and the suffix as the person's instruction lists them
    for name in [
        "HERDR_SOCKET",
        "HERDR_FLEET_URL",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "OPENAI_ORG_ID",
        "GEMINI_MODEL",
        "GOOGLE_CLOUD_PROJECT",
        "AWS_REGION",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "ANTHROPIC_API_KEY",
        "SOME_API_KEY",
        "some_api_key",
        // the person's credentials: a name that ends in `_TOKEN`, `_SECRET` or `_PASSWORD`, and
        // GitHub's and OpenCode's own
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "SOME_TOKEN",
        "some_token",
        "SOME_SECRET",
        "SOME_PASSWORD",
        "GH_TOKEN",
        "GH_HOST",
        "GITHUB_TOKEN",
        "GITHUB_ACTIONS",
        "OPENCODE_CONFIG_CONTENT",
        "OPENCODE_DISABLE_AUTOUPDATE",
    ] {
        assert!(is_removed(name), "{name} reaches a child");
    }
    for name in [
        "PATH",
        "HOME",
        "TERM",
        "XDG_CONFIG_HOME",
        "CLAUDE_CONFIG_DIR",
        "GOOGLE",
        "AWS",
        "API_KEYS",
        // near misses: the prefix without its `_`, and a word that is in the name but does not end it
        "GHOSTTY_RESOURCES_DIR",
        "PASSWORD_STORE_DIR",
    ] {
        assert!(!is_removed(name), "{name} is removed from a child");
    }
}

/// A folder of the test's own in the system's temporary folder, removed when it is dropped. Each
/// test names its own, as tests run side by side in one process.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Scratch {
        let path = std::env::temp_dir().join(format!("hfrs-scratch-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path)
            .unwrap_or_else(|error| panic!("cannot create {}: {error}", path.display()));
        Scratch(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn a_run_that_failed_before_herdr_started_leaves_no_session_folder() {
    let scratch = Scratch::new("never-started");
    let config_home = scratch.0.join("hfrs-1-2");
    fs::create_dir(&config_home).expect("the session folder");
    let live = Live {
        session: "herdr-fleet-rs-1-2".to_owned(),
        config_home: config_home.clone(),
        base: scratch.0.join("base"),
        herdr: None,
        core: None,
    };
    // a failed assertion unwinds through the guard, as in a failed run
    let outcome = catch_unwind(AssertUnwindSafe(move || {
        let _live = live;
        panic!("the build failed");
    }));
    assert!(outcome.is_err(), "the run did not fail");
    assert!(
        !config_home.exists(),
        "{} is kept though herdr never started",
        config_home.display()
    );
}

#[test]
fn the_run_folder_has_the_nearest_roles_and_standing_orders() {
    let scratch = Scratch::new("roles");
    // the checkout's own `.herdr-fleet/`, in a folder above the run's
    let checkout_fleet = scratch.0.join(".herdr-fleet");
    fs::create_dir_all(checkout_fleet.join("agents")).expect("the checkout's agents folder");
    fs::write(
        checkout_fleet.join("agents").join("lead.md"),
        "---\nname: lead\n---\nthe checkout's lead\n",
    )
    .expect("the checkout's lead role");
    fs::write(
        checkout_fleet.join("standing.md"),
        "the checkout's orders\n",
    )
    .expect("the checkout's standing orders");
    let base = scratch.0.join("rust").join(".dev-state").join("1-2");
    make_run_folders(&base);
    // where the core looks from for a thread of the run: the folder the CLI runs in, and the
    // thread's worktree below it
    for cwd in [
        base.join("repo"),
        thread_worktree(&base.join("repo"), "abc12345"),
    ] {
        assert_eq!(
            orchestrator::config::find_project_path(&cwd, "agents"),
            Some(base.join(".herdr-fleet").join("agents")),
            "the roles of {} are not the run's own",
            cwd.display()
        );
        assert_eq!(
            orchestrator::config::find_project_path(&cwd, "standing.md"),
            Some(base.join(".herdr-fleet").join("standing.md")),
            "the standing orders of {} are not the run's own",
            cwd.display()
        );
        let user_dir = base.join("config").join("herdr-fleet");
        assert_eq!(
            orchestrator::config::load_standing_orders(&cwd, &user_dir),
            "",
            "the lead gets standing orders"
        );
    }
}

/// What `herdr pane list` printed in the last live run, with its paths and names shortened and
/// some fields (the agent's session, the stripped title) left out: one JSON object. The panes are
/// the run's own shell, `w1:p1`, and the lead's, `w2:p2`. Their tabs (`w1:t1`) and the thread's id
/// (`6fc7a85b`, in the lead's title) are in the text, but are not panes.
const PANE_LIST: &str = concat!(
    r#"{"id":"cli:pane:list","result":{"panes":["#,
    r#"{"agent_status":"unknown","cwd":"/work/repo","focused":true,"foreground_cwd":"/work/repo","#,
    r#""pane_id":"w1:p1","revision":1,"scroll":{"max_offset_from_bottom":0,"offset_from_bottom":0,"#,
    r#""viewport_rows":40},"tab_id":"w1:t1","terminal_id":"term_660112214c4ad1","#,
    r#""terminal_title":"user@host:~/work/repo","workspace_id":"w1"},"#,
    r#"{"agent":"pi","agent_status":"done","cwd":"/work/repo/.herdr-fleet/worktrees/6fc7a85b","#,
    r#""display_agent":"lead: live thread","focused":false,"#,
    r#""foreground_cwd":"/work/repo/.herdr-fleet/worktrees/6fc7a85b","pane_id":"w2:p2","revision":3,"#,
    r#""scroll":{"max_offset_from_bottom":0,"offset_from_bottom":0,"viewport_rows":40},"#,
    r#""tab_id":"w2:t1","terminal_id":"term_660112214d2753","#,
    r#""terminal_title":"π - fleet:live thread - 6fc7a85b","title":"live thread","#,
    r#""tokens":{"fleet":"9844a16f","model":"deepseek-v4.1-flash","role":"lead"},"workspace_id":"w2"}"#,
    r#"],"type":"pane_list"}}"#,
);

#[test]
fn a_pane_is_listed_by_the_pane_id_herdr_prints() {
    assert_eq!(lists_pane(PANE_LIST, "w1:p1"), Ok(true));
    assert_eq!(lists_pane(PANE_LIST, "w2:p2"), Ok(true));
    assert_eq!(lists_pane(PANE_LIST, "w3:p3"), Ok(false));
    // in the text, in other fields than `pane_id`
    assert_eq!(lists_pane(PANE_LIST, "w1:t1"), Ok(false));
    assert_eq!(lists_pane(PANE_LIST, "6fc7a85b"), Ok(false));
}

#[test]
fn a_pane_id_that_starts_another_is_a_different_pane() {
    let long =
        r#"{"id":"cli:pane:list","result":{"panes":[{"pane_id":"w2:p20"}],"type":"pane_list"}}"#;
    let short =
        r#"{"id":"cli:pane:list","result":{"panes":[{"pane_id":"w2:p2"}],"type":"pane_list"}}"#;
    assert_eq!(lists_pane(long, "w2:p20"), Ok(true));
    assert_eq!(lists_pane(long, "w2:p2"), Ok(false));
    assert_eq!(lists_pane(short, "w2:p2"), Ok(true));
    assert_eq!(lists_pane(short, "w2:p20"), Ok(false));
}

#[test]
fn a_pane_list_that_is_not_herdrs_json_is_an_error_that_shows_it() {
    for listed in [
        // text that names the ids, as the old text search would have found them
        "w1:p1 w2:p2",
        // JSON, but not the list: an error, or a pane without its id (nothing could be told gone)
        r#"{"id":"cli:pane:list","error":{"code":"no_server"}}"#,
        r#"{"id":"cli:pane:list","result":{"panes":[{"title":"w2:p2"}],"type":"pane_list"}}"#,
    ] {
        let problem = lists_pane(listed, "w2:p2")
            .expect_err("a list of another shape is an error, not an answer");
        assert!(
            problem.contains(listed),
            "the error does not show the output: {problem}"
        );
    }
}

/// Starts `sh -c <script>` and returns once the script has printed a line: the traps it sets
/// before that are in place.
fn spawn_ready(script: &str) -> Child {
    let mut child = Command::new("sh")
        .args(["-c", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .expect("sh starts");
    let mut line = String::new();
    BufReader::new(child.stdout.as_mut().expect("a stdout pipe"))
        .read_line(&mut line)
        .expect("the script prints a line");
    assert_eq!(line.trim(), "ready");
    child
}

#[test]
fn a_process_that_exits_0_on_sigterm_is_stopped_with_its_status() {
    let mut child = spawn_ready("trap 'exit 0' TERM; echo ready; while :; do sleep 0.05; done");
    let status = terminate(&mut child, Duration::from_secs(10));
    let _ = child.kill();
    let _ = child.wait();
    assert!(
        status.expect("it ends after SIGTERM").success(),
        "it did not exit with 0"
    );
}

#[test]
fn a_process_that_ignores_sigterm_is_an_error_after_the_limit() {
    // `exec`: the process that ignores the signal is the one the test holds
    let mut child = spawn_ready("trap '' TERM; echo ready; exec sleep 60");
    let started = Instant::now();
    let outcome = terminate(&mut child, Duration::from_millis(300));
    let _ = child.kill();
    let _ = child.wait();
    assert!(
        outcome.is_err(),
        "{outcome:?} for a process that did not end"
    );
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "it waited far past its limit"
    );
}

#[test]
fn the_session_folder_is_kept_only_when_herdr_ran_and_the_run_failed_or_herdr_did_not_stop() {
    // (herdr was started, herdr stopped, the run failed, the folder is kept)
    for (started, stopped, failed, kept) in [
        (false, true, false, false),
        (false, true, true, false), // failed before herdr: nothing of the session to keep
        (true, true, false, false),
        (true, true, true, true),
        (true, false, false, true), // herdr did not stop
        (true, false, true, true),
    ] {
        assert_eq!(
            keeps_session_folder(started, stopped, failed),
            kept,
            "herdr started {started}, stopped {stopped}; the run failed {failed}"
        );
    }
}
