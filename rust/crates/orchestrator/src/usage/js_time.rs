//! JavaScript's `Date` where the usage reads and writes a time: `Date.UTC`, `Date.parse` of an ISO
//! time, `toISOString`, `Math.round`, and a wall time in a named zone as `zonedTime`
//! (`server/fleet/usage.ts:75`) works it out. Times are epoch milliseconds as JavaScript numbers.

use std::sync::LazyLock;

use jiff::Timestamp;
use jiff::tz::TimeZone;
use regex::Regex;

const DAY_MS: f64 = 86_400_000.0;

/// JavaScript's `.` in a pattern without the `s` flag: any character but a line terminator. Rust's
/// `.` stops only at `\n`. Repeated (`.+`), it also takes a character past U+FFFF, one UTF-16 unit
/// at a time; once (`.?`), see [`DOT_UNIT`].
pub(crate) const DOT: &str = r"[^\n\r\u{2028}\u{2029}]";
/// JavaScript's `.` taken once, in a pattern without the `u` flag: one UTF-16 code unit, so not a
/// character past U+FFFF (two units), which Rust's regex would take as one.
pub(crate) const DOT_UNIT: &str = r"[^\n\r\u{2028}\u{2029}\u{10000}-\u{10FFFF}]";
/// JavaScript's `\s`: its white space (tab, vertical tab, form feed, U+FEFF and the space
/// separators) and its line terminators. Rust's `\s` also takes U+0085 and leaves out U+FEFF.
pub(crate) const SPACE: &str = r"[\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";
/// `TimeClip`: a `Date` holds no time further than this from the epoch.
const MAX_TIME: f64 = 8.64e15;

/// Days from 1970-01-01 to the first of `month` (1 to 12) of `year`, in the proleptic Gregorian
/// calendar (H. Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The year, month (1 to 12) and day of `days` after 1970-01-01 (`civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `Date.UTC(year, month, day, hours, minutes)` with `month` from 0: a month, day, hour or minute
/// past its range carries into the next, as JavaScript's `MakeDay` and `MakeTime` do. `None` past
/// the times a `Date` can hold.
pub(crate) fn date_utc(year: i64, month: i64, day: i64, hours: i64, minutes: i64) -> Option<f64> {
    let year = year.checked_add(month.div_euclid(12))?;
    let days = days_from_civil(year, month.rem_euclid(12) + 1, 1) + day - 1;
    let time = days as f64 * DAY_MS + hours as f64 * 3_600_000.0 + minutes as f64 * 60_000.0;
    (time.abs() <= MAX_TIME).then_some(time)
}

/// `new Date(time).getUTCFullYear()`.
pub(crate) fn utc_year(time: f64) -> i64 {
    civil_from_days((time / DAY_MS).floor() as i64).0
}

/// `new Date(time).toISOString()`: `2026-10-04T08:00:00.000Z`, the milliseconds truncated as a
/// `Date` holds them; a year past 0 to 9999 is written with its sign and six digits. A time past
/// what a `Date` holds is "Invalid Date", as `String(new Date(time))` writes it, where
/// `toISOString` throws.
pub(crate) fn to_iso_string(time: f64) -> String {
    if !time.is_finite() || time.abs() > MAX_TIME {
        return "Invalid Date".to_owned();
    }
    let ms = time.trunc() as i64;
    let days = ms.div_euclid(86_400_000);
    let of_day = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{}{:06}", if year < 0 { '-' } else { '+' }, year.abs())
    };
    format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3_600_000,
        of_day / 60_000 % 60,
        of_day / 1000 % 60,
        of_day % 1000
    )
}

/// `Math.round`: the nearest whole number, a half rounded up (towards +∞), not away from zero.
pub(crate) fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// The ISO forms `Date.parse` reads: a date alone (UTC), or a date and time with an offset (`Z`,
/// `+09:00`, `+0900`) or without one (the local time). The fraction is cut to milliseconds.
static ISO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^([+-][0-9]{6}|[0-9]{4})-([0-9]{2})-([0-9]{2})(?:T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?$",
    )
    .expect("the ISO pattern compiles")
});

/// `Date.parse(text)` for the ISO forms (`ISO`); `None` where JavaScript gives `NaN`, and for the
/// other forms some engines also read (`Oct 4 2026`), which no CLI the usage reads writes.
pub(crate) fn date_parse(text: &str, local: &TimeZone) -> Option<f64> {
    let parts = ISO.captures(text)?;
    let number = |index: usize| -> Option<i64> {
        parts
            .get(index)
            .map(|m| m.as_str().parse().ok())
            .unwrap_or(Some(0))
    };
    let year = number(1)?;
    let (month, day) = (number(2)?, number(3)?);
    let (hours, minutes, seconds) = (number(4)?, number(5)?, number(6)?);
    if parts.get(1).is_some_and(|m| m.as_str() == "-000000")
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hours > 24
        || minutes > 59
        || seconds > 59
        || (hours == 24 && (minutes, seconds) != (0, 0))
    {
        return None;
    }
    let millis = parts.get(7).map_or(0.0, |m| {
        let digits = &m.as_str()[..m.as_str().len().min(3)];
        format!("{digits:0<3}").parse::<f64>().unwrap_or(0.0)
    });
    let wall = date_utc(year, month - 1, day, hours, minutes)? + seconds as f64 * 1000.0 + millis;
    let time = match (parts.get(4), parts.get(8)) {
        // a date alone is UTC
        (None, _) => wall,
        (Some(_), Some(offset)) if offset.as_str() == "Z" => wall,
        (Some(_), Some(offset)) => {
            let offset = offset.as_str();
            let sign = if offset.starts_with('-') { -1.0 } else { 1.0 };
            let digits: String = offset[1..].chars().filter(char::is_ascii_digit).collect();
            let (h, m) = (
                digits[..2].parse::<f64>().ok()?,
                digits[2..].parse::<f64>().ok()?,
            );
            if h > 23.0 || m > 59.0 {
                return None;
            }
            wall - sign * (h * 3_600_000.0 + m * 60_000.0)
        }
        // a date and time without an offset is the local time
        (Some(_), None) => local_to_utc(wall, local)?,
    };
    (time.abs() <= MAX_TIME).then_some(time)
}

/// The instant of a local wall time, given as the epoch milliseconds the same wall time has in
/// UTC: JavaScript's `UTC(t)`. A wall time that does not exist (summer time skips it) is read with
/// the offset before the change, and one that comes twice is the earlier: jiff's `compatible`.
pub(crate) fn local_to_utc(wall: f64, local: &TimeZone) -> Option<f64> {
    let wall = wall.floor() as i64;
    let civil = Timestamp::from_millisecond(wall)
        .ok()?
        .to_zoned(TimeZone::UTC)
        .datetime();
    let zoned = local.to_ambiguous_zoned(civil).compatible().ok()?;
    Some(zoned.timestamp().as_millisecond() as f64)
}

/// The local wall time of an instant, as the epoch milliseconds the same wall time has in UTC
/// (JavaScript's `LocalTime(t)`).
pub(crate) fn utc_to_local(time: f64, local: &TimeZone) -> Option<f64> {
    let timestamp = Timestamp::from_millisecond(time.floor() as i64).ok()?;
    let offset = local.to_offset(timestamp);
    Some(time + f64::from(offset.seconds()) * 1000.0)
}

/// Epoch milliseconds of a wall time in an IANA zone, as `zonedTime` works it out: the wall time
/// read as UTC (`guess`), shown in the zone to the minute (`Intl.DateTimeFormat` without
/// seconds), and the difference taken back once. `None` for a zone the tz database does not know
/// (`Intl` throws). Near a change of offset this is not the instant the wall time names: the
/// offset is the zone's at `guess`.
pub(crate) fn zoned_time(
    year: i64,
    month: i64,
    day: i64,
    hours: i64,
    minutes: i64,
    zone: &str,
) -> Option<f64> {
    let guess = date_utc(year, month, day, hours, minutes)?;
    let zone = TimeZone::get(zone).ok()?;
    let offset = zone.to_offset(Timestamp::from_millisecond(guess as i64).ok()?);
    let shown = guess + f64::from(offset.seconds()) * 1000.0;
    let shown = (shown / 60_000.0).floor() * 60_000.0;
    Some(guess - (shown - guess))
}
