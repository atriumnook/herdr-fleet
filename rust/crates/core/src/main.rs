//! The `herdr-fleet` executable of herdr-fleet-core; the crate's responsibility is in lib.rs.

use std::future::Future;
use std::io;
use std::process::ExitCode;
use std::time::Duration;

use herdr_fleet_core::start::{Settings, run};

#[tokio::main]
async fn main() -> ExitCode {
    match start().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("herdr-fleet: {error}");
            ExitCode::FAILURE
        }
    }
}

/// The core, set up from this process's environment, until ctrl-c or SIGTERM.
async fn start() -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|error| format!("cannot tell where this executable is: {error}"))?;
    let settings = Settings::from_env(|name| std::env::var_os(name), &exe)?;
    let signal = shutdown_signal()
        .map_err(|error| format!("cannot listen for the signals that stop it: {error}"))?;
    let shutdown = async move {
        signal.await;
        // server/index.ts:2090: the process ends 2 s after the first signal, though a request such
        // as a `fleet wait` is still open (the server stops taking new ones at once)
        tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(2)).await;
            std::process::exit(0);
        });
    };
    run(settings, shutdown).await
}

/// Resolves at the first ctrl-c or SIGTERM, the signals `server/index.ts:2092-2093` stops at. The
/// handlers are installed here, before anything starts: a signal that comes after this returns is
/// not lost, and installing them can fail.
#[cfg(unix)]
fn shutdown_signal() -> io::Result<impl Future<Output = ()> + Send + 'static> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    Ok(async move {
        tokio::select! {
            _ = interrupt.recv() => {}
            _ = terminate.recv() => {}
        }
    })
}

/// Resolves at the first ctrl-c (Windows has no SIGTERM).
#[cfg(not(unix))]
fn shutdown_signal() -> io::Result<impl Future<Output = ()> + Send + 'static> {
    Ok(async {
        let _ = tokio::signal::ctrl_c().await;
    })
}
