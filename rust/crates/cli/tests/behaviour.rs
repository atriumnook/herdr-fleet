//! What the fleet CLI does beyond the cases of the fleet CLI contract, through its `run`.
//!
//! Unless a test says otherwise, each expected value was recorded from the TypeScript CLI
//! (`bun bin/fleet.ts`, Bun 1.4.4, on the `rust` branch of 2026-11-09) with the contract's runner
//! (`runCase` of `scripts/fleet-cli-fixtures.ts`) on the same arguments, environment and answers,
//! and the times from `new Date(ms).toLocaleString()` under `LANG=en_US.UTF-8` and the `TZ` named.
//! Where the TypeScript CLI fails on a missing field (a TypeError), the issue (#251: "任意の項目が
//! 欠けても失敗しない") asks the Rust CLI not to: the expected text is then worked out by hand from
//! `bin/fleet.ts`, where a template literal writes a missing value as `undefined`.

mod common;

use common::{Case, run_case};
use serde_json::{Value, json};

fn report() -> Value {
    json!({ "report": "R" })
}

fn done_run() -> Value {
    json!({ "run": { "id": "r1", "name": "w", "role": "worker", "agent": "pi", "group": "g", "paneId": "p1", "state": "done" } })
}

const DONE_LINE: &str = "r1  w (worker, pi)  done  pane p1\n";

fn report_path(hours: &str) -> Vec<String> {
    vec![format!("/api/fleet/report?cwd=$CWD&hours={hours}")]
}

fn usage_text() -> String {
    run_case(&Case::new(&["help"])).stdout
}

// #189 の 9: the TypeScript CLI put `--hours` into the query as `${hours}`, so `1e21` went out as
// `hours=1e+21`, which the server reads as `1e 21`. The Rust CLI checks it as a number and then
// percent-encodes it, as encodeURIComponent writes `1e+21` (issue #251, #189).
#[test]
fn report_encodes_the_hours_it_sends() {
    let actual = run_case(&Case::new(&["report", "--hours", "1e21"]).respond(200, report()));
    assert_eq!(actual.paths(), report_path("1e%2B21"));
    assert_eq!((actual.stdout.as_str(), actual.exit_code), ("R\n", 0));
    let actual = run_case(
        &Case::new(&["report", "--hours", "123456789012345678901234"]).respond(200, report()),
    );
    assert_eq!(actual.paths(), report_path("1.2345678901234569e%2B23"));
}

#[test]
fn report_reads_hours_as_javascript_number_does() {
    for (given, sent) in [
        ("0x10", "16"),
        ("0X1F", "31"),
        ("0b11", "3"),
        ("0o7", "7"),
        (" 2 ", "2"),
        ("\u{a0}3\u{2028}", "3"),
        ("1e3", "1000"),
        ("5.", "5"),
        (".5", "0.5"),
        ("+5", "5"),
        ("1e-7", "1e-7"),
        ("00012", "12"),
        ("1.50", "1.5"),
    ] {
        let actual = run_case(&Case::new(&["report", "--hours", given]).respond(200, report()));
        assert_eq!(actual.paths(), report_path(sent), "--hours {given:?}");
    }
}

#[test]
fn report_refuses_hours_that_are_not_a_positive_number() {
    for argv in [
        vec!["report", "--hours", "Infinity"],
        vec!["report", "--hours=-1"],
        vec!["report", "--hours", "1_0"],
        vec!["report", "--hours="],
        vec!["report", "--hours", "0"],
    ] {
        let actual = run_case(&Case::new(&argv).respond(200, report()));
        assert_eq!(actual.requests, vec![], "{argv:?}");
        assert_eq!(
            (actual.stderr.as_str(), actual.exit_code),
            ("fleet: --hours must be a positive number\n", 2),
            "{argv:?}"
        );
    }
}

#[test]
fn wait_reads_the_timeout_as_javascript_number_does() {
    for (given, sent) in [("0x10", json!(16)), ("1.5", json!(1.5)), ("  7", json!(7))] {
        let actual = run_case(
            &Case::new(&["wait", "r1", "--timeout", given])
                .env("HERDR_FLEET_GROUP", "g")
                .respond(200, done_run()),
        );
        assert_eq!(
            actual.requests[0].body,
            Some(json!({ "group": "g", "timeout_ms": sent })),
            "--timeout {given:?}"
        );
        assert_eq!(actual.stdout, DONE_LINE);
    }
    for given in ["0.5", "abc"] {
        let actual = run_case(&Case::new(&["wait", "r1", "--timeout", given]));
        assert_eq!(
            (actual.stderr.as_str(), actual.exit_code),
            (
                "fleet: --timeout must be a positive number of milliseconds\n",
                2
            ),
            "--timeout {given:?}"
        );
    }
    // every command checks --timeout, before it looks at the command
    let actual = run_case(&Case::new(&["list", "--timeout", "x"]));
    assert_eq!(
        actual.stderr,
        "fleet: --timeout must be a positive number of milliseconds\n"
    );
}

/// The messages of Bun's `parseArgs` (node:util), each followed by the usage, exit 2.
#[test]
fn argument_errors_carry_the_messages_of_bun_parse_args() {
    let unknown = |name: &str| {
        format!(
            "Unknown option '{name}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"{name}\""
        )
    };
    let ambiguous = |name: &str| {
        format!(
            "Option '{name}' argument is ambiguous.\nDid you forget to specify the option argument for '{name}'?\nTo specify an option argument starting with a dash use '{name}=-XYZ'."
        )
    };
    let usage = usage_text();
    for (argv, message) in [
        (
            vec!["list", "--json=1"],
            "Option '--json' does not take an argument".to_string(),
        ),
        (
            vec!["list", "--json="],
            "Option '--json' does not take an argument".to_string(),
        ),
        (
            vec!["spawn", "--role"],
            "Option '--role <value>' argument missing".to_string(),
        ),
        (vec!["spawn", "--role", "--task", "x"], ambiguous("--role")),
        (vec!["read", "r1", "--lines", "-5"], ambiguous("--lines")),
        (vec!["report", "--hours", "-0x5"], ambiguous("--hours")),
        (vec!["list", "-x"], unknown("-x")),
        (vec!["list", "-abc"], unknown("a")),
        (vec!["list", "--Json"], unknown("--Json")),
        (vec!["list", "---x"], unknown("---x")),
        (vec!["list", "--bogus=1"], unknown("--bogus")),
        (vec!["guide", "--bogus"], unknown("--bogus")),
    ] {
        let actual = run_case(&Case::new(&argv));
        assert_eq!(actual.requests, vec![], "{argv:?}");
        assert_eq!(actual.stdout, "", "{argv:?}");
        assert_eq!(
            actual.stderr,
            format!("fleet: {message}\n\n{usage}"),
            "{argv:?}"
        );
        assert_eq!(actual.exit_code, 2, "{argv:?}");
    }
}

#[test]
fn arguments_after_a_double_dash_and_a_lone_dash_are_positional() {
    let runs = json!({ "runs": [] });
    for argv in [
        vec!["list", "--", "--json"],
        vec!["list", "-"],
        vec!["list", "--"],
        vec!["list", "--all", "--all"],
        vec!["list", "--role=a=b"],
    ] {
        let actual = run_case(
            &Case::new(&argv)
                .env("HERDR_FLEET_GROUP", "g")
                .respond(200, runs.clone()),
        );
        assert_eq!(actual.stdout, "no agents\n", "{argv:?}");
        assert_eq!(actual.exit_code, 0, "{argv:?}");
    }
    let actual = run_case(
        &Case::new(&["read", "r1", "--lines=-5"])
            .env("HERDR_FLEET_GROUP", "g")
            .respond(200, json!({ "text": "t" })),
    );
    assert_eq!(
        actual.paths(),
        vec!["/api/fleet/runs/r1/read?group=g&lines=-5"]
    );
    let actual = run_case(
        &Case::new(&["read", "r1", "--lines", "-"])
            .env("HERDR_FLEET_GROUP", "g")
            .respond(200, json!({ "text": "t" })),
    );
    assert_eq!(
        actual.paths(),
        vec!["/api/fleet/runs/r1/read?group=g&lines=-"]
    );
}

#[test]
fn help_comes_before_the_arguments_are_read_and_an_unknown_command_after() {
    let actual = run_case(&Case::new(&["help", "--bogus"]));
    assert_eq!((actual.stdout, actual.exit_code), (usage_text(), 0));
    let usage = usage_text();
    for (argv, command) in [
        (vec!["bogus", "--json"], "bogus"),
        (vec!["--json"], "--json"),
    ] {
        let actual = run_case(&Case::new(&argv));
        assert_eq!(
            actual.stderr,
            format!("fleet: unknown command: {command}\n\n{usage}")
        );
        assert_eq!(actual.exit_code, 2);
    }
}

#[test]
fn the_depth_is_read_as_parse_int_does() {
    for (given, sent) in [
        ("3abc", json!(3)),
        ("abc", json!(0)),
        ("-2", json!(-2)),
        (" 7", json!(7)),
        ("1e3", json!(1)),
        ("", json!(0)),
        ("0x10", json!(0)),
        ("-0", json!(0)),
        ("99999999999999999999", json!(1e20)),
    ] {
        let actual = run_case(
            &Case::new(&["thread", "--title", "t", "--task", "x"])
                .env("HERDR_FLEET_DEPTH", given)
                .respond(200, done_run()),
        );
        let body = actual.requests[0].body.clone().expect("a body");
        assert_eq!(body["depth"].as_f64(), sent.as_f64(), "depth {given:?}");
        assert_eq!(body["depth"].is_i64(), sent.is_i64(), "depth {given:?}");
    }
}

#[test]
fn the_group_comes_from_the_pane_id_lowercased_with_other_characters_as_dashes() {
    for (pane, group) in [
        ("W1:P_2.Ä x", "fleet-w1-p_2-x"),
        ("", "fleet-default"),
        ("ABC--def", "fleet-abc--def"),
        ("İx", "fleet-i-x"),
        ("ΣΑΣ", "fleet--"),
    ] {
        let actual = run_case(
            &Case::new(&["list"])
                .env("HERDR_PANE_ID", pane)
                .respond(200, json!({ "runs": [] })),
        );
        assert_eq!(
            actual.paths(),
            vec![format!("/api/fleet/runs?group={group}")],
            "pane {pane:?}"
        );
    }
}

#[test]
fn an_empty_pane_id_is_sent_but_an_empty_token_is_not() {
    let actual = run_case(
        &Case::new(&["spawn", "--role", "r", "--task", "t"])
            .env("HERDR_PANE_ID", "")
            .env("HERDR_FLEET_TOKEN", "")
            .respond(200, done_run()),
    );
    assert_eq!(
        actual.requests[0].body,
        Some(
            json!({ "role": "r", "task": "t", "cwd": "$CWD", "group": "fleet-default", "depth": 0, "caller_pane_id": "" })
        )
    );
    assert_eq!(
        actual.requests[0].headers.get("authorization"),
        None,
        "an empty token sends no authorization"
    );
}

#[test]
fn a_brief_of_only_some_flags_sends_those() {
    let actual = run_case(
        &Case::new(&[
            "spawn", "--role", "r", "--forbid", "x", "--write", "a", "--write", "b", "--avoid",
            "pi",
        ])
        .respond(200, done_run()),
    );
    assert_eq!(
        actual.requests[0].body,
        Some(json!({
            "role": "r", "brief": { "write": ["a", "b"], "forbidden": "x" }, "cwd": "$CWD",
            "group": "fleet-default", "depth": 0, "avoid": ["pi"]
        }))
    );
}

#[test]
fn values_in_a_path_are_encoded_as_encode_uri_component_does() {
    let actual = run_case(
        &Case::new(&["read", "a b/c?d#e%f!~*'()é😀"])
            .env("HERDR_FLEET_GROUP", "g&h")
            .respond(200, json!({ "text": "t" })),
    );
    assert_eq!(
        actual.paths(),
        vec!["/api/fleet/runs/a%20b%2Fc%3Fd%23e%25f!~*'()%C3%A9%F0%9F%98%80/read?group=g%26h"]
    );
    let actual = run_case(
        &Case::new(&["report", "--json", "--planned-label", "a b&c/é"])
            .respond(200, json!({ "report": "x\"y" })),
    );
    assert_eq!(
        actual.paths(),
        vec!["/api/fleet/report?cwd=$CWD&hours=24&planned_label=a%20b%26c%2F%C3%A9"]
    );
    assert_eq!(actual.stdout, "\"x\\\"y\"\n");
}

#[test]
fn send_joins_the_words_of_the_message_with_spaces() {
    let actual = run_case(
        &Case::new(&["send", "w", "a", "", "b"])
            .env("HERDR_FLEET_GROUP", "g")
            .respond(200, done_run()),
    );
    assert_eq!(
        actual.requests[0].body,
        Some(json!({ "message": "a  b", "group": "g" }))
    );
}

#[test]
fn read_trims_the_end_and_leaves_out_empty_lines_option() {
    let actual = run_case(
        &Case::new(&["read", "w", "--lines="])
            .env("HERDR_FLEET_GROUP", "g")
            .respond(200, json!({ "text": "a  \n\n" })),
    );
    assert_eq!(actual.paths(), vec!["/api/fleet/runs/w/read?group=g"]);
    assert_eq!(actual.stdout, "a\n");
}

#[test]
fn usage_clear_sends_only_the_first_key() {
    let actual =
        run_case(&Case::new(&["usage", "clear", "a", "b"]).respond(200, json!({ "cleared": [] })));
    assert_eq!(actual.requests[0].body, Some(json!({ "key": "a" })));
    assert_eq!(actual.stdout, "nothing was cooling down\n");
}

#[test]
fn an_empty_cwd_is_sent_as_given() {
    let actual = run_case(&Case::new(&["roles", "--cwd="]).respond(200, json!({ "roles": [] })));
    assert_eq!(actual.paths(), vec!["/api/fleet/roles?cwd="]);
    assert_eq!(actual.stdout, "\n");
}

#[test]
fn json_output_writes_numbers_and_text_as_json_stringify_does() {
    let actual = run_case(
        &Case::new(&["list", "--json"])
            .env("HERDR_FLEET_GROUP", "g")
            .respond(
                200,
                json!({ "runs": [{ "a": 1.0, "b": 1e21, "c": 1e-7, "d": -0.0, "e": 0.1, "f": 123456789012345680000.0, "g": "\u{2028}<\u{7f}", "h": [], "i": {} }] }),
            ),
    );
    assert_eq!(
        actual.stdout,
        "[\n  {\n    \"a\": 1,\n    \"b\": 1e+21,\n    \"c\": 1e-7,\n    \"d\": 0,\n    \"e\": 0.1,\n    \"f\": 123456789012345680000,\n    \"g\": \"\u{2028}<\u{7f}\",\n    \"h\": [],\n    \"i\": {}\n  }\n]\n"
    );
}

#[test]
fn a_plan_file_may_start_with_a_byte_order_mark() {
    let actual = run_case(
        &Case::new(&["plan", "p.json"])
            .env("HERDR_FLEET_RUN", "r5")
            .file("p.json", "\u{feff}{\"title\":\"t\"}")
            .respond(200, json!({ "plan": { "version": 2, "title": "t" } })),
    );
    assert_eq!(
        actual.requests[0].body,
        Some(json!({ "plan": { "title": "t" }, "group": "fleet-default" }))
    );
    assert_eq!(actual.exit_code, 0);
}

#[test]
fn a_plan_keeps_the_last_of_repeated_keys_in_the_place_of_the_first() {
    let actual = run_case(
        &Case::new(&["plan", "-"])
            .env("HERDR_FLEET_RUN", "r5")
            .stdin("{\"a\":1,\"b\":2,\"a\":3}")
            .respond(200, json!({ "plan": { "version": 2, "title": "t" } })),
    );
    let body = actual.requests[0].body.clone().expect("a body");
    assert_eq!(
        body,
        json!({ "plan": { "a": 3, "b": 2 }, "group": "fleet-default" })
    );
    let keys: Vec<_> = body["plan"].as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, vec!["a", "b"]);
}

#[test]
fn a_plan_needs_a_non_empty_caller_run_and_a_readable_file() {
    let actual = run_case(
        &Case::new(&["plan", "-"])
            .env("HERDR_FLEET_RUN", "")
            .stdin("{}"),
    );
    assert_eq!(
        (actual.stderr.as_str(), actual.exit_code),
        (
            "fleet: fleet plan: only a thread's lead the fleet started writes a plan (HERDR_FLEET_RUN is not set)\n",
            2
        )
    );
    // the reason is the runtime's (Bun: "Directories cannot be read like files")
    let actual = run_case(&Case::new(&["plan", "."]).env("HERDR_FLEET_RUN", "r5"));
    assert!(
        actual.stderr.starts_with("fleet: cannot read .: ") && actual.stderr.len() > 22,
        "{:?}",
        actual.stderr
    );
    assert_eq!((actual.requests.len(), actual.exit_code), (0, 2));
}

#[test]
fn missing_fields_of_a_run_print_as_undefined() {
    let actual = run_case(
        &Case::new(&["spawn", "--role", "r", "--task", "t"]).respond(200, json!({ "run": {} })),
    );
    assert_eq!(
        actual.stdout,
        "undefined  undefined (undefined, undefined)  undefined  pane undefined\n"
    );
    assert_eq!(actual.exit_code, 0);
}

/// Worked out by hand (the TypeScript CLI fails on `pr.state.toLowerCase()`): an unknown thread
/// state and contract mark index nothing in THREAD_STATES and CONTRACT_MARKS, so they print as
/// `undefined`, and so does the missing state of the pull request.
#[test]
fn a_thread_with_unknown_values_and_missing_fields_prints_them_as_undefined() {
    let actual = run_case(&Case::new(&["threads"]).respond(
        200,
        json!({ "threads": [{ "run": { "id": "r1", "name": "n", "pr": { "number": 3, "url": "u", "checks": "c" } }, "state": "weird", "contract": [{ "id": "A1", "state": "x" }] }] }),
    ));
    assert_eq!(
        actual.stdout,
        "r1  n  undefined\n    Contract: A1 undefined\n    PR #3 undefined, checks c: u\n"
    );
    assert_eq!(actual.exit_code, 0);
    // recorded from the TypeScript CLI
    let actual = run_case(&Case::new(&["threads"]).respond(
        200,
        json!({ "threads": [{ "run": { "id": "r1", "name": "n" } }] }),
    ));
    assert_eq!(actual.stdout, "r1  n  undefined\n");
}

/// Worked out by hand (the TypeScript CLI fails on `entry.key.padEnd`): a missing key pads
/// `undefined`, a reset time of 0 is left out (it is falsy), a missing or out-of-range time
/// prints as `Invalid Date`, as `new Date(undefined)` and `new Date(1e300)` do.
#[test]
fn usage_with_missing_fields_prints_them_as_undefined() {
    let actual = run_case(&Case::new(&["usage"]).respond(
        200,
        json!({ "usage": [
            { "reading": { "windows": [{ "name": "w", "usedPercent": 12.5, "resetsAt": 0 }] }, "cooldown": { "until": 9e15, "reason": "x" } },
            { "key": "k", "reading": { "readAt": 1e300, "windows": [] } }
        ] }),
    ));
    assert_eq!(
        actual.stdout,
        "undefined    w 12.5%  read Invalid Date\n             cooling down until Invalid Date: x\nk              read Invalid Date\n"
    );
    assert_eq!(actual.exit_code, 0);
}

/// Worked out by hand (the TypeScript CLI fails on `role.name.padEnd`).
#[test]
fn roles_with_missing_fields_print_them_as_undefined() {
    let actual = run_case(&Case::new(&["roles"]).respond(
        200,
        json!({ "roles": [{ "name": "averyveryverylongname", "agent": "claude", "description": "d" }, {}] }),
    ));
    assert_eq!(
        actual.stdout,
        "averyveryverylongname claude d\nundefined    undefined undefined\n"
    );
}

/// The TypeScript CLI fails with a TypeError (exit 1) when the answer lacks the field it reads
/// (`run`, `runs`, …); the Rust CLI fails with exit 1 too, and says what is missing (an
/// assumption of #251, written in its pull request).
#[test]
fn an_answer_without_the_field_the_command_reads_fails() {
    for (argv, body, field) in [
        (
            vec!["spawn", "--role", "r", "--task", "t"],
            json!({}),
            "run",
        ),
        (
            vec!["spawn", "--role", "r", "--task", "t", "--json"],
            json!({}),
            "run",
        ),
        (vec!["list"], json!("hello"), "runs"),
        (vec!["read", "w"], json!({}), "text"),
    ] {
        let actual = run_case(&Case::new(&argv).respond(200, body));
        assert_eq!(actual.stdout, "", "{argv:?}");
        assert_eq!(
            actual.stderr,
            format!("fleet: the fleet server's answer has no {field}\n"),
            "{argv:?}"
        );
        assert_eq!(actual.exit_code, 1, "{argv:?}");
    }
}

#[test]
fn an_error_answer_keeps_an_empty_code_and_message() {
    let actual = run_case(
        &Case::new(&["list"]).respond(500, json!({ "error": { "code": "", "message": "" } })),
    );
    assert_eq!(
        (actual.stderr.as_str(), actual.exit_code),
        ("fleet: : \n", 1)
    );
}

#[test]
fn a_wait_timeout_on_another_command_exits_124_and_prints_nothing() {
    let actual = run_case(
        &Case::new(&["spawn", "--role", "r", "--task", "t"]).respond(
            408,
            json!({ "error": { "code": "wait_timeout", "message": "m" }, "run": { "id": "r" } }),
        ),
    );
    assert_eq!(
        (
            actual.stdout.as_str(),
            actual.stderr.as_str(),
            actual.exit_code
        ),
        ("", "", 124)
    );
}

/// The CLI talks to the fleet server it is given, never through a proxy: the server refuses a
/// request that came through one (`cameThroughProxy`, server/access.ts), and `run` reads no
/// variable but the ones it is given.
#[test]
fn proxy_variables_are_not_used() {
    let actual = run_case(
        &Case::new(&["list"])
            .env("HERDR_FLEET_GROUP", "g")
            .env("HTTP_PROXY", "http://127.0.0.1:9")
            .env("http_proxy", "http://127.0.0.1:9")
            .env("ALL_PROXY", "http://127.0.0.1:9")
            .respond(200, json!({ "runs": [] })),
    );
    assert_eq!(
        (actual.stdout.as_str(), actual.exit_code),
        ("no agents\n", 0)
    );
}

fn usage_read_at(tz: &str, read_at: f64) -> String {
    let actual = run_case(&Case::new(&["usage"]).env("TZ", tz).respond(
        200,
        json!({ "usage": [{ "key": "k", "reading": { "readAt": read_at, "windows": [] } }] }),
    ));
    assert_eq!(actual.exit_code, 0);
    actual
        .stdout
        .strip_prefix("k              read ")
        .and_then(|t| t.strip_suffix('\n'))
        .unwrap_or_else(|| panic!("unexpected output {:?}", actual.stdout))
        .to_string()
}

/// `toLocaleString()` in en-US, in the zone the passed `TZ` names (not the process's own: the
/// tests of one process run side by side with different zones).
#[test]
fn times_are_written_in_en_us_form_in_the_zone_tz_names() {
    for (tz, ms, text) in [
        ("UTC", 0.0, "1/1/1970, 12:00:00 AM"),
        ("UTC", 43_200_000.0, "1/1/1970, 12:00:00 PM"),
        ("UTC", -1.0, "12/31/1969, 11:59:59 PM"),
        ("UTC", 1.9, "1/1/1970, 12:00:00 AM"),
        ("UTC", -1.9, "12/31/1969, 11:59:59 PM"),
        ("UTC", 8.64e15, "9/13/275760, 12:00:00 AM"),
        ("UTC", 8.64e15 + 1.0, "Invalid Date"),
        ("UTC", -8.64e15, "4/20/271822, 12:00:00 AM"),
        ("UTC", -62_198_755_200_000.0, "1/1/2, 12:00:00 AM"),
        ("UTC", -62_135_596_800_000.0, "1/1/1, 12:00:00 AM"),
        ("UTC", -59_011_459_200_000.0, "1/1/100, 12:00:00 AM"),
        ("UTC", 1_262_401_445_000.0, "1/2/2010, 3:04:05 AM"),
        ("Asia/Tokyo", 0.0, "1/1/1970, 9:00:00 AM"),
        ("Asia/Tokyo", 2_209_104_000_000.0, "1/2/2040, 5:00:00 PM"),
        ("Asia/Tokyo", 8.64e15, "9/13/275760, 9:00:00 AM"),
        ("Asia/Tokyo", -8.64e15, "4/20/271822, 9:18:59 AM"),
        ("Asia/Tokyo", -62_135_596_800_000.0, "1/1/1, 9:18:59 AM"),
        (":Asia/Tokyo", 2_209_104_000_000.0, "1/2/2040, 5:00:00 PM"),
        ("asia/tokyo", 2_209_104_000_000.0, "1/2/2040, 5:00:00 PM"),
        ("America/New_York", 0.0, "12/31/1969, 7:00:00 PM"),
        (
            "America/New_York",
            1_710_054_000_000.0,
            "3/10/2024, 3:00:00 AM",
        ),
        (
            "America/New_York",
            1_699_167_600_000.0,
            "11/5/2023, 2:00:00 AM",
        ),
        ("America/New_York", 8.64e15, "9/12/275760, 8:00:00 PM"),
        ("America/New_York", -8.64e15, "4/19/271822, 7:03:58 PM"),
        (
            "America/New_York",
            -62_198_755_200_000.0,
            "12/31/3, 7:03:58 PM",
        ),
        ("Europe/London", 0.0, "1/1/1970, 1:00:00 AM"),
        ("Europe/London", -8.64e15, "4/19/271822, 11:58:45 PM"),
        ("Etc/GMT-3", 2_209_104_000_000.0, "1/2/2040, 11:00:00 AM"),
        // what the zone database does not name is UTC, as in Bun
        ("Nope/Zone", 2_209_104_000_000.0, "1/2/2040, 8:00:00 AM"),
        ("JST-9", 2_209_104_000_000.0, "1/2/2040, 8:00:00 AM"),
        ("", 2_209_104_000_000.0, "1/2/2040, 8:00:00 AM"),
        ("Asia/Tokyo ", 2_209_104_000_000.0, "1/2/2040, 8:00:00 AM"),
    ] {
        assert_eq!(usage_read_at(tz, ms), text, "TZ={tz:?}, {ms} ms");
    }
}
