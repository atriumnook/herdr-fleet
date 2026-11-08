//! `new Date(ms).toISOString()` of JavaScript, for the epoch milliseconds OpenCode stamps.

use serde_json::Value;

/// A time JavaScript's `Date` cannot hold: `toISOString` throws a RangeError on it, and the read
/// fails, as TypeScript's does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct InvalidTime;

/// The farthest a `Date` reaches from the epoch, either way (ECMA-262 TimeClip).
const MAX_TIME_MS: f64 = 8.64e15;
const DAY_MS: i64 = 86_400_000;

/// `typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null` (the
/// `iso` of `server/opencode-messages.ts`); JSON holds no number that is not finite.
pub(crate) fn iso(ms: Option<&Value>) -> Result<Option<String>, InvalidTime> {
    let Some(ms) = ms.and_then(Value::as_f64) else {
        return Ok(None);
    };
    if ms.abs() > MAX_TIME_MS {
        return Err(InvalidTime);
    }
    // TimeClip drops the fraction toward zero
    let ms = ms.trunc() as i64;
    let days = ms.div_euclid(DAY_MS);
    let in_day = ms.rem_euclid(DAY_MS);
    let (year, month, day) = civil_from_days(days);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    Ok(Some(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    )))
}

/// The proleptic Gregorian date of a day counted from 1970-01-01 (Howard Hinnant's
/// `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Expected values: Bun 1.4.4 `new Date(ms).toISOString()` (a RangeError where it throws).
    #[test]
    fn writes_a_time_as_javascript_does() {
        let cases: [(Value, Result<Option<&str>, InvalidTime>); 16] = [
            (json!(0), Ok(Some("1970-01-01T00:00:00.000Z"))),
            (json!(5590), Ok(Some("1970-01-01T00:00:05.590Z"))),
            (json!(-1), Ok(Some("1969-12-31T23:59:59.999Z"))),
            (json!(-1.5), Ok(Some("1969-12-31T23:59:59.999Z"))),
            (json!(1.7), Ok(Some("1970-01-01T00:00:00.001Z"))),
            (json!(8.64e15), Ok(Some("+275760-09-13T00:00:00.000Z"))),
            (json!(-8.64e15), Ok(Some("-271821-04-20T00:00:00.000Z"))),
            (json!(8_640_000_000_000_001_i64), Err(InvalidTime)),
            (json!(1e20), Err(InvalidTime)),
            (
                json!(253_402_300_799_999_i64),
                Ok(Some("9999-12-31T23:59:59.999Z")),
            ),
            (
                json!(253_402_300_800_000_i64),
                Ok(Some("+010000-01-01T00:00:00.000Z")),
            ),
            (
                json!(-62_135_596_800_000_i64),
                Ok(Some("0001-01-01T00:00:00.000Z")),
            ),
            (
                json!(-62_135_596_800_001_i64),
                Ok(Some("0000-12-31T23:59:59.999Z")),
            ),
            (
                json!(-62_198_755_200_000_i64),
                Ok(Some("-000001-01-01T00:00:00.000Z")),
            ),
            (
                json!(951_782_400_000_i64),
                Ok(Some("2000-02-29T00:00:00.000Z")),
            ),
            (json!("5590"), Ok(None)),
        ];
        for (ms, expected) in cases {
            assert_eq!(
                iso(Some(&ms)),
                expected.map(|found| found.map(str::to_owned)),
                "new Date({ms}).toISOString()"
            );
        }
        assert_eq!(iso(None), Ok(None));
    }
}
