//! The Claude Code cases of the conversation corpus (`fixtures/conversations/claude/`), in order
//! and in the reverse order (#201).

mod common;

#[test]
fn claude_conversations() {
    common::check(common::Slice::Claude);
}
