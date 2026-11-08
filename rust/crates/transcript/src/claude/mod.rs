//! Claude Code's session transcripts (`~/.claude/projects/<project>/<session>.jsonl`): the
//! `claude-transcript` branches of `server/conversation.ts` (`parseClaudeTranscript`, `opensTurn`,
//! `TURN_MARK` and `PEER_MARK`, `outputInText`, `transcriptImage`), of
//! `server/conversation-metadata.ts`, and the Claude records of `server/transcript-records.ts`
//! (`isContextClear`, `claudePeerNotice`, `claudePeerId`). A `/clear` starts a new history.

mod parse;
mod text;

use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

use protocol::js::{self, WHITESPACE};
use protocol::{ConversationMetadata, ConversationPart, ConversationSource, ConversationTurn};
use regex::Regex;
use serde_json::Value;

use crate::Image;
use crate::format::{TranscriptFormat, active_history_text};
use crate::records::{
    IMAGE_TYPES, Row, context_of, decode_base64_leniently, lines, metadata_label, metadata_start,
    parse_line, record, text as field, token_count,
};

use self::text::{is_command_entry, js_string, truthy};

pub(crate) struct Claude;

impl TranscriptFormat for Claude {
    type Place = Path;
    /// The deliveries of other sessions' messages read so far, by sender and message id
    /// (`peersSeen`).
    type Carry = HashSet<String>;

    const SOURCE: ConversationSource = ConversationSource::ClaudeTranscript;

    fn live_path(place: &Path) -> &Path {
        place
    }

    fn clear_mark(&self) -> Option<&'static str> {
        Some("/clear")
    }

    fn is_clear(&self, entry: &Value) -> bool {
        is_context_clear(record(Some(entry)))
    }

    /// A prompt holds `"user"`; a queued attachment carrying another session's message has no
    /// `"user"` in it, and its own mark.
    fn turn_marks(&self) -> &'static [&'static str] {
        &["\"user\"", "\"kind\":\"peer\""]
    }

    /// A Claude prompt opens a turn (tool results answer the turn before it), and so does another
    /// session's message in either of its forms. An entry holding a tool result never opens one,
    /// also when it carries a new prompt: the result must be parsed with its call (#141).
    fn opens_turn(&self, entry: &Value) -> bool {
        let entry = record(Some(entry));
        if peer_notice(entry).is_some() {
            return true;
        }
        if field(entry, "type") != Some("user")
            || truthy(entry.get("isMeta"))
            || truthy(entry.get("isCompactSummary"))
        {
            return false;
        }
        match record(entry.get("message")).get("content") {
            Some(Value::String(content)) => !is_command_entry(content),
            Some(Value::Array(blocks)) => {
                // a page starting here would parse the result apart from its call and lose the
                // output
                let kind = |block: &Value| field(record(Some(block)), "type").map(str::to_owned);
                if blocks
                    .iter()
                    .any(|block| kind(block).as_deref() == Some("tool_result"))
                {
                    return false;
                }
                blocks.iter().any(|block| {
                    let block = record(Some(block));
                    field(block, "type") == Some("text")
                        && field(block, "text")
                            .is_some_and(|words| !is_command_entry(js::trim(words)))
                })
            }
            _ => false,
        }
    }

    fn parse_turns(&self, text: &str, carry: &mut HashSet<String>) -> Vec<ConversationTurn> {
        parse::parse_claude_transcript(text, carry)
    }

    /// Recorded settings, never inferred: the model each response names, the context its request
    /// filled (a subagent's request fills its own context, not this one's), and the effort Claude
    /// Code records for each response (versions before it record none).
    fn metadata(&self, text: &str, before: Option<ConversationMetadata>) -> ConversationMetadata {
        let mut metadata = metadata_start(before);
        for line in lines(text) {
            let Some(parsed) = parse_line(line) else {
                continue;
            };
            let entry = record(Some(&parsed));
            if is_context_clear(entry) {
                metadata = metadata_start(None);
                continue;
            }
            if field(entry, "type") != Some("assistant") {
                continue;
            }
            let message = record(entry.get("message"));
            if let Some(model) = metadata_label(message.get("model")) {
                metadata.model = Some(model);
                if entry.get("isSidechain") != Some(&Value::Bool(true)) {
                    let usage = record(message.get("usage"));
                    let used = token_count(usage.get("input_tokens"))
                        + token_count(usage.get("cache_creation_input_tokens"))
                        + token_count(usage.get("cache_read_input_tokens"));
                    metadata.context =
                        context_of(used, metadata.model.as_deref(), None, metadata.context);
                }
            }
            if entry.contains_key("effort") {
                metadata.reasoning_effort = metadata_label(entry.get("effort"));
            }
        }
        metadata
    }

    fn output_in_entry(&self, entry: Value, reference: &str) -> Option<String> {
        let Some(Value::Array(blocks)) = record(entry.get("message")).get("content") else {
            return None;
        };
        blocks
            .iter()
            .map(|block| record(Some(block)))
            .find(|block| {
                field(block, "type") == Some("tool_result")
                    && field(block, "tool_use_id") == Some(reference)
            })
            .map(|block| claude_result_text(block.get("content")))
    }

    /// The image an image part's ref (`<entry uuid>:<block index>`) names, from the last `/clear`
    /// on (`transcriptImage`).
    fn image(&self, place: &Path, reference: &str) -> Option<Image> {
        let found = IMAGE_REF.captures(reference)?;
        let uuid = found.get(1)?.as_str();
        let index: usize = found.get(2)?.as_str().parse().ok()?;
        let bytes = std::fs::read(place).ok()?;
        let whole = String::from_utf8_lossy(&bytes);
        let needle = serde_json::to_string(uuid).ok()?;
        for line in lines(active_history_text(self, &whole)) {
            if !line.contains(&needle) {
                continue;
            }
            let Some(entry) = parse_line(line) else {
                continue;
            };
            let entry = record(Some(&entry));
            let Some(Value::Array(content)) = record(entry.get("message")).get("content") else {
                continue;
            };
            if field(entry, "uuid") != Some(uuid) {
                continue;
            }
            let block = record(content.get(index));
            let source = record(block.get("source"));
            let data = field(source, "data");
            if field(block, "type") != Some("image") || field(source, "type") != Some("base64") {
                return None;
            }
            let data = data?;
            let media_type = js_string(source.get("media_type"));
            if !IMAGE_TYPES.contains(&media_type.as_str()) {
                return None;
            }
            return Some(Image {
                media_type,
                bytes: decode_base64_leniently(data),
            });
        }
        None
    }
}

static IMAGE_REF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^([0-9a-f-]{8,64}):([0-9]{1,3})$").expect("IMAGE_REF"));

/// A whole local-command envelope: quoting /clear in prose is not a reset.
static CLEAR_COMMAND: LazyLock<Regex> = LazyLock::new(|| {
    let s = WHITESPACE;
    Regex::new(&format!(
        r"^{s}*<command-name>{s}*/clear{s}*</command-name>(?:{s}*<command-message>clear</command-message>)?(?:{s}*<command-args>{s}*</command-args>)?{s}*$"
    ))
    .expect("CLEAR_COMMAND")
});

/// Is this record a `/clear` (`isContextClear` of a Claude transcript)?
pub(super) fn is_context_clear(entry: &Row) -> bool {
    let message = record(entry.get("message"));
    if field(entry, "type") != Some("user")
        || truthy(entry.get("isMeta"))
        || truthy(entry.get("isCompactSummary"))
        || field(message, "role") != Some("user")
    {
        return false;
    }
    field(message, "content").is_some_and(|content| CLEAR_COMMAND.is_match(content))
}

static CROSS_SESSION_MESSAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"<cross-session-message(?-u:\b)([^>]*)>\n?((?s:.)*?)\n?</cross-session-message>")
        .expect("CROSS_SESSION_MESSAGE")
});

static FROM_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?-u:\b)from-name="([^"]+)""#).expect("FROM_NAME"));

/// The `origin` of another session's message: a queued attachment's, or a meta `user` entry's.
/// `None` when the record is neither.
fn peer_origin(entry: &Row) -> Option<(&Row, Option<&Value>)> {
    if field(entry, "type") == Some("attachment") {
        let queued = record(entry.get("attachment"));
        return (field(queued, "type") == Some("queued_command"))
            .then(|| (record(queued.get("origin")), queued.get("prompt")));
    }
    (field(entry, "type") == Some("user") && entry.get("isMeta") == Some(&Value::Bool(true))).then(
        || {
            (
                record(entry.get("origin")),
                record(entry.get("message")).get("content"),
            )
        },
    )
}

/// Another Claude session's message (Claude Code cross-session messaging). It starts the agent's
/// work like a prompt, but nobody typed it here: a notice, sourced `peer:<sender>`. Claude records
/// it as a meta `user` entry when it arrives between turns, and as a queued_command attachment
/// when it arrives mid-turn; both carry `origin: { kind: "peer", name, body }` (`claudePeerNotice`).
pub(super) fn peer_notice(entry: &Row) -> Option<ConversationPart> {
    let (origin, envelope) = peer_origin(entry)?;
    if field(origin, "kind") != Some("peer") {
        return None;
    }
    let parsed = envelope
        .and_then(Value::as_str)
        .and_then(|envelope| CROSS_SESSION_MESSAGE.captures(envelope));
    let group = |index: usize| {
        parsed
            .as_ref()
            .and_then(|found| found.get(index))
            .map(|group| group.as_str())
    };
    let body = field(origin, "body").or_else(|| group(2)).unwrap_or("");
    // an unnamed sender leaves the source bare (`peer:`); the chat says "another session" for it
    let name = field(origin, "name")
        .map(js::trim)
        .filter(|name| !name.is_empty())
        .or_else(|| {
            FROM_NAME
                .captures(group(1).unwrap_or(""))
                .and_then(|found| found.get(1))
                .map(|name| name.as_str())
        })
        .unwrap_or("");
    (!js::trim(body).is_empty()).then(|| ConversationPart::Notice {
        text: body.to_owned(),
        source: Some(format!("peer:{name}")),
    })
}

/// One delivery of another session's message, as Claude identifies it: the sender and its message
/// id. Claude can record the same delivery twice (queued mid-turn, then echoed as a meta entry);
/// the second record is the same notice. `None` when the record does not carry both
/// (`claudePeerId`).
pub(super) fn peer_id(entry: &Row) -> Option<String> {
    let origin = if field(entry, "type") == Some("attachment") {
        record(record(entry.get("attachment")).get("origin"))
    } else {
        record(entry.get("origin"))
    };
    let from = field(origin, "from").filter(|from| !from.is_empty())?;
    let message = field(origin, "msg_id").filter(|message| !message.is_empty())?;
    (field(origin, "kind") == Some("peer")).then(|| format!("{from}|{message}"))
}

/// The text of a Claude tool result: the string, or each part's `text` (`claudeResultText`).
pub(super) fn claude_result_text(output: Option<&Value>) -> String {
    match output {
        Some(Value::String(output)) => output.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|part| match part {
                Value::Object(part) => part
                    .get("text")
                    .map(|words| js_string(Some(words)))
                    .unwrap_or_default(),
                _ => String::new(),
            })
            .collect(),
        _ => String::new(),
    }
}
