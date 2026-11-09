//! The fleet's notices to its agents ([fleet] messages to a coordinator or a thread's lead); from
//! `server/fleet/outbox.ts`. They are kept in one JSON file (0600) that is written, a temp file
//! renamed over it, before a notice is typed.
//!
//! A queued notice ([`Outbox::put`]) waits until whoever hears its run is free, survives a restart,
//! and goes out with the others due to the same agent, in the order written; once the message is
//! typed, the delivered notices leave the file in one write, so a restart neither loses nor repeats
//! one. A crash while the message is being typed sends it again after the restart: a repeat over a
//! loss, as the coordinator waits on this news.
//!
//! A notice sent at once ([`Outbox::send_now`]: a button the person pressed, the standstill call)
//! is in the file only while it is typed. One a crash left behind is dropped on load: the person saw
//! the press fail and presses again, and the supervisor finds a standstill again.
//!
//! The entries sit behind one `std::sync::Mutex`, held only while they change and are written,
//! never while a message is typed: a notice can be put while one goes out.

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Clock;
use crate::registry::write_whole;

/// What a notice is, when it is written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoticeInput {
    /// The run the notice is about: whoever hears that run when the notice goes out hears it.
    pub about: String,
    /// A later notice of the same `about` and `slot` replaces one not yet delivered.
    pub slot: String,
    /// The header it is listed under, in a message with others.
    pub section: String,
    pub text: String,
    /// The landing step it hands on, by the time the person pressed it (epoch milliseconds).
    pub landing_at: Option<i64>,
}

/// A notice in the outbox: numbered in the order written, which is the order it goes out in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub about: String,
    pub slot: String,
    pub section: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub landing_at: Option<i64>,
    pub seq: u64,
    /// When it was put (epoch milliseconds).
    pub at: i64,
}

/// A notice sent at once: kept in the file only while it is typed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct Immediate {
    seq: u64,
    at: i64,
    to: String,
    text: String,
    /// always `true`: the mark outbox.ts tells these entries by (`"now" in entry`)
    now: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
enum Entry {
    Notice(Notice),
    Immediate(Immediate),
}

impl Entry {
    fn seq(&self) -> u64 {
        match self {
            Entry::Notice(notice) => notice.seq,
            Entry::Immediate(immediate) => immediate.seq,
        }
    }

    fn notice(&self) -> Option<&Notice> {
        match self {
            Entry::Notice(notice) => Some(notice),
            Entry::Immediate(_) => None,
        }
    }
}

struct State {
    entries: Vec<Entry>,
    next: u64,
}

/// The fleet's notices to its agents (see the module's comment).
pub struct Outbox {
    file: Option<PathBuf>,
    clock: Arc<dyn Clock>,
    state: Mutex<State>,
}

impl Outbox {
    /// The queued notices `file` holds, in the order written; none without a file, or from one
    /// that is missing or not a JSON array. Notices sent at once that a crash left behind, and
    /// entries without a number or a text, are dropped, and the file is written without them.
    pub fn open(file: Option<PathBuf>, clock: Arc<dyn Clock>) -> io::Result<Self> {
        let outbox = Outbox {
            file,
            clock,
            state: Mutex::new(State {
                entries: Vec::new(),
                next: 1,
            }),
        };
        let Some(stored) = outbox.file.as_deref().and_then(|file| {
            let bytes = std::fs::read(file).ok()?;
            match serde_json::from_str(&String::from_utf8_lossy(&bytes)) {
                Ok(Value::Array(values)) => Some(values),
                _ => None,
            }
        }) else {
            return Ok(outbox);
        };
        // outbox.ts: an entry is valid with a number `seq` and a string `text`
        let valid: Vec<&Value> = stored
            .iter()
            .filter(|entry| entry.get("seq").is_some_and(Value::is_number))
            .filter(|entry| entry.get("text").is_some_and(Value::is_string))
            .collect();
        let highest = valid
            .iter()
            .filter_map(|entry| entry.get("seq").and_then(Value::as_f64))
            .fold(0.0, f64::max);
        let mut entries: Vec<Entry> = valid
            .iter()
            .filter(|entry| entry.get("now").is_none())
            // a queued notice this crate cannot read (a missing field, a seq that is not a whole
            // number) is dropped with the invalid ones
            .filter_map(|entry| serde_json::from_value::<Notice>(Value::clone(entry)).ok())
            .map(Entry::Notice)
            .collect();
        entries.sort_by_key(Entry::seq);
        {
            let mut state = outbox.lock();
            // seq is a whole number of at most 2^53 in any file outbox.ts or this wrote
            #[expect(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "a JavaScript number used as a counter"
            )]
            let next = highest as u64 + 1;
            state.next = next;
            if entries.len() == stored.len() {
                state.entries = entries;
            } else {
                outbox.commit(&mut state, entries)?;
            }
        }
        Ok(outbox)
    }

    /// Queues a notice, in place of one of the same run and slot not yet delivered.
    pub fn put(&self, input: NoticeInput) -> io::Result<Notice> {
        let mut state = self.lock();
        let notice = Notice {
            about: input.about,
            slot: input.slot,
            section: input.section,
            text: input.text,
            landing_at: input.landing_at,
            seq: state.next,
            at: self.clock.now_ms(),
        };
        state.next += 1;
        let mut entries: Vec<Entry> = state
            .entries
            .iter()
            .filter(|entry| {
                entry
                    .notice()
                    .is_none_or(|each| each.about != notice.about || each.slot != notice.slot)
            })
            .cloned()
            .collect();
        entries.push(Entry::Notice(notice.clone()));
        self.commit(&mut state, entries)?;
        Ok(notice)
    }

    /// The run's notice of `slot` is no longer news: the person answered it, or the run went on
    /// (outbox.ts's `drop`).
    pub fn discard(&self, about: &str, slot: &str) -> io::Result<()> {
        self.remove(|entry| {
            entry
                .notice()
                .is_some_and(|notice| notice.about == about && notice.slot == slot)
        })
    }

    /// The queued notices about `from` are about `to` now, in their place: a thread's new lead took
    /// them over (outbox.ts's `move`).
    pub fn move_notices(&self, from: &str, to: &str) -> io::Result<()> {
        let mut state = self.lock();
        let entries = state
            .entries
            .iter()
            .map(|entry| match entry {
                Entry::Notice(notice) if notice.about == from => Entry::Notice(Notice {
                    about: to.to_owned(),
                    ..notice.clone()
                }),
                other => other.clone(),
            })
            .collect();
        self.commit(&mut state, entries)
    }

    /// The queued notices `keep` turns down leave the outbox.
    pub fn prune(&self, keep: impl Fn(&Notice) -> bool) -> io::Result<()> {
        self.remove(|entry| entry.notice().is_some_and(|notice| !keep(notice)))
    }

    /// The queued notices, in the order written.
    pub fn pending(&self) -> Vec<Notice> {
        self.pending_where(|_| true)
    }

    /// The queued notices `filter` takes, in the order written.
    pub fn pending_where(&self, filter: impl Fn(&Notice) -> bool) -> Vec<Notice> {
        self.lock()
            .entries
            .iter()
            .filter_map(Entry::notice)
            .filter(|notice| filter(notice))
            .cloned()
            .collect()
    }

    /// Whether a queued notice about the run waits.
    pub fn holds(&self, about: &str) -> bool {
        self.lock()
            .entries
            .iter()
            .filter_map(Entry::notice)
            .any(|notice| notice.about == about)
    }

    /// `due` in one message, through `send` (true once it was typed); delivered, they leave the
    /// outbox. A notice that replaced one of them meanwhile stays for the next message. An error
    /// says the delivered notices could not leave the file.
    pub async fn deliver<F, Fut>(
        &self,
        due: &[Notice],
        headers: &HashMap<&str, &str>,
        send: F,
    ) -> io::Result<bool>
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = bool>,
    {
        if due.is_empty() || !send(message(due, headers)).await {
            return Ok(false);
        }
        self.remove(|entry| due.iter().any(|notice| notice.seq == entry.seq()))?;
        Ok(true)
    }

    /// `text` to the run `to` now, through `send`: written before it is typed, gone after, whatever
    /// came of it (a send whose future is dropped too). `send`'s value is handed back; an error says
    /// the file did not take the notice, which then is not sent, or did not let it go after.
    pub async fn send_now<T, F, Fut>(&self, to: &str, text: &str, send: F) -> io::Result<T>
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = T>,
    {
        let seq = {
            let mut state = self.lock();
            let seq = state.next;
            state.next += 1;
            let mut entries = state.entries.clone();
            entries.push(Entry::Immediate(Immediate {
                seq,
                at: self.clock.now_ms(),
                to: to.to_owned(),
                text: text.to_owned(),
                now: true,
            }));
            self.commit(&mut state, entries)?;
            seq
        };
        let mut sending = Sending {
            outbox: self,
            seq: Some(seq),
        };
        let sent = send(text.to_owned()).await;
        sending.finish()?;
        Ok(sent)
    }

    fn remove(&self, matches: impl Fn(&Entry) -> bool) -> io::Result<()> {
        let mut state = self.lock();
        let kept: Vec<Entry> = state
            .entries
            .iter()
            .filter(|entry| !matches(entry))
            .cloned()
            .collect();
        if kept.len() == state.entries.len() {
            return Ok(());
        }
        self.commit(&mut state, kept)
    }

    /// `entries` on disk, then in memory: a notice the file did not take is never sent.
    fn commit(&self, state: &mut State, entries: Vec<Entry>) -> io::Result<()> {
        if let Some(file) = &self.file {
            write_whole(file, serde_json::to_string(&entries)?.as_bytes())?;
        }
        state.entries = entries;
        Ok(())
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A notice sent now while it is typed: it leaves the outbox when the send ends, or, when the send's
/// future is dropped first, when this is dropped (outbox.ts's `finally`).
struct Sending<'a> {
    outbox: &'a Outbox,
    seq: Option<u64>,
}

impl Sending<'_> {
    fn finish(&mut self) -> io::Result<()> {
        match self.seq.take() {
            Some(seq) => self.outbox.remove(|entry| entry.seq() == seq),
            None => Ok(()),
        }
    }
}

impl Drop for Sending<'_> {
    fn drop(&mut self) {
        // nobody is left to hear an error here: the notice stays in the file, and the next load
        // drops it, as one a crash left behind
        let _ = self.finish();
    }
}

/// The notices as one message: each under its section's header, which comes again when the section
/// changes. A section without a header lists its notices alone.
pub fn message(notices: &[Notice], headers: &HashMap<&str, &str>) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut section: Option<&str> = None;
    for notice in notices {
        if section != Some(notice.section.as_str()) {
            section = Some(&notice.section);
            if let Some(header) = headers
                .get(notice.section.as_str())
                .filter(|header| !header.is_empty())
            {
                lines.push((*header).to_owned());
            }
        }
        lines.push(format!("- {}", notice.text));
    }
    lines.join("\n")
}
