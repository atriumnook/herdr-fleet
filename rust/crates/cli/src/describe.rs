//! The lines the CLI prints for a run, a thread, a subscription's usage and a role
//! (`describe`, `describeThread`, `describeUsage` and the `roles` line of `bin/fleet.ts`).
//! A field the answer leaves out prints as `undefined`, as a template literal writes it, and
//! never fails (ADR 0107-crate-split); numbers are written as JavaScript writes them.

use jiff::tz::TimeZone;
use protocol::fleet_cli::{Run, ThreadSummary, UsageEntry};
use protocol::js::{number_to_string, trim_end};
use protocol::{AgentState, ContractState, ThreadState};

use crate::js::{pad_end, truthy};
use crate::time::locale_string;

/// How a template literal writes an optional string.
pub fn text(value: Option<&str>) -> &str {
    value.unwrap_or("undefined")
}

/// How a template literal writes an optional number.
pub fn number(value: Option<f64>) -> String {
    value.map_or_else(|| "undefined".to_string(), number_to_string)
}

/// `<id>  <name> (<role>, <agent>[, <model>])  <state>  pane <pane>`.
pub fn run(run: &Run) -> String {
    let model = truthy(run.model.as_deref())
        .map(|m| format!(", {m}"))
        .unwrap_or_default();
    format!(
        "{}  {} ({}, {}{model})  {}  pane {}",
        text(run.id.as_deref()),
        text(run.name.as_deref()),
        text(run.role.as_deref()),
        text(run.agent.as_deref()),
        text(run.state.as_deref()),
        text(run.pane_id.as_deref()),
    )
}

/// The exit status a settled run gives: 4 blocked on a question, 1 failed or stopped, else 0.
pub fn status_of(run: &Run) -> i32 {
    match run.known_state() {
        Some(AgentState::Blocked) => 4,
        Some(AgentState::Failed | AgentState::Stopped) => 1,
        _ => 0,
    }
}

/// The handoff the agent wrote to its result file; without one, its screen.
pub fn result_text(run: &Run) -> String {
    match truthy(run.result.as_deref()).or(truthy(run.last_output.as_deref())) {
        Some(text) => format!("\n{}", trim_end(text)),
        None => String::new(),
    }
}

/// The non-empty parts, one per line (`[…].filter(Boolean).join("\n")`).
pub fn lines(parts: &[String]) -> String {
    parts
        .iter()
        .filter(|p| !p.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
}

fn thread_state(state: ThreadState) -> &'static str {
    match state {
        ThreadState::Working => "Working",
        ThreadState::Waiting => "Needs you",
        ThreadState::Review => "Ready for review",
        ThreadState::Landing => "Landing",
        ThreadState::Idle => "Idle",
        ThreadState::Failed => "Failed",
        ThreadState::Ended => "Ended",
        ThreadState::Resolved => "Resolved",
    }
}

fn contract_mark(state: ContractState) -> &'static str {
    match state {
        ContractState::Met => "✓",
        ContractState::Open => "·",
        ContractState::Unmet => "✗",
    }
}

/// A thread: its run, state and branch, then its HANDOFF status line, contract and pull request.
pub fn thread(thread: &ThreadSummary) -> String {
    let none = Run::default();
    let run = thread.run.as_ref().unwrap_or(&none);
    let state = thread.known_state().map_or("undefined", thread_state);
    let branch = truthy(run.branch.as_deref())
        .map(|b| format!("  {b}"))
        .unwrap_or_default();
    let contract = match &thread.contract {
        Some(items) if !items.is_empty() => format!(
            "    Contract: {}",
            items
                .iter()
                .map(|item| format!(
                    "{} {}",
                    text(item.id.as_deref()),
                    item.known_state().map_or("undefined", contract_mark)
                ))
                .collect::<Vec<_>>()
                .join(" ")
        ),
        _ => String::new(),
    };
    let pr = run.pr.as_ref().map_or_else(String::new, |pr| {
        format!(
            "    PR #{} {}, checks {}: {}",
            number(pr.number),
            pr.state
                .as_deref()
                .map_or_else(|| "undefined".to_string(), str::to_lowercase),
            text(pr.checks.as_deref()),
            text(pr.url.as_deref()),
        )
    });
    lines(&[
        format!(
            "{}  {}  {state}{branch}",
            text(run.id.as_deref()),
            text(run.name.as_deref())
        ),
        truthy(thread.status.as_deref())
            .map(|s| format!("    {s}"))
            .unwrap_or_default(),
        contract,
        pr,
    ])
}

/// A number's truthiness: present, not 0 and not NaN.
fn truthy_number(value: Option<f64>) -> Option<f64> {
    value.filter(|v| *v != 0.0 && !v.is_nan())
}

/// A subscription: its windows and when it was read, a cooldown that has not ended at `now`
/// (milliseconds since 1970), and the last failed read.
pub fn usage(entry: &UsageEntry, now: f64, zone: &TimeZone) -> String {
    let time = |ms: Option<f64>| locale_string(ms.unwrap_or(f64::NAN), zone);
    let windows = entry
        .reading
        .as_ref()
        .and_then(|r| r.windows.as_ref())
        .map(|windows| {
            windows
                .iter()
                .map(|w| {
                    let resets = truthy_number(w.resets_at)
                        .map(|at| format!(" (resets {})", time(Some(at))))
                        .unwrap_or_default();
                    format!(
                        "{} {}%{resets}",
                        text(w.name.as_deref()),
                        number(w.used_percent)
                    )
                })
                .collect::<Vec<_>>()
                .join(", ")
        });
    let read = entry
        .reading
        .as_ref()
        .map(|r| format!("  read {}", time(r.read_at)))
        .unwrap_or_default();
    let cooldown = entry
        .cooldown
        .as_ref()
        .filter(|c| c.until.is_some_and(|until| until > now))
        .map(|c| {
            format!(
                "             cooling down until {}: {}",
                time(c.until),
                text(c.reason.as_deref())
            )
        })
        .unwrap_or_default();
    let error = truthy(entry.error.as_deref())
        .map(|e| format!("             last read failed: {e}"))
        .unwrap_or_default();
    lines(&[
        format!(
            "{} {}{read}",
            pad_end(text(entry.key.as_deref()), 12),
            windows.as_deref().unwrap_or("no reading")
        ),
        cooldown,
        error,
    ])
}

/// A role that can be spawned: its name, its CLI and what it does.
pub fn role(role: &protocol::fleet_cli::Role) -> String {
    format!(
        "{} {} {}",
        pad_end(text(role.name.as_deref()), 12),
        pad_end(text(role.agent.as_deref()), 6),
        text(role.description.as_deref())
    )
}
