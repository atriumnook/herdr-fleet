//! Builds the minimal core from the environment and runs it (#270).
//!
//! [`run`] is `createServer` of `server/index.ts` as far as the fleet goes: the orchestrator over
//! herdr, `/api/fleet` in front of it, the receiver of herdr's pane status, the pull request poll
//! and the first `reconcile_all`. Phase 4 adds the other routes, the token and the paired devices
//! (ADR 0242-phase-3-split, "Rust の core が thread を 1 つ起動して終える").

use std::collections::{BTreeMap, HashSet};
use std::ffi::OsString;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use herdr::Herdr;
use herdr::herdr_api::{AgentStatus, PaneInfo};
use herdr::pane_status::{PaneStatus, PaneStatusHandler, PaneStatusOptions, Replay};
use orchestrator::agents::{AgentDirs, discover_agents};
use orchestrator::api::{FleetApiDeps, router};
use orchestrator::config::{load_config, load_standing_orders};
use orchestrator::events::EventLog;
use orchestrator::fleet::{GitLanding, Orchestrator, OrchestratorDeps, Timings};
use orchestrator::herdr_runtime::HerdrRuntime;
use orchestrator::launch::Host;
use orchestrator::registry::RunRegistry;
use orchestrator::{Clock, SystemClock};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior};

use crate::app;

/// The port to listen on unless `PORT` says another: `DEFAULT_PORT` in `shared/protocol.ts:462`.
const DEFAULT_PORT: u16 = 7317;

/// How often the open pull requests are read again and the projects run without the person are
/// looked after: `PULL_REQUEST_POLL_MS` in `server/index.ts:144`.
const PULL_REQUEST_POLL: Duration = Duration::from_secs(60);

/// What the core is started with, read from its environment by [`Settings::from_env`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    /// the port to listen on, on `127.0.0.1` only
    pub port: u16,
    /// where the fleet keeps what it must remember: the runs, the event log, the result folders
    pub state_dir: PathBuf,
    /// the person's fleet config, roles and standing orders
    pub user_fleet_dir: PathBuf,
    /// herdr's socket
    pub herdr_socket: PathBuf,
    /// what an agent runs in its shell to reach the fleet: the `fleet` CLI, as one shell word
    pub fleet_command: String,
}

impl Settings {
    /// The settings `env` gives. `env` reads a variable (`|name| std::env::var_os(name)` in the
    /// binary; a test cannot set the process's environment under `forbid(unsafe_code)`), and `exe` is
    /// this executable. An empty value counts as unset, as `||` and `??` read it in the TypeScript;
    /// a missing `HOME` counts as empty, as in [`herdr::socket::socket_path`].
    ///
    /// It refuses `HERDR_FLEET_TOKEN`, a `PORT` that is not a port number, and an executable whose
    /// path is not UTF-8 (a command line is text).
    pub fn from_env(
        env: impl Fn(&str) -> Option<OsString>,
        exe: &Path,
    ) -> Result<Settings, String> {
        // The server's access check has a token mode (server/index.ts:356, :1100) that this core
        // lacks until phase 4. The TypeScript server with a token refuses this PC without it, so
        // running here without the check would let in what it refuses: not to run is the decision
        // of issue #270.
        if env("HERDR_FLEET_TOKEN").is_some_and(|token| !token.is_empty()) {
            return Err("HERDR_FLEET_TOKEN is set, but this core has no token check yet (phase 4): unset it to run it".to_owned());
        }
        let port = match env("PORT").filter(|port| !port.is_empty()) {
            // `Number(envPort)` of server/index.ts:1087 hands NaN to Bun.serve for a text that is no
            // number; here it is said before the core listens
            Some(port) => {
                let port = port.to_string_lossy();
                port.parse::<u16>()
                    .map_err(|_| format!("PORT must be a port number: {port}"))?
            }
            None => DEFAULT_PORT,
        };
        let home = env("HOME").unwrap_or_default();
        let user_fleet_dir = orchestrator::config::user_fleet_dir(
            env("XDG_CONFIG_HOME").as_deref(),
            Path::new(&home),
        );
        // server/state-dir.ts and server/fleet/config.ts:23-25 build the same default folder
        let state_dir = env("HERDR_FLEET_STATE_DIR")
            .filter(|dir| !dir.is_empty())
            .map_or_else(|| user_fleet_dir.clone(), PathBuf::from);
        // the cli crate's `fleet` is built into the folder this executable is in
        let fleet_exe = exe.with_file_name(format!("fleet{}", std::env::consts::EXE_SUFFIX));
        let fleet_exe = fleet_exe.to_str().ok_or_else(|| {
            format!(
                "the path of this executable is not valid UTF-8: {}",
                exe.display()
            )
        })?;
        Ok(Settings {
            port,
            state_dir,
            user_fleet_dir,
            herdr_socket: herdr::socket::socket_path(&env),
            fleet_command: shell_word(fleet_exe),
        })
    }
}

/// `text` as one word of a shell command line, as `FLEET_COMMAND` in `server/index.ts:173` writes
/// each part of it: as it is when it matches `^[\w./-]+$` (`\w` is ASCII only there), else in single
/// quotes with each `'` written `'\''`.
fn shell_word(text: &str) -> String {
    let plain = !text.is_empty()
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'/' | b'-'));
    if plain {
        text.to_owned()
    } else {
        format!("'{}'", text.replace('\'', r"'\''"))
    }
}

/// Runs the minimal core until `shutdown` resolves, in the order `createServer` sets things up
/// (`server/index.ts:354-560`, `:1047-1083`, `:2048-2062`).
///
/// The address is taken first, so that a port in use is reported before a file of the state folder
/// is touched. The moment `shutdown` resolves, the poll, the subscription to herdr and the
/// orchestrator's timers are stopped; the server then waits for the connections still open
/// ([`serve_stopping`]).
pub async fn run(
    settings: Settings,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<(), String> {
    let listener = app::listen(settings.port)
        .await
        .map_err(|error| format!("cannot listen on 127.0.0.1:{}: {error}", settings.port))?;
    run_on(listener, settings, shutdown).await
}

/// [`run`] from where its address is taken: on `listener`, whatever `settings.port` says. A test
/// binds a listener of its own, so that it knows the port and no other test can take it.
async fn run_on(
    listener: TcpListener,
    settings: Settings,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<(), String> {
    let Settings {
        state_dir,
        user_fleet_dir,
        herdr_socket,
        fleet_command,
        ..
    } = settings;
    // the port it got: `PORT=0` asks for any free one (`listeningPort`, server/index.ts:511, :2060)
    let port = listener
        .local_addr()
        .map_err(|error| format!("cannot read the address it listens on: {error}"))?
        .port();

    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let registry = Arc::new(RunRegistry::open(
        Some(state_dir.join("fleet-runs.json")),
        &*clock,
    ));
    // in an Arc: phase 4's factory report reads the log the orchestrator writes (`FactoryReporter`)
    let events = Arc::new(EventLog::new(
        state_dir.join("fleet-events.jsonl"),
        clock.clone(),
    ));
    let client = Herdr::new(herdr_socket);
    let agent_dirs = AgentDirs::new(&user_fleet_dir);
    let fleet = Orchestrator::new(OrchestratorDeps {
        runtime: Arc::new(HerdrRuntime::new(client.clone())),
        registry,
        clock,
        // the warnings are dropped: server/index.ts:533-535 calls `loadConfig(cwd)` with no list
        config: {
            let user_dir = user_fleet_dir.clone();
            Arc::new(move |cwd: &Path| load_config(cwd, &mut Vec::new(), &user_dir))
        },
        agents: Arc::new(move |cwd: &Path| discover_agents(cwd, &mut Vec::new(), &agent_dirs)),
        standing_orders: Some(Arc::new(move |cwd: &Path| {
            load_standing_orders(cwd, &user_fleet_dir)
        })),
        landing: Arc::new(GitLanding::new()),
        fleet_command,
        // server/index.ts:540, without `HERDR_FLEET_TOKEN`: `Settings::from_env` refused a token
        agent_env: Arc::new(move || {
            BTreeMap::from([(
                "HERDR_FLEET_URL".to_owned(),
                format!("http://127.0.0.1:{port}"),
            )])
        }),
        host: Host::from_process(),
        results_dir: state_dir.join("fleet-results"),
        plans_dir: Some(state_dir.join("fleet-plans")),
        instructions_dir: state_dir.join("fleet-instructions"),
        prompt_dir: None,
        timings: Timings::default(),
        // phase 4: the usage tracker and the model catalog
        usage: None,
        models: None,
        on_changed: None,
        events: Some(Arc::new(move |event| events.record(event))),
    })
    .map_err(|error| format!("cannot start the fleet: {error}"))?;

    // Phase 4 gives the parts that are `None` here (usage, settings, entrances, models, the factory
    // report) with the routes that read them: a route whose part is `None` answers 404, as in
    // TypeScript when the argument is absent.
    let api = router(FleetApiDeps {
        fleet: fleet.clone(),
        usage: None,
        settings: None,
        entrances: None,
        models: None,
        report: None,
    });

    let pane_status = herdr::pane_status::start(
        Arc::new(client),
        Arc::new(PaneStatusReceiver {
            fleet: fleet.clone(),
        }),
        PaneStatusOptions::default(),
    );
    // the open pull requests, then the projects run without the person (server/index.ts:2048-2058)
    let polling = poll_every(PULL_REQUEST_POLL, {
        let fleet = fleet.clone();
        move || {
            let (refresh, supervise) = (fleet.clone(), fleet.clone());
            in_order(
                async move { refresh.refresh_pull_requests().await },
                async move { supervise.supervise_projects().await },
            )
        }
    });
    // runs from before a restart: read back from herdr, so the finished ones are not counted as
    // working (server/index.ts:2061-2062)
    reconcile_all_in_background(&fleet);

    let background = Background {
        polling,
        pane_status,
        fleet,
    };
    serve_stopping(background, listener, app::routes(api), shutdown)
        .await
        .map_err(|error| format!("cannot serve on 127.0.0.1:{port}: {error}"))
}

/// What [`run_on`] starts beside the server and stops together, as `stop` of `createServer` does
/// (`server/index.ts:2067-2077`).
struct Background {
    /// the pull request poll
    polling: JoinHandle<()>,
    /// the subscription to herdr's pane status
    pane_status: PaneStatus,
    /// the orchestrator: its timers, and the settlements and starts it would begin
    fleet: Orchestrator,
}

impl Background {
    /// Stops the poll, the subscription and the fleet, in the order of the TypeScript `stop`.
    /// Calling it again does nothing.
    fn stop(&self) {
        self.polling.abort();
        self.pane_status.stop();
        self.fleet.stop();
    }
}

/// [`app::serve`] of `routes` on `listener` until `shutdown` resolves, with `background` stopped the
/// moment it has: in the future handed to `serve`, which runs before `serve` waits for the
/// connections still open. A `fleet wait` can be open for minutes and `main.rs` ends the process 2 s
/// after the signal, so stopping after `serve` returned would leave the orchestrator settling turns
/// and starting panes for those 2 s, and then cut it off in the middle of one. The TypeScript `stop`
/// stops the work before it calls `server.stop(true)` (`server/index.ts:2067-2077`).
async fn serve_stopping(
    background: Background,
    listener: TcpListener,
    routes: Router,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    let background = Arc::new(background);
    let served = app::serve(listener, routes, {
        let background = Arc::clone(&background);
        async move {
            shutdown.await;
            background.stop();
        }
    })
    .await;
    // `serve` ends once `shutdown` has resolved; if it ended otherwise, the work stops here
    background.stop();
    served
}

/// `first`, then `second`, each in a task of its own: a panic of either ends that task, and the
/// round goes on. The `.catch(() => undefined)` after each of the two calls of a poll round in
/// `server/index.ts:2054-2055` does the same, so the second runs whatever the first did.
async fn in_order(
    first: impl Future<Output = ()> + Send + 'static,
    second: impl Future<Output = ()> + Send + 'static,
) {
    let _ = tokio::spawn(first).await;
    let _ = tokio::spawn(second).await;
}

/// Calls `round` every `period` as JavaScript's `setInterval` does, with the guard of
/// `pullRequestsPolling` in `server/index.ts:2050-2057`: the first call is one `period` from now,
/// never two rounds run at once, and a tick that comes while one runs is dropped, not made up. A
/// round that panics ends that round only, as the `.catch(() => undefined)` there does. Abort the
/// returned task to stop; a round already running goes on to its end, as after `clearInterval`.
///
/// Not tokio's `interval` with the round awaited in the loop: that hands over a late tick as soon
/// as the round ends, where the next tick is the first one after it.
fn poll_every<Round, Work>(period: Duration, round: Round) -> JoinHandle<()>
where
    Round: Fn() -> Work + Send + 'static,
    Work: Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async move {
        let mut ticks = tokio::time::interval_at(Instant::now() + period, period);
        // the loop waits for no round, so a tick is late only when the runtime was stalled; a timer
        // that fired late fires once, and is not made up
        ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let busy = Arc::new(tokio::sync::Mutex::new(()));
        loop {
            ticks.tick().await;
            // held by the round, and let go when it ends or panics
            let Ok(held) = Arc::clone(&busy).try_lock_owned() else {
                continue;
            };
            let work = round();
            tokio::spawn(async move {
                let _held = held;
                work.await;
            });
        }
    })
}

/// `void fleet.reconcileAll()`: every live run read back from herdr, in a task of its own, since
/// the caller must not wait for herdr.
fn reconcile_all_in_background(fleet: &Orchestrator) {
    let fleet = fleet.clone();
    tokio::spawn(async move { fleet.reconcile_all().await });
}

/// What the fleet does with the status of the panes herdr reports: the handlers of the collector
/// in `server/index.ts:1047-1083` that reach the orchestrator. What they also do there for the
/// browsers and web push (the completion tracker, `broadcastAll`, `push`) is phase 4's, so
/// `on_baseline`, `on_structure_change` and `on_focus` do nothing here.
///
/// The collector calls these on a task of its own, one at a time, so none of them may wait for
/// herdr: `on_resync` hands the read-back to a task.
struct PaneStatusReceiver {
    fleet: Orchestrator,
}

impl PaneStatusHandler for PaneStatusReceiver {
    // server/index.ts:1050 wakes the orchestrator before it looks at `replay`: a status read back
    // from a snapshot counts too
    fn on_status(
        &self,
        pane: &str,
        _status: AgentStatus,
        _agent: Option<&str>,
        _replay: Option<Replay>,
    ) {
        self.fleet.on_pane_status(pane);
    }

    fn on_baseline(&self, _panes: &[PaneInfo]) {}

    // server/index.ts:1072
    fn on_resync(&self, _panes: &[PaneInfo], _newer: &HashSet<String>) {
        reconcile_all_in_background(&self.fleet);
    }

    // server/index.ts:1077
    fn on_pane_ended(&self, pane: &str) {
        self.fleet.on_pane_ended(pane);
    }

    fn on_structure_change(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::post;
    use herdr::herdr_api::Subscription;
    use herdr::{EventSender, EventSource, EventStream, SnapshotFuture};
    use orchestrator::config::FleetConfig;
    use orchestrator::runtime::{
        AgentMetadata, AgentRuntime, CreateLocationOptions, RuntimeFuture, RuntimeLocation,
        StartOptions,
    };
    use protocol::AgentState;
    use std::io::{Read, Write};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::sync::Notify;
    use tokio_util::sync::CancellationToken;

    const EXE: &str = "/opt/x/herdr-fleet";

    /// An `env` that holds these variables and no others: the process's own environment is neither
    /// read nor changed (it cannot be changed under `forbid(unsafe_code)`).
    fn env<'a>(vars: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<OsString> + 'a {
        move |name| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| OsString::from(value))
        }
    }

    fn settings(vars: &[(&str, &str)]) -> Settings {
        Settings::from_env(env(vars), Path::new(EXE)).expect("the environment gives settings")
    }

    fn fleet_command(exe: &str) -> String {
        Settings::from_env(env(&[]), Path::new(exe))
            .expect("the environment gives settings")
            .fleet_command
    }

    // server/index.ts:356 reads HERDR_FLEET_TOKEN as the token of the server's access check (:1100,
    // :1103). With one set, `decideAccess` refuses this PC without it (server/access.ts:110, before
    // the rule for this PC at :117), and this core has no token check yet (phase 4): the issue's
    // security decision is to refuse to run rather than let in what the TypeScript server refuses.
    #[test]
    fn refuses_a_token_it_cannot_check() {
        assert_eq!(
            Settings::from_env(env(&[("HERDR_FLEET_TOKEN", "not-a-real-token")]), Path::new(EXE)),
            Err("HERDR_FLEET_TOKEN is set, but this core has no token check yet (phase 4): unset it to run it"
                .to_owned())
        );
    }

    // server/index.ts:355: "Empty token = gate disabled"
    #[test]
    fn an_empty_token_is_no_token() {
        assert!(Settings::from_env(env(&[("HERDR_FLEET_TOKEN", "")]), Path::new(EXE)).is_ok());
    }

    // shared/protocol.ts:462 `DEFAULT_PORT = 7317`; server/index.ts:1087 `envPort ? … : DEFAULT_PORT`
    // reads an empty PORT as unset
    #[test]
    fn port_defaults_to_7317() {
        assert_eq!(settings(&[]).port, 7317);
        assert_eq!(settings(&[("PORT", "")]).port, 7317);
    }

    // server/index.ts:1087: `Number(envPort)`, and a port of 0 asks Bun.serve for any free port
    #[test]
    fn port_is_read_from_port() {
        assert_eq!(settings(&[("PORT", "7401")]).port, 7401);
        assert_eq!(settings(&[("PORT", "0")]).port, 0);
    }

    // server/index.ts:1087 passes `Number("abc")`, NaN, to Bun.serve; the issue's rule is to say so
    // before listening. 65535 is the highest port; the others are not numbers of a port.
    #[test]
    fn refuses_a_value_that_is_not_a_port_number() {
        for value in ["abc", "70000", "-1"] {
            assert_eq!(
                Settings::from_env(env(&[("PORT", value)]), Path::new(EXE)),
                Err(format!("PORT must be a port number: {value}")),
                "{value}"
            );
        }
        assert_eq!(settings(&[("PORT", "65535")]).port, 65535);
    }

    // server/state-dir.ts:6-7: HERDR_FLEET_STATE_DIR is returned as it is
    #[test]
    fn state_dir_is_the_one_given() {
        let given = settings(&[
            ("HERDR_FLEET_STATE_DIR", "/var/state/../fleet"),
            ("XDG_CONFIG_HOME", "/xdg"),
            ("HOME", "/home/x"),
        ]);
        assert_eq!(given.state_dir.as_os_str(), "/var/state/../fleet");
    }

    // server/state-dir.ts:8: `join(XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr-fleet")`,
    // and `||` reads an empty value as unset
    #[test]
    fn state_dir_defaults_to_herdr_fleet_in_the_config_home() {
        let xdg = settings(&[("XDG_CONFIG_HOME", "/xdg"), ("HOME", "/home/x")]);
        assert_eq!(xdg.state_dir, Path::new("/xdg/herdr-fleet"));
        let home = settings(&[("HOME", "/home/x")]);
        assert_eq!(home.state_dir, Path::new("/home/x/.config/herdr-fleet"));
        let empty = settings(&[
            ("HERDR_FLEET_STATE_DIR", ""),
            ("XDG_CONFIG_HOME", ""),
            ("HOME", "/home/x"),
        ]);
        assert_eq!(empty.state_dir, Path::new("/home/x/.config/herdr-fleet"));
    }

    // server/fleet/config.ts:23-25 `userFleetDir()`: the same folder as the default state folder, and
    // HERDR_FLEET_STATE_DIR does not move it (the issue: fleet.json, roles and standing orders are
    // found from XDG_CONFIG_HOME, not from the state folder)
    #[test]
    fn user_fleet_dir_follows_the_config_home_not_the_state_dir() {
        let xdg = settings(&[("XDG_CONFIG_HOME", "/xdg"), ("HOME", "/home/x")]);
        assert_eq!(xdg.user_fleet_dir, Path::new("/xdg/herdr-fleet"));
        let home = settings(&[("HOME", "/home/x")]);
        assert_eq!(
            home.user_fleet_dir,
            Path::new("/home/x/.config/herdr-fleet")
        );
        let moved = settings(&[
            ("HERDR_FLEET_STATE_DIR", "/var/state"),
            ("XDG_CONFIG_HOME", "/xdg"),
            ("HOME", "/home/x"),
        ]);
        assert_eq!(moved.state_dir, Path::new("/var/state"));
        assert_eq!(moved.user_fleet_dir, Path::new("/xdg/herdr-fleet"));
    }

    // server/herdr/client.ts `herdrSocketPath`: HERDR_SOCKET, else under HOME
    #[test]
    fn herdr_socket_is_herdr_socket() {
        let given = settings(&[
            ("HERDR_SOCKET", "/run/user/1000/herdr.sock"),
            ("HOME", "/home/x"),
        ]);
        assert_eq!(given.herdr_socket, Path::new("/run/user/1000/herdr.sock"));
        #[cfg(unix)]
        {
            let home = settings(&[("HOME", "/home/x")]);
            assert_eq!(
                home.herdr_socket,
                Path::new("/home/x/.config/herdr/herdr.sock")
            );
        }
    }

    // server/index.ts:173 FLEET_COMMAND: the `fleet` beside this executable, written as one shell
    // word that is left as it is when it matches /^[\w./-]+$/
    #[test]
    fn fleet_command_is_the_fleet_beside_this_executable() {
        assert_eq!(fleet_command("/opt/x/herdr-fleet"), "/opt/x/fleet");
        // every character the expression allows: letters of both cases, digits, `_`, `.`, `-`
        assert_eq!(
            fleet_command("/opt/X_1-2.3/herdr-fleet"),
            "/opt/X_1-2.3/fleet"
        );
    }

    // server/index.ts:173: any other path is single-quoted with each `'` written as `'\''`
    #[test]
    fn fleet_command_quotes_a_path_a_shell_would_split_or_expand() {
        assert_eq!(
            fleet_command("/tmp/it's here/herdr-fleet"),
            r"'/tmp/it'\''s here/fleet'"
        );
        assert_eq!(
            fleet_command("/opt/my tools/herdr-fleet"),
            "'/opt/my tools/fleet'"
        );
        assert_eq!(
            fleet_command("/tmp/$HOME/herdr-fleet"),
            "'/tmp/$HOME/fleet'"
        );
    }

    // server/index.ts:173: `\w` of a regular expression without the `u` flag is ASCII only
    #[test]
    fn fleet_command_quotes_a_path_with_letters_outside_ascii() {
        assert_eq!(
            fleet_command("/home/名前/herdr-fleet"),
            "'/home/名前/fleet'"
        );
    }

    // a command line is text: a path that is not UTF-8 cannot be written into one without changing it
    #[cfg(unix)]
    #[test]
    fn refuses_an_executable_path_that_is_not_utf8() {
        use std::os::unix::ffi::OsStringExt;
        let exe = PathBuf::from(OsString::from_vec(b"/opt/\xff/herdr-fleet".to_vec()));
        assert_eq!(
            Settings::from_env(env(&[]), &exe),
            Err(
                "the path of this executable is not valid UTF-8: /opt/\u{fffd}/herdr-fleet"
                    .to_owned()
            )
        );
    }

    // the live test, and anything that starts the core in a task, spawn `run`: a future that is not
    // `Send` fails to compile here instead
    #[test]
    fn run_is_a_send_future() {
        fn is_send(_: &impl Send) {}
        is_send(&run(settings(&[]), std::future::ready(())));
    }

    /// A listener on a free port of 7400-7499 (the standing orders' range), held until it is passed
    /// on, so that no other test takes the port in between.
    async fn free_listener() -> TcpListener {
        for port in 7400..7500 {
            if let Ok(listener) = app::listen(port).await {
                return listener;
            }
        }
        panic!("no free port in 7400-7499");
    }

    /// The status and the body of `GET path`, asked of 127.0.0.1:`port` over a new connection.
    async fn get(port: u16, path: &'static str) -> (u16, String) {
        tokio::task::spawn_blocking(move || {
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            let request = format!(
                "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(request.as_bytes()).unwrap();
            let mut answer = String::new();
            stream.read_to_string(&mut answer).unwrap();
            let (head, body) = answer.split_once("\r\n\r\n").unwrap_or((&answer, ""));
            (head[9..12].parse().unwrap(), body.to_owned())
        })
        .await
        .unwrap()
    }

    // The core as a whole, up to herdr (nothing listens at the socket it is given): it answers
    // `/api/fleet` from the orchestrator behind the access control, and stops when told to.
    // `GET /runs` is `server/fleet/api.ts`'s `{ runs }`, with no run yet.
    #[tokio::test]
    async fn serves_the_fleet_api_until_told_to_stop() {
        let folder =
            std::env::temp_dir().join(format!("herdr-fleet-core-start-{}", std::process::id()));
        let listener = free_listener().await;
        let port = listener.local_addr().unwrap().port();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let core = tokio::spawn(run_on(
            listener,
            Settings {
                port,
                state_dir: folder.join("state"),
                user_fleet_dir: folder.join("config"),
                herdr_socket: folder.join("no-herdr.sock"),
                fleet_command: "fleet".to_owned(),
            },
            async {
                let _ = stopped.await;
            },
        ));

        let answer = get(port, "/api/fleet/runs").await;
        assert_eq!(answer, (200, r#"{"runs":[]}"#.to_owned()));

        stop.send(()).unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(10), core)
            .await
            .expect("it stops within ten seconds")
            .expect("it does not panic");
        assert_eq!(ended, Ok(()));
        let _ = std::fs::remove_dir_all(&folder);
    }

    /// Records the instant each round starts, and how many ran at once.
    #[derive(Default)]
    struct Rounds {
        started: Mutex<Vec<Instant>>,
        running: AtomicUsize,
        most_at_once: AtomicUsize,
    }

    // server/index.ts:2051-2057 `setInterval(…, PULL_REQUEST_POLL_MS)`: the first call comes one
    // period after the interval is set, not at once. A timer never fires early, so the time since
    // the start is a bound that holds however busy the machine is.
    #[tokio::test]
    async fn polls_first_one_period_after_the_start() {
        let period = Duration::from_millis(150);
        let rounds = Arc::new(Rounds::default());
        let start = Instant::now();
        let poller = poll_every(period, {
            let rounds = rounds.clone();
            move || {
                let rounds = rounds.clone();
                async move { rounds.started.lock().unwrap().push(Instant::now()) }
            }
        });
        eventually("the first round", || {
            !rounds.started.lock().unwrap().is_empty()
        })
        .await;
        poller.abort();
        let started = rounds.started.lock().unwrap().clone();
        assert!(
            started[0] - start >= period,
            "the first round came before one period"
        );
    }

    // server/index.ts:2050-2057 `pullRequestsPolling`: a tick that comes while a round runs does
    // nothing, and the next tick is the one after the round ended, not a catch-up. With a period of
    // 100 ms and a round of 250 ms, ticks 2 and 3 fall in the first round, so the second round
    // cannot start before tick 4, 400 ms after the start; one that ran at the end of the first
    // round would start at about 350 ms.
    #[tokio::test]
    async fn skips_the_ticks_that_come_while_a_round_runs() {
        let period = Duration::from_millis(100);
        let rounds = Arc::new(Rounds::default());
        let start = Instant::now();
        let poller = poll_every(period, {
            let rounds = rounds.clone();
            move || {
                let rounds = rounds.clone();
                async move {
                    rounds.started.lock().unwrap().push(Instant::now());
                    let now = rounds.running.fetch_add(1, Ordering::SeqCst) + 1;
                    rounds.most_at_once.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    rounds.running.fetch_sub(1, Ordering::SeqCst);
                }
            }
        });
        eventually("the second round", || {
            rounds.started.lock().unwrap().len() >= 2
        })
        .await;
        poller.abort();
        let started = rounds.started.lock().unwrap().clone();
        assert!(
            started[1] - start >= period * 4,
            "the second round came at {:?}",
            started[1] - start
        );
        assert_eq!(rounds.most_at_once.load(Ordering::SeqCst), 1);
    }

    // server/index.ts:2054-2055 `.catch(() => undefined)`: a round that fails does not end the polling
    #[tokio::test]
    async fn goes_on_polling_after_a_round_panics() {
        let ran = Arc::new(AtomicUsize::new(0));
        let poller = poll_every(Duration::from_millis(30), {
            let ran = ran.clone();
            move || {
                let ran = ran.clone();
                async move {
                    assert!(
                        ran.fetch_add(1, Ordering::SeqCst) != 0,
                        "the first round fails"
                    );
                }
            }
        });
        eventually("a round after the one that failed", || {
            ran.load(Ordering::SeqCst) >= 2
        })
        .await;
        poller.abort();
    }

    /// A future that writes `what` into `log` when it runs.
    fn note(
        log: &Arc<Mutex<Vec<&'static str>>>,
        what: &'static str,
    ) -> impl Future<Output = ()> + Send + 'static {
        let log = log.clone();
        async move { log.lock().unwrap().push(what) }
    }

    // server/index.ts:2054-2055: one call after the other, as `.then(() => fleet.superviseProjects())`
    // starts the second when the first has ended, not beside it
    #[tokio::test]
    async fn runs_the_second_call_when_the_first_has_ended() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let first = {
            let log = log.clone();
            async move {
                log.lock().unwrap().push("first starts");
                tokio::time::sleep(Duration::from_millis(30)).await;
                log.lock().unwrap().push("first ends");
            }
        };
        in_order(first, note(&log, "second")).await;
        assert_eq!(
            *log.lock().unwrap(),
            ["first starts", "first ends", "second"]
        );
    }

    // server/index.ts:2054-2055: each call has a `.catch(() => undefined)` after it, so
    // `superviseProjects()` runs whatever `refreshPullRequests()` did, and a call that fails ends the
    // round, not the process
    #[tokio::test]
    async fn runs_the_second_call_whatever_became_of_the_first() {
        let ran = Arc::new(AtomicBool::new(false));
        let second = {
            let ran = ran.clone();
            async move { ran.store(true, Ordering::SeqCst) }
        };
        in_order(async { panic!("the first call fails") }, second).await;
        assert!(
            ran.load(Ordering::SeqCst),
            "the second call did not run after the first one panicked"
        );

        // a second call that fails ends the round: the caller does not see the panic
        in_order(async {}, async { panic!("the second call fails") }).await;
    }

    /// Waits, up to ten seconds, until `condition` holds.
    async fn eventually(what: &str, condition: impl Fn() -> bool) {
        let waited = tokio::time::timeout(Duration::from_secs(10), async {
            while !condition() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(waited.is_ok(), "timed out waiting for {what}");
    }

    /// herdr as far as the receiver's tests ask of it: `get` writes down whom it was asked about and
    /// says the agent is still starting, a state in which the orchestrator asks herdr nothing more.
    #[derive(Default)]
    struct AskedRuntime {
        asked: Mutex<Vec<String>>,
    }

    impl AskedRuntime {
        fn asked(&self, name: &str) -> bool {
            self.asked.lock().unwrap().iter().any(|asked| asked == name)
        }

        /// How many times herdr was asked about any agent.
        fn times_asked(&self) -> usize {
            self.asked.lock().unwrap().len()
        }
    }

    impl AgentRuntime for AskedRuntime {
        fn get<'a>(&'a self, name: &'a str) -> RuntimeFuture<'a, AgentState> {
            self.asked.lock().unwrap().push(name.to_owned());
            Box::pin(async { Ok(AgentState::Starting) })
        }
        fn create_location<'a>(
            &'a self,
            _: CreateLocationOptions,
            _: &'a CancellationToken,
        ) -> RuntimeFuture<'a, RuntimeLocation> {
            unreachable!("the receiver's tests ask herdr only for `get`")
        }
        fn start(&self, _: StartOptions) -> RuntimeFuture<'_, AgentState> {
            unreachable!("the receiver's tests ask herdr only for `get`")
        }
        fn close_pane<'a>(&'a self, _: &'a str) -> RuntimeFuture<'a, ()> {
            unreachable!("the receiver's tests ask herdr only for `get`")
        }
        fn prompt<'a>(
            &'a self,
            _: &'a str,
            _: &'a str,
            _: &'a CancellationToken,
        ) -> RuntimeFuture<'a, AgentState> {
            unreachable!("the receiver's tests ask herdr only for `get`")
        }
        fn read<'a>(&'a self, _: &'a str, _: u32) -> RuntimeFuture<'a, String> {
            unreachable!("the receiver's tests ask herdr only for `get`")
        }
        fn screen<'a>(&'a self, _: &'a str) -> RuntimeFuture<'a, String> {
            unreachable!("the receiver's tests ask herdr only for `get`")
        }
        fn interrupt<'a>(&'a self, _: &'a str) -> RuntimeFuture<'a, ()> {
            unreachable!("the receiver's tests ask herdr only for `get`")
        }
        fn focus<'a>(&'a self, _: &'a str) -> RuntimeFuture<'a, ()> {
            unreachable!("the receiver's tests ask herdr only for `get`")
        }
        fn report_metadata(&self, _: AgentMetadata) -> RuntimeFuture<'_, ()> {
            unreachable!("the receiver's tests ask herdr only for `get`")
        }
    }

    /// An orchestrator over `runtime` that knows two runs, `r1` in pane `w1:p1` and `r2` in `w1:p2`,
    /// and keeps its records in memory only.
    fn fleet_over(runtime: Arc<AskedRuntime>) -> Orchestrator {
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let registry = RunRegistry::open(None, &*clock);
        for (id, pane) in [("r1", "w1:p1"), ("r2", "w1:p2")] {
            let run = serde_json::from_value(serde_json::json!({
                "id": id, "name": id, "role": "worker", "agent": "claude", "group": "g",
                "herdrName": format!("{id}-name"), "paneId": pane, "cwd": "/nonexistent",
                "state": "starting", "depth": 0, "interactive": true, "worktree": false,
                "startedAt": clock.now_ms(), "updatedAt": clock.now_ms(),
            }))
            .expect("a run");
            registry.insert(run).expect("a registry with no file");
        }
        Orchestrator::new(OrchestratorDeps {
            runtime,
            registry: Arc::new(registry),
            clock,
            config: Arc::new(|_: &Path| FleetConfig::default()),
            agents: Arc::new(|_: &Path| Vec::new()),
            standing_orders: None,
            landing: Arc::new(GitLanding::new()),
            fleet_command: "fleet".to_owned(),
            agent_env: Arc::new(BTreeMap::new),
            host: Host::new(BTreeMap::new(), PathBuf::from("/nonexistent")),
            results_dir: PathBuf::from("/nonexistent/fleet-results"),
            plans_dir: None,
            instructions_dir: PathBuf::from("/nonexistent/fleet-instructions"),
            prompt_dir: None,
            timings: Timings::default(),
            usage: None,
            models: None,
            on_changed: None,
            events: None,
        })
        .expect("an orchestrator")
    }

    // ADR 0242-phase-3-split / issue #270: `on_status` → `on_pane_status`, `on_resync` →
    // `reconcile_all`, `on_pane_ended` → `on_pane_ended` (server/index.ts:1049-1050, :1071-1072,
    // :1076-1077)
    #[tokio::test]
    async fn tells_the_orchestrator_what_herdr_reports() {
        let runtime = Arc::new(AskedRuntime::default());
        let fleet = fleet_over(runtime.clone());
        let receiver = PaneStatusReceiver {
            fleet: fleet.clone(),
        };

        // a status wakes the orchestrator for that pane's run, a replayed one too: index.ts:1050
        // comes before the check of the replay
        let replay = Some(Replay {
            before: AgentStatus::Idle,
            agent: None,
        });
        receiver.on_status("w1:p1", AgentStatus::Working, Some("claude"), replay);
        eventually("the run of the pane to be read back", || {
            runtime.asked("r1-name")
        })
        .await;
        assert!(
            !runtime.asked("r2-name"),
            "the other pane's run was read back too"
        );

        // events were lost: every live run is read back, the other pane's too
        receiver.on_resync(&[], &HashSet::new());
        eventually("every run to be read back", || runtime.asked("r2-name")).await;

        // a pane that ended ends its run
        receiver.on_pane_ended("w1:p2");
        assert_eq!(
            fleet.get("r2", None).expect("r2").state,
            AgentState::Stopped
        );
    }

    /// Sets its flag when it is dropped.
    struct DropFlag(Arc<AtomicBool>);

    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    /// herdr's events as far as the subscription to the pane status asks of them: it keeps the
    /// sending end of each subscription it hands out, so that a test sees whether the collector
    /// dropped them, and its snapshot never answers.
    #[derive(Default)]
    struct QuietHerdr {
        subscriptions: Mutex<Vec<EventSender>>,
    }

    impl QuietHerdr {
        fn opened(&self) -> usize {
            self.subscriptions.lock().unwrap().len()
        }

        /// Every subscription it handed out was dropped, and there was one.
        fn all_dropped(&self) -> bool {
            let subscriptions = self.subscriptions.lock().unwrap();
            !subscriptions.is_empty() && subscriptions.iter().all(EventSender::is_closed)
        }
    }

    impl EventSource for QuietHerdr {
        fn subscribe(&self, _: Vec<Subscription>) -> EventStream {
            let (sender, stream) = EventStream::channel();
            self.subscriptions.lock().unwrap().push(sender);
            stream
        }

        fn snapshot(&self) -> SnapshotFuture {
            Box::pin(std::future::pending())
        }
    }

    /// The head of a `POST /hold` with a body of 6 bytes, and the first 3 of them, on a connection
    /// that stays open: the server holds the request in its handler until the rest comes.
    fn send_all_but_the_end(port: u16) -> std::net::TcpStream {
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let request = format!(
            "POST /hold HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: 6\r\n\r\nabc"
        );
        stream.write_all(request.as_bytes()).unwrap();
        stream
    }

    /// The last 3 bytes of the body of [`send_all_but_the_end`]'s request, and the answer: its
    /// status and its body.
    async fn send_the_end(mut stream: std::net::TcpStream) -> (u16, String) {
        tokio::task::spawn_blocking(move || {
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            stream.write_all(b"def").unwrap();
            let mut answer = String::new();
            stream.read_to_string(&mut answer).unwrap();
            let (head, body) = answer.split_once("\r\n\r\n").unwrap_or((&answer, ""));
            (head[9..12].parse().unwrap(), body.to_owned())
        })
        .await
        .unwrap()
    }

    // server/index.ts:2067-2077: `stop` clears the pull request timer and stops the collector and
    // the fleet first, and only then calls `server.stop(true)`. Axum's graceful shutdown waits for
    // the connections still open, and a `fleet wait` can be open for minutes (main.rs ends the
    // process 2 s after the signal): the work stops at the signal, not when the server returns.
    // The request that holds the server open is in its handler when the signal comes, and it is
    // answered after the work stopped.
    #[tokio::test]
    async fn stops_the_work_at_the_signal_not_after_the_open_connections() {
        let listener = free_listener().await;
        let port = listener.local_addr().unwrap().port();
        let reached = Arc::new(Notify::new());
        let routes = Router::new().route(
            "/hold",
            post({
                let reached = reached.clone();
                move |request: axum::extract::Request| {
                    let reached = reached.clone();
                    async move {
                        reached.notify_one();
                        // the whole body: it waits for the end of it
                        match axum::body::to_bytes(request.into_body(), usize::MAX).await {
                            Ok(body) => body.len().to_string(),
                            Err(error) => format!("cut: {error}"),
                        }
                    }
                }
            }),
        );

        // each part of the work, with something a test sees of it
        let runtime = Arc::new(AskedRuntime::default());
        let fleet = fleet_over(runtime.clone());
        let poll_dropped = Arc::new(AtomicBool::new(false));
        let polling = poll_every(PULL_REQUEST_POLL, {
            let guard = DropFlag(poll_dropped.clone());
            move || {
                let _guard = &guard;
                async {}
            }
        });
        let source = Arc::new(QuietHerdr::default());
        let pane_status = herdr::pane_status::start(
            source.clone(),
            Arc::new(PaneStatusReceiver {
                fleet: fleet.clone(),
            }),
            PaneStatusOptions::default(),
        );
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let served = tokio::spawn(serve_stopping(
            Background {
                polling,
                pane_status,
                fleet: fleet.clone(),
            },
            listener,
            routes,
            async {
                let _ = stopped.await;
            },
        ));

        let held = send_all_but_the_end(port);
        tokio::time::timeout(Duration::from_secs(10), reached.notified())
            .await
            .expect("the request reaches its handler");
        // what the signal changes: before it, the subscriptions are open, the poll is running, and
        // the fleet reads its runs back from herdr
        eventually("the subscriptions to herdr", || source.opened() > 0).await;
        assert!(!source.all_dropped(), "a subscription was dropped early");
        assert!(!poll_dropped.load(Ordering::SeqCst), "the poll ended early");
        fleet.reconcile_all().await;
        assert!(
            runtime.asked("r1-name") && runtime.asked("r2-name"),
            "the fleet did not read its runs back"
        );

        stop.send(()).unwrap();
        // the request is still open
        eventually("the subscriptions to herdr to be dropped", || {
            source.all_dropped()
        })
        .await;
        eventually("the poll to end", || poll_dropped.load(Ordering::SeqCst)).await;
        // a stopped fleet starts no settlement: a read-back of every run asks herdr nothing
        let stopped_reading = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let before = runtime.times_asked();
                fleet.reconcile_all().await;
                if runtime.times_asked() == before {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(
            stopped_reading.is_ok(),
            "timed out waiting for the fleet to stop reading its runs back"
        );

        // the server still waited for the request, and it answers it
        assert!(
            !served.is_finished(),
            "the server ended before the open request did"
        );
        assert_eq!(send_the_end(held).await, (200, "6".to_owned()));
        let ended = tokio::time::timeout(Duration::from_secs(10), served)
            .await
            .expect("the server ends once the request is answered")
            .expect("it does not panic");
        assert!(ended.is_ok());
    }
}
