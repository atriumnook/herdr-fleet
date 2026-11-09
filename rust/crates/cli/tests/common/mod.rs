//! Runs the fleet CLI's `run` on one case of the fleet CLI contract, in this process, the way
//! `scripts/fleet-cli-fixtures.ts` runs an executable: a stub server on 127.0.0.1 that answers
//! the case's responses in order and records each request, a new empty working folder, and an
//! environment built from nothing (`PATH`, `HOME`, `TMPDIR`, `TZ=UTC`, `LANG=en_US.UTF-8`, the
//! case's variables, and `HERDR_FLEET_URL` pointing at the stub). What the CLI sent and printed
//! comes back with the placeholders `$URL` and `$CWD` put in, as the runner writes them.
#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

/// The folder of the fleet CLI contract's cases.
pub fn cases_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/fleet-cli")
}

/// One case: what the runner reads from `fixtures/fleet-cli/<case>.json`.
#[derive(Debug, Clone, Default)]
pub struct Case {
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    pub trailing_slash: bool,
    pub stdin: Option<String>,
    pub files: Vec<(String, String)>,
    /// Status and body; a string body is sent as text, anything else as JSON.
    pub responses: Vec<(u16, Value)>,
    /// No server listens (`"server": "closed"`).
    pub closed: bool,
}

impl Case {
    pub fn new(argv: &[&str]) -> Self {
        Case {
            argv: argv.iter().map(|a| a.to_string()).collect(),
            ..Case::default()
        }
    }

    pub fn env(mut self, name: &str, value: &str) -> Self {
        self.env.push((name.to_string(), value.to_string()));
        self
    }

    pub fn respond(mut self, status: u16, body: Value) -> Self {
        self.responses.push((status, body));
        self
    }

    pub fn file(mut self, name: &str, text: &str) -> Self {
        self.files.push((name.to_string(), text.to_string()));
        self
    }

    pub fn stdin(mut self, text: &str) -> Self {
        self.stdin = Some(text.to_string());
        self
    }

    /// The case a corpus file holds.
    pub fn from_json(spec: &Value) -> Self {
        let strings = |v: &Value| -> Vec<(String, String)> {
            v.as_object()
                .map(|o| {
                    o.iter()
                        .map(|(k, v)| (k.clone(), v.as_str().expect("a string").to_string()))
                        .collect()
                })
                .unwrap_or_default()
        };
        Case {
            argv: spec["argv"]
                .as_array()
                .expect("argv")
                .iter()
                .map(|a| a.as_str().expect("an argument").to_string())
                .collect(),
            env: strings(&spec["env"]),
            trailing_slash: spec["trailingSlash"].as_bool().unwrap_or(false),
            stdin: spec["stdin"].as_str().map(str::to_string),
            files: strings(&spec["files"]),
            responses: spec["responses"]
                .as_array()
                .map(|answers| {
                    answers
                        .iter()
                        .map(|a| {
                            let status = a["status"].as_u64().expect("a status") as u16;
                            let body = a.get("body").cloned().unwrap_or(Value::Object(Map::new()));
                            (status, body)
                        })
                        .collect()
                })
                .unwrap_or_default(),
            closed: spec["server"].as_str() == Some("closed"),
        }
    }
}

/// A request the stub received, as the runner records it.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub method: String,
    pub path: String,
    /// Only `x-herdr-fleet` and `authorization`, when sent.
    pub headers: BTreeMap<String, String>,
    pub body: Option<Value>,
}

impl Request {
    /// The request as the corpus writes it in `expected.requests`.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("method".into(), Value::String(self.method.clone()));
        out.insert("path".into(), Value::String(self.path.clone()));
        let headers = self
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect();
        out.insert("headers".into(), Value::Object(headers));
        if let Some(body) = &self.body {
            out.insert("body".into(), body.clone());
        }
        Value::Object(out)
    }
}

/// What a run of the CLI did.
#[derive(Debug, Clone, PartialEq)]
pub struct Actual {
    pub requests: Vec<Request>,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

impl Actual {
    pub fn paths(&self) -> Vec<String> {
        self.requests.iter().map(|r| r.path.clone()).collect()
    }
}

const FIRST_PORT: u16 = 7400;
const PORT_COUNT: u16 = 100;

/// A start among the ports 7400 to 7499 that differs from call to call.
fn port_start() -> u16 {
    static CALLS: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    ((nanos + CALLS.fetch_add(7, Ordering::Relaxed)) % PORT_COUNT as u64) as u16
}

/// Binds 127.0.0.1 on a free port from 7400 to 7499, as the runner does (the standing orders keep
/// test servers in that range).
fn listen() -> TcpListener {
    let start = port_start();
    for i in 0..PORT_COUNT {
        let port = FIRST_PORT + (start + i) % PORT_COUNT;
        if closed_ports().contains(&port) {
            continue;
        }
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            return listener;
        }
    }
    panic!("no free port from 7400 to 7499");
}

/// The ports a `"server": "closed"` case of this process has let go and points its CLI at: the
/// stubs of the tests running beside it do not bind them until that case ends.
fn closed_ports() -> std::sync::MutexGuard<'static, BTreeSet<u16>> {
    static CLOSED: Mutex<BTreeSet<u16>> = Mutex::new(BTreeSet::new());
    CLOSED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Stub {
    port: u16,
    requests: Arc<Mutex<Vec<Request>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Stub {
    fn start(responses: Vec<(u16, Value)>) -> Stub {
        let listener = listen();
        let port = listener.local_addr().expect("an address").port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (recorded, stopping) = (requests.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stopping.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                serve(stream, &responses, &recorded);
            }
        });
        Stub {
            port,
            requests,
            stop,
            thread: Some(thread),
        }
    }

    fn finish(mut self) -> Vec<Request> {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(thread) = self.thread.take() {
            thread.join().expect("the stub's thread");
        }
        std::mem::take(&mut *self.requests.lock().expect("the requests"))
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        408 => "Request Timeout",
        409 => "Conflict",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        _ => "Unknown",
    }
}

/// Reads one request from `stream`, records it and answers the next response.
fn serve(stream: TcpStream, responses: &[(u16, Value)], requests: &Mutex<Vec<Request>>) {
    let mut reader = BufReader::new(stream.try_clone().expect("a stream"));
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut headers = BTreeMap::new();
    let mut length = 0usize;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).unwrap_or(0) == 0 {
            break;
        }
        let header = header.trim_end_matches(['\r', '\n']);
        if header.is_empty() {
            break;
        }
        let Some((name, value)) = header.split_once(':') else {
            continue;
        };
        let (name, value) = (name.trim().to_ascii_lowercase(), value.trim().to_string());
        if name == "content-length" {
            length = value.parse().unwrap_or(0);
        }
        if name == "x-herdr-fleet" || name == "authorization" {
            headers.insert(name, value);
        }
    }
    let mut body = vec![0; length];
    let _ = reader.read_exact(&mut body);
    let text = String::from_utf8_lossy(&body).into_owned();
    let body = if text.is_empty() {
        None
    } else {
        Some(serde_json::from_str(&text).unwrap_or(Value::String(text)))
    };
    let index = {
        let mut requests = requests.lock().expect("the requests");
        requests.push(Request {
            method,
            path,
            headers,
            body,
        });
        requests.len() - 1
    };
    let (status, content_type, text) = match responses.get(index) {
        Some((status, Value::String(text))) => (*status, "text/plain", text.clone()),
        Some((status, body)) => (*status, "application/json", body.to_string()),
        None => (
            500,
            "application/json",
            r#"{"error":{"code":"no_response","message":"the case has no response for this request"}}"#
                .to_string(),
        ),
    };
    let mut stream = stream;
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
        reason(status),
        text.len()
    );
    let _ = stream.flush();
}

/// A port from 7400 to 7499 that nothing listens on: free when it was bound and let go, and
/// kept from the other stubs of this process until the guard is dropped. Another process could
/// take it before the CLI connects; the case then fails rather than passes, as with the runner.
struct ClosedPort(u16);

impl ClosedPort {
    fn take() -> ClosedPort {
        let listener = listen();
        let port = listener.local_addr().expect("an address").port();
        // reserved while still bound, so that no stub of this process binds it in between
        closed_ports().insert(port);
        drop(listener);
        ClosedPort(port)
    }
}

impl Drop for ClosedPort {
    fn drop(&mut self) {
        closed_ports().remove(&self.0);
    }
}

/// A new empty folder for one case, with its real path.
fn new_folder() -> PathBuf {
    static COUNT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!(
        "fleet-cli-case-{}-{nanos}-{}",
        std::process::id(),
        COUNT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&path).expect("a folder for the case");
    path.canonicalize().expect("the folder's real path")
}

/// encodeURIComponent, to find the working folder in a request's path as the runner does.
fn uri_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn substitute(value: &Value, pairs: &[(String, &str)]) -> Value {
    match value {
        Value::String(text) => Value::String(
            pairs
                .iter()
                .fold(text.clone(), |t, (find, replace)| t.replace(find, replace)),
        ),
        Value::Array(items) => Value::Array(items.iter().map(|v| substitute(v, pairs)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), substitute(v, pairs)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Runs the CLI's `run` on `case`.
pub fn run_case(case: &Case) -> Actual {
    let stub = (!case.closed).then(|| Stub::start(case.responses.clone()));
    let closed = case.closed.then(ClosedPort::take);
    let port = stub
        .as_ref()
        .map(|s| s.port)
        .or(closed.as_ref().map(|c| c.0))
        .expect("a stub or a closed port");
    let url = format!("http://127.0.0.1:{port}");
    let cwd = new_folder();
    for (name, text) in &case.files {
        std::fs::write(cwd.join(name), text).expect("a case's file");
    }
    let mut env = BTreeMap::new();
    env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
    env.insert("HOME".to_string(), "/nonexistent-home".to_string());
    env.insert(
        "TMPDIR".to_string(),
        std::env::temp_dir().to_string_lossy().into_owned(),
    );
    env.insert("TZ".to_string(), "UTC".to_string());
    env.insert("LANG".to_string(), "en_US.UTF-8".to_string());
    for (name, value) in &case.env {
        env.insert(name.clone(), value.clone());
    }
    env.insert(
        "HERDR_FLEET_URL".to_string(),
        if case.trailing_slash {
            format!("{url}/")
        } else {
            url.clone()
        },
    );
    let argv = case.argv.clone();
    let mut stdin = std::io::Cursor::new(case.stdin.clone().unwrap_or_default().into_bytes());
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let exit_code = herdr_fleet_cli::run(&argv, &env, &cwd, &mut stdin, &mut stdout, &mut stderr);
    let requests = stub.map(Stub::finish).unwrap_or_default();
    let cwd_text = cwd.to_string_lossy().into_owned();
    let pairs = [(url.clone(), "$URL"), (cwd_text.clone(), "$CWD")];
    let requests = requests
        .into_iter()
        .map(|r| Request {
            path: r.path.replace(&uri_component(&cwd_text), "$CWD"),
            body: r.body.map(|b| substitute(&b, &pairs)),
            ..r
        })
        .collect();
    let text = |bytes: Vec<u8>| {
        let text = String::from_utf8(bytes).expect("the CLI writes UTF-8");
        match substitute(&Value::String(text), &pairs) {
            Value::String(text) => text,
            _ => unreachable!(),
        }
    };
    let _ = std::fs::remove_dir_all(&cwd);
    Actual {
        requests,
        stdout: text(stdout),
        stderr: text(stderr),
        exit_code,
    }
}

/// Whether `pattern`, a regular expression of the corpus, matches the whole of `text`. Knows the
/// constructs the corpus's patterns use: escaped characters (`\n` is a newline), `.+` (one or more
/// characters but line terminators) and `[^\n]*`; any other construct panics, so a new pattern
/// in the corpus is not compared wrongly.
pub fn pattern_matches(pattern: &str, text: &str) -> bool {
    #[derive(Debug)]
    enum Token {
        Char(char),
        AnyPlus,
        NotNewlineStar,
    }
    let mut tokens = Vec::new();
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some('n') => tokens.push(Token::Char('\n')),
                Some(c) if !c.is_ascii_alphanumeric() => tokens.push(Token::Char(c)),
                other => panic!("the pattern uses \\{other:?}, which this matcher does not know"),
            },
            '.' => {
                assert_eq!(chars.next(), Some('+'), "only .+ is known");
                tokens.push(Token::AnyPlus);
            }
            '[' => {
                let class: String = chars.by_ref().take(4).collect();
                assert_eq!(class, "^\\n]", "only [^\\n] is known");
                assert_eq!(chars.next(), Some('*'), "only [^\\n]* is known");
                tokens.push(Token::NotNewlineStar);
            }
            '(' | ')' | '*' | '+' | '?' | '{' | '}' | '|' | '^' | '$' | ']' => {
                panic!("the pattern uses {c}, which this matcher does not know")
            }
            c => tokens.push(Token::Char(c)),
        }
    }
    fn matches(tokens: &[Token], text: &[char]) -> bool {
        let line_terminator = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
        match tokens.split_first() {
            None => text.is_empty(),
            Some((Token::Char(c), rest)) => text.first() == Some(c) && matches(rest, &text[1..]),
            Some((Token::AnyPlus, rest)) => (1..=text.len())
                .take_while(|&n| !line_terminator(text[n - 1]))
                .any(|n| matches(rest, &text[n..])),
            Some((Token::NotNewlineStar, rest)) => (0..=text.len())
                .take_while(|&n| n == 0 || text[n - 1] != '\n')
                .any(|n| matches(rest, &text[n..])),
        }
    }
    let text: Vec<char> = text.chars().collect();
    matches(&tokens, &text)
}

/// Whether an expected output of the corpus (a string, or `{ "pattern": … }`) matches `actual`.
pub fn output_matches(expected: &Value, actual: &str) -> bool {
    match expected {
        Value::String(text) => text == actual,
        Value::Object(o) => pattern_matches(o["pattern"].as_str().expect("a pattern"), actual),
        _ => panic!("an output is a string or a pattern"),
    }
}
