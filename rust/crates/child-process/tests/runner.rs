//! The bounded runner (ADR 0242-phase-3-split, "子プロセス"): the time limit and the kill, the
//! limits on what is read, the number of children at once, cancellation, the standard input, the
//! line-by-line exchange `codex app-server` speaks, and the environment policy every start names.
//!
//! Each test starts a fake executable in a temporary folder. The ones moved from
//! `server/opencode-cli.test.ts` name its `test`; their expected values are its own. The others
//! are worked out by hand from ADR 0242-phase-3-split and the TypeScript they name.

#![cfg(unix)]

mod common;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::time::{Duration, Instant};

use common::{TempDir, fake, read, sh_quote};
use herdr_fleet_child_process::{Command, EnvPolicy, KILL_GRACE, RunError, Runner, StreamLimit};
use tokio_util::sync::CancellationToken;

const SHORT: Duration = Duration::from_millis(300);

fn env(pairs: &[(&str, &str)]) -> BTreeMap<OsString, OsString> {
    pairs
        .iter()
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect()
}

/// A command for the fake `program` in `dir`, with the server's environment and a limit of 10
/// seconds.
fn command(program: &std::path::Path, dir: &TempDir) -> Command {
    Command::new(
        program,
        dir.path(),
        EnvPolicy::Inherit(BTreeMap::new()),
        Duration::from_secs(10),
    )
}

#[test]
fn the_kill_grace_is_two_seconds() {
    // server/opencode-cli.ts: KILL_GRACE_MS = 2_000; ADR 0242-phase-3-split: "2 秒後に SIGKILL"
    assert_eq!(KILL_GRACE, Duration::from_secs(2));
}

#[tokio::test]
async fn returns_what_the_child_wrote_and_its_exit_code() {
    let dir = TempDir::new("output");
    let program = fake(
        dir.path(),
        "cli",
        "printf 'out %s' \"$1\"; printf 'err' >&2; exit 3",
    );
    let output = Runner::new(1)
        .run(
            command(&program, &dir).arg("one"),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(output.code, Some(3));
    assert_eq!(output.stdout, b"out one");
    assert_eq!(output.stderr, b"err");
}

#[tokio::test]
async fn runs_in_the_folder_it_is_given() {
    let dir = TempDir::new("cwd");
    let work = dir.join("work");
    std::fs::create_dir(&work).unwrap();
    let program = fake(dir.path(), "cli", "pwd");
    let output = Runner::new(1)
        .run(
            Command::new(
                &program,
                &work,
                EnvPolicy::Inherit(BTreeMap::new()),
                SHORT * 10,
            ),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim_end(),
        work.to_str().unwrap()
    );
}

#[tokio::test]
async fn a_program_that_is_not_there_fails_to_start() {
    let dir = TempDir::new("missing");
    let error = Runner::new(1)
        .run(
            Command::new(
                dir.join("no-such-cli"),
                dir.path(),
                EnvPolicy::Inherit(BTreeMap::new()),
                SHORT,
            ),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(matches!(error, RunError::Spawn(_)), "{error:?}");
}

#[tokio::test]
async fn writes_the_standard_input_and_closes_it() {
    let dir = TempDir::new("stdin");
    // cat ends only when its input is closed
    let program = fake(dir.path(), "cli", "cat");
    let output = Runner::new(1)
        .run(
            command(&program, &dir).stdin(b"the prompt\n".to_vec()),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(output.stdout, b"the prompt\n");
}

#[tokio::test]
async fn without_input_the_child_reads_nothing() {
    let dir = TempDir::new("no-stdin");
    let program = fake(dir.path(), "cli", "cat; echo done");
    let output = Runner::new(1)
        .run(command(&program, &dir), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(output.stdout, b"done\n");
}

/// The minimal environment: the child gets these variables and nothing else (server/cli-child.ts:
/// "The CLI's whole environment").
#[tokio::test]
async fn the_minimal_policy_passes_only_what_it_names() {
    let dir = TempDir::new("env-only");
    let cmd = Command::new(
        "/usr/bin/env",
        dir.path(),
        EnvPolicy::Only(env(&[("ONLY_ME", "x"), ("ALSO", "y z")])),
        SHORT * 10,
    );
    let output = Runner::new(1)
        .run(cmd, &CancellationToken::new())
        .await
        .unwrap();
    let mut lines: Vec<_> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect();
    lines.sort();
    assert_eq!(lines, ["ALSO=y z", "ONLY_ME=x"]);
}

/// The inherited environment: the server's, with what the caller adds laid over it
/// (server/fleet/github.ts:14, server/fleet/thread.ts:174).
#[tokio::test]
async fn the_inheriting_policy_passes_the_servers_environment_and_what_it_adds() {
    let dir = TempDir::new("env-inherit");
    let path = std::env::var("PATH").expect("the test runs with a PATH");
    let cmd = Command::new(
        "/usr/bin/env",
        dir.path(),
        EnvPolicy::Inherit(env(&[("GH_PROMPT_DISABLED", "1"), ("PATH", "/replaced")])),
        SHORT * 10,
    );
    let output = Runner::new(1)
        .run(cmd, &CancellationToken::new())
        .await
        .unwrap();
    let text = String::from_utf8(output.stdout).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert!(lines.contains(&"GH_PROMPT_DISABLED=1"), "{text}");
    assert!(lines.contains(&"PATH=/replaced"), "{text}");
    assert!(!lines.contains(&format!("PATH={path}").as_str()), "{text}");
    // something of the test's own environment besides PATH passes too
    let home = std::env::var("HOME").expect("the test runs with a HOME");
    assert!(lines.contains(&format!("HOME={home}").as_str()), "{text}");
}

/// Past the time limit the child gets SIGTERM, and a CLI that heeds it ends there.
#[tokio::test]
async fn past_the_time_limit_the_child_gets_sigterm() {
    let dir = TempDir::new("sigterm");
    let marker = dir.join("term");
    let program = fake(
        dir.path(),
        "cli",
        &format!(
            "trap 'echo term > {}; kill $pid; exit 0' TERM\nsleep 30 >/dev/null 2>&1 &\npid=$!\nwait $pid",
            sh_quote(&marker)
        ),
    );
    let started = Instant::now();
    let error = Runner::new(1)
        .run(
            command(&program, &dir)
                .timeout(SHORT)
                .kill_grace(Duration::from_secs(5)),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(matches!(error, RunError::TimedOut), "{error:?}");
    assert_eq!(read(&marker), "term\n");
    // it ended at SIGTERM, long before the grace would have sent SIGKILL
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
}

/// SIGTERM goes to the child alone, not to a process group: a process the child started stays
/// (TypeScript's `child.kill` signals the child's pid; ADR 0242-phase-3-split).
#[cfg(target_os = "linux")]
#[tokio::test]
async fn sigterm_goes_to_the_child_alone() {
    let dir = TempDir::new("no-group");
    let pid_file = dir.join("pid");
    let program = fake(
        dir.path(),
        "cli",
        &format!(
            "sleep 30 >/dev/null 2>&1 &\necho $! > {}\nexec sleep 30",
            sh_quote(&pid_file)
        ),
    );
    let error = Runner::new(1)
        .run(
            command(&program, &dir).timeout(SHORT),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(matches!(error, RunError::TimedOut), "{error:?}");
    let pid: u32 = read(&pid_file).trim().parse().unwrap();
    let alive = common::alive(pid);
    let _ = std::process::Command::new("kill")
        .arg(pid.to_string())
        .status();
    assert!(alive, "the grandchild was signalled too");
}

/// `server/opencode-cli.test.ts`: "a CLI that ignores SIGTERM is killed, and the read ends with a
/// timeout that is not tried again" (the kill), with the grace of the server: SIGKILL two seconds
/// after SIGTERM.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_child_that_ignores_sigterm_gets_sigkill_after_the_grace() {
    let dir = TempDir::new("sigkill");
    let pid_file = dir.join("pid");
    // exec: the pid is sleep's own, which keeps the ignored SIGTERM
    let program = fake(
        dir.path(),
        "cli",
        &format!(
            "trap '' TERM\necho $$ > {}\nexec sleep 30",
            sh_quote(&pid_file)
        ),
    );
    let started = Instant::now();
    let error = Runner::new(1)
        .run(
            command(&program, &dir).timeout(SHORT),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    let elapsed = started.elapsed();
    assert!(matches!(error, RunError::TimedOut), "{error:?}");
    // the limit, then the grace of 2 s before SIGKILL, and no second grace: the pipe closed with it
    assert!(elapsed >= SHORT + KILL_GRACE, "{elapsed:?}");
    assert!(
        elapsed < SHORT + KILL_GRACE + Duration::from_millis(1500),
        "{elapsed:?}"
    );
    let pid: u32 = read(&pid_file).trim().parse().unwrap();
    assert!(!common::alive(pid));
}

/// A launcher whose child holds the pipe: after SIGKILL the read is given up one grace later
/// (`server/opencode-cli.ts:119-122`).
#[cfg(target_os = "linux")]
#[tokio::test]
async fn the_read_is_given_up_a_grace_after_sigkill() {
    let dir = TempDir::new("give-up");
    let pid_file = dir.join("pid");
    let grace = Duration::from_millis(400);
    // the shell ignores SIGTERM and dies of SIGKILL; its sleep keeps stdout open
    let program = fake(
        dir.path(),
        "cli",
        &format!(
            "trap '' TERM\nsleep 30 &\necho $! > {}\nwait",
            sh_quote(&pid_file)
        ),
    );
    let started = Instant::now();
    let error = Runner::new(1)
        .run(
            command(&program, &dir).timeout(SHORT).kill_grace(grace),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    let elapsed = started.elapsed();
    let pid: u32 = read(&pid_file).trim().parse().unwrap();
    let _ = std::process::Command::new("kill")
        .arg("-9")
        .arg(pid.to_string())
        .status();
    assert!(matches!(error, RunError::TimedOut), "{error:?}");
    assert!(elapsed >= SHORT + grace * 2, "{elapsed:?}");
    assert!(
        elapsed < SHORT + grace * 2 + Duration::from_millis(1500),
        "{elapsed:?}"
    );
}

/// `server/opencode-cli.test.ts`: "a reply past the limit is dropped, not held".
#[tokio::test]
async fn a_reply_past_the_limit_is_dropped() {
    let dir = TempDir::new("too-large");
    let program = fake(dir.path(), "cli", "head -c 5000 /dev/zero | tr '\\0' a");
    let error = Runner::new(1)
        .run(
            command(&program, &dir).stdout_limit(StreamLimit::Fail(1000)),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(error, RunError::TooLarge { limit: 1000, .. }),
        "{error:?}"
    );
}

/// The dropped reply does not wait for the child: one that keeps writing is killed.
#[tokio::test]
async fn a_child_writing_past_the_limit_is_not_waited_for() {
    let dir = TempDir::new("too-large-endless");
    let program = fake(dir.path(), "cli", "trap '' TERM\nexec yes");
    let started = Instant::now();
    let error = Runner::new(1)
        .run(
            command(&program, &dir).stdout_limit(StreamLimit::Fail(1000)),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(matches!(error, RunError::TooLarge { .. }), "{error:?}");
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
}

/// What a CLI says on stderr is kept up to its limit, the rest read and dropped
/// (server/opencode-cli.ts reads 4096 bytes of it).
#[tokio::test]
async fn stderr_is_kept_up_to_its_limit() {
    let dir = TempDir::new("stderr-head");
    let program = fake(
        dir.path(),
        "cli",
        "printf 'begin'; head -c 100000 /dev/zero | tr '\\0' e >&2; printf 'end'",
    );
    let output = Runner::new(1)
        .run(
            command(&program, &dir).stderr_limit(StreamLimit::Head(4096)),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(output.stdout, b"beginend");
    assert_eq!(output.stderr, vec![b'e'; 4096]);
}

/// The last bytes, for a command whose end says what went wrong (the setup command keeps its
/// last 20 lines, server/fleet/thread.ts:182).
#[tokio::test]
async fn the_tail_keeps_the_last_bytes() {
    let dir = TempDir::new("tail");
    let program = fake(
        dir.path(),
        "cli",
        "i=1; while [ $i -le 1000 ]; do echo \"line $i\"; i=$((i+1)); done",
    );
    let output = Runner::new(1)
        .run(
            command(&program, &dir).stdout_limit(StreamLimit::Tail(19)),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(output.stdout, b"line 999\nline 1000\n");
}

/// `server/opencode-cli.test.ts`: "no more CLIs run at once than allowed, however many ask".
#[tokio::test]
async fn no_more_children_run_at_once_than_allowed() {
    let dir = TempDir::new("overlap");
    let log = dir.join("overlap");
    let program = fake(
        dir.path(),
        "cli",
        &format!(
            "echo start >> {log}; sleep 0.3; echo end >> {log}",
            log = sh_quote(&log)
        ),
    );
    let runner = Runner::new(2);
    let runs: Vec<_> = (0..6)
        .map(|_| {
            let runner = runner.clone();
            let cmd = command(&program, &dir);
            tokio::spawn(async move { runner.run(cmd, &CancellationToken::new()).await })
        })
        .collect();
    for run in runs {
        run.await.unwrap().unwrap();
    }
    let (mut open, mut most) = (0, 0);
    for line in read(&log).lines() {
        open += if line == "start" { 1 } else { -1 };
        most = most.max(open);
    }
    assert_eq!(most, 2);
}

/// A cancelled run stops its child as a timeout does: SIGTERM first.
#[tokio::test]
async fn a_cancelled_run_stops_its_child() {
    let dir = TempDir::new("cancel");
    let marker = dir.join("term");
    let program = fake(
        dir.path(),
        "cli",
        &format!(
            "trap 'echo term > {}; kill $pid; exit 0' TERM\nsleep 30 >/dev/null 2>&1 &\npid=$!\nwait $pid",
            sh_quote(&marker)
        ),
    );
    let cancel = CancellationToken::new();
    let later = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(SHORT).await;
        later.cancel();
    });
    let started = Instant::now();
    let error = Runner::new(1)
        .run(command(&program, &dir), &cancel)
        .await
        .unwrap_err();
    assert!(matches!(error, RunError::Cancelled), "{error:?}");
    assert_eq!(read(&marker), "term\n");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
}

/// A run cancelled while it waits for its turn never starts.
#[tokio::test]
async fn a_run_cancelled_before_its_turn_never_starts() {
    let dir = TempDir::new("cancel-queued");
    let log = dir.join("log");
    let slow = fake(dir.path(), "slow", "sleep 0.5");
    let program = fake(
        dir.path(),
        "cli",
        &format!("echo ran >> {}", sh_quote(&log)),
    );
    let runner = Runner::new(1);
    let busy = tokio::spawn({
        let runner = runner.clone();
        let cmd = command(&slow, &dir);
        async move { runner.run(cmd, &CancellationToken::new()).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let cancel = CancellationToken::new();
    cancel.cancel();
    let error = runner
        .run(command(&program, &dir), &cancel)
        .await
        .unwrap_err();
    assert!(matches!(error, RunError::Cancelled), "{error:?}");
    busy.await.unwrap().unwrap();
    assert_eq!(read(&log), "");
}

/// The exchange of `codex app-server` (server/fleet/usage.ts:426, model-lists.ts:127): a line
/// written, the answers read line by line, among lines that are not answers.
#[tokio::test]
async fn a_session_writes_lines_and_reads_the_answers_line_by_line() {
    let dir = TempDir::new("session");
    let program = fake(
        dir.path(),
        "cli",
        "echo 'a notice'\nwhile read -r line; do echo \"got $line\"; echo \"again $line\"; done",
    );
    let mut session = Runner::new(1)
        .session(command(&program, &dir), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        session.next_line().await.unwrap().as_deref(),
        Some("a notice")
    );
    session.send_line(r#"{"id":1}"#).await.unwrap();
    assert_eq!(
        session.next_line().await.unwrap().as_deref(),
        Some(r#"got {"id":1}"#)
    );
    assert_eq!(
        session.next_line().await.unwrap().as_deref(),
        Some(r#"again {"id":1}"#)
    );
    session.send_line("two").await.unwrap();
    assert_eq!(
        session.next_line().await.unwrap().as_deref(),
        Some("got two")
    );
    session.close().await;
}

/// A child that closes its output ends the session's lines.
#[tokio::test]
async fn a_session_ends_when_the_child_closes_its_output() {
    let dir = TempDir::new("session-eof");
    let program = fake(dir.path(), "cli", "echo one");
    let mut session = Runner::new(1)
        .session(command(&program, &dir), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(session.next_line().await.unwrap().as_deref(), Some("one"));
    assert_eq!(session.next_line().await.unwrap(), None);
    session.close().await;
}

/// The time limit covers the whole session (`setTimeout(..., 15_000)` around the whole exchange,
/// server/fleet/usage.ts:427).
#[tokio::test]
async fn the_time_limit_covers_the_whole_session() {
    let dir = TempDir::new("session-timeout");
    let program = fake(
        dir.path(),
        "cli",
        "while read -r line; do sleep 0.2; echo \"got $line\"; done",
    );
    let mut session = Runner::new(1)
        .session(
            command(&program, &dir).timeout(Duration::from_millis(500)),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let started = Instant::now();
    let mut outcome = Ok(None);
    for n in 0..10 {
        session.send_line(&n.to_string()).await.ok();
        outcome = session.next_line().await;
        if outcome.is_err() {
            break;
        }
    }
    assert!(matches!(outcome, Err(RunError::TimedOut)), "{outcome:?}");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
}

/// A line longer than the output's limit is refused, not held.
#[tokio::test]
async fn a_session_line_past_the_limit_is_refused() {
    let dir = TempDir::new("session-too-large");
    let program = fake(
        dir.path(),
        "cli",
        "head -c 5000 /dev/zero | tr '\\0' a; echo",
    );
    let mut session = Runner::new(1)
        .session(
            command(&program, &dir).stdout_limit(StreamLimit::Fail(1000)),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let outcome = session.next_line().await;
    assert!(
        matches!(outcome, Err(RunError::TooLarge { limit: 1000, .. })),
        "{outcome:?}"
    );
    session.close().await;
}

/// Closing a session stops a child that has not ended (the `finally { child.kill() }` of
/// server/fleet/usage.ts:463).
#[cfg(target_os = "linux")]
#[tokio::test]
async fn closing_a_session_stops_its_child() {
    let dir = TempDir::new("session-close");
    let pid_file = dir.join("pid");
    let program = fake(
        dir.path(),
        "cli",
        &format!("echo $$ > {}\nexec sleep 30", sh_quote(&pid_file)),
    );
    let session = Runner::new(1)
        .session(command(&program, &dir), &CancellationToken::new())
        .await
        .unwrap();
    while read(&pid_file).trim().is_empty() {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let pid: u32 = read(&pid_file).trim().parse().unwrap();
    session.close().await;
    assert!(!common::alive(pid));
}

/// A session holds its place among the runner's children until it is closed.
#[tokio::test]
async fn a_session_counts_among_the_children() {
    let dir = TempDir::new("session-slot");
    let log = dir.join("log");
    let program = fake(
        dir.path(),
        "cli",
        &format!("echo ran >> {}", sh_quote(&log)),
    );
    let waiting = fake(
        dir.path(),
        "wait",
        "while read -r line; do echo \"$line\"; done",
    );
    let runner = Runner::new(1);
    let mut session = runner
        .session(command(&waiting, &dir), &CancellationToken::new())
        .await
        .unwrap();
    let queued = tokio::spawn({
        let runner = runner.clone();
        let cmd = command(&program, &dir);
        async move { runner.run(cmd, &CancellationToken::new()).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(read(&log), "");
    session.send_line("x").await.unwrap();
    assert_eq!(session.next_line().await.unwrap().as_deref(), Some("x"));
    session.close().await;
    queued.await.unwrap().unwrap();
    assert_eq!(read(&log), "ran\n");
}
