//! The fleet CLI as a library: [`run`] takes what a process has (the arguments, the environment,
//! the working folder and the standard streams) and returns the exit status. `main.rs` hands it
//! the process's own; the orchestrator's tests call it against the router (ADR
//! 0242-phase-3-split, CC). It reads nothing of the process itself (no `std::env`, no
//! `current_dir`, no zone from the process's `TZ`), so that tests in one process can call it side
//! by side with different environments.
//!
//! It has the arguments, output and exit statuses of `bin/fleet.ts` (the fleet CLI contract,
//! `fixtures/fleet-cli/`), with the differences ADR 0242-phase-3-split decided: times in the
//! en-US form whatever the locale, and `report --hours` percent-encoded in the query (#189).
//! The answers of `/api/fleet` are read into `protocol::fleet_cli`, where every field is optional
//! (ADR 0244-phase-3-dependencies), and `--json` prints the server's JSON itself.
//!
//! Responsibility and dependencies: docs/rust-migration/adr/0107-crate-split.md.

mod args;
mod commands;
mod describe;
mod http;
mod js;
mod texts;
mod time;

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::Path;

use serde_json::Value;

/// Why a command ended early: the message after `fleet: `, the exit status, and for a
/// `wait_timeout` answer the run it names.
#[derive(Debug)]
pub(crate) struct Failure {
    pub message: String,
    pub exit: i32,
    pub run: Option<Value>,
}

impl Failure {
    pub fn new(message: impl Into<String>, exit: i32) -> Failure {
        Failure {
            message: message.into(),
            exit,
            run: None,
        }
    }

    /// A usage error: exit 2.
    pub fn usage(message: impl Into<String>) -> Failure {
        Failure::new(message, 2)
    }
}

/// What a command reads besides its arguments, and where it writes.
pub(crate) struct Context<'a> {
    pub env: &'a BTreeMap<String, String>,
    pub cwd: &'a Path,
    pub stdin: &'a mut dyn Read,
    pub stdout: &'a mut dyn Write,
    pub stderr: &'a mut dyn Write,
}

impl Context<'_> {
    /// A variable of the environment `run` was given.
    pub fn var(&self, name: &str) -> Option<&str> {
        self.env.get(name).map(String::as_str)
    }

    /// `console.log`: the text and a newline on standard output. A write that fails (a closed
    /// pipe) is dropped, as Bun drops it.
    pub fn out(&mut self, text: &str) {
        let _ = writeln!(self.stdout, "{text}");
    }

    /// `console.error`: the text and a newline on standard error.
    pub fn err(&mut self, text: &str) {
        let _ = writeln!(self.stderr, "{text}");
    }
}

/// Runs `fleet` with `argv`, the arguments after the program's name (`process.argv.slice(2)`;
/// the fleet CLI contract's `argv`), the variables `env`, the working folder `cwd` and the
/// standard streams, and returns the exit status: 0 settled, 1 failed or error, 2 usage, 4
/// blocked on a question, 124 wait timed out.
pub fn run(
    argv: &[String],
    env: &BTreeMap<String, String>,
    cwd: &Path,
    stdin: &mut dyn Read,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let mut context = Context {
        env,
        cwd,
        stdin,
        stdout,
        stderr,
    };
    let code = match commands::main(argv, &mut context) {
        Ok(code) => code,
        Err(failure) => {
            // a wait that timed out has printed its run, or prints nothing
            if failure.exit != 124 {
                context.err(&format!("fleet: {}", failure.message));
            }
            failure.exit
        }
    };
    let _ = context.stdout.flush();
    let _ = context.stderr.flush();
    code
}
