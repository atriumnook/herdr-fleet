//! The keys an answer to a card sends (`answerKeys`, server/prompt.ts:1152-1224). The checks of an
//! answer's shape and their messages live here alone; how a card takes its answer is data each
//! family's parser fills in (`Answering`), so this file does not branch on the agent.

use std::collections::BTreeSet;
use std::fmt;

use protocol::js;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::ParsedPrompt;

/// An answer to a card, as the request's JSON gave it: TypeScript's `PromptAnswer` without the pane
/// and the card's id, each of its three fields absent or there with whatever value it holds, `null`
/// included (TypeScript tells them apart with `!== undefined`). Whether exactly one is there, and
/// whether it is a string, an array or a whole number in range, `answer_keys` checks with
/// TypeScript's messages and in its order. Made from the JSON only (`From<Value>`): JavaScript's
/// `JSON.parse` keeps the last of two same keys, as `Value` does, and a body that is no object holds
/// no answer.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(from = "Value")]
pub struct Answer {
    option_index: Option<Value>,
    option_indices: Option<Value>,
    custom_text: Option<Value>,
}

impl From<Value> for Answer {
    fn from(answer: Value) -> Self {
        let mut fields = match answer {
            Value::Object(fields) => fields,
            _ => Map::new(),
        };
        Answer {
            option_index: fields.remove("option_index"),
            option_indices: fields.remove("option_indices"),
            custom_text: fields.remove("custom_text"),
        }
    }
}

/// One step of an answer: keys pressed one after another, or text typed into the pane. In JSON,
/// `{"keys": [...]}` or `{"text": "..."}`, as TypeScript's `AnswerStep`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum AnswerStep {
    Keys { keys: Vec<Key> },
    Text { text: String },
}

/// A key an answer presses, written by herdr's name for it (TypeScript's `KEY`, server/prompt.ts:32-46,
/// and the editor keys of answerKeys): the keys TypeScript's code sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Key {
    Up,
    Down,
    Enter,
    Escape,
    Space,
    Tab,
    Right,
    BackTab,
    /// opens Codex's queue on its first question (herdr's own alt+arrow bindings apply to the
    /// keyboard, not to keys sent to the pane)
    OpenQueue,
    /// closes Codex's queue back to its main prompt
    CloseQueue,
    /// empties an input line after the cursor
    CtrlK,
    /// empties an input line before the cursor
    CtrlU,
}

impl Key {
    /// herdr's name of the key.
    pub fn as_str(self) -> &'static str {
        match self {
            Key::Up => "up",
            Key::Down => "down",
            Key::Enter => "enter",
            Key::Escape => "esc",
            Key::Space => "space",
            Key::Tab => "tab",
            Key::Right => "right",
            Key::BackTab => "shift+tab",
            Key::OpenQueue => "alt+up",
            Key::CloseQueue => "alt+down",
            Key::CtrlK => "ctrl+k",
            Key::CtrlU => "ctrl+u",
        }
    }
}

impl Serialize for Key {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// Why an answer cannot be sent to a card. The message is TypeScript's (server/prompt.ts:1166-1219).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvalidAnswer {
    /// none of the three answers, or more than one
    NotExactlyOne,
    /// a typed answer that is not a string
    CustomTextNotString,
    /// several options that are not an array
    OptionIndicesNotArray,
    /// a typed answer that is blank, or to a card that takes none
    NoCustomAnswer,
    /// several options for a card of a single choice, or none
    NoSelections,
    /// one of several options that is not a whole number among the card's options
    OutsideRange,
    /// an option that is not a whole number among the card's options, is its typed answer, or is
    /// given to a card of several choices
    InvalidOptionIndex,
}

impl fmt::Display for InvalidAnswer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            InvalidAnswer::NotExactlyOne => "Exactly one answer is required.",
            InvalidAnswer::CustomTextNotString => "Custom text must be a string.",
            InvalidAnswer::OptionIndicesNotArray => "Option indices must be an array.",
            InvalidAnswer::NoCustomAnswer => "This prompt does not accept a custom answer.",
            InvalidAnswer::NoSelections => "This prompt requires one or more selections.",
            InvalidAnswer::OutsideRange => "An option index is outside the displayed range.",
            InvalidAnswer::InvalidOptionIndex => "A valid option index is required.",
        })
    }
}

impl std::error::Error for InvalidAnswer {}

/// How a card takes its answer, filled in by the parser that read it. The rows are the menu's, as
/// the cursor moves through them; an option's index is its row (TypeScript's `answerKeys` reads
/// them so).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Answering {
    /// the row the cursor is on
    pub selected: usize,
    pub options: OptionKeys,
    /// how a typed answer goes in; `None` when the card takes none
    pub typed: Option<Typed>,
    /// how several options are picked; `None` for a card of a single choice. The card's
    /// `multi_select` is whether this is there.
    pub multiple: Option<Multiple>,
}

impl Answering {
    /// A menu of a single choice that takes no typed answer, its cursor on row `selected`.
    pub(crate) fn menu(selected: usize) -> Self {
        Answering {
            selected,
            options: OptionKeys::Menu { escape: None },
            typed: None,
            multiple: None,
        }
    }
}

/// How one option is picked.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum OptionKeys {
    /// move the cursor to the option's row and press Enter; the option at `escape`, when there is
    /// one, presses Escape instead (an approval whose "No" is the same as backing out)
    Menu { escape: Option<usize> },
    /// each option's own steps, for a card whose options are not rows of a menu
    Steps(Vec<Vec<AnswerStep>>),
}

impl From<Vec<Vec<AnswerStep>>> for OptionKeys {
    fn from(steps: Vec<Vec<AnswerStep>>) -> Self {
        OptionKeys::Steps(steps)
    }
}

/// A typed answer: move to `row`, press `before`, type the text, press `after`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Typed {
    pub row: usize,
    pub before: Vec<Key>,
    pub after: Vec<Key>,
}

/// Several options: for each option whose tick must change, move to it and press `toggle`; then
/// press `finish`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Multiple {
    /// the options ticked on the screen
    pub checked: Vec<usize>,
    pub toggle: Key,
    pub finish: Vec<Key>,
}

/// The Up or Down presses that move the cursor from row `from` to row `to`.
fn navigation(from: usize, to: usize) -> impl Iterator<Item = Key> {
    let key = if to > from { Key::Down } else { Key::Up };
    std::iter::repeat_n(key, to.abs_diff(from))
}

/// Each key as a step of its own, as TypeScript sends them.
fn key_steps(keys: impl IntoIterator<Item = Key>) -> Vec<AnswerStep> {
    keys.into_iter()
        .map(|key| AnswerStep::Keys { keys: vec![key] })
        .collect()
}

/// A JavaScript number that `Number.isInteger` takes and that is at least 0 and below `len`.
fn index_in(value: &Value, len: usize) -> Option<usize> {
    let value = value.as_f64()?;
    (value.is_finite() && value.fract() == 0.0 && value >= 0.0 && value < len as f64)
        .then_some(value as usize)
}

/// The steps that send `answer` to the card `prompt`, in TypeScript's order of checks.
pub fn answer_keys(
    prompt: &ParsedPrompt,
    answer: &Answer,
) -> Result<Vec<AnswerStep>, InvalidAnswer> {
    let card = prompt.card();
    let answering = prompt.answering();
    let supplied = [
        answer.option_index.is_some(),
        answer.option_indices.is_some(),
        answer.custom_text.is_some(),
    ]
    .into_iter()
    .filter(|given| *given)
    .count();
    if supplied != 1 {
        return Err(InvalidAnswer::NotExactlyOne);
    }

    if let Some(text) = &answer.custom_text {
        let text = js::trim(text.as_str().ok_or(InvalidAnswer::CustomTextNotString)?);
        let Some(typed) = answering.typed.as_ref().filter(|_| !text.is_empty()) else {
            return Err(InvalidAnswer::NoCustomAnswer);
        };
        let mut steps = key_steps(
            navigation(answering.selected, typed.row).chain(typed.before.iter().copied()),
        );
        steps.push(AnswerStep::Text {
            text: text.to_owned(),
        });
        steps.extend(key_steps(typed.after.iter().copied()));
        return Ok(steps);
    }

    if let Some(indices) = &answer.option_indices {
        let indices = indices
            .as_array()
            .ok_or(InvalidAnswer::OptionIndicesNotArray)?;
        let Some(multiple) = answering.multiple.as_ref().filter(|_| !indices.is_empty()) else {
            return Err(InvalidAnswer::NoSelections);
        };
        let desired = indices
            .iter()
            .map(|index| index_in(index, card.options.len()))
            .collect::<Option<BTreeSet<usize>>>()
            .ok_or(InvalidAnswer::OutsideRange)?;
        let checked: BTreeSet<usize> = multiple.checked.iter().copied().collect();
        let mut cursor = answering.selected;
        let mut keys = Vec::new();
        for index in 0..card.options.len() {
            if desired.contains(&index) != checked.contains(&index) {
                keys.extend(navigation(cursor, index));
                keys.push(multiple.toggle);
                cursor = index;
            }
        }
        keys.extend(multiple.finish.iter().copied());
        return Ok(key_steps(keys));
    }

    let index = answer
        .option_index
        .as_ref()
        .and_then(|index| index_in(index, card.options.len()))
        .filter(|index| Some(*index) != card.custom_option_index && !card.multi_select)
        .ok_or(InvalidAnswer::InvalidOptionIndex)?;
    Ok(match &answering.options {
        OptionKeys::Steps(steps) => steps
            .get(index)
            .cloned()
            .ok_or(InvalidAnswer::InvalidOptionIndex)?,
        OptionKeys::Menu {
            escape: Some(escape),
        } if *escape == index => key_steps([Key::Escape]),
        OptionKeys::Menu { .. } => {
            key_steps(navigation(answering.selected, index).chain([Key::Enter]))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_written_by_herdrs_name() {
        // server/prompt.ts:32-46 and the literal keys of answerKeys (1185)
        let names = [
            (Key::Up, "up"),
            (Key::Down, "down"),
            (Key::Enter, "enter"),
            (Key::Escape, "esc"),
            (Key::Space, "space"),
            (Key::Tab, "tab"),
            (Key::Right, "right"),
            (Key::BackTab, "shift+tab"),
            (Key::OpenQueue, "alt+up"),
            (Key::CloseQueue, "alt+down"),
            (Key::CtrlK, "ctrl+k"),
            (Key::CtrlU, "ctrl+u"),
        ];
        for (key, name) in names {
            assert_eq!(key.as_str(), name);
            assert_eq!(serde_json::to_value(key).unwrap(), name);
        }
    }

    #[test]
    fn a_step_is_written_as_typescripts_answer_step() {
        let steps = vec![
            AnswerStep::Keys {
                keys: vec![Key::Down],
            },
            AnswerStep::Text { text: "x".into() },
        ];
        assert_eq!(
            serde_json::to_string(&steps).unwrap(),
            r#"[{"keys":["down"]},{"text":"x"}]"#
        );
    }
}
