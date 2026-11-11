//! `claude -p /usage`, and the reading in its text (`server/fleet/usage.ts:73-114, 469-483`).

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use child_process::{Runner, claude_env};
use protocol::js::trim;
use protocol::{UsageReading, UsageWindow};
use regex::Regex;
use serde_json::Value;

use super::js_time::{DOT, SPACE, utc_year, zoned_time};
use super::probe::{ProbeOptions, Readings, UsageProbe, run_cli, truthy};

/// How long `claude -p /usage` may run (`usage.ts:480`).
pub const CLAUDE_TIMEOUT: Duration = Duration::from_secs(30);

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

static RESET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{{1,2}}), ([0-9]{{1,2}})(?::([0-9]{{2}}))?{SPACE}*(am|pm){SPACE}*\(([^)]+)\)"
    ))
    .expect("the reset pattern compiles")
});

static USED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r":{SPACE}*([0-9]+(?:\.[0-9]+)?)% used(?:{SPACE}*·{SPACE}*resets ({DOT}+))?"
    ))
    .expect("the share pattern compiles")
});

/// `Oct 4, 9:50pm (Asia/Tokyo)`: no year, so the next such time, at most a day in the past. The
/// zone is read as `zonedTime` reads it (`js_time::zoned_time`); a zone the tz database does not
/// know gives no time.
fn reset_time(text: &str, now: f64) -> Option<f64> {
    let parts = RESET.captures(trim(text))?;
    let month = MONTHS
        .iter()
        .position(|name| name.eq_ignore_ascii_case(&parts[1]))? as i64;
    let day: i64 = parts[2].parse().ok()?;
    let hours = parts[3].parse::<i64>().ok()? % 12
        + if parts[5].eq_ignore_ascii_case("pm") {
            12
        } else {
            0
        };
    let minutes: i64 = parts.get(4).map_or(Some(0), |m| m.as_str().parse().ok())?;
    let zone = &parts[6];
    let year = utc_year(now);
    let at = zoned_time(year, month, day, hours, minutes, zone)?;
    if at < now - 86_400_000.0 {
        return zoned_time(year + 1, month, day, hours, minutes, zone);
    }
    Some(at)
}

/// `claude -p /usage`'s text: `Current session: 7% used · resets Oct 4, 9:50pm (Asia/Tokyo)` and
/// `Current week (all models): …`. Only the windows every model shares: a per-model weekly window
/// would wrongly hold back the others. An API-key session has none. `now` is the reading's time.
pub fn parse_claude_usage(text: &str, now: i64) -> Option<UsageReading> {
    let now = now as f64;
    let windows: Vec<UsageWindow> = [
        ("Current session", "5h"),
        ("Current week (all models)", "weekly"),
    ]
    .into_iter()
    .filter_map(|(label, name)| {
        let line = text
            .split('\n')
            .find(|line| trim(line).starts_with(&format!("{label}:")))?;
        let parts = USED.captures(line)?;
        let resets_at = parts
            .get(2)
            .and_then(|reset| reset_time(reset.as_str(), now))
            // `resetsAt ? { resetsAt } : {}`: 0 is no time
            .filter(|&at| at != 0.0);
        Some(UsageWindow {
            name: name.to_owned(),
            used_percent: parts[1].parse().ok()?,
            resets_at,
        })
    })
    .collect();
    (!windows.is_empty()).then_some(UsageReading {
        windows,
        read_at: now,
    })
}

/// `claude -p /usage`: a local command in print mode, answered without a model turn. No session
/// is kept, and the person's settings are not loaded, so their hooks and plugins do not run at
/// every probe (the sign-in is not a setting: it still applies). It runs in the probe's own
/// folder, whose project folder Claude Code still makes once, empty.
pub fn claude_probe(options: ProbeOptions) -> UsageProbe {
    let options = Arc::new(options);
    let runner = Runner::new(1);
    Arc::new(move || {
        let options = Arc::clone(&options);
        let runner = runner.clone();
        Box::pin(async move {
            let output = run_cli(
                &options,
                &runner,
                options.command_or("claude"),
                &[
                    "-p",
                    "/usage",
                    "--no-session-persistence",
                    "--setting-sources",
                    "project",
                    "--output-format",
                    "json",
                ],
                claude_env(&options.env),
                CLAUDE_TIMEOUT,
            )
            .await?;
            let output: Value = serde_json::from_slice(&output)
                .map_err(|error| format!("claude: the answer is not JSON: {error}"))?;
            let answered = !output.get("is_error").is_some_and(truthy);
            let Some(result) = output
                .get("result")
                .and_then(Value::as_str)
                .filter(|_| answered)
            else {
                return Err("claude: /usage gave no answer".to_owned());
            };
            Ok(parse_claude_usage(result, options.clock.now_ms())
                .map(|reading| Readings::from([("claude".to_owned(), reading)]))
                .unwrap_or_default())
        })
    })
}
