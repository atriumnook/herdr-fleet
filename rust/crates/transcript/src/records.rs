//! The native-record rules two or more sources share (`server/transcript-records.ts`, the shared
//! parts of `server/conversation-metadata.ts` and `server/conversation.ts`), so paging, rendering
//! and on-demand results read records the same way.
//!
//! pi and omp share one parser (`parse_omp_transcript`). What omp does not use is moved here for
//! the sources that do (#201 to #205), and #206 removes its `allow(dead_code)`.

use std::collections::HashMap;

use base64::Engine as _;
use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use protocol::js::{self, cut_utf16};
use protocol::{
    ContextUsage, ConversationMetadata, ConversationPart, ConversationTurn, ImageRef, ToolPart,
    TurnRole,
};
use serde_json::{Map, Value};

use crate::js_json::stringify_pretty;
use crate::skill_activity::skill_invocation_prompt;
use crate::tool_output::trim_output;

pub(crate) type Row = Map<String, Value>;

static EMPTY: std::sync::LazyLock<Row> = std::sync::LazyLock::new(Row::new);

/// A record's fields: a JSON object, else none (TypeScript's `record`).
pub(crate) fn record(value: Option<&Value>) -> &Row {
    match value {
        Some(Value::Object(row)) => row,
        _ => &EMPTY,
    }
}

/// A field that is a string.
pub(crate) fn text<'a>(row: &'a Row, field: &str) -> Option<&'a str> {
    row.get(field).and_then(Value::as_str)
}

/// A JSON line as `JSON.parse` reads it, or `None` for a line it would refuse (a torn tail) and
/// for the two JSON texts serde_json refuses and `JSON.parse` reads (a lone surrogate escape, a
/// number past f64): ADR 0193-phase-2-dependencies reads those as unreadable records.
pub(crate) fn parse_line(line: &str) -> Option<Value> {
    serde_json::from_str(line).ok()
}

/// The text of a tool result: the string, or the `text` of each part.
pub(crate) fn result_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| record(Some(part)).get("text").and_then(Value::as_str))
            .collect(),
        _ => String::new(),
    }
}

/// Enough turns for a conversation.
pub(crate) const MAX_TURNS: usize = 100;

/// The image types a chat shows; anything else stays out of the page.
#[allow(dead_code)]
pub(crate) const IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// The first of these fields that is a string (TypeScript's `string(...values)`).
fn first_string(row: &Row, fields: &[&str]) -> Option<Value> {
    fields
        .iter()
        .find_map(|field| row.get(*field).filter(|value| value.is_string()).cloned())
}

/// The first of these fields that is neither absent nor null (TypeScript's `a ?? b ?? c`).
fn first_present(row: &Row, fields: &[&str]) -> Option<Value> {
    fields
        .iter()
        .find_map(|field| row.get(*field).filter(|value| !value.is_null()).cloned())
}

/// Sets `field` to `value`, or removes it when the value is undefined.
fn put(row: &mut Row, field: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            row.insert(field.to_owned(), value);
        }
        None => {
            row.remove(field);
        }
    }
}

/// A pi-family `/clear`: a custom record of its own type.
pub(crate) fn pi_context_clear(value: &Value) -> bool {
    let entry = record(Some(value));
    text(entry, "type") == Some("custom") && text(entry, "customType") == Some("context_clear")
}

/// A pi-family message with its content as a list of blocks: providers use several spellings for
/// the same tool call and result fields, read here as one. `None` for any other record and for a
/// message not to be displayed.
pub(crate) fn pi_message(value: &Value) -> Option<Row> {
    let entry = record(Some(value));
    let message = record(entry.get("message"));
    if text(entry, "type") != Some("message")
        || message.get("display") == Some(&Value::Bool(false))
        || entry.get("display") == Some(&Value::Bool(false))
    {
        return None;
    }
    let raw = match message.get("content") {
        Some(Value::String(text)) => vec![serde_json::json!({ "type": "text", "text": text })],
        Some(Value::Array(blocks)) => blocks.clone(),
        _ => Vec::new(),
    };
    let content = raw
        .into_iter()
        .map(|value| {
            let Value::Object(mut block) = value else {
                return value;
            };
            match text(&block, "type") {
                Some("toolCall") => {
                    let name = first_string(&block, &["toolName", "name"]);
                    let id = first_string(&block, &["toolCallId", "id", "callId"]);
                    let arguments = first_present(&block, &["toolInput", "input", "arguments"]);
                    put(&mut block, "name", name);
                    put(&mut block, "id", id);
                    put(&mut block, "arguments", arguments);
                }
                Some("toolResult") => {
                    let id = first_string(&block, &["toolCallId", "callId", "id"]);
                    let content = first_present(&block, &["output", "content", "result"]);
                    put(&mut block, "toolCallId", id);
                    put(&mut block, "content", content);
                }
                _ => {}
            }
            Value::Object(block)
        })
        .collect();
    let mut normalized = message.clone();
    let id = first_string(message, &["toolCallId", "callId"]);
    put(&mut normalized, "toolCallId", id);
    normalized.insert("content".to_owned(), Value::Array(content));
    Some(normalized)
}

/// One tool result of a pi-family message, with the media types of the images it carries.
pub(crate) struct PiResult {
    pub(crate) id: String,
    pub(crate) text: String,
    pub(crate) error: bool,
    pub(crate) images: Vec<String>,
}

/// The tool result blocks of a message from `pi_message`: the message itself when its role is
/// `toolResult`, else its `toolResult` blocks.
fn result_blocks(message: &Row) -> Vec<&Row> {
    if text(message, "role") == Some("toolResult") {
        return vec![message];
    }
    match message.get("content") {
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|block| record(Some(block)))
            .filter(|block| text(block, "type") == Some("toolResult"))
            .collect(),
        _ => Vec::new(),
    }
}

/// One entry's tool results, with the images each carries. pi reads a picture into a tool
/// result as inline base64 beside the text it returns, so only the position is carried in the
/// page: the bytes stay in the file and are fetched when the row is opened. `index` counts the
/// images of that one result, which is what the page's ref quotes.
pub(crate) fn pi_results(message: &Row) -> Vec<PiResult> {
    result_blocks(message)
        .into_iter()
        .filter_map(|block| {
            let id = text(block, "toolCallId")?.to_owned();
            let images = block_images(block)
                .into_iter()
                .map(|image| image.0)
                .collect();
            Some(PiResult {
                id,
                text: result_text(block.get("content")),
                error: block.get("isError") == Some(&Value::Bool(true)),
                images,
            })
        })
        .collect()
}

/// The images of a result block, as (media type, base64 data).
fn block_images(block: &Row) -> Vec<(String, String)> {
    match block.get("content") {
        Some(Value::Array(parts)) => parts.iter().filter_map(pi_image_of).collect(),
        _ => Vec::new(),
    }
}

/// An image block a chat shows; pi names the type `mimeType` where Claude names it `media_type`.
fn pi_image_of(value: &Value) -> Option<(String, String)> {
    let image = record(Some(value));
    if text(image, "type") != Some("image") {
        return None;
    }
    let media_type = text(image, "mimeType").or_else(|| text(image, "media_type"))?;
    let data = text(image, "data")?;
    PI_IMAGE_TYPES
        .contains(&media_type)
        .then(|| (media_type.to_owned(), data.to_owned()))
}

const PI_IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// The `index`th image of the tool result answering `tool_call_id`, as (media type, base64 data).
/// `message` must come from `pi_message`: the page's ref was built from the normalised content.
#[allow(dead_code)]
pub(crate) fn pi_image_block(
    message: &Row,
    tool_call_id: &str,
    index: usize,
) -> Option<(String, String)> {
    if pi_results(message)
        .iter()
        .all(|result| result.id != tool_call_id)
    {
        return None;
    }
    result_blocks(message)
        .into_iter()
        .filter(|block| {
            text(message, "role") == Some("toolResult")
                || text(block, "toolCallId") == Some(tool_call_id)
        })
        .flat_map(block_images)
        .nth(index)
}

/// Does this pi-family record open a turn? A prompt is a `message` record with a user role and
/// text; a tool result answers the turn before it.
pub(crate) fn pi_opens_turn(entry: &Value) -> bool {
    pi_message(entry).is_some_and(|message| {
        text(&message, "role") == Some("user")
            && blocks(&message).any(|block| {
                text(block, "type") == Some("text")
                    && text(block, "text").is_some_and(|text| !text.is_empty())
            })
    })
}

/// A runtime wakes the agent with a `custom_message` (a background job's result, `display: true`)
/// in the user's seat: the answer before it is final and the work after it is a new turn.
/// The envelope is chrome.
pub(crate) fn pi_notice(value: &Value) -> Option<String> {
    let entry = record(Some(value));
    if text(entry, "type") != Some("custom_message")
        || entry.get("display") == Some(&Value::Bool(false))
    {
        return None;
    }
    let content = js::trim(text(entry, "content")?);
    let content = content
        .strip_prefix("<system-notice>")
        .map_or(content, js::trim_start);
    let content = content
        .strip_suffix("</system-notice>")
        .map_or(content, js::trim_end);
    let content = js::trim(content);
    (!content.is_empty()).then(|| content.to_owned())
}

/// The one-line summary a collapsed tool chip shows. pi names a file `path` where Claude names it
/// `file_path`; both are worth showing.
pub(crate) fn tool_summary(name: &str, input: &Value) -> String {
    let first = [
        "command",
        "file_path",
        "path",
        "pattern",
        "description",
        "url",
    ]
    .iter()
    .find_map(|field| input.get(*field).filter(|value| !value.is_null()));
    match first {
        Some(Value::String(text)) => cut_utf16(text, 120).to_owned(),
        _ => name.to_owned(),
    }
}

/// `typeof value === "object" && value !== null ? value : {}` for a tool call's input.
pub(crate) fn tool_input(value: Option<&Value>) -> Value {
    match value {
        Some(input @ (Value::Object(_) | Value::Array(_))) => input.clone(),
        _ => Value::Object(Map::new()),
    }
}

/// `split("\n")` of JavaScript: every line, the last one too when it is empty.
pub(crate) fn lines(text: &str) -> impl Iterator<Item = &str> {
    text.split('\n')
}

/// Splits one pi-family session jsonl into turns: adjacent assistant messages merge, toolCall
/// parts adopt the output of the toolResult that answers them (matched by toolCallId), thinking
/// stays private to the agent. `tool_images`: name the images a tool result carries (pi only:
/// omp would carry refs nothing can answer).
pub(crate) fn parse_omp_transcript(text_of_page: &str, tool_images: bool) -> Vec<ConversationTurn> {
    let mut turns: Vec<ConversationTurn> = Vec::new();
    // tool parts still waiting for their result, by toolCall id: (turn, part)
    let mut pending: HashMap<String, (usize, usize)> = HashMap::new();

    for line in lines(text_of_page) {
        if js::trim(line).is_empty() {
            continue;
        }
        let Some(entry) = parse_line(line) else {
            continue;
        };
        if !(entry.is_object() || entry.is_array()) {
            continue;
        }
        if pi_context_clear(&entry) {
            turns.clear();
            pending.clear();
            continue;
        }
        let timestamp = record(Some(&entry))
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(notice) = pi_notice(&entry) {
            turns.push(ConversationTurn {
                role: TurnRole::User,
                ts: timestamp,
                end_ts: None,
                parts: vec![ConversationPart::Notice {
                    text: notice,
                    source: None,
                }],
            });
            continue;
        }
        // pi folds old context into a summary of its own accord and on /compact: the card says
        // where the conversation was cut
        if text(record(Some(&entry)), "type") == Some("compaction") {
            if let Some(summary) = text(record(Some(&entry)), "summary")
                .filter(|summary| !js::trim(summary).is_empty())
            {
                turns.push(ConversationTurn {
                    role: TurnRole::User,
                    ts: timestamp,
                    end_ts: None,
                    parts: vec![ConversationPart::Compact {
                        text: summary.to_owned(),
                    }],
                });
            }
            continue;
        }
        let Some(message) = pi_message(&entry) else {
            continue;
        };
        let role = text(&message, "role");
        if role != Some("assistant") {
            apply_results(&message, &mut turns, &mut pending, tool_images);
        }

        if role == Some("user") {
            let prompt = blocks(&message)
                .filter(|block| text(block, "type") == Some("text"))
                .filter_map(|block| text(block, "text"))
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            // image-only user parts have no text to show
            if prompt.is_empty() {
                continue;
            }
            // a skill invocation reads as what the user asked, the skill as a chip on it
            let mut parts = Vec::new();
            match skill_invocation_prompt(&prompt) {
                None => parts.push(ConversationPart::Text {
                    text: prompt,
                    phase: None,
                }),
                Some(invocation) => {
                    let asked = if invocation.request.is_empty() {
                        invocation
                            .skills
                            .iter()
                            .map(|skill| format!("/skill:{}", skill.name))
                            .collect::<Vec<_>>()
                            .join(" ")
                    } else {
                        invocation.request
                    };
                    parts.push(ConversationPart::Text {
                        text: asked,
                        phase: None,
                    });
                    parts.extend(
                        invocation
                            .skills
                            .into_iter()
                            .map(|skill| ConversationPart::Skill { skill }),
                    );
                }
            }
            turns.push(ConversationTurn {
                role: TurnRole::User,
                ts: timestamp,
                end_ts: None,
                parts,
            });
            continue;
        }

        if role == Some("assistant") {
            let at = match turns.last() {
                Some(last) if last.role == TurnRole::Assistant => turns.len() - 1,
                _ => {
                    turns.push(ConversationTurn {
                        role: TurnRole::Assistant,
                        ts: timestamp.clone(),
                        end_ts: None,
                        parts: Vec::new(),
                    });
                    turns.len() - 1
                }
            };
            if let Some(timestamp) = timestamp.filter(|timestamp| !timestamp.is_empty()) {
                turns[at].end_ts = Some(timestamp);
            }
            for block in blocks(&message) {
                match text(block, "type") {
                    Some("text") => {
                        if let Some(text) = text(block, "text").filter(|text| !text.is_empty()) {
                            turns[at].parts.push(ConversationPart::Text {
                                text: text.to_owned(),
                                phase: None,
                            });
                        }
                    }
                    Some("thinking") => {
                        let thinking = text(block, "thinking")
                            .or_else(|| text(block, "text"))
                            .unwrap_or("");
                        if !thinking.is_empty() {
                            turns[at].parts.push(ConversationPart::Thinking {
                                text: thinking.to_owned(),
                            });
                        }
                    }
                    Some("toolCall") => {
                        let Some(name) = text(block, "name") else {
                            continue;
                        };
                        let input = tool_input(block.get("arguments"));
                        let summary =
                            match text(block, "intent").filter(|intent| !intent.is_empty()) {
                                Some(intent) => intent.to_owned(),
                                None => tool_summary(name, &input),
                            };
                        turns[at].parts.push(ConversationPart::Tool(ToolPart {
                            name: name.to_owned(),
                            summary: cut_utf16(&summary, 120).to_owned(),
                            input: stringify_pretty(&input),
                            output: String::new(),
                            error: None,
                            skill: None,
                            output_ref: None,
                            output_size: None,
                            images: None,
                        }));
                        if let Some(id) = text(block, "id") {
                            pending.insert(id.to_owned(), (at, turns[at].parts.len() - 1));
                        }
                    }
                    // unsupported transcript parts are intentionally ignored
                    _ => {}
                }
            }
            // a provider can place a result beside its call in the same assistant record
            apply_results(&message, &mut turns, &mut pending, tool_images);
            // a failed request (a 401, an overloaded provider) leaves an empty message: without its
            // error the chat showed the prompt with no answer at all
            if text(&message, "stopReason") == Some("error")
                && let Some(error) =
                    text(&message, "errorMessage").filter(|error| !error.is_empty())
            {
                turns[at].parts.push(ConversationPart::Text {
                    text: format!("Error: {error}"),
                    phase: None,
                });
            }
        }
    }

    turns.retain(|turn| !turn.parts.is_empty());
    turns
}

/// The object blocks of a message's content.
fn blocks(message: &Row) -> impl Iterator<Item = &Row> {
    message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
}

/// Folds a message's tool results into the tool parts waiting for them.
fn apply_results(
    message: &Row,
    turns: &mut [ConversationTurn],
    pending: &mut HashMap<String, (usize, usize)>,
    tool_images: bool,
) {
    for result in pi_results(message) {
        let Some((turn, part)) = pending.remove(&result.id) else {
            continue;
        };
        let ConversationPart::Tool(tool) = &mut turns[turn].parts[part] else {
            continue;
        };
        trim_output(tool, &result.text, &result.id);
        if result.error {
            tool.error = Some(true);
        }
        if tool_images && !result.images.is_empty() {
            // addressed by the call it answers: a nested result shares its entry with other
            // blocks, so the entry id alone could not say which one an image came from
            tool.images = Some(
                result
                    .images
                    .iter()
                    .enumerate()
                    .map(|(index, media_type)| ImageRef {
                        media_type: media_type.clone(),
                        reference: format!("pi:{}:{index}", result.id),
                    })
                    .collect(),
            );
        }
    }
}

/// A model or effort as it may be shown: a trimmed string that is not markup.
pub(crate) fn metadata_label(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    let trimmed = js::trim(text);
    (!trimmed.is_empty() && !text.starts_with('<')).then(|| trimmed.to_owned())
}

/// A token count as recorded: a positive finite number, else 0.
pub(crate) fn token_count(value: Option<&Value>) -> f64 {
    match value.and_then(Value::as_f64) {
        Some(count) if count.is_finite() && count > 0.0 => count,
        _ => 0.0,
    }
}

/// Claude's standard window; a request past it can only have run in the 1M one.
const CLAUDE_STANDARD_WINDOW: f64 = 200_000.0;
const CLAUDE_LONG_WINDOW: f64 = 1_000_000.0;

/// The context a request filled, and the window when the transcript leaves no doubt: the window
/// a transcript states (Codex), else for a Claude model the 1M one once a request went past 200k
/// (and kept: a compaction shrinks the use, not the window). pi resolves its window its own way.
pub(crate) fn context_of(
    used: f64,
    model: Option<&str>,
    window: Option<f64>,
    before: Option<ContextUsage>,
) -> Option<ContextUsage> {
    if used == 0.0 {
        return before;
    }
    if window.is_some() {
        return Some(ContextUsage { used, window });
    }
    let long = model.is_some_and(|model| model.starts_with("claude"))
        && (used > CLAUDE_STANDARD_WINDOW
            || before.and_then(|before| before.window) == Some(CLAUDE_LONG_WINDOW));
    Some(ContextUsage {
        used,
        window: long.then_some(CLAUDE_LONG_WINDOW),
    })
}

/// The metadata a fold starts from: what the text before said, or nothing recorded.
pub(crate) fn metadata_start(before: Option<ConversationMetadata>) -> ConversationMetadata {
    before.unwrap_or(ConversationMetadata {
        model: None,
        reasoning_effort: None,
        context: None,
    })
}

/// `Buffer.from(text, "base64")` of Node: never fails, reads both alphabets, skips what is in
/// neither, stops at the first `=`, drops a last lone character (the rules and Bun's answers:
/// ADR 0193-phase-2-dependencies, "寛容な base64 の復号").
#[allow(dead_code)]
pub(crate) fn decode_base64_leniently(text: &str) -> Vec<u8> {
    // each UTF-16 code unit as its low byte, as Node's latin1 does
    let bytes: Vec<u8> = text.encode_utf16().map(|unit| unit as u8).collect();
    let end = bytes
        .iter()
        .position(|byte| *byte == b'=')
        .unwrap_or(bytes.len());
    let mut kept: Vec<u8> = bytes[..end]
        .iter()
        .map(|byte| match byte {
            b'-' => b'+',
            b'_' => b'/',
            other => *other,
        })
        .filter(|byte| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/')
        .collect();
    if kept.len() % 4 == 1 {
        kept.pop();
    }
    let engine = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    engine.decode(&kept).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values: Bun 1.4.4 `[...Buffer.from(input, "base64")]` (ADR 0193-phase-2-dependencies,
    // and the scratchpad js.ts of #196).
    #[test]
    fn decodes_base64_as_node_does() {
        let hello = vec![104, 101, 108, 108, 111];
        let cases: [(&str, Vec<u8>); 18] = [
            ("aGVsbG8=", hello.clone()),
            ("aGVsbG8", hello.clone()),
            ("aGVs bG8=", hello.clone()),
            ("aGVs\nbG8=", hello.clone()),
            ("aGVsbG8=extra", hello.clone()),
            ("aGV*sbG8", hello.clone()),
            ("aGVsbG9", hello.clone()),
            ("aGVsbG8-_w", vec![104, 101, 108, 108, 111, 62, 255]),
            ("aGVsbG8+/w", vec![104, 101, 108, 108, 111, 62, 255]),
            ("aGVsbG8xY", vec![104, 101, 108, 108, 111, 49]),
            ("aGVsbG8xYQ", vec![104, 101, 108, 108, 111, 49, 97]),
            ("aGVs=bG8=", vec![104, 101, 108]),
            ("=aGVs", vec![]),
            ("", vec![]),
            ("####", vec![]),
            ("aG💩VsbG8=", vec![104]),
            ("aGŁVsbG8=", vec![104, 96, 21, 177, 177, 188]),
            ("aGé VsbG8=", hello),
        ];
        for (input, expected) in cases {
            assert_eq!(
                decode_base64_leniently(input),
                expected,
                "Buffer.from({input:?}, \"base64\")"
            );
        }
    }
}
