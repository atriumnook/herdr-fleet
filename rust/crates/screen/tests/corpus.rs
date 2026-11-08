//! Every case of the screen corpus (`fixtures/screens/`) in one test, whichever issue owns it, and
//! `sameIdAs` across the whole corpus (#206): the completion of phase 2 in
//! docs/rust-migration/plan.md. Each slice's own test (`pi_omp.rs` and the others) stays.

mod common;

use std::collections::BTreeMap;

#[test]
fn every_screen_case() {
    let mut slices = BTreeMap::new();
    for case in common::load_cases() {
        *slices
            .entry(format!("{:?}", common::slice_of(&case.spec)))
            .or_insert(0) += 1;
    }
    println!("the cases of each slice: {slices:?}");
    common::check_all();
}
