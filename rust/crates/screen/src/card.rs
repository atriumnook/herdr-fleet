//! A parsed card: the public card with its content id, how it takes its answer, and which reader
//! read it (`finishPrompt` and `publicPrompt`, server/prompt.ts:198-230).

use std::fmt::Write;

use protocol::{InteractivePrompt, InteractivePromptOption, PromptKind, QueuedState, js};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::answer::{Answering, OptionKeys};
use crate::{claude, codex, fallback, omp, pi};

/// The longest body a card shows, in UTF-16 code units (server/prompt.ts:211). The id reads all of
/// it.
const BODY_MAX: usize = 12_000;

/// A card read off a screen, with what answering it needs. Keep it to answer the card: the public
/// card alone (`card()`, copied to be sent) carries none of that.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedPrompt {
    card: InteractivePrompt,
    responder: Responder,
    answering: Answering,
}

impl ParsedPrompt {
    /// The card as the Web UI shows it.
    pub fn card(&self) -> &InteractivePrompt {
        &self.card
    }

    pub(crate) fn answering(&self) -> &Answering {
        &self.answering
    }

    /// Whether the menu the card was read from is still what ends the screen
    /// (`promptTailIsActive`, server/prompt.ts:822-858): the family that read it decides.
    pub(crate) fn tail_is_active(&self, screen: &str) -> bool {
        match self.responder {
            Responder::Claude(responder) => claude::tail_is_active(responder, screen),
            Responder::Codex(responder) => codex::tail_is_active(responder, screen),
            Responder::Omp(responder) => omp::tail_is_active(responder, screen),
            Responder::Pi(responder) => pi::tail_is_active(responder, screen),
            Responder::Fallback(responder) => fallback::tail_is_active(responder, screen),
        }
    }
}

/// Which reader read a card (TypeScript's `Responder`, server/prompt.ts:48-66), by family.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Responder {
    Claude(claude::Responder),
    Codex(codex::Responder),
    Omp(omp::Responder),
    Pi(pi::Responder),
    Fallback(fallback::Responder),
}

// A family's parsers hand `finish` their own responder, which these wrap.
impl From<claude::Responder> for Responder {
    fn from(responder: claude::Responder) -> Self {
        Responder::Claude(responder)
    }
}

impl From<codex::Responder> for Responder {
    fn from(responder: codex::Responder) -> Self {
        Responder::Codex(responder)
    }
}

impl From<omp::Responder> for Responder {
    fn from(responder: omp::Responder) -> Self {
        Responder::Omp(responder)
    }
}

impl From<pi::Responder> for Responder {
    fn from(responder: pi::Responder) -> Self {
        Responder::Pi(responder)
    }
}

impl From<fallback::Responder> for Responder {
    fn from(responder: fallback::Responder) -> Self {
        Responder::Fallback(responder)
    }
}

/// What a card says, as its parser read it: the public card without its id, its agent and
/// `multi_select` (which is whether its answering takes several options), the body whole.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CardFields {
    pub kind: PromptKind,
    pub title: String,
    pub question: String,
    pub body: Option<String>,
    pub options: Vec<InteractivePromptOption>,
    pub custom_option_index: Option<usize>,
    pub queued: Option<QueuedState>,
    pub fallback: bool,
}

/// What else the id of a last-resort card reads (server/prompt.ts:1348-1361): its question and body
/// with the working line's ticking parts blanked, the whole visible screen read so, and which of its
/// lines was read as the working line.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FallbackScreen {
    pub question: String,
    pub body: Option<String>,
    pub screen: String,
    pub working: Option<usize>,
}

/// What the content id reads: the same fields as TypeScript's, in one fixed shape.
#[derive(Serialize)]
struct IdInput<'a> {
    agent: &'a str,
    kind: PromptKind,
    title: &'a str,
    question: &'a str,
    body: Option<&'a str>,
    options: &'a [InteractivePromptOption],
    multi_select: bool,
    custom_option_index: Option<usize>,
    queued: Option<QueuedState>,
    fallback: bool,
    /// a last-resort card's screen and the place of its working line
    screen: Option<(&'a str, Option<usize>)>,
}

/// An option of a card: a label without a description.
pub(crate) fn option(label: impl Into<String>) -> InteractivePromptOption {
    InteractivePromptOption {
        label: label.into(),
        description: None,
    }
}

/// The card named by its content: the sha256 of everything it says, the body before it is cut
/// for display, in hexadecimal whole (ADR 0192-phase-2-split, "カードの content id"). Two cards that
/// say the same get the same id; the cursor's place is not in it. A last-resort card's id reads
/// `fallback`'s fields in place of its question and body. The card is of several choices when its
/// answering takes several options.
pub(crate) fn finish(
    agent: &str,
    fields: CardFields,
    fallback: Option<FallbackScreen>,
    responder: impl Into<Responder>,
    answering: Answering,
) -> ParsedPrompt {
    let multi_select = answering.multiple.is_some();
    if let OptionKeys::Steps(steps) = &answering.options {
        debug_assert_eq!(
            steps.len(),
            fields.options.len(),
            "one list of steps for each option"
        );
    }
    let input = IdInput {
        agent,
        kind: fields.kind,
        title: &fields.title,
        question: fallback
            .as_ref()
            .map_or(&fields.question, |screen| &screen.question),
        body: match &fallback {
            Some(screen) => screen.body.as_deref(),
            None => fields.body.as_deref(),
        },
        options: &fields.options,
        multi_select,
        custom_option_index: fields.custom_option_index,
        queued: fields.queued,
        fallback: fields.fallback,
        screen: fallback
            .as_ref()
            .map(|screen| (screen.screen.as_str(), screen.working)),
    };
    let json = serde_json::to_vec(&input).expect("a card's fields write as JSON");
    let mut id = String::with_capacity(64);
    for byte in Sha256::digest(&json) {
        write!(id, "{byte:02x}").expect("a String takes what is written");
    }
    let CardFields {
        kind,
        title,
        question,
        body,
        options,
        custom_option_index,
        queued,
        fallback,
    } = fields;
    let card = InteractivePrompt {
        id,
        agent: agent.to_owned(),
        kind,
        title,
        question,
        body: body.map(|body| js::cut_utf16(&body, BODY_MAX).to_owned()),
        options,
        multi_select,
        custom_option_index,
        queued,
        fallback,
    };
    ParsedPrompt {
        card,
        responder: responder.into(),
        answering,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::answer::{Key, Multiple};

    fn fields(question: &str, body: Option<&str>) -> CardFields {
        CardFields {
            kind: PromptKind::Question,
            title: "Question".into(),
            question: question.into(),
            body: body.map(str::to_owned),
            options: vec![InteractivePromptOption {
                label: "Yes".into(),
                description: None,
            }],
            custom_option_index: None,
            queued: None,
            fallback: false,
        }
    }

    fn answering(selected: usize) -> Answering {
        Answering {
            selected,
            options: OptionKeys::Menu { escape: None },
            typed: None,
            multiple: None,
        }
    }

    fn responder() -> Responder {
        Responder::Pi(pi::Responder::Question)
    }

    fn id(agent: &str, fields: CardFields, fallback: Option<FallbackScreen>) -> String {
        finish(agent, fields, fallback, responder(), answering(0))
            .card
            .id
    }

    #[test]
    fn the_id_is_the_whole_sha256_in_hexadecimal() {
        let id = id("pi", fields("Go?", None), None);
        assert_eq!(id.len(), 64);
        assert!(
            id.bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        );
    }

    #[test]
    fn the_same_content_has_the_same_id_and_other_content_another() {
        let first = id("pi", fields("Go?", None), None);
        assert_eq!(first, id("pi", fields("Go?", None), None));
        // the cursor's place is not the card's content (server/prompt.ts:209-210)
        assert_eq!(
            first,
            finish("pi", fields("Go?", None), None, responder(), answering(1))
                .card
                .id
        );
        assert_ne!(first, id("omp", fields("Go?", None), None));
        assert_ne!(first, id("pi", fields("Go!", None), None));
        assert_ne!(first, id("pi", fields("Go?", Some("")), None));
    }

    #[test]
    fn the_id_reads_the_body_before_it_is_cut_for_display() {
        // server/prompt.ts:209-211: the body shows 12,000 UTF-16 code units, the id reads all of it
        let long = "a".repeat(BODY_MAX);
        let longer = format!("{long}b");
        let shown = finish(
            "pi",
            fields("Go?", Some(&longer)),
            None,
            responder(),
            answering(0),
        );
        assert_eq!(shown.card.body.as_deref(), Some(long.as_str()));
        assert_ne!(shown.card.id, id("pi", fields("Go?", Some(&long)), None));
    }

    #[test]
    fn a_last_resort_card_is_named_by_its_screen_too() {
        let screen = |text: &str, working: Option<usize>| FallbackScreen {
            question: "Go?".into(),
            body: None,
            screen: text.into(),
            working,
        };
        let card = || fields("Go?", None);
        let first = id("claude", card(), Some(screen("a\nGo?", None)));
        assert_eq!(first, id("claude", card(), Some(screen("a\nGo?", None))));
        assert_ne!(first, id("claude", card(), Some(screen("b\nGo?", None))));
        assert_ne!(first, id("claude", card(), Some(screen("a\nGo?", Some(0)))));
        assert_ne!(first, id("claude", card(), None));
        // the id reads the question and body as the screen gives them, not as the card shows them
        let steady = FallbackScreen {
            question: "* Working… (<time>)".into(),
            ..screen("a", None)
        };
        let ticking = finish(
            "claude",
            fields("✢ Working… (1s)", None),
            Some(steady.clone()),
            responder(),
            answering(0),
        );
        let ticked = finish(
            "claude",
            fields("✢ Working… (2s)", None),
            Some(steady),
            responder(),
            answering(0),
        );
        assert_eq!(ticking.card.id, ticked.card.id);
        assert_eq!(ticking.card.question, "✢ Working… (1s)");
    }

    #[test]
    fn a_card_is_of_several_choices_when_its_answering_takes_several() {
        let several = Answering {
            multiple: Some(Multiple {
                checked: Vec::new(),
                toggle: Key::Space,
                finish: vec![Key::Enter],
            }),
            ..answering(0)
        };
        let one = finish("omp", fields("Go?", None), None, responder(), answering(0));
        let many = finish("omp", fields("Go?", None), None, responder(), several);
        assert!(!one.card.multi_select);
        assert!(many.card.multi_select);
        assert_ne!(one.card.id, many.card.id);
    }
}
