//! The minimal Rust core starts one thread in an isolated herdr session and ends it (issue #270;
//! ADR 0242-phase-3-split, "Rust の core が thread を 1 つ起動して終える").
//!
//! The test starts a headless herdr of its own, the core (`herdr-fleet`) and, with the Rust fleet
//! CLI (`fleet`), a thread whose lead is a real `claude` agent on the model alias `haiku` (the
//! `.herdr-fleet/fleet.json` of a temporary git repository). The lead is asked to write a
//! `report.json` that says state `ready`, with a summary and evidence, and to end its turn. Then:
//!
//! - `fleet wait` returns once that turn has ended;
//! - `fleet list --json` shows the run with `outcome.report.state == "ready"`;
//! - `POST /api/fleet/runs/<id>/land {"action":"discard"}` ends the thread;
//! - its worktree, its branch and its pane are gone.
//!
//! The requests of the CLI (`fleet thread` is a POST, `fleet wait` and `fleet list` are GETs) all go
//! through the core's access control; the discard is a POST of a raw HTTP/1.1 request.
//!
//! The test is `#[ignore]`: CI has no herdr, and the lead is a real agent that uses a little of the
//! person's claude subscription (the `claude` CLI; no API key). Run it by hand, from `rust/`:
//!
//! ```text
//! env $(env | grep -oE '^HERDR[A-Z_]*' | sed 's/^/-u /') \
//!   cargo test --locked -p herdr-fleet-core --test live_thread -- --ignored --nocapture
//! ```
//!
//! `--nocapture` prints each command, its exit status and its output. The output can hold what
//! claude's screen shows (`last_output` of the run), such as the account's name or email: read it
//! before it goes into a pull request.
//!
//! Isolation (`.herdr-fleet/standing.md`, "The factory must keep running"):
//!
//! - no `*_API_KEY` variable reaches a child: the agent runs on the subscription;
//! - no `HERDR_*` variable reaches a child, as the pane this runs in carries variables that point at
//!   the person's herdr and their running fleet; the core and the CLI get only the ones this test
//!   sets (`HERDR_FLEET_URL`, `HERDR_FLEET_STATE_DIR`, `HERDR_SOCKET`, `HERDR_FLEET_GROUP`);
//! - herdr runs as the session `herdr-fleet-rs-<run id>` (`<run id>` is `<pid>-<unix seconds>`),
//!   every herdr command names it with `--session`, and it is stopped at the end, also when an
//!   assertion fails;
//! - the core listens on a port from 7400 to 7499, never the running fleet's 7317;
//! - the state folder, the repository and the logs are in `rust/.dev-state/<run id>/`, which stays
//!   after the run as its evidence;
//! - `XDG_CONFIG_HOME` is never the person's `~/.config`. The core's is `<run folder>/config`, where
//!   it looks for the person's fleet config, roles and standing orders
//!   (`$XDG_CONFIG_HOME/herdr-fleet`, issue #270). Every other child's, herdr's and so its panes'
//!   included, is a short folder of this run's own under `/tmp`, where herdr puts the session's
//!   socket: a Unix socket's path ends at 107 bytes (103 on macOS), and herdr's socket under
//!   `<run folder>/config` would be about 160 bytes in a worktree
//!   (`server/reattach.contract.test.ts` has the same reason).

#![cfg(unix)]

use std::ffi::OsStr;
use std::fs::{self, DirBuilder, File};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::net::UnixStream;
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

/// The repository's `.herdr-fleet/fleet.json`: the thread's lead on claude's `haiku`, with no
/// fallback to another CLI.
const FLEET_JSON: &str =
    r#"{"roles":{"lead":{"agent":"claude","model":"haiku","fallbackModels":[]}}}"#;

/// A Unix socket's path ends at 107 bytes on Linux and 103 on macOS.
const SOCKET_PATH_MAX: usize = 103;

/// What this run started, and where. Dropping it stops what it started, so that a failed assertion
/// cleans up as a passed run does.
struct Live {
    /// The herdr session, `herdr-fleet-rs-<run id>`.
    session: String,
    /// `XDG_CONFIG_HOME` of every child but the core: herdr's session folder is under it. Short
    /// (see the top of this file), and removed after a passed run.
    config_home: PathBuf,
    /// `rust/.dev-state/<run id>/`: `state/` (`HERDR_FLEET_STATE_DIR`), `config/` (the core's
    /// `XDG_CONFIG_HOME`), `zsh/` (`ZDOTDIR`), `repo/`, and the logs of herdr and the core. Kept.
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
        for folder in ["state", "config", "zsh", "repo"] {
            let path = base.join(folder);
            fs::create_dir_all(&path)
                .unwrap_or_else(|error| panic!("cannot create {}: {error}", path.display()));
        }
        // empty, so that zsh does not ask its new-user questions in herdr's panes; `ZDOTDIR` keeps
        // those panes from reading the person's zsh files
        fs::write(base.join("zsh").join(".zshrc"), "").expect("an empty .zshrc");
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

    /// A command of this run: the test's own environment without any `HERDR_*` or `*_API_KEY`
    /// variable, and with `XDG_CONFIG_HOME` on this run's own folder.
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

impl Drop for Live {
    fn drop(&mut self) {
        // the core first, so that it does not go on talking to a herdr that is going away
        if let Some(mut core) = self.core.take() {
            let _ = core.kill();
            let _ = core.wait();
        }
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
        if stopped && !failed {
            let _ = fs::remove_dir_all(&self.config_home);
        } else {
            println!(
                "kept for the evidence: {} and herdr's session folder {}",
                self.base.display(),
                self.config_home.display()
            );
        }
    }
}

/// The names of the variables no child of this run gets: `HERDR_*`, and `*_API_KEY` (standing
/// orders: the agents run on the person's subscriptions only).
fn removed_variables() -> Vec<String> {
    let mut names: Vec<String> = std::env::vars_os()
        .map(|(name, _)| name.to_string_lossy().into_owned())
        .filter(|name| {
            let upper = name.to_ascii_uppercase();
            upper.starts_with("HERDR_") || upper.ends_with("_API_KEY")
        })
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

/// Does `text` name `id` as a whole? `w1:p1` is in `[w1:p1]` and in `"w1:p1"`, but not in `w1:p12`.
/// Any character that is not a letter or a digit ends a name, so a doubtful match counts as a
/// mention.
fn mentions(text: &str, id: &str) -> bool {
    text.match_indices(id).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + id.len()..].chars().next();
        !before.is_some_and(|c| c.is_ascii_alphanumeric())
            && !after.is_some_and(|c| c.is_ascii_alphanumeric())
    })
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

#[test]
#[ignore = "starts herdr and a real claude agent (haiku); run by hand"]
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

    // 6. a repository with the fleet's config and one commit
    let repo = live.base.join("repo");
    let git = |args: &[&str]| {
        let mut command = live.command("git");
        command.current_dir(&repo).args(args);
        run_ok("git", command, Duration::from_secs(60))
    };
    git(&["init", "-b", "main"]);
    git(&["config", "user.name", "live thread"]);
    git(&["config", "user.email", "live-thread@example.invalid"]);
    fs::create_dir_all(repo.join(".herdr-fleet")).expect("the .herdr-fleet folder");
    fs::write(repo.join(".herdr-fleet").join("fleet.json"), FLEET_JSON).expect("fleet.json");
    fs::write(
        repo.join("README.md"),
        "# live thread\n\nA repository for tests/live_thread.rs.\n",
    )
    .expect("README.md");
    git(&["add", "-A"]);
    // no signing and no hooks of the person's own git config, which the repository would not have
    git(&[
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
    let id = text(&first, "id").to_owned();
    let group = text(&first, "group").to_owned();

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
    assert_eq!(
        run.pointer("/outcome/report/state").and_then(Value::as_str),
        Some("ready"),
        "the lead's report is not `ready`: see its outcome in the run above"
    );
    let pane_id = text(run, "pane_id");

    // 12. the thread ends. While it lives its pane is listed: otherwise "not listed" after the
    // discard would prove nothing.
    let open = run_ok(
        "herdr pane list",
        live.herdr_command(&["pane", "list"]),
        Duration::from_secs(30),
    );
    assert!(
        mentions(&open.stdout, pane_id),
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
    let project = text(run, "project");
    let branch = text(run, "branch");
    let worktree = Path::new(project)
        .join(".herdr-fleet")
        .join("worktrees")
        .join(&id);
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
                    && !mentions(&listed.stdout, pane_id)
                    && !mentions(&listed.stderr, pane_id)
            })
        },
    );
    println!(
        "live_thread: thread {id} reported ready and was discarded; its pane {pane_id}, its \
         worktree {} and its branch {branch} are gone",
        worktree.display()
    );
}
