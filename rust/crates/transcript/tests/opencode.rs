//! The opencode cases of the conversation corpus (`fixtures/conversations/opencode/`), in order
//! and in the reverse order, against the replies each case recorded (#204).

mod common;

#[test]
fn opencode_conversations() {
    common::check(common::Slice::Opencode);
}
