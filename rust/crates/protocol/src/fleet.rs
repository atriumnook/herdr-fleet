//! The fleet's records as the server keeps them and the API sends them (`shared/fleet.ts`): runs,
//! threads, reports, pull requests, usage, settings, the fleet skill's folders and model listings,
//! and the rules both sides apply to them.
//!
//! Absent and `null` fields follow ADR 0193-protocol-types (see `crate::absent`): a TypeScript
//! `field?: T` is an `Option<T>` that is left out when `None`.

use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::PlanMark;
use crate::absent::present;
use crate::js;

/// How hard an agent thinks, for the CLIs that take a level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

/// herdr's agent states, plus what the fleet adds: starting (no state yet), failed and stopped
/// (the run is over).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    Starting,
    Working,
    Idle,
    Done,
    Blocked,
    Unknown,
    Failed,
    Stopped,
}

/// The agent CLIs the fleet can start: herdr's `agent start --kind` values it has an adapter for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FleetAgentKind {
    Pi,
    Claude,
    Codex,
    Cursor,
    Agy,
    Opencode,
}

impl FleetAgentKind {
    /// Every kind, in the order of `server/fleet/adapters.ts`'s `AGENT_KINDS`.
    pub const ALL: [FleetAgentKind; 6] = [
        FleetAgentKind::Pi,
        FleetAgentKind::Claude,
        FleetAgentKind::Codex,
        FleetAgentKind::Cursor,
        FleetAgentKind::Agy,
        FleetAgentKind::Opencode,
    ];

    /// The kind as herdr, the settings and the records name it: its serde name.
    pub const fn name(self) -> &'static str {
        match self {
            FleetAgentKind::Pi => "pi",
            FleetAgentKind::Claude => "claude",
            FleetAgentKind::Codex => "codex",
            FleetAgentKind::Cursor => "cursor",
            FleetAgentKind::Agy => "agy",
            FleetAgentKind::Opencode => "opencode",
        }
    }
}

/// A spawn candidate passed over before the one a run started on, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkippedCandidate {
    /// The candidate entry as configured: a model, or `<agent>:<model>`.
    pub candidate: String,
    pub reason: String,
}

/// One agent the fleet started, as the server keeps it (runs.json) and the API sends it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub id: String,
    pub name: String,
    pub role: String,
    pub agent: FleetAgentKind,
    /// The fleet this run belongs to: its caller's, so a caller lists only its own agents.
    pub group: String,
    /// herdr's agent name, unique per run.
    pub herdr_name: String,
    pub pane_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<ThinkingLevel>,
    pub state: AgentState,
    pub depth: u32,
    pub interactive: bool,
    pub worktree: bool,
    /// Epoch milliseconds.
    pub started_at: i64,
    /// Epoch milliseconds.
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// The HANDOFF the agent wrote to its result file during its last settled turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    /// What its last settled turn reported (report.json), or that it reported nothing; none for a
    /// run without a result file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<TurnOutcome>,
    /// The model this run replaced after a configured fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_from: Option<String>,
    /// The run that took this run's task over.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaced_by: Option<String>,
    /// The thread a lead took over from an earlier run of it: that first run's id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    /// The CLIs a thread's lead runs failed on since the thread's last report.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avoid: Option<Vec<FleetAgentKind>>,
    /// Candidates passed over before this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped: Option<Vec<SkippedCandidate>>,
    /// A thread lead's branch, when its thread works on a worktree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The repository a thread or a project's coordinator works for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// The run that started this thread, a project's coordinator.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// The paths its brief lets it change, absolute.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write: Option<Vec<String>>,
    /// A thread's question for the person that its coordinator has not been given yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
    /// The commit a thread's worktree started from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// A thread lead's acceptance contract, as it stood when the lead's turn last settled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract: Option<Vec<ContractItem>>,
    /// What a thread changed since `base`, as it stood when the lead's turn last settled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<DiffStat>,
    /// When the person marked the thread done (epoch ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<i64>,
    /// The branch the repository's main checkout was on when the thread started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    /// The thread's pull request, as the fleet last read it from GitHub.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<PullRequest>,
    /// The landing step the person asked for last, until it went as asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub landing: Option<LandingStep>,
    /// How the thread ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub landed: Option<Landed>,
    /// The plan a thread's lead handed over last, and whether the person answered it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<PlanMark>,
}

/// How a thread ended: merged into its base branch, or thrown away.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Landed {
    Merged,
    Discarded,
}

/// The steps that land a thread, each pressed by the person on the Fleet screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LandAction {
    Update,
    Pr,
    FixCi,
    Comments,
    Merge,
    MergePr,
    Discard,
}

impl LandAction {
    /// Every landing step, in the order `server/fleet/api.ts`'s `LAND_ACTIONS` names them.
    pub const ALL: [LandAction; 7] = [
        LandAction::Update,
        LandAction::Pr,
        LandAction::FixCi,
        LandAction::Comments,
        LandAction::Merge,
        LandAction::MergePr,
        LandAction::Discard,
    ];
}

/// One landing step the person asked for: handed to its agent (`sent`), and what the fleet found
/// once that agent's turn ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LandingStep {
    pub action: LandAction,
    /// Epoch milliseconds.
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent: Option<bool>,
    /// The step did not go as asked: what the fleet found.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The states an agent reports a turn in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReportState {
    Progress,
    Waiting,
    Ready,
    Blocked,
    Failed,
    Dropped,
}

/// Every report state, in the order of `shared/fleet.ts`'s `REPORT_STATES`.
pub const REPORT_STATES: [ReportState; 6] = [
    ReportState::Progress,
    ReportState::Waiting,
    ReportState::Ready,
    ReportState::Blocked,
    ReportState::Failed,
    ReportState::Dropped,
];

/// An agent's report of its turn, from report.json beside its handoff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunReport {
    pub state: ReportState,
    pub summary: String,
    /// What the agent ran and what it showed.
    pub evidence: Vec<String>,
    /// One concrete question for the person, when the person must act.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub human_action: Option<String>,
}

/// What a settled turn reported: the report, or none, and why. On the wire it is
/// `{ report: {…} }` or `{ report: null, problem: "…" }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "OutcomeWire", into = "OutcomeWire")]
pub enum TurnOutcome {
    Report(RunReport),
    NoReport { problem: String },
}

#[derive(Serialize, Deserialize)]
struct OutcomeWire {
    #[serde(deserialize_with = "Option::deserialize")]
    report: Option<RunReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    problem: Option<String>,
}

impl TryFrom<OutcomeWire> for TurnOutcome {
    type Error = &'static str;

    fn try_from(wire: OutcomeWire) -> Result<Self, Self::Error> {
        match (wire.report, wire.problem) {
            (Some(report), None) => Ok(TurnOutcome::Report(report)),
            (None, Some(problem)) => Ok(TurnOutcome::NoReport { problem }),
            (Some(_), Some(_)) => Err("an outcome with a report has no problem"),
            (None, None) => Err("an outcome without a report says its problem"),
        }
    }
}

impl From<TurnOutcome> for OutcomeWire {
    fn from(outcome: TurnOutcome) -> Self {
        match outcome {
            TurnOutcome::Report(report) => OutcomeWire {
                report: Some(report),
                problem: None,
            },
            TurnOutcome::NoReport { problem } => OutcomeWire {
                report: None,
                problem: Some(problem),
            },
        }
    }
}

impl TurnOutcome {
    /// The report, if the turn left one.
    pub fn report(&self) -> Option<&RunReport> {
        match self {
            TurnOutcome::Report(report) => Some(report),
            TurnOutcome::NoReport { .. } => None,
        }
    }
}

/// A thread's pull request on GitHub, and its checks: failing ones by name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequest {
    pub number: u64,
    pub url: String,
    pub state: PullRequestState,
    pub checks: ChecksState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failing: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum PullRequestState {
    Open,
    Merged,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChecksState {
    Pending,
    Pass,
    Fail,
    None,
}

/// One comment of the person's on a thread's change: on a line of the new file, or one it removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineComment {
    pub file: String,
    pub line: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<bool>,
    pub text: String,
}

/// What stands between a thread and landing, read when asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandingChecks {
    pub base_branch: String,
    /// Files changed or new in the worktree that no commit holds (git status), the first 20.
    pub uncommitted: Vec<String>,
    /// Commits the branch has that the base branch does not, and the other way round.
    pub ahead: u64,
    pub behind: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<PullRequest>,
    /// GitHub could not be asked (gh missing, signed out, offline).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_error: Option<String>,
}

/// Lines a change adds and removes, in the files git tracks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffStat {
    pub added: u64,
    pub removed: u64,
    pub files: u64,
}

/// One assertion of a thread lead's acceptance contract (contract.md), as the lead last marked it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContractItem {
    pub id: String,
    pub state: ContractState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContractState {
    Met,
    Open,
    Unmet,
}

/// Where a thread stands for the person.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadState {
    Working,
    Waiting,
    Review,
    Landing,
    Idle,
    Failed,
    Ended,
    Resolved,
}

/// A thread as its project's coordinator sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThreadSummary {
    pub run: AgentRun,
    pub state: ThreadState,
    /// The last report's state and summary, or that the turn left none and why (`outcome_line`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract: Option<Vec<ContractItem>>,
}

/// One limit window: a share of it used, until it resets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageWindow {
    /// `5h`, `weekly`, `monthly`, …
    pub name: String,
    #[serde(rename = "usedPercent")]
    pub used_percent: f64,
    /// Epoch milliseconds, a JavaScript number (Codex's seconds times 1000 may have a fraction);
    /// unknown for some sources.
    #[serde(rename = "resetsAt", default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageReading {
    pub windows: Vec<UsageWindow>,
    /// Epoch milliseconds, a JavaScript number.
    #[serde(rename = "readAt")]
    pub read_at: f64,
}

/// An account sitting out after a rate limit. Times are epoch milliseconds, JavaScript numbers:
/// `until` may come from a window's `resetsAt`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cooldown {
    pub until: f64,
    pub reason: String,
    pub since: f64,
}

/// One account the fleet tracks: a CLI, or a part of one with its own limits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageEntry {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reading: Option<UsageReading>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cooldown: Option<Cooldown>,
    /// The last reading attempt failed; the reading kept is older.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A report the person has to act on: it says so with a question, or the agent is blocked or
/// could not do it.
pub fn needs_person(report: &RunReport) -> bool {
    report.human_action.is_some()
        || report.state == ReportState::Blocked
        || report.state == ReportState::Failed
}

/// A turn's outcome in a line: the report's state and summary, or that there is none and why.
pub fn outcome_line(outcome: &TurnOutcome) -> String {
    match outcome {
        TurnOutcome::Report(report) => {
            let state = serde_json::to_value(report.state).expect("a report state is a string");
            format!(
                "{} — {}",
                state.as_str().unwrap_or_default(),
                report.summary
            )
        }
        TurnOutcome::NoReport { problem } => format!("no report — {problem}"),
    }
}

/// One assertion's mark at the start of the text: TypeScript's
/// `/^\s*[-*]\s*\[([ xX!])\]\s*(A\d+)\b/` with JavaScript's `\s`, `\d` and `\b`.
static CONTRACT_ITEM: LazyLock<Regex> = LazyLock::new(|| {
    let s = js::WHITESPACE;
    Regex::new(&format!(r"^{s}*[-*]{s}*\[([ xX!])\]{s}*(A[0-9]+)(?-u:\b)")).unwrap()
});

/// contract.md's assertions: `- [ ] A1 …` open, `- [x]` met, `- [!]` cannot be met.
pub fn contract_items(text: &str) -> Vec<ContractItem> {
    // The `m` flag: `^` matches at the start and after each of JavaScript's line terminators. A
    // search goes on after the end of the last match, as `matchAll` does.
    let starts = std::iter::once(0).chain(
        text.char_indices()
            .filter(|&(_, c)| js::is_line_terminator(c))
            .map(|(index, c)| index + c.len_utf8()),
    );
    let mut items = Vec::new();
    let mut searched_to = 0;
    for start in starts {
        if start < searched_to {
            continue;
        }
        let Some(found) = CONTRACT_ITEM.captures(&text[start..]) else {
            continue;
        };
        let state = match &found[1] {
            "!" => ContractState::Unmet,
            " " => ContractState::Open,
            _ => ContractState::Met,
        };
        items.push(ContractItem {
            id: found[2].to_owned(),
            state,
        });
        searched_to = start + found.get(0).expect("a match").end();
    }
    items
}

/// The run that leads a thread now: `id`, or the lead run that took the thread over from it
/// (`replaced_by`).
pub fn current_lead<'a>(runs: &'a [AgentRun], id: &str) -> Option<&'a AgentRun> {
    let find = |id: &str| runs.iter().find(|candidate| candidate.id == id);
    let mut run = find(id)?;
    for _ in 0..32 {
        if run.role != "lead" {
            break;
        }
        let Some(next) = run.replaced_by.as_deref().and_then(find) else {
            break;
        };
        run = next;
    }
    Some(run)
}

/// Where a thread stands: herdr's state of its lead, and once a turn settled, what it reported.
pub fn thread_state(run: &AgentRun) -> ThreadState {
    let working = matches!(
        run.state,
        AgentState::Starting | AgentState::Working | AgentState::Unknown
    );
    if run.resolved_at.is_some() && !working {
        return ThreadState::Resolved;
    }
    match run.state {
        AgentState::Failed => return ThreadState::Failed,
        AgentState::Stopped => return ThreadState::Ended,
        AgentState::Blocked => return ThreadState::Waiting,
        _ if working => return ThreadState::Working,
        _ => {}
    }
    // A plan waits on the person through the blocked report its turn ends with (agents/lead.md),
    // not by itself. A turn that left no report is someone's to look at.
    let report = run.outcome.as_ref().and_then(TurnOutcome::report);
    let no_report = matches!(run.outcome, Some(TurnOutcome::NoReport { .. }));
    let open = run
        .pr
        .as_ref()
        .is_some_and(|pr| pr.state == PullRequestState::Open);
    let failing = open
        && run
            .pr
            .as_ref()
            .is_some_and(|pr| pr.checks == ChecksState::Fail);
    let step_went_wrong = run
        .landing
        .as_ref()
        .is_some_and(|step| step.error.as_deref().is_some_and(|error| !error.is_empty()));
    if report.is_some_and(needs_person) || no_report || step_went_wrong || failing {
        return ThreadState::Waiting;
    }
    if open {
        return ThreadState::Landing;
    }
    if report.is_some_and(|report| report.state == ReportState::Ready) {
        ThreadState::Review
    } else {
        ThreadState::Idle
    }
}

/// One candidate of a role: the CLI, and its model (none: the CLI's own default).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleCandidate {
    pub agent: FleetAgentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// A candidate as the Settings page draws it, with why it would be passed over now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleCandidateSetting {
    pub agent: FleetAgentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip: Option<String>,
}

/// A role's candidates and thinking level as one source sets them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleCandidates {
    pub candidates: Vec<RoleCandidate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<ThinkingLevel>,
}

/// A role as the Settings page draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleSettings {
    pub name: String,
    pub description: String,
    /// The role edits no file: only a CLI the fleet can keep from editing plays it.
    pub read_only: bool,
    /// The candidates in the order the fleet tries them.
    pub candidates: Vec<RoleCandidateSetting>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<ThinkingLevel>,
    /// The person's fleet.json sets the candidates or the thinking level.
    pub changed: bool,
    /// What the role's file alone sets: Reset goes back to it.
    pub defaults: RoleCandidates,
    /// Set when the project's own `.herdr-fleet/fleet.json` sets the role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<RoleCandidates>,
}

/// The setup command of one repository the person's fleet.json names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSetup {
    pub path: String,
    pub setup: String,
}

/// The fleet's settings from the person's fleet.json, with what each role and the project make of
/// them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetSettings {
    /// The person's fleet.json, where every change is saved.
    pub file: String,
    pub roles: Vec<RoleSettings>,
    /// A candidate is passed over while a window of its account is used this much (percent).
    pub max_used_percent: f64,
    /// How long an account sits out after a rate limit whose message names no time (minutes).
    /// JavaScript numbers: fleet.json's values are floored but have no upper bound
    /// (`server/fleet/config.ts`), so they may pass `u32`.
    pub rate_limit_cooldown_minutes: f64,
    /// Agents starting or working at once.
    pub max_concurrent: f64,
    /// A helper's pane closes when its turn ends.
    pub close_on_settle: bool,
    /// The language the person reads; empty when unset.
    pub language: String,
    pub projects: Vec<ProjectSetup>,
    /// The CLIs a read-only role can run on.
    pub read_only_agents: Vec<FleetAgentKind>,
}

/// A role's new candidates in a settings patch; a `thinking` of `null` unsets the level.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RolePatch {
    pub candidates: Vec<RoleCandidate>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub thinking: Option<Option<ThinkingLevel>>,
}

/// A project's new setup command in a settings patch; an empty one removes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectPatch {
    pub setup: String,
}

/// A change to the person's fleet.json: what is named changes, the rest stays. A role set to
/// `null` goes back to its file's candidates. The maps keep the order the object lists them in. The numbers are JavaScript numbers, so the settings
/// store can refuse one that is not whole with its own message.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roles: Option<IndexMap<String, Option<RolePatch>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_used_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limit_cooldown_minutes: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_on_settle: Option<bool>,
    /// An empty language unsets it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// An empty setup command removes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projects: Option<IndexMap<String, ProjectPatch>>,
}

/// A folder agent CLIs read skills from, where the Settings page puts the fleet skill.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FleetEntrance {
    pub id: EntranceId,
    /// The skill's file, absolute.
    pub file: String,
    /// The CLIs that read skills from this folder.
    pub readers: Vec<FleetAgentKind>,
    pub state: EntranceState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntranceId {
    Claude,
    Agents,
    Gemini,
}

/// installed: as the fleet writes it now; outdated: the fleet wrote it for another command or
/// address; taken: a file the fleet did not write is there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntranceState {
    Installed,
    Missing,
    Outdated,
    Taken,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetEntrances {
    pub entrances: Vec<FleetEntrance>,
    /// The server wants a token, which the skill does not carry.
    pub token_required: bool,
}

/// The models one agent CLI says it offers. `complete`: the list is the CLI's whole answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelListing {
    pub agent: FleetAgentKind,
    pub models: Vec<ListedModel>,
    pub complete: bool,
    /// Why the CLI could not be asked; `models` is then empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListedModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Whether `model` is one the listing names. A `:level` suffix is not part of a name, cursor's
/// bracketed parameters (`gpt-5[effort=high]`) belong to one model, and opencode's `#variant` is a
/// way to run the model the listing names without it.
pub fn model_listed(listing: &ModelListing, model: &str) -> bool {
    static BRACKETS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\[[^\n\r\u{2028}\u{2029}]*\]$").unwrap());
    static LEVEL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r":(off|minimal|low|medium|high|xhigh|max)$").unwrap());
    static VARIANT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"#[^#]+$").unwrap());
    static EFFORT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"-(low|medium|high|xhigh|max)$").unwrap());
    // `replace` with a regular expression without the `g` flag: the first match alone
    let bare = |name: &str| BRACKETS.replace(name, "").into_owned();
    let unsuffixed = LEVEL.replace(model, "");
    let name = if listing.agent == FleetAgentKind::Opencode {
        bare(&VARIANT.replace(&unsuffixed, ""))
    } else {
        bare(&unsuffixed)
    };
    // agy lists a model once per effort (`gemini-3.1-pro-high`) and takes the effort apart
    let base = |id: &str| {
        if listing.agent == FleetAgentKind::Agy {
            EFFORT.replace(id, "").into_owned()
        } else {
            id.to_owned()
        }
    };
    listing
        .models
        .iter()
        .any(|each| each.id == name || bare(&each.id) == name || base(&each.id) == name)
}

/// How a task sent from a pane's conversation opens (the fleet skill's `fleet project`).
pub const FROM_PANE: &str = "[from pane ";

/// The pane a message to a coordinator came from, and the message without that opening line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FromPane {
    pub pane_id: String,
    pub text: String,
}

/// The pane a message to a coordinator was sent from, and the message without that opening line;
/// none for one the person typed on the Fleet screen.
pub fn from_pane(text: &str) -> Option<FromPane> {
    // JavaScript's `\w` is ASCII
    static OPENING: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\[from pane ([A-Za-z0-9_:.-]{1,64})\]\n\n").unwrap());
    let found = OPENING.captures(text)?;
    Some(FromPane {
        pane_id: found[1].to_owned(),
        text: text[found.get(0)?.end()..].to_owned(),
    })
}
