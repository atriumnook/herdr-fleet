//! `alacritty_terminal` (with its `vte` parser), read out in the shape of
//! Ghostty's plain `write_screen_file` output.
//!
//! An alacritty cell that was never written and a cell holding a written
//! space are the same (`' '`), so this output cannot keep the trailing spaces
//! Ghostty keeps; it drops every row's trailing spaces. Compare it with
//! [`crate::fixtures::lines`], which drops them on both sides.

use alacritty_terminal::Term;
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::Config;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::vte::ansi::Processor;

use crate::Wraps;

/// Feeds `bytes` to a new `cols` x `rows` terminal and returns the scrollback
/// and the active screen as text: soft-wrapped rows joined for
/// [`Wraps::Join`], each row's trailing spaces and the trailing blank rows
/// dropped.
pub fn screen_text(cols: u16, rows: u16, bytes: &[u8], wraps: Wraps) -> Vec<u8> {
    let size = TermSize::new(cols.into(), rows.into());
    let mut term = Term::new(Config::default(), &size, VoidListener);
    let mut parser: Processor = Processor::new();
    parser.advance(&mut term, bytes);

    let grid = term.grid();
    let top = -(grid.history_size() as i32);
    let bottom = grid.screen_lines() as i32;
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    for y in top..bottom {
        let row = &grid[Line(y)];
        let mut text = String::new();
        let mut wrapped = false;
        for x in 0..grid.columns() {
            let cell = &row[Column(x)];
            if x == grid.columns() - 1 && cell.flags.contains(Flags::WRAPLINE) {
                wrapped = true;
            }
            if cell
                .flags
                .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
            {
                continue;
            }
            // A tab leaves '\t' in the cell it started from; it shows as blank.
            text.push(if cell.c == '\t' { ' ' } else { cell.c });
            if let Some(marks) = cell.zerowidth() {
                text.extend(marks);
            }
        }
        if wrapped && wraps == Wraps::Join {
            current.push_str(&text);
        } else {
            current.push_str(text.trim_end_matches(' '));
            lines.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        lines.push(current.trim_end_matches(' ').to_string());
    }
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    lines.join("\n").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_soft_wraps_and_skips_wide_spacers() {
        let text = screen_text(4, 3, "abcdef\r\n日本語".as_bytes(), Wraps::Join);
        assert_eq!(String::from_utf8(text).unwrap(), "abcdef\n日本語");
        let text = screen_text(4, 3, "abcdef\r\n日本語".as_bytes(), Wraps::Keep);
        assert_eq!(String::from_utf8(text).unwrap(), "abcd\nef\n日本\n語");
    }
}
