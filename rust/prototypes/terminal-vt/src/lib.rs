//! Prototype for Issue #109: parse recorded pane bytes with libghostty-vt
//! (and, for comparison, `alacritty_terminal`) and compare the screen text
//! with what Ghostty 1.4.0 wrote for the same bytes (`fixtures/`).
//!
//! Every emulator here produces the screen text in the shape of Ghostty's
//! `write_screen_file` action with the `plain` format: the scrollback and the
//! active screen of the screen in use (primary or alternate), one line per
//! row, soft-wrapped rows joined, no trailing blank rows, no final newline.

pub mod alacritty;
pub mod fixtures;
pub mod ghostty;
