//! Prototype for Issue #109: parse recorded pane bytes with libghostty-vt
//! (and, for comparison, `alacritty_terminal`) and compare the screen text
//! with what Ghostty 1.4.0 wrote for the same bytes (`fixtures/`).
//!
//! Every emulator here produces the screen text in the shape of Ghostty's
//! `write_screen_file` action with the `plain` format: the scrollback and the
//! active screen of the screen in use (primary or alternate), one line per
//! row, soft-wrapped rows joined ([`Wraps::Join`]), no trailing blank rows,
//! no final newline.

pub mod alacritty;
pub mod fixtures;
pub mod ghostty;

/// What to do with a row that the terminal wrapped onto the next one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wraps {
    /// Join it with the next row into one line, as Ghostty's
    /// `write_screen_file` does.
    Join,
    /// Keep every row on its own line.
    Keep,
}
