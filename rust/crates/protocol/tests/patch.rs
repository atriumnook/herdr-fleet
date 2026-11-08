//! `shared/patch.test.ts`, with its expected values.

use herdr_fleet_protocol::{patch_files, patch_text};

const PATCH: &str = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: docs/b.md\n+hi\n*** End Patch\n";

#[test]
fn finds_a_patch_given_whole_or_as_the_string_an_exec_script_hands_to_apply_patch() {
    assert_eq!(patch_text(PATCH).as_deref(), Some(PATCH));
    // `JSON.stringify(PATCH)` in the TypeScript test: the patch as a JSON string literal.
    let literal = serde_json::to_string(PATCH).unwrap();
    let script = format!("text(await tools.apply_patch({literal}));\nconsole.log(\"done\")");
    assert_eq!(patch_text(&script).as_deref(), Some(PATCH));
    assert_eq!(
        patch_text(&format!("await tools.apply_patch(`{PATCH}`)")).as_deref(),
        Some(PATCH)
    );
    assert_eq!(patch_text("tools.exec_command({cmd: 'ls'})"), None);
    assert_eq!(patch_text("tools.apply_patch(\"not a patch\")"), None);
}

#[test]
fn names_each_file_a_patch_touches_once_in_order() {
    let patch = format!("{PATCH}*** Update File: src/a.ts\n*** Delete File: old.txt\n");
    assert_eq!(patch_files(&patch), ["src/a.ts", "docs/b.md", "old.txt"]);
}

/// Where JavaScript's whitespace and line terminators differ from Rust's: the expected values are
/// what `shared/patch.ts` returns for these inputs under Bun 1.4.4.
#[test]
fn reads_whitespace_and_line_ends_as_javascript_does() {
    let patch = "*** Begin Patch\n*** Update File: a.ts\n*** End Patch\n";
    // `trimStart` removes U+FEFF and keeps U+0085
    assert_eq!(
        patch_text(&format!("\u{FEFF}{patch}")).as_deref(),
        Some(patch)
    );
    assert_eq!(patch_text(&format!("\u{85}{patch}")), None);
    // `\s` takes U+3000 and a line break between the call and its argument
    let literal = serde_json::to_string(patch).unwrap();
    assert_eq!(
        patch_text(&format!("tools.apply_patch(\u{3000}\n{literal})")).as_deref(),
        Some(patch)
    );
    // JSON.parse refuses an escape JSON does not have
    assert_eq!(patch_text(r#"tools.apply_patch("\x41")"#), None);
    // `$` ends a line at \r and U+2028 as at \n; `trim` keeps U+0085
    let files = "*** Begin Patch\r\n*** Update File: a.ts \r\n*** Add File: b.md\u{2028}*** Delete File: c\u{85}\n";
    assert_eq!(patch_files(files), ["a.ts", "b.md", "c\u{85}"]);
}
