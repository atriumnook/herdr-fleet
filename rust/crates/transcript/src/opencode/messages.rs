//! OpenCode 2's session messages -> the conversation the chat renders (`server/opencode-messages.ts`).
//! Pure: the reads are in `session.rs`. A model step is one `assistant` message, so a user's prompt
//! is followed by a chain of them; the turn is what the chat shows, not the message.

use std::sync::LazyLock;

use protocol::js::{cut_utf16, stringify_pretty, trim};
use protocol::{
    ContextUsage, ConversationMetadata, ConversationPart, ConversationTurn, ImageRef,
    SkillActivity, SkillEvidence, SkillStatus, TextPhase, ToolPart, TurnRole,
};
use regex::Regex;
use serde_json::Value;

use super::time::{InvalidTime, iso};
use crate::records::{IMAGE_TYPES, Row, record, token_count};
use crate::tool_output::trim_output;

/// Message ids are `msg_` and letters, digits, `_`, `-`: a ref made of one is safe to put in a URL.
pub(super) static OPENCODE_MESSAGE_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^msg_[A-Za-z0-9_-]{1,100}$").expect("OPENCODE_MESSAGE_ID"));
/// `<message id>:<index>`: a user image's index in `files`, or a tool's index in `content` (0 for
/// a shell command). The digits are ASCII, as JavaScript's `\d` is.
pub(super) static OPENCODE_REF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(msg_[A-Za-z0-9_-]{1,100}):([0-9]{1,4})$").expect("OPENCODE_REF")
});

/// A notice is a line the reader opens on request, not the model's whole instructions.
const NOTICE_CHARS: usize = 4000;
/// A step with no end older than this was cut off (the server died), not written still.
const STALE_MS: f64 = 10.0 * 60_000.0;

/// A field that is a string, else `""` (TypeScript's `text`).
fn text<'a>(row: &'a Row, field: &str) -> &'a str {
    row.get(field).and_then(Value::as_str).unwrap_or_default()
}

/// The first of two strings that is not empty (`a || b`).
fn or<'a>(a: &'a str, b: &'a str) -> &'a str {
    if a.is_empty() { b } else { a }
}

/// `Object.keys(record(value)).length > 0`.
fn has_fields(value: Option<&Value>) -> bool {
    !record(value).is_empty()
}

/// A JSON number that is not zero (`typeof value === "number" && value !== 0`).
fn nonzero(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|number| number != 0.0)
}

/// A message that opens a turn: the person's prompt, or text the runtime put in the user's seat.
pub(super) fn starts_turn(message: &Row) -> bool {
    matches!(text(message, "type"), "user" | "synthetic")
}

/// What a tool wrote: its text, with a line for each file it returned (the file itself is not read).
fn content_text(content: Option<&Value>) -> String {
    let parts = match content {
        Some(Value::Array(parts)) => parts.as_slice(),
        _ => &[],
    };
    parts
        .iter()
        .map(|value| {
            let part = record(Some(value));
            match text(part, "type") {
                "text" => text(part, "text").to_owned(),
                "file" => format!(
                    "[file: {}]",
                    or(or(text(part, "name"), text(part, "mime")), "file")
                ),
                _ => String::new(),
            }
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The one line a collapsed tool chip shows.
fn summary_of(name: &str, input: &Row) -> String {
    const KEYS: [&str; 8] = [
        "command",
        "filePath",
        "file_path",
        "path",
        "pattern",
        "description",
        "url",
        "query",
    ];
    for key in KEYS {
        let value = text(input, key);
        if !value.is_empty() {
            let line = value.split('\n').next().unwrap_or_default();
            return cut_utf16(line, 120).to_owned();
        }
    }
    name.to_owned()
}

/// The tool call at `content[index]` of an assistant message, or a shell command (index 0), with
/// its whole output (`toolOutputOf`).
pub(super) fn tool_output_of(message: &Row, index: usize) -> Option<String> {
    if text(message, "type") == "shell" {
        return (index == 0).then(|| text(record(message.get("output")), "output").to_owned());
    }
    let tool = record(
        message
            .get("content")
            .and_then(Value::as_array)
            .and_then(|content| content.get(index)),
    );
    if text(message, "type") != "assistant" || text(tool, "type") != "tool" {
        return None;
    }
    Some(tool_result(record(tool.get("state"))).0)
}

/// A tool's output, and whether it failed.
fn tool_result(state: &Row) -> (String, bool) {
    match text(state, "status") {
        "completed" => {
            let metadata = record(state.get("metadata"));
            // fleet's rule for every agent: a command that exited non-zero failed, whatever its
            // status says
            (
                content_text(state.get("content")),
                nonzero(metadata.get("exit")),
            )
        }
        "error" => {
            let output = content_text(state.get("content"));
            let output = if output.is_empty() {
                text(record(state.get("error")), "message").to_owned()
            } else {
                output
            };
            (output, true)
        }
        _ => (String::new(), false),
    }
}

/// `index` is the tool's place in the message's content: the ref its whole output is fetched by.
fn tool_part(message_id: &str, index: usize, tool: &Row) -> ToolPart {
    let name = or(text(tool, "name"), "tool").to_owned();
    let state = record(tool.get("state"));
    let streamed = state.get("input").and_then(Value::as_str);
    let input = match streamed {
        Some(_) => &Row::new(),
        None => record(state.get("input")),
    };
    let mut part = ToolPart {
        summary: summary_of(&name, input),
        input: match streamed {
            Some(streamed) => streamed.to_owned(),
            None => stringify_pretty(&Value::Object(input.clone())),
        },
        name,
        output: String::new(),
        error: None,
        skill: None,
        output_ref: None,
        output_size: None,
        images: None,
    };
    let (output, error) = tool_result(state);
    trim_output(&mut part, &output, &format!("{message_id}:{index}"));
    if error {
        part.error = Some(true);
    }
    part
}

fn shell_part(message: &Row) -> ToolPart {
    let command = text(message, "command");
    let mut input = Row::new();
    input.insert("command".to_owned(), Value::String(command.to_owned()));
    let mut part = ToolPart {
        name: "bash".to_owned(),
        summary: summary_of("bash", &input),
        input: command.to_owned(),
        output: String::new(),
        error: None,
        skill: None,
        output_ref: None,
        output_size: None,
        images: None,
    };
    trim_output(
        &mut part,
        text(record(message.get("output")), "output"),
        &format!("{}:0", text(message, "id")),
    );
    if nonzero(message.get("exit")) || matches!(text(message, "status"), "timeout" | "killed") {
        part.error = Some(true);
    }
    part
}

/// The turns of a run of messages, and the id of each turn's first message: the cursor a page
/// starting at that turn carries.
#[derive(Debug, Default)]
pub(super) struct ParsedMessages {
    pub(super) turns: Vec<ConversationTurn>,
    pub(super) first_ids: Vec<String>,
}

/// The turns being made, and which is the assistant turn being filled.
struct Turns {
    parsed: ParsedMessages,
    /// the assistant turn being filled; `None` until a message needs one
    assistant: Option<usize>,
}

impl Turns {
    fn push(&mut self, turn: ConversationTurn, id: &str) -> usize {
        self.parsed.turns.push(turn);
        self.parsed.first_ids.push(id.to_owned());
        self.parsed.turns.len() - 1
    }

    fn user(&mut self, message: &Row, parts: Vec<ConversationPart>) -> Result<(), InvalidTime> {
        self.assistant = None;
        let ts = iso(record(message.get("time")).get("created"))?;
        self.push(
            ConversationTurn {
                role: TurnRole::User,
                ts,
                end_ts: None,
                parts,
            },
            text(message, "id"),
        );
        Ok(())
    }

    fn assistant(&mut self, message: &Row) -> Result<&mut ConversationTurn, InvalidTime> {
        let time = record(message.get("time"));
        let index = match self.assistant {
            Some(index) => index,
            None => {
                let ts = iso(time.get("created"))?;
                let index = self.push(
                    ConversationTurn {
                        role: TurnRole::Assistant,
                        ts,
                        end_ts: None,
                        parts: Vec::new(),
                    },
                    text(message, "id"),
                );
                self.assistant = Some(index);
                index
            }
        };
        // `completed ?? created`: a null end is no end
        let end = iso(time
            .get("completed")
            .filter(|completed| !completed.is_null())
            .or_else(|| time.get("created")))?;
        let turn = &mut self.parsed.turns[index];
        if end.is_some() {
            turn.end_ts = end;
        }
        Ok(turn)
    }
}

/// Messages oldest first, those a staged revert hides already left out (`parseOpencodeMessages`).
/// A `user` or `synthetic` message opens a turn, and what follows it until the next such message
/// is one assistant turn. Ids are never compared: the list's order is the order. An error: a time
/// JavaScript's `Date` cannot hold, which fails the read in TypeScript too.
pub(super) fn parse_opencode_messages(messages: &[Row]) -> Result<ParsedMessages, InvalidTime> {
    let mut turns = Turns {
        parsed: ParsedMessages::default(),
        assistant: None,
    };
    for message in messages {
        let id = text(message, "id");
        match text(message, "type") {
            "user" => {
                let mut parts = Vec::new();
                let prompt = text(message, "text");
                if !prompt.is_empty() {
                    parts.push(ConversationPart::Text {
                        text: prompt.to_owned(),
                        phase: None,
                    });
                }
                let files = message.get("files").and_then(Value::as_array);
                for (index, value) in files.into_iter().flatten().enumerate() {
                    let file = record(Some(value));
                    let mime = text(file, "mime");
                    if IMAGE_TYPES.contains(&mime) {
                        parts.push(ConversationPart::Image(ImageRef {
                            media_type: mime.to_owned(),
                            reference: format!("{id}:{index}"),
                        }));
                    } else {
                        parts.push(ConversationPart::Text {
                            text: format!("[file: {}]", or(or(text(file, "name"), mime), "file")),
                            phase: None,
                        });
                    }
                }
                turns.user(message, parts)?;
            }
            "synthetic" | "system" => {
                // `description` is the short summary meant for a transcript; `text` is what the
                // model was told (an instructions delta, whole)
                let body = cut_utf16(
                    trim(or(text(message, "description"), text(message, "text"))),
                    NOTICE_CHARS,
                );
                if !body.is_empty() {
                    turns.user(
                        message,
                        vec![ConversationPart::Notice {
                            text: body.to_owned(),
                            source: None,
                        }],
                    )?;
                }
            }
            "skill" => {
                // `name` is the skill's name as shown; `skill` is its id
                let name = or(text(message, "name"), text(message, "skill"));
                if !name.is_empty() {
                    turns
                        .assistant(message)?
                        .parts
                        .push(ConversationPart::Skill {
                            skill: SkillActivity {
                                name: name.to_owned(),
                                evidence: SkillEvidence::Instructions,
                                status: SkillStatus::Loaded,
                                path: None,
                            },
                        });
                }
            }
            "shell" => {
                let part = shell_part(message);
                turns
                    .assistant(message)?
                    .parts
                    .push(ConversationPart::Tool(part));
            }
            "compaction" => {
                let summary = text(message, "summary");
                let status = text(message, "status");
                if status == "completed" && !trim(summary).is_empty() {
                    turns.user(
                        message,
                        vec![ConversationPart::Compact {
                            text: summary.to_owned(),
                        }],
                    )?;
                } else if status == "failed" {
                    let detail = text(record(message.get("error")), "message");
                    let line = if detail.is_empty() {
                        "Error: compaction failed".to_owned()
                    } else {
                        format!("Error: compaction failed: {detail}")
                    };
                    turns
                        .assistant(message)?
                        .parts
                        .push(ConversationPart::Text {
                            text: line,
                            phase: None,
                        });
                }
            }
            "assistant" => {
                let turn = turns.assistant(message)?;
                let mut last = None;
                let content = message.get("content").and_then(Value::as_array);
                for (index, value) in content.into_iter().flatten().enumerate() {
                    let block = record(Some(value));
                    let block_text = text(block, "text");
                    match text(block, "type") {
                        "text" if !block_text.is_empty() => {
                            last = Some(turn.parts.len());
                            turn.parts.push(ConversationPart::Text {
                                text: block_text.to_owned(),
                                phase: None,
                            });
                        }
                        "reasoning" if !block_text.is_empty() => {
                            turn.parts.push(ConversationPart::Thinking {
                                text: block_text.to_owned(),
                            });
                        }
                        "tool" => turn
                            .parts
                            .push(ConversationPart::Tool(tool_part(id, index, block))),
                        _ => {}
                    }
                }
                if has_fields(message.get("error")) {
                    let error = record(message.get("error"));
                    let line = if text(error, "type") == "aborted" {
                        "Interrupted".to_owned()
                    } else {
                        format!("Error: {}", or(text(error, "message"), text(error, "type")))
                    };
                    turn.parts.push(ConversationPart::Text {
                        text: line,
                        phase: None,
                    });
                }
                // an answer is the text the model ended on; a step that went on to call tools is
                // commentary
                if text(message, "finish") == "stop"
                    && let Some(ConversationPart::Text { phase, .. }) =
                        last.and_then(|last| turn.parts.get_mut(last))
                {
                    *phase = Some(TextPhase::FinalAnswer);
                }
            }
            // idle, agent/model/location switches, and kinds a later version adds: no turn of
            // their own
            _ => {}
        }
    }
    // a message with nothing to show (an empty step, a user turn of only an unknown file) is no turn
    let ParsedMessages {
        turns: all,
        first_ids,
    } = turns.parsed;
    let (turns, first_ids) = all
        .into_iter()
        .zip(first_ids)
        .filter(|(turn, _)| !turn.parts.is_empty())
        .unzip();
    Ok(ParsedMessages { turns, first_ids })
}

/// `provider/model`, the variant when it is not the default, and the context the newest request
/// filled (`opencodeMetadata`). `window_of(provider, model)`: the model's context window.
pub(super) fn opencode_metadata(
    messages: &[Row],
    window_of: impl Fn(&str, &str) -> Option<f64>,
) -> ConversationMetadata {
    let mut metadata = ConversationMetadata {
        model: None,
        reasoning_effort: None,
        context: None,
    };
    let mut model_seen = false;
    for message in messages.iter().rev() {
        if text(message, "type") != "assistant" {
            continue;
        }
        let model = record(message.get("model"));
        let model_id = text(model, "id");
        let provider_id = text(model, "providerID");
        if !model_seen && !model_id.is_empty() {
            model_seen = true;
            metadata.model = Some(if provider_id.is_empty() {
                model_id.to_owned()
            } else {
                format!("{provider_id}/{model_id}")
            });
            let variant = text(model, "variant");
            metadata.reasoning_effort =
                (!variant.is_empty() && variant != "default").then(|| variant.to_owned());
        }
        // an errored or aborted step reports zeros: it filled nothing, so it says nothing of the
        // context
        let tokens = record(message.get("tokens"));
        let cache = record(tokens.get("cache"));
        let used = token_count(tokens.get("input"))
            + token_count(cache.get("read"))
            + token_count(cache.get("write"));
        if used > 0.0 {
            metadata.context = Some(ContextUsage {
                used,
                window: if model_id.is_empty() {
                    None
                } else {
                    window_of(provider_id, model_id)
                },
            });
            break;
        }
    }
    metadata
}

/// Whether the end of the list is still being written (`stillWriting`): the newest assistant
/// message has no end, a tool has not finished, a shell command runs, or a compaction does (it
/// changes in place, with no new message and no change to the session).
pub(super) fn still_writing(messages: &[Row], now: i64) -> bool {
    let fresh = |message: &Row| match record(message.get("time"))
        .get("created")
        .and_then(Value::as_f64)
    {
        Some(created) => (now as f64) - created < STALE_MS,
        None => true,
    };
    for message in messages.iter().rev() {
        match text(message, "type") {
            "shell" | "compaction" => {
                return text(message, "status") == "running" && fresh(message);
            }
            "assistant" => {}
            _ => continue,
        }
        if !fresh(message) {
            return false;
        }
        // an end that is null is still an end: TypeScript asks whether the field is there
        if !record(message.get("time")).contains_key("completed")
            && !has_fields(message.get("error"))
        {
            return true;
        }
        let content = message.get("content").and_then(Value::as_array);
        return content.into_iter().flatten().any(|value| {
            let state = record(record(Some(value)).get("state"));
            matches!(text(state, "status"), "streaming" | "running")
        });
    }
    false
}
