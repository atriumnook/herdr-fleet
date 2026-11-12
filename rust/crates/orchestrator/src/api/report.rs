//! `GET /report`: a project's factory metrics, from the fleet's event log and what GitHub says now
//! (`factoryReport`, `server/index.ts:544-551`; ADR 0259-metrics-interface, "結果").

use std::collections::HashMap;
use std::path::PathBuf;

use regex::Regex;

use super::FactoryReporter;
use super::error::ApiError;
use crate::FleetError;
use crate::fleet::{Orchestrator, QUIET};
use crate::metrics::{MetricsInput, metrics, read_events, render};
use crate::thread::{git_branch, main_worktree};

/// A report the route was asked for, its query checked.
pub(super) struct Request {
    pub cwd: PathBuf,
    /// a finite number above 0
    pub hours: f64,
    pub planned: Option<Regex>,
}

/// `planned_label` as the report reads it: absent or empty is none (`server/index.ts:551` adds
/// `planned` only when the string is not empty); anything Rust's `regex` cannot read is refused.
/// That is more than JavaScript refuses: `regex` has no lookaround or backreference, which can
/// make matching take exponential time on a pattern a person types (ADR 0269-fleet-api).
pub(super) fn planned_label(raw: Option<&str>) -> Result<Option<Regex>, FleetError> {
    match raw {
        None | Some("") => Ok(None),
        Some(pattern) => Regex::new(pattern).map(Some).map_err(|_| {
            FleetError::new(
                "invalid_planned_label",
                "planned_label must be a regular expression",
            )
        }),
    }
}

/// The report: the project is the repository's main worktree, so a thread's worktree reports on
/// the repository it came from, and the pull requests count against the branch checked out there.
pub(super) async fn report(
    reporter: &FactoryReporter,
    fleet: &Orchestrator,
    request: Request,
) -> Result<String, ApiError> {
    let Some(project) = main_worktree(&request.cwd).await else {
        return Err(FleetError::new(
            "not_a_repository",
            format!("{} is not in a git repository", request.cwd.display()),
        )
        .into());
    };
    let base = git_branch(&project)
        .await
        .unwrap_or_else(|| "HEAD".to_owned());
    let to = fleet.now();
    // TypeScript compares the times, whole milliseconds, with `to - hours * 3_600_000`, which may
    // have a fraction: `t >= from` holds for the same times when the fraction is dropped
    let from = to.saturating_sub((request.hours * 3_600_000.0).floor() as i64);
    let (merged, issues) = tokio::join!(
        reporter.github.list_merged_pull_requests(&project),
        reporter.github.list_issues(&project)
    );
    let (merged, issues) = (merged?, issues?);
    // up to two files of 8 MiB, read off the async threads
    let file = reporter.events.file().to_path_buf();
    let events = tokio::task::spawn_blocking(move || read_events(&file))
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?;
    let current: HashMap<String, protocol::AgentState> = fleet
        .list(None)
        .into_iter()
        .map(|run| (run.id, run.state))
        .collect();
    let project_name = project.display().to_string();
    let counted = metrics(&MetricsInput {
        events: &events,
        project: &project_name,
        base: &base,
        from,
        to,
        quiet_ms: QUIET.as_millis() as i64,
        merged: &merged,
        issues: &issues,
        planned: request.planned.as_ref(),
        current: &current,
    });
    Ok(render(&project_name, &base, &counted, &reporter.time_zone))
}
