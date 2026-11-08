//! The looks of each adapter of server/fleet/adapters.ts, in its order there.

use std::sync::LazyLock;

use protocol::js;
use regex::Regex;

use super::vt::strip_vt;
use super::{js_lines, last_match, open_question};
use crate::ScreenChecks;
use crate::text::{js_regex, split_lines};

/// `/^\s*(?:Error|error): (.+)$/gm`, the error line most CLIs leave.
static ERROR_LINE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^{s}*(?:Error|error): ({.}+)$"));

/// `lastMatch(screen, /^\s*(?:Error|error): (.+)$/gm)`.
fn error_line(screen: &str) -> Option<String> {
    last_match(screen, &ERROR_LINE)
}

static PI_ERROR: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^{s}*Error: ({.}+)$"));
static PI_TURN_ERROR: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^{s}*Error: ({.}+?){s}*$"));

pub(super) const PI: ScreenChecks = ScreenChecks {
    startup_error: |screen| last_match(screen, &PI_ERROR),
    question: None,
    ready_error: None,
    input_ready: None,
    draft: Some(pi_draft),
    turn_error: pi_turn_error,
};

/// pi's input sits between the last two horizontal rules, with no prompt mark: empty, it holds only
/// the cursor (a reverse-video space).
fn pi_draft(screen: &str) -> bool {
    let plain = strip_vt(screen);
    let lines = split_lines(&plain);
    let rules: Vec<usize> = (0..lines.len())
        .filter(|&at| js::trim(lines[at]).starts_with("───"))
        .collect();
    let [.., above, below] = rules[..] else {
        return false;
    };
    !js::trim(&lines[above + 1..below].concat()).is_empty()
}

/// `piTurnError`: pi prints an exhausted request as a line `Error: <reason>` and ends the turn. A
/// turn that did its work ends with the HANDOFF section the fleet asks for, so an `Error:` line
/// without one is a failed turn; an error quoted inside a real handoff is not.
fn pi_turn_error(output: &str) -> Option<String> {
    if output.contains("HANDOFF") {
        return None;
    }
    last_match(output, &PI_TURN_ERROR)
}

/// Claude's input line: `❯` and a no-break space after any SGR sequences.
static CLAUDE_INPUT: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"^(?:\x1b\[[0-9;]*m)*❯\x{a0}({.}*)$"));
static CLAUDE_API_ERROR: LazyLock<Regex> = LazyLock::new(|| js_regex(r"API Error: ?({.}+)$"));

pub(super) const CLAUDE: ScreenChecks = ScreenChecks {
    startup_error: error_line,
    question: None,
    ready_error: None,
    input_ready: None,
    draft: Some(claude_draft),
    turn_error: |output| last_match(output, &CLAUDE_API_ERROR),
};

/// The input line opens with ❯ and a no-break space; the placeholder there is dim, a draft is not.
fn claude_draft(screen: &str) -> bool {
    let Some(line) = js_lines(screen)
        .filter_map(|(_, line)| CLAUDE_INPUT.captures(line))
        .last()
    else {
        return false;
    };
    let mut text = line.get(1).map_or("", |group| group.as_str());
    while let Some(rest) = text.strip_prefix("\x1b[0m") {
        text = rest;
    }
    !text.starts_with("\x1b[2m") && !js::trim(&strip_vt(text)).is_empty()
}

/// Codex shows a failed request as a `■ <reason>` line once its retries are spent.
static CODEX_FAILED: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^{s}*■{s}+({.}+)$"));

pub(super) const CODEX: ScreenChecks = ScreenChecks {
    startup_error: error_line,
    question: None,
    ready_error: None,
    input_ready: None,
    draft: None,
    turn_error: |output| last_match(output, &CODEX_FAILED),
};

/// cursor's empty input line.
static CURSOR_INPUT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("Plan, search, build anything").unwrap());
static CURSOR_TRUST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("Workspace Trust Required").unwrap());

/// Cursor Agent asks to trust every folder it is given, after herdr already called it ready (which
/// herdr reports as idle).
pub(super) const CURSOR: ScreenChecks = ScreenChecks {
    startup_error: error_line,
    question: Some(cursor_question),
    ready_error: None,
    input_ready: Some(|screen| CURSOR_INPUT.is_match(screen)),
    draft: None,
    turn_error: error_line,
};

fn cursor_question(screen: &str) -> Option<String> {
    let input_at = CURSOR_INPUT
        .find_iter(screen)
        .last()
        .map(|found| found.start());
    open_question(
        screen,
        input_at,
        &[(
            &CURSOR_TRUST,
            "Cursor Agent asks whether to trust this folder.",
        )],
    )
}

/// agy's input: a `>` line between rules, empty or holding the auto mode's hint until something is
/// typed (`> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)`, as herdr reads
/// it). A message or an option after `>` is not it. `AGY_INPUT`, matched line by line.
static AGY_INPUT: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"^{s}*>(?:{s}+Auto mode: {.}*)?{s}*$"));
/// The auto mode on agy's last line, `auto · ` before the model; `\b` is JavaScript's.
static AGY_AUTO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?-u:\b)auto · ").unwrap());
static AGY_TRUST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"Do you trust the contents of this project\?").unwrap());
static AGY_SIGN_IN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("You are currently not signed in").unwrap());
static AGY_PERMISSION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("Requesting permission for:").unwrap());
static AGY_FILE_ACCESS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"Allow access to this file\?").unwrap());
static AGY_UNKNOWN_MODEL: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"model ({S}+) is not recognized as a known model"));
static AGY_CONFLICT: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"--model ({S}+) conflicts with --effort=({S}+?)\."));

/// Antigravity CLI: herdr reports its trust, sign-in and approval screens as idle (its file access
/// screen as done), and an unknown model is swapped for the default one with only a warning.
pub(super) const AGY: ScreenChecks = ScreenChecks {
    startup_error: error_line,
    question: Some(agy_question),
    ready_error: Some(agy_ready_error),
    input_ready: Some(agy_input_ready),
    draft: None,
    turn_error: error_line,
};

/// The byte index of the last line `AGY_INPUT` matches.
fn agy_input_at(screen: &str) -> Option<usize> {
    js_lines(screen)
        .filter(|(_, line)| AGY_INPUT.is_match(line))
        .map(|(at, _)| at)
        .last()
}

/// The mode from --settings is set some seconds after the input shows (`auto · ` before the model
/// on its last line): a task typed before would run in the default mode, which asks before every
/// command.
fn agy_input_ready(screen: &str) -> bool {
    agy_input_at(screen).is_some() && AGY_AUTO.is_match(screen)
}

fn agy_question(screen: &str) -> Option<String> {
    open_question(
        screen,
        agy_input_at(screen),
        &[
            (
                &AGY_TRUST,
                "Antigravity CLI asks whether to trust this folder.",
            ),
            (&AGY_SIGN_IN, "Antigravity CLI is not signed in."),
            (
                &AGY_PERMISSION,
                "Antigravity CLI asks for permission to use a tool.",
            ),
            // asked in auto mode too, for a file outside the run's folders and the ones given with
            // --add-dir
            (
                &AGY_FILE_ACCESS,
                "Antigravity CLI asks to read a file outside its workspace.",
            ),
        ],
    )
}

fn agy_ready_error(screen: &str) -> Option<String> {
    if let Some(unknown) = AGY_UNKNOWN_MODEL.captures(screen) {
        return Some(format!(
            "Unknown model {}: Antigravity CLI would run its default model instead.",
            &unknown[1]
        ));
    }
    AGY_CONFLICT.captures(screen).map(|conflict| {
        format!(
            "The model {} does not take the level {}: Antigravity CLI would run its default model instead.",
            &conflict[1], &conflict[2]
        )
    })
}

/// `NOT_OPENCODE_2`.
const NOT_OPENCODE_2: &str = "The opencode that herdr starts is not OpenCode 2 (check `opencode --version`); the fleet's rules for it need version 2.";
/// The help that opencode 1.x answers `--standalone` with (v1.19.0).
static OPENCODE_1_HELP: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"opencode \[project\]{s}+start opencode tui"));
/// A line of text in OpenCode's input box, two columns after the bar.
static OPENCODE_INPUT_TEXT: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^┃ {2}({S}{.}*)$"));
static OPENCODE_RETRY: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"^⚠ Retry(?:ing in {S}+| due) · attempt [0-9]+ · ({.}+)$"));
static OPENCODE_ERROR: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^Error: ({.}+)$"));
/// The agent, model and time that end a turn (`build · model · 595ms`), or the time alone.
static OPENCODE_TURN_END: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"^(?:{.}+ · )?[0-9][0-9.]*m?s$"));

/// OpenCode 2. The screens were seen on v2.0.26: a new session, a draft, a failed turn, the
/// permission prompt and the retry line. It has no ready check: an opencode that is not version 2 is
/// refused while starting.
pub(super) const OPENCODE: ScreenChecks = ScreenChecks {
    startup_error: opencode_startup_error,
    question: Some(opencode_question),
    ready_error: None,
    input_ready: None,
    draft: Some(opencode_draft),
    turn_error: opencode_turn_error,
};

/// The input is a box of `┃` rows that ends above a `╹▀▀▀` line: padding, the text, padding, and
/// last the agent and model; empty, it shows a "Ask anything…" placeholder.
fn opencode_draft(screen: &str) -> bool {
    let plain = strip_vt(screen);
    let lines: Vec<&str> = split_lines(&plain).into_iter().map(js::trim).collect();
    let Some(bottom) = lines.iter().rposition(|line| line.starts_with("╹▀")) else {
        return false;
    };
    let mut top = bottom;
    while top > 0 && lines[top - 1].starts_with('┃') {
        top -= 1;
    }
    // `lines.slice(top, bottom - 1)`: a box's bottom on the first line makes the end -1, which
    // `slice` counts from the end
    let end = if bottom == 0 {
        lines.len() - 1
    } else {
        bottom - 1
    };
    // text starts two columns after the bar; a toast drawn over the box's right side (`Getting
    // started`) starts far from it
    lines.get(top..end).unwrap_or_default().iter().any(|line| {
        OPENCODE_INPUT_TEXT
            .captures(line)
            .is_some_and(|text| !text[1].starts_with("Ask anything…"))
    })
}

/// herdr starts the executable named `opencode`, which may still be 1.x: it answers --standalone
/// with its help text and exit code 1 (v1.19.0; its TUI is not started, so the screen is that help).
fn opencode_startup_error(screen: &str) -> Option<String> {
    if OPENCODE_1_HELP.is_match(screen) {
        Some(NOT_OPENCODE_2.to_owned())
    } else {
        error_line(screen)
    }
}

/// The permission request replaces the input; once answered it leaves the screen. Its title is
/// shortened to `Permission` on a narrow pane.
fn opencode_question(screen: &str) -> Option<String> {
    let plain = strip_vt(screen);
    (plain.contains("△ Permission") && plain.contains("Allow once") && plain.contains("Reject"))
        .then(|| "OpenCode asks for permission.".to_owned())
}

/// `opencodeTurnError`: while it retries a failed request, `⚠ Retrying in 12s · attempt 2 · <reason>`
/// (`⚠ Retry due · ...` once the wait is over), the reason wrapping onto the next line on a narrow
/// pane. A request it gives up on ends in `Error: <reason>`, a blank line and the agent, model and
/// time of the turn (`... · 595ms`): an `Error:` line in a tool's output is not that.
fn opencode_turn_error(output: &str) -> Option<String> {
    let lines: Vec<&str> = split_lines(output).into_iter().map(js::trim).collect();
    let handoff = output.contains("HANDOFF");
    let mut found: Option<String> = None;
    for (at, line) in lines.iter().enumerate() {
        let next = lines.get(at + 1).copied();
        if let Some(retry) = OPENCODE_RETRY.captures(line) {
            let reason = &retry[1];
            found = Some(match next {
                Some(next)
                    if !next.is_empty() && !next.contains(" · ") && !next.starts_with('┃') =>
                {
                    format!("{reason} {next}")
                }
                _ => reason.to_owned(),
            });
            continue;
        }
        let Some(error) = OPENCODE_ERROR.captures(line) else {
            continue;
        };
        let end = if next == Some("") {
            lines.get(at + 2).copied()
        } else {
            next
        };
        if !handoff && OPENCODE_TURN_END.is_match(end.unwrap_or("")) {
            found = Some(error[1].to_owned());
        }
    }
    found
        .map(|text| js::trim(&text).to_owned())
        .filter(|text| !text.is_empty())
}
