//! `agy -p /usage --output-format json`, and the readings in its answer
//! (`server/fleet/usage.ts:51-71, 461-467`).

use std::sync::Arc;
use std::time::Duration;

use child_process::{Runner, child_env};
use jiff::tz::TimeZone;
use protocol::{UsageReading, UsageWindow};
use serde_json::Value;

use super::js_time::{date_parse, js_round};
use super::probe::{ProbeOptions, Readings, UsageProbe, run_cli};

/// How long `agy -p /usage` may run (`usage.ts:466`).
pub const AGY_TIMEOUT: Duration = Duration::from_secs(30);

/// `agy -p /usage --output-format json`: buckets of remaining share per model group, keyed by
/// bucket id (`gemini-5h`, `3p-weekly`): the `gemini…` ones are `agy:gemini`'s, the others
/// `agy:3p`'s. A share is `Math.round((1 - remaining) * 1000) / 10` percent used; a reset time is
/// read as `Date.parse` reads it, a time without an offset in `time_zone`. `now` is the readings'
/// time.
pub fn parse_agy_usage(output: &Value, now: i64, time_zone: &TimeZone) -> Readings {
    let mut readings = Readings::new();
    let groups = output
        .get("command")
        .filter(|command| command.is_object())
        .and_then(|command| command.get("data"))
        .filter(|data| data.is_object())
        .and_then(|data| data.get("groups"))
        .and_then(Value::as_array);
    let buckets = groups
        .into_iter()
        .flatten()
        .filter_map(|group| group.get("buckets").and_then(Value::as_array))
        .flatten();
    for bucket in buckets {
        let (Some(id), Some(remaining)) = (
            bucket.get("id").and_then(Value::as_str),
            bucket.get("remaining_fraction").and_then(Value::as_f64),
        ) else {
            continue;
        };
        let key = if id.starts_with("gemini") {
            "agy:gemini"
        } else {
            "agy:3p"
        };
        let window = UsageWindow {
            name: bucket
                .get("window")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .to_owned(),
            used_percent: js_round((1.0 - remaining) * 1000.0) / 10.0,
            resets_at: bucket
                .get("reset_time")
                .and_then(Value::as_str)
                .and_then(|text| date_parse(text, time_zone)),
        };
        readings
            .entry(key.to_owned())
            .or_insert_with(|| UsageReading {
                windows: Vec::new(),
                read_at: now as f64,
            })
            .windows
            .push(window);
    }
    readings
}

/// `agy -p /usage`: answered by the CLI without a model turn. Auto-update is held off (`true`,
/// not `1`).
pub fn agy_probe(options: ProbeOptions) -> UsageProbe {
    let options = Arc::new(options);
    let runner = Runner::new(1);
    Arc::new(move || {
        let options = Arc::clone(&options);
        let runner = runner.clone();
        Box::pin(async move {
            let mut env = child_env(&options.env, &[]);
            env.insert("AGY_CLI_DISABLE_AUTO_UPDATE".into(), "true".into());
            let program = options.command_or("agy");
            let output = run_cli(
                &options,
                &runner,
                program,
                &["-p", "/usage", "--output-format", "json"],
                env,
                AGY_TIMEOUT,
            )
            .await?;
            let output: Value = serde_json::from_slice(&output).map_err(|error| {
                format!(
                    "{}: the answer is not JSON: {error}",
                    program.to_string_lossy()
                )
            })?;
            Ok(parse_agy_usage(
                &output,
                options.clock.now_ms(),
                &options.time_zone,
            ))
        })
    })
}
