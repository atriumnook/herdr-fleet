//! What a CLI the server starts on its own gets of the server's environment, and the folder it
//! runs in (`server/cli-child.ts`).
//!
//! The environments are the security tables `fixtures/security/child-process/childEnv.json` and
//! `claudeEnv.json` (ADR 0122-parity-criteria, "安全上の判定の表"), which
//! `scripts/security-fixtures/child-process.test.ts` runs against the TypeScript. The folder's
//! tests move `server/explain.test.ts`'s two `it` on `emptyWorkDir`; the others are worked out by
//! hand from `server/cli-child.ts`.

mod common;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;

use common::TempDir;
use herdr_fleet_child_process::{Env, child_env, claude_env, empty_work_dir};
use serde_json::Value;

/// The cases of `fixtures/security/child-process/<name>.json`.
fn table(name: &str) -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/security/child-process")
        .join(format!("{name}.json"));
    let text =
        fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let value: Value =
        serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    value
        .as_array()
        .expect("a table is an array of cases")
        .clone()
}

/// An environment written as a JSON object, as the tables write one.
fn env_of(value: &Value) -> Env {
    value
        .as_object()
        .expect("an environment is an object")
        .iter()
        .map(|(name, value)| {
            (
                OsString::from(name),
                OsString::from(value.as_str().expect("a variable's value is a string")),
            )
        })
        .collect()
}

fn about(case: &Value) -> &str {
    case.get("about")
        .and_then(Value::as_str)
        .expect("a case has its about")
}

#[test]
fn child_env_passes_every_case_of_its_table() {
    let cases = table("childEnv");
    // the table's size when it was written (issue #246): a case lost from it fails here
    assert_eq!(cases.len(), 71);
    for case in &cases {
        let input = case.get("input").expect("a case has its input");
        let env = env_of(input.get("env").expect("childEnv's input has its env"));
        let also_keep: Vec<&str> = input
            .get("alsoKeep")
            .map(|names| {
                names
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|name| name.as_str().unwrap())
                    .collect()
            })
            .unwrap_or_default();
        let expected = env_of(case.get("expected").expect("a case has its expected value"));
        assert_eq!(child_env(&env, &also_keep), expected, "{}", about(case));
    }
}

#[test]
fn claude_env_passes_every_case_of_its_table() {
    let cases = table("claudeEnv");
    assert_eq!(cases.len(), 19);
    for case in &cases {
        let env = env_of(case.get("input").expect("a case has its input"));
        let expected = env_of(case.get("expected").expect("a case has its expected value"));
        assert_eq!(claude_env(&env), expected, "{}", about(case));
    }
}

/// A name that is not UTF-8 is kept by no rule (each rule names text), and a kept name's value
/// passes as it is, UTF-8 or not.
#[cfg(unix)]
#[test]
fn values_pass_as_bytes() {
    use std::os::unix::ffi::OsStringExt as _;
    let odd = OsString::from_vec(vec![0x2f, 0xff, 0x62]);
    let env: BTreeMap<OsString, OsString> = [
        (OsString::from("PATH"), odd.clone()),
        (
            OsString::from_vec(vec![b'L', b'C', b'_', 0xff]),
            OsString::from("x"),
        ),
    ]
    .into();
    assert_eq!(
        child_env(&env, &[]),
        BTreeMap::from([(OsString::from("PATH"), odd)])
    );
}

#[cfg(unix)]
fn mode(path: &std::path::Path) -> u32 {
    use std::os::unix::fs::PermissionsExt as _;
    fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777
}

/// `server/explain.test.ts`: "runs a fake claude in the server's own work folder, emptied first,
/// with the prompt on stdin" (its folder part: made, then emptied the next time).
#[cfg(unix)]
#[test]
fn makes_the_folder_private_and_empties_it_each_time() {
    let root = TempDir::new("work-dir");
    let dir = root.join("a").join("work");
    empty_work_dir(&dir).unwrap();
    assert!(dir.is_dir());
    assert_eq!(mode(&dir), 0o700);
    fs::write(dir.join("left.txt"), "x").unwrap();
    fs::create_dir_all(dir.join(".claude").join("deep")).unwrap();
    fs::write(dir.join(".claude").join("deep").join("settings.json"), "{}").unwrap();
    empty_work_dir(&dir).unwrap();
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
}

/// A folder that is already there, opened to others, is made private again.
#[cfg(unix)]
#[test]
fn a_folder_already_there_is_made_private() {
    use std::os::unix::fs::PermissionsExt as _;
    let root = TempDir::new("work-dir-open");
    let dir = root.join("work");
    fs::create_dir(&dir).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o777)).unwrap();
    empty_work_dir(&dir).unwrap();
    assert_eq!(mode(&dir), 0o700);
}

/// `server/explain.test.ts`: "uses only a real folder: a link in its place is refused".
#[cfg(unix)]
#[test]
fn a_link_in_its_place_is_refused() {
    let root = TempDir::new("work-dir-link");
    fs::create_dir(root.join("elsewhere")).unwrap();
    fs::write(root.join("elsewhere").join("keep.txt"), "x").unwrap();
    std::os::unix::fs::symlink(root.join("elsewhere"), root.join("work")).unwrap();
    assert!(empty_work_dir(&root.join("work")).is_err());
    let left: Vec<_> = fs::read_dir(root.join("elsewhere"))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(left, vec![OsString::from("keep.txt")]);
}

/// A link inside the folder is removed, not followed: what it points at stays.
#[cfg(unix)]
#[test]
fn a_link_inside_is_removed_not_followed() {
    let root = TempDir::new("work-dir-inner-link");
    fs::create_dir(root.join("elsewhere")).unwrap();
    fs::write(root.join("elsewhere").join("keep.txt"), "x").unwrap();
    let dir = root.join("work");
    empty_work_dir(&dir).unwrap();
    std::os::unix::fs::symlink(root.join("elsewhere"), dir.join("link")).unwrap();
    empty_work_dir(&dir).unwrap();
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    assert!(root.join("elsewhere").join("keep.txt").exists());
}

/// A file in the folder's place is refused, and left.
#[test]
fn a_file_in_its_place_is_refused() {
    let root = TempDir::new("work-dir-file");
    fs::write(root.join("work"), "x").unwrap();
    assert!(empty_work_dir(&root.join("work")).is_err());
    assert_eq!(fs::read_to_string(root.join("work")).unwrap(), "x");
}

/// A link named with a `/` or `/.` after it is still refused, and what it points at stays: the
/// OS would look through the link (codex's review of #280; TypeScript's `lstatSync` has the same
/// gap).
#[cfg(unix)]
#[test]
fn a_link_named_with_a_trailing_slash_is_refused() {
    use std::os::unix::fs::PermissionsExt as _;
    let root = TempDir::new("work-dir-link-slash");
    fs::create_dir(root.join("elsewhere")).unwrap();
    fs::set_permissions(root.join("elsewhere"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(root.join("elsewhere").join("keep.txt"), "x").unwrap();
    std::os::unix::fs::symlink(root.join("elsewhere"), root.join("work")).unwrap();
    let link = root.join("work").display().to_string();
    for named in [format!("{link}/"), format!("{link}/."), format!("{link}//")] {
        assert!(
            empty_work_dir(std::path::Path::new(&named)).is_err(),
            "{named}"
        );
        assert!(root.join("elsewhere").join("keep.txt").exists(), "{named}");
        assert_eq!(mode(&root.join("elsewhere")), 0o755, "{named}");
    }
    // a name that ends in `..` names another folder than the one written: refused
    assert!(empty_work_dir(&root.join("work").join("..")).is_err());
    assert!(root.join("elsewhere").join("keep.txt").exists());
}
