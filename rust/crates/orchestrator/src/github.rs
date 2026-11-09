//! Reading pull requests, checks and issues with `gh`; from `server/fleet/github.ts`.
//!
//! `gh` holds its own sign-in, as the person: the fleet reads no token. Nothing here writes to
//! GitHub; the agents do that, once the person pressed the step (agents/lead.md,
//! agents/coordinator.md). `gh` runs through the caller's [`Runner`] with the server's environment
//! (ADR 0242-phase-3-split, "子プロセス"); its arguments and the reading of its output are here.

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use child_process::{Command, Env, EnvPolicy, RunError, Runner};
use protocol::{ChecksState, PullRequest, PullRequestState};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use tokio_util::sync::CancellationToken;

/// How long one `gh` command may run (`GH_TIMEOUT_MS`, `server/fleet/github.ts:8`).
pub const GH_TIMEOUT: Duration = Duration::from_secs(20);

/// How many merged pull requests [`GitHub::list_merged_pull_requests`] asks for.
pub const MERGED_PULL_REQUESTS_LIMIT: usize = 200;

/// How many issues [`GitHub::list_issues`] asks for.
pub const ISSUES_LIMIT: usize = 500;

/// What `gh` said went wrong, or why it could not be asked: for a person to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhError(pub String);

impl std::fmt::Display for GhError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for GhError {}

/// A pull request and the commit its branch is at on GitHub.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestReading {
    pub pr: PullRequest,
    pub head: String,
}

/// A pull request merged, as the factory's metrics read it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedPullRequest {
    pub number: u64,
    pub title: String,
    pub merged_at: String,
    pub base_ref_name: String,
}

/// An issue, as the factory's metrics read it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueSummary {
    pub number: u64,
    pub title: String,
    pub created_at: String,
    pub closed_at: Option<String>,
    pub labels: Vec<Label>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Label {
    pub name: String,
}

/// A list `gh` answered, and whether it reached the number asked for: then there may be more
/// that the list leaves out, and whoever counts them says so (issue #189, item 6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing<T> {
    pub items: Vec<T>,
    pub limit_reached: bool,
}

/// Reads GitHub through the `gh` CLI, signed in as the person.
#[derive(Debug, Clone)]
pub struct GitHub {
    runner: Runner,
    program: OsString,
}

impl Default for GitHub {
    fn default() -> Self {
        Self::new()
    }
}

impl GitHub {
    /// `gh` as the server's `PATH` finds it.
    pub fn new() -> Self {
        Self::with_program("gh")
    }

    /// `program` in place of `gh`: a path, or a name looked up in the server's `PATH`.
    pub fn with_program(program: impl Into<OsString>) -> Self {
        GitHub {
            // no limit on how many run at once, as in TypeScript (ADR 0242-phase-3-split)
            runner: Runner::new(usize::MAX),
            program: program.into(),
        }
    }

    /// The pull request of `branch` in the repository at `repo`, with its checks; `None` when the
    /// branch has none. Fails with what gh said when GitHub cannot be asked (gh missing, signed
    /// out, offline).
    pub async fn read_pull_request(
        &self,
        repo: &Path,
        branch: &str,
    ) -> Result<Option<PullRequestReading>, GhError> {
        let args = [
            "pr",
            "view",
            branch,
            "--json",
            "number,url,state,headRefOid",
        ];
        let viewed = match self.gh(repo, &args).await {
            Ok(viewed) => viewed,
            Err(RunError::Spawn(_)) => {
                return Err(GhError("The gh command is not installed.".into()));
            }
            // stopped past its time limit: TypeScript's killed gh said nothing either
            Err(_) => return Err(GhError("gh could not read the pull request.".into())),
        };
        if !viewed.ok {
            if viewed
                .error
                .to_lowercase()
                .contains("no pull requests found")
            {
                return Ok(None);
            }
            let said = first_line(&viewed.error);
            return Err(GhError(if said.is_empty() {
                "gh could not read the pull request.".into()
            } else {
                said
            }));
        }
        let viewed: Viewed = serde_json::from_str(&viewed.output)
            .map_err(|_| GhError("gh pr view answered something other than JSON.".into()))?;
        let (checks, failing) = if viewed.state == PullRequestState::Open {
            self.read_checks(repo, viewed.number).await
        } else {
            (ChecksState::None, None)
        };
        Ok(Some(PullRequestReading {
            pr: PullRequest {
                number: viewed.number,
                url: viewed.url,
                state: viewed.state,
                checks,
                failing,
            },
            head: viewed.head_ref_oid,
        }))
    }

    /// A pull request's checks, summed up: any failing (by name), else any still running, else
    /// passed, or none at all (also when gh lists none, or cannot).
    async fn read_checks(&self, repo: &Path, number: u64) -> (ChecksState, Option<Vec<String>>) {
        // gh exits 1 when a check failed and 8 while one runs, and prints them either way
        let number = number.to_string();
        let args = ["pr", "checks", &number, "--json", "name,bucket"];
        let Ok(listed) = self.gh(repo, &args).await else {
            return (ChecksState::None, None);
        };
        let Ok(rows) = serde_json::from_str::<Vec<Check>>(&listed.output) else {
            return (ChecksState::None, None);
        };
        let failing: Vec<String> = rows
            .iter()
            .filter(|row| row.bucket == "fail" || row.bucket == "cancel")
            .map(|row| row.name.clone())
            .collect();
        if !failing.is_empty() {
            return (ChecksState::Fail, Some(failing));
        }
        let any = |bucket: &str| rows.iter().any(|row| row.bucket == bucket);
        if any("pending") {
            (ChecksState::Pending, None)
        } else if any("pass") {
            (ChecksState::Pass, None)
        } else {
            (ChecksState::None, None)
        }
    }

    /// The repository's merged pull requests, the latest [`MERGED_PULL_REQUESTS_LIMIT`] by when
    /// they were opened, and whether the list reached that many.
    pub async fn list_merged_pull_requests(
        &self,
        repo: &Path,
    ) -> Result<Listing<MergedPullRequest>, GhError> {
        let limit = MERGED_PULL_REQUESTS_LIMIT.to_string();
        let args = ["pr", "list", "--state", "merged", "--limit", &limit];
        let fields = ["--json", "number,title,mergedAt,baseRefName"];
        self.list(
            repo,
            &[&args[..], &fields[..]].concat(),
            MERGED_PULL_REQUESTS_LIMIT,
        )
        .await
    }

    /// The repository's issues, open and closed, the latest [`ISSUES_LIMIT`], and whether the list
    /// reached that many.
    pub async fn list_issues(&self, repo: &Path) -> Result<Listing<IssueSummary>, GhError> {
        let limit = ISSUES_LIMIT.to_string();
        let args = ["issue", "list", "--state", "all", "--limit", &limit];
        let fields = ["--json", "number,title,createdAt,closedAt,labels"];
        self.list(repo, &[&args[..], &fields[..]].concat(), ISSUES_LIMIT)
            .await
    }

    /// A list gh answers as JSON (`ghJson`, `github.ts:64`), and whether it is as long as `limit`.
    async fn list<T: DeserializeOwned>(
        &self,
        repo: &Path,
        args: &[&str],
        limit: usize,
    ) -> Result<Listing<T>, GhError> {
        let command = args[..2].join(" ");
        let listed = match self.gh(repo, args).await {
            Ok(listed) => listed,
            Err(RunError::TimedOut) => {
                return Err(GhError(format!("gh {command} failed or timed out.")));
            }
            Err(error) => {
                return Err(GhError(format!("The gh command could not be run: {error}")));
            }
        };
        if !listed.ok {
            return Err(GhError(if listed.error.is_empty() {
                format!("gh {command} failed or timed out.")
            } else {
                listed.error
            }));
        }
        let items: Vec<T> = serde_json::from_str(&listed.output)
            .map_err(|_| GhError(format!("gh {command} answered something other than JSON.")))?;
        let limit_reached = items.len() >= limit;
        Ok(Listing {
            items,
            limit_reached,
        })
    }

    /// `gh <args>` in `cwd`, with the server's environment, no prompt, no update notice, no colour
    /// and no git prompt, nothing to read, and [`GH_TIMEOUT`] (`github.ts:10-23`).
    async fn gh(&self, cwd: &Path, args: &[&str]) -> Result<GhOutcome, RunError> {
        let env: Env = [
            ("GH_PROMPT_DISABLED", "1"),
            ("GH_NO_UPDATE_NOTIFIER", "1"),
            ("NO_COLOR", "1"),
            ("GIT_TERMINAL_PROMPT", "0"),
        ]
        .into_iter()
        .map(|(name, value)| (name.into(), value.into()))
        .collect();
        let command =
            Command::new(&self.program, cwd, EnvPolicy::Inherit(env), GH_TIMEOUT).args(args);
        let output = self.runner.run(command, &CancellationToken::new()).await?;
        Ok(GhOutcome {
            ok: output.code == Some(0),
            output: String::from_utf8_lossy(&output.stdout).into_owned(),
            error: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        })
    }
}

/// A gh command that ended: whether it exited 0, its output, and what it said went wrong (trimmed).
struct GhOutcome {
    ok: bool,
    output: String,
    error: String,
}

/// What `gh pr view --json number,url,state,headRefOid` answers.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Viewed {
    number: u64,
    url: String,
    state: PullRequestState,
    head_ref_oid: String,
}

/// A row of `gh pr checks --json name,bucket`.
#[derive(Deserialize)]
struct Check {
    name: String,
    bucket: String,
}

fn first_line(text: &str) -> String {
    text.split('\n').next().unwrap_or("").to_owned()
}
