//! The fleet CLI contract (`fixtures/fleet-cli/`, ADR 0122-parity-criteria) on the Rust CLI's
//! `run`, in this process: every case's requests, standard output, standard error and exit
//! status, compared as `bin/fleet-cli-fixtures.test.ts` ("fleet CLI contract") compares them. The
//! expected values are the cases', which the TypeScript CLI wrote. The same cases run on the
//! built executable with `HERDR_FLEET_CLI_TARGET=rust:<path> bun test bin/fleet-cli-fixtures.test.ts`.

mod common;

use common::{Case, cases_dir, output_matches, pattern_matches, run_case};
use serde_json::Value;

#[test]
fn every_case_of_the_fleet_cli_contract_passes() {
    let mut names: Vec<_> = std::fs::read_dir(cases_dir())
        .expect("the corpus folder")
        .map(|entry| entry.expect("an entry").path())
        .filter(|path| path.extension().is_some_and(|e| e == "json"))
        .collect();
    names.sort();
    assert!(
        names.len() >= 87,
        "the corpus holds {} cases, fewer than the 87 of the issue",
        names.len()
    );
    let mut failures = Vec::new();
    for path in &names {
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        let spec: Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("a case")).expect("JSON");
        let expected = &spec["expected"];
        let actual = run_case(&Case::from_json(&spec));
        let requests: Vec<Value> = actual.requests.iter().map(|r| r.to_json()).collect();
        let mut wrong = Vec::new();
        if Value::Array(requests.clone()) != expected["requests"] {
            wrong.push(format!(
                "requests: expected {}, got {}",
                expected["requests"],
                Value::Array(requests)
            ));
        }
        if !output_matches(&expected["stdout"], &actual.stdout) {
            wrong.push(format!(
                "stdout: expected {}, got {:?}",
                expected["stdout"], actual.stdout
            ));
        }
        if !output_matches(&expected["stderr"], &actual.stderr) {
            wrong.push(format!(
                "stderr: expected {}, got {:?}",
                expected["stderr"], actual.stderr
            ));
        }
        if Some(actual.exit_code as i64) != expected["exitCode"].as_i64() {
            wrong.push(format!(
                "exit status: expected {}, got {}",
                expected["exitCode"], actual.exit_code
            ));
        }
        if !wrong.is_empty() {
            failures.push(format!("{name}:\n  {}", wrong.join("\n  ")));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases failed:\n{}",
        failures.len(),
        names.len(),
        failures.join("\n")
    );
}

#[test]
fn the_pattern_matcher_reads_the_corpus_patterns_as_regular_expressions_do() {
    let pattern = "fleet: cannot read missing\\.json: .+\\n";
    assert!(pattern_matches(
        pattern,
        "fleet: cannot read missing.json: No such file\n"
    ));
    assert!(!pattern_matches(
        pattern,
        "fleet: cannot read missing.json: \n"
    ));
    assert!(!pattern_matches(
        pattern,
        "fleet: cannot read missing.json: a\nb\n"
    ));
    assert!(!pattern_matches(
        pattern,
        "fleet: cannot read missingXjson: x\n"
    ));
    let pattern = "fleet: [^\\n]*--bogus[^\\n]*\\n\\nusage";
    assert!(pattern_matches(
        pattern,
        "fleet: Unknown option '--bogus'.\n\nusage"
    ));
    assert!(!pattern_matches(pattern, "fleet: x\n--bogus\n\nusage"));
}
