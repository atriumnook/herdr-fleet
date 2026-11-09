//! The herdr crate through its public interface: the socket's place, the Windows marker, and
//! (against the fake server in `common/`) the RPC, the response table and the event
//! subscription. The tests marked `#[ignore]` talk to a real herdr: run them against an isolated
//! session (`HERDR_SOCKET` pointing at it), never the one you work in.

// the fake listens on a Unix socket; on Windows herdr is a named pipe (checked in phase 6)
#[cfg(unix)]
mod common;

#[cfg(unix)]
use common::fake_herdr::{self, FakeHerdr, Reply, Step};
#[cfg(unix)]
use herdr_api::methods;
use herdr_fleet_herdr::marker::{
    MARKER_START_SLACK_MS, MarkerOwner, RunningProcess, marker_owner, parse_process_line,
    stale_marker,
};
use herdr_fleet_herdr::socket::socket_path;
use std::ffi::OsString;
use std::path::PathBuf;

mod marker {
    use super::*;

    // a real marker and the process behind it, read from a Windows PC (herdr 0.9.3)
    const MARKER: &str = "26540:1790829888292852700";

    fn daemon() -> RunningProcess {
        RunningProcess {
            name: "herdr".into(),
            started_ms: Some(1790829888236),
        }
    }

    fn process(name: &str, started_ms: Option<i64>) -> RunningProcess {
        RunningProcess {
            name: name.into(),
            started_ms,
        }
    }

    // server/herdr-marker.test.ts: "reads the pid and the start out of herdr's Windows socket marker"
    #[test]
    fn reads_the_pid_and_the_start_out_of_the_marker() {
        assert_eq!(
            marker_owner(MARKER),
            Some(MarkerOwner {
                pid: 26540,
                started_ms: Some(1790829888292)
            })
        );
        assert_eq!(
            marker_owner("4312"),
            Some(MarkerOwner {
                pid: 4312,
                started_ms: None
            })
        );
        assert_eq!(marker_owner(""), None);
        assert_eq!(marker_owner("0:1"), None);
        assert_eq!(marker_owner("abc:1"), None);
    }

    // server/herdr-marker.test.ts: "reads the process the probe printed, and none from an empty answer"
    #[test]
    fn reads_the_process_the_probe_printed() {
        assert_eq!(
            parse_process_line("herdr|1790829888236\r\n"),
            Some(daemon())
        );
        assert_eq!(parse_process_line(""), None);
        assert_eq!(parse_process_line("\r\n"), None);
    }

    // server/herdr-marker.test.ts: "keeps the marker of the daemon that wrote it"
    #[test]
    fn keeps_the_marker_of_the_daemon_that_wrote_it() {
        assert!(!stale_marker(MARKER, |_| Some(daemon())));
        assert!(!stale_marker(MARKER, |_| Some(process(
            "HERDR.EXE",
            Some(1790829888236)
        ))));
    }

    // server/herdr-marker.test.ts: "calls a marker stale when its pid is gone or was handed to another program"
    #[test]
    fn calls_a_marker_stale_when_its_pid_is_gone_or_was_handed_on() {
        assert!(stale_marker(MARKER, |_| None));
        assert!(stale_marker(MARKER, |_| Some(process(
            "svchost",
            Some(1790829888236)
        ))));
        // a name that only contains herdr is not herdr
        assert!(stale_marker(MARKER, |_| Some(process(
            "herdr-fleet",
            Some(1790829888236)
        ))));
    }

    // server/herdr-marker.test.ts: "calls a marker stale when another herdr holds its pid: it started at another time"
    #[test]
    fn calls_a_marker_stale_when_another_herdr_holds_its_pid() {
        assert!(stale_marker(MARKER, |_| Some(process(
            "herdr",
            Some(1790829888236 + 3_600_000)
        ))));
    }

    // server/herdr-marker.test.ts: "falls back to the name when either start is unknown, and never calls an unreadable marker stale"
    #[test]
    fn falls_back_to_the_name_and_never_calls_an_unreadable_marker_stale() {
        assert!(!stale_marker(MARKER, |_| Some(process("herdr", None))));
        assert!(!stale_marker("26540", |_| Some(daemon())));
        assert!(!stale_marker("garbage", |_| None));
    }

    // The slack is 30 seconds (server/herdr-marker.ts MARKER_START_SLACK_MS): 30 s apart is
    // the same daemon, 30.001 s apart is not.
    #[test]
    fn the_start_may_sit_thirty_seconds_from_the_process_creation() {
        assert_eq!(MARKER_START_SLACK_MS, 30_000);
        // the marker says 1790829888292 ms
        assert!(!stale_marker(MARKER, |_| Some(process(
            "herdr",
            Some(1790829888292 - 30_000)
        ))));
        assert!(stale_marker(MARKER, |_| Some(process(
            "herdr",
            Some(1790829888292 - 30_001)
        ))));
    }
}

mod socket {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<OsString> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| OsString::from(value))
        }
    }

    // server/herdr/client.ts herdrSocketPath: HERDR_SOCKET wins
    #[test]
    fn herdr_socket_wins() {
        assert_eq!(
            socket_path(env(&[
                ("HERDR_SOCKET", "/run/x/herdr.sock"),
                ("HOME", "/home/a"),
                ("APPDATA", "C:\\Users\\a\\AppData\\Roaming"),
            ])),
            PathBuf::from("/run/x/herdr.sock")
        );
    }

    // an empty HERDR_SOCKET is no setting: TypeScript tests it for truthiness
    #[cfg(unix)]
    #[test]
    fn an_empty_herdr_socket_falls_back_to_home() {
        assert_eq!(
            socket_path(env(&[("HERDR_SOCKET", ""), ("HOME", "/home/a")])),
            PathBuf::from("/home/a/.config/herdr/herdr.sock")
        );
    }

    #[cfg(unix)]
    #[test]
    fn without_herdr_socket_it_is_under_home() {
        assert_eq!(
            socket_path(env(&[("HOME", "/home/a")])),
            PathBuf::from("/home/a/.config/herdr/herdr.sock")
        );
        // `${process.env.HOME ?? ""}/.config/herdr/herdr.sock`
        assert_eq!(
            socket_path(env(&[])),
            PathBuf::from("/.config/herdr/herdr.sock")
        );
    }
}

#[cfg(unix)]
/// A `pane_info` result for pane `w1:p1`, with the fields the schema requires.
fn pane_info() -> serde_json::Value {
    serde_json::json!({
        "type": "pane_info",
        "pane": {
            "pane_id": "w1:p1",
            "workspace_id": "w1",
            "tab_id": "w1:t1",
            "terminal_id": "term-1",
            "agent_status": "idle",
            "focused": false,
            "revision": 3,
        },
    })
}

#[cfg(unix)]
fn pane_get() -> herdr_api::PaneTarget {
    herdr_api::PaneTarget {
        pane_id: "w1:p1".into(),
    }
}

#[cfg(unix)]
mod rpc {
    use super::*;
    use herdr_fleet_herdr::{Herdr, HerdrError};
    use std::time::{Duration, Instant};

    // server/herdr/client.ts DEFAULT_TIMEOUT_MS
    #[test]
    fn the_default_time_limit_is_ten_seconds() {
        assert_eq!(Herdr::DEFAULT_TIMEOUT, Duration::from_secs(10));
    }

    #[tokio::test]
    async fn sends_one_ndjson_request_and_reads_the_result() {
        let fake = FakeHerdr::start(|request| Reply::result(request, pane_info()));
        let herdr = Herdr::new(fake.socket());

        let result = herdr.rpc::<methods::PaneGet>(pane_get()).await.unwrap();

        let herdr_api::ResponseResult::PaneInfo(info) = result else {
            panic!("expected pane_info, got {result:?}");
        };
        assert_eq!(info.pane.pane_id, "w1:p1");
        let requests = fake.requests();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request["method"], "pane.get");
        assert_eq!(request["params"], serde_json::json!({ "pane_id": "w1:p1" }));
        // `br-<time in base 36>-<counter>`, as nextId writes it
        let id = request["id"].as_str().expect("a string id");
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 3, "{id}");
        assert_eq!(parts[0], "br");
        assert!(
            parts[1]
                .chars()
                .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
        );
        assert!(parts[2].parse::<u64>().is_ok(), "{id}");
        let keys: Vec<&String> = request.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["id", "method", "params"]);
    }

    // server/herdr/client.test.ts: "issues a fresh connection per call, so sequential calls both
    // succeed" (here against the fake, which answers one request per connection as herdr does)
    #[tokio::test]
    async fn opens_a_connection_per_request() {
        let fake = FakeHerdr::start(|request| Reply::result(request, pane_info()));
        let herdr = Herdr::new(fake.socket());

        herdr.rpc::<methods::PaneGet>(pane_get()).await.unwrap();
        herdr.rpc::<methods::PaneGet>(pane_get()).await.unwrap();

        let requests = fake.requests();
        assert_eq!(requests.len(), 2);
        assert_ne!(requests[0]["id"], requests[1]["id"]);
    }

    #[tokio::test]
    async fn joins_a_line_split_across_reads() {
        let fake = FakeHerdr::start(|request| {
            let line = format!(
                "{}\n",
                serde_json::json!({ "id": request["id"], "result": pane_info() })
            );
            // split inside a multibyte character too: "é" is two bytes
            let line = line.replace("term-1", "term-é");
            let bytes = line.into_bytes();
            let at = bytes.windows(2).position(|w| w == "é".as_bytes()).unwrap() + 1;
            Reply {
                steps: vec![
                    Step::Write(bytes[..at].to_vec()),
                    Step::Wait(Duration::from_millis(50)),
                    Step::Write(bytes[at..].to_vec()),
                ],
                close: true,
            }
        });
        let herdr = Herdr::new(fake.socket());

        let result = herdr.rpc::<methods::PaneGet>(pane_get()).await.unwrap();

        let herdr_api::ResponseResult::PaneInfo(info) = result else {
            panic!("expected pane_info, got {result:?}");
        };
        assert_eq!(info.pane.terminal_id, "term-é");
    }

    #[tokio::test]
    async fn skips_blank_lines_before_the_answer() {
        let fake = FakeHerdr::start(|request| {
            let line = serde_json::json!({ "id": request["id"], "result": pane_info() });
            Reply::raw(format!("\n   \r\n  {line}  \n").as_bytes())
        });
        let herdr = Herdr::new(fake.socket());

        let result = herdr.rpc::<methods::PaneGet>(pane_get()).await;

        assert!(
            matches!(result, Ok(herdr_api::ResponseResult::PaneInfo(_))),
            "{result:?}"
        );
    }

    #[tokio::test]
    async fn returns_herdrs_error_with_its_code() {
        let fake = FakeHerdr::start(|request| {
            Reply::error(request, "pane_not_found", "pane w1:p1 not found")
        });
        let herdr = Herdr::new(fake.socket());

        let error = herdr.rpc::<methods::PaneGet>(pane_get()).await.unwrap_err();

        assert_eq!(
            error,
            HerdrError::Herdr {
                code: "pane_not_found".into(),
                message: "pane w1:p1 not found".into(),
            }
        );
        assert_eq!(error.code(), "pane_not_found");
        assert_eq!(error.message(), "pane w1:p1 not found");
    }

    // `const { code = "herdr_error", message = "herdr request failed" } = frame.error`
    #[tokio::test]
    async fn an_error_without_code_or_message_gets_the_defaults() {
        let fake = FakeHerdr::start(|request| {
            Reply::line(serde_json::json!({ "id": request["id"], "error": {} }))
        });
        let herdr = Herdr::new(fake.socket());

        let error = herdr.rpc::<methods::PaneGet>(pane_get()).await.unwrap_err();

        assert_eq!(error.code(), "herdr_error");
        assert_eq!(error.message(), "herdr request failed");
    }

    #[tokio::test]
    async fn an_unparseable_frame_is_a_bad_frame() {
        let fake = FakeHerdr::start(|_| Reply::raw(b"not json\n"));
        let herdr = Herdr::new(fake.socket());

        let error = herdr.rpc::<methods::PaneGet>(pane_get()).await.unwrap_err();

        assert_eq!(error.code(), "bad_frame");
        assert_eq!(error.message(), "herdr sent unparseable frame: not json");
    }

    // `line.slice(0, 200)`
    #[tokio::test]
    async fn a_bad_frame_quotes_at_most_200_characters() {
        let fake = FakeHerdr::start(|_| Reply::raw(format!("{}\n", "x".repeat(300)).as_bytes()));
        let herdr = Herdr::new(fake.socket());

        let error = herdr.rpc::<methods::PaneGet>(pane_get()).await.unwrap_err();

        assert_eq!(
            error.message(),
            format!("herdr sent unparseable frame: {}", "x".repeat(200))
        );
    }

    // ADR 0242-phase-3-split: `rpc` returns `ResponseResult`, so a result that is none of its
    // shapes is a bad frame (TypeScript passed any value on)
    #[tokio::test]
    async fn a_result_that_is_no_response_shape_is_a_bad_frame() {
        let fake =
            FakeHerdr::start(|request| Reply::result(request, serde_json::json!({ "pane": {} })));
        let herdr = Herdr::new(fake.socket());

        let error = herdr.rpc::<methods::PaneGet>(pane_get()).await.unwrap_err();

        assert_eq!(error.code(), "bad_frame");
    }

    #[tokio::test]
    async fn gives_up_after_the_time_limit_the_caller_passes() {
        let fake = FakeHerdr::start(|_| Reply::silent());
        let herdr = Herdr::new(fake.socket());
        let started = Instant::now();

        let error = herdr
            .with_timeout(Duration::from_millis(150))
            .rpc::<methods::PaneGet>(pane_get())
            .await
            .unwrap_err();

        let waited = started.elapsed();
        assert_eq!(error.code(), "timeout");
        assert_eq!(error.message(), "herdr pane.get timed out after 150ms");
        assert!(waited >= Duration::from_millis(150), "{waited:?}");
        assert!(waited < Duration::from_secs(5), "{waited:?}");
    }

    #[tokio::test]
    async fn a_close_before_the_answer_is_closed() {
        let fake = FakeHerdr::start(|_| Reply::close());
        let herdr = Herdr::new(fake.socket());

        let error = herdr.rpc::<methods::PaneGet>(pane_get()).await.unwrap_err();

        assert_eq!(error.code(), "closed");
        assert_eq!(
            error.message(),
            "herdr closed the connection before answering pane.get"
        );
    }

    #[tokio::test]
    async fn a_half_line_then_a_close_is_closed() {
        let fake = FakeHerdr::start(|_| Reply::raw(b"{\"id\":\"x\",\"res"));
        let herdr = Herdr::new(fake.socket());

        let error = herdr.rpc::<methods::PaneGet>(pane_get()).await.unwrap_err();

        assert_eq!(error.code(), "closed");
    }

    #[tokio::test]
    async fn a_socket_nobody_listens_on_is_connect_failed() {
        let dir = fake_herdr::fresh_dir();
        let path = dir.join("herdr.sock");
        let herdr = Herdr::new(&path);

        let error = herdr.rpc::<methods::PaneGet>(pane_get()).await.unwrap_err();

        assert_eq!(error.code(), "connect_failed");
        let prefix = format!("cannot reach herdr at {}: ", path.display());
        assert!(error.message().starts_with(&prefix), "{}", error.message());
        let _ = std::fs::remove_dir_all(dir);
    }

    // only the first frame answers: herdr sends one response per connection
    #[tokio::test]
    async fn the_first_frame_answers() {
        let fake = FakeHerdr::start(|request| {
            let first = serde_json::json!({ "id": request["id"], "result": { "type": "ok" } });
            Reply::raw(format!("{first}\n{{garbage\n").as_bytes())
        });
        let herdr = Herdr::new(fake.socket());

        let result = herdr.rpc::<methods::PaneClose>(pane_get()).await;

        assert_eq!(result, Ok(herdr_api::ResponseResult::Ok));
    }
}

#[cfg(unix)]
mod answer {
    use super::*;
    use herdr_fleet_herdr::Herdr;

    #[tokio::test]
    async fn call_turns_the_result_into_the_methods_shape() {
        let fake = FakeHerdr::start(|request| Reply::result(request, pane_info()));
        let herdr = Herdr::new(fake.socket());

        let answer = herdr.call::<methods::PaneGet>(pane_get()).await.unwrap();

        assert_eq!(answer.pane.pane_id, "w1:p1");
        assert_eq!(answer.pane.revision, 3);
    }

    #[tokio::test]
    async fn an_ok_answer_is_unit() {
        let fake =
            FakeHerdr::start(|request| Reply::result(request, serde_json::json!({ "type": "ok" })));
        let herdr = Herdr::new(fake.socket());

        let answer: () = herdr.call::<methods::PaneClose>(pane_get()).await.unwrap();

        assert_eq!(answer, ());
    }

    #[tokio::test]
    async fn another_shape_than_the_table_says_is_a_bad_frame() {
        let fake =
            FakeHerdr::start(|request| Reply::result(request, serde_json::json!({ "type": "ok" })));
        let herdr = Herdr::new(fake.socket());

        let error = herdr
            .call::<methods::PaneGet>(pane_get())
            .await
            .unwrap_err();

        assert_eq!(error.code(), "bad_frame");
        assert!(error.message().contains("pane.get"), "{}", error.message());
        assert!(error.message().contains("pane_info"), "{}", error.message());
        assert!(error.message().contains("ok"), "{}", error.message());
    }

    #[tokio::test]
    async fn herdrs_error_passes_through_call() {
        let fake = FakeHerdr::start(|request| Reply::error(request, "agent_blocked", "blocked"));
        let herdr = Herdr::new(fake.socket());

        let error = herdr
            .call::<methods::PaneGet>(pane_get())
            .await
            .unwrap_err();

        assert_eq!(error.code(), "agent_blocked");
    }
}

#[cfg(unix)]
mod subscribe {
    use super::*;
    use herdr_fleet_herdr::{EventFrame, EventSource, EventStream, Herdr, StreamItem};
    use std::time::Duration;

    const WITHIN: Duration = Duration::from_secs(5);

    fn workspace_focused() -> Vec<herdr_api::Subscription> {
        vec![herdr_api::Subscription::WorkspaceFocused]
    }

    async fn next(stream: &mut EventStream) -> Option<StreamItem> {
        tokio::time::timeout(WITHIN, stream.next())
            .await
            .expect("the stream answered within 5 s")
    }

    fn line(value: serde_json::Value) -> Step {
        Step::Write(format!("{value}\n").into_bytes())
    }

    fn started(request: &serde_json::Value) -> Step {
        line(
            serde_json::json!({ "id": request["id"], "result": { "type": "subscription_started" } }),
        )
    }

    fn status(pane: &str, status: &str) -> serde_json::Value {
        serde_json::json!({
            "event": "pane.agent_status_changed",
            "data": { "pane_id": pane, "agent_status": status },
        })
    }

    #[tokio::test]
    async fn sends_events_subscribe_then_streams_frames_after_it_started() {
        let fake = FakeHerdr::start(|request| Reply {
            steps: vec![
                started(request),
                line(status("w1:p1", "working")),
                Step::Wait(Duration::from_millis(30)),
                line(serde_json::json!({
                    "event": "pane_closed",
                    "data": { "type": "pane_closed", "pane_id": "w1:p2" },
                })),
            ],
            close: false,
        });
        let herdr = Herdr::new(fake.socket());

        let mut stream = herdr.subscribe(vec![
            herdr_api::Subscription::PaneAgentStatusChanged(
                herdr_api::SubscriptionPaneAgentStatusChanged {
                    pane_id: "w1:p1".into(),
                    agent_status: None,
                },
            ),
            herdr_api::Subscription::PaneClosed,
        ]);

        assert_eq!(next(&mut stream).await, Some(StreamItem::Started));
        assert_eq!(
            next(&mut stream).await,
            Some(StreamItem::Event(EventFrame {
                event: Some("pane.agent_status_changed".into()),
                data: serde_json::json!({ "pane_id": "w1:p1", "agent_status": "working" }),
            }))
        );
        assert_eq!(
            next(&mut stream).await,
            Some(StreamItem::Event(EventFrame {
                event: Some("pane_closed".into()),
                data: serde_json::json!({ "type": "pane_closed", "pane_id": "w1:p2" }),
            }))
        );
        let requests = fake.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["method"], "events.subscribe");
        assert_eq!(
            requests[0]["params"],
            serde_json::json!({ "subscriptions": [
                { "type": "pane.agent_status_changed", "pane_id": "w1:p1" },
                { "type": "pane.closed" },
            ] })
        );
        assert!(requests[0]["id"].as_str().unwrap().starts_with("br-"));
    }

    #[tokio::test]
    async fn joins_a_frame_split_across_reads() {
        let fake = FakeHerdr::start(|request| {
            let frame = format!("{}\n", status("w1:p1", "done"));
            let (head, tail) = frame.split_at(20);
            Reply {
                steps: vec![
                    started(request),
                    Step::Write(head.as_bytes().to_vec()),
                    Step::Wait(Duration::from_millis(50)),
                    Step::Write(tail.as_bytes().to_vec()),
                ],
                close: false,
            }
        });
        let herdr = Herdr::new(fake.socket());
        let mut stream = herdr.subscribe(workspace_focused());

        assert_eq!(next(&mut stream).await, Some(StreamItem::Started));
        let Some(StreamItem::Event(frame)) = next(&mut stream).await else {
            panic!("expected an event");
        };
        assert_eq!(frame.data["agent_status"], "done");
    }

    // an unparseable line is skipped; an error frame is told and the stream goes on
    #[tokio::test]
    async fn skips_unparseable_lines_and_tells_error_frames() {
        let fake = FakeHerdr::start(|request| Reply {
            steps: vec![
                started(request),
                Step::Write(b"{nope\n".to_vec()),
                line(
                    serde_json::json!({ "error": { "code": "events_lost", "message": "fell behind" } }),
                ),
                line(serde_json::json!({ "error": {} })),
                line(status("w1:p1", "idle")),
            ],
            close: false,
        });
        let herdr = Herdr::new(fake.socket());
        let mut stream = herdr.subscribe(workspace_focused());

        assert_eq!(next(&mut stream).await, Some(StreamItem::Started));
        let Some(StreamItem::Error(error)) = next(&mut stream).await else {
            panic!("expected an error");
        };
        assert_eq!(
            (error.code(), error.message()),
            ("events_lost", "fell behind")
        );
        // `frame.error.code ?? "herdr_error"`, `frame.error.message ?? "subscription failed"`
        let Some(StreamItem::Error(error)) = next(&mut stream).await else {
            panic!("expected an error");
        };
        assert_eq!(
            (error.code(), error.message()),
            ("herdr_error", "subscription failed")
        );
        assert!(matches!(
            next(&mut stream).await,
            Some(StreamItem::Event(_))
        ));
    }

    // TypeScript hands every frame but the first subscription_started to onEvent
    #[tokio::test]
    async fn only_the_first_subscription_started_is_the_start() {
        let fake = FakeHerdr::start(|request| Reply {
            steps: vec![
                line(status("w1:p1", "idle")),
                started(request),
                started(request),
            ],
            close: false,
        });
        let herdr = Herdr::new(fake.socket());
        let mut stream = herdr.subscribe(workspace_focused());

        assert!(matches!(
            next(&mut stream).await,
            Some(StreamItem::Event(_))
        ));
        assert_eq!(next(&mut stream).await, Some(StreamItem::Started));
        let Some(StreamItem::Event(frame)) = next(&mut stream).await else {
            panic!("expected the second start as an event");
        };
        assert_eq!(frame.event, None);
        assert_eq!(frame.data, serde_json::Value::Null);
    }

    // a frame that is not an object, or whose event is not a string, is an event of neither
    #[tokio::test]
    async fn a_frame_without_a_string_event_has_none() {
        let fake = FakeHerdr::start(|request| Reply {
            steps: vec![
                started(request),
                Step::Write(b"5\n".to_vec()),
                line(serde_json::json!({ "event": 7, "data": "text" })),
            ],
            close: false,
        });
        let herdr = Herdr::new(fake.socket());
        let mut stream = herdr.subscribe(workspace_focused());

        assert_eq!(next(&mut stream).await, Some(StreamItem::Started));
        assert_eq!(
            next(&mut stream).await,
            Some(StreamItem::Event(EventFrame {
                event: None,
                data: serde_json::Value::Null
            }))
        );
        assert_eq!(
            next(&mut stream).await,
            Some(StreamItem::Event(EventFrame {
                event: None,
                data: serde_json::json!("text")
            }))
        );
    }

    // herdr closes a subscription that fell behind: the stream ends, and nothing reconnects
    #[tokio::test]
    async fn ends_when_herdr_closes_and_does_not_reconnect() {
        let fake = FakeHerdr::start(|request| Reply {
            steps: vec![started(request), line(status("w1:p1", "idle"))],
            close: true,
        });
        let herdr = Herdr::new(fake.socket());
        let mut stream = herdr.subscribe(workspace_focused());

        assert_eq!(next(&mut stream).await, Some(StreamItem::Started));
        assert!(matches!(
            next(&mut stream).await,
            Some(StreamItem::Event(_))
        ));
        assert_eq!(next(&mut stream).await, None);
        assert_eq!(next(&mut stream).await, None);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(fake.requests().len(), 1);
    }

    // server/herdr/client.test.ts: "reports a connect that fails as closed, so a subscriber
    // retrying on close retries" (here without a herdr: the path has no socket)
    #[tokio::test]
    async fn a_connect_that_fails_is_told_then_the_stream_ends() {
        let herdr = Herdr::new("/nonexistent/herdr-fleet-test.sock");
        let mut stream = herdr.subscribe(workspace_focused());

        let Some(StreamItem::Error(error)) = next(&mut stream).await else {
            panic!("expected connect_failed");
        };
        assert_eq!(error.code(), "connect_failed");
        assert_eq!(next(&mut stream).await, None);
    }

    // closed by the caller: dropping the stream closes herdr's connection
    #[tokio::test]
    async fn dropping_the_stream_closes_the_connection() {
        let fake = FakeHerdr::start(|request| Reply {
            steps: vec![
                started(request),
                line(status("w1:p1", "working")),
                line(status("w1:p1", "idle")),
            ],
            close: false,
        });
        let herdr = Herdr::new(fake.socket());
        let mut stream = herdr.subscribe(workspace_focused());
        assert_eq!(next(&mut stream).await, Some(StreamItem::Started));

        drop(stream);

        let deadline = tokio::time::Instant::now() + WITHIN;
        while fake.ended_by_client() == 0 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(fake.ended_by_client(), 1);
    }

    // dropped before it connected: a connection that opened anyway is closed
    #[tokio::test]
    async fn a_stream_dropped_at_once_leaves_no_connection() {
        let fake = FakeHerdr::start(|request| Reply {
            steps: vec![started(request)],
            close: false,
        });
        let herdr = Herdr::new(fake.socket());

        drop(herdr.subscribe(workspace_focused()));

        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(fake.ended_by_client() as usize, fake.requests().len());
    }

    // the stream H3's tests build without a socket
    #[tokio::test]
    async fn a_channel_feeds_a_stream_until_the_sender_goes() {
        let (sender, mut stream) = EventStream::channel();
        assert!(sender.send(StreamItem::Started).await);
        drop(sender);

        assert_eq!(next(&mut stream).await, Some(StreamItem::Started));
        assert_eq!(next(&mut stream).await, None);
    }

    #[tokio::test]
    async fn a_sender_knows_when_the_stream_was_closed() {
        let (sender, stream) = EventStream::channel();
        assert!(!sender.is_closed());

        drop(stream);

        assert!(sender.is_closed());
        assert!(!sender.send(StreamItem::Started).await);
    }
}

#[cfg(unix)]
mod event_source {
    use super::*;
    use herdr_fleet_herdr::{EventSource, Herdr, StreamItem};
    use std::sync::Arc;

    fn snapshot() -> serde_json::Value {
        let pane = pane_info()["pane"].clone();
        serde_json::json!({
            "type": "session_snapshot",
            "snapshot": {
                "version": "0.9.1",
                "protocol": 22,
                "workspaces": [],
                "tabs": [],
                "panes": [pane],
                "agents": [],
                "layouts": [],
            },
        })
    }

    #[tokio::test]
    async fn the_client_is_an_event_source() {
        let fake = FakeHerdr::start(|request| match request["method"].as_str() {
            Some("session.snapshot") => Reply::result(request, snapshot()),
            _ => Reply::result(
                request,
                serde_json::json!({ "type": "subscription_started" }),
            ),
        });
        let source: Arc<dyn EventSource> = Arc::new(Herdr::new(fake.socket()));

        let panes = source.snapshot().await.unwrap();
        let mut stream = source.subscribe(vec![herdr_api::Subscription::PaneCreated]);

        assert_eq!(panes.len(), 1);
        assert_eq!(panes[0].pane_id, "w1:p1");
        assert_eq!(stream.next().await, Some(StreamItem::Started));
        let methods: Vec<serde_json::Value> = fake
            .requests()
            .iter()
            .map(|r| r["method"].clone())
            .collect();
        assert_eq!(methods, ["session.snapshot", "events.subscribe"]);
    }
}

#[cfg(unix)]
/// Against a real herdr. `HERDR_SOCKET` must name an isolated session's socket
/// (`~/.config/herdr/sessions/herdr-fleet-rs-<run id>/herdr.sock`): these tests create and close
/// workspaces and start an agent (pi, sent only its local `/hotkeys` command).
mod live {
    use super::*;
    use herdr_fleet_herdr::ANSWERS;
    use herdr_fleet_herdr::{EventSource, Herdr, StreamItem};
    use serde::de::DeserializeOwned;
    use std::collections::BTreeSet;
    use std::time::Duration;

    /// One live test at a time: a test that compares two snapshots must not see another test's
    /// workspace come or go between them (TypeScript runs a file's tests one after another).
    static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    async fn herdr() -> (Herdr, tokio::sync::MutexGuard<'static, ()>) {
        let turn = ONE_AT_A_TIME.lock().await;
        let socket = std::env::var_os("HERDR_SOCKET")
            .expect("set HERDR_SOCKET to an isolated herdr session's socket");
        assert!(
            socket.to_string_lossy().contains("herdr-fleet-rs-"),
            "HERDR_SOCKET must name a session herdr-fleet-rs-<run id>, not the one you work in"
        );
        (Herdr::new(socket_path(|name| std::env::var_os(name))), turn)
    }

    fn params<P: DeserializeOwned>(value: serde_json::Value) -> P {
        serde_json::from_value(value).expect("params of the schema")
    }

    /// A workspace in /tmp, as scripts/test-herdr.ts makes sure one exists; closed by the caller.
    async fn workspace(herdr: &Herdr, label: &str) -> herdr_api::ResponseResultWorkspaceCreated {
        herdr
            .call::<methods::WorkspaceCreate>(params(serde_json::json!({
                "cwd": "/tmp", "label": label, "focus": false,
            })))
            .await
            .unwrap()
    }

    async fn close_workspace(herdr: &Herdr, workspace_id: &str) {
        let _ = herdr
            .rpc::<methods::WorkspaceClose>(params(
                serde_json::json!({ "workspace_id": workspace_id }),
            ))
            .await;
    }

    // server/herdr/client.test.ts: ping "reaches the live herdr server and reports its protocol"
    #[tokio::test]
    #[ignore = "needs an isolated herdr session"]
    async fn ping_reaches_herdr_and_reports_its_protocol() {
        let (herdr, _turn) = herdr().await;
        let pong = herdr
            .call::<methods::Ping>(params(serde_json::json!({})))
            .await
            .unwrap();
        assert!(!pong.version.is_empty());
        assert!(pong.protocol > 0);
    }

    // server/herdr/client.test.ts: sessionSnapshot "returns the live workspace/tab/pane tree"
    #[tokio::test]
    #[ignore = "needs an isolated herdr session"]
    async fn session_snapshot_returns_the_tree() {
        let (herdr, _turn) = herdr().await;
        let created = workspace(&herdr, "client-snapshot").await;

        let snapshot = herdr
            .call::<methods::SessionSnapshot>(params(serde_json::json!({})))
            .await
            .map(|answer| answer.snapshot);

        close_workspace(&herdr, &created.workspace.workspace_id).await;
        let snapshot = snapshot.unwrap();
        assert!(!snapshot.workspaces.is_empty());
        assert!(!snapshot.panes.is_empty());
        for workspace in &snapshot.workspaces {
            assert!(!workspace.workspace_id.is_empty());
        }
        for pane in &snapshot.panes {
            assert!(!pane.pane_id.is_empty());
            assert!(!pane.workspace_id.is_empty());
        }
    }

    // server/herdr/client.test.ts: sessionSnapshot "issues a fresh connection per call, so
    // sequential calls both succeed"
    #[tokio::test]
    #[ignore = "needs an isolated herdr session"]
    async fn sequential_snapshots_both_succeed() {
        let (herdr, _turn) = herdr().await;
        let snapshot = || herdr.call::<methods::SessionSnapshot>(params(serde_json::json!({})));
        let first = snapshot().await.unwrap().snapshot;
        let second = snapshot().await.unwrap().snapshot;
        assert_eq!(first.workspaces.len(), second.workspaces.len());
    }

    // server/herdr/client.test.ts: paneRead "returns terminal text for a live pane and echoes its id"
    #[tokio::test]
    #[ignore = "needs an isolated herdr session"]
    async fn pane_read_echoes_the_pane() {
        let (herdr, _turn) = herdr().await;
        let created = workspace(&herdr, "client-read").await;
        let pane = created.root_pane.pane_id.clone();

        let read = herdr
            .call::<methods::PaneRead>(params(serde_json::json!({
                "pane_id": pane, "source": "visible", "format": "text", "strip_ansi": true,
            })))
            .await;

        close_workspace(&herdr, &created.workspace.workspace_id).await;
        assert_eq!(read.unwrap().read.pane_id, pane);
    }

    // server/herdr/client.test.ts: paneRead "keeps escape sequences when reading ansi"
    // (paneRead turns strip_ansi off for an ansi read; the caller passes it here)
    #[tokio::test]
    #[ignore = "needs an isolated herdr session"]
    async fn pane_read_in_ansi() {
        let (herdr, _turn) = herdr().await;
        let created = workspace(&herdr, "client-ansi").await;

        let read = herdr
            .call::<methods::PaneRead>(params(serde_json::json!({
                "pane_id": created.root_pane.pane_id, "source": "visible", "format": "ansi",
                "strip_ansi": false,
            })))
            .await;

        close_workspace(&herdr, &created.workspace.workspace_id).await;
        assert_eq!(read.unwrap().read.format, herdr_api::ReadFormat::Ansi);
    }

    // server/herdr/client.test.ts: paneRead "rejects an unknown pane with a coded HerdrError"
    #[tokio::test]
    #[ignore = "needs an isolated herdr session"]
    async fn an_unknown_pane_is_a_coded_error() {
        let (herdr, _turn) = herdr().await;
        let error = herdr
            .call::<methods::PaneRead>(params(serde_json::json!({
                "pane_id": "w9999:p9999", "source": "visible",
            })))
            .await
            .unwrap_err();
        assert!(!error.code().is_empty());
        // a timeout would mean the client hung rather than parsed the server's refusal
        assert_ne!(error.code(), "timeout");
    }

    // server/herdr/client.test.ts: subscribeEvents "opens a streaming connection and closes cleanly"
    #[tokio::test]
    #[ignore = "needs an isolated herdr session"]
    async fn a_subscription_starts_and_closes() {
        let (herdr, _turn) = herdr().await;
        let created = workspace(&herdr, "client-subscribe").await;

        let mut stream = herdr.subscribe(vec![
            // `Subscription::PaneUpdated` names no pane: send the TypeScript request as it is
            herdr_api::Subscription::Other(
                serde_json::json!({ "type": "pane.updated", "pane_id": created.root_pane.pane_id }),
            ),
            herdr_api::Subscription::WorkspaceFocused,
        ]);
        let first = tokio::time::timeout(Duration::from_secs(5), stream.next()).await;
        drop(stream);

        close_workspace(&herdr, &created.workspace.workspace_id).await;
        assert_eq!(
            first.expect("subscription_started within 5 s"),
            Some(StreamItem::Started)
        );
    }

    /// Every method of the table, against herdr: `call` fails with `bad_frame` when herdr
    /// answers another shape than the table says.
    #[tokio::test]
    #[ignore = "needs an isolated herdr session, git and pi"]
    async fn herdr_answers_each_method_in_the_tables_shape() {
        let (herdr, _turn) = herdr().await;
        let mut called = BTreeSet::new();
        let dir = fake_herdr::fresh_dir();
        let dir_text = dir.to_string_lossy().into_owned();

        // ping, session.snapshot
        herdr
            .call::<methods::Ping>(params(serde_json::json!({})))
            .await
            .unwrap();
        called.insert("ping");
        herdr
            .call::<methods::SessionSnapshot>(params(serde_json::json!({})))
            .await
            .unwrap();
        called.insert("session.snapshot");
        // workspace.create, tab.create, pane.split, pane.get, pane.read, pane.report_metadata
        let created = herdr
            .call::<methods::WorkspaceCreate>(params(serde_json::json!({
                "cwd": dir_text, "label": "client-table", "env": { "A": "1" }, "focus": false,
            })))
            .await
            .unwrap();
        called.insert("workspace.create");
        let workspace_id = created.workspace.workspace_id.clone();
        let root = created.root_pane.pane_id.clone();
        let result = async {
            herdr
                .call::<methods::TabCreate>(params(serde_json::json!({
                    "workspace_id": workspace_id, "cwd": dir_text, "label": "t", "env": { "A": "1" },
                    "focus": false,
                })))
                .await?;
            called.insert("tab.create");
            let split = herdr
                .call::<methods::PaneSplit>(params(serde_json::json!({
                    "target_pane_id": root, "direction": "right", "cwd": dir_text,
                    "env": { "A": "1" }, "focus": false,
                })))
                .await?;
            called.insert("pane.split");
            let pane = split.pane.pane_id;
            herdr
                .call::<methods::PaneGet>(params(serde_json::json!({ "pane_id": pane })))
                .await?;
            called.insert("pane.get");
            herdr
                .call::<methods::PaneRead>(params(serde_json::json!({
                    "pane_id": pane, "source": "recent", "lines": 40,
                })))
                .await?;
            called.insert("pane.read");
            herdr
                .call::<methods::PaneReportMetadata>(params(serde_json::json!({
                    "pane_id": pane, "source": "herdr-fleet", "title": "client table",
                })))
                .await?;
            called.insert("pane.report_metadata");

            // agent.start, agent.get, agent.focus, agent.send_keys, agent.read, agent.prompt
            let name = format!("client-table-{}", std::process::id());
            herdr
                .call::<methods::AgentStart>(params(serde_json::json!({
                    "name": name, "kind": "pi", "pane_id": pane, "args": ["--no-session"],
                })))
                .await?;
            called.insert("agent.start");
            let mut ready = false;
            for _ in 0..120 {
                let agent = herdr
                    .call::<methods::AgentGet>(params(serde_json::json!({ "target": name })))
                    .await?;
                if agent.agent.interactive_ready == Some(true) {
                    ready = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            assert!(ready, "pi became ready within 30 s");
            called.insert("agent.get");
            herdr
                .call::<methods::AgentFocus>(params(serde_json::json!({ "target": name })))
                .await?;
            called.insert("agent.focus");
            herdr
                .call::<methods::AgentSendKeys>(params(serde_json::json!({
                    "target": name, "keys": ["esc"],
                })))
                .await?;
            called.insert("agent.send_keys");
            herdr
                .call::<methods::AgentRead>(params(serde_json::json!({
                    "target": name, "source": "recent_unwrapped", "lines": 20,
                })))
                .await?;
            called.insert("agent.read");
            // a command pi answers itself, without its model
            herdr
                .call::<methods::AgentPrompt>(params(serde_json::json!({
                    "target": name, "text": "/hotkeys",
                })))
                .await?;
            called.insert("agent.prompt");

            // pane.close
            herdr
                .call::<methods::PaneClose>(params(serde_json::json!({ "pane_id": pane })))
                .await?;
            called.insert("pane.close");

            // worktree.create, in a fresh repository
            let repo = dir.join("repo");
            let git = |args: &[&str]| {
                let status = std::process::Command::new("git")
                    .args(["-c", "core.fsmonitor=false"])
                    .args(args)
                    .status()
                    .expect("run git");
                assert!(status.success(), "git {args:?}");
            };
            git(&["init", "-q", &repo.to_string_lossy()]);
            git(&[
                "-C", &repo.to_string_lossy(), "-c", "user.email=e2e@example.invalid", "-c",
                "user.name=e2e", "commit", "-q", "--allow-empty", "-m", "init",
            ]);
            let worktree = herdr
                .call::<methods::WorktreeCreate>(params(serde_json::json!({
                    "cwd": repo, "branch": "fleet/t1", "label": "client-table-worktree",
                    "focus": false, "path": repo.join(".wt").join("t1"),
                })))
                .await?;
            called.insert("worktree.create");
            close_workspace(&herdr, &worktree.workspace.workspace_id).await;
            Ok::<(), herdr_fleet_herdr::HerdrError>(())
        }
        .await;

        close_workspace(&herdr, &workspace_id).await;
        let _ = std::fs::remove_dir_all(&dir);
        result.unwrap();
        let table: BTreeSet<&str> = ANSWERS.iter().map(|(method, _)| *method).collect();
        assert_eq!(called, table, "every method of the table, and only those");
    }
}
