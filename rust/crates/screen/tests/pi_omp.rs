//! The cards of pi, omp and the agents without a reader of their own (#195), and the checks of an
//! answer's shape that every card shares.

mod common;

use herdr_fleet_screen::{Answer, InvalidAnswer, answer_keys, parse_interactive_prompt};

#[test]
fn pi_omp_and_other_agents_cases() {
    common::check(common::Slice::PiOmp);
}

/// pi's select from `fixtures/screens/pi/reads-an-extensions-select-as-its-options-in-pis-own-order`:
/// a single choice of three options with no typed answer.
const PI_SELECT: &str = concat!(
    "────────────────────────────────────────\n",
    "\n",
    " Allow dangerous command?\n",
    "\n",
    " → Allow once\n",
    "   Always allow\n",
    "   Block\n",
    " ↑↓ navigate  enter select  escape/ctrl+c cancel\n",
    "────────────────────────────────────────\n",
    "────────────────────────────────────────\n",
    "/tmp/app\n",
    "0.0%/215k (auto)                                        some-model • medium\n",
);

fn refused(answer: Answer) -> String {
    let prompt = parse_interactive_prompt("pi", PI_SELECT).expect("pi's select reads as a card");
    let error: InvalidAnswer = answer_keys(&prompt, &answer).expect_err("the answer is refused");
    error.to_string()
}

fn answer(json: &str) -> Answer {
    serde_json::from_str(json).unwrap()
}

/// server/prompt.test.ts, `rejects invalid answer shapes`. The TypeScript test asks a Claude card;
/// these checks come before anything the agent decides (server/prompt.ts:1165-1169, 1194-1195, 1218), so
/// pi's card answers them the same. The TypeScript test matches part of each message; the whole
/// message is the one server/prompt.ts throws.
#[test]
fn rejects_invalid_answer_shapes() {
    let both = refused(answer(r#"{"option_index": 0, "custom_text": "also"}"#));
    assert!(both.contains("Exactly one answer"));
    assert_eq!(both, "Exactly one answer is required.");

    let indices = refused(answer(r#"{"option_indices": [0]}"#));
    assert!(indices.contains("requires one or more selections"));
    assert_eq!(indices, "This prompt requires one or more selections.");

    let outside = refused(answer(r#"{"option_index": 99}"#));
    assert!(outside.contains("valid option index"));
    assert_eq!(outside, "A valid option index is required.");

    let text = refused(answer(r#"{"custom_text": 42}"#));
    assert!(text.contains("must be a string"));
    assert_eq!(text, "Custom text must be a string.");

    let null = refused(answer(r#"{"option_indices": null}"#));
    assert!(null.contains("must be an array"));
    assert_eq!(null, "Option indices must be an array.");
}

#[test]
fn refuses_an_index_that_is_not_a_whole_number_in_range() {
    // server/prompt.ts:1218: a fraction, a negative number and the row past the last are no option
    for index in ["1.5", "-1", "3"] {
        assert_eq!(
            refused(answer(&format!(r#"{{"option_index": {index}}}"#))),
            "A valid option index is required.",
            "option_index {index}"
        );
    }
    // server/prompt.ts:1171: a select of pi's takes no typed answer, and a blank one is none
    assert_eq!(
        refused(answer(r#"{"custom_text": "x"}"#)),
        "This prompt does not accept a custom answer."
    );
}

/// A case of pi's select under `name`, read from a case.json.
fn pi_case(name: &str, spec: serde_json::Value) -> common::Case {
    common::Case {
        name: name.into(),
        screen: PI_SELECT.into(),
        spec: serde_json::from_value(spec).unwrap(),
    }
}

fn pi_select_spec(same_id_as: &[&str]) -> serde_json::Value {
    serde_json::json!({
        "call": "parseInteractivePrompt",
        "agent": "pi",
        "expected": {
            "agent": "pi", "kind": "question", "title": "", "question": "Allow dangerous command?",
            "body": null,
            "options": [
                {"label": "Allow once", "description": null},
                {"label": "Always allow", "description": null},
                {"label": "Block", "description": null}
            ],
            "multi_select": false, "custom_option_index": null
        },
        "sameIdAs": same_id_as,
        // a number written as 1.0 is the JavaScript number 1
        "answers": [{"answer": {"option_index": 1.0}, "expected": [{"keys": ["down"]}, {"keys": ["enter"]}]}]
    })
}

#[test]
fn the_runner_checks_which_cases_share_a_card() {
    let first = pi_case("pi/first", pi_select_spec(&["pi/second"]));
    let second = pi_case("pi/second", pi_select_spec(&["pi/first"]));
    assert!(common::failures(&[&first, &second], "PiOmp").is_empty());

    // the same card under a case that names no twin
    let alone = pi_case("pi/second", pi_select_spec(&[]));
    let failures = common::failures(&[&first, &alone], "PiOmp");
    assert_eq!(
        failures,
        [r#"pi/second: its card has the same id as ["pi/first"], and sameIdAs names []"#]
    );
}

#[test]
fn the_runner_compares_same_id_as_as_the_case_lists_it() {
    // the TypeScript test compares the list itself: a repeated name is not the list of the twins
    let first = pi_case("pi/first", pi_select_spec(&["pi/second", "pi/second"]));
    let second = pi_case("pi/second", pi_select_spec(&["pi/first"]));
    let failures = common::failures(&[&first, &second], "PiOmp");
    assert_eq!(
        failures,
        [
            r#"pi/first: its card has the same id as ["pi/second"], and sameIdAs names ["pi/second", "pi/second"]"#
        ]
    );
}

#[test]
fn the_runner_sorts_twins_as_javascript_sorts_strings() {
    // `["pi/😀", "pi/Ａ"].sort()` keeps this order: UTF-16 puts U+D83D before U+FF21, where Rust's
    // own order of strings puts U+FF21 first
    let first = pi_case("pi/a", pi_select_spec(&["pi/😀", "pi/Ａ"]));
    let second = pi_case("pi/😀", pi_select_spec(&["pi/a", "pi/Ａ"]));
    let third = pi_case("pi/Ａ", pi_select_spec(&["pi/a", "pi/😀"]));
    assert_eq!(
        common::failures(&[&first, &second, &third], "PiOmp"),
        Vec::<String>::new()
    );
}

#[test]
fn the_runner_refuses_a_parse_without_an_agent() {
    // scripts/screen-fixtures.ts `agentOf`: an empty agent is none
    let case = pi_case(
        "other/nameless",
        serde_json::json!({"call": "parseInteractivePrompt", "agent": "", "expected": null}),
    );
    assert_eq!(
        common::failures(&[&case], "PiOmp"),
        ["other/nameless: parseInteractivePrompt needs an agent"]
    );
}

#[test]
fn the_runner_refuses_a_twin_outside_its_slice() {
    let case = pi_case("pi/first", pi_select_spec(&["claude/elsewhere"]));
    let failures = common::failures(&[&case], "PiOmp");
    assert_eq!(
        failures,
        [r#"pi/first: sameIdAs names cases outside the slice PiOmp: ["claude/elsewhere"]"#]
    );
}

#[test]
fn the_runner_compares_numbers_by_value_and_finds_a_wrong_value() {
    assert!(common::same(&serde_json::json!(1), &serde_json::json!(1.0)));
    assert!(!common::same(
        &serde_json::json!({"a": 1}),
        &serde_json::json!({"a": 1, "b": null})
    ));
    let mut spec = pi_select_spec(&[]);
    spec["expected"]["question"] = "Something else?".into();
    let failures = common::failures(&[&pi_case("pi/first", spec)], "PiOmp");
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(failures[0].starts_with("pi/first: returned "));
}

/// omp's single choice from `fixtures/screens/omp/parses-omp-single-multi-select-and-approval-prompts-1`.
const OMP_SINGLE: &str = concat!(
    "\n",
    "╭─ Ask ───────────────────╮\n",
    "│ Which target?           │\n",
    "├─────────────────────────┤\n",
    "│❯ ○ Jetson Orin         │\n",
    "│  ○ RK3588               │\n",
    "│  ○ Other (type your own)│\n",
    "├─────────────────────────┤\n",
    "│ Enter select · n note · ↑/↓ move · Esc cancel\n",
    "╰─────────────────────────╯\n",
);

/// omp's multiple choice from `fixtures/screens/omp/parses-omp-single-multi-select-and-approval-prompts-2`.
const OMP_MULTI: &str = concat!(
    "\n",
    "╭─ Ask ───────────────────╮\n",
    "│ Which checks?           │\n",
    "├─────────────────────────┤\n",
    "│❯ ☐ Lint                │\n",
    "│  ☐ Tests                │\n",
    "│  ☐ Build                │\n",
    "│  ☐ Other (type your own)│\n",
    "├─────────────────────────┤\n",
    "│ Space/Enter toggle · n note · ↑/↓ move · Tab/←/→ · Esc cancel\n",
    "╰─────────────────────────╯\n",
);

/// omp's approval from `fixtures/screens/omp/parses-omp-single-multi-select-and-approval-prompts-3`.
const OMP_APPROVAL: &str = concat!(
    "\n",
    "╭─ Permission ────────────╮\n",
    "│ Allow tool: bash        │\n",
    "│ curl -I example.com     │\n",
    "│❯ Approve               │\n",
    "│  Deny                  │\n",
    "╰─────────────────────────╯\n",
);

fn keys(prompt: &str, agent: &str, answer_json: &str) -> serde_json::Value {
    let prompt = parse_interactive_prompt(agent, prompt).expect("the screen reads as a card");
    serde_json::to_value(answer_keys(&prompt, &answer(answer_json)).unwrap()).unwrap()
}

fn omp_refused(screen: &str, answer_json: &str) -> String {
    let prompt = parse_interactive_prompt("omp", screen).expect("the screen reads as a card");
    answer_keys(&prompt, &answer(answer_json))
        .unwrap_err()
        .to_string()
}

/// The answers to omp's cards the corpus does not hold. The expected keys and messages are what
/// TypeScript's answerKeys returns and throws for the same cards (Bun 1.4.4).
#[test]
fn answers_omps_cards_as_typescript_does() {
    let steps = |json: &str| serde_json::from_str::<serde_json::Value>(json).unwrap();
    assert_eq!(
        keys(OMP_SINGLE, "omp", r#"{"option_index": 1}"#),
        steps(r#"[{"keys":["down"]},{"keys":["enter"]}]"#)
    );
    // the typed answer is the row "Other (type your own)": Enter opens it, Enter sends it
    assert_eq!(
        keys(OMP_SINGLE, "omp", r#"{"custom_text": " Pi 5 "}"#),
        steps(
            r#"[{"keys":["down"]},{"keys":["down"]},{"keys":["enter"]},{"text":"Pi 5"},{"keys":["enter"]}]"#
        )
    );
    assert_eq!(
        omp_refused(OMP_SINGLE, r#"{"option_index": 2}"#),
        "A valid option index is required."
    );

    // Lint ticked already: picking Tests alone unticks Lint and ticks Tests
    let ticked = OMP_MULTI.replace("☐ Lint", "☑ Lint");
    assert_eq!(
        keys(&ticked, "omp", r#"{"option_indices": [1, 1]}"#),
        steps(
            r#"[{"keys":["space"]},{"keys":["down"]},{"keys":["space"]},{"keys":["tab"]},{"keys":["enter"]}]"#
        )
    );
    assert_eq!(
        omp_refused(&ticked, r#"{"custom_text": "x"}"#),
        "This prompt does not accept a custom answer."
    );
    assert_eq!(
        omp_refused(&ticked, r#"{"option_indices": [3]}"#),
        "An option index is outside the displayed range."
    );

    assert_eq!(
        keys(OMP_APPROVAL, "omp", r#"{"option_index": 1}"#),
        steps(r#"[{"keys":["down"]},{"keys":["enter"]}]"#)
    );
    assert_eq!(
        keys(OMP_APPROVAL, "omp", r#"{"option_index": 0}"#),
        steps(r#"[{"keys":["enter"]}]"#)
    );
}

/// server/prompt.ts:1165-1166: a field given as null is given, so beside another answer it makes
/// two. The messages and keys are what TypeScript's answerKeys returns for the same answers to the
/// same card (Bun 1.4.4).
#[test]
fn a_null_field_is_an_answer_given() {
    for json in [
        r#"{"option_index": 0, "option_indices": null}"#,
        r#"{"option_index": 0, "custom_text": null}"#,
        r#"{"option_index": 0, "custom_text": 42}"#,
    ] {
        assert_eq!(
            refused(answer(json)),
            "Exactly one answer is required.",
            "{json}"
        );
    }
    assert_eq!(
        refused(answer(r#"{"option_index": null}"#)),
        "A valid option index is required."
    );
    assert_eq!(
        refused(answer(r#"{"option_index": "0"}"#)),
        "A valid option index is required."
    );
    assert_eq!(
        refused(answer(r#"{"option_indices": ["a"]}"#)),
        "This prompt requires one or more selections."
    );
    // JSON.parse keeps the last of two same keys; a body that is no object holds no answer
    let prompt = parse_interactive_prompt("pi", PI_SELECT).unwrap();
    assert_eq!(
        serde_json::to_string(
            &answer_keys(
                &prompt,
                &answer(r#"{"option_index": 0, "option_index": 1}"#)
            )
            .unwrap()
        )
        .unwrap(),
        r#"[{"keys":["down"]},{"keys":["enter"]}]"#
    );
    assert_eq!(refused(answer("[1]")), "Exactly one answer is required.");
    let zero = Answer::from(serde_json::json!({"pane_id": "p", "option_index": -0.0}));
    assert_eq!(
        serde_json::to_string(&answer_keys(&prompt, &zero).unwrap()).unwrap(),
        r#"[{"keys":["enter"]}]"#
    );
}

/// What a client writes (protocol's PromptAnswer) reads as the same answer: the two types name the
/// three fields each on their own.
#[test]
fn a_prompt_answer_written_by_a_client_reads_as_an_answer() {
    let written = protocol::PromptAnswer {
        pane_id: "p".into(),
        prompt_id: "id".into(),
        option_index: Some(2.0),
        option_indices: None,
        custom_text: None,
    };
    let read: Answer = serde_json::from_value(serde_json::to_value(&written).unwrap()).unwrap();
    let prompt = parse_interactive_prompt("pi", PI_SELECT).unwrap();
    assert_eq!(
        serde_json::to_string(&answer_keys(&prompt, &read).unwrap()).unwrap(),
        r#"[{"keys":["down"]},{"keys":["down"]},{"keys":["enter"]}]"#
    );
}
