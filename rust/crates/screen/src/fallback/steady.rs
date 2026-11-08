//! How a last-resort card's id reads a line of the screen (`steadyReader`, server/prompt.ts:1255-1289).

use std::sync::LazyLock;

use regex::Regex;

use crate::text::js_regex;

/// `WORKING_LINE_RE`: Claude Code's working line, whole: one of its spinner's frames, what it is
/// doing ending in an ellipsis, and in parentheses the time it has taken and the tokens it has
/// used, then maybe the interrupt hint: "✢ Tempering… (1m 55s · ↓ 10.0k tokens)".
static WORKING_LINE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"^[·✢✳✶✻✽*] ({S}(?:{.}*{S})?…) \((?:[0-9]+h )?(?:[0-9]+m )?[0-9]+s · [↑↓] [0-9.,]+[kKmM]? tokens( · esc to interrupt)?\)$",
    )
});

/// Claude Code keeps its working line on the screen while it waits on a prompt, and the line's
/// spinner, time and token count change every second or so. An id that took them in refused each
/// answer tapped after a tick as stale.
///
/// They are blanked on that one line, and only when it is known to be it: the pane runs Claude, the
/// line is its working line to the letter, token count with its arrow included, and no other line
/// of the screen has that shape. Every other screen is read as it is. The words stay in the id, so
/// "Deleting staging…" is never "Deleting production…".
pub(super) struct Steady {
    /// the working line as the screen shows it, and as the id reads it
    blanked: Option<(String, String)>,
    /// which of the shown lines was read as the working line; it goes into the id beside the text,
    /// so that a screen holding the blanked form as its own text is another card
    pub working: Option<usize>,
}

impl Steady {
    /// The reader for a screen of `agent`'s whose shown lines are `shown`.
    pub(super) fn new(agent: &str, shown: &[String]) -> Self {
        let mut working = shown
            .iter()
            .enumerate()
            .filter(|_| agent == "claude")
            .filter(|(_, line)| WORKING_LINE.is_match(line));
        let (Some((at, line)), None) = (working.next(), working.next()) else {
            return Steady {
                blanked: None,
                working: None,
            };
        };
        let found = WORKING_LINE
            .captures(line)
            .expect("the working line matched");
        let hint = found.get(2).map_or("", |hint| hint.as_str());
        let blanked = format!("* {} (<time> · <tokens>{hint})", &found[1]);
        Steady {
            blanked: Some((line.clone(), blanked)),
            working: Some(at),
        }
    }

    /// A line as the id reads it: the working line blanked, any other line as it is.
    pub(super) fn read<'a>(&'a self, line: &'a str) -> &'a str {
        match &self.blanked {
            Some((working, blanked)) if working == line => blanked,
            _ => line,
        }
    }

    /// `steadyFields`' body: each of its lines read so.
    pub(super) fn read_lines(&self, text: &str) -> String {
        text.split('\n')
            .map(|line| self.read(line))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &[&str]) -> Vec<String> {
        text.iter().map(|line| (*line).to_owned()).collect()
    }

    #[test]
    fn blanks_the_ticking_parts_of_claudes_one_working_line() {
        let shown = lines(&[
            "Run it?",
            "✢ Tempering… (1m 55s · ↓ 10.0k tokens · esc to interrupt)",
        ]);
        let steady = Steady::new("claude", &shown);
        assert_eq!(steady.working, Some(1));
        assert_eq!(
            steady.read(&shown[1]),
            "* Tempering… (<time> · <tokens> · esc to interrupt)"
        );
        assert_eq!(steady.read("Run it?"), "Run it?");
        assert_eq!(
            steady.read_lines("a\n✢ Tempering… (1m 55s · ↓ 10.0k tokens · esc to interrupt)"),
            "a\n* Tempering… (<time> · <tokens> · esc to interrupt)"
        );
    }

    #[test]
    fn reads_the_screen_as_it_is_when_the_line_is_not_known_to_be_the_working_line() {
        let working = "✻ Deleting… (3s · ↑ 1.2k tokens)";
        // another agent's screen
        assert_eq!(Steady::new("cursor", &lines(&[working])).working, None);
        // two lines of that shape may be a menu's rows with their marker
        let two = Steady::new("claude", &lines(&[working, "* Cancel… (4s · ↓ 9 tokens)"]));
        assert_eq!(two.working, None);
        assert_eq!(two.read(working), working);
        // a time without the token count may be one that is offered
        assert_eq!(
            Steady::new("claude", &lines(&["* Restart service… (300s)"])).working,
            None
        );
    }
}
