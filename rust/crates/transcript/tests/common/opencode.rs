//! OpenCode's recorded replies (`api.json`) as the CLI would answer them: `RecordedOpencodeApi` of
//! `scripts/conversation-fixtures.ts` (the format: its head, and ADR 0122-parity-criteria).

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, PoisonError};

use herdr_fleet_transcript::opencode::{OpencodeApi, OpencodeError};
use serde_json::Value;

use super::{only_keys, validate_replies};

/// A recorded reply of `opencode api GET <path>`.
#[derive(Debug, Clone)]
struct Reply {
    status: u16,
    body: Value,
}

/// The replies of `opencode api GET <path>` a case recorded, by path with its query arguments
/// sorted by name; a GET of a path not recorded fails the case, naming the path.
pub struct RecordedOpencodeApi {
    running: bool,
    replies: Mutex<HashMap<String, Reply>>,
    unrecorded: Mutex<Vec<String>>,
}

/// A lock's value, also after a panic elsewhere held it: the runner reports that panic itself.
fn held<T>(lock: &Mutex<T>) -> MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A path with its query arguments sorted by name, those of one name in the order given (their
/// order means something): the key a reply is recorded under (`replyKey`). Names compare by UTF-16
/// code units, as JavaScript's `<` does.
pub fn reply_key(path: &str) -> String {
    let Some((head, query)) = path.split_once('?') else {
        return path.to_owned();
    };
    let mut pairs: Vec<&str> = query.split('&').filter(|pair| !pair.is_empty()).collect();
    let name = |pair: &str| pair.split('=').next().unwrap_or_default().to_owned();
    // a stable sort keeps the arguments of one name in the order given
    pairs.sort_by(|a, b| name(a).encode_utf16().cmp(name(b).encode_utf16()));
    format!("{head}?{}", pairs.join("&"))
}

impl RecordedOpencodeApi {
    /// `api.json` of a case (`{"serviceRunning", "get"}`); an error names what is wrong with it.
    pub fn new(recorded: &Value, place: &str) -> Result<Self, String> {
        let Value::Object(recorded) = recorded else {
            return Err(format!("{place}: not an object"));
        };
        only_keys(place, recorded, &["serviceRunning", "get"])?;
        let Some(running) = recorded.get("serviceRunning").and_then(Value::as_bool) else {
            return Err(format!("{place}: \"serviceRunning\" is not a boolean"));
        };
        let api = Self {
            running,
            replies: Mutex::new(HashMap::new()),
            unrecorded: Mutex::new(Vec::new()),
        };
        // `recorded["get"] ?? {}`: a null is no replies, as a missing field is
        let empty = Value::Object(serde_json::Map::new());
        api.set(
            recorded
                .get("get")
                .filter(|replies| !replies.is_null())
                .unwrap_or(&empty),
            &format!("{place} get"),
        )?;
        Ok(api)
    }

    /// Replaces the replies of these paths from here on (the `api` step); the others stay.
    pub fn set(&self, replies: &Value, place: &str) -> Result<(), String> {
        validate_replies(place, replies)?;
        let mut parsed = HashMap::new();
        let mut keys = HashSet::new();
        for (path, reply) in replies.as_object().into_iter().flatten() {
            let key = reply_key(path);
            if !keys.insert(key.clone()) {
                return Err(format!(
                    "{place}: \"{path}\" names the same reply as another path"
                ));
            }
            // validate_replies has found a whole number; an HTTP status fits in a u16
            let status = reply["status"].as_f64().unwrap_or_default();
            if !(0.0..=f64::from(u16::MAX)).contains(&status) {
                return Err(format!(
                    "{place} \"{path}\": \"status\" is not an HTTP status"
                ));
            }
            parsed.insert(
                key,
                Reply {
                    status: status as u16,
                    body: reply["body"].clone(),
                },
            );
        }
        held(&self.replies).extend(parsed);
        Ok(())
    }

    /// The GETs asked for that the case did not record, kept even when the reader catches the
    /// failure.
    pub fn unrecorded(&self) -> Vec<String> {
        held(&self.unrecorded).clone()
    }
}

impl OpencodeApi for RecordedOpencodeApi {
    fn service_running(&self) -> Result<bool, OpencodeError> {
        Ok(self.running)
    }

    fn get(&self, path: &str) -> Result<Value, OpencodeError> {
        let key = reply_key(path);
        let Some(reply) = held(&self.replies).get(&key).cloned() else {
            let error = OpencodeError::Other(format!("api.json records no reply for GET {key}"));
            held(&self.unrecorded).push(key);
            return Err(error);
        };
        if (200..300).contains(&reply.status) {
            return Ok(reply.body);
        }
        let tag = reply
            .body
            .get("_tag")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        Err(OpencodeError::Http {
            status: reply.status,
            tag,
        })
    }
}

// Expected values: worked out by hand from `replyKey` and `RecordedOpencodeApi` of
// scripts/conversation-fixtures.ts.
#[test]
fn sorts_query_arguments_by_name() {
    assert_eq!(reply_key("/api/model"), "/api/model");
    assert_eq!(
        reply_key("/api/session/s/message?order=desc&limit=1"),
        "/api/session/s/message?limit=1&order=desc"
    );
    // one name's arguments keep their order, and empty ones are dropped
    assert_eq!(reply_key("/a?b=2&a=1&b=1"), "/a?a=1&b=2&b=1");
    assert_eq!(reply_key("/a?&b=1&&a=2&"), "/a?a=2&b=1");
    assert_eq!(reply_key("/a?"), "/a?");
}

#[test]
fn answers_the_recorded_replies() {
    let api = RecordedOpencodeApi::new(
        &serde_json::json!({
            "serviceRunning": false,
            "get": {
                "/x?order=desc&limit=1": { "status": 200, "body": { "data": 1 } },
                "/gone": { "status": 404, "body": { "_tag": "SessionNotFoundError" } },
                "/bad": { "status": 400, "body": null },
            },
        }),
        "api.json",
    )
    .expect("a valid api.json");
    assert_eq!(api.service_running(), Ok(false));
    assert_eq!(
        api.get("/x?limit=1&order=desc"),
        Ok(serde_json::json!({ "data": 1 }))
    );
    assert_eq!(
        api.get("/gone"),
        Err(OpencodeError::Http {
            status: 404,
            tag: "SessionNotFoundError".to_owned()
        })
    );
    assert_eq!(
        api.get("/bad"),
        Err(OpencodeError::Http {
            status: 400,
            tag: String::new()
        })
    );
    assert!(api.unrecorded().is_empty());

    // an `api` step replaces the replies it names, and keeps the others
    api.set(
        &serde_json::json!({ "/gone": { "status": 200, "body": "back" } }),
        "api",
    )
    .expect("valid replies");
    assert_eq!(api.get("/gone"), Ok(serde_json::json!("back")));
    assert_eq!(
        api.get("/x?order=desc&limit=1"),
        Ok(serde_json::json!({ "data": 1 }))
    );
}

#[test]
fn a_path_not_recorded_fails_naming_it() {
    let api = RecordedOpencodeApi::new(&serde_json::json!({ "serviceRunning": true }), "api.json")
        .expect("a valid api.json");
    assert_eq!(
        api.get("/y?order=desc&limit=1"),
        Err(OpencodeError::Other(
            "api.json records no reply for GET /y?limit=1&order=desc".to_owned()
        ))
    );
    assert_eq!(api.unrecorded(), vec!["/y?limit=1&order=desc".to_owned()]);
}

// `recorded["get"] ?? {}` of scripts/conversation-fixtures.ts:287: a null `get` records no reply.
#[test]
fn a_null_get_records_no_reply() {
    let api = RecordedOpencodeApi::new(
        &serde_json::json!({ "serviceRunning": false, "get": null }),
        "api.json",
    )
    .expect("a valid api.json");
    assert_eq!(api.service_running(), Ok(false));
    assert!(api.get("/api/model").is_err());
}

#[test]
fn refuses_an_api_json_out_of_format() {
    let refused = |recorded: Value| RecordedOpencodeApi::new(&recorded, "api.json").err();
    assert_eq!(
        refused(serde_json::json!([])),
        Some("api.json: not an object".to_owned())
    );
    assert_eq!(
        refused(serde_json::json!({ "get": {} })),
        Some("api.json: \"serviceRunning\" is not a boolean".to_owned())
    );
    assert!(refused(serde_json::json!({ "serviceRunning": true, "other": 1 })).is_some());
    assert_eq!(
        refused(serde_json::json!({
            "serviceRunning": true,
            "get": {
                "/a?x=1&y=2": { "status": 200, "body": 1 },
                "/a?y=2&x=1": { "status": 200, "body": 2 },
            },
        })),
        Some("api.json get: \"/a?y=2&x=1\" names the same reply as another path".to_owned())
    );
}
