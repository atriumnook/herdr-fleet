//! The task behind [`super::start`]: `startStatusCollector` in `server/collector.ts`, one state
//! machine on one Tokio task. Each of TypeScript's callbacks (a subscription's event, start or
//! close, a timer, a snapshot's answer) is one wake of [`Collector::run`]; the reconcile, an
//! `async` function there, is [`Reconcile`]'s states here, so that the connections keep being
//! read while its snapshot or its replay's wait is on its way, as they are in Bun.
//!
//! What it copes with (verified against herdr protocol 22, the header of `server/collector.ts`):
//! - `pane.agent_status_changed` needs a pane_id, and one connection carries any number of
//!   per-pane subscriptions: every pane shares one status connection.
//! - A second `events.subscribe` on an open connection is ignored: when the pane set changes,
//!   the status connection is opened again with the whole set.
//! - `pane.created` / `pane.closed` / `pane.exited` subscribe globally and drive both the pane
//!   set and the structure changes; `pane.focused` subscribes globally on its own connection.
//! - herdr closes a subscription that fell behind (after `events_lost`, which a full socket
//!   buffer never delivers): every connection reopens on the close alone, and what it missed is
//!   read back from a snapshot taken once the new subscription started (herdr's order).
//! - A status that changed while no subscription listened for the pane (the set was being
//!   reopened, herdr refused a batch for a pane that had gone, or the subscription had only just
//!   started) is never sent again: the first snapshot after the new subscription started is
//!   measured against each pane's status as last told, and a difference is told as that event
//!   (`replay`). An outage of unknown length (`events_lost`, a herdr that could not be reached)
//!   is corrected without alerts (`on_resync`).

use super::frames::{self, Structure};
use super::{PaneStatusHandler, PaneStatusOptions, Replay};
use crate::error::HerdrError;
use crate::events::{EventSource, EventStream, SnapshotFuture, StreamItem};
use herdr_api::{AgentStatus, PaneInfo, Subscription, SubscriptionPaneAgentStatusChanged};
use std::collections::{HashMap, HashSet};
use std::future::pending;
use std::mem;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::time::{Instant, Interval, MissedTickBehavior, Sleep, interval_at, sleep};

/// A pane's status as last heard, in an event or a snapshot.
#[derive(Debug, Clone)]
struct Heard {
    status: AgentStatus,
    agent: Option<String>,
}

/// The open status connection (one `subscribeEvents` of `openStatusSubscription`).
struct StatusConnection {
    stream: EventStream,
    /// herdr's `subscription_started` came
    started: bool,
    /// herdr answered the batch with an error of its own (a pane that had gone), not a
    /// connection that failed
    refused: bool,
}

/// A subscription that reopens itself when herdr closes it (`resilientSubscription`): at once,
/// then backing off while it keeps closing before it starts (herdr restarting).
struct Resilient {
    subscriptions: Vec<Subscription>,
    stream: Option<EventStream>,
    /// whether the open connection is a retry: its start means events may have been missed
    retry: bool,
    reopen: Option<Pin<Box<Sleep>>>,
    delay: Duration,
    attempted: bool,
}

enum ResilientWake {
    Item(Option<StreamItem>),
    Reopen,
}

impl Resilient {
    fn new(subscriptions: Vec<Subscription>, options: &PaneStatusOptions) -> Self {
        Self {
            subscriptions,
            stream: None,
            retry: false,
            reopen: None,
            delay: options.reconnect_min,
            attempted: false,
        }
    }

    fn open(&mut self, source: &dyn EventSource) {
        self.reopen = None;
        self.retry = self.attempted;
        self.attempted = true;
        self.stream = Some(source.subscribe(self.subscriptions.clone()));
    }

    /// The connection started: `true` when it was a retry (`onRestart`).
    fn started(&mut self, options: &PaneStatusOptions) -> bool {
        self.delay = options.reconnect_min;
        self.retry
    }

    fn closed(&mut self, options: &PaneStatusOptions) {
        self.stream = None;
        self.reopen = Some(Box::pin(sleep(self.delay)));
        self.delay = (self.delay * 2).min(options.reconnect_max);
    }

    async fn wake(&mut self) -> ResilientWake {
        if let Some(stream) = &mut self.stream {
            return ResilientWake::Item(stream.next().await);
        }
        match &mut self.reopen {
            Some(reopen) => {
                reopen.as_mut().await;
                ResilientWake::Reopen
            }
            None => pending().await,
        }
    }
}

/// What a reconcile was asked with (the locals of `reconcile` before its `await`).
#[derive(Debug, Clone, Copy)]
struct Asked {
    resync: Option<u64>,
    replay: Option<u64>,
    /// the count of events when the snapshot was asked for
    at: u64,
}

/// What a reconcile does once its replays are told.
struct Finish {
    asked_at: u64,
    pane_ids: Vec<String>,
    same_set: bool,
}

/// Where the reconcile is (TypeScript's `reconciling` and the point its `async` body waits at).
enum Reconcile {
    Idle,
    /// Reconciling, with nothing to wait on (between two steps).
    Busy,
    Snapshot {
        answer: SnapshotFuture,
        asked: Asked,
    },
    /// The wait before a replay, or before a live connection closes for another pane set.
    Settle {
        until: Pin<Box<Sleep>>,
        generation: u64,
        replays: Vec<PaneInfo>,
        finish: Finish,
    },
}

enum ReconcileWake {
    Answered(Result<Vec<PaneInfo>, HerdrError>),
    Settled,
}

impl Reconcile {
    async fn wake(&mut self) -> ReconcileWake {
        match self {
            Self::Snapshot { answer, .. } => ReconcileWake::Answered(answer.as_mut().await),
            Self::Settle { until, .. } => {
                until.as_mut().await;
                ReconcileWake::Settled
            }
            Self::Idle | Self::Busy => pending().await,
        }
    }
}

/// Connection items [`Collector::run`] reads in a row before one wake takes any ready branch at
/// random: one full buffer of a connection (`BUFFERED_ITEMS` in `events.rs`) is read in order, but
/// a connection that never runs dry cannot keep the other connections, the timers or a snapshot's
/// answer waiting (Bun turns to timers and other sockets between reads of one socket).
const CONNECTION_BURST: u32 = 256;

enum Wake {
    Status(Option<StreamItem>),
    Lifecycle(ResilientWake),
    Focus(ResilientWake),
    Reconcile(ReconcileWake),
    Timer,
    Backstop,
}

pub(super) struct Collector {
    source: Arc<dyn EventSource>,
    handler: Arc<dyn PaneStatusHandler>,
    options: PaneStatusOptions,
    stopped: Arc<AtomicBool>,
    status: Option<StatusConnection>,
    subscribed: HashSet<String>,
    /// the open status subscription has started: until then it has heard nothing
    status_started: bool,
    /// each status subscription's number: a resync or replay counts only for the one still open
    generation: u64,
    /// status events were lost: the next snapshot after a new subscription starts resyncs
    recovering: bool,
    /// the subscription that started while recovering: the next reconcile's snapshot resyncs
    resync_for: Option<u64>,
    /// the status subscription was closed for another pane set, or refused: a change since then
    /// may have had no event
    gap: bool,
    /// the subscription that started after such a gap: the next reconcile's snapshot replays
    replay_for: Option<u64>,
    /// counts status, exit, close and focus events; each pane keeps the count of its latest
    events: u64,
    last_event_of: HashMap<String, u64>,
    /// what the snapshot after a gap is measured against
    heard: HashMap<String, Heard>,
    /// when a pane last ended or closed: a snapshot asked for before that is no news of it
    acted_on: HashMap<String, u64>,
    /// when a pane last came to the front: no replay from a snapshot asked for before that; a
    /// resync still corrects it
    focused_at: HashMap<String, u64>,
    reconcile: Reconcile,
    reconcile_pending: bool,
    /// the debounce, or the retry of a failed snapshot
    reconcile_timer: Option<Pin<Box<Sleep>>>,
    lifecycle: Resilient,
    focus: Option<Resilient>,
}

impl Collector {
    /// Opens the connections and asks for the first snapshot, as `startStatusCollector` does
    /// before it returns.
    pub(super) fn new(
        source: Arc<dyn EventSource>,
        handler: Arc<dyn PaneStatusHandler>,
        options: PaneStatusOptions,
        stopped: Arc<AtomicBool>,
    ) -> Self {
        let structure = vec![
            Subscription::PaneCreated,
            Subscription::PaneClosed,
            Subscription::PaneExited,
        ];
        let mut collector = Self {
            lifecycle: Resilient::new(structure, &options),
            // its own connection: a focus type an older herdr refuses must not cost pane exits
            focus: options
                .focus
                .then(|| Resilient::new(vec![Subscription::PaneFocused], &options)),
            source,
            handler,
            options,
            stopped,
            status: None,
            subscribed: HashSet::new(),
            status_started: false,
            generation: 0,
            recovering: false,
            resync_for: None,
            gap: false,
            replay_for: None,
            events: 0,
            last_event_of: HashMap::new(),
            heard: HashMap::new(),
            acted_on: HashMap::new(),
            focused_at: HashMap::new(),
            reconcile: Reconcile::Idle,
            reconcile_pending: false,
            reconcile_timer: None,
        };
        collector.lifecycle.open(collector.source.as_ref());
        if let Some(focus) = &mut collector.focus {
            focus.open(collector.source.as_ref());
        }
        collector.reconcile();
        collector
    }

    fn stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    pub(super) async fn run(mut self) {
        let period = self.options.backstop;
        let mut backstop: Interval = interval_at(Instant::now() + period, period);
        backstop.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut burst = 0;
        loop {
            if self.stopped() {
                return;
            }
            macro_rules! next_wake {
                ($($biased:ident)?) => {
                    tokio::select! {
                        $($biased;)?
                        item = status_item(&mut self.status) => Wake::Status(item),
                        wake = self.lifecycle.wake() => Wake::Lifecycle(wake),
                        wake = focus_wake(&mut self.focus) => Wake::Focus(wake),
                        wake = self.reconcile.wake() => Wake::Reconcile(wake),
                        () = fire(&mut self.reconcile_timer) => Wake::Timer,
                        _ = backstop.tick() => Wake::Backstop,
                    }
                };
            }
            // Connections first: an event read in the same turn as a snapshot's answer came
            // before it, as Bun runs the event's callback before the answer's continuation. Past
            // CONNECTION_BURST connection items in a row, any ready branch may go first.
            let wake = if burst < CONNECTION_BURST {
                next_wake!(biased)
            } else {
                next_wake!()
            };
            burst = match wake {
                Wake::Status(_) | Wake::Lifecycle(_) | Wake::Focus(_) => burst + 1,
                Wake::Reconcile(_) | Wake::Timer | Wake::Backstop => 0,
            };
            if self.stopped() {
                return;
            }
            match wake {
                Wake::Status(item) => self.on_status_item(item),
                Wake::Lifecycle(wake) => self.on_lifecycle(wake),
                Wake::Focus(wake) => self.on_focus(wake),
                Wake::Reconcile(ReconcileWake::Answered(answer)) => self.answered(answer),
                Wake::Reconcile(ReconcileWake::Settled) => self.settled(),
                Wake::Timer => {
                    self.reconcile_timer = None;
                    self.reconcile();
                }
                Wake::Backstop => self.reconcile(),
            }
        }
    }

    // --- the status connection ---------------------------------------------------------------

    fn close_status(&mut self) {
        self.status_started = false;
        self.subscribed.clear();
        self.status = None;
    }

    fn open_status(&mut self, pane_ids: &[String]) {
        if self.stopped() || pane_ids.is_empty() {
            return;
        }
        self.subscribed = pane_ids.iter().cloned().collect();
        self.generation += 1;
        // between the snapshot that chose these panes and this subscription's start nothing listens
        self.gap = true;
        let subscriptions = pane_ids
            .iter()
            .map(|pane| {
                Subscription::PaneAgentStatusChanged(SubscriptionPaneAgentStatusChanged {
                    agent_status: None,
                    pane_id: pane.clone(),
                })
            })
            .collect();
        self.status = Some(StatusConnection {
            stream: self.source.subscribe(subscriptions),
            started: false,
            refused: false,
        });
    }

    fn on_status_item(&mut self, item: Option<StreamItem>) {
        match item {
            Some(StreamItem::Event(frame)) => {
                let Some(change) = frames::status(&frame) else {
                    return;
                };
                self.events += 1;
                self.last_event_of.insert(change.pane.clone(), self.events);
                self.heard.insert(
                    change.pane.clone(),
                    Heard {
                        status: change.status.clone(),
                        agent: change.agent.clone(),
                    },
                );
                self.handler
                    .on_status(&change.pane, change.status, change.agent.as_deref(), None);
            }
            // herdr's contract: subscribe, wait until it started, then snapshot. The snapshot
            // that chose these panes came before: one more closes the gap it leaves.
            Some(StreamItem::Started) => {
                if let Some(status) = &mut self.status {
                    status.started = true;
                }
                self.status_started = true;
                if self.recovering {
                    self.resync_for = Some(self.generation);
                } else if self.gap {
                    self.replay_for = Some(self.generation);
                }
                self.reconcile();
            }
            Some(StreamItem::Error(error)) => {
                if let Some(status) = &mut self.status {
                    status.refused =
                        !matches!(error.code(), "connect_failed" | "socket_error" | "timeout");
                }
                log_subscription_error(&error);
            }
            // herdr answers a bad batch (a pane that vanished between snapshot and subscribe)
            // with an error frame and closes the socket, and closes a subscriber that fell
            // behind (`events_lost`): the whole set is subscribed again from a fresh snapshot,
            // now rather than after the debounce, and what was missed is resynced. One herdr
            // refused before it started lost no events of its own: the gap it leaves is the
            // short one between two subscriptions. One that could not connect says nothing of
            // how long nobody listened, and recovers like a lost one.
            None => {
                let Some(status) = self.status.take() else {
                    return;
                };
                self.close_status();
                if status.started || !status.refused {
                    self.recovering = true;
                }
                self.reconcile();
            }
        }
    }

    // --- the structure and focus connections -------------------------------------------------

    fn on_lifecycle(&mut self, wake: ResilientWake) {
        match wake {
            ResilientWake::Reopen => self.lifecycle.open(self.source.as_ref()),
            ResilientWake::Item(Some(StreamItem::Started)) => {
                // panes created or closed meanwhile were not heard of: learn them from a snapshot
                if self.lifecycle.started(&self.options) {
                    self.handler.on_structure_change();
                    self.reconcile();
                }
            }
            ResilientWake::Item(Some(StreamItem::Error(error))) => log_subscription_error(&error),
            ResilientWake::Item(None) => self.lifecycle.closed(&self.options),
            ResilientWake::Item(Some(StreamItem::Event(frame))) => {
                match frames::structure(&frame) {
                    None => {}
                    Some(Structure::Ended(pane)) => {
                        // a snapshot already on its way still holds the pane: it is no news of it
                        self.events += 1;
                        self.acted_on.insert(pane.clone(), self.events);
                        self.heard.remove(&pane);
                        self.handler.on_pane_ended(&pane);
                    }
                    Some(Structure::Changed { closed }) => {
                        // closed with no exit frame: a snapshot on its way that still holds the
                        // pane is no news of it either
                        if let Some(pane) = closed {
                            self.events += 1;
                            self.acted_on.insert(pane.clone(), self.events);
                            self.heard.remove(&pane);
                        }
                        self.handler.on_structure_change();
                        self.schedule_reconcile();
                    }
                }
            }
        }
    }

    fn on_focus(&mut self, wake: ResilientWake) {
        let Some(focus) = &mut self.focus else {
            return;
        };
        match wake {
            ResilientWake::Reopen => focus.open(self.source.as_ref()),
            // a focus change missed meanwhile is gone for good: the next one is heard again
            ResilientWake::Item(Some(StreamItem::Started)) => {
                focus.started(&self.options);
            }
            ResilientWake::Item(Some(StreamItem::Error(error))) => log_subscription_error(&error),
            ResilientWake::Item(None) => focus.closed(&self.options),
            ResilientWake::Item(Some(StreamItem::Event(frame))) => {
                let Some(pane) = frames::focus(&frame) else {
                    return;
                };
                self.events += 1;
                self.focused_at.insert(pane.clone(), self.events);
                // a finish seen at herdr's terminal is no measure for a later snapshot. Work
                // still going on is: its finish in a gap after this is news
                let at_rest = self.heard.get(&pane).is_some_and(|told| {
                    told.status != AgentStatus::Working && told.status != AgentStatus::Blocked
                });
                if at_rest {
                    self.heard.remove(&pane);
                }
                self.handler.on_focus(&pane);
            }
        }
    }

    // --- the reconcile -----------------------------------------------------------------------

    fn schedule_reconcile(&mut self) {
        if self.stopped() || self.reconcile_timer.is_some() {
            return;
        }
        self.reconcile_timer = Some(Box::pin(sleep(self.options.debounce)));
    }

    fn reconcile(&mut self) {
        if self.stopped() {
            return;
        }
        if !matches!(self.reconcile, Reconcile::Idle) {
            // a reconcile is in flight: remember the request and run again when it lands, so
            // an event arriving mid-reconcile can never be lost to the debounce
            self.reconcile_pending = true;
            return;
        }
        let asked = Asked {
            resync: self.resync_for.take(),
            replay: self.replay_for.take(),
            at: self.events,
        };
        self.reconcile = Reconcile::Snapshot {
            answer: self.source.snapshot(),
            asked,
        };
    }

    fn done(&mut self) {
        self.reconcile = Reconcile::Idle;
        if self.reconcile_pending && !self.stopped() {
            self.reconcile_pending = false;
            self.reconcile();
        }
    }

    /// Whether an event, an exit or a focus since `seq` is newer than a snapshot asked then.
    fn newer_than(&self, pane: &str, seq: u64) -> bool {
        let of = |map: &HashMap<String, u64>| map.get(pane).copied().unwrap_or(0);
        of(&self.last_event_of)
            .max(of(&self.acted_on))
            .max(of(&self.focused_at))
            > seq
    }

    fn answered(&mut self, answer: Result<Vec<PaneInfo>, HerdrError>) {
        let Reconcile::Snapshot { asked, .. } = mem::replace(&mut self.reconcile, Reconcile::Busy)
        else {
            return;
        };
        match answer {
            Ok(panes) => self.measure(asked, &panes),
            Err(_) => {
                self.snapshot_failed(asked);
                self.done();
            }
        }
    }

    fn measure(&mut self, asked: Asked, panes: &[PaneInfo]) {
        self.handler.on_baseline(panes);
        // a snapshot asked for a subscription that closed meanwhile may predate what the next
        // one misses: recovery waits for that one's own snapshot
        let resynced = asked.resync.is_some()
            && asked.resync == Some(self.generation)
            && self.status.is_some();
        if resynced {
            self.recovering = false;
            // an exit since the snapshot was asked for is newer than it too. A focus is not:
            // work that ended during the loss is still to be settled, or it would read as
            // going on for good
            let newer: HashSet<String> = self
                .last_event_of
                .iter()
                .chain(&self.acted_on)
                .filter(|(_, seq)| **seq > asked.at)
                .map(|(pane, _)| pane.clone())
                .collect();
            self.handler.on_resync(panes, &newer);
            // clients learn statuses from events, and some were lost: they fetch again
            self.handler.on_structure_change();
        }
        let pane_ids: Vec<String> = panes.iter().map(|pane| pane.pane_id.clone()).collect();
        let same_set = pane_ids.len() == self.subscribed.len()
            && pane_ids.iter().all(|pane| self.subscribed.contains(pane));
        // the live subscription is about to be closed for another pane set: what this snapshot
        // shows and no event has said will not be said by one any more
        let leaving = !same_set && self.status_started && !self.recovering && !resynced;
        let after_gap = !resynced
            && !self.recovering
            && asked.replay.is_some()
            && asked.replay == Some(self.generation)
            && self.status.is_some();
        let replaying = after_gap || leaving;
        if resynced || after_gap {
            self.gap = false;
        }
        let mut replays = Vec::new();
        for pane in panes {
            let id = pane.pane_id.as_str();
            let of = |map: &HashMap<String, u64>| map.get(id).copied().unwrap_or(0);
            // an event, an exit or a focus since the snapshot was asked for is newer than it
            let focus_only =
                resynced && of(&self.last_event_of).max(of(&self.acted_on)) <= asked.at;
            if self.newer_than(id, asked.at) && !focus_only {
                continue;
            }
            match self.heard.get(id) {
                // a pane first seen, or corrected by the resync: this is what it is told as from now
                None => self.hear(pane),
                Some(_) if resynced => self.hear(pane),
                Some(before) if replaying && before.status != pane.agent_status => {
                    replays.push(pane.clone());
                }
                Some(_) => {}
            }
        }
        let finish = Finish {
            asked_at: asked.at,
            pane_ids,
            same_set,
        };
        // also with nothing to replay, when the live connection is about to close: an event on
        // its way is read first
        if !replays.is_empty() || leaving {
            // the old connection stays open through this: an event it still holds is read, and wins
            self.reconcile = Reconcile::Settle {
                until: Box::pin(sleep(self.options.replay_settle)),
                generation: self.generation,
                replays,
                finish,
            };
        } else {
            self.finish(finish);
        }
    }

    fn hear(&mut self, pane: &PaneInfo) {
        self.heard.insert(
            pane.pane_id.clone(),
            Heard {
                status: pane.agent_status.clone(),
                agent: pane.agent.clone(),
            },
        );
    }

    fn settled(&mut self) {
        let Reconcile::Settle {
            generation,
            replays,
            finish,
            ..
        } = mem::replace(&mut self.reconcile, Reconcile::Busy)
        else {
            return;
        };
        // the subscription closed under the wait: what was missed is of unknown length now, and
        // the resync speaks
        let still = !self.recovering && generation == self.generation && self.status.is_some();
        for pane in if still { replays } else { Vec::new() } {
            let id = pane.pane_id.as_str();
            if self.newer_than(id, finish.asked_at) {
                continue;
            }
            let Some(before) = self.heard.get(id).cloned() else {
                continue;
            };
            if before.status == pane.agent_status {
                continue;
            }
            self.hear(&pane);
            self.handler.on_status(
                id,
                pane.agent_status.clone(),
                pane.agent.as_deref(),
                Some(Replay {
                    before: before.status,
                    agent: before.agent,
                }),
            );
        }
        self.finish(finish);
    }

    fn finish(&mut self, finish: Finish) {
        let Finish {
            asked_at,
            pane_ids,
            same_set,
        } = finish;
        let present: HashSet<&str> = pane_ids.iter().map(String::as_str).collect();
        // gone before this snapshot; a pane heard of since may be too new for it
        self.last_event_of
            .retain(|pane, seq| *seq > asked_at || present.contains(pane.as_str()));
        let last_event_of = &self.last_event_of;
        self.heard.retain(|pane, _| {
            present.contains(pane.as_str())
                || last_event_of.get(pane).copied().unwrap_or(0) > asked_at
        });
        self.acted_on
            .retain(|pane, seq| *seq > asked_at || present.contains(pane.as_str()));
        self.focused_at
            .retain(|pane, seq| *seq > asked_at || present.contains(pane.as_str()));
        if !same_set {
            self.close_status();
            self.open_status(&pane_ids);
            // no pane left to listen for: nothing can have been missed
            if pane_ids.is_empty() {
                self.gap = false;
            }
        }
        self.done();
    }

    fn snapshot_failed(&mut self, asked: Asked) {
        if asked.resync.is_some() && self.resync_for.is_none() {
            self.resync_for = asked.resync;
        }
        if asked.replay.is_some() && self.replay_for.is_none() {
            self.replay_for = asked.replay;
        }
        // a gap with a snapshot that fails in it is no short one any more: nobody knows what
        // was missed, and it is corrected without alerts like any lost stretch
        if self.gap && !self.recovering {
            self.recovering = true;
            self.replay_for = None;
            if self.status_started {
                self.resync_for = Some(self.generation);
            }
        }
        // herdr unreachable or slow: retry shortly instead of waiting for the backstop
        if !self.stopped() && self.reconcile_timer.is_none() {
            self.reconcile_timer = Some(Box::pin(sleep(self.options.snapshot_retry)));
        }
    }
}

async fn status_item(status: &mut Option<StatusConnection>) -> Option<StreamItem> {
    match status {
        Some(status) => status.stream.next().await,
        None => pending().await,
    }
}

async fn focus_wake(focus: &mut Option<Resilient>) -> ResilientWake {
    match focus {
        Some(focus) => focus.wake().await,
        None => pending().await,
    }
}

async fn fire(timer: &mut Option<Pin<Box<Sleep>>>) {
    match timer {
        Some(timer) => timer.as_mut().await,
        None => pending().await,
    }
}

/// herdr unreachable is expected while it restarts; anything else is worth a line.
fn log_subscription_error(error: &HerdrError) {
    let code = error.code();
    if code == "connect_failed" || code == "socket_error" {
        return;
    }
    eprintln!("herdr events: {code}: {}", error.message());
}
