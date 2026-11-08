//! Every case of the conversation corpus (`fixtures/conversations/`) in one test, whichever source
//! it reads, in order and in the reverse order (#206): the completion of phase 2 in
//! docs/rust-migration/plan.md. Each source's own test (`omp.rs` and the others) stays.

mod common;

use std::collections::BTreeMap;

#[test]
fn every_conversation_case() {
    let mut sources = BTreeMap::new();
    for case in common::load_cases() {
        *sources.entry(case.source).or_insert(0) += 1;
    }
    println!("the cases of each source: {sources:?}");
    common::check_all();
}
