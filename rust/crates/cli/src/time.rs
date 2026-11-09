//! `new Date(ms).toLocaleString()` as `bin/fleet.ts` prints times, always in the en-US form
//! (`1/2/2040, 8:00:00 AM`) whatever the locale, in the zone the `TZ` passed to `run` names
//! (ADR 0242-phase-3-split). The zone is never read from the process: `run` is called from the
//! tests of one process side by side, so jiff's `TimeZone::system()`, which reads the process's
//! `TZ`, is not used. Nor is jiff's global zone database, which the process's `TZDIR` picks:
//! Bun takes the zones from ICU and ignores `TZDIR`.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use jiff::Timestamp;
use jiff::tz::{TimeZone, TimeZoneDatabase};

/// The zone `env`'s `TZ` names, as Bun (ICU) reads it: an IANA name, with a leading `:` allowed
/// and letter case ignored; what the zone database does not name (a POSIX rule such as `JST-9`,
/// a path, the empty string) is UTC. Without `TZ`, the system's zone, `/etc/localtime`.
pub fn zone(env: &BTreeMap<String, String>) -> TimeZone {
    match env.get("TZ") {
        Some(name) => {
            let name = name.strip_prefix(':').unwrap_or(name);
            if name.is_empty() || name.starts_with('/') {
                return TimeZone::UTC;
            }
            database().get(name).unwrap_or(TimeZone::UTC)
        }
        None => system_zone(),
    }
}

/// The zone database, opened once for the process from where the system keeps it, whatever the
/// process's `TZDIR` says.
fn database() -> &'static TimeZoneDatabase {
    static DATABASE: OnceLock<TimeZoneDatabase> = OnceLock::new();
    DATABASE.get_or_init(open_database)
}

/// The first of the folders jiff searches on Unix (when `TZDIR` is not set) that holds zones.
#[cfg(unix)]
fn open_database() -> TimeZoneDatabase {
    [
        "/usr/share/zoneinfo",
        "/usr/share/lib/zoneinfo",
        "/etc/zoneinfo",
    ]
    .into_iter()
    .filter_map(|dir| TimeZoneDatabase::from_dir(dir).ok())
    .find(|database| !database.is_definitively_empty())
    .unwrap_or_else(TimeZoneDatabase::none)
}

/// Windows keeps no zone database: the copy built into jiff (phase 6 settles the Windows build).
#[cfg(not(unix))]
fn open_database() -> TimeZoneDatabase {
    TimeZoneDatabase::bundled()
}

#[cfg(unix)]
fn system_zone() -> TimeZone {
    std::fs::read("/etc/localtime")
        .ok()
        .and_then(|data| TimeZone::tzif("Local", &data).ok())
        .unwrap_or(TimeZone::UTC)
}

/// Windows has no `/etc/localtime`; its zone comes with the Windows build (phase 6).
#[cfg(not(unix))]
fn system_zone() -> TimeZone {
    TimeZone::UTC
}

/// The largest time a JavaScript Date holds, in milliseconds either side of 1970.
const DATE_LIMIT_MS: f64 = 8.64e15;
/// 400 years of the Gregorian calendar, after which the dates fall on the same weekdays again.
const CYCLE_SECONDS: i64 = 146_097 * 86_400;

/// `new Date(ms).toLocaleString()` in en-US, in `zone`; `Invalid Date` for what a Date cannot
/// hold. A Date reaches about 275,000 years either way and jiff's times 9,999: a time beyond
/// jiff's range is moved by whole 400-year cycles into it, where the calendar and the zone's
/// rules repeat (before the zone's first change its first offset holds, after its last change
/// its yearly rule), and the cycles are added back to the year.
pub fn locale_string(ms: f64, zone: &TimeZone) -> String {
    if !ms.is_finite() || ms.abs() > DATE_LIMIT_MS {
        return "Invalid Date".to_string();
    }
    // a Date drops the fraction of a millisecond toward zero; the clock shows whole seconds
    let seconds = (ms.trunc() as i64).div_euclid(1000);
    // a day inside jiff's range, so that no offset takes the local time out of it
    let (min, max) = (
        Timestamp::MIN.as_second() + 86_400,
        Timestamp::MAX.as_second() - 86_400,
    );
    let cycles = if seconds > max {
        (seconds - max + CYCLE_SECONDS - 1) / CYCLE_SECONDS
    } else if seconds < min {
        -((min - seconds + CYCLE_SECONDS - 1) / CYCLE_SECONDS)
    } else {
        0
    };
    let Ok(timestamp) = Timestamp::from_second(seconds - cycles * CYCLE_SECONDS) else {
        return "Invalid Date".to_string();
    };
    let local = zone.to_datetime(timestamp);
    let year = i64::from(local.year()) + 400 * cycles;
    // the Gregorian era's year: 1 BC is year 0, shown as 1, and en-US writes no era
    let year = if year <= 0 { 1 - year } else { year };
    let hour = local.hour();
    let (hour12, half) = match hour {
        0 => (12, "AM"),
        1..=11 => (hour, "AM"),
        12 => (12, "PM"),
        _ => (hour - 12, "PM"),
    };
    format!(
        "{}/{}/{year}, {hour12}:{:02}:{:02} {half}",
        local.month(),
        local.day(),
        local.minute(),
        local.second()
    )
}
