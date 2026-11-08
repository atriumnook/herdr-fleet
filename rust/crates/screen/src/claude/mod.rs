//! Claude Code's cards (its questions, the review of several answers, approvals, plans and
//! unnumbered menus) and the prompt it suggests next (server/prompt.ts:416-820, 1407-1471).
//! Each card's reader is a file of its own; this file holds what they share: which reader read a
//! card, the order they are tried in, and whether the menu a card was read from still ends the
//! screen (`promptTailIsActive` for Claude's responders, with `withoutClaudeTasks`).

mod approval;
mod confirm;
mod preview;
mod question;
mod review;
mod suggestion;

use std::sync::LazyLock;

use regex::Regex;

use crate::ParsedPrompt;
use crate::text::{clean_line, ends, find_last_index, js_regex, visible_lines};

pub(crate) use suggestion::suggestion;

/// Which of Claude Code's readers read a card (TypeScript's `claude-*` responders).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Responder {
    /// a question, of one choice or several (`claude-question`)
    Question,
    /// the review of several answers before they are sent (`claude-submit`)
    Submit,
    /// a tool's approval (`claude-approval`)
    Approval,
    /// the plan Claude asks to execute (`claude-plan`)
    Plan,
    /// an unnumbered menu, such as the folder-trust check (`claude-confirm`)
    Confirm,
}

/// Claude Code's parsers, in the order `parsePrompt` tries them (server/prompt.ts:1121).
pub(crate) const PARSERS: &[fn(&str) -> Option<ParsedPrompt>] = &[
    question::parse,
    review::parse,
    approval::parse,
    confirm::parse,
];

/// `CLAUDE_ASK_HINT_RE`: the hint under a question; several questions navigate between tabs.
static ASK_HINT: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(r"(?i)enter to select{.}*(?:↑/↓|tab/arrow keys) to navigate{.}*esc to cancel")
});
/// `CLAUDE_TABS_RE`: question tabs, whole (`←  ☒ Route  ☐ Author  ✔ Submit  →`) or cut off by a
/// narrow pane.
static TABS: LazyLock<Regex> = LazyLock::new(|| js_regex("^←{s}+[☐☒☑✔]"));
/// `CLAUDE_CONFIRM_HINT_RE`: the hint under Claude Code's unnumbered menus.
static CONFIRM_HINT: LazyLock<Regex> =
    LazyLock::new(|| js_regex("(?i)enter to confirm{.}*esc to (?:cancel|exit|go back)"));
/// `SOLID_RULE_RE`.
static SOLID_RULE: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[─━]{8,}$").unwrap());

/// The end of an approval: Claude Code 2.1.29x ends with "Esc to cancel", optionally followed by its
/// stop-agents chord, anchored so arbitrary trailing text cannot keep an old approval live.
static APPROVAL_TAIL: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(concat!(
        r"(?i)esc to cancel{.}*(?:tab|ctrl\+e)|ctrl\+e to explain",
        r"|^esc to cancel(?:{s}*·{s}*ctrl\+x ctrl\+k twice to stop background agents)?$",
    ))
});
/// The end of a plan's menu.
static PLAN_TAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)ctrl\+g to edit|shift\+tab to approve with this feedback").unwrap()
});

/// `CLAUDE_TASKS_HEAD_RE`: the head of Claude Code's task list, `3 tasks (0 done, 1 in progress, 2 open)`.
static TASKS_HEAD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]+) tasks \([0-9]+ done, (?:[0-9]+ in progress, )?[0-9]+ open\)$").unwrap()
});
/// `CLAUDE_TASK_ROW_RE`: a task's row.
static TASK_ROW: LazyLock<Regex> = LazyLock::new(|| js_regex("^[◻◼✔]{s}"));
/// `CLAUDE_TASKS_MORE_RE`: the count of the tasks the list does not show.
static TASKS_MORE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^…{s}\+[0-9]+ pending$"));
/// A line that is a prompt or a bullet of its own, never a task's activity.
static PROMPT_OR_BULLET: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[❯>›●⏺]").unwrap());
/// `LABELED_RULE_RE`: the session's rule, with its name on it.
static LABELED_RULE: LazyLock<Regex> = LazyLock::new(|| js_regex("^─{3,}{s}{.}*─$"));
/// `CLAUDE_HINT_TAIL_RE`.
static HINT_TAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?-u:\b)esc to (?:cancel|exit|go back)(?-u:\b)").unwrap());
/// `CLAUDE_SUBMIT_TAIL_RE`: the last row of Claude's review of several answers, which ends it in
/// place of a hint.
static SUBMIT_TAIL: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"(?i)^(?:[›>❯]{s}*)?[0-9]+\.{s}+Cancel$"));

/// Whether the menu a card of Claude Code's was read from still ends the screen
/// (`promptTailIsActive`, server/prompt.ts:822-858). Claude's task list and the session's rule under
/// the panel are left out first.
pub(crate) fn tail_is_active(responder: Responder, screen: &str) -> bool {
    let visible = visible_lines(screen);
    let shown = match responder {
        // Claude's review has no hint of its own: its last row ends the panel
        Responder::Submit => {
            without_tasks(&visible, |lines, end| line_before(lines, end, &SUBMIT_TAIL))
        }
        _ => without_tasks(&visible, |lines, end| line_before(lines, end, &HINT_TAIL)),
    };
    match responder {
        Responder::Question => ends(shown, &ASK_HINT),
        Responder::Submit => SUBMIT_TAIL.is_match(shown.last().map_or("", String::as_str)),
        Responder::Approval => ends(shown, &APPROVAL_TAIL),
        Responder::Confirm => ends(shown, &CONFIRM_HINT),
        Responder::Plan => ends(shown, &PLAN_TAIL),
    }
}

/// Whether `pattern` matches the line before `end` (`lines[end - 1] ?? ""`).
fn line_before(lines: &[String], end: usize, pattern: &Regex) -> bool {
    let line = end.checked_sub(1).and_then(|at| lines.get(at));
    pattern.is_match(line.map_or("", String::as_str))
}

/// `withoutClaudeTasks` (server/prompt.ts:781-820): the visible lines without Claude Code's task
/// list and the session's rule above it, when they sit directly under the panel's hint
/// (`hint_ends`: whether the hint ends right before line `end`). The list holds task rows, the
/// activity under a task in progress and the pending count, nothing else; anything else under the
/// hint keeps the panel answered.
fn without_tasks(shown: &[String], hint_ends: impl Fn(&[String], usize) -> bool) -> &[String] {
    let mut end = shown.len();
    if let Some(head) = find_last_index(shown, |line, _| TASKS_HEAD.is_match(line)) {
        // `Number(…)`, read as an f64: a count of any length is a number, as large as it reads (a
        // string of digits always parses as an f64, so the fallback is never taken)
        let total: f64 = TASKS_HEAD.captures(&shown[head]).unwrap()[1]
            .parse()
            .unwrap_or(f64::INFINITY);
        let mut rows = 0_usize;
        let mut in_progress = false;
        let mut list = true;
        let mut index = head + 1;
        while index < shown.len() && list {
            let line = &shown[index];
            if TASK_ROW.is_match(line) {
                rows += 1;
                in_progress = line.starts_with('◼');
            } else if TASKS_MORE.is_match(line) {
                list = index == shown.len() - 1;
            } else if in_progress && line.ends_with('…') && !PROMPT_OR_BULLET.is_match(line) {
                // the activity under the task in progress: one line, ending in an ellipsis
                in_progress = false;
            } else {
                list = false;
            }
            index += 1;
        }
        if list && rows > 0 && rows as f64 <= total {
            end = head;
        }
    }
    // the session's rule is drawn above the list, and with no task list too
    if line_before(shown, end, &LABELED_RULE) {
        end -= 1;
    }
    if end < shown.len() && hint_ends(shown, end) {
        &shown[..end]
    } else {
        shown
    }
}

/// `cleanLine` of each of `lines[from..to]`, without blank lines and rules.
fn text_lines<T: AsRef<str>>(lines: &[T], from: usize, to: usize) -> Vec<String> {
    lines
        .get(from..to.max(from))
        .unwrap_or_default()
        .iter()
        .map(|line| clean_line(line.as_ref()))
        .filter(|line| !line.is_empty() && !crate::text::is_divider(line))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<String> {
        text.lines().map(str::to_owned).collect()
    }

    fn after_hint(lines: &[String], end: usize) -> bool {
        line_before(lines, end, &HINT_TAIL)
    }

    /// server/prompt.ts:781-820 (Claude Code 2.1.289): the task list and the session's rule under the
    /// hint go; what TypeScript's `withoutClaudeTasks` returns for these lines.
    #[test]
    fn leaves_out_claudes_task_list_under_the_hint() {
        let shown = lines(concat!(
            "Enter to select · ↑/↓ to navigate · Esc to cancel\n",
            "─── session ──\n",
            "3 tasks (0 done, 1 in progress, 2 open)\n",
            "◼ Build it\n",
            "Building…\n",
            "◻ Test it\n",
            "… +1 pending",
        ));
        assert_eq!(without_tasks(&shown, after_hint), &shown[..1]);
    }

    #[test]
    fn keeps_a_list_with_anything_else_under_it() {
        // a shell's prompt under the list: the panel was answered
        let shown = lines(concat!(
            "Esc to cancel\n",
            "2 tasks (0 done, 2 open)\n",
            "◻ One\n",
            "$ ls",
        ));
        assert_eq!(without_tasks(&shown, after_hint), &shown[..]);
        // more rows than the head counts
        let shown = lines("Esc to cancel\n1 tasks (0 done, 1 open)\n◻ One\n◻ Two");
        assert_eq!(without_tasks(&shown, after_hint), &shown[..]);
        // the pending count ends the list
        let shown = lines("Esc to cancel\n3 tasks (0 done, 3 open)\n◻ One\n… +2 pending\n◻ Two");
        assert_eq!(without_tasks(&shown, after_hint), &shown[..]);
    }

    #[test]
    fn leaves_out_the_sessions_rule_alone_only_under_the_hint() {
        let shown = lines("Esc to cancel\n─── session ──");
        assert_eq!(without_tasks(&shown, after_hint), &shown[..1]);
        let shown = lines("later output\n─── session ──");
        assert_eq!(without_tasks(&shown, after_hint), &shown[..]);
        assert!(without_tasks(&[], after_hint).is_empty());
    }
}
