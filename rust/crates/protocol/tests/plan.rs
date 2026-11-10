//! The checks of a lead's plan (`shared/plan.ts`). The first five tests are `shared/plan.test.ts`'s,
//! with its expected values; the rest are this crate's own, with the values TypeScript's
//! `parsePlan` answered for the same input (bun 1.4.4, at the `rust` branch's `shared/plan.ts`).

use herdr_fleet_protocol::{
    ParsePlanOptions, PlanExhibit, PlanInput, number_claims, parse_plan, plan_asks, plan_open,
};
use serde_json::{Value, json};

fn ask(id: &str) -> Value {
    json!({
        "id": id, "question": format!("Which {id}?"),
        "options": [{ "value": "a", "label": "A" }, { "value": "b", "label": "B", "note": "claim 2 goes" }],
        "recommended": "a",
    })
}

fn plan() -> Value {
    json!({
        "title": "Scheduled send in the composer",
        "why": ["I want to send a message later"],
        "claims": [
            {
                "text": "The person can pick a time in the composer.",
                "exhibit": { "kind": "list", "items": ["Send later opens a time picker"] },
                "ask": ask("picker"),
                "children": [
                    { "text": "Send later saves the message with a time.", "exhibit": { "kind": "calls", "rows": [{ "depth": 0, "text": "createScheduled()", "at": "server/routes.ts:18" }, { "depth": 1, "text": "insert()" }] },
                      "children": [{ "text": "routes.ts:18 · createScheduled()", "exhibit": { "kind": "code", "path": "server/routes.ts", "start": 18, "end": 24 } }] },
                ],
            },
            { "text": "A person holds 50 scheduled messages at most.", "exhibit": { "kind": "schema", "lang": "sql", "text": "create table scheduled (id int)" }, "ask": ask("limit") },
        ],
        "shared": { "text": "One new table.", "exhibit": { "kind": "code", "path": "db/new.sql", "text": "create table scheduled ();" } },
        "scope": ["Normal send", "Drafts"],
        "extra": "dropped",
    })
}

fn parse(value: &Value) -> Result<PlanInput, Vec<String>> {
    parse_plan(value, ParsePlanOptions::default())
}

fn parse_stored(value: &Value) -> Result<PlanInput, Vec<String>> {
    parse_plan(value, ParsePlanOptions { stored: true })
}

fn errors(value: &Value) -> Vec<String> {
    parse(value).expect_err("the plan has problems")
}

/// shared/plan.test.ts: "take a plan the lead wrote, in the shape the fleet keeps"
#[test]
fn take_a_plan_the_lead_wrote_in_the_shape_the_fleet_keeps() {
    let parsed = parse(&plan()).unwrap_or_else(|errors| panic!("{}", errors.join("\n")));
    assert_eq!(parsed.title, "Scheduled send in the composer");
    assert_eq!(
        serde_json::to_value(&parsed.claims[0].children[0].children[0].exhibit).unwrap(),
        json!({ "kind": "code", "path": "server/routes.ts", "start": 18, "end": 24 })
    );
    assert_eq!(
        serde_json::to_value(&parsed.shared).unwrap(),
        json!({ "text": "One new table.", "exhibit": { "kind": "code", "path": "db/new.sql", "text": "create table scheduled ();" } })
    );
    assert_eq!(parsed.scope, ["Normal send", "Drafts"]);
    assert!(
        serde_json::to_value(&parsed)
            .unwrap()
            .get("extra")
            .is_none()
    );
}

/// shared/plan.test.ts: "number the claims in reading order, and the decisions D1, D2 on the claims they change"
#[test]
fn number_the_claims_in_reading_order_and_the_decisions_on_the_claims_they_change() {
    let parsed = parse(&plan()).unwrap_or_else(|errors| panic!("{}", errors.join("\n")));
    let numbered: Vec<String> = number_claims(&parsed.claims)
        .iter()
        .map(|claim| format!("{}@{}", claim.id, claim.level))
        .collect();
    assert_eq!(numbered, ["1@1", "1.1@2", "1.1.1@3", "2@1"]);
    let asks: Vec<String> = plan_asks(&parsed.claims)
        .iter()
        .map(|each| format!("{} {} {}", each.number, each.claim, each.ask.id))
        .collect();
    assert_eq!(asks, ["D1 1 picker", "D2 2 limit"]);
}

/// shared/plan.test.ts: "answer every problem at once, so the lead fixes them together"
#[test]
fn answer_every_problem_at_once_so_the_lead_fixes_them_together() {
    let mut wrong = ask("limit");
    wrong["recommended"] = json!("c");
    let found = errors(&json!({
        "title": "",
        "claims": [
            { "text": "x", "exhibit": { "kind": "code", "path": "a.ts" } },
            { "text": "y", "exhibit": { "kind": "code", "path": "a.ts", "start": 1, "end": 100 } },
            { "text": "z", "ask": wrong },
            { "text": "w", "ask": ask("limit"), "exhibit": { "kind": "video" } },
        ],
    }));
    assert_eq!(
        found,
        [
            "title must be a non-empty string",
            "claims[0].exhibit needs start (and end) to show lines of a.ts, or text for code it proposes",
            "claims[1].exhibit must show 1 to 60 lines",
            "claims[2].ask.recommended must be one of its options' values",
            "claims[3].exhibit.kind must be code, schema, calls or list",
            "claims[3].ask.id limit is used twice",
        ]
    );
}

/// shared/plan.test.ts: "hold at most 3 levels, 5 claims under each, and 5 decisions"
#[test]
fn hold_at_most_3_levels_5_claims_under_each_and_5_decisions() {
    let deep = json!({ "text": "1", "children": [{ "text": "2", "children": [{ "text": "3", "children": [{ "text": "4" }] }] }] });
    assert_eq!(
        errors(&json!({ "title": "t", "claims": [deep] })),
        ["claims[0].children[0].children[0].children: a plan has at most 3 levels"]
    );
    let wide: Vec<Value> = (0..6)
        .map(|index| json!({ "text": index.to_string(), "ask": ask(&format!("d{index}")) }))
        .collect();
    assert_eq!(
        errors(&json!({ "title": "t", "claims": wide })),
        ["claims has more than 5 claims"]
    );
    let asks: Vec<Value> = (0..3)
        .map(|index| {
            json!({ "text": index.to_string(), "ask": ask(&format!("a{index}")), "children": [{ "text": "c", "ask": ask(&format!("b{index}")) }] })
        })
        .collect();
    assert_eq!(
        errors(&json!({ "title": "t", "claims": asks })),
        ["a plan asks at most 5 decisions; ask only what changes what you build"]
    );
}

/// shared/plan.test.ts: "need a title and at least one claim, and refuse what is not an object"
#[test]
fn need_a_title_and_at_least_one_claim_and_refuse_what_is_not_an_object() {
    assert_eq!(errors(&json!([])), ["the plan must be a JSON object"]);
    assert_eq!(errors(&json!({ "title": "t" })), ["claims is required"]);
    assert_eq!(
        errors(&json!({ "title": "t", "claims": [] })),
        ["claims must hold at least one claim"]
    );
}

/// `planOpen`: the person has not answered, and the lead has not gone on without the answers.
#[test]
fn a_plan_is_open_until_it_is_answered_or_closed() {
    assert!(plan_open(None, None));
    assert!(!plan_open(Some(5), None));
    assert!(!plan_open(None, Some(5)));
    assert!(!plan_open(Some(0), Some(0)));
}

#[test]
fn null_lists_read_as_empty_and_a_null_claims_list_is_no_problem() {
    let parsed = parse(
        &json!({ "title": " t ", "claims": null, "why": null, "scope": null, "shared": null }),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&parsed).unwrap(),
        json!({ "title": "t", "why": [], "claims": [], "scope": [] })
    );
}

#[test]
fn lists_of_strings_say_which_entry_is_wrong() {
    assert_eq!(
        errors(
            &json!({ "title": "t", "claims": [{ "text": "c" }], "why": [null, "a", " ", 5, "d", "e"], "scope": "x" })
        ),
        [
            "why has more than 5 entries",
            "why[0] is required",
            "why[2] must be a non-empty string",
            "why[3] must be a non-empty string",
            "scope must be a list of strings",
        ]
    );
}

#[test]
fn decisions_need_ids_options_and_labels() {
    let long = ask(&"a".repeat(33));
    assert_eq!(
        errors(&json!({ "title": "t", "claims": [
            { "text": "1", "ask": long },
            { "text": "2", "ask": ask("-a") },
            { "text": "3", "ask": { "id": "A_b-9", "question": "q", "options": [{ "value": "a", "label": "A" }, { "value": "a", "label": "A2" }, "x", { "value": "b c", "label": "B" }, { "value": "z" }], "recommended": "z" } },
            { "text": "4", "ask": { "id": 7, "question": "", "options": [{ "value": "a", "label": "A" }] } },
            { "text": "5", "ask": [] },
        ] })),
        [
            "claims[0].ask.id must be letters, digits, - and _ (up to 32)",
            "claims[1].ask.id must be letters, digits, - and _ (up to 32)",
            "claims[2].ask.options[1].value a is used twice",
            "claims[2].ask.options[2] must be an object",
            "claims[2].ask.options[3].value must be letters, digits, - and _ (up to 32)",
            "claims[2].ask.options[4].label is required",
            "claims[3].ask.id must be letters, digits, - and _ (up to 32)",
            "claims[3].ask.question must be a non-empty string",
            "claims[3].ask.options must hold 2 to 5 options",
            "claims[4].ask must be an object",
        ]
    );
}

#[test]
fn call_trees_lists_and_exhibits_say_what_is_wrong() {
    assert_eq!(
        errors(&json!({ "title": "t", "claims": [
            { "text": "1", "exhibit": { "kind": "calls", "rows": [{ "depth": 6, "text": "a" }, { "depth": 1.5, "text": "b" }, { "depth": "1", "text": "c" }, { "depth": null, "text": "d", "at": " x " }, 3, { "text": "" }] } },
            { "text": "2", "exhibit": { "kind": "calls", "rows": [] } },
            { "text": "3", "exhibit": { "kind": "list", "items": "x" } },
            { "text": "4", "exhibit": { "kind": "list", "items": [] } },
            { "text": "5", "exhibit": "code" },
            { "text": "6", "exhibit": { "path": "a" } },
        ] })),
        [
            "claims has more than 5 claims",
            "claims[0].exhibit.rows[0].depth must be 0 to 5",
            "claims[0].exhibit.rows[1].depth must be 0 to 5",
            "claims[0].exhibit.rows[2].depth must be 0 to 5",
            "claims[0].exhibit.rows[4] must be an object",
            "claims[0].exhibit.rows[5].text must be a non-empty string",
            "claims[1].exhibit.rows must be a non-empty list",
            "claims[2].exhibit.items must be a list of strings",
            "claims[2].exhibit.items must be a non-empty list",
            "claims[3].exhibit.items must be a non-empty list",
            "claims[4].exhibit must be an object",
        ]
    );
}

#[test]
fn a_call_trees_rows_keep_their_depth_and_place() {
    let parsed = parse(&json!({ "title": "t", "claims": [
        { "text": "1", "exhibit": { "kind": "calls", "rows": [{ "depth": null, "text": " d ", "at": " x " }, { "depth": 5, "text": "e" }, { "depth": 2.0, "text": "f" }] } },
    ] }))
    .unwrap();
    assert_eq!(
        parsed.claims[0].exhibit,
        Some(PlanExhibit::Calls {
            rows: serde_json::from_value(json!([
                { "depth": 0, "text": "d", "at": "x" }, { "depth": 5, "text": "e" }, { "depth": 2, "text": "f" },
            ]))
            .unwrap()
        })
    );
}

#[test]
fn code_exhibits_name_lines_from_1_and_at_most_60_of_them() {
    assert_eq!(
        errors(&json!({ "title": "t", "claims": [
            { "text": "1", "exhibit": { "kind": "code", "path": "a.ts", "start": 5, "end": 4 } },
            { "text": "2", "exhibit": { "kind": "code", "path": "a.ts", "start": 0, "end": "3" } },
            { "text": "3", "exhibit": { "kind": "code", "start": 1.5, "lang": "x".repeat(21) } },
            { "text": "4", "exhibit": { "kind": "code", "path": "a.ts", "start": 2, "end": 61 } },
            { "text": "5", "exhibit": { "kind": "code", "path": "a.ts", "start": 2, "lines": ["x"] } },
        ] })),
        [
            "claims[0].exhibit must show 1 to 60 lines",
            "claims[1].exhibit.start must be a line number from 1",
            "claims[1].exhibit.end must be a line number from 1",
            "claims[1].exhibit needs start (and end) to show lines of a.ts, or text for code it proposes",
            "claims[2].exhibit.path is required",
            "claims[2].exhibit.lang is longer than 20 characters",
            "claims[2].exhibit.start must be a line number from 1",
            "claims[2].exhibit needs start (and end) to show lines of the file, or text for code it proposes",
        ]
    );
}

#[test]
fn a_plan_the_lead_wrote_leaves_out_the_lines_and_a_stored_one_keeps_them() {
    let written = json!({ "title": "t", "claims": [
        { "text": "1", "exhibit": { "kind": "code", "path": " a.ts ", "start": 1, "end": 2, "lang": " ts ", "lines": ["😀".repeat(240), ""] } },
    ] });
    // a line of 480 UTF-16 code units, the most a stored line holds
    assert_eq!(
        serde_json::to_value(parse_stored(&written).unwrap()).unwrap(),
        json!({ "title": "t", "why": [], "claims": [{ "text": "1", "exhibit": { "kind": "code", "path": "a.ts", "start": 1, "end": 2, "lang": "ts", "lines": ["😀".repeat(240), ""] }, "children": [] }], "scope": [] })
    );
    assert_eq!(
        serde_json::to_value(&parse(&written).unwrap().claims[0].exhibit).unwrap(),
        json!({ "kind": "code", "path": "a.ts", "start": 1, "end": 2, "lang": "ts" })
    );
}

#[test]
fn a_stored_plans_lines_are_strings_of_480_characters_at_most_and_60_of_them() {
    let stored = json!({ "title": "t", "claims": [
        { "text": "1", "exhibit": { "kind": "code", "path": "a.ts", "start": 1, "lines": null } },
        { "text": "2", "exhibit": { "kind": "code", "path": "a.ts", "start": 1, "lines": ["y".repeat(481)] } },
        { "text": "3", "exhibit": { "kind": "code", "path": "a.ts", "start": 1, "lines": vec![""; 61] } },
    ] });
    assert_eq!(
        parse_stored(&stored).unwrap_err(),
        [
            "claims[0].exhibit.lines must be up to 60 lines",
            "claims[1].exhibit.lines must be up to 60 lines",
            "claims[2].exhibit.lines must be up to 60 lines",
        ]
    );
}

#[test]
fn shared_needs_an_object_with_its_text() {
    assert_eq!(
        errors(&json!({ "title": "t", "claims": [{ "text": "c" }], "shared": [] })),
        ["shared must be an object"]
    );
    assert_eq!(
        errors(
            &json!({ "title": "t", "claims": [{ "text": "c" }], "shared": { "exhibit": { "kind": "schema" } } })
        ),
        ["shared.text is required", "shared.exhibit.text is required"]
    );
    assert_eq!(
        errors(&json!({ "title": 5, "claims": { "a": 1 } })),
        [
            "title must be a non-empty string",
            "claims must be a list of claims"
        ]
    );
}

/// Lengths count UTF-16 code units, and blank means JavaScript's `trim` leaves nothing.
#[test]
fn lengths_count_utf16_code_units_and_blank_is_javascripts_whitespace() {
    assert_eq!(
        errors(
            &json!({ "title": "😀".repeat(61), "claims": [{ "text": "\u{3000}" }, { "text": "\u{85}" }, { "text": "😀".repeat(150) }] })
        ),
        [
            "title is longer than 120 characters",
            "claims[0].text must be a non-empty string"
        ]
    );
    // U+0085 is no whitespace to JavaScript's trim, though Rust's char::is_whitespace says it is
    assert_eq!(
        serde_json::to_value(
            parse(&json!({ "title": "😀".repeat(60), "claims": [{ "text": "\u{85}", "children": null }], "scope": [" s "] }))
                .unwrap()
        )
        .unwrap(),
        json!({ "title": "😀".repeat(60), "why": [], "claims": [{ "text": "\u{85}", "children": [] }], "scope": ["s"] })
    );
}

#[test]
fn three_levels_with_an_empty_fourth_are_a_plan() {
    assert!(
        parse(&json!({ "title": "t", "claims": [{ "text": "1", "children": [{ "text": "2", "children": [{ "text": "3", "children": [] }] }] }] }))
            .is_ok()
    );
}
