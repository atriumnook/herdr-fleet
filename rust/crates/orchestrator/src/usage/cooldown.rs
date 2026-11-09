//! A failure message that says a limit was hit, and until when (`rateLimitUntil`,
//! `server/fleet/usage.ts:117-157`).
//!
//! The patterns are TypeScript's, written for Rust's regex: `\d` as `[0-9]`, `\b` as the ASCII
//! word boundary `(?-u:\b)`, and `.` and `\s` as [`DOT`] and [`SPACE`], as JavaScript reads them in
//! a pattern without the `u` flag. Case is set aside by Unicode's simple folding, where JavaScript
//! sets it aside by upper case: they differ only for letters past ASCII that fold into it (`ſ`,
//! the Kelvin sign).

use std::sync::LazyLock;

use jiff::tz::TimeZone;
use regex::Regex;

use super::js_time::{DOT, SPACE, date_parse, local_to_utc, utc_to_local};

/// What a failure message says of a rate limit: TypeScript's `null`, `undefined` and a number.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RateLimit {
    /// Another failure (`null`).
    NotOne,
    /// A rate limit, until the time it names (epoch milliseconds) when it names one.
    Until(Option<f64>),
}

fn pattern(source: &str) -> Regex {
    Regex::new(source).expect("the pattern compiles")
}

/// `RATE_LIMITED` (`server/fleet/usage.ts:117`).
static RATE_LIMITED: LazyLock<Regex> = LazyLock::new(|| {
    pattern(&format!(
        r"(?i)rate{DOT}?limit|usage limit|limit reached|quota|too many requests|(?-u:\b)429(?-u:\b)|resource{DOT}?exhausted|out of credits"
    ))
});

static ISO_TIME: LazyLock<Regex> = LazyLock::new(|| {
    pattern(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})",
    )
});

static RELATIVE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(&format!(
        r"(?i)(?-u:\b)in{SPACE}+((?:[0-9]+{SPACE}*(?:d|days?|h|hours?|hrs?|m|mins?|minutes?|s|secs?|seconds?)(?-u:\b)(?:{SPACE}|,)*(?:and{SPACE}+)?)+)"
    ))
});

static RELATIVE_PART: LazyLock<Regex> =
    LazyLock::new(|| pattern(&format!(r"(?i)([0-9]+){SPACE}*([dhms])")));

static CLOCK: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?i)(?-u:\b)at\s+([0-9]{1,2}):([0-9]{2})\s*(am|pm)?(?-u:\b)"));

const DAY_MS: f64 = 86_400_000.0;

/// A failure message that says a limit was hit, and until when if it says: an ISO time, "in 2h
/// 5m" / "in 30 minutes", or a clock time ("at 3:45 PM", the next one to come in `time_zone`, the
/// server's zone in TypeScript). [`RateLimit::NotOne`] when it is not a rate limit,
/// `Until(None)` when it is one with no time in it. `now` is epoch milliseconds.
pub fn rate_limit_until(message: &str, now: i64, time_zone: &TimeZone) -> RateLimit {
    let now = now as f64;
    if !RATE_LIMITED.is_match(message) {
        return RateLimit::NotOne;
    }
    if let Some(iso) = ISO_TIME.find(message)
        && let Some(at) = date_parse(iso.as_str(), time_zone)
        && at > now
    {
        return RateLimit::Until(Some(at));
    }
    if let Some(relative) = RELATIVE.captures(message) {
        let total: f64 = RELATIVE_PART
            .captures_iter(&relative[1])
            .map(|part| {
                let unit = match part[2].to_ascii_lowercase().as_str() {
                    "d" => DAY_MS,
                    "h" => 3_600_000.0,
                    "m" => 60_000.0,
                    _ => 1_000.0,
                };
                part[1].parse::<f64>().unwrap_or(f64::INFINITY) * unit
            })
            .sum();
        if total > 0.0 {
            return RateLimit::Until(Some(now + total));
        }
    }
    if let Some(clock) = CLOCK.captures(message) {
        return RateLimit::Until(next_clock_time(&clock, now, time_zone));
    }
    RateLimit::Until(None)
}

/// `at.setHours(hours, minutes, 0, 0)` on a `Date` of `now`, and a day later
/// (`at.setDate(at.getDate() + 1)`) when that is not after `now`, both in local time.
fn next_clock_time(clock: &regex::Captures<'_>, now: f64, time_zone: &TimeZone) -> Option<f64> {
    let meridiem = clock.get(3).map(|m| m.as_str().to_ascii_lowercase());
    let hours = clock[1].parse::<f64>().ok()? % if meridiem.is_some() { 12.0 } else { 24.0 };
    let hours = hours
        + if meridiem.as_deref() == Some("pm") {
            12.0
        } else {
            0.0
        };
    let minutes = clock[2].parse::<f64>().ok()?;
    let local_now = utc_to_local(now, time_zone)?;
    let wall = (local_now / DAY_MS).floor() * DAY_MS + hours * 3_600_000.0 + minutes * 60_000.0;
    let at = local_to_utc(wall, time_zone)?;
    if at > now {
        return Some(at);
    }
    // the same local time of day as `at` holds (which a skipped hour may have moved), a day on
    local_to_utc(utc_to_local(at, time_zone)? + DAY_MS, time_zone)
}
