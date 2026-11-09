//! A Claude Code transcript's text, split into turns (`parseClaudeTranscript`).

use std::collections::{HashMap, HashSet};

use protocol::js::{self, stringify_pretty};
use protocol::{ConversationPart, ConversationTurn, ImageRef, SkillStatus, ToolPart, TurnRole};
use serde_json::Value;

use super::text::{
    cap_notice, is_command_entry, js_string_or_empty, local_command_output, notice_text, truthy,
    unwrap_pastes, written_together,
};
use super::{claude_result_text, is_context_clear, peer_id, peer_notice};
use crate::records::{IMAGE_TYPES, Row, lines, parse_line, record, text, tool_input, tool_summary};
use crate::skill_activity::invoked_skill;
use crate::tool_output::trim_output;

/// Which kind of notice put a line in the user's seat.
const LOCAL_COMMAND: &str = "local-command";
const INFORMATIONAL: &str = "informational";

/// A turn, with a key that names it while turns are inserted before it and removed.
struct Slot {
    key: usize,
    turn: ConversationTurn,
}

/// The turns of one text, as they are built.
#[derive(Default)]
struct Turns {
    slots: Vec<Slot>,
    next_key: usize,
    /// tool parts still waiting for their result, by tool_use id: (turn key, part index)
    pending: HashMap<String, (usize, usize)>,
    /// the agent's last entry called a tool: its turn is not over, whatever is written meanwhile
    at_work: bool,
    /// the message whose reply ended (end_turn), and its turn: injected feedback can resume the
    /// model without a human prompt, and its next message is a new reply. Claude Code writes one
    /// message as several entries (its thinking, then its text), each with the message's stop
    /// reason: they stay one reply, also when a notice is written between them.
    completed: Option<(Option<Value>, usize)>,
}

impl Turns {
    fn new_turn(
        &mut self,
        role: TurnRole,
        ts: Option<String>,
        parts: Vec<ConversationPart>,
    ) -> Slot {
        let key = self.next_key;
        self.next_key += 1;
        Slot {
            key,
            turn: ConversationTurn {
                role,
                ts,
                end_ts: None,
                parts,
            },
        }
    }

    fn push(&mut self, role: TurnRole, ts: Option<String>, parts: Vec<ConversationPart>) {
        let slot = self.new_turn(role, ts, parts);
        self.slots.push(slot);
    }

    fn insert(&mut self, at: usize, ts: Option<String>, part: ConversationPart) {
        let slot = self.new_turn(TurnRole::User, ts, vec![part]);
        self.slots.insert(at, slot);
    }

    fn position(&self, key: usize) -> Option<usize> {
        self.slots.iter().rposition(|slot| slot.key == key)
    }

    /// Where a notice goes: before the turn at work it was written in, else at the end.
    fn notice_at(&self) -> usize {
        match self.slots.last() {
            Some(last) if self.at_work && last.turn.role == TurnRole::Assistant => {
                self.slots.len() - 1
            }
            _ => self.slots.len(),
        }
    }

    /// The turn before `at`, when there is one.
    fn before(&self, at: usize) -> Option<&ConversationTurn> {
        at.checked_sub(1)
            .and_then(|index| self.slots.get(index))
            .map(|slot| &slot.turn)
    }

    /// The turn an assistant entry adds to (`assistantTurn`): its message's reply when that one
    /// ended, the assistant turn at the end while no reply ended, else a new one.
    fn assistant_turn(&mut self, ts: Option<String>, id: Option<&Value>) -> usize {
        if let Some((completed_id, key)) = &self.completed
            && id.is_some_and(Value::is_string)
            && completed_id.as_ref() == id
            && let Some(at) = self.position(*key)
        {
            return at;
        }
        if self.completed.is_none()
            && self
                .slots
                .last()
                .is_some_and(|last| last.turn.role == TurnRole::Assistant)
        {
            return self.slots.len() - 1;
        }
        self.push(TurnRole::Assistant, ts, Vec::new());
        self.slots.len() - 1
    }

    fn clear(&mut self) {
        self.slots.clear();
        self.pending.clear();
    }

    fn tool(&mut self, (key, part): (usize, usize)) -> Option<&mut ToolPart> {
        let at = self.position(key)?;
        match self.slots[at].turn.parts.get_mut(part) {
            Some(ConversationPart::Tool(tool)) => Some(tool),
            _ => None,
        }
    }
}

/// The notice a turn is, when it is nothing else: its text and source.
fn lone_notice(turn: Option<&ConversationTurn>) -> Option<(&str, Option<&str>)> {
    match turn?.parts.as_slice() {
        [ConversationPart::Notice { text, source }] => Some((text, source.as_deref())),
        _ => None,
    }
}

/// Claude Code versions differ in where a refused command goes: a `local_command` answer, an
/// `informational` entry, and nothing says one never writes both. The same words from the other
/// kind, written together, are one answer; a notice repeating its own kind is kept.
fn said_by_other_kind(
    turn: Option<&ConversationTurn>,
    words: &str,
    ts: Option<&str>,
    kind: &str,
) -> bool {
    let Some((said, source)) = lone_notice(turn) else {
        return false;
    };
    if source == Some(kind) || !matches!(source, Some(LOCAL_COMMAND | INFORMATIONAL)) {
        return false;
    }
    written_together(turn.and_then(|turn| turn.ts.as_deref()), ts)
        && (said == words || said.split('\n').any(|line| line == words))
}

fn notice(text: String, source: &str) -> ConversationPart {
    ConversationPart::Notice {
        text,
        source: Some(source.to_owned()),
    }
}

fn text_part(text: String) -> ConversationPart {
    ConversationPart::Text { text, phase: None }
}

/// Splits one transcript text into turns. Adjacent assistant entries merge into a single turn
/// (text parts + tool parts); each tool_use is followed by a user tool_result entry, which is
/// folded into the tool part it answers. `peers_seen`: the deliveries of other sessions' messages
/// an earlier part of the same page read (a page is parsed in parts), so an echo in a later part
/// is no second notice.
pub(super) fn parse_claude_transcript(
    text_of_page: &str,
    peers_seen: &mut HashSet<String>,
) -> Vec<ConversationTurn> {
    let mut turns = Turns::default();
    for line in lines(text_of_page) {
        if js::trim(line).is_empty() {
            continue;
        }
        // a torn tail line while Claude is mid-append
        let Some(Value::Object(entry)) = parse_line(line) else {
            continue;
        };
        read_entry(&mut turns, &entry, peers_seen);
    }
    turns
        .slots
        .into_iter()
        .map(|slot| slot.turn)
        .filter(|turn| !turn.parts.is_empty())
        .collect()
}

fn read_entry(turns: &mut Turns, entry: &Row, peers_seen: &mut HashSet<String>) {
    let ts = text(entry, "timestamp").map(str::to_owned);
    // another session's message: its own turn, so the work it started is not appended to the
    // answer before it
    if let Some(peer) = peer_notice(entry) {
        if let Some(id) = peer_id(entry)
            && !peers_seen.insert(id)
        {
            return;
        }
        turns.push(TurnRole::User, ts, vec![peer]);
        return;
    }
    if truthy(entry.get("isMeta")) {
        return;
    }
    if is_context_clear(entry) {
        turns.clear();
        return;
    }
    let message = record(entry.get("message"));
    let content = message.get("content");
    let kind = text(entry, "type");

    // a compaction's summary marks where the conversation was folded, readable on request
    if truthy(entry.get("isCompactSummary")) {
        let summary = match content {
            Some(Value::String(summary)) => summary.clone(),
            Some(Value::Array(blocks)) => blocks
                .iter()
                .map(|block| {
                    let block = record(Some(block));
                    if text(block, "type") == Some("text") {
                        js_string_or_empty(block.get("text"))
                    } else {
                        String::new()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };
        turns.push(
            TurnRole::User,
            ts,
            vec![ConversationPart::Compact { text: summary }],
        );
        return;
    }

    // A message sent while Claude is working is no `user` entry: it is queued, then recorded as
    // this attachment when the turn takes it in. Background task notices and other agents'
    // messages use the same record, so only a person's prompt counts. The `queue-operation` lines
    // around it repeat the text and are skipped.
    if kind == Some("attachment") {
        let queued = record(entry.get("attachment"));
        if text(queued, "type") == Some("queued_command")
            && text(queued, "commandMode") == Some("prompt")
            && text(record(queued.get("origin")), "kind") == Some("human")
        {
            if let Some(prompt) = text(queued, "prompt") {
                let trimmed = js::trim(prompt);
                if !trimmed.is_empty() && !is_command_entry(trimmed) {
                    turns.push(TurnRole::User, ts, vec![text_part(unwrap_pastes(prompt))]);
                }
            }
            return;
        }
    }

    // A slash command answers in the terminal, not through the model: a refused /goal says why
    // only here. It is the runtime speaking in the user's seat, so it reads as a notice.
    if kind == Some("system") && text(entry, "subtype") == Some("local_command") {
        let output = local_command_output(entry.get("content"));
        let at = turns.notice_at();
        if !output.is_empty()
            && !said_by_other_kind(turns.before(at), &output, ts.as_deref(), LOCAL_COMMAND)
        {
            turns.insert(at, ts, notice(output, LOCAL_COMMAND));
        }
        return;
    }

    // Claude Code's own notices: an unknown slash command and the arguments it dropped, a usage
    // limit reached or reset. The message that drew one is not recorded, so without it a refused
    // command just vanished from the chat. Lines written together read as one notice. Claude Code
    // also writes them while the agent works; such a notice does not end the turn: it goes before
    // the turn it was written in, so the turn stays whole and stays the last one, which is what
    // the chat reads as the turn still running.
    if kind == Some("system") && text(entry, "subtype") == Some("informational") {
        let words = text(entry, "content").map(notice_text).unwrap_or_default();
        if words.is_empty() {
            return;
        }
        let at = turns.notice_at();
        let before = turns.before(at);
        if said_by_other_kind(before, &words, ts.as_deref(), INFORMATIONAL) {
            return;
        }
        let joined = match lone_notice(before) {
            Some((said, Some(INFORMATIONAL)))
                if written_together(before.and_then(|turn| turn.ts.as_deref()), ts.as_deref()) =>
            {
                Some(cap_notice(&format!("{said}\n{words}")))
            }
            _ => None,
        };
        match joined {
            Some(joined) => turns.slots[at - 1].turn.parts = vec![notice(joined, INFORMATIONAL)],
            None => turns.insert(at, ts, notice(words, INFORMATIONAL)),
        }
        return;
    }

    if kind == Some("user") {
        match content {
            Some(Value::String(prompt)) => {
                if !is_command_entry(prompt) {
                    turns.push(TurnRole::User, ts, vec![text_part(unwrap_pastes(prompt))]);
                }
            }
            Some(Value::Array(blocks)) => read_user_blocks(turns, entry, blocks, ts),
            _ => {}
        }
        return;
    }

    if kind == Some("assistant")
        && let Some(Value::Array(blocks)) = content
    {
        read_assistant_blocks(turns, entry, message, blocks, ts);
    }
}

/// A user entry with blocks: its prompt, the tool results it folds into their calls, and the
/// images pasted into it.
fn read_user_blocks(turns: &mut Turns, entry: &Row, blocks: &[Value], ts: Option<String>) {
    let prompt = blocks
        .iter()
        .filter_map(|block| {
            let block = record(Some(block));
            let words = text(block, "text")?;
            (text(block, "type") == Some("text") && !is_command_entry(js::trim(words)))
                .then_some(words)
        })
        .collect::<Vec<_>>()
        .join("\n");
    for block in blocks {
        let Value::Object(result) = block else {
            continue;
        };
        let Some(id) = text(result, "tool_use_id") else {
            continue;
        };
        if text(result, "type") != Some("tool_result") {
            continue;
        }
        let Some(place) = turns.pending.remove(id) else {
            continue;
        };
        let failed = result.get("is_error") == Some(&Value::Bool(true));
        if let Some(tool) = turns.tool(place) {
            trim_output(tool, &claude_result_text(result.get("content")), id);
            if failed {
                tool.error = Some(true);
            }
            if let Some(skill) = &mut tool.skill {
                skill.status = if failed {
                    SkillStatus::Failed
                } else {
                    SkillStatus::Loaded
                };
            }
        }
    }
    // an image pasted into the prompt: named here, fetched only when shown
    let mut parts: Vec<ConversationPart> = match text(entry, "uuid") {
        Some(uuid) => blocks
            .iter()
            .enumerate()
            .filter_map(|(index, block)| {
                let block = record(Some(block));
                let source = record(block.get("source"));
                let media_type = text(source, "media_type")?;
                (text(block, "type") == Some("image")
                    && text(source, "type") == Some("base64")
                    && IMAGE_TYPES.contains(&media_type))
                .then(|| {
                    ConversationPart::Image(ImageRef {
                        media_type: media_type.to_owned(),
                        reference: format!("{uuid}:{index}"),
                    })
                })
            })
            .collect(),
        None => Vec::new(),
    };
    let has_prompt = !js::trim(&prompt).is_empty();
    if has_prompt {
        parts.push(text_part(unwrap_pastes(&prompt)));
    }
    if !parts.is_empty() {
        turns.push(TurnRole::User, ts, parts);
    }
}

/// An assistant entry's blocks, added to the turn it belongs to.
fn read_assistant_blocks(
    turns: &mut Turns,
    entry: &Row,
    message: &Row,
    blocks: &[Value],
    ts: Option<String>,
) {
    let at = turns.assistant_turn(ts.clone(), message.get("id"));
    let key = turns.slots[at].key;
    // an entry that names no stop reason is still at work when it calls a tool
    let stop = message.get("stop_reason");
    let stopped = |reason: &str| stop.and_then(Value::as_str) == Some(reason);
    turns.completed = stopped("end_turn").then(|| (message.get("id").cloned(), key));
    let calls_tool = blocks
        .iter()
        .any(|block| text(record(Some(block)), "type") == Some("tool_use"));
    turns.at_work = stopped("tool_use") || (stop.is_none_or(Value::is_null) && calls_tool);
    let thinking_as_updates = text(entry, "thinkingDisplay") == Some("updates");
    let mut new_pending = Vec::new();
    let turn = &mut turns.slots[at].turn;
    if let Some(ts) = ts.filter(|ts| !ts.is_empty()) {
        turn.end_ts = Some(ts);
    }
    for block in blocks {
        let Value::Object(block) = block else {
            continue;
        };
        match text(block, "type") {
            Some("text") => {
                if let Some(words) = text(block, "text").filter(|words| !words.is_empty()) {
                    turn.parts.push(text_part(words.to_owned()));
                }
            }
            Some("thinking") => {
                let thinking = text(block, "thinking")
                    .or_else(|| text(block, "text"))
                    .unwrap_or("");
                // the terminal prints an "updates" entry's thinking as narration between the
                // tools, so it is read as that: commentary keeps it in the work block, never
                // taken for the answer
                if !js::trim(thinking).is_empty() && thinking_as_updates {
                    turn.parts.push(ConversationPart::Text {
                        text: thinking.to_owned(),
                        phase: Some(protocol::TextPhase::Commentary),
                    });
                } else if !thinking.is_empty() {
                    turn.parts.push(ConversationPart::Thinking {
                        text: thinking.to_owned(),
                    });
                }
            }
            Some("tool_use") => {
                let Some(name) = text(block, "name") else {
                    continue;
                };
                let input = tool_input(block.get("input"));
                let mut part = ToolPart {
                    name: name.to_owned(),
                    summary: tool_summary(name, &input),
                    input: stringify_pretty(&input),
                    output: String::new(),
                    error: None,
                    skill: None,
                    output_ref: None,
                    output_size: None,
                    images: None,
                };
                if let Some(skill) = invoked_skill(name, &input) {
                    part.summary = skill.name.clone();
                    part.skill = Some(skill);
                }
                turn.parts.push(ConversationPart::Tool(part));
                new_pending.push((
                    js_string_or_empty(block.get("id")),
                    (key, turn.parts.len() - 1),
                ));
            }
            // unsupported transcript blocks are intentionally ignored
            _ => {}
        }
    }
    turns.pending.extend(new_pending);
}
