//! Every fixture, parsed by libghostty-vt, gives the screen Ghostty 1.4.0
//! wrote for the same bytes: byte for byte, and so line for line.

use terminal_vt::fixtures::{self, first_difference, lines};
use terminal_vt::{Wraps, ghostty};

#[test]
fn libghostty_vt_matches_ghostty_on_every_fixture() {
    let all = fixtures::all();
    assert!(all.len() >= 5, "Issue #109 asks for at least 5 recordings");
    let mut failed = Vec::new();
    for f in &all {
        let text = ghostty::screen_text(f.cols, f.rows, &f.bytes, Wraps::Join);
        let expected = lines(&f.ghostty_screen);
        let diff = first_difference(&expected, &lines(&text));
        let exact = text == f.ghostty_screen;
        match (&diff, exact) {
            (None, true) => println!(
                "libghostty-vt {}: match ({}x{}, {} lines, byte-identical)",
                f.name,
                f.cols,
                f.rows,
                expected.len()
            ),
            (None, false) => {
                println!("libghostty-vt {}: lines match, bytes differ", f.name);
                failed.push(f.name.clone());
            }
            (Some((line, want, got)), _) => {
                println!(
                    "libghostty-vt {}: MISMATCH at line {line}\n  ghostty: {want:?}\n  libghostty-vt: {got:?}",
                    f.name
                );
                failed.push(f.name.clone());
            }
        }
    }
    assert!(
        failed.is_empty(),
        "libghostty-vt differs from Ghostty on {failed:?}"
    );
}
