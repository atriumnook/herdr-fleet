//! The commands of `fleet` (`main` and `waitFor` of `bin/fleet.ts`), in its order of checks: the
//! usage first, then the options, then `--timeout`, then the command's own arguments, then the
//! request.

use std::time::{SystemTime, UNIX_EPOCH};

use protocol::fleet_cli::{
    ClearedBody, PlanBody, ReportBody, RolesBody, Run, RunBody, RunsBody, TextBody, ThreadsBody,
    UsageBody,
};
use protocol::js::{stringify_pretty, trim_end};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::args::{Parsed, parse};
use crate::describe::{self, lines, number, result_text, status_of, text};
use crate::http::{Client, Method};
use crate::js::{encode_uri_component as enc, parse_int, truthy};
use crate::texts::{GUIDE, USAGE};
use crate::time::zone;
use crate::{Context, Failure};

/// A JSON number as `JSON.stringify` writes it: an integer without a fraction.
fn js_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Value::from(value as i64)
    } else {
        serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}

/// A request body: fields in the order given, an undefined one left out (`JSON.stringify`).
#[derive(Default)]
struct Body(Map<String, Value>);

impl Body {
    fn put(mut self, key: &str, value: Option<Value>) -> Self {
        if let Some(value) = value {
            self.0.insert(key.to_string(), value);
        }
        self
    }

    fn text(self, key: &str, value: Option<&str>) -> Self {
        self.put(key, value.map(|v| Value::String(v.to_string())))
    }

    fn flag(self, key: &str, value: Option<bool>) -> Self {
        self.put(key, value.map(Value::Bool))
    }

    fn texts(self, key: &str, value: Option<&[String]>) -> Self {
        self.put(
            key,
            value.map(|v| Value::Array(v.iter().cloned().map(Value::String).collect())),
        )
    }

    fn done(self) -> Value {
        Value::Object(self.0)
    }
}

/// The answer read as `T`, one of the bodies of `protocol::fleet_cli`.
fn read<T: DeserializeOwned>(answer: &Value) -> Result<T, Failure> {
    serde_json::from_value(answer.clone()).map_err(|error| {
        Failure::new(
            format!("the fleet server's answer is not one the CLI reads: {error}"),
            1,
        )
    })
}

/// The field a command reads from the answer, which the TypeScript CLI fails without too.
fn needed<T>(value: Option<T>, field: &str) -> Result<T, Failure> {
    value.ok_or_else(|| Failure::new(format!("the fleet server's answer has no {field}"), 1))
}

/// The answer's run, read for the text and the exit status, and as the server wrote it for `--json`.
fn run_of(answer: &Value) -> Result<(Run, Value), Failure> {
    let run = needed(read::<RunBody>(answer)?.run, "run")?;
    let raw = needed(read::<RunBody<Value>>(answer)?.run, "run")?;
    Ok((run, raw))
}

/// What the commands share: the parsed options, the caller's fleet and the client.
struct Command<'c, 'a> {
    context: &'c mut Context<'a>,
    values: Parsed,
    json: bool,
    timeout: Option<f64>,
    client: Client,
    group: String,
    depth: f64,
    pane_id: Option<String>,
    caller_run: Option<String>,
}

impl Command<'_, '_> {
    /// `print`: the JSON value with `--json`, else the text.
    fn print(&mut self, value: &Value, text: impl FnOnce() -> String) {
        let output = if self.json {
            stringify_pretty(value)
        } else {
            text()
        };
        self.context.out(&output);
    }

    fn cwd(&self) -> String {
        match self.values.text("cwd") {
            Some(cwd) => cwd.to_string(),
            None => self.context.cwd.to_string_lossy().into_owned(),
        }
    }

    /// The agent the command names: its first positional.
    fn target(&self, command: &str) -> Result<String, Failure> {
        match truthy(self.values.positionals.first().map(String::as_str)) {
            Some(target) => Ok(target.to_string()),
            None => Err(Failure::usage(format!("fleet {command}: name the agent"))),
        }
    }

    fn group_body(&self) -> Body {
        Body::default().text("group", Some(&self.group))
    }

    /// The brief the flags give, or none when no brief flag is set; the server says which
    /// fields are missing, all at once.
    fn brief(&self) -> Result<Option<Value>, Failure> {
        let v = &self.values;
        let names = [
            "goal",
            "write",
            "read-only",
            "context",
            "done",
            "verify",
            "forbid",
            "timebox",
        ];
        if !names.iter().any(|name| v.has(name)) {
            return Ok(None);
        }
        let read_only = v.flag("read-only").is_some();
        if v.list("write").is_some() && read_only {
            return Err(Failure::usage("--write and --read-only do not go together"));
        }
        let write: Option<&[String]> = if read_only {
            Some(&[])
        } else {
            v.list("write")
        };
        Ok(Some(
            Body::default()
                .text("goal", v.text("goal"))
                .texts("write", write)
                .text("context", v.text("context"))
                .text("done", v.text("done"))
                .text("verify", v.text("verify"))
                .text("forbidden", v.text("forbid"))
                .text("timebox", v.text("timebox"))
                .done(),
        ))
    }

    /// Prints a run a command started or acted on, with the note the server added.
    fn print_started(&mut self, answer: &Value) -> Result<Run, Failure> {
        let (run, raw) = run_of(answer)?;
        self.print(&raw, || {
            let note = truthy(run.last_error.as_deref())
                .map(|e| format!("note: {e}"))
                .unwrap_or_default();
            lines(&[describe::run(&run), note])
        });
        Ok(run)
    }

    /// Waits for `target`; a run replaced after a failed first turn hands the wait to its
    /// replacement.
    fn wait_for(&mut self, target: &str) -> Result<i32, Failure> {
        let mut current = target.to_string();
        loop {
            let body = self
                .group_body()
                .put("timeout_ms", self.timeout.map(js_number))
                .done();
            let path = format!("/runs/{}/wait", enc(&current));
            let answer = match self.client.call(Method::Post, &path, Some(body)) {
                Ok(answer) => answer,
                Err(failure) => {
                    if failure.exit == 124
                        && let Some(raw) = &failure.run
                    {
                        let run: Run = serde_json::from_value(raw.clone()).unwrap_or_default();
                        self.print(raw, || {
                            format!(
                                "{}\nwait timed out; the agent is still {}",
                                describe::run(&run),
                                text(run.state.as_deref())
                            )
                        });
                    }
                    return Err(failure);
                }
            };
            let (run, raw) = run_of(&answer)?;
            if let Some(next) = truthy(run.replaced_by.as_deref()) {
                if !self.json {
                    self.context.err(&format!(
                        "{} failed on {} ({}); waiting for its re-spawn {next}",
                        text(run.name.as_deref()),
                        run.model.as_deref().unwrap_or("its model"),
                        run.last_error.as_deref().unwrap_or("error"),
                    ));
                }
                current = next.to_string();
                continue;
            }
            self.print(&raw, || {
                let error = truthy(run.last_error.as_deref())
                    .map(|e| format!("error: {e}"))
                    .unwrap_or_default();
                lines(&[describe::run(&run), error, result_text(&run)])
            });
            return Ok(status_of(&run));
        }
    }
}

/// `main` of `bin/fleet.ts`: the exit status, or why the command ended early.
pub fn main(argv: &[String], context: &mut Context) -> Result<i32, Failure> {
    let command = argv.first().map(String::as_str).unwrap_or("");
    if matches!(command, "" | "help" | "--help" | "-h") {
        context.out(USAGE);
        return Ok(if command.is_empty() { 2 } else { 0 });
    }
    let values =
        parse(&argv[1..]).map_err(|message| Failure::usage(format!("{message}\n\n{USAGE}")))?;
    let json = values.flag("json").is_some();
    let timeout = values.text("timeout").map(crate::js::number);
    if timeout.is_some_and(|t| !t.is_finite() || t < 1.0) {
        return Err(Failure::usage(
            "--timeout must be a positive number of milliseconds",
        ));
    }
    let pane_id = context.var("HERDR_PANE_ID").map(str::to_string);
    let group = match truthy(context.var("HERDR_FLEET_GROUP")) {
        Some(group) => group.to_string(),
        None => match truthy(pane_id.as_deref()) {
            Some(pane) => format!("fleet-{}", group_name(pane)),
            None => "fleet-default".to_string(),
        },
    };
    let depth = parse_int(context.var("HERDR_FLEET_DEPTH").unwrap_or("0"));
    let depth = if depth.is_nan() || depth == 0.0 {
        0.0
    } else {
        depth
    };
    let caller_run = truthy(context.var("HERDR_FLEET_RUN")).map(str::to_string);
    let client = Client::new(
        context.var("HERDR_FLEET_URL"),
        context.var("HERDR_FLEET_TOKEN"),
    );
    let mut c = Command {
        context,
        values,
        json,
        timeout,
        client,
        group,
        depth,
        pane_id,
        caller_run,
    };
    match command {
        "spawn" => spawn(&mut c),
        "thread" => thread(&mut c),
        "threads" => threads(&mut c),
        "plan" => plan(&mut c),
        "project" => project(&mut c),
        "guide" => {
            c.context.out(GUIDE);
            Ok(0)
        }
        "send" => send(&mut c),
        "wait" => {
            let target = c.target("wait")?;
            c.wait_for(&target)
        }
        "read" => read_output(&mut c),
        "list" => list(&mut c),
        "interrupt" | "focus" => press(&mut c, command),
        "close-done" => close_done(&mut c),
        "roles" => roles(&mut c),
        "usage" => usage(&mut c),
        "report" => report(&mut c),
        _ => Err(Failure::usage(format!(
            "unknown command: {command}\n\n{USAGE}"
        ))),
    }
}

/// `paneId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")`.
fn group_name(pane: &str) -> String {
    let mut out = String::new();
    let mut other = false;
    for c in pane.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' {
            out.push(c);
            other = false;
        } else if !other {
            out.push('-');
            other = true;
        }
    }
    out
}

fn spawn(c: &mut Command) -> Result<i32, Failure> {
    let brief = c.brief()?;
    let v = &c.values;
    if truthy(v.text("role")).is_none() || (truthy(v.text("task")).is_none() && brief.is_none()) {
        return Err(Failure::usage(
            "fleet spawn: --role and --task (or a brief) are required",
        ));
    }
    let body = Body::default()
        .text("role", v.text("role"))
        .text("task", v.text("task"))
        .put("brief", brief)
        .text("name", v.text("name"))
        .text("model", v.text("model"))
        .text("thinking", v.text("thinking"))
        .text("cwd", Some(&c.cwd()))
        .flag("worktree", v.flag("worktree"))
        .flag("interactive", v.flag("interactive"))
        .text("direction", v.text("direction"))
        .text("group", Some(&c.group))
        .put("depth", Some(js_number(c.depth)))
        .text("caller_pane_id", c.pane_id.as_deref())
        .texts("avoid", v.list("avoid"))
        .done();
    let answer = c.client.call(Method::Post, "/spawn", Some(body))?;
    if c.values.flag("wait").is_some() {
        let run = needed(read::<RunBody>(&answer)?.run, "run")?;
        return c.wait_for(text(run.id.as_deref()));
    }
    let run = c.print_started(&answer)?;
    Ok(blocked_or_zero(&run))
}

fn blocked_or_zero(run: &Run) -> i32 {
    if run.known_state() == Some(protocol::AgentState::Blocked) {
        4
    } else {
        0
    }
}

fn thread(c: &mut Command) -> Result<i32, Failure> {
    let brief = c.brief()?;
    let v = &c.values;
    if truthy(v.text("title")).is_none() || (truthy(v.text("task")).is_none() && brief.is_none()) {
        return Err(Failure::usage(
            "fleet thread: --title and --task (or a brief) are required",
        ));
    }
    let body = Body::default()
        .text("title", v.text("title"))
        .text("task", v.text("task"))
        .put("brief", brief)
        .text("cwd", Some(&c.cwd()))
        .put("depth", Some(js_number(c.depth)))
        .text("caller_run", c.caller_run.as_deref())
        .done();
    let answer = c.client.call(Method::Post, "/threads", Some(body))?;
    let run = c.print_started(&answer)?;
    Ok(blocked_or_zero(&run))
}

fn threads(c: &mut Command) -> Result<i32, Failure> {
    let caller = c
        .caller_run
        .as_deref()
        .map(|run| format!("&caller_run={}", enc(run)))
        .unwrap_or_default();
    let path = format!("/threads?cwd={}{caller}", enc(&c.cwd()));
    let answer = c.client.call(Method::Get, &path, None)?;
    let threads = needed(read::<ThreadsBody>(&answer)?.threads, "threads")?;
    let raw = needed(read::<ThreadsBody<Value>>(&answer)?.threads, "threads")?;
    c.print(&Value::Array(raw), || {
        if threads.is_empty() {
            "no threads".to_string()
        } else {
            threads
                .iter()
                .map(describe::thread)
                .collect::<Vec<_>>()
                .join("\n")
        }
    });
    Ok(0)
}

fn plan(c: &mut Command) -> Result<i32, Failure> {
    let positionals = &c.values.positionals;
    let file = match truthy(positionals.first().map(String::as_str)) {
        Some(file) if positionals.len() == 1 => file.to_string(),
        _ => {
            return Err(Failure::usage(
                "fleet plan: give the plan's JSON file (- for stdin)",
            ));
        }
    };
    let Some(caller_run) = c.caller_run.clone() else {
        return Err(Failure::usage(
            "fleet plan: only a thread's lead the fleet started writes a plan (HERDR_FLEET_RUN is not set)",
        ));
    };
    let bytes = if file == "-" {
        let mut bytes = Vec::new();
        c.context
            .stdin
            .read_to_end(&mut bytes)
            .map_err(|error| Failure::new(error.to_string(), 1))?;
        bytes
    } else {
        std::fs::read(c.context.cwd.join(&file))
            .map_err(|error| Failure::usage(format!("cannot read {file}: {error}")))?
    };
    // decoded as Bun's text() does: invalid UTF-8 replaced, a byte order mark dropped
    let decoded = String::from_utf8_lossy(&bytes);
    let decoded = decoded.strip_prefix('\u{feff}').unwrap_or(&decoded);
    let plan: Value = serde_json::from_str(decoded)
        .map_err(|error| Failure::usage(format!("{file} is not JSON: {error}")))?;
    let body = Body::default()
        .put("plan", Some(plan))
        .text("group", Some(&c.group))
        .done();
    let path = format!("/runs/{}/plan", enc(&caller_run));
    let answer = c.client.call(Method::Post, &path, Some(body))?;
    let saved = needed(read::<PlanBody>(&answer)?.plan, "plan")?;
    let raw = needed(read::<PlanBody<Value>>(&answer)?.plan, "plan")?;
    c.print(&raw, || {
        format!(
            "plan \"{}\" version {} is on the Fleet screen. End your turn with a BLOCKED HANDOFF that says the plan waits for the person; their answers come back as your next task.",
            text(saved.title.as_deref()),
            number(saved.version)
        )
    });
    Ok(0)
}

fn project(c: &mut Command) -> Result<i32, Failure> {
    let Some(task) = truthy(c.values.text("task")).map(str::to_string) else {
        return Err(Failure::usage("fleet project: --task is required"));
    };
    // an agent the fleet started reports to whoever started it (its instructions), never past
    // it to the coordinator
    if c.caller_run.is_some() {
        return Err(Failure::usage(
            "fleet project: the fleet's own agents do not call the coordinator; report as your instructions say",
        ));
    }
    let body = Body::default()
        .text("task", Some(&task))
        .text("cwd", Some(&c.cwd()))
        .text("from_pane", truthy(c.pane_id.as_deref()))
        .done();
    let answer = c.client.call(Method::Post, "/projects", Some(body))?;
    let run = c.print_started(&answer)?;
    Ok(blocked_or_zero(&run))
}

fn send(c: &mut Command) -> Result<i32, Failure> {
    let message = c.values.positionals.get(1..).unwrap_or_default().join(" ");
    if message.is_empty() {
        return Err(Failure::usage("fleet send: give the message"));
    }
    let target = c.target("send")?;
    let body = Body::default()
        .text("message", Some(&message))
        .text("group", Some(&c.group))
        .done();
    let answer = c.client.call(
        Method::Post,
        &format!("/runs/{}/send", enc(&target)),
        Some(body),
    )?;
    let (run, raw) = run_of(&answer)?;
    c.print(&raw, || describe::run(&run));
    Ok(match run.known_state() {
        Some(protocol::AgentState::Failed) => 1,
        Some(protocol::AgentState::Blocked) => 4,
        _ => 0,
    })
}

fn read_output(c: &mut Command) -> Result<i32, Failure> {
    let target = c.target("read")?;
    let lines = truthy(c.values.text("lines"))
        .map(|n| format!("&lines={}", enc(n)))
        .unwrap_or_default();
    let path = format!("/runs/{}/read?group={}{lines}", enc(&target), enc(&c.group));
    let answer = c.client.call(Method::Get, &path, None)?;
    let text = needed(read::<TextBody>(&answer)?.text, "text")?;
    let raw = serde_json::json!({ "text": text });
    c.print(&raw, || trim_end(&text).to_string());
    Ok(0)
}

fn list(c: &mut Command) -> Result<i32, Failure> {
    let all = c.values.flag("all").is_some();
    let path = if all {
        "/runs".to_string()
    } else {
        format!("/runs?group={}", enc(&c.group))
    };
    let answer = c.client.call(Method::Get, &path, None)?;
    let runs = needed(read::<RunsBody>(&answer)?.runs, "runs")?;
    let raw = needed(read::<RunsBody<Value>>(&answer)?.runs, "runs")?;
    c.print(&Value::Array(raw), || {
        if runs.is_empty() {
            return "no agents".to_string();
        }
        runs.iter()
            .map(|run| {
                let group = if all {
                    format!("  [{}]", text(run.group.as_deref()))
                } else {
                    String::new()
                };
                format!("{}{group}", describe::run(run))
            })
            .collect::<Vec<_>>()
            .join("\n")
    });
    Ok(0)
}

fn press(c: &mut Command, command: &str) -> Result<i32, Failure> {
    let target = c.target(command)?;
    let path = format!("/runs/{}/{command}", enc(&target));
    let answer = c
        .client
        .call(Method::Post, &path, Some(c.group_body().done()))?;
    let (run, raw) = run_of(&answer)?;
    c.print(&raw, || describe::run(&run));
    Ok(0)
}

fn close_done(c: &mut Command) -> Result<i32, Failure> {
    let answer = c
        .client
        .call(Method::Post, "/close-done", Some(c.group_body().done()))?;
    let runs = needed(read::<RunsBody>(&answer)?.runs, "runs")?;
    let raw = needed(read::<RunsBody<Value>>(&answer)?.runs, "runs")?;
    c.print(&Value::Array(raw), || {
        if runs.is_empty() {
            "nothing to close".to_string()
        } else {
            runs.iter()
                .map(|run| format!("closed {}", describe::run(run)))
                .collect::<Vec<_>>()
                .join("\n")
        }
    });
    Ok(0)
}

fn roles(c: &mut Command) -> Result<i32, Failure> {
    let path = format!("/roles?cwd={}", enc(&c.cwd()));
    let answer = c.client.call(Method::Get, &path, None)?;
    let roles = needed(read::<RolesBody>(&answer)?.roles, "roles")?;
    let raw = needed(read::<RolesBody<Value>>(&answer)?.roles, "roles")?;
    c.print(&Value::Array(raw), || {
        roles
            .iter()
            .map(describe::role)
            .collect::<Vec<_>>()
            .join("\n")
    });
    Ok(0)
}

/// Milliseconds since 1970 (`Date.now()`).
fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn usage(c: &mut Command) -> Result<i32, Failure> {
    let positionals = c.values.positionals.clone();
    if positionals.first().map(String::as_str) == Some("clear") {
        let body = Body::default()
            .text("key", truthy(positionals.get(1).map(String::as_str)))
            .done();
        let answer = c.client.call(Method::Post, "/usage/clear", Some(body))?;
        let cleared = needed(read::<ClearedBody>(&answer)?.cleared, "cleared")?;
        let raw = answer.get("cleared").cloned().unwrap_or(Value::Null);
        c.print(&raw, || {
            if cleared.is_empty() {
                "nothing was cooling down".to_string()
            } else {
                format!("cleared {}", cleared.join(", "))
            }
        });
        return Ok(0);
    }
    if !positionals.is_empty() {
        return Err(Failure::usage("fleet usage: the only subcommand is clear"));
    }
    let body = Body::default()
        .flag("all", Some(c.values.flag("refresh").unwrap_or(false)))
        .done();
    let answer = c.client.call(Method::Post, "/usage/refresh", Some(body))?;
    let usage = needed(read::<UsageBody>(&answer)?.usage, "usage")?;
    let raw = needed(read::<UsageBody<Value>>(&answer)?.usage, "usage")?;
    let zone = zone(c.context.env);
    let now = now_ms();
    c.print(&Value::Array(raw), || {
        if usage.is_empty() {
            "no usage known yet".to_string()
        } else {
            usage
                .iter()
                .map(|entry| describe::usage(entry, now, &zone))
                .collect::<Vec<_>>()
                .join("\n")
        }
    });
    Ok(0)
}

fn report(c: &mut Command) -> Result<i32, Failure> {
    let hours = match c.values.text("hours") {
        None => 24.0,
        Some(hours) => crate::js::number(hours),
    };
    if !hours.is_finite() || hours <= 0.0 {
        return Err(Failure::usage("--hours must be a positive number"));
    }
    let planned = truthy(c.values.text("planned-label"))
        .map(|label| format!("&planned_label={}", enc(label)))
        .unwrap_or_default();
    // checked as a number, then encoded: `1e+21` would reach the server as `1e 21` (#189)
    let path = format!(
        "/report?cwd={}&hours={}{planned}",
        enc(&c.cwd()),
        enc(&protocol::js::number_to_string(hours))
    );
    let answer = c.client.call(Method::Get, &path, None)?;
    let report = needed(read::<ReportBody>(&answer)?.report, "report")?;
    c.print(&Value::String(report.clone()), || report);
    Ok(0)
}
