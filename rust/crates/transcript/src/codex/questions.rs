//! The questions a rollout asked with request_user_input_async and holds no answer for
//! (`unansweredCodexQuestions` of `server/codex.ts`), oldest first. A question skipped in the TUI
//! leaves no record, so a caller takes as many of the newest as the TUI shows waiting. Only bytes
//! appended since the last call are read (the first call reads the last 4 MiB), and only lines
//! naming the tool are parsed.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use protocol::QueuedQuestion;
use serde_json::Value;

use super::parser::{content_text, question_reply_items, string};
use crate::paging::file_stat;
use crate::records::{lines, parse_line, record};

const QUESTION_SCAN_BYTES: u64 = 4 * 1024 * 1024;
const REMEMBERED_SCANS: usize = 16;
const TOOL: &str = "request_user_input_async";

/// How far a rollout was read, the questions asked and the ones answered since.
#[derive(Clone)]
struct Scan {
    /// the file the scan read: another file in its place is read afresh
    node: String,
    size: u64,
    /// the scan started inside the file: its first line read is a part of a line
    cut: bool,
    asked: Vec<QueuedQuestion>,
    answered: HashSet<String>,
}

/// The scans kept between calls, by rollout, the least recently used first.
pub(super) struct Questions {
    scans: Mutex<Vec<(PathBuf, Scan)>>,
}

/// `${value}` of a JSON number that `Number.isInteger` accepts; `None` for any other value and
/// for one JavaScript would write with an exponent, which names no question.
fn integer_text(value: Option<&Value>) -> Option<String> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && number.abs() < 1e21).then(|| format!("{}", number as i128))
}

impl Scan {
    /// Folds one line of the rollout into the scan.
    fn read(&mut self, line: &str) {
        if !line.contains(TOOL) {
            return;
        }
        let Some(entry) = parse_line(line) else {
            return;
        };
        let entry = record(Some(&entry));
        if string(entry, "type") != "response_item" {
            return;
        }
        let payload = record(entry.get("payload"));
        match (string(payload, "type"), string(payload, "role")) {
            ("function_call", _) if string(payload, "name") == TOOL => {
                let Some(args) = parse_line(string(payload, "arguments")) else {
                    return;
                };
                let call = string(payload, "call_id");
                let questions = record(Some(&args))
                    .get("questions")
                    .and_then(Value::as_array);
                for (index, question) in questions.into_iter().flatten().enumerate() {
                    let question = record(Some(question));
                    let title = match string(question, "title") {
                        "" => string(question, "question"),
                        title => title,
                    };
                    let options = question
                        .get("options")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .map(|option| match option {
                            Value::String(option) => option.as_str(),
                            other => string(record(Some(other)), "label"),
                        })
                        .filter(|option| !option.is_empty())
                        .map(str::to_owned)
                        .collect();
                    self.asked.push(QueuedQuestion {
                        key: format!("{call}:{index}"),
                        title: title.to_owned(),
                        options,
                    });
                }
            }
            ("message", "user") => {
                let text = content_text(payload.get("content"), false);
                let items = match question_reply_items(&text) {
                    Some(items) => match parse_line(items) {
                        Some(items) => items,
                        None => return,
                    },
                    None => Value::Array(Vec::new()),
                };
                for item in items.as_array().into_iter().flatten() {
                    // questionItemId: ["request_user_input_async", call id, question index]
                    let Some(Value::Array(id)) =
                        parse_line(string(record(Some(item)), "questionItemId"))
                    else {
                        continue;
                    };
                    if let (Some(Value::String(call)), Some(index)) =
                        (id.get(1), integer_text(id.get(2)))
                    {
                        self.answered.insert(format!("{call}:{index}"));
                    }
                }
            }
            _ => {}
        }
    }
}

impl Questions {
    pub(super) const fn new() -> Self {
        Self {
            scans: Mutex::new(Vec::new()),
        }
    }

    /// The questions `path` asked that hold no answer yet; none for a rollout it cannot read.
    pub(super) fn unanswered(&self, path: &Path) -> Vec<QueuedQuestion> {
        let Ok(meta) = fs::metadata(path) else {
            return Vec::new();
        };
        let stat = file_stat(&meta);
        let known = self
            .scans
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .find(|(scanned, _)| scanned == path)
            .map(|(_, scan)| scan.clone());
        // the scan is built on a copy and kept only once complete
        let mut scan = match known {
            Some(known) if known.node == stat.node && stat.size >= known.size => known,
            _ => Scan {
                node: stat.node,
                size: stat.size.saturating_sub(QUESTION_SCAN_BYTES),
                cut: stat.size > QUESTION_SCAN_BYTES,
                asked: Vec::new(),
                answered: HashSet::new(),
            },
        };
        if stat.size > scan.size {
            let mut bytes = Vec::new();
            let read = File::open(path).and_then(|mut file| {
                file.seek(SeekFrom::Start(scan.size))?;
                file.take(stat.size - scan.size).read_to_end(&mut bytes)
            });
            if read.is_err() {
                return Vec::new();
            }
            // whole lines only: a line still being written is read again next time
            let end = bytes
                .iter()
                .rposition(|byte| *byte == b'\n')
                .map_or(0, |at| at + 1);
            let whole = String::from_utf8_lossy(&bytes[..end]);
            let mut text: &str = &whole;
            if scan.cut && end > 0 {
                text = text.find('\n').map_or("", |at| &text[at + 1..]);
                scan.cut = false;
            }
            for line in lines(text) {
                scan.read(line);
            }
            scan.size += end as u64;
        }
        let unanswered = scan
            .asked
            .iter()
            .filter(|question| !scan.answered.contains(&question.key))
            .cloned()
            .collect();
        let mut scans = self
            .scans
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        scans.retain(|(scanned, _)| scanned != path);
        scans.push((path.to_path_buf(), scan));
        if scans.len() > REMEMBERED_SCANS {
            scans.remove(0);
        }
        unanswered
    }
}
