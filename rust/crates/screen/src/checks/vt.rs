//! `stripVTControlCharacters` of `node:util`, as Bun 1.4.4 has it.

use std::sync::LazyLock;

use regex::Regex;

/// The pattern of Bun 1.4.4's `stripVTControlCharacters` (`getAnsiRegExp`, read from the strings of
/// the `bun` binary): a CSI or C1 CSI sequence, an OSC string up to BEL or ST, or a two-character
/// escape. It is ASCII but for ESC, U+009B and U+009C, and has no look-around or back reference, so
/// the regex crate's leftmost-first matches are JavaScript's; `\d` is written `[0-9]`.
static VT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"[\x1B\x{9B}][\[\]()#;?]*(?:",
        r"(?:(?:(?:;[-a-zA-Z0-9/#&.:=?%@~_]+)*|[a-zA-Z0-9]+(?:;[-a-zA-Z0-9/#&.:=?%@~_]*)*)?(?:\x07|\x1B\\|\x{9C}))",
        r"|(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nq-uy=><~]))",
    ))
    .unwrap()
});

/// `stripVTControlCharacters(text)`.
pub(super) fn strip_vt(text: &str) -> String {
    VT.replace_all(text, "").into_owned()
}

#[cfg(test)]
mod tests {
    use super::strip_vt;

    /// Each string and what Bun 1.4.4's `stripVTControlCharacters` returns for it.
    #[test]
    fn strips_what_bun_strips() {
        let cases = [
            ("plain", "plain"),
            ("a\x1b[31mb\x1b[0m", "ab"),
            ("\x1b[1;2;3Hx", "x"),
            // four digits at most: the fifth is the final character
            ("a\x1b[12345mb", "amb"),
            // `:` separates no parameter
            ("a\x1b[38:2:1mb", "a:2:1mb"),
            ("a\x1b[5ub", "ab"),
            ("a\x1b[5pb", "apb"),
            ("a\x1b[?25lb", "ab"),
            ("a\u{9b}31mb", "ab"),
            ("a\x1b]8;;http://x\x07link\x1b]8;;\x07b", "alinkb"),
            ("a\x1b]8;;http://x\x1b\\b", "ab"),
            ("a\x1b]0;title\u{9c}b", "ab"),
            // a space ends the OSC's text: `ESC ] 0` is read as an escape of its own
            ("a\x1b]0;a b\x07c", "a;a b\x07c"),
            ("a\x1b]x", "a\x1b]x"),
            ("a\x1bb", "a\x1bb"),
            ("a\x1b", "a\x1b"),
            ("a\x1b\x1b[2mb", "a\x1bb"),
            ("a\x1b(Bb", "ab"),
            ("a\x1b7b", "ab"),
            ("a\x1bQb", "a\x1bQb"),
            ("\x1b[2m❯\u{a0}placeholder\x1b[0m", "❯\u{a0}placeholder"),
        ];
        for (text, expected) in cases {
            assert_eq!(strip_vt(text), expected, "{text:?}");
        }
    }
}
