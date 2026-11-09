//! The usage the fleet knows of, kept per account (`usage_key`), and the file it survives a
//! restart in (`UsageTracker`, `server/fleet/usage.ts:159-397`).

use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use jiff::tz::TimeZone;
use protocol::js::{cut_utf16, number_to_string};
use protocol::{Cooldown, FleetAgentKind, UsageEntry, UsageReading, UsageWindow};
use serde_json::Value;
use tokio::sync::watch;

use super::cooldown::{RateLimit, rate_limit_until};
use super::js_time::to_iso_string;
use super::probe::{Readings, UsageProbe, did_not_answer};
use super::{kind_name, usage_key};
use crate::Clock;
use crate::registry::write_whole;

/// How old a probed reading may be before a spawn asks again (`PROBE_TTL_MS`).
pub const PROBE_TTL: Duration = Duration::from_secs(60);
/// How old a reading may be before the Fleet screen's own refresh asks again (`AUTO_REFRESH_MS`).
/// Only the CLIs that have a probe are asked: cursor has none (its `/usage` is typed into a live
/// pane, after a turn).
pub const AUTO_REFRESH: Duration = Duration::from_secs(5 * 60);
/// A CLI that keeps failing is asked less often (the wait doubles per failure) but at least
/// hourly (`BACKOFF_CAP_MS`).
pub const BACKOFF_CAP: Duration = Duration::from_secs(60 * 60);
/// Longer than any probe's own time limit: a probe stuck past it must not hold spawns up
/// (`PROBE_TIMEOUT_MS`).
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(35);
/// cursor's `/usage` screen is read again after a turn once the last reading, or the last try, is
/// this old (`SCREEN_TTL_MS`).
pub const SCREEN_TTL: Duration = Duration::from_secs(10 * 60);
/// A window read without its reset time counts this long: a full one would otherwise hold its CLI
/// back for good, since a CLI read only after its own turns (cursor) is never read again
/// (`UNDATED_WINDOW_MS`).
pub const UNDATED_WINDOW: Duration = Duration::from_secs(24 * 60 * 60);

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

/// How a [`UsageTracker`] is built.
pub struct UsageTrackerOptions {
    /// Readings and cooldowns survive a restart here; `None` keeps them in memory.
    pub file: Option<PathBuf>,
    /// The probe for each CLI that can be asked; a kind without one is learned from its errors
    /// (and cursor's screen).
    pub probes: HashMap<FleetAgentKind, UsageProbe>,
    /// How old a probed reading may be before a spawn asks again.
    pub probe_ttl: Duration,
    /// How long a probe may take before it counts as failed.
    pub probe_timeout: Duration,
    pub clock: Arc<dyn Clock>,
    /// The zone a clock time in a failure message is read in (`try again at 3:45 PM`): the
    /// server's.
    pub time_zone: TimeZone,
}

impl UsageTrackerOptions {
    /// No probes, the default TTL and time limit ([`PROBE_TTL`], [`PROBE_TIMEOUT`]), the server's
    /// zone.
    pub fn new(file: Option<PathBuf>, clock: Arc<dyn Clock>) -> Self {
        Self {
            file,
            probes: HashMap::new(),
            probe_ttl: PROBE_TTL,
            probe_timeout: PROBE_TIMEOUT,
            clock,
            time_zone: TimeZone::system(),
        }
    }
}

/// The usage the fleet knows of, kept per account. A handle: its clones share the same state.
#[derive(Clone)]
pub struct UsageTracker {
    inner: Arc<Inner>,
}

struct Inner {
    file: Option<PathBuf>,
    probes: HashMap<FleetAgentKind, UsageProbe>,
    probe_ttl: Duration,
    probe_timeout: Duration,
    clock: Arc<dyn Clock>,
    time_zone: TimeZone,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// In the order they were first set, as a JavaScript `Map` keeps them: the order of the file.
    entries: Vec<UsageEntry>,
    probed_at: HashMap<FleetAgentKind, f64>,
    /// The probe of each kind under way: its end is sent here.
    in_flight: HashMap<FleetAgentKind, watch::Receiver<bool>>,
    /// Failures in a row per CLI: one not installed or not signed in is not asked every time.
    failures: HashMap<FleetAgentKind, u32>,
    /// When each account's screen was last tried, read or not: a screen that never shows the
    /// usage costs one try per [`SCREEN_TTL`].
    screen_tried_at: HashMap<String, f64>,
}

impl State {
    fn get(&self, key: &str) -> Option<&UsageEntry> {
        self.entries.iter().find(|entry| entry.key == key)
    }

    /// The entry of `key`, made after the others when there is none (`get(key) ?? { key }` and
    /// `set`).
    fn entry(&mut self, key: &str) -> &mut UsageEntry {
        let index = match self.entries.iter().position(|entry| entry.key == key) {
            Some(index) => index,
            None => {
                self.entries.push(UsageEntry {
                    key: key.to_owned(),
                    reading: None,
                    cooldown: None,
                    error: None,
                });
                self.entries.len() - 1
            }
        };
        &mut self.entries[index]
    }
}

/// A key of this CLI: the CLI's own, or one of its parts (`agy:gemini`).
fn of_kind(key: &str, kind: &str) -> bool {
    key == kind
        || key
            .strip_prefix(kind)
            .is_some_and(|rest| rest.starts_with(':'))
}

/// A window that still counts: it has not reset since it was read.
fn current(window: &UsageWindow, reading: &UsageReading, now: f64) -> bool {
    match window.resets_at {
        None => now - reading.read_at < millis(UNDATED_WINDOW),
        Some(resets_at) => resets_at > now,
    }
}

/// `a.key.localeCompare(b.key)` as Bun 1.4.4 orders the keys the tracker holds (CLI names,
/// `agy:gemini`, `pi:<provider>`) in the en-US locale: by the characters' primary weights first
/// (spaces, then punctuation and symbols in the order below, digits, then letters with case set
/// aside), then lower case before upper case. A character past ASCII is weighed after the letters
/// by its code point, where the locale would weigh `é` next to `e`.
fn locale_order(a: &str, b: &str) -> Ordering {
    let primary = |key: &str| key.chars().map(primary_weight).collect::<Vec<_>>();
    let upper = |key: &str| {
        key.chars()
            .map(|c| c.is_ascii_uppercase())
            .collect::<Vec<_>>()
    };
    primary(a)
        .cmp(&primary(b))
        .then_with(|| upper(a).cmp(&upper(b)))
        .then_with(|| a.cmp(b))
}

/// The punctuation and symbols of ASCII in the order of the locale's collation (the Unicode
/// collation's default table), after a space and before the digits.
const PUNCTUATION: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

fn primary_weight(c: char) -> u32 {
    let ascii_after = |base: u32, offset: usize| base + offset as u32;
    if c.is_ascii_whitespace() {
        0
    } else if let Some(index) = PUNCTUATION.find(c) {
        ascii_after(1, index)
    } else if c.is_ascii_digit() {
        ascii_after(100, (c as u8 - b'0') as usize)
    } else if c.is_ascii_alphabetic() {
        ascii_after(200, (c.to_ascii_lowercase() as u8 - b'a') as usize)
    } else {
        300 + u32::from(c)
    }
}

impl UsageTracker {
    /// A tracker with what `options.file` holds: an entry, or a part of one, that does not have
    /// the shape this code reads is dropped, and a file that cannot be read is no file.
    pub fn new(options: UsageTrackerOptions) -> Self {
        let mut state = State::default();
        if let Some(file) = &options.file {
            for entry in stored_entries(file) {
                let key = entry.key.clone();
                *state.entry(&key) = entry;
            }
        }
        Self {
            inner: Arc::new(Inner {
                file: options.file,
                probes: options.probes,
                probe_ttl: options.probe_ttl,
                probe_timeout: options.probe_timeout,
                clock: options.clock,
                time_zone: options.time_zone,
                state: Mutex::new(state),
            }),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn now(&self) -> f64 {
        self.inner.clock.now_ms() as f64
    }

    /// Every account known, by key.
    pub fn list(&self) -> Vec<UsageEntry> {
        let mut entries = self.state().entries.clone();
        entries.sort_by(|a, b| locale_order(&a.key, &b.key));
        entries
    }

    /// Asks every probe whose last try is older than `max_age` (the probe TTL when `None`). With
    /// `max_age` (the automatic refresh), one that keeps failing is asked after longer. `force`
    /// asks them all now, backing off or not.
    pub async fn refresh(&self, force: bool, max_age: Option<Duration>) {
        let kinds: Vec<FleetAgentKind> = self.inner.probes.keys().copied().collect();
        // every probe starts before any is waited for: they run side by side
        let started: Vec<_> = kinds
            .into_iter()
            .filter_map(|kind| self.start_probe(kind, force, max_age))
            .collect();
        for end in started {
            wait(end).await;
        }
    }

    /// Why a candidate should not start now: its account is cooling down, or a window it draws on
    /// is at least `max_used_percent` used. `None` when it may, including when nothing is known.
    pub async fn unavailable(
        &self,
        kind: FleetAgentKind,
        model: Option<&str>,
        max_used_percent: f64,
    ) -> Option<String> {
        if let Some(end) = self.start_probe(kind, false, None) {
            wait(end).await;
        }
        self.known(kind, model, max_used_percent)
    }

    /// The same answer as [`UsageTracker::unavailable`] from what is known now, asking no CLI.
    pub fn known(
        &self,
        kind: FleetAgentKind,
        model: Option<&str>,
        max_used_percent: f64,
    ) -> Option<String> {
        let key = usage_key(kind, model);
        let now = self.now();
        let state = self.state();
        let entry = state.get(&key)?;
        if let Some(cooldown) = entry
            .cooldown
            .as_ref()
            .filter(|cooldown| cooldown.until > now)
        {
            return Some(format!(
                "{key} is cooling down until {} ({})",
                to_iso_string(cooldown.until),
                cooldown.reason
            ));
        }
        let reading = entry.reading.as_ref()?;
        let full = reading.windows.iter().find(|window| {
            current(window, reading, now) && window.used_percent >= max_used_percent
        })?;
        let resets = full
            .resets_at
            .filter(|&at| at != 0.0)
            .map(|at| format!(" (resets {})", to_iso_string(at)))
            .unwrap_or_default();
        Some(format!(
            "{key} has used {}% of its {} limit{resets}",
            number_to_string(full.used_percent),
            full.name
        ))
    }

    /// A start or a turn failed with `message`. A rate limit puts the account in cooldown: until
    /// the time the message names, else until a window it read as full resets, else
    /// `default_minutes`. Says whether it was one.
    pub fn note_failure(
        &self,
        kind: FleetAgentKind,
        model: Option<&str>,
        message: &str,
        default_minutes: f64,
    ) -> bool {
        let now_ms = self.inner.clock.now_ms();
        let now = now_ms as f64;
        let RateLimit::Until(until) = rate_limit_until(message, now_ms, &self.inner.time_zone)
        else {
            return false;
        };
        let key = usage_key(kind, model);
        let mut state = self.state();
        let entry = state.entry(&key);
        let full_resets = entry.reading.as_ref().map_or_else(Vec::new, |reading| {
            reading
                .windows
                .iter()
                .filter(|window| current(window, reading, now) && window.used_percent >= 100.0)
                .filter_map(|window| window.resets_at.filter(|&at| at != 0.0))
                .collect()
        });
        let until = until.unwrap_or_else(|| {
            full_resets
                .into_iter()
                .reduce(f64::max)
                .unwrap_or(now + default_minutes * 60_000.0)
        });
        entry.cooldown = Some(Cooldown {
            until,
            reason: cut_utf16(message, 200).to_owned(),
            since: now,
        });
        self.persist(&state);
        true
    }

    /// Whether to read a CLI's usage off its screen now (cursor's `/usage`): when neither the last
    /// reading nor the last try is recent. A yes counts as the try.
    pub fn claim_screen(&self, kind: FleetAgentKind, model: Option<&str>) -> bool {
        let key = usage_key(kind, model);
        let now = self.now();
        let mut state = self.state();
        let read_at = state
            .get(&key)
            .and_then(|entry| entry.reading.as_ref())
            .map_or(f64::NEG_INFINITY, |reading| reading.read_at);
        let tried_at = state
            .screen_tried_at
            .get(&key)
            .copied()
            .unwrap_or(f64::NEG_INFINITY);
        if now - read_at.max(tried_at) < millis(SCREEN_TTL) {
            return false;
        }
        state.screen_tried_at.insert(key, now);
        true
    }

    /// `reading` is what is known now of the account a candidate of `kind` and `model` draws on
    /// (cursor's `/usage` screen); an earlier failure goes.
    pub fn record(&self, kind: FleetAgentKind, model: Option<&str>, reading: UsageReading) {
        let key = usage_key(kind, model);
        let mut state = self.state();
        let entry = state.entry(&key);
        entry.reading = Some(reading);
        entry.error = None;
        self.persist(&state);
    }

    /// Ends cooldowns: one account's, every account of a CLI (`agy`), or all of them (`None`, or
    /// an empty target, as JavaScript reads `""`). Returns the keys cleared, in the order the
    /// accounts were first known.
    pub fn clear_cooldown(&self, target: Option<&str>) -> Vec<String> {
        let target = target.filter(|target| !target.is_empty());
        let mut state = self.state();
        let mut cleared = Vec::new();
        for entry in &mut state.entries {
            if entry.cooldown.is_none() || target.is_some_and(|target| !of_kind(&entry.key, target))
            {
                continue;
            }
            entry.cooldown = None;
            cleared.push(entry.key.clone());
        }
        if !cleared.is_empty() {
            self.persist(&state);
        }
        cleared
    }

    /// Starts the probe of `kind` unless one is under way (whose end is then returned instead) or
    /// its last try is recent (`None`). Only the automatic refresh (`max_age`) backs off: a spawn
    /// asks at the plain TTL, so routing never leans on an hours-old reading.
    fn start_probe(
        &self,
        kind: FleetAgentKind,
        force: bool,
        max_age: Option<Duration>,
    ) -> Option<watch::Receiver<bool>> {
        let probe = Arc::clone(self.inner.probes.get(&kind)?);
        let now = self.now();
        let mut state = self.state();
        if let Some(running) = state.in_flight.get(&kind) {
            return Some(running.clone());
        }
        let wait = match max_age {
            None => millis(self.inner.probe_ttl),
            Some(max_age) => {
                let max_age = millis(max_age);
                let failures = state.failures.get(&kind).copied().unwrap_or(0).min(6);
                (max_age * 2f64.powi(failures as i32)).min(max_age.max(millis(BACKOFF_CAP)))
            }
        };
        let probed_at = state
            .probed_at
            .get(&kind)
            .copied()
            .unwrap_or(f64::NEG_INFINITY);
        if !force && now - probed_at < wait {
            return None;
        }
        let (ended, end) = watch::channel(false);
        state.in_flight.insert(kind, end.clone());
        drop(state);
        // its own task: the probe runs to its end and is recorded even when the caller that
        // started it is dropped, as TypeScript's promise does
        let tracker = self.clone();
        tokio::spawn(async move {
            // whatever happens to the task, the probe is no longer under way once it ends
            let _done = Done {
                tracker: tracker.clone(),
                kind,
                ended,
            };
            tracker.run_probe(kind, probe).await;
        });
        Some(end)
    }

    async fn run_probe(&self, kind: FleetAgentKind, probe: UsageProbe) {
        let name = kind_name(kind);
        let timeout = self.inner.probe_timeout;
        // the closure is called in the probe's own task too: one that panics before it hands out
        // its future fails that task, not the tracker's
        let mut running = tokio::spawn(async move { probe().await });
        let answer = match tokio::time::timeout(timeout, &mut running).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(error)) => Err(format!("{name}: the probe failed: {error}")),
            Err(_) => {
                running.abort();
                Err(did_not_answer(name, timeout))
            }
        };
        let now = self.now();
        let mut state = self.state();
        match answer {
            Ok(readings) => {
                Self::replace(&mut state, name, readings);
                state.failures.remove(&kind);
            }
            Err(message) => {
                *state.failures.entry(kind).or_insert(0) += 1;
                // a CLI that cannot say leaves what was known; it is not a reason to refuse a spawn
                let mut known = false;
                for entry in state
                    .entries
                    .iter_mut()
                    .filter(|entry| of_kind(&entry.key, name))
                {
                    entry.error = Some(message.clone());
                    known = true;
                }
                if !known {
                    state.entry(name).error = Some(message);
                }
            }
        }
        state.probed_at.insert(kind, now);
        self.persist(&state);
    }

    /// What the CLI answered is all there is now: a part it no longer reports goes, and so does an
    /// earlier failure; a cooldown stays.
    fn replace(state: &mut State, name: &str, readings: Readings) {
        state.entries.retain_mut(|entry| {
            if !of_kind(&entry.key, name) || readings.contains_key(&entry.key) {
                return true;
            }
            entry.reading = None;
            entry.error = None;
            entry.cooldown.is_some()
        });
        for (key, reading) in readings {
            let entry = state.entry(&key);
            entry.reading = Some(reading);
            entry.error = None;
        }
    }

    /// A file that cannot be written loses only the restart's memory: never a spawn's own outcome.
    fn persist(&self, state: &State) {
        let Some(file) = &self.inner.file else {
            return;
        };
        let written = serde_json::to_string(&state.entries)
            .map_err(std::io::Error::from)
            .and_then(|json| write_whole(file, json.as_bytes()));
        if let Err(error) = written {
            eprintln!("fleet: cannot save usage to {}: {error}", file.display());
        }
    }
}

/// Ends a probe's turn when its task ends, also by a panic: the kind is no longer under way, and
/// those waiting for it are told.
struct Done {
    tracker: UsageTracker,
    kind: FleetAgentKind,
    ended: watch::Sender<bool>,
}

impl Drop for Done {
    fn drop(&mut self) {
        self.tracker.state().in_flight.remove(&self.kind);
        let _ = self.ended.send(true);
    }
}

async fn wait(mut end: watch::Receiver<bool>) {
    // a closed channel is a probe task gone: nothing more to wait for
    let _ = end.wait_for(|ended| *ended).await;
}

/// The entries `file` holds, each with only the parts that still have the shape this code reads.
fn stored_entries(file: &std::path::Path) -> Vec<UsageEntry> {
    let Ok(bytes) = fs::read(file) else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)) {
        Ok(Value::Array(values)) => values.iter().filter_map(stored_entry).collect(),
        _ => Vec::new(),
    }
}

fn stored_entry(value: &Value) -> Option<UsageEntry> {
    let key = value.as_object()?.get("key")?.as_str()?;
    let reading = value
        .get("reading")
        .filter(|reading| reading.is_object())
        .and_then(|reading| {
            let read_at = reading.get("readAt")?.as_f64()?;
            let windows = reading
                .get("windows")?
                .as_array()?
                .iter()
                .map(stored_window)
                .collect::<Option<Vec<_>>>()?;
            Some(UsageReading { windows, read_at })
        });
    let cooldown = value
        .get("cooldown")
        .filter(|cooldown| cooldown.is_object())
        .and_then(|cooldown| {
            Some(Cooldown {
                until: cooldown.get("until")?.as_f64()?,
                since: cooldown.get("since")?.as_f64()?,
                reason: cooldown.get("reason")?.as_str()?.to_owned(),
            })
        });
    Some(UsageEntry {
        key: key.to_owned(),
        reading,
        cooldown,
        error: value
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

/// `validWindow`: a name, a numeric share, and a numeric reset time or none at all (`null` is not
/// none).
fn stored_window(value: &Value) -> Option<UsageWindow> {
    let window = value.as_object()?;
    let resets_at = match window.get("resetsAt") {
        None => None,
        Some(at) => Some(at.as_f64()?),
    };
    Some(UsageWindow {
        name: window.get("name")?.as_str()?.to_owned(),
        used_percent: window.get("usedPercent")?.as_f64()?,
        resets_at,
    })
}
