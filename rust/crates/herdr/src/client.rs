//! One request, one connection (`herdrRpc` in `server/herdr/client.ts`): the herdr server closes
//! the connection after a single response, so a pooled or reused socket would never see a second
//! reply.

use crate::answer::Answer;
use crate::error::HerdrError;
use crate::lines::LineReader;
use herdr_api::{Method, ResponseResult};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// A client of one herdr server, named by its socket, and the time limit of its calls. Cheap to
/// clone; it holds no connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Herdr {
    socket_path: PathBuf,
    timeout: Duration,
}

impl Herdr {
    /// How long a call waits for its answer unless the caller says otherwise
    /// (`DEFAULT_TIMEOUT_MS`).
    pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);

    /// The herdr whose socket is `socket_path` (on Windows, the marker file the named pipe is
    /// named after).
    /// Its calls give up after [`Self::DEFAULT_TIMEOUT`].
    pub fn new(socket_path: impl Into<PathBuf>) -> Self {
        Self {
            socket_path: socket_path.into(),
            timeout: Self::DEFAULT_TIMEOUT,
        }
    }

    /// A copy whose calls give up after `timeout` (connecting included): a call herdr may take
    /// longer than ten seconds to answer passes its own limit.
    pub fn with_timeout(&self, timeout: Duration) -> Self {
        Self {
            socket_path: self.socket_path.clone(),
            timeout,
        }
    }

    /// The socket this client talks to.
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// Calls `M` on a connection of its own and returns herdr's result: the first non-blank line
    /// answers. A result that is none of [`ResponseResult`]'s shapes is a `bad_frame` (ADR
    /// 0242-phase-3-split); a `type` the schema does not name is `ResponseResult::Other`.
    pub async fn rpc<M: Method>(&self, params: M::Params) -> Result<ResponseResult, HerdrError> {
        let request = request_line(M::NAME, &params);
        match tokio::time::timeout(self.timeout, self.exchange(M::NAME, &request)).await {
            Ok(answer) => answer,
            Err(_) => Err(HerdrError::Timeout(format!(
                "herdr {} timed out after {}ms",
                M::NAME,
                self.timeout.as_millis()
            ))),
        }
    }

    /// [`Self::rpc`], then the shape the table gives `M` (see [`crate::Answer`]); another shape
    /// is a `bad_frame`.
    pub async fn call<M: Answer>(&self, params: M::Params) -> Result<M::Output, HerdrError> {
        M::answer(self.rpc::<M>(params).await?)
    }

    async fn exchange(&self, method: &str, request: &str) -> Result<ResponseResult, HerdrError> {
        let mut stream = connect(&self.socket_path).await.map_err(|error| {
            HerdrError::ConnectFailed(format!(
                "cannot reach herdr at {}: {error}",
                self.socket_path.display()
            ))
        })?;
        if let Err(error) = stream.write_all(request.as_bytes()).await {
            // herdr closed the connection before it read the request: Bun's write does not
            // fail there, and its close handler reports `closed`
            return Err(match error.kind() {
                std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset => {
                    closed_before_answer(method)
                }
                _ => socket_error(error),
            });
        }
        let mut lines = LineReader::default();
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            let read = stream.read(&mut chunk).await.map_err(socket_error)?;
            if read == 0 {
                return Err(closed_before_answer(method));
            }
            // the first frame answers; the connection is dropped (closed) with the rest
            if let Some(line) = lines.push(&chunk[..read]).into_iter().next() {
                return read_answer(&line);
            }
        }
    }
}

fn closed_before_answer(method: &str) -> HerdrError {
    HerdrError::Closed(format!(
        "herdr closed the connection before answering {method}"
    ))
}

fn socket_error(error: std::io::Error) -> HerdrError {
    HerdrError::SocketError(error.to_string())
}

/// The answer a frame carries: herdr's error, or its result as one of the response shapes.
fn read_answer(line: &str) -> Result<ResponseResult, HerdrError> {
    let frame = parse_frame(line).map_err(HerdrError::BadFrame)?;
    if let Some(error) = frame.get("error").filter(|error| truthy(error)) {
        return Err(HerdrError::from_frame(error, "herdr request failed"));
    }
    let result = frame.get("result").cloned().unwrap_or(Value::Null);
    serde_json::from_value(result).map_err(|error| {
        HerdrError::BadFrame(format!("herdr answered with no response shape: {error}"))
    })
}

/// A frame as JSON; the error is the message of a `bad_frame`.
pub(crate) fn parse_frame(line: &str) -> Result<Value, String> {
    serde_json::from_str(line).map_err(|_| {
        let quoted: String = line.chars().take(200).collect();
        format!("herdr sent unparseable frame: {quoted}")
    })
}

/// JavaScript's truthiness of a JSON value (`if (frame.error)`).
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `{"id", "method", "params"}` and a newline.
pub(crate) fn request_line(method: &str, params: &impl Serialize) -> String {
    #[derive(Serialize)]
    struct Request<'a, P> {
        id: String,
        method: &'a str,
        params: &'a P,
    }
    let request = Request {
        id: next_id(),
        method,
        params,
    };
    // the generated params hold strings, numbers, lists and string-keyed maps only
    let mut line = serde_json::to_string(&request).expect("herdr params encode as JSON");
    line.push('\n');
    line
}

/// `br-<now in base 36>-<counter>`, as `nextId` writes it.
fn next_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis());
    format!("br-{}-{count}", base36(now))
}

fn base36(mut value: u128) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut digits = Vec::new();
    loop {
        digits.push(DIGITS[(value % 36) as usize]);
        value /= 36;
        if value == 0 {
            break;
        }
    }
    digits.reverse();
    String::from_utf8(digits).expect("ASCII digits")
}

#[cfg(unix)]
pub(crate) type Stream = tokio::net::UnixStream;

#[cfg(windows)]
pub(crate) type Stream = tokio::net::windows::named_pipe::NamedPipeClient;

/// Opens herdr's socket: a Unix socket, or on Windows the named pipe the marker names.
#[cfg(unix)]
pub(crate) async fn connect(socket_path: &Path) -> std::io::Result<Stream> {
    tokio::net::UnixStream::connect(socket_path).await
}

#[cfg(windows)]
pub(crate) async fn connect(socket_path: &Path) -> std::io::Result<Stream> {
    // every instance of the pipe is serving another client: wait for one to free up, as tokio's
    // named pipe documentation does (the call's time limit bounds the wait; a subscription's
    // owner ends it by dropping the stream)
    const ERROR_PIPE_BUSY: i32 = 231;
    let name = crate::socket::pipe_name(socket_path);
    loop {
        match tokio::net::windows::named_pipe::ClientOptions::new().open(&name) {
            Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            result => return result,
        }
    }
}
