//! A question whose options carry a preview (AskUserQuestion's `preview`, Claude Code 2.1.288):
//! the selected option's preview is drawn in a box to the right of the options, "Notes: press n to
//! add notes" under it (`withoutPreview`, server/prompt.ts:416-451). The box stands in one column on
//! every line (its top corner names it), so only what sits in that column goes: a `│` inside an
//! option's own text stays. Columns are counted as `Bun.stringWidth` counts them, over the graphemes
//! `Intl.Segmenter` gives (ADR 0193-phase-2-dependencies, "文字の幅と grapheme").

use std::sync::LazyLock;

use protocol::js;
use regex::Regex;

use crate::text::{graphemes, js_regex, string_width};

/// `CLAUDE_PREVIEW_HINT_RE`: the hint of a question with previews.
pub(super) static PREVIEW_HINT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?-u:\b)n to add notes(?-u:\b)").unwrap());
/// `PREVIEW_EDGE`: the characters a preview's box is drawn with at its left edge.
const PREVIEW_EDGE: &str = "┌│└├╭╰┐┘╮╯";
/// The box's top corner, after the gap that parts it from the options.
static CORNER: LazyLock<Regex> = LazyLock::new(|| js_regex("{s}{2,}[┌╭]"));
/// The preview's own notes line: a question may begin with "Notes:" too.
static NOTES: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"(?i)^{s}*Notes:{s}+press n to add notes(?-u:\b){.}*$"));

/// `indexAtColumn`: the byte index where terminal column `column` begins in `line`, or `None` when
/// no grapheme starts there. A wide character takes two columns and a joined emoji is one grapheme
/// of two.
fn index_at_column(line: &str, column: usize) -> Option<usize> {
    let mut width = 0;
    for (index, grapheme) in graphemes(line) {
        if width == column {
            return Some(index);
        }
        width += string_width(grapheme);
    }
    (width == column).then_some(line.len())
}

/// `withoutPreview`: `lines` with the preview's box cut off each line, and its notes line blanked.
/// The box's column is where the first top corner among lines `from..=to` stands.
pub(super) fn without_preview(lines: &[String], from: usize, to: usize) -> Vec<String> {
    let column = (from..=to).find_map(|index| {
        let line = lines.get(index).map_or("", String::as_str);
        let corner = CORNER.find(line)?;
        // the corner is the last character of the match
        let at = line[..corner.end()].char_indices().next_back()?.0;
        Some(string_width(&line[..at]))
    });
    lines
        .iter()
        .map(|line| {
            let at = column
                .filter(|column| *column >= 2)
                .and_then(|column| index_at_column(line, column));
            let boxed = at.filter(|&at| {
                line[at..]
                    .chars()
                    .next()
                    .is_some_and(|edge| PREVIEW_EDGE.contains(edge))
                    && line[..at].ends_with("  ")
            });
            let line = match boxed {
                Some(at) => js::trim_end(&line[..at]),
                None => line.as_str(),
            };
            NOTES.replace(line, "").into_owned()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<String> {
        text.split('\n').map(str::to_owned).collect()
    }

    /// What TypeScript's `withoutPreview` returns for these lines, worked out from
    /// server/prompt.ts:437-451: the corner stands in column 12 of the first line; `あ` takes two
    /// columns, so the second line's box starts at its eleventh character.
    #[test]
    fn cuts_the_box_off_in_its_column() {
        let read = without_preview(
            &lines(concat!(
                "❯ 1. Alpha  ┌──────┐\n",
                "  2. あ│b   │ x    │\n",
                "  3. Gamma  └──────┘\n",
                "  Notes: press n to add notes",
            )),
            0,
            3,
        );
        assert_eq!(read, ["❯ 1. Alpha", "  2. あ│b", "  3. Gamma", ""]);
    }

    #[test]
    fn keeps_a_line_without_the_box_in_its_column() {
        // the edge must follow two spaces, and a grapheme must start at the column
        let read = without_preview(
            &lines("1. Alpha  ┌──┐\n2. Beta x│ y\n3. ああああ │ z\n4. 👨\u{200d}👩     │"),
            0,
            0,
        );
        // column 10 is the second half of the fourth `あ`; the family is one grapheme of two columns
        assert_eq!(
            read,
            [
                "1. Alpha",
                "2. Beta x│ y",
                "3. ああああ │ z",
                "4. 👨\u{200d}👩"
            ]
        );
    }

    #[test]
    fn finds_the_column_where_a_grapheme_starts() {
        assert_eq!(index_at_column("aあb", 0), Some(0));
        assert_eq!(index_at_column("aあb", 1), Some(1));
        assert_eq!(index_at_column("aあb", 2), None);
        assert_eq!(index_at_column("aあb", 3), Some(4));
        assert_eq!(index_at_column("aあb", 4), Some(5));
        assert_eq!(index_at_column("aあb", 5), None);
    }
}
