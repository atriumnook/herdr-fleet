//! How `OpencodeConversations` reads a session through the CLI (`server/opencode-session.ts`): the
//! newest page kept between polls while nothing says the session changed, the walk back through
//! the message list, a staged revert, and the model list the context window comes from.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, MutexGuard, PoisonError};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use protocol::{ConversationMetadata, ConversationSource, ConversationTurn};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::messages::{
    OPENCODE_MESSAGE_ID, opencode_metadata, parse_opencode_messages, starts_turn, still_writing,
};
use super::time::InvalidTime;
use super::{OpencodeConversations, OpencodeError};
use crate::records::{MAX_TURNS, Row, record, text};
use crate::{ConversationError, Page, PageRequest, UnavailableReason};

/// Messages asked of the CLI at a time, and how many a page holds at least (it also reaches back
/// to a turn's start).
const FETCH_MESSAGES: usize = 100;
const PAGE_MESSAGES: usize = 100;
/// A page holds no more messages than this: a longer turn is cut into pages, its newest steps first.
const MAX_PAGE_MESSAGES: usize = 300;
/// The messages kept of a session between polls; a poll reads the newest hundred and joins them
/// to these.
pub(super) const KEEP_MESSAGES: usize = 400;
/// Reads one walk makes at most: a gap or a revert deeper than this is a changed history, not a
/// longer wait.
const MAX_FETCHES: usize = 15;
const SESSIONS_KEPT: usize = 4;
const MODEL_TTL_MS: i64 = 10 * 60_000;
const MODEL_RETRY_MS: i64 = 30_000;

/// `provider\0model` -> context window, from the service's model list.
pub(super) type Windows = HashMap<String, f64>;

/// What the reader keeps between reads, behind its lock.
#[derive(Default)]
pub(super) struct State {
    /// the newest messages of the sessions read last, the oldest read first
    pub(super) newest: Vec<(String, Arc<Newest>)>,
    models: Option<Models>,
}

struct Models {
    at: i64,
    windows: Arc<Windows>,
}

/// The newest messages of a session while it has not changed, and what says it has not.
pub(super) struct Newest {
    marker: String,
    pub(super) messages: Vec<Row>,
    end: bool,
    hidden: HashSet<String>,
    revert: Option<String>,
    writing: bool,
}

/// What the walk back through a session's messages found.
struct Walk {
    /// oldest first, what a staged revert hides left out
    messages: Vec<Row>,
    /// the session's first message is among them
    end: bool,
    since_found: bool,
    /// the staged revert's message was not reached: everything read is hidden by it
    still_hidden: bool,
    hidden: HashSet<String>,
    /// the newest message the service listed, hidden or not
    newest_id: String,
}

#[derive(Default)]
struct WalkFrom<'a> {
    before: Option<&'a str>,
    since: Option<&'a str>,
    revert: Option<&'a str>,
}

impl From<OpencodeError> for ConversationError {
    fn from(error: OpencodeError) -> Self {
        Self::Opencode(error)
    }
}

impl From<InvalidTime> for ConversationError {
    /// TypeScript's `toISOString` throws a RangeError, which the route answers as an internal
    /// error, as it does a failed CLI.
    fn from(_: InvalidTime) -> Self {
        Self::Opencode(OpencodeError::Other("Invalid time value".to_owned()))
    }
}

/// `encodeURIComponent`: every byte of the UTF-8 but `A-Z a-z 0-9 - _ . ! ~ * ' ( )`, escaped.
pub(super) fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The cursor the list itself hands out for "older than this message", which the service reads
/// back: `{id, order, direction}` as JSON, in base64url without padding. A message id holds no
/// character JSON escapes (`OPENCODE_MESSAGE_ID`), so the text is TypeScript's `JSON.stringify`.
pub(super) fn before_cursor(id: &str) -> String {
    URL_SAFE_NO_PAD.encode(format!(
        r#"{{"id":"{id}","order":"desc","direction":"next"}}"#
    ))
}

/// `message.id === id` of JavaScript, for an id that is a string.
fn has_id(message: &Row, id: &str) -> bool {
    text(message, "id") == Some(id)
}

/// `a === b` of JavaScript for two JSON values: an object or an array is never the same as another.
fn strictly_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::Object(_) | Value::Array(_)), _) => false,
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// What a change to the session can touch: when it was written, when it went idle, what it used,
/// where it was reverted to. Only compared with the marker before, never shown: each field as
/// JSON stands in for TypeScript's `Array.prototype.join`.
fn marks(session: &Row) -> String {
    let time = record(session.get("time"));
    let tokens = record(session.get("tokens"));
    [
        time.get("updated"),
        time.get("idle"),
        tokens.get("input"),
        tokens.get("output"),
        session.get("cost"),
        record(session.get("revert")).get("messageID"),
    ]
    .map(|value| serde_json::to_string(&value).expect("a JSON value as text"))
    .join(":")
}

/// The bytes of a pasted image are not kept: the chat asks for one by ref (`image`), and a page of
/// them is megabytes.
fn slim(value: Value) -> Row {
    let Value::Object(mut message) = value else {
        return Row::new();
    };
    if text(&message, "type") == Some("user")
        && let Some(Value::Array(files)) = message.get_mut("files")
    {
        for file in files.iter_mut() {
            if !file.is_object() {
                *file = Value::Object(Row::new());
            }
            if let Value::Object(file) = file {
                file.insert("data".to_owned(), Value::String(String::new()));
            }
        }
    }
    message
}

/// The `data` array of a body, else none.
fn data(body: &Value) -> &[Value] {
    match record(Some(body)).get("data") {
        Some(Value::Array(rows)) => rows,
        _ => &[],
    }
}

/// The `data` array of a body, taken out of it; else none.
fn take_data(body: &mut Value) -> Vec<Value> {
    match body.get_mut("data").map(Value::take) {
        Some(Value::Array(rows)) => rows,
        _ => Vec::new(),
    }
}

/// Where a page starts in `messages`: at `since`; else at the first turn's start, and no more than
/// a page back.
fn start_of(messages: &[Row], end: bool, since: Option<usize>) -> usize {
    if let Some(since) = since {
        return since;
    }
    let mut start = if end {
        0
    } else {
        messages.iter().position(starts_turn).unwrap_or(0)
    };
    let floor = messages.len().saturating_sub(MAX_PAGE_MESSAGES);
    if messages.len() > MAX_PAGE_MESSAGES && start < floor {
        start = messages
            .iter()
            .enumerate()
            .position(|(index, message)| index >= floor && starts_turn(message))
            .unwrap_or(floor);
    }
    start
}

/// The fields of the version's hash that are not the page's own.
#[derive(Serialize)]
struct Answered<'a> {
    turns: &'a [ConversationTurn],
    cursor: Option<&'a str>,
    metadata: &'a ConversationMetadata,
}

impl OpencodeConversations {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn require_service(&self) -> Result<(), ConversationError> {
        if self.api.service_running()? {
            Ok(())
        } else {
            Err(ConversationError::ConversationUnavailable(
                UnavailableReason::OpencodeServiceStopped,
            ))
        }
    }

    /// A message of the session; `None` when the service has no such message.
    pub(super) fn message(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<Option<Row>, ConversationError> {
        self.require_service()?;
        let path = format!(
            "/api/session/{}/message/{}",
            encode_uri_component(session_id),
            encode_uri_component(message_id)
        );
        match self.api.get(&path) {
            Ok(body) => Ok(Some(record(record(Some(&body)).get("data")).clone())),
            Err(OpencodeError::Http { status: 404, .. }) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// What the CLI says of the session itself; `None` when there is no such session.
    fn session(&self, session_id: &str) -> Result<Option<Row>, ConversationError> {
        match self.api.get(&format!(
            "/api/session/{}",
            encode_uri_component(session_id)
        )) {
            Ok(body) => Ok(Some(record(record(Some(&body)).get("data")).clone())),
            Err(OpencodeError::Http { status: 404, .. }) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// The newest message's id. A shell command, a compaction, a skill and a synthetic message are
    /// written without the session's `time.updated` moving, so the session alone does not say
    /// that the messages changed; a new message does change this.
    fn newest_id(&self, session_id: &str) -> Result<String, ConversationError> {
        let body = self.api.get(&format!(
            "/api/session/{}/message?limit=1&order=desc",
            encode_uri_component(session_id)
        ))?;
        let first = record(data(&body).first());
        Ok(text(first, "id").unwrap_or_default().to_owned())
    }

    /// The context windows of the service's model list; empty when it cannot be read. Kept ten
    /// minutes, or thirty seconds when it came back empty, by the clock the reader was given
    /// (TypeScript reads `Date.now()` here).
    fn windows(&self) -> Arc<Windows> {
        let now = (self.now)();
        if let Some(models) = &self.state().models {
            let ttl = if models.windows.is_empty() {
                MODEL_RETRY_MS
            } else {
                MODEL_TTL_MS
            };
            if now - models.at < ttl {
                return Arc::clone(&models.windows);
            }
        }
        let mut windows = Windows::new();
        // no window is drawn rather than a guessed one
        if let Ok(body) = self.api.get("/api/model") {
            for value in data(&body) {
                let model = record(Some(value));
                let context = record(model.get("limit")).get("context");
                let (Some(context), Some(provider)) =
                    (context.and_then(Value::as_f64), text(model, "providerID"))
                else {
                    continue;
                };
                for id in [text(model, "modelID"), text(model, "id")]
                    .into_iter()
                    .flatten()
                {
                    windows.insert(format!("{provider}\0{id}"), context);
                }
            }
        }
        let windows = Arc::new(windows);
        self.state().models = Some(Models {
            at: (self.now)(),
            windows: Arc::clone(&windows),
        });
        windows
    }

    pub(super) fn read(
        &self,
        session_id: &str,
        working: bool,
        page: &PageRequest,
    ) -> Result<Page, ConversationError> {
        self.require_service()?;
        let cursors = [&page.before, &page.since, &page.from];
        let anchored = cursors.iter().any(|cursor| cursor.is_some());
        if cursors
            .iter()
            .filter_map(|cursor| cursor.as_deref())
            .any(|cursor| !OPENCODE_MESSAGE_ID.is_match(cursor))
        {
            return Err(ConversationError::HistoryChanged);
        }
        let Some(session) = self.session(session_id)? else {
            return Err(if anchored {
                ConversationError::HistoryChanged
            } else {
                ConversationError::ConversationUnavailable(
                    UnavailableReason::OpencodeSessionMissing,
                )
            });
        };
        let revert = text(record(session.get("revert")), "messageID").map(str::to_owned);

        let held: Arc<Newest>;
        let walked: Vec<Row>;
        let (messages, start, end): (&[Row], usize, bool) = if let Some(before) = &page.before {
            if page.since.as_ref() == Some(before) {
                let metadata = ConversationMetadata {
                    model: None,
                    reasoning_effort: None,
                    context: None,
                };
                return Ok(self.answer(session_id, page, Vec::new(), page.since.clone(), metadata));
            }
            // a `since` the service does not have is a changed history at once, not after the
            // whole walk
            if let Some(since) = &page.since
                && self.message(session_id, since)?.is_none()
            {
                return Err(ConversationError::HistoryChanged);
            }
            let walk = self.walk(
                session_id,
                WalkFrom {
                    before: Some(before),
                    since: page.since.as_deref(),
                    revert: revert.as_deref(),
                },
            )?;
            if page.since.is_some() && !walk.since_found {
                return Err(ConversationError::HistoryChanged);
            }
            let since = page.since.as_deref().and_then(|since| {
                walk.messages
                    .iter()
                    .position(|message| has_id(message, since))
            });
            let start = start_of(&walk.messages, walk.end, since);
            // the anchor's own messages are not among them: an anchor the service no longer has
            // (a committed revert) answers an empty page, the same as the first message of a
            // session
            if walk.messages.is_empty() && self.message(session_id, before)?.is_none() {
                return Err(ConversationError::HistoryChanged);
            }
            walked = walk.messages;
            (&walked, start, walk.end)
        } else {
            held = self.newest_of(session_id, &session, revert, working)?;
            let mut start = start_of(&held.messages, held.end, None);
            if let Some(from) = &page.from {
                match held
                    .messages
                    .iter()
                    .position(|message| has_id(message, from))
                {
                    Some(found) => start = start.max(found),
                    // not in the newest page: the page has moved past it, unless the service has
                    // lost it
                    None => {
                        if held.hidden.contains(from.as_str())
                            || self.message(session_id, from)?.is_none()
                        {
                            return Err(ConversationError::HistoryChanged);
                        }
                    }
                }
            }
            (&held.messages, start, held.end)
        };

        let parsed = parse_opencode_messages(&messages[start..])?;
        let total = parsed.turns.len();
        let dropped = total.saturating_sub(MAX_TURNS);
        let turns = parsed.turns[dropped..].to_vec();
        // the beginning of the session: nothing before the first message, and no turn dropped
        let at_beginning = end && start == 0 && dropped == 0;
        let cursor = if at_beginning {
            None
        } else {
            parsed.first_ids.get(dropped).cloned()
        };
        let windows = if page.before.is_none() {
            self.windows()
        } else {
            Arc::default()
        };
        let metadata = opencode_metadata(messages, |provider, model| {
            windows.get(&format!("{provider}\0{model}")).copied()
        });
        Ok(self.answer(session_id, page, turns, cursor, metadata))
    }

    /// The newest messages: kept while nothing says the session changed; else the newest page read
    /// and joined to the older messages already held (a long turn is not walked again from its
    /// start), or walked afresh when the two do not meet.
    fn newest_of(
        &self,
        session_id: &str,
        session: &Row,
        revert: Option<String>,
        working: bool,
    ) -> Result<Arc<Newest>, ConversationError> {
        let base = marks(session);
        let cached = self
            .state()
            .newest
            .iter()
            .find(|(id, _)| id == session_id)
            .map(|(_, entry)| Arc::clone(entry));
        if let Some(cached) = &cached
            && !working
            && !cached.writing
            && cached.revert == revert
            && cached.marker == format!("{base}:{}", self.newest_id(session_id)?)
        {
            return Ok(Arc::clone(cached));
        }
        let entry = Arc::new(self.refresh(session_id, &base, revert, cached.as_deref())?);
        let mut state = self.state();
        state.newest.retain(|(id, _)| id != session_id);
        state
            .newest
            .push((session_id.to_owned(), Arc::clone(&entry)));
        if state.newest.len() > SESSIONS_KEPT {
            state.newest.remove(0);
        }
        Ok(entry)
    }

    fn refresh(
        &self,
        session_id: &str,
        base: &str,
        revert: Option<String>,
        cached: Option<&Newest>,
    ) -> Result<Newest, ConversationError> {
        let settle =
            |mut messages: Vec<Row>, end: bool, hidden: HashSet<String>, newest_id: &str| {
                let writing = still_writing(&messages, (self.now)());
                let kept = messages.len() > KEEP_MESSAGES;
                if kept {
                    messages.drain(..messages.len() - KEEP_MESSAGES);
                }
                Newest {
                    marker: format!("{base}:{newest_id}"),
                    messages,
                    end: end && !kept,
                    hidden,
                    revert: revert.clone(),
                    writing,
                }
            };
        if let Some(cached) = cached
            && revert.is_none()
            && cached.revert.is_none()
        {
            let mut body = self.api.get(&format!(
                "/api/session/{}/message?limit={FETCH_MESSAGES}&order=desc",
                encode_uri_component(session_id)
            ))?;
            let read: Vec<Row> = take_data(&mut body).into_iter().rev().map(slim).collect();
            let newest_id = read
                .last()
                .and_then(|message| text(message, "id"))
                .unwrap_or_default()
                .to_owned();
            if read.len() < FETCH_MESSAGES {
                return Ok(settle(read, true, HashSet::new(), &newest_id));
            }
            let first = read[0].get("id");
            if let Some(join) = cached
                .messages
                .iter()
                .position(|message| strictly_equal(message.get("id"), first))
            {
                let mut joined = cached.messages[..join].to_vec();
                joined.extend(read);
                return Ok(settle(joined, cached.end, HashSet::new(), &newest_id));
            }
        }
        let walk = self.walk(
            session_id,
            WalkFrom {
                revert: revert.as_deref(),
                ..WalkFrom::default()
            },
        )?;
        if walk.still_hidden && !walk.end {
            return Err(ConversationError::ConversationUnavailable(
                UnavailableReason::OpencodeRevertTooDeep,
            ));
        }
        Ok(settle(
            walk.messages,
            walk.end,
            walk.hidden,
            &walk.newest_id,
        ))
    }

    fn answer(
        &self,
        session_id: &str,
        page: &PageRequest,
        turns: Vec<ConversationTurn>,
        cursor: Option<String>,
        metadata: ConversationMetadata,
    ) -> Page {
        // the page as asked: TypeScript hashes `JSON.stringify(page)` with the cursors given
        let mut asked = serde_json::Map::new();
        for (key, cursor) in [
            ("before", &page.before),
            ("since", &page.since),
            ("from", &page.from),
        ] {
            if let Some(cursor) = cursor {
                asked.insert(key.to_owned(), Value::String(cursor.clone()));
            }
        }
        let answered = serde_json::to_string(&Answered {
            turns: &turns,
            cursor: cursor.as_deref(),
            metadata: &metadata,
        })
        .expect("a page as JSON");
        let digest = Sha256::digest(
            format!(
                "{}\0{session_id}\0{}\0{answered}",
                self.process,
                Value::Object(asked)
            )
            .as_bytes(),
        );
        let mut version = URL_SAFE_NO_PAD.encode(digest);
        version.truncate(22);
        Page {
            source: ConversationSource::OpencodeSession,
            turns,
            metadata,
            cursor,
            abandoned: None,
            history_id: session_id.to_owned(),
            version,
        }
    }

    /// Messages from the newest (or from the ones older than `before`) back until a page's worth
    /// with a turn's start among them, or the session begins. With `since` it goes on until that
    /// message is reached: the page between is what the chat is missing. The list is newest first
    /// and its cursor names a message, not a place, so a session that grows while this reads does
    /// not shift the pages.
    fn walk(&self, session_id: &str, from: WalkFrom<'_>) -> Result<Walk, ConversationError> {
        let mut collected: Vec<Row> = Vec::new();
        let mut hidden = HashSet::new();
        // the newest page starts above a staged revert's message and drops everything down to it
        let mut reverting = from.before.is_none() && from.revert.is_some();
        let mut cursor = None;
        if let Some(before) = from.before {
            cursor = Some(before_cursor(before));
            if let Some(revert) = from.revert {
                self.require_visible(session_id, revert, before)?;
            }
        }
        let mut since_found = false;
        let mut end = false;
        let mut newest_id = String::new();
        let mut fetched = 1;
        loop {
            let path = format!(
                "/api/session/{}/message?limit={FETCH_MESSAGES}{}",
                encode_uri_component(session_id),
                match &cursor {
                    None => "&order=desc".to_owned(),
                    Some(cursor) => format!("&cursor={}", encode_uri_component(cursor)),
                }
            );
            let mut body = match self.api.get(&path) {
                Ok(body) => body,
                // the service refuses a cursor it cannot read
                Err(OpencodeError::Http { status: 400, .. }) if cursor.is_some() => {
                    return Err(ConversationError::HistoryChanged);
                }
                Err(error) => return Err(error.into()),
            };
            let next = text(record(record(Some(&body)).get("cursor")), "next").map(str::to_owned);
            let rows = take_data(&mut body);
            let listed = rows.len();
            if fetched == 1 && cursor.is_none() {
                newest_id = text(record(rows.first()), "id")
                    .unwrap_or_default()
                    .to_owned();
            }
            for value in rows {
                let message = slim(value);
                let id = text(&message, "id").unwrap_or_default();
                if reverting {
                    if from.revert == Some(id) {
                        reverting = false;
                    }
                    hidden.insert(id.to_owned());
                    continue;
                }
                if from.since == Some(id) {
                    since_found = true;
                }
                collected.push(message);
            }
            // fewer than asked for is the last page
            let Some(next) = next.filter(|_| listed >= FETCH_MESSAGES) else {
                end = true;
                break;
            };
            if from.since.is_some() {
                if since_found {
                    break;
                }
            } else if collected.len() >= MAX_PAGE_MESSAGES
                || (collected.len() >= PAGE_MESSAGES && collected.iter().any(starts_turn))
            {
                break;
            }
            if fetched >= MAX_FETCHES {
                break;
            }
            cursor = Some(next);
            fetched += 1;
        }
        collected.reverse();
        Ok(Walk {
            messages: collected,
            end,
            since_found,
            still_hidden: reverting,
            hidden,
            newest_id,
        })
    }

    /// A staged revert hides its own message and every later one: an anchor among them is gone
    /// from the history. Which is later is read from the times the service stamps, which only grow
    /// along the list; two stamped alike are taken as not hidden, and the next read corrects it.
    /// TypeScript asks for the two messages at once; a synchronous port asks one after the other
    /// (ADR 0192-phase-2-split, "OpenCode").
    fn require_visible(
        &self,
        session_id: &str,
        revert: &str,
        anchor: &str,
    ) -> Result<(), ConversationError> {
        if anchor == revert {
            return Err(ConversationError::HistoryChanged);
        }
        let reverted = self.message(session_id, revert)?;
        let Some(held) = self.message(session_id, anchor)? else {
            return Err(ConversationError::HistoryChanged);
        };
        let Some(reverted) = reverted else {
            return Ok(());
        };
        let created = |message: &Row| {
            record(message.get("time"))
                .get("created")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
        };
        if created(&held) > created(&reverted) {
            return Err(ConversationError::HistoryChanged);
        }
        Ok(())
    }
}
