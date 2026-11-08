//! The codex cases of the conversation corpus (`fixtures/conversations/codex/`), in order and in
//! the reverse order (#202).

mod common;

#[test]
fn codex_conversations() {
    common::check(common::Slice::Codex);
}
