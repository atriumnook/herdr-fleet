//! A fake herdr: a Unix socket in a fresh temporary folder that reads one NDJSON request per
//! connection, records it, and answers as the test scripts it (whole lines, a line split across
//! writes, nothing, or a close before any answer).
//!
//! It depends on std, tokio (`net`, `io-util`, `rt`, `sync`, `time`) and serde_json only and
//! names nothing outside itself, so that a test of another crate includes it as it is:
//! `#[cfg(unix)] #[path = "../../herdr/tests/common/fake_herdr.rs"] mod fake_herdr;` (the
//! orchestrator's `HerdrRuntime` tests, ADR 0252-herdr-client). On Windows herdr listens on a
//! named pipe, which phase 6 checks.

#![cfg(unix)]
#![allow(dead_code)]

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::task::JoinHandle;

/// One step of an answer.
#[derive(Debug, Clone)]
pub enum Step {
    /// Write these bytes as they are (a line split across two steps arrives in two reads).
    Write(Vec<u8>),
    /// Wait before the next step.
    Wait(Duration),
}

/// How the fake answers one request.
#[derive(Debug, Clone)]
pub struct Reply {
    pub steps: Vec<Step>,
    /// Close the connection after the steps; otherwise keep it open until the client closes it
    /// or the fake is dropped.
    pub close: bool,
}

impl Reply {
    /// One line (a newline is added), then the close herdr does after a response.
    pub fn line(value: Value) -> Self {
        Self {
            steps: vec![Step::Write(format!("{value}\n").into_bytes())],
            close: true,
        }
    }

    /// `{"id": <the request's id>, "result": result}`, as herdr answers.
    pub fn result(request: &Value, result: Value) -> Self {
        Self::line(serde_json::json!({ "id": request["id"], "result": result }))
    }

    /// `{"id": …, "error": {"code": code, "message": message}}`.
    pub fn error(request: &Value, code: &str, message: &str) -> Self {
        Self::line(serde_json::json!({
            "id": request["id"],
            "error": { "code": code, "message": message },
        }))
    }

    /// These raw bytes, then the close.
    pub fn raw(bytes: &[u8]) -> Self {
        Self {
            steps: vec![Step::Write(bytes.to_vec())],
            close: true,
        }
    }

    /// Never answer; keep the connection open.
    pub fn silent() -> Self {
        Self {
            steps: Vec::new(),
            close: false,
        }
    }

    /// Close at once, without an answer.
    pub fn close() -> Self {
        Self {
            steps: Vec::new(),
            close: true,
        }
    }
}

type Handler = dyn Fn(&Value) -> Reply + Send + Sync + 'static;

/// A running fake. Dropping it stops the listener, closes every open connection and removes
/// its folder.
pub struct FakeHerdr {
    dir: PathBuf,
    socket: PathBuf,
    requests: Arc<Mutex<Vec<Value>>>,
    ended: Arc<AtomicU64>,
    connections: Arc<Mutex<Vec<JoinHandle<()>>>>,
    accept: JoinHandle<()>,
}

impl FakeHerdr {
    /// Listens in a new temporary folder and answers each request with `handler(request)`.
    /// A request line that is not JSON is recorded as a JSON string of the line.
    pub fn start(handler: impl Fn(&Value) -> Reply + Send + Sync + 'static) -> Self {
        let dir = fresh_dir();
        let socket = dir.join("herdr.sock");
        let listener = UnixListener::bind(&socket).expect("bind the fake herdr socket");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let ended = Arc::new(AtomicU64::new(0));
        let connections = Arc::new(Mutex::new(Vec::new()));
        let handler: Arc<Handler> = Arc::new(handler);
        let accept = tokio::spawn({
            let requests = requests.clone();
            let ended = ended.clone();
            let connections = connections.clone();
            async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let task = tokio::spawn(serve(
                        stream,
                        handler.clone(),
                        requests.clone(),
                        ended.clone(),
                    ));
                    connections.lock().unwrap().push(task);
                }
            }
        });
        Self {
            dir,
            socket,
            requests,
            ended,
            connections,
            accept,
        }
    }

    /// The socket's path, to hand to the client.
    pub fn socket(&self) -> &Path {
        &self.socket
    }

    /// Every request read so far, in the order they arrived.
    pub fn requests(&self) -> Vec<Value> {
        self.requests.lock().unwrap().clone()
    }

    /// How many connections the client closed while the fake kept them open.
    pub fn ended_by_client(&self) -> u64 {
        self.ended.load(Ordering::SeqCst)
    }

    /// Waits up to `within` until `count` requests have arrived; the requests then.
    pub async fn wait_for_requests(&self, count: usize, within: Duration) -> Vec<Value> {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let requests = self.requests();
            if requests.len() >= count || tokio::time::Instant::now() >= deadline {
                return requests;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

impl Drop for FakeHerdr {
    fn drop(&mut self) {
        self.accept.abort();
        for task in self.connections.lock().unwrap().drain(..) {
            task.abort();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn serve(
    stream: UnixStream,
    handler: Arc<Handler>,
    requests: Arc<Mutex<Vec<Value>>>,
    ended: Arc<AtomicU64>,
) {
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let Ok(Some(line)) = lines.next_line().await else {
        return;
    };
    let request = serde_json::from_str(&line).unwrap_or(Value::String(line));
    requests.lock().unwrap().push(request.clone());
    let reply = handler(&request);
    for step in reply.steps {
        match step {
            Step::Write(bytes) => {
                if write.write_all(&bytes).await.is_err() {
                    return;
                }
                let _ = write.flush().await;
            }
            Step::Wait(duration) => tokio::time::sleep(duration).await,
        }
    }
    if reply.close {
        let _ = write.shutdown().await;
        return;
    }
    // keep the connection open until the client goes: read until its end
    while let Ok(Some(_)) = lines.next_line().await {}
    ended.fetch_add(1, Ordering::SeqCst);
}

/// A path in a fresh, empty temporary folder that nothing else uses.
pub fn fresh_dir() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "herdr-fleet-herdr-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create a temporary folder");
    dir
}
