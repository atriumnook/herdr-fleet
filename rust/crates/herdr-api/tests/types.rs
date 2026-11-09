//! The generated types read and write the JSON herdr's socket API speaks. The JSON is written by
//! hand from `scripts/herdr-schema.json` (protocol 22) and from the frames of
//! `server/collector.test.ts`; the counts (102 methods, 63 response shapes, 26 events) are the
//! issue's (#245).

use std::collections::HashSet;
use std::fs;
use std::marker::PhantomData;
use std::path::Path;

use herdr_fleet_herdr_api::{
    AgentStatus, AgentViewFilter, EventData, EventDataPaneCreated, EventDataPaneExited,
    EventEnvelope, EventKind, EventMatch, LayoutNode, LayoutNodePane, LayoutNodeSplit,
    METHOD_NAMES, Method, OutputMatch, PaneInfo, PaneMoveDestination, PaneReadParams, PopupSize,
    ReadSource, ResponseResult, ResponseResultPong, SessionSnapshot, SplitDirection, Subscription,
    SubscriptionEventData, SubscriptionEventEnvelope, SubscriptionPaneAgentStatusChanged,
    SuccessResponse, methods,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn schema() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../scripts/herdr-schema.json");
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

/// The `const` values of the discriminator `key` in the variants of a `oneOf`.
fn tags(union: &Value, key: &str) -> Vec<String> {
    union["oneOf"]
        .as_array()
        .unwrap()
        .iter()
        .map(|variant| {
            variant["properties"][key]["const"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect()
}

fn same_type<T>(_: PhantomData<T>, _: PhantomData<T>) {}

fn params_of<M: Method>() -> PhantomData<M::Params> {
    PhantomData
}

#[test]
fn every_method_has_a_marker_with_its_name_and_params() {
    assert_eq!(METHOD_NAMES.len(), 102);
    let unique: HashSet<&str> = METHOD_NAMES.iter().copied().collect();
    assert_eq!(unique.len(), 102);
    let request = &schema()["schemas"]["request"];
    let mut in_schema = tags(request, "method");
    in_schema.sort();
    let mut generated: Vec<String> = METHOD_NAMES.iter().map(|name| name.to_string()).collect();
    generated.sort();
    assert_eq!(generated, in_schema);

    assert_eq!(methods::Ping::NAME, "ping");
    assert_eq!(methods::AgentStart::NAME, "agent.start");
    assert_eq!(methods::PaneRead::NAME, "pane.read");
    assert_eq!(methods::EventsSubscribe::NAME, "events.subscribe");
    assert_eq!(
        methods::ServerSshAgentRegister::NAME,
        "server.ssh_agent.register"
    );
    same_type(
        params_of::<methods::PaneRead>(),
        PhantomData::<PaneReadParams>,
    );
    same_type(
        params_of::<methods::EventsSubscribe>(),
        PhantomData::<herdr_fleet_herdr_api::EventsSubscribeParams>,
    );
    same_type(
        params_of::<methods::AgentStart>(),
        PhantomData::<herdr_fleet_herdr_api::AgentStartParams>,
    );
}

#[test]
fn a_request_writes_only_the_fields_it_sets() {
    let params = PaneReadParams {
        pane_id: "w1:p1".to_owned(),
        source: ReadSource::RecentUnwrapped,
        format: None,
        lines: Some(40),
        strip_ansi: None,
    };
    assert_eq!(
        serde_json::to_value(&params).unwrap(),
        json!({ "pane_id": "w1:p1", "source": "recent_unwrapped", "lines": 40 }),
    );
    // EmptyParams must be `{}`, never `null`
    assert_eq!(
        serde_json::to_value(herdr_fleet_herdr_api::EmptyParams {}).unwrap(),
        json!({}),
    );
}

#[test]
fn a_subscription_is_written_with_its_type() {
    let params = herdr_fleet_herdr_api::EventsSubscribeParams {
        subscriptions: vec![
            Subscription::PaneAgentStatusChanged(SubscriptionPaneAgentStatusChanged {
                pane_id: "w1:p1".to_owned(),
                agent_status: None,
            }),
            Subscription::LayoutUpdated,
        ],
    };
    assert_eq!(
        serde_json::to_value(&params).unwrap(),
        json!({ "subscriptions": [
            { "type": "pane.agent_status_changed", "pane_id": "w1:p1" },
            { "type": "layout.updated" },
        ] }),
    );
    let read: herdr_fleet_herdr_api::EventsSubscribeParams =
        serde_json::from_value(serde_json::to_value(&params).unwrap()).unwrap();
    assert_eq!(read, params);
}

/// A tag the generated union knows decodes to its own variant, or fails because the hand-written
/// object lacks the variant's fields; it never falls through to `Other`.
fn assert_known<T: DeserializeOwned + std::fmt::Debug>(
    key: &str,
    tag: &str,
    is_other: impl Fn(&T) -> bool,
) {
    let mut object = serde_json::Map::new();
    object.insert(key.to_owned(), json!(tag));
    match serde_json::from_value::<T>(Value::Object(object)) {
        Ok(value) => assert!(!is_other(&value), "{tag}: {value:?}"),
        Err(error) => assert!(
            error.to_string().contains("missing field"),
            "{tag}: {error}"
        ),
    }
}

#[test]
fn every_response_shape_of_the_schema_is_a_variant_of_response_result() {
    let schema = schema();
    let tags = tags(
        &schema["schemas"]["success_response"]["$defs"]["ResponseResult"],
        "type",
    );
    assert_eq!(tags.len(), 63);
    for tag in &tags {
        assert_known::<ResponseResult>("type", tag, |value| {
            matches!(value, ResponseResult::Other(_))
        });
    }
}

/// The smallest value the schema accepts for `node`: its required properties only, the first
/// variant of a union that is not `null`, the first value of an enum.
fn instance(schema: &Value, node: &Value, depth: usize) -> Value {
    if node == &Value::Bool(true) {
        return json!({ "any": [1, "two"] });
    }
    if let Some(reference) = node["$ref"].as_str() {
        let parts: Vec<&str> = reference.split('/').collect();
        let target = &schema["schemas"][parts[2]]["$defs"][parts[4]];
        return instance(schema, target, depth + 1);
    }
    if let Some(constant) = node.get("const") {
        return constant.clone();
    }
    if let Some(values) = node["enum"].as_array() {
        return values[0].clone();
    }
    if let Some(variants) = node["oneOf"].as_array().or(node["anyOf"].as_array()) {
        let variant = variants
            .iter()
            .find(|variant| variant["type"] != "null")
            .unwrap();
        return instance(schema, variant, depth);
    }
    let kind = match &node["type"] {
        Value::String(kind) => kind.as_str(),
        Value::Array(kinds) => kinds
            .iter()
            .filter_map(Value::as_str)
            .find(|kind| *kind != "null")
            .unwrap(),
        other => panic!("no type: {other}"),
    };
    match kind {
        "string" => json!("x"),
        "boolean" => json!(true),
        "integer" => json!(7),
        "number" => json!(0.5),
        // one item, until the depth stops a type that holds itself
        "array" if depth < 6 => json!([instance(schema, &node["items"], depth + 1)]),
        "array" => json!([]),
        "object" => {
            let mut object = serde_json::Map::new();
            let required = node["required"].as_array().cloned().unwrap_or_default();
            for name in required {
                let name = name.as_str().unwrap();
                let property = &node["properties"][name];
                object.insert(name.to_owned(), instance(schema, property, depth + 1));
            }
            if let Some(values) = node.get("additionalProperties").filter(|v| v.is_object()) {
                object.insert("k".to_owned(), instance(schema, values, depth + 1));
            }
            Value::Object(object)
        }
        other => panic!("unknown type {other}"),
    }
}

/// Every shape of a tagged union reads to its own variant and writes back the same JSON.
fn assert_round_trips<T: DeserializeOwned + Serialize + std::fmt::Debug>(
    schema: &Value,
    union: &Value,
    is_other: impl Fn(&T) -> bool,
) -> usize {
    let variants = union["oneOf"].as_array().unwrap();
    for variant in variants {
        let json = instance(schema, variant, 0);
        let read: T =
            serde_json::from_value(json.clone()).unwrap_or_else(|error| panic!("{json}: {error}"));
        assert!(!is_other(&read), "{json}: {read:?}");
        assert_eq!(serde_json::to_value(&read).unwrap(), json);
    }
    variants.len()
}

#[test]
fn every_shape_of_the_tagged_unions_reads_and_writes_back() {
    let schema = schema();
    let defs = |section: &str| schema["schemas"][section]["$defs"].clone();
    let (request, response, event) = (defs("request"), defs("success_response"), defs("event"));
    let count = assert_round_trips::<ResponseResult>(&schema, &response["ResponseResult"], |v| {
        matches!(v, ResponseResult::Other(_))
    });
    assert_eq!(count, 63);
    let count = assert_round_trips::<EventData>(&schema, &event["EventData"], |v| {
        matches!(v, EventData::Other(_))
    });
    assert_eq!(count, 26);
    assert_round_trips::<Subscription>(&schema, &request["Subscription"], |v| {
        matches!(v, Subscription::Other(_))
    });
    assert_round_trips::<LayoutNode>(&schema, &request["LayoutNode"], |v| {
        matches!(v, LayoutNode::Other(_))
    });
    assert_round_trips::<AgentViewFilter>(&schema, &request["AgentViewFilter"], |v| {
        matches!(v, AgentViewFilter::Other(_))
    });
    assert_round_trips::<EventMatch>(&schema, &request["EventMatch"], |v| {
        matches!(v, EventMatch::Other(_))
    });
    assert_round_trips::<OutputMatch>(&schema, &request["OutputMatch"], |v| {
        matches!(v, OutputMatch::Other(_))
    });
    assert_round_trips::<PaneMoveDestination>(&schema, &request["PaneMoveDestination"], |v| {
        matches!(v, PaneMoveDestination::Other(_))
    });
}

#[test]
fn a_success_response_decodes_to_its_shape() {
    let frame = json!({
        "id": "1",
        "result": { "type": "pong", "version": "0.9.4", "protocol": 22, "capabilities": null },
    });
    let response: SuccessResponse = serde_json::from_value(frame).unwrap();
    assert_eq!(response.id, "1");
    assert_eq!(
        response.result,
        ResponseResult::Pong(ResponseResultPong {
            version: "0.9.4".to_owned(),
            protocol: 22,
            capabilities: None,
        }),
    );

    let ok: ResponseResult = serde_json::from_value(json!({ "type": "ok" })).unwrap();
    assert_eq!(ok, ResponseResult::Ok);
    assert_eq!(serde_json::to_value(&ok).unwrap(), json!({ "type": "ok" }));

    // agent.explain's `explain` may be any value
    let explain = json!({ "type": "agent_explain", "explain": { "steps": [1, "two", null] } });
    let read: ResponseResult = serde_json::from_value(explain.clone()).unwrap();
    assert_eq!(serde_json::to_value(&read).unwrap(), explain);
}

#[test]
fn a_response_shape_from_a_newer_herdr_is_kept() {
    let future = json!({ "type": "pane_future", "pane_id": "w1:p1", "extra": [1, 2] });
    let read: ResponseResult = serde_json::from_value(future.clone()).unwrap();
    assert_eq!(read, ResponseResult::Other(future.clone()));
    assert_eq!(serde_json::to_value(&read).unwrap(), future);
}

#[test]
fn a_known_response_shape_with_a_wrong_field_is_an_error() {
    let wrong = json!({ "type": "pong", "version": "0.9.4", "protocol": "22" });
    let error = serde_json::from_value::<ResponseResult>(wrong).unwrap_err();
    // the error names the shape whose fields did not decode
    assert!(error.to_string().starts_with("pong: "), "{error}");
    assert!(serde_json::from_value::<ResponseResult>(json!({ "version": "0.9.4" })).is_err());
}

#[test]
fn every_event_of_the_schema_is_a_variant_of_event_data() {
    let schema = schema();
    let event = &schema["schemas"]["event"]["$defs"];
    let tags = tags(&event["EventData"], "type");
    assert_eq!(tags.len(), 26);
    let mut kinds: Vec<String> = event["EventKind"]["enum"]
        .as_array()
        .unwrap()
        .iter()
        .map(|kind| kind.as_str().unwrap().to_owned())
        .collect();
    kinds.sort();
    let mut sorted = tags.clone();
    sorted.sort();
    assert_eq!(kinds, sorted);
    for tag in &tags {
        assert_known::<EventData>("type", tag, |value| matches!(value, EventData::Other(_)));
        let kind: EventKind = serde_json::from_value(json!(tag)).unwrap();
        assert!(!matches!(kind, EventKind::Other(_)), "{tag}");
    }
}

#[test]
fn an_event_frame_decodes_to_its_event() {
    // server/collector.test.ts, "reads a lifecycle frame" (the frame of its pane_exited case)
    let frame = json!({
        "event": "pane_exited",
        "data": { "type": "pane_exited", "pane_id": "w3M:p1", "workspace_id": "w3M" },
    });
    let envelope: EventEnvelope = serde_json::from_value(frame.clone()).unwrap();
    assert_eq!(envelope.event, EventKind::PaneExited);
    assert_eq!(
        envelope.data,
        EventData::PaneExited(EventDataPaneExited {
            pane_id: "w3M:p1".to_owned(),
            workspace_id: "w3M".to_owned(),
        }),
    );
    assert_eq!(serde_json::to_value(&envelope).unwrap(), frame);

    let future = json!({ "event": "pane_teleported", "data": { "type": "pane_teleported" } });
    let envelope: EventEnvelope = serde_json::from_value(future.clone()).unwrap();
    assert_eq!(
        envelope.event,
        EventKind::Other("pane_teleported".to_owned())
    );
    assert_eq!(
        envelope.data,
        EventData::Other(json!({ "type": "pane_teleported" }))
    );
    assert_eq!(serde_json::to_value(&envelope).unwrap(), future);
}

#[test]
fn a_subscription_event_frame_decodes_to_its_event() {
    let frame = json!({
        "event": "pane.agent_status_changed",
        "data": {
            "pane_id": "w1:p1", "workspace_id": "w1", "agent_status": "working", "agent": "claude",
        },
    });
    let envelope: SubscriptionEventEnvelope = serde_json::from_value(frame).unwrap();
    let SubscriptionEventData::PaneAgentStatusChangedEvent(event) = envelope.data else {
        panic!("{:?}", envelope.data);
    };
    assert_eq!(event.pane_id, "w1:p1");
    assert_eq!(event.agent_status, AgentStatus::Working);
    assert_eq!(event.agent.as_deref(), Some("claude"));
}

#[test]
fn an_enum_keeps_a_value_it_does_not_name() {
    // scripts/generate-protocol-types.test.ts, "widens string enums so an unknown herdr value
    // still decodes"
    let status: AgentStatus = serde_json::from_value(json!("hibernating")).unwrap();
    assert_eq!(status, AgentStatus::Other("hibernating".to_owned()));
    assert_eq!(serde_json::to_value(&status).unwrap(), json!("hibernating"));

    for (text, status) in [
        ("idle", AgentStatus::Idle),
        ("working", AgentStatus::Working),
        ("blocked", AgentStatus::Blocked),
        ("done", AgentStatus::Done),
        ("unknown", AgentStatus::Unknown),
    ] {
        assert_eq!(
            serde_json::from_value::<AgentStatus>(json!(text)).unwrap(),
            status
        );
        assert_eq!(serde_json::to_value(&status).unwrap(), json!(text));
        assert_eq!(status.as_str(), text);
    }
}

#[test]
fn a_named_value_built_by_hand_as_other_is_the_named_value() {
    let by_hand = AgentStatus::Other("idle".to_owned());
    assert_eq!(by_hand, AgentStatus::Idle);
    let set: HashSet<AgentStatus> = [AgentStatus::Idle].into_iter().collect();
    assert!(set.contains(&by_hand));
    assert_ne!(AgentStatus::Other("idle2".to_owned()), AgentStatus::Idle);
}

#[test]
fn a_type_of_the_same_shape_in_two_sections_is_one_type() {
    // the event's pane and the snapshot's panes are both `PaneInfo`
    let pane = json!({
        "pane_id": "w1:p1", "terminal_id": "t1", "workspace_id": "w1", "tab_id": "w1:t1",
        "focused": true, "agent_status": "idle", "revision": 3,
    });
    let event: EventData =
        serde_json::from_value(json!({ "type": "pane_created", "pane": pane.clone() })).unwrap();
    let EventData::PaneCreated(EventDataPaneCreated { pane: from_event }) = event else {
        panic!("{event:?}");
    };
    let snapshot: SessionSnapshot = serde_json::from_value(json!({
        "version": "0.9.4", "protocol": 22, "workspaces": [], "tabs": [], "panes": [pane],
        "layouts": [], "agents": [],
    }))
    .unwrap();
    let from_snapshot: &PaneInfo = &snapshot.panes[0];
    assert_eq!(&from_event, from_snapshot);
    assert_eq!(from_event.revision, 3);
    assert_eq!(from_event.agent, None);
}

#[test]
fn a_layout_holds_layouts() {
    let layout = LayoutNode::Split(LayoutNodeSplit {
        direction: SplitDirection::Right,
        ratio: 0.5,
        first: Box::new(LayoutNode::Pane(LayoutNodePane {
            pane_id: Some("w1:p1".to_owned()),
            ..empty_pane()
        })),
        second: Box::new(LayoutNode::Pane(empty_pane())),
    });
    let json = json!({
        "type": "split", "direction": "right", "ratio": 0.5,
        "first": { "type": "pane", "pane_id": "w1:p1" },
        "second": { "type": "pane" },
    });
    assert_eq!(serde_json::to_value(&layout).unwrap(), json);
    assert_eq!(serde_json::from_value::<LayoutNode>(json).unwrap(), layout);
}

fn empty_pane() -> LayoutNodePane {
    LayoutNodePane {
        command: None,
        cwd: None,
        env: None,
        label: None,
        pane_id: None,
    }
}

#[test]
fn a_union_without_a_tag_is_told_apart_by_its_json_type() {
    assert_eq!(
        serde_json::from_value::<PopupSize>(json!(80)).unwrap(),
        PopupSize::Integer(80)
    );
    assert_eq!(
        serde_json::from_value::<PopupSize>(json!("80%")).unwrap(),
        PopupSize::String("80%".to_owned()),
    );
    assert_eq!(
        serde_json::to_value(PopupSize::String("80%".to_owned())).unwrap(),
        json!("80%")
    );
}
