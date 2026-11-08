//! Claude Code's cards and the prompt it suggests next (#197).

mod common;

#[test]
fn claude_cases() {
    common::check(common::Slice::Claude);
}
