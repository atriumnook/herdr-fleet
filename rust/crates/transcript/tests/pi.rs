//! The pi cases of the conversation corpus (`fixtures/conversations/pi/`), in order and in the
//! reverse order (#203).

mod common;

#[test]
fn pi_conversations() {
    common::check(common::Slice::Pi);
}
