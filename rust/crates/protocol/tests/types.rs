//! What the corpora do not show of the protocol types: a field TypeScript requires (that may be
//! `null`) is required, a `null` cursor is kept apart from an absent one, and the shapes of the
//! types no corpus holds. The JSON is written by hand from `shared/protocol.ts` and
//! `shared/fleet.ts`.

use herdr_fleet_protocol::{
    ConversationMetadata, ConversationResponse, ConversationSource, FleetAgentKind,
    InteractivePrompt, PromptAnswer, UsageReading,
};
use serde_json::{Value, json};

fn card() -> Value {
    json!({
        "id": "abc", "agent": "claude", "kind": "question", "title": "Question", "question": "Which?",
        "body": null, "options": [{"label": "A", "description": null}], "multi_select": false,
        "custom_option_index": null,
    })
}

fn without(mut value: Value, field: &str) -> Value {
    value.as_object_mut().unwrap().remove(field);
    value
}

#[test]
fn a_field_typescript_requires_may_be_null_but_not_absent() {
    assert!(serde_json::from_value::<InteractivePrompt>(card()).is_ok());
    for field in ["body", "custom_option_index"] {
        let error =
            serde_json::from_value::<InteractivePrompt>(without(card(), field)).unwrap_err();
        assert!(
            error
                .to_string()
                .contains(&format!("missing field `{field}`")),
            "{field}: {error}"
        );
    }
    let option = json!({"label": "A"});
    let mut card = card();
    card["options"] = json!([option]);
    assert!(serde_json::from_value::<InteractivePrompt>(card).is_err());

    let metadata = json!({"model": null, "reasoning_effort": null});
    assert!(serde_json::from_value::<ConversationMetadata>(metadata.clone()).is_ok());
    assert!(serde_json::from_value::<ConversationMetadata>(without(metadata, "model")).is_err());
}

#[test]
fn an_optional_field_is_left_out_and_a_fallback_card_says_true() {
    let mut card = card();
    card["fallback"] = json!(true);
    card["queued"] = json!("open");
    let typed: InteractivePrompt = serde_json::from_value(card.clone()).unwrap();
    assert!(typed.fallback);
    assert_eq!(serde_json::to_value(&typed).unwrap(), card);

    let answer = json!({"pane_id": "p", "prompt_id": "abc", "option_indices": [0, 2]});
    let typed: PromptAnswer = serde_json::from_value(answer).unwrap();
    assert_eq!(typed.option_indices, Some(vec![0.0, 2.0]));
    let back = serde_json::to_value(&typed).unwrap();
    assert_eq!(back.as_object().unwrap().len(), 3, "{back}");
}

#[test]
fn an_answers_index_is_any_javascript_number_for_the_screen_crate_to_check() {
    // TypeScript answers 409 prompt_changed before it looks at the index, then refuses one that
    // is not a whole number in range with its own message (server/prompt.ts:1197, 1218-1219)
    for index in [json!(-1), json!(1.5)] {
        let answer = json!({"pane_id": "p", "prompt_id": "abc", "option_index": index});
        let typed: PromptAnswer = serde_json::from_value(answer).unwrap();
        assert_eq!(typed.option_index, index.as_f64());
    }
}

#[test]
fn a_null_cursor_is_kept_apart_from_an_absent_one() {
    let scrollback = json!({"source": "scrollback", "turns": []});
    let typed: ConversationResponse = serde_json::from_value(scrollback.clone()).unwrap();
    assert_eq!(typed.cursor, None);
    assert_eq!(typed.source, ConversationSource::Scrollback);
    assert_eq!(serde_json::to_value(&typed).unwrap(), scrollback);

    let beginning =
        json!({"history_id": "h", "source": "opencode-session", "turns": [], "cursor": null});
    let typed: ConversationResponse = serde_json::from_value(beginning.clone()).unwrap();
    assert_eq!(typed.cursor, Some(None));
    assert_eq!(serde_json::to_value(&typed).unwrap(), beginning);

    let later = json!({"history_id": "h", "source": "pi-transcript", "turns": [], "cursor": "c1"});
    let typed: ConversationResponse = serde_json::from_value(later.clone()).unwrap();
    assert_eq!(typed.cursor, Some(Some("c1".to_owned())));
    assert_eq!(serde_json::to_value(&typed).unwrap(), later);
}

#[test]
fn the_fleet_agent_kinds_are_the_six_adapters() {
    let kinds = ["pi", "claude", "codex", "cursor", "agy", "opencode"];
    for kind in kinds {
        let typed: FleetAgentKind = serde_json::from_value(json!(kind)).unwrap();
        assert_eq!(serde_json::to_value(typed).unwrap(), json!(kind));
    }
    assert!(serde_json::from_value::<FleetAgentKind>(json!("omp")).is_err());
}

#[test]
fn a_usage_reading_keeps_the_camel_case_names_and_leaves_an_unknown_reset_out() {
    // TypeScript keeps any finite number (server/fleet/usage.ts:192, 200): Codex's reset is its
    // seconds times 1000
    let reading = json!({
        "windows": [
            {"name": "5h", "usedPercent": 12.5, "resetsAt": 1_767_225_600_000.5},
            {"name": "weekly", "usedPercent": 40},
        ],
        "readAt": 1_767_222_000_000_i64,
    });
    let typed: UsageReading = serde_json::from_value(reading.clone()).unwrap();
    assert_eq!(typed.windows[1].resets_at, None);
    assert_eq!(typed.windows[0].resets_at, Some(1_767_225_600_000.5));
    // a whole number reads back as an f64 (40 as 40.0); as values the two are the same number
    let back = serde_json::to_value(&typed).unwrap();
    assert_eq!(back["windows"][1]["usedPercent"].as_f64(), Some(40.0));
    assert_eq!(back["windows"][0], reading["windows"][0]);
    assert_eq!(back["readAt"].as_f64(), Some(1_767_222_000_000.0));
    assert!(back["windows"][1].get("resetsAt").is_none());
}

#[test]
fn a_number_reads_as_javascripts_json_parse_reads_it() {
    // JSON.parse keeps 0.9999999999999999 (Number.isInteger is false under Bun 1.4.4); serde_json
    // without `float_roundtrip` reads 1.0, and the screen would take option 1
    let answer = r#"{"pane_id":"p","prompt_id":"id","option_index":0.9999999999999999}"#;
    let typed: PromptAnswer = serde_json::from_str(answer).unwrap();
    assert_eq!(typed.option_index, Some(0.999_999_999_999_999_9));
    assert_ne!(typed.option_index, Some(1.0));
    // the bits Bun's JSON.parse and Rust's str::parse give 8.971135692166839e-150
    let value: Value = serde_json::from_str("8.971135692166839e-150").unwrap();
    assert_eq!(value.as_f64().unwrap().to_bits(), 0x20fd_5db4_3a77_6693);
}

#[test]
fn a_context_count_is_any_positive_number_the_transcript_recorded() {
    // server/conversation-metadata.ts:8 keeps any positive finite number as it is recorded, so a
    // Codex `total_tokens` of 1.5 answers `{"used": 1.5, "window": 200000}`
    let metadata = json!({"model": "gpt", "reasoning_effort": null, "context": {"used": 1.5, "window": 200000}});
    let typed = serde_json::from_value::<ConversationMetadata>(metadata);
    let back = serde_json::to_value(typed.unwrap()).unwrap();
    assert_eq!(back["context"]["used"].as_f64(), Some(1.5));
    assert_eq!(back["context"]["window"].as_f64(), Some(200_000.0));
}
