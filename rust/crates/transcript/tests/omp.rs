//! The omp cases of the conversation corpus (`fixtures/conversations/omp/`), in order and in the
//! reverse order (#196).

mod common;

#[test]
fn omp_conversations() {
    common::check(common::Slice::Omp);
}
