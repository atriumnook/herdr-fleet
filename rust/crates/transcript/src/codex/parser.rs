//! A Codex rollout's records as turns (`createCodexTranscriptParser` of `server/codex.ts`).
//! Rollouts hold both display events and model context: only conversation records belong in the
//! chat; developer prompts and terminal chrome do not. Codex records most messages twice, once as
//! an event and once as a response item, and the second of a pair is folded into the first.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::LazyLock;

use protocol::js::{self, WHITESPACE, cut_utf16};
use protocol::{
    ConversationPart, ConversationTurn, ImageRef, SkillStatus, TextPhase, ToolPart, TurnRole,
    patch_files, patch_text,
};
use regex::Regex;
use serde_json::{Map, Value};

use super::images::image_parts;
use super::memory::without_memory_citations;
use super::skills::{codex_read_call, codex_read_skills};
use crate::js_json::stringify_pretty;
use crate::records::{Row, lines, parse_line, record};
use crate::skill_activity::selected_skill;
use crate::tool_output::trim_output;

/// A string field, or "" (TypeScript's `string(value)`).
pub(super) fn string<'a>(row: &'a Row, field: &str) -> &'a str {
    row.get(field).and_then(Value::as_str).unwrap_or("")
}

/// Whether JavaScript reads a JSON value as true: not missing, null, false, 0 or "".
pub(super) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(number)) => number.as_f64() != Some(0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

static AGENTS_CONTEXT: LazyLock<Regex> = LazyLock::new(|| {
    let s = WHITESPACE;
    Regex::new(&format!(
        r"^# AGENTS\.md instructions(?: for [^\r\n]+)?\r?\n{s}*<INSTRUCTIONS>(?s:.)*</INSTRUCTIONS>(?:{s}*<environment_context>(?s:.)*</environment_context>)?$"
    ))
    .expect("AGENTS_CONTEXT")
});

/// The envelopes Codex puts in the user's seat for the model alone.
const CONTEXT_TAGS: [&str; 4] = [
    "environment_context",
    "permissions instructions",
    "turn_aborted",
    "subagent_notification",
];

/// Whether a user message is context Codex injected, not something the user wrote.
fn context_only(text: &str) -> bool {
    let value = js::trim(text);
    AGENTS_CONTEXT.is_match(value)
        || CONTEXT_TAGS.iter().any(|tag| {
            let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
            value.len() >= open.len() + close.len()
                && value.starts_with(&open)
                && value.ends_with(&close)
        })
}

static QUESTION_REPLY: LazyLock<Regex> = LazyLock::new(|| {
    let s = WHITESPACE;
    Regex::new(&format!(
        r"^<send_user_message_question_reply>{s}*((?s:.)*?){s}*</send_user_message_question_reply>$"
    ))
    .expect("QUESTION_REPLY")
});

/// The JSON list inside an answer to Codex's queued questions
/// (`<send_user_message_question_reply>`), or `None` for any other message.
pub(super) fn question_reply_items(text: &str) -> Option<&str> {
    Some(QUESTION_REPLY.captures(js::trim(text))?.get(1)?.as_str())
}

/// An answer to Codex's queued questions (request_user_input_async) reaches the model as a user
/// message: a JSON list of {answer, question, questionItemId} inside
/// `<send_user_message_question_reply>`. The chat shows what was answered, not the envelope.
fn question_reply(text: &str) -> Option<String> {
    let items: Value = serde_json::from_str(question_reply_items(text)?).ok()?;
    let answers: Vec<&str> = items
        .as_array()?
        .iter()
        .map(|item| js::trim(string(record(Some(item)), "answer")))
        .filter(|answer| !answer.is_empty())
        .collect();
    (!answers.is_empty()).then(|| answers.join("\n"))
}

/// The questions of a request_user_input(_async) call: `title` (async) or `question` (plan mode).
fn question_titles(args: &Row) -> Vec<&str> {
    let Some(questions) = args.get("questions").and_then(Value::as_array) else {
        return Vec::new();
    };
    questions
        .iter()
        .map(|question| {
            let question = record(Some(question));
            match string(question, "title") {
                "" => string(question, "question"),
                title => title,
            }
        })
        .filter(|title| !title.is_empty())
        .collect()
}

static IMAGE_OPENING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^<image name=\[Image #[0-9]+\](?: path="[^"\r\n]+")?>$"#).expect("IMAGE_OPENING")
});

const IMAGE_TYPES: [&str; 2] = ["input_image", "local_image"];
const TEXT_TYPES: [&str; 4] = ["input_text", "output_text", "text", "summary_text"];

/// A message's or a tool output's text as Codex recorded it: a string, or the text of each part.
/// `user`: leave out the context Codex injected and the envelope around a pasted image.
pub(super) fn content_text(value: Option<&Value>, user: bool) -> String {
    let parts = match value {
        Some(Value::String(text)) => {
            return if user && context_only(text) {
                String::new()
            } else {
                text.clone()
            };
        }
        Some(Value::Array(parts)) => parts,
        _ => return String::new(),
    };
    let type_at =
        |index: Option<usize>| string(record(index.and_then(|index| parts.get(index))), "type");
    let mut texts = Vec::new();
    for (index, raw) in parts.iter().enumerate() {
        let part = record(Some(raw));
        let kind = string(part, "type");
        let text = string(part, "text");
        let image_envelope = user
            && kind == "input_text"
            && ((IMAGE_OPENING.is_match(text) && IMAGE_TYPES.contains(&type_at(Some(index + 1))))
                || (text == "</image>" && IMAGE_TYPES.contains(&type_at(index.checked_sub(1)))));
        if image_envelope {
            continue;
        }
        if let Some(Value::String(text)) = part.get("text")
            && TEXT_TYPES.contains(&kind)
            && !(user && context_only(text))
        {
            texts.push(text.as_str());
        }
    }
    texts.join("\n")
}

/// A line of `head` as the `m` flag reads one: split at every line terminator.
fn head_lines(head: &str) -> impl Iterator<Item = &str> {
    head.split(js::is_line_terminator)
}

/// Whether a line starts with `word` followed by a word boundary (`/^word\b/`).
fn starts_with_word(line: &str, word: &str) -> bool {
    line.strip_prefix(word).is_some_and(|rest| {
        !rest
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    })
}

static EXIT_CODE_JSON: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r#""exit_code":{WHITESPACE}*([0-9]+)"#)).expect("EXIT_CODE_JSON")
});

/// The exit code a line states (`/^(?:Process exited with code|Exit code:) (\d+)$/`).
fn exit_code_line(line: &str) -> Option<&str> {
    let code = line
        .strip_prefix("Process exited with code ")
        .or_else(|| line.strip_prefix("Exit code: "))?;
    (!code.is_empty() && code.bytes().all(|byte| byte.is_ascii_digit())).then_some(code)
}

/// Whether a Codex tool output says the call failed. Codex records no flag: its command runner
/// writes the exit code into the output, and a script or patch its own verdict. A script that
/// completed is judged as a whole, however its commands went.
pub(super) fn call_failed(output: &str) -> bool {
    let head = cut_utf16(output, 2000);
    if head_lines(head).any(|line| starts_with_word(line, "Script completed")) {
        return false;
    }
    if head_lines(head).any(|line| starts_with_word(line, "Script failed"))
        || head.contains("apply_patch verification failed")
    {
        return true;
    }
    let code = head_lines(head).find_map(exit_code_line).or_else(|| {
        EXIT_CODE_JSON
            .captures(head)
            .and_then(|found| found.get(1))
            .map(|code| code.as_str())
    });
    code.is_some_and(|code| code != "0")
}

/// `Date.parse` for the date-time format of ECMAScript (`YYYY-MM-DDTHH:mm:ss.sssZ` and its
/// shorter forms), in milliseconds since the epoch; `None` for any other text, which JavaScript
/// reads as NaN or by rules of its own. A time without an offset is read as UTC where JavaScript
/// reads local time: only the distance between two timestamps is used, which the offset does not
/// change (but across a daylight-saving change). Codex writes every timestamp in UTC (`Z`).
fn date_parse(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let mut at = 0;
    // `count` digits at `at`
    let digits = |at: &mut usize, count: usize| -> Option<i64> {
        let field = bytes.get(*at..*at + count)?;
        if !field.iter().all(u8::is_ascii_digit) {
            return None;
        }
        *at += count;
        std::str::from_utf8(field).ok()?.parse().ok()
    };
    // `separator` and two digits after it; `Some(None)` when the separator is not there
    let next = |at: &mut usize, separator: u8| -> Option<Option<i64>> {
        if bytes.get(*at) != Some(&separator) {
            return Some(None);
        }
        *at += 1;
        digits(at, 2).map(Some)
    };
    let year = match bytes.first()? {
        b'+' => {
            at = 1;
            digits(&mut at, 6)?
        }
        b'-' => {
            at = 1;
            match digits(&mut at, 6)? {
                0 => return None,
                year => -year,
            }
        }
        _ => digits(&mut at, 4)?,
    };
    let (month, day) = match next(&mut at, b'-')? {
        Some(month) => (month, next(&mut at, b'-')?.unwrap_or(1)),
        None => (1, 1),
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (mut hour, mut minute, mut second, mut millis, mut offset) = (0, 0, 0, 0, 0);
    if bytes.get(at) == Some(&b'T') {
        at += 1;
        hour = digits(&mut at, 2)?;
        minute = next(&mut at, b':')??;
        if let Some(seconds) = next(&mut at, b':')? {
            second = seconds;
            if bytes.get(at) == Some(&b'.') {
                at += 1;
                let run = bytes[at..]
                    .iter()
                    .take_while(|b| b.is_ascii_digit())
                    .count();
                if run == 0 {
                    return None;
                }
                // only the milliseconds count
                let mut fraction = text[at..at + run.min(3)].to_owned();
                while fraction.len() < 3 {
                    fraction.push('0');
                }
                millis = fraction.parse().ok()?;
                at += run;
            }
        }
        match bytes.get(at) {
            Some(b'Z') => at += 1,
            Some(sign @ (b'+' | b'-')) => {
                let sign = if *sign == b'-' { -1 } else { 1 };
                at += 1;
                let hours = digits(&mut at, 2)?;
                let minutes = next(&mut at, b':')??;
                if hours > 23 || minutes > 59 {
                    return None;
                }
                offset = sign * (hours * 60 + minutes);
            }
            _ => {}
        }
        let midnight = hour == 24 && minute == 0 && second == 0 && millis == 0;
        if (hour > 23 && !midnight) || minute > 59 || second > 59 {
            return None;
        }
    }
    if at != bytes.len() {
        return None;
    }
    // days from the civil date (Howard Hinnant's algorithm); a day past the month's end runs on
    // into the next month, as JavaScriptCore reads it
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let seconds = ((days * 24 + hour) * 60 + minute - offset) * 60 + second;
    let time = seconds * 1000 + millis;
    // TimeClip: a time past 8.64e15 ms either way is NaN
    (time.abs() <= 8_640_000_000_000_000).then_some(time as f64)
}

/// A message of the last few, kept to fold the second record of a pair into the first.
struct Message {
    role: TurnRole,
    text: String,
    source: &'static str,
    ts: String,
    paired: bool,
    turn: usize,
    /// the text part's place in an assistant turn; a user message's phase is never set
    part: Option<usize>,
}

/// The parse of one run of records, folded record by record.
#[derive(Default)]
pub(super) struct Parser {
    turns: Vec<ConversationTurn>,
    /// tool parts still waiting for their output, by call id: (turn, part)
    tools: HashMap<String, (usize, usize)>,
    messages: VecDeque<Message>,
    /// when the running task started; "" when none runs
    started_at: String,
    /// the completed items whose skill reads were taken, the oldest first
    skill_events: (HashSet<String>, VecDeque<String>),
    active_turn_id: Option<String>,
}

/// How many recent messages a pair is looked for in.
const PAIR_WINDOW: usize = 8;
/// How many completed items' skill reads are remembered.
const SKILL_EVENTS: usize = 512;

/// The turns of `text`, the turns that hold nothing left out (`parseCodexTranscript`).
pub(super) fn parse(text: &str) -> Vec<ConversationTurn> {
    let mut parser = Parser::default();
    parser.write(text);
    parser
        .turns
        .into_iter()
        .filter(|turn| !turn.parts.is_empty())
        .collect()
}

fn phase(payload: &Row) -> Option<TextPhase> {
    match string(payload, "phase") {
        "commentary" => Some(TextPhase::Commentary),
        "final_answer" => Some(TextPhase::FinalAnswer),
        _ => None,
    }
}

impl Parser {
    /// The assistant turn records now belong to: the last turn, or a new one.
    fn assistant(&mut self, ts: &str) -> usize {
        if self.turns.last().map(|turn| turn.role) != Some(TurnRole::Assistant) {
            let start = [self.started_at.as_str(), ts]
                .into_iter()
                .find(|value| !value.is_empty());
            self.turns.push(ConversationTurn {
                role: TurnRole::Assistant,
                ts: start.map(str::to_owned),
                end_ts: None,
                parts: Vec::new(),
            });
        }
        let last = self.turns.len() - 1;
        if !ts.is_empty() {
            self.turns[last].end_ts = Some(ts.to_owned());
        }
        last
    }

    /// Ends the last turn at `ts`, when it is the assistant's.
    fn end_at(&mut self, ts: &str) {
        if let Some(turn) = self.turns.last_mut()
            && turn.role == TurnRole::Assistant
            && !ts.is_empty()
        {
            turn.end_ts = Some(ts.to_owned());
        }
    }

    fn message(
        &mut self,
        role: TurnRole,
        text: String,
        source: &'static str,
        ts: &str,
        phase: Option<TextPhase>,
        images: Vec<ImageRef>,
    ) {
        let body = match role {
            TurnRole::User => question_reply(&text).unwrap_or(text),
            TurnRole::Assistant => without_memory_citations(&text),
        };
        let blank = js::trim(&body).is_empty();
        if blank && images.is_empty() {
            return;
        }
        let at = date_parse(ts);
        let duplicate = self.messages.iter_mut().rev().find(|other| {
            !other.paired
                && other.role == role
                && other.text == body
                && other.source != source
                && (other.ts == ts
                    || matches!((date_parse(&other.ts), at), (Some(a), Some(b)) if (a - b).abs() <= 1000.0))
        });
        if let Some(duplicate) = duplicate {
            duplicate.paired = true;
            let turn = &mut self.turns[duplicate.turn];
            if let (Some(phase), Some(part)) = (phase, duplicate.part)
                && let Some(ConversationPart::Text { phase: shown, .. }) = turn.parts.get_mut(part)
            {
                *shown = Some(phase);
            }
            // Prefer the event's local paths over a response's inline copies of the same images.
            let has_images = turn
                .parts
                .iter()
                .any(|part| matches!(part, ConversationPart::Image(_)));
            if !images.is_empty() && (source == "event" || !has_images) {
                let rest = std::mem::take(&mut turn.parts)
                    .into_iter()
                    .filter(|part| !matches!(part, ConversationPart::Image(_)));
                turn.parts = images
                    .into_iter()
                    .map(ConversationPart::Image)
                    .chain(rest)
                    .collect();
            }
            return;
        }
        let part = ConversationPart::Text {
            text: body.clone(),
            phase,
        };
        let (turn, part) = match role {
            TurnRole::User => {
                let mut parts: Vec<ConversationPart> =
                    images.into_iter().map(ConversationPart::Image).collect();
                if !blank {
                    parts.push(part);
                }
                self.turns.push(ConversationTurn {
                    role,
                    ts: (!ts.is_empty()).then(|| ts.to_owned()),
                    end_ts: None,
                    parts,
                });
                (self.turns.len() - 1, None)
            }
            TurnRole::Assistant => {
                let turn = self.assistant(ts);
                self.turns[turn].parts.push(part);
                (turn, Some(self.turns[turn].parts.len() - 1))
            }
        };
        self.messages.push_back(Message {
            role,
            text: body,
            source,
            ts: ts.to_owned(),
            paired: false,
            turn,
            part,
        });
        if self.messages.len() > PAIR_WINDOW {
            self.messages.pop_front();
        }
    }

    pub(super) fn write(&mut self, text: &str) {
        for line in lines(text) {
            let Some(Value::Object(entry)) = parse_line(line) else {
                continue;
            };
            let payload = record(entry.get("payload"));
            let ts = string(&entry, "timestamp");
            match string(&entry, "type") {
                "event_msg" => self.event(&entry, payload, ts),
                "response_item" => self.response_item(&entry, payload, ts),
                _ => {}
            }
        }
    }

    fn event(&mut self, entry: &Row, payload: &Row, ts: &str) {
        let kind = string(payload, "type");
        let turn_id = payload.get("turn_id");
        if kind == "item_completed"
            && (self.active_turn_id.is_none()
                || !truthy(turn_id)
                || turn_id.and_then(Value::as_str) == self.active_turn_id.as_deref())
        {
            self.skill_reads(payload.get("item"), ts);
        }
        match kind {
            "task_started" => {
                self.started_at = match string(payload, "started_at") {
                    "" => ts,
                    started => started,
                }
                .to_owned();
                self.active_turn_id = Some(string(payload, "turn_id"))
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned);
            }
            "task_complete" | "turn_aborted" => {
                self.end_at(ts);
                self.started_at.clear();
            }
            "user_message"
                if !truthy(payload.get("kind")) || string(payload, "kind") == "plain" =>
            {
                let text = content_text(payload.get("message"), true);
                self.message(TurnRole::User, text, "event", ts, None, image_parts(entry));
            }
            "agent_message" => {
                let text = content_text(payload.get("message"), false);
                self.message(
                    TurnRole::Assistant,
                    text,
                    "event",
                    ts,
                    phase(payload),
                    Vec::new(),
                );
            }
            _ => {}
        }
    }

    /// The skills a completed command read, once per item.
    fn skill_reads(&mut self, item: Option<&Value>, ts: &str) {
        let id = string(record(item), "id");
        let skills = codex_read_skills(item.unwrap_or(&Value::Null));
        let (seen, order) = &mut self.skill_events;
        if id.is_empty() || skills.is_empty() || seen.contains(id) {
            return;
        }
        seen.insert(id.to_owned());
        order.push_back(id.to_owned());
        if order.len() > SKILL_EVENTS
            && let Some(oldest) = order.pop_front()
        {
            seen.remove(&oldest);
        }
        for skill in skills {
            let turn = self.assistant(ts);
            let parts = &mut self.turns[turn].parts;
            let existing = parts.iter_mut().rev().find_map(|part| match part {
                ConversationPart::Tool(tool)
                    if tool.skill.as_ref().and_then(|known| known.path.as_ref())
                        == skill.path.as_ref() =>
                {
                    Some(tool)
                }
                _ => None,
            });
            match existing.and_then(|tool| tool.skill.as_mut()) {
                Some(known) => known.status = skill.status,
                None => parts.push(ConversationPart::Skill { skill }),
            }
        }
    }

    fn response_item(&mut self, entry: &Row, payload: &Row, ts: &str) {
        match string(payload, "type") {
            "message" => match string(payload, "role") {
                "user" => self.user_response(entry, payload, ts),
                "assistant" => {
                    let body = content_text(payload.get("content"), false);
                    if string(payload, "channel") == "analysis" {
                        self.thinking(body, ts);
                    } else if !truthy(payload.get("recipient"))
                        || string(payload, "recipient") == "all"
                    {
                        self.message(
                            TurnRole::Assistant,
                            body,
                            "response",
                            ts,
                            phase(payload),
                            Vec::new(),
                        );
                    }
                }
                _ => {}
            },
            "reasoning" => {
                let body = content_text(payload.get("summary"), false);
                self.thinking(body, ts);
            }
            kind @ ("function_call" | "custom_tool_call") => self.tool_call(kind, payload, ts),
            "function_call_output" | "custom_tool_call_output" => self.tool_output(payload, ts),
            _ => {}
        }
    }

    fn thinking(&mut self, body: String, ts: &str) {
        if !js::trim(&body).is_empty() {
            let turn = self.assistant(ts);
            self.turns[turn]
                .parts
                .push(ConversationPart::Thinking { text: body });
        }
    }

    fn user_response(&mut self, entry: &Row, payload: &Row, ts: &str) {
        let content = match payload.get("content") {
            Some(Value::Array(blocks)) => blocks.clone(),
            other => vec![serde_json::json!({
                "type": "input_text",
                "text": other.cloned().unwrap_or(Value::Null),
            })],
        };
        let selected = |block: &Value| selected_skill(string(record(Some(block)), "text"));
        let skills: Vec<_> = content.iter().filter_map(selected).collect();
        let visible: Vec<Value> = content
            .iter()
            .filter(|block| selected(block).is_none())
            .cloned()
            .collect();
        let text = content_text(Some(&Value::Array(visible)), true);
        self.message(
            TurnRole::User,
            text,
            "response",
            ts,
            None,
            image_parts(entry),
        );
        for skill in skills {
            let turn = self.assistant(ts);
            let parts = &mut self.turns[turn].parts;
            let shown = parts.iter().any(|part| {
                matches!(part, ConversationPart::Skill { skill: known }
                    if known.name == skill.name && known.path == skill.path)
            });
            if !shown {
                parts.push(ConversationPart::Skill { skill });
            }
        }
    }

    fn tool_call(&mut self, kind: &str, payload: &Row, ts: &str) {
        let name = match string(payload, "name") {
            "" => "tool",
            name => name,
        };
        let raw = payload.get(if kind == "function_call" {
            "arguments"
        } else {
            "input"
        });
        let args: Map<String, Value> = match raw {
            Some(Value::Object(args)) => args.clone(),
            // freeform tool input stays as it was written
            Some(Value::String(text)) => match parse_line(text) {
                Some(Value::Object(args)) => args,
                _ => Map::new(),
            },
            _ => Map::new(),
        };
        let raw_text = raw.and_then(Value::as_str);
        // a patch, bare or in an exec script, is summed up by the files it touches
        let files = raw_text
            .and_then(patch_text)
            .map(|patch| patch_files(&patch))
            .unwrap_or_default();
        let titles = question_titles(&args);
        let summary = if !files.is_empty() {
            files.join(", ")
        } else if name.starts_with("request_user_input") && !titles.is_empty() {
            titles.join(" · ")
        } else {
            [
                "cmd",
                "command",
                "file_path",
                "path",
                "pattern",
                "description",
                "url",
            ]
            .iter()
            .find_map(|field| args.get(*field).and_then(Value::as_str))
            .unwrap_or("")
            .to_owned()
        };
        let summary = if summary.is_empty() { name } else { &summary };
        let args = Value::Object(args);
        let input = match &args {
            Value::Object(fields) if !fields.is_empty() => stringify_pretty(&args),
            _ => raw_text.unwrap_or("").to_owned(),
        };
        let part = ToolPart {
            name: name.to_owned(),
            summary: cut_utf16(summary, 120).to_owned(),
            input,
            output: String::new(),
            error: None,
            skill: codex_read_call(name, &args),
            output_ref: None,
            output_size: None,
            images: None,
        };
        let turn = self.assistant(ts);
        let parts = &mut self.turns[turn].parts;
        parts.push(ConversationPart::Tool(part));
        if let Some(call_id) = payload.get("call_id").and_then(Value::as_str) {
            self.tools
                .insert(call_id.to_owned(), (turn, parts.len() - 1));
        }
    }

    fn tool_output(&mut self, payload: &Row, ts: &str) {
        let call_id = string(payload, "call_id");
        let Some((turn, part)) = self.tools.remove(call_id) else {
            return;
        };
        if let Some(ConversationPart::Tool(tool)) = self.turns[turn].parts.get_mut(part) {
            let output = content_text(payload.get("output"), false);
            trim_output(tool, &output, call_id);
            if call_failed(&output) {
                tool.error = Some(true);
            }
            let failed = tool.error == Some(true);
            if let Some(skill) = tool.skill.as_mut() {
                skill.status = if failed {
                    SkillStatus::Failed
                } else {
                    SkillStatus::Loaded
                };
            }
        }
        self.end_at(ts);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values: Bun 1.4.4 `Date.parse` of the same texts.
    #[test]
    fn reads_timestamps_as_date_parse_does() {
        let cases: [(&str, Option<f64>); 21] = [
            ("1970-01-01T00:00:00Z", Some(0.0)),
            ("2026-05-01T10:00:00.123Z", Some(1_777_629_600_123.0)),
            ("2026-05-01T10:00:00.5Z", Some(1_777_629_600_500.0)),
            ("2026-05-01T12:00:00+02:00", Some(1_777_629_600_000.0)),
            ("2026-05-01", Some(1_777_593_600_000.0)),
            ("", None),
            ("2026-13-01T00:00:00Z", None),
            ("yesterday", None),
            ("2026-05-01T10:00:00.123456Z", Some(1_777_629_600_123.0)),
            ("2026-05-01T24:00:00Z", Some(1_777_680_000_000.0)),
            ("2026-05", Some(1_777_593_600_000.0)),
            ("2026", Some(1_767_225_600_000.0)),
            ("+002026-05-01T00:00:00Z", Some(1_777_593_600_000.0)),
            ("2026-05-01T10:00Z", Some(1_777_629_600_000.0)),
            ("2026-02-30T00:00:00Z", Some(1_772_409_600_000.0)),
            ("+275760-09-13T00:00:00.000Z", Some(8_640_000_000_000_000.0)),
            ("+275760-09-13T00:00:00.001Z", None),
            ("-271821-04-20T00:00:00Z", Some(-8_640_000_000_000_000.0)),
            ("-271821-04-19T23:59:59Z", None),
            ("2026-05-01T24:00:00.500Z", None),
            ("-000000-01-01T00:00:00Z", None),
        ];
        for (text, expected) in cases {
            assert_eq!(date_parse(text), expected, "Date.parse({text:?})");
        }
    }

    // Expected values: the TypeScript `codexCallFailed` of the same outputs (Bun 1.4.4).
    #[test]
    fn reads_a_failure_from_the_output() {
        assert!(call_failed("Process exited with code 1\nOutput:"));
        assert!(!call_failed("Exit code: 0\n"));
        assert!(call_failed("{\"exit_code\": 2}"));
        assert!(!call_failed("Script completed\nProcess exited with code 1"));
        assert!(call_failed("x\nScript failed: boom"));
        assert!(!call_failed("Script completedly"));
        assert!(!call_failed("plain output"));
    }
}
