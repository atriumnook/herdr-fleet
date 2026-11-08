//! Codex's file edits (`shared/patch.ts`): an `apply_patch` call carries the patch as its whole
//! input, and the `exec` tool's scripts carry it as the string argument of
//! `tools.apply_patch(…)`. Both read as a raw blob unless the patch is found and its files named.

use std::sync::LazyLock;

use regex::Regex;

use crate::js;

const BEGIN: &str = "*** Begin Patch";

/// `tools.apply_patch(` and its first argument, a JSON string or a template literal
/// (`/tools\.apply_patch\(\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/s`).
static APPLY_PATCH_CALL: LazyLock<Regex> = LazyLock::new(|| {
    let space = js::WHITESPACE;
    Regex::new(&format!(
        r#"tools\.apply_patch\({space}*("(?:[^"\\]|\\(?s:.))*"|`(?:[^`\\]|\\(?s:.))*`)"#
    ))
    .unwrap()
});

/// A line naming a file of the patch (`/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m`, matched on
/// each line).
static FILE_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\*\*\* (?:Update|Add|Delete) File: (.+)$").unwrap());

/// The patch an edit call carries, or `None` when the input is not one.
pub fn patch_text(input: &str) -> Option<String> {
    let trimmed = js::trim_start(input);
    if trimmed.starts_with(BEGIN) {
        return Some(trimmed.to_owned());
    }
    let literal = APPLY_PATCH_CALL.captures(input)?.get(1)?.as_str();
    let text = match literal.strip_prefix('`') {
        Some(template) => template[..template.len() - 1].replace("\\`", "`"),
        // serde_json refuses an unpaired surrogate escape that JSON.parse keeps: such a call reads
        // as no patch (ADR 0193-phase-2-dependencies)
        None => serde_json::from_str::<String>(literal).ok()?,
    };
    let text = js::trim_start(&text);
    text.starts_with(BEGIN).then(|| text.to_owned())
}

/// The files a patch adds, updates or deletes, in the order it names them.
pub fn patch_files(patch: &str) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    for line in patch.split(js::is_line_terminator) {
        let Some(name) = FILE_LINE.captures(line).and_then(|found| found.get(1)) else {
            continue;
        };
        let file = js::trim(name.as_str());
        if !files.iter().any(|known| known == file) {
            files.push(file.to_owned());
        }
    }
    files
}
