//! herdr's event subscription (`subscribeEvents` in `server/herdr/client.ts`) and the port the
//! pane-status subscription reads herdr through (`StatusCollectorDeps` in `server/collector.ts`).
//!
//! Unlike an ordinary call, `events.subscribe` keeps the connection open and streams frames until
//! the caller drops the stream.

use crate::client::{Herdr, connect, parse_frame, request_line, truthy};
use crate::error::HerdrError;
use crate::lines::LineReader;
use herdr_api::{PaneInfo, Subscription};
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

/// How many items a subscription holds that its owner has not read. A stalled owner stops the
/// reader, herdr's socket buffer fills, and herdr closes the subscription (`events_lost`), which
/// the pane-status subscription recovers from; Bun reads nothing while its handler runs either.
const BUFFERED_ITEMS: usize = 256;

/// A frame herdr streams, as it sends it: status frames are flat
/// (`{event: "pane.agent_status_changed", data: {pane_id, agent_status, …}}`), structure frames
/// carry a snake_case `data.type`, and neither always matches the schema's event envelope.
#[derive(Debug, Clone, PartialEq)]
pub struct EventFrame {
    /// The frame's `event`, when it is a string.
    pub event: Option<String>,
    /// The frame's `data`; `Null` when the frame has none.
    pub data: Value,
}

impl EventFrame {
    fn from_value(frame: &Value) -> Self {
        Self {
            event: frame
                .get("event")
                .and_then(Value::as_str)
                .map(str::to_owned),
            data: frame.get("data").cloned().unwrap_or(Value::Null),
        }
    }
}

/// What a subscription tells, in the order herdr sent it.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamItem {
    /// herdr's first `subscription_started`: the subscription listens from here on.
    Started,
    /// Any other frame, before or after the start.
    Event(EventFrame),
    /// herdr's error frame (`events_lost` before it closes a subscription that fell behind), or
    /// the socket's failure (`connect_failed`, `socket_error`). The stream goes on until it ends.
    Error(HerdrError),
}

/// The items of one subscription. It ends ([`EventStream::next`] returns `None`) when herdr
/// closes the connection or it could not be opened, and nothing reconnects: the caller does.
/// Dropping it closes the connection, and items not read yet are dropped with it: they belong to
/// a subscription the caller replaced.
#[derive(Debug)]
pub struct EventStream {
    receiver: mpsc::Receiver<StreamItem>,
}

impl EventStream {
    /// A connected pair: the real subscription's reader holds the sender, and so does a fake
    /// [`EventSource`].
    pub fn channel() -> (EventSender, EventStream) {
        let (sender, receiver) = mpsc::channel(BUFFERED_ITEMS);
        (EventSender { sender }, EventStream { receiver })
    }

    /// The next item; `None` once the subscription ended. Cancel-safe: in `tokio::select!`, an
    /// item is never lost when another branch wins.
    pub async fn next(&mut self) -> Option<StreamItem> {
        self.receiver.recv().await
    }
}

/// The feeding end of [`EventStream::channel`]. Dropping it ends the stream once its items are
/// read (what herdr's close looks like to the owner).
#[derive(Debug, Clone)]
pub struct EventSender {
    sender: mpsc::Sender<StreamItem>,
}

impl EventSender {
    /// Hands `item` to the stream, waiting while the stream holds as many items as it can;
    /// `false` once the stream was dropped.
    pub async fn send(&self, item: StreamItem) -> bool {
        self.sender.send(item).await.is_ok()
    }

    /// Whether the stream was dropped (the TypeScript fake's `closedByCollector`).
    pub fn is_closed(&self) -> bool {
        self.sender.is_closed()
    }

    /// Resolves once the stream was dropped.
    async fn closed(&self) {
        self.sender.closed().await;
    }
}

/// The future of [`EventSource::snapshot`]: `'static`, so that its owner can keep it in flight
/// while it handles events.
pub type SnapshotFuture =
    Pin<Box<dyn Future<Output = Result<Vec<PaneInfo>, HerdrError>> + Send + 'static>>;

/// Where pane status comes from: herdr's event subscription and its session snapshot.
/// [`Herdr`] is the real one; tests hand a fake built on [`EventStream::channel`].
pub trait EventSource: Send + Sync + 'static {
    /// Subscribes to `subscriptions` on a connection of its own. It returns at once and connects
    /// in the background, so it must be called within a Tokio runtime; a connect that fails is
    /// told as `connect_failed`, then the stream ends.
    fn subscribe(&self, subscriptions: Vec<Subscription>) -> EventStream;

    /// Every pane of the session now (`session.snapshot`).
    fn snapshot(&self) -> SnapshotFuture;
}

impl EventSource for Herdr {
    fn subscribe(&self, subscriptions: Vec<Subscription>) -> EventStream {
        let (sender, stream) = EventStream::channel();
        let herdr = self.clone();
        tokio::spawn(async move {
            tokio::select! {
                () = stream_items(&herdr, subscriptions, &sender) => {}
                // the owner dropped the stream: the socket closes with this task
                () = sender.closed() => {}
            }
        });
        stream
    }

    fn snapshot(&self) -> SnapshotFuture {
        let herdr = self.clone();
        Box::pin(async move {
            let answer = herdr
                .call::<herdr_api::methods::SessionSnapshot>(herdr_api::EmptyParams {})
                .await?;
            Ok(answer.snapshot.panes)
        })
    }
}

async fn stream_items(herdr: &Herdr, subscriptions: Vec<Subscription>, sender: &EventSender) {
    let mut socket = match connect(herdr.socket_path()).await {
        Ok(socket) => socket,
        Err(error) => {
            // a connect that never opened never closes either: report it, then end, or a
            // subscriber that retries on the end waits forever (the status collector while
            // herdr restarts)
            let error = HerdrError::ConnectFailed(error.to_string());
            sender.send(StreamItem::Error(error)).await;
            return;
        }
    };
    let request = request_line(
        <herdr_api::methods::EventsSubscribe as herdr_api::Method>::NAME,
        &herdr_api::EventsSubscribeParams { subscriptions },
    );
    if let Err(error) = socket.write_all(request.as_bytes()).await {
        let error = HerdrError::SocketError(error.to_string());
        sender.send(StreamItem::Error(error)).await;
        return;
    }
    let mut lines = LineReader::default();
    let mut started = false;
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let read = match socket.read(&mut chunk).await {
            Ok(0) => return,
            Ok(read) => read,
            Err(error) => {
                let error = HerdrError::SocketError(error.to_string());
                sender.send(StreamItem::Error(error)).await;
                return;
            }
        };
        for line in lines.push(&chunk[..read]) {
            let Some(item) = item_of(&line, &mut started) else {
                continue;
            };
            if !sender.send(item).await {
                return;
            }
        }
    }
}

/// What a line tells; `None` for a line that is not JSON.
fn item_of(line: &str, started: &mut bool) -> Option<StreamItem> {
    let frame = parse_frame(line).ok()?;
    if let Some(error) = frame.get("error").filter(|error| truthy(error)) {
        return Some(StreamItem::Error(HerdrError::from_frame(
            error,
            "subscription failed",
        )));
    }
    let kind = frame
        .get("result")
        .and_then(|result| result.get("type"))
        .and_then(Value::as_str);
    if !*started && kind == Some("subscription_started") {
        *started = true;
        return Some(StreamItem::Started);
    }
    Some(StreamItem::Event(EventFrame::from_value(&frame)))
}
