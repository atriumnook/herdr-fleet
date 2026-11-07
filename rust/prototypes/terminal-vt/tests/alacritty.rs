//! The same fixtures through `alacritty_terminal`, to know how close the
//! fallback is. Compared line by line, each line's trailing spaces dropped
//! (see `terminal_vt::alacritty`). ADR 0109-terminal-emulator records the
//! result; this test fails when it changes.

use terminal_vt::fixtures::{self, first_difference, lines};
use terminal_vt::{Wraps, alacritty, ghostty};

/// Every fixture but `nvim-japanese`. There nvim fills a row and moves on
/// with CR LF on its second draw; Ghostty keeps the row's soft-wrap mark
/// from the first draw, alacritty_terminal clears it, so Ghostty's unwrapped
/// text joins two rows that alacritty_terminal keeps apart. The rows'
/// characters are the same (`rows_match_libghostty_vt` below).
const MATCHING: &[&str] = &[
    "claude-startup",
    "codex-startup",
    "less-sgr",
    "scroll-wrap",
    "sgr-colors",
    "wide-chars",
];

#[test]
fn alacritty_terminal_against_ghostty() {
    let all = fixtures::all();
    let mut matched = Vec::new();
    for f in &all {
        let text = alacritty::screen_text(f.cols, f.rows, &f.bytes, Wraps::Join);
        match first_difference(&lines(&f.ghostty_screen), &lines(&text)) {
            None => {
                println!("alacritty_terminal {}: match", f.name);
                matched.push(f.name.as_str());
            }
            Some((line, want, got)) => println!(
                "alacritty_terminal {}: MISMATCH at line {line}\n  ghostty: {want:?}\n  alacritty_terminal: {got:?}",
                f.name
            ),
        }
    }
    println!(
        "alacritty_terminal matched {} of {}",
        matched.len(),
        all.len()
    );
    assert_eq!(matched, MATCHING);
}

/// With every row on its own line, alacritty_terminal and libghostty-vt
/// (which gives Ghostty's screen, see tests/ghostty_vt.rs) agree on every
/// fixture, `nvim-japanese` included: the one difference above is only in
/// which rows count as wrapped.
#[test]
fn rows_match_libghostty_vt() {
    for f in &fixtures::all() {
        let ghostty = lines(&ghostty::screen_text(f.cols, f.rows, &f.bytes, Wraps::Keep));
        let alacritty = lines(&alacritty::screen_text(
            f.cols,
            f.rows,
            &f.bytes,
            Wraps::Keep,
        ));
        if let Some((line, want, got)) = first_difference(&ghostty, &alacritty) {
            panic!(
                "{}: row {line} differs\n  libghostty-vt: {want:?}\n  alacritty_terminal: {got:?}",
                f.name
            );
        }
        println!(
            "rows {}: alacritty_terminal = libghostty-vt ({} rows)",
            f.name,
            ghostty.len()
        );
    }
}
