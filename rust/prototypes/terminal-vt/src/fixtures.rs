//! The recorded fixtures (`fixtures/<name>/`, see `fixtures/README.md`) and
//! the comparison of an emulator's screen text with Ghostty's.

use std::fs;
use std::path::{Path, PathBuf};

pub struct Fixture {
    pub name: String,
    pub cols: u16,
    pub rows: u16,
    /// `output.bin`: the bytes the pty's master side read, unchanged.
    pub bytes: Vec<u8>,
    /// `ghostty-screen.txt`: what Ghostty 1.4.0 wrote for those bytes.
    pub ghostty_screen: Vec<u8>,
}

pub fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

/// Every fixture, sorted by name.
pub fn all() -> Vec<Fixture> {
    let mut names: Vec<String> = fs::read_dir(dir())
        .expect("read fixtures/")
        .map(|e| e.expect("fixtures/ entry"))
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().into_string().expect("UTF-8 fixture name"))
        .collect();
    names.sort();
    names.into_iter().map(load).collect()
}

fn load(name: String) -> Fixture {
    let base = dir().join(&name);
    let read =
        |file: &str| fs::read(base.join(file)).unwrap_or_else(|e| panic!("{name}/{file}: {e}"));
    let size = String::from_utf8(read("size.txt")).expect("size.txt is UTF-8");
    let (cols, rows) = size
        .trim()
        .split_once('x')
        .unwrap_or_else(|| panic!("{name}/size.txt is not <cols>x<rows>"));
    Fixture {
        cols: cols.parse().expect("cols"),
        rows: rows.parse().expect("rows"),
        bytes: read("output.bin"),
        ghostty_screen: read("ghostty-screen.txt"),
        name,
    }
}

/// The screen's text lines: each line's trailing spaces and the trailing
/// empty lines dropped. A never-written cell and a written space look the
/// same on screen, and not every emulator tells them apart.
pub fn lines(text: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(text);
    let mut lines: Vec<String> = text
        .split('\n')
        .map(|l| l.trim_end_matches(' ').to_string())
        .collect();
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    lines
}

/// The first line (1-based) where `actual` differs from `expected`, with
/// both lines, or `None` when every line is the same. A line that only one
/// side has is a difference even when it is empty, so the reported line is
/// where the two first part, whether or not the input went through [`lines`].
pub fn first_difference(expected: &[String], actual: &[String]) -> Option<(usize, String, String)> {
    let n = expected.len().max(actual.len());
    (0..n).find_map(|i| {
        let e = expected.get(i).cloned().unwrap_or_default();
        let a = actual.get(i).cloned().unwrap_or_default();
        (e != a || i >= expected.len() || i >= actual.len()).then(|| (i + 1, e, a))
    })
}
