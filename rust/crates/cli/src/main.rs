//! The `fleet` executable: hands the process's arguments, environment, working folder and
//! standard streams to [`herdr_fleet_cli::run`] and exits with what it returns.
//!
//! Responsibility and dependencies: docs/rust-migration/adr/0107-crate-split.md.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let env: BTreeMap<String, String> = std::env::vars_os()
        .map(|(name, value)| {
            (
                name.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let code = herdr_fleet_cli::run(
        &argv,
        &env,
        &cwd,
        &mut std::io::stdin().lock(),
        &mut std::io::stdout().lock(),
        &mut std::io::stderr().lock(),
    );
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}
