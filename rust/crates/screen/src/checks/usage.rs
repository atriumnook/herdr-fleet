//! `cursorUsage` (server/fleet/adapters.ts:278-298): cursor's `/usage` pager.

use std::sync::LazyLock;

use protocol::{UsageReading, UsageWindow};
use regex::Regex;

use crate::text::js_regex;

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const DAY_MS: i64 = 86_400_000;

static INCLUDED: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"Included:?{s}+([0-9]+(?:\.[0-9]+)?)% used"));
/// JavaScript's `\b` looks at ASCII word characters alone (ADR 0193-phase-2-dependencies).
static NAMED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"Resets (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{1,2})(?-u:\b)")
        .unwrap()
});
static NUMERIC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"Resets ([0-9]{1,2})月([0-9]{1,2})日").unwrap());

/// cursor's `/usage` pager: `Included  12% used` (the plan's included usage, which on-demand would
/// extend; off for this fleet's user) and `Resets Oct 23`, a UTC date with no year (the next one),
/// written in the CLI's locale: `Resets 10月26日` under ja_JP. `now` is epoch milliseconds.
pub(super) fn cursor_usage(screen: &str, now: i64) -> Option<UsageReading> {
    let included = INCLUDED.captures_iter(screen).last()?;
    let named = NAMED.captures_iter(screen).last();
    let numeric = NUMERIC.captures_iter(screen).last();
    let number = |text: &str| text.parse::<i64>().expect("one or two digits");
    // the English spelling wins over the Japanese one, as in TypeScript
    let date = match (named, numeric) {
        (Some(named), _) => Some((
            MONTHS
                .iter()
                .position(|month| *month == &named[1])
                .expect("a month the pattern names") as i64,
            number(&named[2]),
        )),
        (None, Some(numeric)) => Some((number(&numeric[1]) - 1, number(&numeric[2]))),
        (None, None) => None,
    };
    let resets_at = date.map(|(month, day)| {
        let year = utc_year(now);
        let at = date_utc(year, month, day);
        if at <= now {
            date_utc(year + 1, month, day)
        } else {
            at
        }
    });
    Some(UsageReading {
        windows: vec![UsageWindow {
            name: "monthly".into(),
            used_percent: included[1].parse().expect("digits with at most one point"),
            // `...(resetsAt ? { resetsAt } : {})`: 0 is false in JavaScript
            resets_at: resets_at.filter(|&at| at != 0).map(|at| at as f64),
        }],
        read_at: now as f64,
    })
}

/// `Date.UTC(year, month, day)` for a month from 0: a month or a day out of its range rolls into the
/// next or the previous ones, as ECMAScript's MakeDay does.
fn date_utc(year: i64, month: i64, day: i64) -> i64 {
    let year = year + month.div_euclid(12);
    let month = month.rem_euclid(12) + 1;
    (days_from_civil(year, month, 1) + day - 1) * DAY_MS
}

/// `new Date(ms).getUTCFullYear()`.
fn utc_year(ms: i64) -> i64 {
    civil_year(ms.div_euclid(DAY_MS))
}

/// The days from 1970-01-01 to the first of `month` (1 to 12) of `year`, in the proleptic Gregorian
/// calendar (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The year of the day `days` after 1970-01-01 (Howard Hinnant's `civil_from_days`).
fn civil_year(days: i64) -> i64 {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let year = year_of_era + era * 400;
    // March is the first month of Hinnant's year: January and February belong to the next one
    if month_index >= 10 { year + 1 } else { year }
}

#[cfg(test)]
mod tests {
    use super::{date_utc, utc_year};

    /// The values are what Bun 1.4.4 gives for `Date.UTC` and `getUTCFullYear`.
    #[test]
    fn counts_days_as_javascripts_date_does() {
        assert_eq!(date_utc(1970, 0, 1), 0);
        assert_eq!(date_utc(2026, 9, 23), 1_792_713_600_000);
        // February 29 of a year without one is March 1
        assert_eq!(date_utc(2027, 1, 29), 1_803_859_200_000);
        assert_eq!(date_utc(2024, 1, 29), 1_709_164_800_000);
        // month 12 and day 0 roll over
        assert_eq!(date_utc(2026, 12, 5), 1_799_107_200_000);
        assert_eq!(date_utc(2026, -1, 0), 1_764_460_800_000);
        assert_eq!(date_utc(1969, 11, 31), -86_400_000);
        assert_eq!(utc_year(0), 1970);
        assert_eq!(utc_year(-1), 1969);
        assert_eq!(utc_year(1_798_761_599_999), 2026);
        assert_eq!(utc_year(1_798_761_600_000), 2027);
        assert_eq!(utc_year(951_782_400_000), 2000);
    }
}
