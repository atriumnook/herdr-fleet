//! The widths of `Bun.stringWidth` once escape sequences are skipped: Bun 1.4.4's grapheme rules
//! and grapheme widths (src/jsc/bindings/stringWidth.cpp of the tag `bun-v1.4.4`), over Bun's table
//! of every code point (`table`). Why and how this copies Bun:
//! docs/rust-migration/adr/0218-bun-string-width.md.

mod table;

/// Bun's grapheme break classes (`GraphemeBreakClass`, stringWidth.cpp:126-144 of Bun 1.4.4): the
/// grapheme break property with the Indic conjunct break, in the order of their numbers in the
/// table. Control characters are `Other`: Bun handles them before it asks the break rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Class {
    #[default]
    Other,
    Prepend,
    RegionalIndicator,
    SpacingMark,
    L,
    V,
    T,
    Lv,
    Lvt,
    Zwj,
    Zwnj,
    ExtendedPictographic,
    EmojiModifierBase,
    EmojiModifier,
    IndicConjunctBreakExtend,
    IndicConjunctBreakLinker,
    IndicConjunctBreakConsonant,
}

impl Class {
    const ALL: [Class; 17] = [
        Class::Other,
        Class::Prepend,
        Class::RegionalIndicator,
        Class::SpacingMark,
        Class::L,
        Class::V,
        Class::T,
        Class::Lv,
        Class::Lvt,
        Class::Zwj,
        Class::Zwnj,
        Class::ExtendedPictographic,
        Class::EmojiModifierBase,
        Class::EmojiModifier,
        Class::IndicConjunctBreakExtend,
        Class::IndicConjunctBreakLinker,
        Class::IndicConjunctBreakConsonant,
    ];

    /// `isExtend`
    fn is_extend(self) -> bool {
        matches!(
            self,
            Class::Zwnj | Class::IndicConjunctBreakExtend | Class::IndicConjunctBreakLinker
        )
    }

    /// `isIndicConjunctBreakExtend`
    fn is_indic_extend(self) -> bool {
        matches!(self, Class::IndicConjunctBreakExtend | Class::Zwj)
    }

    /// `isExtendedPictographic`
    fn is_pictographic(self) -> bool {
        matches!(self, Class::ExtendedPictographic | Class::EmojiModifierBase)
    }
}

/// What Bun's table says of a character: its break class, its width (0, 1 or 2; ambiguous
/// characters are narrow, as `Bun.stringWidth` counts them by default) and its Emoji property.
#[derive(Debug, Clone, Copy)]
struct Classified {
    class: Class,
    width: u8,
    emoji: bool,
}

/// A character's entry in Bun's table: bits 0-4 the break class, bits 5-6 the width class (3 is East
/// Asian Ambiguous), bit 7 the Emoji property (stringWidth.cpp:54-83).
fn classify(c: char) -> Classified {
    let packed = table::packed(c);
    let width = match (packed >> 5) & 0x3 {
        3 => 1,
        width => width,
    };
    Classified {
        class: Class::ALL[usize::from(packed & 0x1f)],
        width,
        emoji: packed & 0x80 != 0,
    }
}

/// The states Bun's break rules carry from one pair of characters to the next
/// (`GraphemeBreakState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum BreakState {
    #[default]
    Default,
    RegionalIndicator,
    ExtendedPictographic,
    IndicConjunctBreakConsonant,
    IndicConjunctBreakLinker,
}

/// Whether Bun ends a grapheme between a character of class `before` and one of class `after`
/// (`computeGraphemeBreakNoControl`, stringWidth.cpp:176-338, which Bun ported from uucode): UAX
/// #29 with the Indic conjunct break, written rule for rule.
fn breaks(before: Class, after: Class, state: &mut BreakState) -> bool {
    use BreakState as S;
    use Class as G;

    // go back to the default state when a character does not continue the sequence
    match *state {
        S::RegionalIndicator => {
            if before != G::RegionalIndicator || after != G::RegionalIndicator {
                *state = S::Default;
            }
        }
        S::ExtendedPictographic => {
            let expected = |class: Class| {
                class.is_extend()
                    || matches!(
                        class,
                        G::Zwj | G::ExtendedPictographic | G::EmojiModifierBase | G::EmojiModifier
                    )
            };
            if !expected(before) || !expected(after) {
                *state = S::Default;
            }
        }
        S::IndicConjunctBreakConsonant | S::IndicConjunctBreakLinker => {
            let expected = |class: Class| {
                matches!(
                    class,
                    G::IndicConjunctBreakConsonant
                        | G::IndicConjunctBreakLinker
                        | G::IndicConjunctBreakExtend
                        | G::Zwj
                )
            };
            if !expected(before) || !expected(after) {
                *state = S::Default;
            }
        }
        S::Default => {}
    }

    // GB6, GB7, GB8: Hangul syllables
    if before == G::L && matches!(after, G::L | G::V | G::Lv | G::Lvt) {
        return false;
    }
    if matches!(before, G::Lv | G::V) && matches!(after, G::V | G::T) {
        return false;
    }
    if matches!(before, G::Lvt | G::T) && after == G::T {
        return false;
    }
    // GB9 comes last: Extend and ZWJ also start GB9c and GB11
    // GB9a, GB9b
    if after == G::SpacingMark || before == G::Prepend {
        return false;
    }
    // GB9c: the Indic conjunct break
    if before == G::IndicConjunctBreakConsonant {
        if after.is_indic_extend() {
            *state = S::IndicConjunctBreakConsonant;
            return false;
        }
        if after == G::IndicConjunctBreakLinker {
            *state = S::IndicConjunctBreakLinker;
            return false;
        }
    } else if *state == S::IndicConjunctBreakConsonant {
        if after == G::IndicConjunctBreakLinker {
            *state = S::IndicConjunctBreakLinker;
            return false;
        }
        if after.is_indic_extend() {
            return false;
        }
        *state = S::Default;
    } else if *state == S::IndicConjunctBreakLinker {
        if after == G::IndicConjunctBreakLinker || after.is_indic_extend() {
            return false;
        }
        if after == G::IndicConjunctBreakConsonant {
            *state = S::Default;
            return false;
        }
        *state = S::Default;
    }
    // GB11: emoji ZWJ sequences and emoji modifier sequences
    if before.is_pictographic() {
        if after.is_extend() || after == G::Zwj {
            *state = S::ExtendedPictographic;
            return false;
        }
        if before == G::EmojiModifierBase && after == G::EmojiModifier {
            *state = S::ExtendedPictographic;
            return false;
        }
    } else if *state == S::ExtendedPictographic {
        if (before.is_extend() || before == G::EmojiModifier)
            && (after.is_extend() || after == G::Zwj)
        {
            return false;
        }
        if before == G::Zwj && after.is_pictographic() {
            *state = S::Default;
            return false;
        }
        *state = S::Default;
    }
    // GB12, GB13: regional indicators in pairs
    if before == G::RegionalIndicator && after == G::RegionalIndicator {
        if *state == S::Default {
            *state = S::RegionalIndicator;
            return false;
        }
        *state = S::Default;
        return true;
    }
    // GB9, then GB999
    !(after.is_extend() || after == G::Zwj)
}

/// The width Bun saturates a grapheme's sum of widths at (`GraphemeState::add`).
const MAX_GRAPHEME_WIDTH: usize = 1023;

/// The characters of one grapheme, as far as its width goes (`GraphemeState`,
/// stringWidth.cpp:412-500).
#[derive(Debug, Default)]
struct Grapheme {
    first: char,
    /// the sum of the characters' widths, saturated at `MAX_GRAPHEME_WIDTH`
    sum: usize,
    /// the width of the first character
    base: u8,
    count: usize,
    emoji_base: bool,
    keycap: bool,
    regional_indicator: bool,
    skin_tone: bool,
    zwj: bool,
    vs15: bool,
    vs16: bool,
}

fn is_regional_indicator(c: char) -> bool {
    matches!(c, '\u{1f1e6}'..='\u{1f1ff}')
}

fn is_skin_tone(c: char) -> bool {
    matches!(c, '\u{1f3fb}'..='\u{1f3ff}')
}

impl Grapheme {
    /// `GraphemeState::reset`: a grapheme that starts at `c`. Bun counts ASCII without its table:
    /// printable characters take one column, the rest none.
    fn start(c: char, classified: Classified) -> Grapheme {
        if c.is_ascii() {
            let width = u8::from(matches!(c, ' '..='~'));
            return Grapheme {
                first: c,
                sum: usize::from(width),
                base: width,
                count: 1,
                ..Grapheme::default()
            };
        }
        Grapheme {
            first: c,
            sum: usize::from(classified.width),
            base: classified.width,
            count: 1,
            emoji_base: classified.emoji,
            keycap: c == '\u{20e3}',
            regional_indicator: is_regional_indicator(c),
            skin_tone: is_skin_tone(c),
            zwj: c == '\u{200d}',
            vs15: false,
            vs16: false,
        }
    }

    /// `GraphemeState::add`
    fn add(&mut self, c: char, classified: Classified) {
        self.count += 1;
        self.keycap |= c == '\u{20e3}';
        self.regional_indicator |= is_regional_indicator(c);
        self.skin_tone |= is_skin_tone(c);
        self.zwj |= c == '\u{200d}';
        self.vs15 |= c == '\u{fe0e}';
        self.vs16 |= c == '\u{fe0f}';
        self.sum = (self.sum + usize::from(classified.width)).min(MAX_GRAPHEME_WIDTH);
    }

    /// `GraphemeState::width`: a flag, a keycap, and an emoji with a skin tone or a ZWJ take two
    /// columns, a lone regional indicator one; a variation selector gives the width of the first
    /// character, or two for VS16 on an emoji; otherwise the sum of the characters' widths.
    fn width(&self) -> usize {
        if self.count == 0 {
            return 0;
        }
        if self.regional_indicator && self.count >= 2 {
            return 2;
        }
        if self.keycap {
            return 2;
        }
        if self.regional_indicator {
            return 1;
        }
        if self.emoji_base && (self.skin_tone || self.zwj) {
            return 2;
        }
        if self.vs15 || self.vs16 {
            // the table's Emoji property leaves out the characters below U+203C, of which only ©
            // and ® have it besides the keycap bases
            let emoji = self.emoji_base || matches!(self.first, '\u{a9}' | '\u{ae}');
            if self.base == 2 || (self.vs16 && emoji) {
                return 2;
            }
            return usize::from(self.base);
        }
        self.sum
    }
}

/// Whether Bun's UTF-16 path counts `c` in a bulk run (`ClassifyBulkUTF16Unit` in
/// highway_strings.cpp, and the ASCII runs of `UTF16WidthAccumulator::addRun`): ASCII, and the
/// letters that always make a grapheme of their own with a fixed width.
fn in_bulk_run(c: char) -> bool {
    matches!(c,
        '\u{0}'..='\u{7f}'
        | '\u{370}'..='\u{482}'
        | '\u{48a}'..='\u{52f}'
        | '\u{3041}'..='\u{3096}'
        | '\u{309b}'..='\u{30ff}'
        | '\u{3400}'..='\u{4dbf}'
        | '\u{4e00}'..='\u{9fff}'
        | '\u{ac00}'..='\u{d7a3}'
        | '\u{ff01}'..='\u{ff60}')
        || (matches!(c, '\u{a0}'..='\u{2ff}') && !matches!(c, '\u{a9}' | '\u{ad}' | '\u{ae}'))
}

/// Bun's `UTF16WidthAccumulator`: the width of the graphemes ended so far and the grapheme being
/// read, carried across escape sequences.
#[derive(Debug, Default)]
pub(super) struct WidthCounter {
    width: usize,
    grapheme: Grapheme,
    /// the class of the last character
    before: Class,
    state: BreakState,
}

impl WidthCounter {
    /// Counts the next character that is not part of an escape sequence.
    pub(super) fn push(&mut self, c: char) {
        let classified = classify(c);
        if in_bulk_run(c) {
            // `seedFromBulkRun`: a bulk run ends the grapheme before each of its characters, and
            // a mark after the run still joins its last one
            self.width += self.grapheme.width();
            self.grapheme = Grapheme::start(c, classified);
            self.state = BreakState::Default;
        } else if self.grapheme.count == 0 {
            self.grapheme = Grapheme::start(c, classified);
        } else if breaks(self.before, classified.class, &mut self.state) {
            self.width += self.grapheme.width();
            self.grapheme = Grapheme::start(c, classified);
        } else {
            self.grapheme.add(c, classified);
        }
        self.before = classified.class;
    }

    /// The width of all the characters pushed.
    pub(super) fn finish(&self) -> usize {
        self.width + self.grapheme.width()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::string_width;

    /// Bun's own checks of its table (the `static_assert`s of stringWidth.cpp:86-105), and every
    /// scalar value classified without a panic: the runs start at U+0000 and every break class is
    /// one of `Class::ALL`.
    #[test]
    fn classifies_every_code_point_as_buns_table_does() {
        for c in char::MIN..=char::MAX {
            classify(c);
        }
        let width = |c: char| classify(c).width;
        let emoji = |c: char| classify(c).emoji;
        assert_eq!(width('A'), 1);
        assert_eq!(width('\u{1b}'), 0);
        assert_eq!(width('\u{ad}'), 0);
        assert_eq!(width('\u{202e}'), 0);
        assert_eq!(width('\u{2069}'), 0);
        assert_eq!(width('\u{61c}'), 0);
        assert_eq!(width('\u{1bca0}'), 0);
        assert_eq!(width('\u{1d173}'), 0);
        assert_eq!(width('\u{4e2d}'), 2);
        assert_eq!(width('\u{ff21}'), 2);
        assert_eq!(width('\u{a7}'), 1);
        assert!(emoji('\u{1f600}'));
        assert!(!emoji('#'));
        assert!(!emoji('\u{fe0f}'));
        assert_eq!(width('\u{591}'), 0);
        assert_eq!(width('\u{1161}'), 0);
        assert_eq!(width('\u{1112}'), 2);
        assert_eq!(width('\u{4dc0}'), 2);
        assert!(emoji('\u{1fa89}'));
        assert_eq!(classify('\u{1f1e6}').class, Class::RegionalIndicator);
        assert_eq!(classify('\u{200d}').class, Class::Zwj);
    }

    /// A grapheme's sum of widths stops at 1023 (measured with Bun 1.4.4): Hangul leading jamo
    /// join one another (GB6) and each takes two columns.
    #[test]
    fn saturates_a_graphemes_width_as_bun_does() {
        let jamo = |count: usize| "\u{1100}".repeat(count);
        assert_eq!(string_width(&jamo(511)), 1022);
        assert_eq!(string_width(&jamo(512)), 1023);
        assert_eq!(string_width(&jamo(600)), 1023);
        assert_eq!(string_width(&format!("{}a", jamo(600))), 1024);
    }

    /// `Bun.stringWidth` of every pair of representatives, measured with Bun 1.4.4: one code point
    /// for each pair of (Bun's byte, whether Bun counts it in a bulk run), the first in code point
    /// order, and the five code points `GraphemeState` looks at by value. Bun's break rules and
    /// `GraphemeState::width` see nothing else of a character, so this covers every way two
    /// characters can meet. Row: the first character; column: the second.
    #[test]
    fn counts_every_pair_of_kinds_of_characters_as_bun_string_width() {
        const REPRESENTATIVES: [char; 40] = [
            '\u{0}',
            '\u{20}',
            '\u{80}',
            '\u{a1}',
            '\u{a9}',
            '\u{ae}',
            '\u{300}',
            '\u{530}',
            '\u{600}',
            '\u{890}',
            '\u{903}',
            '\u{915}',
            '\u{93b}',
            '\u{94d}',
            '\u{d3a}',
            '\u{d57}',
            '\u{1100}',
            '\u{1160}',
            '\u{11a8}',
            '\u{200c}',
            '\u{200d}',
            '\u{2010}',
            '\u{203c}',
            '\u{2122}',
            '\u{231a}',
            '\u{2329}',
            '\u{261d}',
            '\u{2630}',
            '\u{26f9}',
            '\u{270a}',
            '\u{302e}',
            '\u{3041}',
            '\u{ac00}',
            '\u{ac01}',
            '\u{16d63}',
            '\u{1f1e6}',
            '\u{1f3fb}',
            '\u{20e3}',
            '\u{fe0e}',
            '\u{fe0f}',
        ];
        const PAIR_WIDTHS: [&str; 40] = [
            "0101110101110001200001112212122222112200",
            "1212221212221112311112223323233333223211",
            "0101110101110001200001112212122222112200",
            "1212221212221112311112223323233333223211",
            "1212221212221112311112223323233333223212",
            "1212221212221112311112223323233333223212",
            "0101110101110001200001112212122222112200",
            "1212221212221112311112223323233333223211",
            "0101110101110001200001112212122222122200",
            "1212221212221112311112223323233333223211",
            "1212221212221112311112223323233333223211",
            "1212221212221112311112223323233333223211",
            "0101110101110001200001112212122222112200",
            "0101110101110001200001112212122222112200",
            "0101110101110001200001112212122222112200",
            "1212221212221112311112223323233333223211",
            "2323332323332223422223334434344444334222",
            "0101110101110001200001112212122222112200",
            "0101110101110001200001112212122222112200",
            "0101110101110001200001112212122222112200",
            "0101110101110001200001112212122222112200",
            "1212221212221112311112223323233333223211",
            "1212221212221112311122223323233333223212",
            "1212221212221112311122223323233333223212",
            "2323332323332223422223334434344444334222",
            "2323332323332223422223334434344444334222",
            "1212221212221112311122223323233333222212",
            "2323332323332223422223334434344444334222",
            "1212221212221112311122223323233333222212",
            "2323332323332223422223334434344444332222",
            "2323332323332223422223334434344444334222",
            "2323332323332223422223334434344444334222",
            "2323332323332223422223334434344444334222",
            "2323332323332223422223334434344444334222",
            "1212221212221112311112223323233333223211",
            "1212222212222212311222223323232333223222",
            "2323332323232222422223334434342444334222",
            "2323332323232222422223334434342444334222",
            "0101110101110001200001112212122222112200",
            "0101110101110001200001112212122222112200",
        ];
        for (row, first) in REPRESENTATIVES.iter().enumerate() {
            for (column, second) in REPRESENTATIVES.iter().enumerate() {
                let text = format!("{first}{second}");
                let width = usize::from(PAIR_WIDTHS[row].as_bytes()[column] - b'0');
                assert_eq!(string_width(&text), width, "{text:?}");
            }
        }
    }
}
