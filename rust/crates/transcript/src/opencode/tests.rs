//! The reader against a service in memory, as `server/opencode-session.test.ts` reads it: what is
//! kept between reads, the lock, the clock, and the cursor the reader writes. The corpus checks
//! the pages themselves (`tests/opencode.rs`).

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use serde_json::{Value, json};

use super::session::{KEEP_MESSAGES, before_cursor, encode_uri_component};
use super::{OpencodeApi, OpencodeConversations, OpencodeError};
use crate::records::Row;
use crate::{ConversationError, PageRequest, UnavailableReason};

const SID: &str = "ses_testsession0001";

/// What the service holds; tests change it between reads.
struct Held {
    messages: Vec<Value>,
    session: Option<Value>,
    models: Vec<Value>,
    calls: Vec<String>,
    /// answers a cursor with 400, as the service does one it cannot read
    refuse_cursors: bool,
}

/// The service as the CLI shows it (`Service` of `server/opencode-session.test.ts`): a message
/// list newest first with cursors that name a message (not a place), a session, and the call log.
struct Service {
    held: Mutex<Held>,
    /// called inside each GET of a message list, with the lock of `held` free
    on_list: Box<dyn Fn() + Send + Sync>,
}

impl Service {
    fn new(messages: Vec<Value>) -> Self {
        Self {
            held: Mutex::new(Held {
                messages,
                session: Some(json!({
                    "id": SID, "time": { "created": 1, "updated": 1 },
                    "tokens": { "input": 0, "output": 0 }, "cost": 0,
                })),
                models: Vec::new(),
                calls: Vec::new(),
                refuse_cursors: false,
            }),
            on_list: Box::new(|| {}),
        }
    }

    fn held(&self) -> std::sync::MutexGuard<'_, Held> {
        self.held.lock().expect("the service's lock")
    }

    fn calls(&self, path: &str) -> usize {
        self.held()
            .calls
            .iter()
            .filter(|call| call.as_str() == path)
            .count()
    }
}

impl OpencodeApi for Service {
    fn service_running(&self) -> Result<bool, OpencodeError> {
        Ok(true)
    }

    fn get(&self, path: &str) -> Result<Value, OpencodeError> {
        let not_found = |tag: &str| OpencodeError::Http {
            status: 404,
            tag: tag.to_owned(),
        };
        let (route, query) = path.split_once('?').unwrap_or((path, ""));
        let argument = |name: &str| {
            query
                .split('&')
                .find_map(|pair| pair.strip_prefix(&format!("{name}=")))
        };
        let mut held = self.held();
        held.calls.push(path.to_owned());
        if route == "/api/model" {
            return Ok(json!({ "data": held.models }));
        }
        let rest = route
            .strip_prefix(&format!("/api/session/{SID}"))
            .ok_or_else(|| not_found("SessionNotFoundError"))?;
        if held.session.is_none() {
            return Err(not_found("SessionNotFoundError"));
        }
        if rest.is_empty() {
            return Ok(json!({ "data": held.session }));
        }
        if let Some(id) = rest.strip_prefix("/message/") {
            let found = held.messages.iter().find(|message| message["id"] == id);
            return found
                .map(|message| json!({ "data": message }))
                .ok_or_else(|| not_found("MessageNotFoundError"));
        }
        let limit: usize = argument("limit").map_or(50, |limit| limit.parse().expect("a limit"));
        let rows: Vec<Value> = match argument("cursor") {
            None => held.messages.iter().rev().take(limit).cloned().collect(),
            Some(_) if held.refuse_cursors => {
                return Err(OpencodeError::Http {
                    status: 400,
                    tag: "InvalidCursorError".to_owned(),
                });
            }
            Some(cursor) => {
                let cursor: Value = serde_json::from_slice(
                    &URL_SAFE_NO_PAD.decode(cursor).expect("a base64url cursor"),
                )
                .expect("a JSON cursor");
                let at = held
                    .messages
                    .iter()
                    .position(|message| message["id"] == cursor["id"])
                    .unwrap_or(0);
                held.messages[at.saturating_sub(limit)..at]
                    .iter()
                    .rev()
                    .cloned()
                    .collect()
            }
        };
        drop(held);
        (self.on_list)();
        let point = |row: &Value| {
            URL_SAFE_NO_PAD.encode(
                json!({ "id": row["id"], "order": "desc", "direction": "next" }).to_string(),
            )
        };
        Ok(match rows.last() {
            None => json!({ "data": rows }),
            Some(last) => json!({ "data": rows, "cursor": { "next": point(last) } }),
        })
    }
}

fn user(id: &str, created: i64) -> Value {
    json!({ "id": id, "type": "user", "time": { "created": created }, "text": format!("<{id}>") })
}

fn step(id: &str, created: i64) -> Value {
    json!({
        "id": id, "type": "assistant", "agent": "build",
        "model": { "id": "model-x", "providerID": "prov-x" },
        "time": { "created": created, "completed": created + 1 }, "finish": "tool-calls",
        "tokens": { "input": 10, "output": 1, "reasoning": 0, "cache": { "read": 90, "write": 0 } },
        "content": [{ "type": "text", "text": format!("<{id}>") }],
    })
}

/// A reader on `service` whose clock reads `now`.
fn reader(service: &Arc<Service>, now: &Arc<AtomicI64>) -> OpencodeConversations {
    let now = Arc::clone(now);
    OpencodeConversations::new(
        Arc::clone(service) as Arc<dyn OpencodeApi>,
        Box::new(move || now.load(Ordering::SeqCst)),
    )
}

/// A reader at time 100, as `withService` of the TypeScript test makes one.
fn with_service(messages: Vec<Value>) -> (Arc<Service>, OpencodeConversations) {
    let service = Arc::new(Service::new(messages));
    let reader = reader(&service, &Arc::new(AtomicI64::new(100)));
    (service, reader)
}

fn held_messages(reader: &OpencodeConversations) -> Vec<Row> {
    let state = reader.state.lock().expect("the reader's lock");
    let (_, entry) = state
        .newest
        .iter()
        .find(|(id, _)| id == SID)
        .expect("the session is held");
    entry.messages.clone()
}

// server/opencode-session.test.ts:373 "what is held stays bounded however long the turn goes"
#[test]
fn what_is_held_stays_bounded_however_long_the_turn_goes() {
    let (service, reader) = with_service(vec![user("msg_first", 1)]);
    let mut created = 2;
    for round in 0..8 {
        for k in 0..90 {
            service
                .held()
                .messages
                .push(step(&format!("msg_r{round}_{k}"), created));
            created += 2;
        }
        reader
            .page(SID, true, &PageRequest::default())
            .expect("a page");
    }
    assert!(held_messages(&reader).len() <= 400);
    assert_eq!(KEEP_MESSAGES, 400);
    let page = reader
        .page(SID, true, &PageRequest::default())
        .expect("a page");
    assert!(!page.turns.last().expect("a turn").parts.is_empty());
}

// server/opencode-session.test.ts:384 "a pasted image's bytes are not kept between polls"
#[test]
fn a_pasted_images_bytes_are_not_kept_between_polls() {
    let png = STANDARD.encode("<png bytes>");
    let mut prompt = user("msg_u", 1);
    prompt["files"] = json!([{ "data": png, "mime": "image/png", "source": { "type": "inline" } }]);
    let (_, reader) = with_service(vec![prompt, step("msg_a", 2)]);
    reader
        .page(SID, false, &PageRequest::default())
        .expect("a page");
    let held = held_messages(&reader);
    let file = &held[0]["files"][0];
    assert_eq!(file["data"], "");
    assert_eq!(file["mime"], "image/png");
    // the image itself is still read, by its ref
    let image = reader
        .image(SID, "msg_u:0")
        .expect("a read")
        .expect("an image");
    assert_eq!(image.media_type, "image/png");
    assert_eq!(image.bytes, b"<png bytes>");
}

// ADR 0192-phase-2-split, "OpenCode": the lock is not held while the CLI answers, so two panes'
// reads run side by side. Each read waits inside its GET until the other is inside one too; with
// the lock held across the GET, the second never gets there.
#[test]
fn two_reads_are_inside_the_cli_at_once() {
    let inside = Arc::new((Mutex::new(0_usize), Condvar::new()));
    let alone = Arc::new(AtomicBool::new(false));
    let mut service = Service::new(vec![user("msg_u", 1), step("msg_a", 2)]);
    let (waiting, waited) = (Arc::clone(&inside), Arc::clone(&alone));
    service.on_list = Box::new(move || {
        let (count, arrived) = &*waiting;
        let mut count = count.lock().expect("the count");
        *count += 1;
        arrived.notify_all();
        let (_count, timeout) = arrived
            .wait_timeout_while(count, Duration::from_secs(5), |count| *count < 2)
            .expect("the count");
        if timeout.timed_out() {
            waited.store(true, Ordering::SeqCst);
        }
    });
    let service = Arc::new(service);
    let reader = Arc::new(reader(&service, &Arc::new(AtomicI64::new(100))));
    let reads: Vec<_> = (0..2)
        .map(|_| {
            let reader = Arc::clone(&reader);
            thread::spawn(move || reader.page(SID, true, &PageRequest::default()).is_ok())
        })
        .collect();
    for read in reads {
        assert!(read.join().expect("a read"));
    }
    assert!(
        !alone.load(Ordering::SeqCst),
        "a read waited alone inside the CLI: the other was held outside it"
    );
}

// The model list is kept ten minutes, or thirty seconds when it is empty (MODEL_TTL_MS and
// MODEL_RETRY_MS of server/opencode-session.ts), by the clock the reader is given: TypeScript
// reads `Date.now()` there, the Rust reader its clock.
#[test]
fn the_model_list_is_read_again_by_the_given_clock() {
    let models = || {
        json!([{ "id": "model-x", "modelID": "model-x", "providerID": "prov-x",
                 "limit": { "context": 200_000, "output": 8000 } }])
    };
    let service = Arc::new(Service::new(vec![user("msg_u", 1), step("msg_a", 2)]));
    service.held().models = models().as_array().expect("models").clone();
    let now = Arc::new(AtomicI64::new(1_000_000));
    let reader = reader(&service, &now);
    let window = |reader: &OpencodeConversations| {
        reader
            .page(SID, true, &PageRequest::default())
            .expect("a page")
            .metadata
            .context
            .and_then(|context| context.window)
    };
    assert_eq!(window(&reader), Some(200_000.0));
    now.store(1_000_000 + 10 * 60_000 - 1, Ordering::SeqCst);
    window(&reader);
    assert_eq!(service.calls("/api/model"), 1);
    now.store(1_000_000 + 10 * 60_000, Ordering::SeqCst);
    window(&reader);
    assert_eq!(service.calls("/api/model"), 2);

    // an empty list is asked again after thirty seconds
    service.held().models.clear();
    now.store(3_000_000, Ordering::SeqCst);
    assert_eq!(window(&reader), None);
    assert_eq!(service.calls("/api/model"), 3);
    now.store(3_000_000 + 30_000 - 1, Ordering::SeqCst);
    window(&reader);
    assert_eq!(service.calls("/api/model"), 3);
    service.held().models = models().as_array().expect("models").clone();
    now.store(3_000_000 + 30_000, Ordering::SeqCst);
    assert_eq!(window(&reader), Some(200_000.0));
    assert_eq!(service.calls("/api/model"), 4);
}

// Expected values: Bun 1.4.4
// `Buffer.from(JSON.stringify({ id, order: "desc", direction: "next" })).toString("base64url")`.
#[test]
fn writes_the_before_cursor_as_typescript_does() {
    for (id, expected) in [
        (
            "msg_abc",
            "eyJpZCI6Im1zZ19hYmMiLCJvcmRlciI6ImRlc2MiLCJkaXJlY3Rpb24iOiJuZXh0In0",
        ),
        (
            "msg_a79_2",
            "eyJpZCI6Im1zZ19hNzlfMiIsIm9yZGVyIjoiZGVzYyIsImRpcmVjdGlvbiI6Im5leHQifQ",
        ),
        (
            "msg_x-Y_9",
            "eyJpZCI6Im1zZ194LVlfOSIsIm9yZGVyIjoiZGVzYyIsImRpcmVjdGlvbiI6Im5leHQifQ",
        ),
    ] {
        assert_eq!(before_cursor(id), expected, "the cursor before {id}");
    }
    // and the reader asks the list with it
    let (service, reader) = with_service(vec![user("msg_abc", 1), step("msg_b", 2)]);
    let before = PageRequest {
        before: Some("msg_abc".to_owned()),
        ..PageRequest::default()
    };
    reader.page(SID, false, &before).expect("a page");
    assert_eq!(
        service.calls(&format!(
            "/api/session/{SID}/message?limit=100&cursor=eyJpZCI6Im1zZ19hYmMiLCJvcmRlciI6ImRlc2MiLCJkaXJlY3Rpb24iOiJuZXh0In0"
        )),
        1
    );
}

// Expected values: Bun 1.4.4 `encodeURIComponent`.
#[test]
fn escapes_a_path_segment_as_encode_uri_component() {
    for (value, expected) in [
        ("ses_abc", "ses_abc"),
        ("a b/c?d&e", "a%20b%2Fc%3Fd%26e"),
        ("日本", "%E6%97%A5%E6%9C%AC"),
        ("-_.!~*()'", "-_.!~*()'"),
        ("%#", "%25%23"),
    ] {
        assert_eq!(encode_uri_component(value), expected);
    }
}

// server/opencode-session.ts:154-159 and 309-311: a 404 is no session, a refused cursor a changed
// history, and another failure of the CLI is no answer the reader can give.
#[test]
fn reads_the_http_status_of_a_failed_get() {
    let (service, reader) = with_service(vec![user("msg_u", 1), step("msg_a", 2)]);
    let before = PageRequest {
        before: Some("msg_a".to_owned()),
        ..PageRequest::default()
    };
    service.held().refuse_cursors = true;
    assert_eq!(
        reader.page(SID, false, &before),
        Err(ConversationError::HistoryChanged)
    );
    service.held().session = None;
    assert_eq!(
        reader.page(SID, false, &PageRequest::default()),
        Err(ConversationError::ConversationUnavailable(
            UnavailableReason::OpencodeSessionMissing
        ))
    );
    assert_eq!(
        reader.page(SID, false, &before),
        Err(ConversationError::HistoryChanged)
    );
    assert_eq!(reader.tool_output(SID, "msg_a:0"), Ok(None));
    assert_eq!(
        reader.page("ses_other0001", false, &PageRequest::default()),
        Err(ConversationError::ConversationUnavailable(
            UnavailableReason::OpencodeSessionMissing
        ))
    );
}
