//! The last-resort cards of a blocked pane no reader knows (#199): a numbered menu that ends the
//! screen, or the screen's last lines with the keys its hints name.

mod common;

#[test]
fn fallback_cases() {
    common::check(common::Slice::Fallback);
}
