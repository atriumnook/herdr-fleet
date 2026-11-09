//! The pane-status subscription (`herdr::pane_status`), driven through its port: a fake
//! [`EventSource`] whose subscriptions the test starts, feeds and closes, and whose snapshot it
//! answers (the fake herdr of `server/collector.test.ts`).
//!
//! Every test runs on Tokio's paused clock: nothing here waits on real I/O (ADR
//! 0242-phase-3-split, "非同期と時刻"). A test ported from `server/collector.test.ts` names its
//! `it`; its waits (`tick`) and the fake's durations are the TypeScript test's. The expected
//! values are the TypeScript test's, or worked out by hand from the TypeScript collector's
//! constants where a test is new.

use herdr_api::{AgentStatus, PaneInfo, Subscription};
use herdr_fleet_herdr::pane_status::{self, PaneStatusHandler, PaneStatusOptions, Replay};
use herdr_fleet_herdr::{
    EventFrame, EventSender, EventSource, EventStream, HerdrError, SnapshotFuture, StreamItem,
};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{oneshot, watch};
use tokio::time::Instant;

// ---------------------------------------------------------------------------------------------
// The fake herdr
// ---------------------------------------------------------------------------------------------

/// One subscription the collector opened.
struct FakeSubscription {
    types: Vec<String>,
    pane_ids: Vec<String>,
    /// `None` once the fake closed it (herdr's close): no other copy is kept, or the stream
    /// would never end.
    sender: Mutex<Option<EventSender>>,
}

impl FakeSubscription {
    /// herdr's `subscription_started`.
    async fn start(&self) {
        self.send(StreamItem::Started).await;
    }

    async fn emit(&self, frame: Value) {
        let frame = EventFrame {
            event: frame
                .get("event")
                .and_then(Value::as_str)
                .map(str::to_owned),
            data: frame.get("data").cloned().unwrap_or(Value::Null),
        };
        self.send(StreamItem::Event(frame)).await;
    }

    /// herdr closes it, after the error frame it sends with `code` (`events_lost` by default in
    /// TypeScript's fake).
    async fn drop_with(&self, code: &str) {
        let error = match code {
            "connect_failed" => HerdrError::ConnectFailed("connect failed".to_owned()),
            "socket_error" => HerdrError::SocketError("socket error".to_owned()),
            "timeout" => HerdrError::Timeout("timeout".to_owned()),
            code => HerdrError::Herdr {
                code: code.to_owned(),
                message: "event subscription fell behind".to_owned(),
            },
        };
        self.send(StreamItem::Error(error)).await;
        self.sender.lock().unwrap().take();
    }

    async fn drop_lost(&self) {
        self.drop_with("events_lost").await;
    }

    /// The collector dropped the stream (TypeScript's `closedByCollector`).
    fn closed_by_collector(&self) -> bool {
        self.sender
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(EventSender::is_closed)
    }

    async fn send(&self, item: StreamItem) {
        let sender = self.sender.lock().unwrap().clone();
        if let Some(sender) = sender {
            sender.send(item).await;
        }
    }
}

#[derive(Default)]
struct FakeState {
    subscriptions: Vec<Arc<FakeSubscription>>,
    panes: Vec<PaneInfo>,
    /// When each snapshot was asked for.
    calls: Vec<Instant>,
    hold: bool,
    failing: bool,
    held: Vec<oneshot::Sender<()>>,
}

/// The fake herdr: subscriptions the test drives, and snapshots answered with the panes it set.
struct FakeHerdr {
    state: Arc<Mutex<FakeState>>,
    opened: watch::Sender<usize>,
}

impl FakeHerdr {
    fn new(panes: Vec<PaneInfo>) -> Arc<Self> {
        Arc::new(Self {
            state: Arc::new(Mutex::new(FakeState {
                panes,
                ..FakeState::default()
            })),
            opened: watch::channel(0).0,
        })
    }

    fn subscriptions(&self) -> Vec<Arc<FakeSubscription>> {
        self.state.lock().unwrap().subscriptions.clone()
    }

    fn snapshot_calls(&self) -> usize {
        self.state.lock().unwrap().calls.len()
    }

    fn snapshot_times(&self) -> Vec<Instant> {
        self.state.lock().unwrap().calls.clone()
    }

    fn set_panes(&self, panes: Vec<PaneInfo>) {
        self.state.lock().unwrap().panes = panes;
    }

    /// Snapshots wait until answered by hand.
    fn hold(&self) {
        self.state.lock().unwrap().hold = true;
    }

    /// Snapshots fail with `timeout` (herdr not answering).
    fn set_failing(&self, failing: bool) {
        self.state.lock().unwrap().failing = failing;
    }

    /// Answers every held snapshot with the panes as they are now.
    fn answer_all(&self) {
        for answer in self.state.lock().unwrap().held.drain(..) {
            let _ = answer.send(());
        }
    }

    fn status(&self) -> Option<Arc<FakeSubscription>> {
        self.subscriptions()
            .into_iter()
            .filter(|s| s.types[0] == "pane.agent_status_changed" && !s.closed_by_collector())
            .last()
    }

    fn lifecycles(&self) -> Vec<Arc<FakeSubscription>> {
        self.subscriptions()
            .into_iter()
            .filter(|s| s.types.iter().any(|t| t == "pane.created"))
            .collect()
    }

    fn lifecycle(&self) -> Arc<FakeSubscription> {
        self.lifecycles().pop().expect("a lifecycle subscription")
    }

    fn focus(&self) -> Arc<FakeSubscription> {
        self.subscriptions()
            .into_iter()
            .find(|s| s.types[0] == "pane.focused")
            .expect("a focus subscription")
    }

    /// Waits until the collector has opened more than `count` subscriptions in all.
    async fn opened_more_than(&self, count: usize) {
        let mut opened = self.opened.subscribe();
        opened.wait_for(|opened| *opened > count).await.unwrap();
    }
}

impl EventSource for FakeHerdr {
    fn subscribe(&self, subscriptions: Vec<Subscription>) -> EventStream {
        let mut types = Vec::new();
        let mut pane_ids = Vec::new();
        for subscription in &subscriptions {
            let value = serde_json::to_value(subscription).unwrap();
            types.push(value["type"].as_str().unwrap().to_owned());
            if let Some(pane) = value.get("pane_id").and_then(Value::as_str) {
                pane_ids.push(pane.to_owned());
            }
        }
        let (sender, stream) = EventStream::channel();
        let record = Arc::new(FakeSubscription {
            types,
            pane_ids,
            sender: Mutex::new(Some(sender)),
        });
        let count = {
            let mut state = self.state.lock().unwrap();
            state.subscriptions.push(record);
            state.subscriptions.len()
        };
        self.opened.send_replace(count);
        stream
    }

    fn snapshot(&self) -> SnapshotFuture {
        let mut state = self.state.lock().unwrap();
        state.calls.push(Instant::now());
        if state.failing {
            return Box::pin(async { Err(HerdrError::Timeout("no answer".to_owned())) });
        }
        if !state.hold {
            let panes = state.panes.clone();
            return Box::pin(async move { Ok(panes) });
        }
        let (answer, answered) = oneshot::channel();
        state.held.push(answer);
        let shared = Arc::clone(&self.state);
        Box::pin(async move {
            answered
                .await
                .map_err(|_| HerdrError::Closed("never answered".to_owned()))?;
            Ok(shared.lock().unwrap().panes.clone())
        })
    }
}

// ---------------------------------------------------------------------------------------------
// The recorder and helpers
// ---------------------------------------------------------------------------------------------

#[derive(Default, Debug)]
struct Log {
    baselines: usize,
    resyncs: Vec<(Vec<String>, Vec<String>)>,
    structure: usize,
    /// `pane:status`, with ` (was before)` for a replay
    statuses: Vec<String>,
    agents: Vec<Option<String>>,
    ended: Vec<String>,
    focused: Vec<String>,
}

#[derive(Default)]
struct Recorder {
    log: Mutex<Log>,
}

impl Recorder {
    fn statuses(&self) -> Vec<String> {
        self.log.lock().unwrap().statuses.clone()
    }

    fn resyncs(&self) -> Vec<(Vec<String>, Vec<String>)> {
        self.log.lock().unwrap().resyncs.clone()
    }

    fn structure(&self) -> usize {
        self.log.lock().unwrap().structure
    }
}

impl PaneStatusHandler for Recorder {
    fn on_status(
        &self,
        pane: &str,
        status: AgentStatus,
        agent: Option<&str>,
        replay: Option<Replay>,
    ) {
        let was = replay.map_or(String::new(), |replay| {
            format!(" (was {})", replay.before.as_str())
        });
        let mut log = self.log.lock().unwrap();
        log.statuses
            .push(format!("{pane}:{}{was}", status.as_str()));
        log.agents.push(agent.map(str::to_owned));
    }

    fn on_baseline(&self, _panes: &[PaneInfo]) {
        self.log.lock().unwrap().baselines += 1;
    }

    fn on_resync(&self, panes: &[PaneInfo], newer: &HashSet<String>) {
        let panes = panes.iter().map(|pane| pane.pane_id.clone()).collect();
        let mut newer: Vec<String> = newer.iter().cloned().collect();
        newer.sort();
        self.log.lock().unwrap().resyncs.push((panes, newer));
    }

    fn on_pane_ended(&self, pane: &str) {
        self.log.lock().unwrap().ended.push(pane.to_owned());
    }

    fn on_structure_change(&self) {
        self.log.lock().unwrap().structure += 1;
    }

    fn on_focus(&self, pane: &str) {
        self.log.lock().unwrap().focused.push(pane.to_owned());
    }
}

/// The TypeScript fake's durations (`fakeHerdr` in `server/collector.test.ts`).
fn fast() -> PaneStatusOptions {
    PaneStatusOptions {
        focus: true,
        reconnect_min: ms(5),
        reconnect_max: ms(40),
        backstop: ms(60_000),
        debounce: ms(5),
        snapshot_retry: ms(5),
        replay_settle: ms(5),
    }
}

fn ms(millis: u64) -> Duration {
    Duration::from_millis(millis)
}

fn pane(pane_id: &str, agent_status: &str) -> PaneInfo {
    serde_json::from_value(json!({
        "pane_id": pane_id,
        "agent_status": agent_status,
        "focused": false,
        "revision": 0,
        "tab_id": "t",
        "terminal_id": "term",
        "workspace_id": pane_id.split(':').next().unwrap(),
    }))
    .unwrap()
}

fn status_frame(pane_id: &str, agent_status: &str) -> Value {
    json!({ "event": "pane.agent_status_changed", "data": { "pane_id": pane_id, "agent_status": agent_status, "agent": "claude" } })
}

fn created(pane_id: &str) -> Value {
    json!({ "event": "pane_created", "data": { "type": "pane_created", "pane_id": pane_id } })
}

fn focused(pane_id: &str) -> Value {
    json!({ "event": "pane_focused", "data": { "type": "pane_focused", "pane_id": pane_id } })
}

/// TypeScript's `tick(ms)`: lets everything ready run, then waits `millis` on the paused clock.
async fn tick(millis: u64) {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    if millis > 0 {
        tokio::time::sleep(ms(millis)).await;
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
    }
}

fn start(
    herdr: &Arc<FakeHerdr>,
    recorder: &Arc<Recorder>,
    options: PaneStatusOptions,
) -> pane_status::PaneStatus {
    pane_status::start(
        Arc::clone(herdr) as Arc<dyn EventSource>,
        Arc::clone(recorder) as Arc<dyn PaneStatusHandler>,
        options,
    )
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

// ---------------------------------------------------------------------------------------------
// Frames (describe parseStatusFrame / parseStructureFrame / parseFocusFrame), through `start`
// ---------------------------------------------------------------------------------------------

// server/collector.test.ts: parseStatusFrame "parses a real agent_status_changed frame"
#[tokio::test(start_paused = true)]
async fn parses_a_real_agent_status_changed_frame() {
    let herdr = FakeHerdr::new(vec![pane("w3J:p1", "idle")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    herdr
        .status()
        .unwrap()
        .emit(json!({ "event": "pane.agent_status_changed", "data": { "agent": "claude", "agent_status": "blocked", "pane_id": "w3J:p1", "workspace_id": "w3J" } }))
        .await;
    tick(0).await;
    assert_eq!(recorder.statuses(), strings(&["w3J:p1:blocked"]));
    assert_eq!(
        recorder.log.lock().unwrap().agents,
        vec![Some("claude".to_owned())]
    );
    collector.stop();
}

// server/collector.test.ts: parseStatusFrame "rejects frames that are not status events"
#[tokio::test(start_paused = true)]
async fn rejects_frames_that_are_not_status_events() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "idle")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    herdr
        .status()
        .unwrap()
        .emit(json!({ "event": "pane_exited", "data": { "type": "pane_exited", "pane_id": "w1:p1" } }))
        .await;
    tick(0).await;
    assert_eq!(recorder.statuses(), Vec::<String>::new());
    assert_eq!(recorder.log.lock().unwrap().ended, Vec::<String>::new());
    collector.stop();
}

// server/collector.test.ts: parseStatusFrame "rejects malformed payloads instead of throwing"
#[tokio::test(start_paused = true)]
async fn rejects_malformed_payloads_instead_of_throwing() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "idle")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    let status = herdr.status().unwrap();
    status
        .emit(json!({ "event": "pane.agent_status_changed", "data": { "pane_id": 7 } }))
        .await;
    status
        .emit(json!({ "event": "pane.agent_status_changed" }))
        .await;
    status.emit(json!({})).await;
    tick(0).await;
    assert_eq!(recorder.statuses(), Vec::<String>::new());
    // still listening: the next good frame is told
    status.emit(status_frame("w1:p1", "working")).await;
    tick(0).await;
    assert_eq!(recorder.statuses(), strings(&["w1:p1:working"]));
    collector.stop();
}

// server/collector.test.ts: parseStructureFrame "parses a pane_exited frame into a pane-ended event"
#[tokio::test(start_paused = true)]
async fn parses_a_pane_exited_frame_into_a_pane_ended_event() {
    let herdr = FakeHerdr::new(vec![]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    herdr
        .lifecycle()
        .emit(json!({ "event": "pane_exited", "data": { "type": "pane_exited", "pane_id": "w3M:p1", "workspace_id": "w3M" } }))
        .await;
    tick(0).await;
    assert_eq!(recorder.log.lock().unwrap().ended, strings(&["w3M:p1"]));
    assert_eq!(recorder.structure(), 0);
    collector.stop();
}

// server/collector.test.ts: parseStructureFrame "parses pane_created and pane_closed into a structure-changed event"
#[tokio::test(start_paused = true)]
async fn parses_pane_created_and_pane_closed_into_a_structure_changed_event() {
    let herdr = FakeHerdr::new(vec![]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    let lifecycle = herdr.lifecycle();
    lifecycle
        .emit(json!({ "data": { "type": "pane_created" } }))
        .await;
    lifecycle
        .emit(json!({ "data": { "type": "pane_closed", "pane_id": "w1:p1" } }))
        .await;
    lifecycle
        .emit(json!({ "data": { "type": "pane_closed" } }))
        .await;
    tick(0).await;
    assert_eq!(recorder.structure(), 3);
    assert_eq!(recorder.log.lock().unwrap().ended, Vec::<String>::new());
    collector.stop();
}

// server/collector.test.ts: parseStructureFrame "rejects unknown or malformed frames"
#[tokio::test(start_paused = true)]
async fn rejects_unknown_or_malformed_structure_frames() {
    let herdr = FakeHerdr::new(vec![]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    let calls = herdr.snapshot_calls();
    let lifecycle = herdr.lifecycle();
    lifecycle
        .emit(json!({ "data": { "type": "workspace_closed" } }))
        .await;
    lifecycle
        .emit(json!({ "data": { "type": "pane_exited", "pane_id": 42 } }))
        .await;
    lifecycle.emit(json!({})).await;
    tick(20).await;
    assert_eq!(recorder.structure(), 0);
    assert_eq!(recorder.log.lock().unwrap().ended, Vec::<String>::new());
    // nor does any of them ask for a snapshot
    assert_eq!(herdr.snapshot_calls(), calls);
    collector.stop();
}

// server/collector.test.ts: parseFocusFrame "names the pane a focus lands on, from the live frame"
#[tokio::test(start_paused = true)]
async fn names_the_pane_a_focus_lands_on_from_the_live_frame() {
    let herdr = FakeHerdr::new(vec![]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    let focus = herdr.focus();
    // live (herdr 0.9.0): a workspace brought to the front also sends pane_focused for its pane
    focus
        .emit(json!({ "event": "pane_focused", "data": { "pane_id": "w1A4:p1", "type": "pane_focused", "workspace_id": "w1A4" } }))
        .await;
    focus
        .emit(json!({ "event": "tab_focused", "data": { "tab_id": "w1A4:t1", "type": "tab_focused", "workspace_id": "w1A4" } }))
        .await;
    focus
        .emit(json!({ "data": { "type": "pane_focused", "pane_id": 3 } }))
        .await;
    focus.emit(json!({})).await;
    tick(0).await;
    assert_eq!(recorder.log.lock().unwrap().focused, strings(&["w1A4:p1"]));
    collector.stop();
}

// ---------------------------------------------------------------------------------------------
// The connections (new: herdr's subscription quirks, the collector.ts header)
// ---------------------------------------------------------------------------------------------

/// `pane.agent_status_changed` needs a pane_id: every pane is one subscription of the single
/// status connection; structure and focus subscribe globally, each on its own connection.
#[tokio::test(start_paused = true)]
async fn subscribes_every_pane_on_one_status_connection_and_structure_and_focus_on_their_own() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "idle"), pane("w2:p1", "idle")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    let subscriptions = herdr.subscriptions();
    assert_eq!(subscriptions.len(), 3);
    let lifecycle = herdr.lifecycle();
    assert_eq!(
        lifecycle.types,
        strings(&["pane.created", "pane.closed", "pane.exited"])
    );
    assert_eq!(lifecycle.pane_ids, Vec::<String>::new());
    let focus = herdr.focus();
    assert_eq!(focus.types, strings(&["pane.focused"]));
    let status = herdr.status().unwrap();
    assert_eq!(
        status.types,
        strings(&["pane.agent_status_changed", "pane.agent_status_changed"])
    );
    assert_eq!(status.pane_ids, strings(&["w1:p1", "w2:p1"]));
    collector.stop();
}

/// A second `events.subscribe` on an open connection is ignored: a new pane closes the status
/// connection and opens another with the whole set.
#[tokio::test(start_paused = true)]
async fn reopens_the_whole_status_connection_when_the_pane_set_changes() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "idle")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    let first = herdr.status().unwrap();
    first.start().await;
    tick(20).await;
    herdr.set_panes(vec![pane("w1:p1", "idle"), pane("w2:p1", "idle")]);
    herdr.lifecycle().emit(created("w2:p1")).await;
    tick(20).await;
    assert!(first.closed_by_collector());
    let second = herdr.status().unwrap();
    assert_eq!(second.pane_ids, strings(&["w1:p1", "w2:p1"]));
    let statuses: Vec<_> = herdr
        .subscriptions()
        .into_iter()
        .filter(|s| s.types[0] == "pane.agent_status_changed")
        .collect();
    assert_eq!(statuses.len(), 2);
    collector.stop();
}

/// `PaneStatusOptions::focus` chooses whether the focus connection opens.
#[tokio::test(start_paused = true)]
async fn opens_the_focus_connection_only_when_asked() {
    let herdr = FakeHerdr::new(vec![]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(
        &herdr,
        &recorder,
        PaneStatusOptions {
            focus: false,
            ..fast()
        },
    );
    tick(0).await;
    assert!(
        herdr
            .subscriptions()
            .iter()
            .all(|s| s.types[0] != "pane.focused")
    );
    assert_eq!(herdr.subscriptions().len(), 1);
    collector.stop();
    assert!(PaneStatusOptions::default().focus);
}

// ---------------------------------------------------------------------------------------------
// The default durations (new: server/collector.ts RECONNECT_MIN_MS … REPLAY_SETTLE_MS)
// ---------------------------------------------------------------------------------------------

/// RECONNECT_MIN_MS 250 doubling up to RECONNECT_MAX_MS 5000: 250, 500, 1000, 2000, 4000,
/// 5000, 5000; back to 250 once one started.
#[tokio::test(start_paused = true)]
async fn backs_off_from_250_ms_to_5_s_by_default() {
    let herdr = FakeHerdr::new(vec![]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, PaneStatusOptions::default());
    tick(0).await;
    let mut gaps = Vec::new();
    for _ in 0..7 {
        let dropped = Instant::now();
        let count = herdr.subscriptions().len();
        herdr.lifecycle().drop_with("connect_failed").await;
        herdr.opened_more_than(count).await;
        gaps.push(Instant::now() - dropped);
    }
    assert_eq!(gaps, [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000].map(ms));
    herdr.lifecycle().start().await;
    tick(0).await;
    let dropped = Instant::now();
    let count = herdr.subscriptions().len();
    herdr.lifecycle().drop_lost().await;
    herdr.opened_more_than(count).await;
    assert_eq!(Instant::now() - dropped, ms(250));
    collector.stop();
}

/// BACKSTOP_INTERVAL_MS: a snapshot every 60 s with nothing else going on.
#[tokio::test(start_paused = true)]
async fn checks_every_pane_against_a_snapshot_every_60_s_by_default() {
    let herdr = FakeHerdr::new(vec![]);
    let recorder = Arc::new(Recorder::default());
    let t0 = Instant::now();
    let collector = start(&herdr, &recorder, PaneStatusOptions::default());
    tick(59_999).await;
    assert_eq!(herdr.snapshot_calls(), 1);
    tick(60_001).await;
    let at: Vec<_> = herdr
        .snapshot_times()
        .into_iter()
        .map(|at| at - t0)
        .collect();
    assert_eq!(at, [0, 60_000, 120_000].map(ms));
    assert_eq!(recorder.log.lock().unwrap().baselines, 3);
    collector.stop();
}

/// RECONCILE_DEBOUNCE_MS: a structure change reconciles 500 ms later, and more changes within
/// those 500 ms do not push it back nor add another.
#[tokio::test(start_paused = true)]
async fn reconciles_500_ms_after_a_structure_change_by_default() {
    let herdr = FakeHerdr::new(vec![]);
    let recorder = Arc::new(Recorder::default());
    let t0 = Instant::now();
    let collector = start(&herdr, &recorder, PaneStatusOptions::default());
    tick(1_000).await;
    let lifecycle = herdr.lifecycle();
    lifecycle.emit(created("w1:p1")).await;
    tick(100).await;
    lifecycle.emit(created("w1:p2")).await;
    tick(399).await;
    assert_eq!(herdr.snapshot_calls(), 1);
    tick(1_000).await;
    let at: Vec<_> = herdr
        .snapshot_times()
        .into_iter()
        .map(|at| at - t0)
        .collect();
    assert_eq!(at, [0, 1_500].map(ms));
    collector.stop();
}

/// SNAPSHOT_RETRY_MS: a snapshot that fails is asked again 5 s later.
#[tokio::test(start_paused = true)]
async fn retries_a_failed_snapshot_after_5_s_by_default() {
    let herdr = FakeHerdr::new(vec![]);
    herdr.set_failing(true);
    let recorder = Arc::new(Recorder::default());
    let t0 = Instant::now();
    let collector = start(&herdr, &recorder, PaneStatusOptions::default());
    tick(10_000).await;
    herdr.set_failing(false);
    tick(5_000).await;
    let at: Vec<_> = herdr
        .snapshot_times()
        .into_iter()
        .map(|at| at - t0)
        .collect();
    assert_eq!(at, [0, 5_000, 10_000, 15_000].map(ms));
    assert_eq!(recorder.log.lock().unwrap().baselines, 1);
    collector.stop();
}

/// REPLAY_SETTLE_MS: a replay waits 150 ms, and so does the close of a live connection for
/// another pane set; an event that arrives within them wins.
#[tokio::test(start_paused = true)]
async fn waits_150_ms_before_a_replay_by_default() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "working")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, PaneStatusOptions::default());
    tick(0).await;
    let first = herdr.status().unwrap();
    first.start().await;
    tick(0).await;
    herdr.set_panes(vec![pane("w1:p1", "working"), pane("w2:p1", "idle")]);
    herdr.lifecycle().emit(created("w2:p1")).await;
    // the debounce, then the wait before the live connection closes
    tick(500).await;
    tick(149).await;
    assert!(!first.closed_by_collector());
    tick(1).await;
    assert!(first.closed_by_collector());
    // w1:p1 finishes in the gap; the new connection's snapshot replays it 150 ms on
    herdr.set_panes(vec![pane("w1:p1", "idle"), pane("w2:p1", "idle")]);
    herdr.status().unwrap().start().await;
    tick(149).await;
    assert_eq!(recorder.statuses(), Vec::<String>::new());
    tick(1).await;
    assert_eq!(recorder.statuses(), strings(&["w1:p1:idle (was working)"]));
    collector.stop();
}

// ---------------------------------------------------------------------------------------------
// Recovery (describe "startStatusCollector recovery")
// ---------------------------------------------------------------------------------------------

// server/collector.test.ts: "snapshots again once the status subscription has started, without resyncing"
#[tokio::test(start_paused = true)]
async fn snapshots_again_once_the_status_subscription_has_started_without_resyncing() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "idle")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    assert_eq!(herdr.status().unwrap().pane_ids, strings(&["w1:p1"]));
    assert_eq!(herdr.snapshot_calls(), 1);
    herdr.status().unwrap().start().await;
    tick(20).await;
    assert_eq!(herdr.snapshot_calls(), 2);
    assert_eq!(recorder.resyncs(), vec![]);
    collector.stop();
}

// server/collector.test.ts: "tells a status that changed while the subscription was reopened for another pane set"
#[tokio::test(start_paused = true)]
async fn tells_a_status_that_changed_while_the_subscription_was_reopened_for_another_pane_set() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "working")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    herdr.status().unwrap().start().await;
    tick(20).await;
    let first = herdr.status().unwrap();
    // a pane opens elsewhere: the connection is reopened with both, and p1 finishes meanwhile
    herdr.set_panes(vec![pane("w1:p1", "working"), pane("w2:p1", "idle")]);
    herdr.lifecycle().emit(created("w2:p1")).await;
    tick(20).await;
    let second = herdr.status().unwrap();
    assert!(!Arc::ptr_eq(&second, &first));
    assert_eq!(second.pane_ids, strings(&["w1:p1", "w2:p1"]));
    herdr.set_panes(vec![pane("w1:p1", "idle"), pane("w2:p1", "idle")]);
    assert_eq!(recorder.statuses(), Vec::<String>::new());
    second.start().await;
    tick(20).await;
    // once, as the event would have been; a pane first seen is no change; nothing was "lost"
    assert_eq!(recorder.statuses(), strings(&["w1:p1:idle (was working)"]));
    assert_eq!(recorder.resyncs(), vec![]);
    // the same snapshot again tells nothing more, and an event since outranks an older snapshot
    herdr.hold();
    herdr
        .lifecycle()
        .emit(json!({ "event": "pane_closed", "data": { "type": "pane_closed" } }))
        .await;
    tick(20).await;
    second.emit(status_frame("w1:p1", "working")).await;
    herdr.answer_all();
    tick(0).await;
    assert_eq!(
        recorder.statuses(),
        strings(&["w1:p1:idle (was working)", "w1:p1:working"])
    );
    collector.stop();
}

// server/collector.test.ts: "tells a change that fell into a subscription herdr refused for a pane that had gone"
#[tokio::test(start_paused = true)]
async fn tells_a_change_that_fell_into_a_subscription_herdr_refused_for_a_pane_that_had_gone() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "working"), pane("w9:p1", "idle")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    // w9:p1 closed between the snapshot and the subscribe: herdr refuses the batch, and p1 finishes meanwhile
    herdr.set_panes(vec![pane("w1:p1", "idle")]);
    herdr.status().unwrap().drop_with("pane_not_found").await;
    tick(0).await;
    let reopened = herdr.status().unwrap();
    assert_eq!(reopened.pane_ids, strings(&["w1:p1"]));
    reopened.start().await;
    tick(20).await;
    assert_eq!(recorder.statuses(), strings(&["w1:p1:idle (was working)"]));
    assert_eq!(recorder.resyncs(), vec![]);
    collector.stop();
}

// server/collector.test.ts: "tells nothing from a snapshot that follows no gap, nor a finish herdr reads two ways"
#[tokio::test(start_paused = true)]
async fn tells_nothing_from_a_snapshot_that_follows_no_gap_nor_a_finish_herdr_reads_two_ways() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "working")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(
        &herdr,
        &recorder,
        PaneStatusOptions {
            backstop: ms(15),
            ..fast()
        },
    );
    tick(0).await;
    herdr.status().unwrap().start().await;
    tick(20).await;
    herdr
        .status()
        .unwrap()
        .emit(status_frame("w1:p1", "done"))
        .await;
    // the backstop's snapshot reads the same finish as idle: no change, and no undoing of the done
    herdr.set_panes(vec![pane("w1:p1", "idle")]);
    tick(40).await;
    assert!(herdr.snapshot_calls() > 2);
    assert_eq!(recorder.statuses(), strings(&["w1:p1:done"]));
    // around a gap it is passed on with what the pane was last told as: whoever shows the pane decides if that is a change
    herdr.set_panes(vec![pane("w1:p1", "idle"), pane("w2:p1", "idle")]);
    herdr.lifecycle().emit(created("w2:p1")).await;
    tick(30).await;
    herdr.status().unwrap().start().await;
    tick(20).await;
    assert_eq!(
        recorder.statuses(),
        strings(&["w1:p1:done", "w1:p1:idle (was done)"])
    );
    collector.stop();
}

// server/collector.test.ts: "tells what the snapshot that closes the subscription already shows: the event for it is lost with the connection"
#[tokio::test(start_paused = true)]
async fn tells_what_the_snapshot_that_closes_the_subscription_already_shows() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "working")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    herdr.status().unwrap().start().await;
    tick(20).await;
    // p1 finishes and a pane opens: herdr's snapshot shows both, its event for p1 is still unread when the connection closes
    herdr.set_panes(vec![pane("w1:p1", "unknown"), pane("w2:p1", "idle")]);
    herdr.lifecycle().emit(created("w2:p1")).await;
    tick(20).await;
    assert_eq!(
        recorder.statuses(),
        strings(&["w1:p1:unknown (was working)"])
    );
    herdr.status().unwrap().start().await;
    tick(20).await;
    assert_eq!(
        recorder.statuses(),
        strings(&["w1:p1:unknown (was working)"])
    );
    collector.stop();
}

// server/collector.test.ts: "lets an event that was on its way outrank the snapshot that overtook it"
#[tokio::test(start_paused = true)]
async fn lets_an_event_that_was_on_its_way_outrank_the_snapshot_that_overtook_it() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "blocked")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(
        &herdr,
        &recorder,
        PaneStatusOptions {
            replay_settle: ms(40),
            ..fast()
        },
    );
    tick(0).await;
    herdr.status().unwrap().start().await;
    tick(20).await;
    herdr.set_panes(vec![pane("w1:p1", "blocked"), pane("w2:p1", "idle")]);
    herdr.lifecycle().emit(created("w2:p1")).await;
    tick(70).await;
    // answered, worked and finished right after the new subscription started: the snapshot says idle before its two events are read
    herdr.set_panes(vec![pane("w1:p1", "idle"), pane("w2:p1", "idle")]);
    let live = herdr.status().unwrap();
    live.start().await;
    tick(10).await;
    live.emit(status_frame("w1:p1", "working")).await;
    live.emit(status_frame("w1:p1", "idle")).await;
    tick(60).await;
    // told once each, in the order they happened, and no finish before the work
    assert_eq!(
        recorder.statuses(),
        strings(&["w1:p1:working", "w1:p1:idle"])
    );
    collector.stop();
}

// server/collector.test.ts: "tells nothing of a pane closed, or once the subscription is lost, while a replay waits"
#[tokio::test(start_paused = true)]
async fn tells_nothing_of_a_pane_closed_or_once_the_subscription_is_lost_while_a_replay_waits() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "working"), pane("w1:p2", "working")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(
        &herdr,
        &recorder,
        PaneStatusOptions {
            replay_settle: ms(40),
            ..fast()
        },
    );
    tick(0).await;
    herdr.status().unwrap().start().await;
    tick(20).await;
    herdr.set_panes(vec![
        pane("w1:p1", "working"),
        pane("w1:p2", "working"),
        pane("w2:p1", "idle"),
    ]);
    herdr.lifecycle().emit(created("w2:p1")).await;
    tick(70).await;
    // both finish in the gap; while the replay waits, p1 is closed (no exit frame)
    herdr.set_panes(vec![
        pane("w1:p1", "idle"),
        pane("w1:p2", "idle"),
        pane("w2:p1", "idle"),
    ]);
    herdr.status().unwrap().start().await;
    tick(10).await;
    herdr
        .lifecycle()
        .emit(json!({ "event": "pane_closed", "data": { "type": "pane_closed", "pane_id": "w1:p1" } }))
        .await;
    tick(60).await;
    assert_eq!(recorder.statuses(), strings(&["w1:p2:idle (was working)"]));
    collector.stop();

    let lost = FakeHerdr::new(vec![pane("w1:p1", "working")]);
    let second = Arc::new(Recorder::default());
    let other = start(
        &lost,
        &second,
        PaneStatusOptions {
            replay_settle: ms(40),
            ..fast()
        },
    );
    tick(0).await;
    lost.status().unwrap().start().await;
    tick(20).await;
    lost.set_panes(vec![pane("w1:p1", "working"), pane("w2:p1", "idle")]);
    lost.lifecycle().emit(created("w2:p1")).await;
    tick(70).await;
    lost.set_panes(vec![pane("w1:p1", "idle"), pane("w2:p1", "idle")]);
    lost.status().unwrap().start().await;
    tick(10).await;
    // herdr drops the new subscription while the replay waits: from here on nobody knows what was missed
    lost.status().unwrap().drop_lost().await;
    tick(60).await;
    assert_eq!(second.statuses(), Vec::<String>::new());
    other.stop();
}

// server/collector.test.ts: "leaves out of the replay a pane that ended or came to the front while the snapshot was on its way"
#[tokio::test(start_paused = true)]
async fn leaves_out_of_the_replay_a_pane_that_ended_or_came_to_the_front_while_the_snapshot_was_on_its_way()
 {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "working"), pane("w1:p2", "working")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    herdr.status().unwrap().start().await;
    tick(20).await;
    herdr.set_panes(vec![
        pane("w1:p1", "working"),
        pane("w1:p2", "working"),
        pane("w2:p1", "idle"),
    ]);
    herdr.lifecycle().emit(created("w2:p1")).await;
    tick(20).await;
    // both finish in the gap
    herdr.set_panes(vec![
        pane("w1:p1", "idle"),
        pane("w1:p2", "idle"),
        pane("w2:p1", "idle"),
    ]);
    herdr.hold();
    herdr.status().unwrap().start().await;
    tick(20).await;
    // the snapshot that will replay is asked for; p1 exits and p2 is brought to the front before it answers
    herdr
        .lifecycle()
        .emit(json!({ "event": "pane_exited", "data": { "type": "pane_exited", "pane_id": "w1:p1" } }))
        .await;
    herdr.focus().emit(focused("w1:p2")).await;
    herdr.answer_all();
    tick(0).await;
    assert_eq!(recorder.statuses(), Vec::<String>::new());
    collector.stop();
}

// server/collector.test.ts: "forgets what a pane was heard as once it came to the front, and recovers silently when a snapshot fails in a gap"
#[tokio::test(start_paused = true)]
async fn forgets_what_a_pane_was_heard_as_once_it_came_to_the_front_and_recovers_silently_when_a_snapshot_fails_in_a_gap()
 {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "working"), pane("w1:p2", "working")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    herdr.status().unwrap().start().await;
    tick(20).await;
    // p1 is brought to the front; later a gap, in which both read idle
    herdr.focus().emit(focused("w1:p1")).await;
    herdr.set_panes(vec![
        pane("w1:p1", "working"),
        pane("w1:p2", "working"),
        pane("w2:p1", "idle"),
    ]);
    herdr.lifecycle().emit(created("w2:p1")).await;
    tick(20).await;
    herdr.set_panes(vec![
        pane("w1:p1", "working"),
        pane("w1:p2", "idle"),
        pane("w2:p1", "idle"),
    ]);
    herdr.status().unwrap().start().await;
    tick(20).await;
    // p2's finish is told; p1 was taken in anew by the snapshot that saw the new pane, and did not change since
    assert_eq!(recorder.statuses(), strings(&["w1:p2:idle (was working)"]));
    collector.stop();

    let broken = FakeHerdr::new(vec![pane("w1:p1", "working")]);
    let second = Arc::new(Recorder::default());
    let flaky = start(&broken, &second, fast());
    tick(0).await;
    broken.status().unwrap().start().await;
    tick(20).await;
    broken.set_panes(vec![pane("w1:p1", "working"), pane("w2:p1", "idle")]);
    broken.lifecycle().emit(created("w2:p1")).await;
    tick(20).await;
    // herdr stops answering snapshots inside the gap, for nobody knows how long; p1 finishes meanwhile
    broken.set_failing(true);
    broken.status().unwrap().start().await;
    tick(20).await;
    broken.set_panes(vec![pane("w1:p1", "idle"), pane("w2:p1", "idle")]);
    broken.set_failing(false);
    tick(30).await;
    assert_eq!(second.statuses(), Vec::<String>::new());
    assert_eq!(second.resyncs().len(), 1);
    flaky.stop();
}

// server/collector.test.ts: "still tells the finish of work that was brought to the front while it went on"
#[tokio::test(start_paused = true)]
async fn still_tells_the_finish_of_work_that_was_brought_to_the_front_while_it_went_on() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "working")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    herdr.status().unwrap().start().await;
    tick(20).await;
    herdr.focus().emit(focused("w1:p1")).await;
    herdr.set_panes(vec![pane("w1:p1", "working"), pane("w2:p1", "idle")]);
    herdr.lifecycle().emit(created("w2:p1")).await;
    tick(30).await;
    herdr.set_panes(vec![pane("w1:p1", "idle"), pane("w2:p1", "idle")]);
    herdr.status().unwrap().start().await;
    tick(30).await;
    assert_eq!(recorder.statuses(), strings(&["w1:p1:idle (was working)"]));
    collector.stop();
}

// server/collector.test.ts: "reads an event still on its way before it closes the connection, also when the snapshot shows nothing to replay"
#[tokio::test(start_paused = true)]
async fn reads_an_event_still_on_its_way_before_it_closes_the_connection_also_when_the_snapshot_shows_nothing_to_replay()
 {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "working")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(
        &herdr,
        &recorder,
        PaneStatusOptions {
            replay_settle: ms(40),
            ..fast()
        },
    );
    tick(0).await;
    herdr.status().unwrap().start().await;
    tick(20).await;
    let live = herdr.status().unwrap();
    // brought to the front: what p1 was told as is forgotten, so the snapshot has nothing to measure it against
    herdr.focus().emit(focused("w1:p1")).await;
    herdr.set_panes(vec![pane("w1:p1", "idle"), pane("w2:p1", "idle")]);
    herdr.lifecycle().emit(created("w2:p1")).await;
    tick(20).await;
    // the finish arrives on the old connection while the collector waits before closing it
    assert!(!live.closed_by_collector());
    live.emit(status_frame("w1:p1", "idle")).await;
    tick(60).await;
    assert!(live.closed_by_collector());
    assert_eq!(recorder.statuses(), strings(&["w1:p1:idle"]));
    collector.stop();
}

// server/collector.test.ts: "recovers without telling when the reopened subscription could not connect"
#[tokio::test(start_paused = true)]
async fn recovers_without_telling_when_the_reopened_subscription_could_not_connect() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "working")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    herdr.status().unwrap().start().await;
    tick(20).await;
    herdr.set_panes(vec![pane("w1:p1", "working"), pane("w2:p1", "idle")]);
    herdr.lifecycle().emit(created("w2:p1")).await;
    tick(20).await;
    // herdr cannot be reached: nobody knows for how long nothing listened
    herdr.status().unwrap().drop_with("connect_failed").await;
    herdr.set_panes(vec![pane("w1:p1", "idle"), pane("w2:p1", "idle")]);
    tick(0).await;
    herdr.status().unwrap().start().await;
    tick(20).await;
    assert_eq!(recorder.statuses(), Vec::<String>::new());
    assert_eq!(recorder.resyncs().len(), 1);
    collector.stop();
}

// server/collector.test.ts: "resubscribes after events_lost and resyncs from a snapshot taken after the start"
#[tokio::test(start_paused = true)]
async fn resubscribes_after_events_lost_and_resyncs_from_a_snapshot_taken_after_the_start() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "working"), pane("w1:p2", "working")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    herdr.status().unwrap().start().await;
    tick(20).await;
    let lost = herdr.status().unwrap();
    herdr.set_panes(vec![pane("w1:p1", "idle"), pane("w1:p2", "blocked")]);
    lost.drop_lost().await;
    tick(0).await;
    let reopened = herdr.status().unwrap();
    assert!(!Arc::ptr_eq(&reopened, &lost));
    // nothing is resynced before the new subscription is live
    assert_eq!(recorder.resyncs(), vec![]);
    let before = herdr.snapshot_calls();
    reopened.start().await;
    tick(20).await;
    assert_eq!(herdr.snapshot_calls(), before + 1);
    assert_eq!(
        recorder.resyncs(),
        vec![(strings(&["w1:p1", "w1:p2"]), vec![])]
    );
    assert_eq!(recorder.structure(), 1);
    collector.stop();
}

// server/collector.test.ts: "still resyncs a pane that only came to the front while the recovery snapshot was on its way"
#[tokio::test(start_paused = true)]
async fn still_resyncs_a_pane_that_only_came_to_the_front_while_the_recovery_snapshot_was_on_its_way()
 {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "working"), pane("w1:p2", "working")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    herdr.status().unwrap().start().await;
    tick(20).await;
    herdr.set_panes(vec![pane("w1:p1", "idle"), pane("w1:p2", "idle")]);
    herdr.status().unwrap().drop_lost().await;
    tick(0).await;
    herdr.hold();
    herdr.status().unwrap().start().await;
    tick(0).await;
    // p1 is brought to the front, p2 exits, while the recovery snapshot is on its way
    herdr.focus().emit(focused("w1:p1")).await;
    herdr
        .lifecycle()
        .emit(json!({ "event": "pane_exited", "data": { "type": "pane_exited", "pane_id": "w1:p2" } }))
        .await;
    herdr.answer_all();
    tick(20).await;
    assert_eq!(
        recorder.resyncs(),
        vec![(strings(&["w1:p1", "w1:p2"]), strings(&["w1:p2"]))]
    );
    collector.stop();
}

// server/collector.test.ts: "leaves out of the resync a pane whose event arrived while the snapshot was on its way"
#[tokio::test(start_paused = true)]
async fn leaves_out_of_the_resync_a_pane_whose_event_arrived_while_the_snapshot_was_on_its_way() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "working"), pane("w1:p2", "working")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    herdr.status().unwrap().start().await;
    tick(20).await;
    herdr.status().unwrap().drop_lost().await;
    tick(0).await;
    herdr.hold();
    let reopened = herdr.status().unwrap();
    reopened.start().await;
    tick(20).await;
    reopened.emit(status_frame("w1:p2", "idle")).await;
    herdr.answer_all();
    tick(0).await;
    assert_eq!(recorder.statuses(), strings(&["w1:p2:idle"]));
    assert_eq!(
        recorder.resyncs(),
        vec![(strings(&["w1:p1", "w1:p2"]), strings(&["w1:p2"]))]
    );
    collector.stop();
}

// server/collector.test.ts: "reconciles when the lifecycle subscription comes back, not on its first start"
#[tokio::test(start_paused = true)]
async fn reconciles_when_the_lifecycle_subscription_comes_back_not_on_its_first_start() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "idle")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    herdr.lifecycle().start().await;
    tick(20).await;
    assert_eq!(recorder.structure(), 0);
    let calls = herdr.snapshot_calls();
    // a pane created while the lifecycle stream was lost
    herdr.set_panes(vec![pane("w1:p1", "idle"), pane("w1:p2", "idle")]);
    herdr.lifecycle().drop_lost().await;
    tick(10).await;
    assert_eq!(herdr.lifecycles().len(), 2);
    herdr.lifecycle().start().await;
    tick(20).await;
    assert_eq!(recorder.structure(), 1);
    assert!(herdr.snapshot_calls() > calls);
    assert_eq!(
        herdr.status().unwrap().pane_ids,
        strings(&["w1:p1", "w1:p2"])
    );
    collector.stop();
}

// server/collector.test.ts: "backs off while a subscription keeps closing before it starts, and resets once one starts"
#[tokio::test(start_paused = true)]
async fn backs_off_while_a_subscription_keeps_closing_before_it_starts_and_resets_once_one_starts()
{
    let herdr = FakeHerdr::new(vec![]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(
        &herdr,
        &recorder,
        PaneStatusOptions {
            reconnect_min: ms(20),
            reconnect_max: ms(160),
            ..fast()
        },
    );
    let mut gaps = Vec::new();
    for _ in 0..4 {
        let dropped = Instant::now();
        let count = herdr.subscriptions().len();
        herdr.lifecycle().drop_with("connect_failed").await;
        herdr.opened_more_than(count).await;
        gaps.push(Instant::now() - dropped);
    }
    // 20, 40, 80, 160 ms (the paused clock makes them exact: the TypeScript test only bounds the last)
    assert_eq!(gaps, [20, 40, 80, 160].map(ms));
    herdr.lifecycle().start().await;
    tick(0).await;
    let count = herdr.subscriptions().len();
    let dropped = Instant::now();
    herdr.lifecycle().drop_lost().await;
    herdr.opened_more_than(count).await;
    // back to the first delay once one started
    assert_eq!(Instant::now() - dropped, ms(20));
    collector.stop();
}

// server/collector.test.ts: "does not let a snapshot asked for a subscription that closed meanwhile end the recovery"
#[tokio::test(start_paused = true)]
async fn does_not_let_a_snapshot_asked_for_a_subscription_that_closed_meanwhile_end_the_recovery() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "working")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    herdr.status().unwrap().start().await;
    tick(20).await;
    herdr.status().unwrap().drop_lost().await;
    tick(0).await;
    herdr.hold();
    let second = herdr.status().unwrap();
    second.start().await;
    tick(20).await;
    // the snapshot for `second` is on its way when `second` is lost too
    second.drop_lost().await;
    tick(0).await;
    herdr.set_panes(vec![pane("w1:p1", "idle")]);
    herdr.answer_all();
    tick(10).await;
    assert_eq!(recorder.resyncs(), vec![]);
    let third = herdr.status().unwrap();
    assert!(!Arc::ptr_eq(&third, &second));
    third.start().await;
    // answer whatever is asked, including the reconcile queued behind an earlier one
    for _ in 0..4 {
        tick(5).await;
        herdr.answer_all();
    }
    tick(10).await;
    assert_eq!(recorder.resyncs(), vec![(strings(&["w1:p1"]), vec![])]);
    collector.stop();
}

// server/collector.test.ts: "reconciles when a lifecycle retry starts although the first attempt never did"
#[tokio::test(start_paused = true)]
async fn reconciles_when_a_lifecycle_retry_starts_although_the_first_attempt_never_did() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "idle")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    herdr.set_panes(vec![pane("w1:p1", "idle"), pane("w1:p2", "idle")]);
    herdr.lifecycle().drop_with("connect_failed").await;
    tick(10).await;
    let calls = herdr.snapshot_calls();
    herdr.lifecycle().start().await;
    tick(20).await;
    assert_eq!(recorder.structure(), 1);
    assert!(herdr.snapshot_calls() > calls);
    collector.stop();
}

// server/collector.test.ts: "does nothing more once stopped, even mid-recovery"
#[tokio::test(start_paused = true)]
async fn does_nothing_more_once_stopped_even_mid_recovery() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "working")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    herdr.status().unwrap().start().await;
    tick(20).await;
    herdr.status().unwrap().drop_lost().await;
    herdr.lifecycle().drop_lost().await;
    collector.stop();
    let subscriptions = herdr.subscriptions().len();
    tick(60).await;
    assert_eq!(herdr.subscriptions().len(), subscriptions);
    assert_eq!(recorder.resyncs(), vec![]);
}

/// New: `stop` closes every connection, a second `stop` does nothing, and dropping the
/// subscription stops it too.
#[tokio::test(start_paused = true)]
async fn stop_closes_every_connection_and_drop_stops_too() {
    let herdr = FakeHerdr::new(vec![pane("w1:p1", "idle")]);
    let recorder = Arc::new(Recorder::default());
    let collector = start(&herdr, &recorder, fast());
    tick(0).await;
    collector.stop();
    collector.stop();
    tick(0).await;
    assert!(
        herdr
            .subscriptions()
            .iter()
            .all(|s| s.closed_by_collector())
    );
    let calls = herdr.snapshot_calls();
    tick(120_000).await;
    assert_eq!(herdr.snapshot_calls(), calls);

    let dropped = FakeHerdr::new(vec![pane("w1:p1", "idle")]);
    drop(start(&dropped, &recorder, fast()));
    tick(0).await;
    assert!(
        dropped
            .subscriptions()
            .iter()
            .all(|s| s.closed_by_collector())
    );
}
