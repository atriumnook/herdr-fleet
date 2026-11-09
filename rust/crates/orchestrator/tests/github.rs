//! Reading GitHub with `gh` (`github.rs`), through a fake `gh` in a temporary folder: the tests never
//! start the real one (issue #255). TypeScript has no test of `server/fleet/github.ts`; the fake's
//! answers are what `gh` 2.103.3 printed for this repository on 2026-11-09 (`gh pr view 280 --json
//! number,url,state,headRefOid`, `gh pr checks 280 --json name,bucket`, `gh pr view <a branch with
//! none>`, `gh pr list --state merged`, `gh issue list --state all`), changed only where a test
//! names it, and the expected values are worked out by hand from `server/fleet/github.ts`.

#![cfg(unix)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use herdr_fleet_orchestrator::github::{
    GH_TIMEOUT, GhError, GitHub, ISSUES_LIMIT, IssueSummary, Label, Listing,
    MERGED_PULL_REQUESTS_LIMIT, MergedPullRequest, PullRequestReading,
};
use protocol::{ChecksState, PullRequest, PullRequestState};

/// A new empty folder under the system's temporary folder (its real path), removed with what it
/// holds when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        use std::hash::{BuildHasher as _, Hasher as _};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(n);
        let dir = std::env::temp_dir().join(format!(
            "herdr-fleet-github-{label}-{}-{n}-{:016x}",
            std::process::id(),
            hasher.finish()
        ));
        fs::create_dir(&dir).unwrap_or_else(|error| panic!("{}: {error}", dir.display()));
        Self(dir.canonicalize().unwrap())
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn sh_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', r"'\''"))
}

/// A fake `gh`: it writes its arguments and what it was started with to files, and answers each
/// command (`pr view`, `pr checks`, `pr list`, `issue list`) with what the test set for it.
struct FakeGh {
    dir: TempDir,
    /// the folder `gh` is started in: a repository's, as the fleet passes
    repo: TempDir,
    program: PathBuf,
}

impl FakeGh {
    fn new(label: &str) -> Self {
        let dir = TempDir::new(label);
        let repo = TempDir::new(&format!("{label}-repo"));
        let program = dir.path().join("gh");
        let d = sh_quote(dir.path());
        let body = format!(
            r#"d={d}
printf '%s\n' "$*" >> "$d/argv"
printf '%s|%s|%s|%s|%s|%s|' "$PWD" "$GH_PROMPT_DISABLED" "$GH_NO_UPDATE_NOTIFIER" "$NO_COLOR" "$GIT_TERMINAL_PROMPT" "${{PATH:+path}}" >> "$d/env"
cat >> "$d/env"; echo >> "$d/env"
case "$1 $2" in
  "pr view") f=view ;;
  "pr checks") f=checks ;;
  "pr list") f=prlist ;;
  "issue list") f=issues ;;
  *) f=other ;;
esac
[ -f "$d/$f.out" ] && cat "$d/$f.out"
[ -f "$d/$f.err" ] && cat "$d/$f.err" >&2
[ -f "$d/$f.code" ] && exit "$(cat "$d/$f.code")"
exit 0"#
        );
        // a shell writes the script, not this process (ETXTBSY: see child-process's tests/common)
        let status = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                r#"printf '#!/bin/sh\n%s\n' "$2" > "$1" && chmod 755 "$1""#,
                "sh",
            ])
            .arg(&program)
            .arg(&body)
            .status()
            .unwrap();
        assert!(status.success());
        FakeGh { dir, repo, program }
    }

    /// What `gh <command>` prints on its standard output and error, and its exit code.
    fn answer(&self, command: &str, stdout: &str, stderr: &str, code: i32) {
        let d = self.dir.path();
        fs::write(d.join(format!("{command}.out")), stdout).unwrap();
        fs::write(d.join(format!("{command}.err")), stderr).unwrap();
        fs::write(d.join(format!("{command}.code")), code.to_string()).unwrap();
    }

    fn github(&self) -> GitHub {
        GitHub::with_program(&self.program)
    }

    fn repo(&self) -> &Path {
        self.repo.path()
    }

    /// Each command's arguments, one line each, in the order run.
    fn argv(&self) -> Vec<String> {
        fs::read_to_string(self.dir.path().join("argv"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    /// Each command's folder, the four variables, whether PATH was there, and its standard input.
    fn env(&self) -> Vec<String> {
        fs::read_to_string(self.dir.path().join("env"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }
}

/// `gh pr view 280 --json number,url,state,headRefOid`, as gh printed it, with the state given.
fn viewed(state: &str) -> String {
    format!(
        r#"{{"headRefOid":"3c1c2775ce93fe7565846e152f319d1657ab3252","number":280,"state":"{state}","url":"https://github.com/atriumnook/herdr-fleet/pull/280"}}"#
    )
}

fn pr(
    state: PullRequestState,
    checks: ChecksState,
    failing: Option<Vec<&str>>,
) -> PullRequestReading {
    PullRequestReading {
        pr: PullRequest {
            number: 280,
            url: "https://github.com/atriumnook/herdr-fleet/pull/280".into(),
            state,
            checks,
            failing: failing.map(|names| names.into_iter().map(String::from).collect()),
        },
        head: "3c1c2775ce93fe7565846e152f319d1657ab3252".into(),
    }
}

#[test]
fn the_time_limit_and_the_list_limits_are_the_typescripts() {
    // github.ts:8 (`20_000`), :74 (`--limit 200`), :79 (`--limit 500`)
    assert_eq!(GH_TIMEOUT, Duration::from_secs(20));
    assert_eq!(MERGED_PULL_REQUESTS_LIMIT, 200);
    assert_eq!(ISSUES_LIMIT, 500);
}

/// github.ts:33-46: an open pull request, then its checks; all passed.
#[tokio::test]
async fn reads_an_open_pull_request_and_its_passed_checks() {
    let gh = FakeGh::new("open-pass");
    gh.answer("view", &viewed("OPEN"), "", 0);
    gh.answer(
        "checks",
        r#"[{"bucket":"pass","name":"linux"},{"bucket":"pass","name":"ts-corpus"}]"#,
        "",
        0,
    );
    let reading = gh.github().read_pull_request(gh.repo(), "fleet/t1").await;
    assert_eq!(
        reading,
        Ok(Some(pr(PullRequestState::Open, ChecksState::Pass, None)))
    );
    assert_eq!(
        gh.argv(),
        [
            "pr view fleet/t1 --json number,url,state,headRefOid",
            "pr checks 280 --json name,bucket"
        ]
    );
}

/// github.ts:14 and :16: in the repository's folder, the server's environment with the four
/// variables over it, and nothing to read.
#[tokio::test]
async fn gh_runs_in_the_repository_with_the_servers_environment_and_four_variables() {
    let gh = FakeGh::new("env");
    gh.answer("view", &viewed("MERGED"), "", 0);
    gh.answer("prlist", "[]", "", 0);
    gh.answer("issues", "[]", "", 0);
    let github = gh.github();
    github
        .read_pull_request(gh.repo(), "fleet/t1")
        .await
        .unwrap();
    github.list_merged_pull_requests(gh.repo()).await.unwrap();
    github.list_issues(gh.repo()).await.unwrap();
    let expected = format!("{}|1|1|1|0|path|", gh.repo().display());
    assert_eq!(gh.env(), [expected.clone(), expected.clone(), expected]);
}

/// github.ts:45: a pull request that is not open has its checks unread: none.
#[tokio::test]
async fn a_merged_or_closed_pull_request_has_no_checks_read() {
    for (state, expected) in [
        ("MERGED", PullRequestState::Merged),
        ("CLOSED", PullRequestState::Closed),
    ] {
        let gh = FakeGh::new("merged");
        gh.answer("view", &viewed(state), "", 0);
        gh.answer("checks", r#"[{"bucket":"fail","name":"linux"}]"#, "", 1);
        let reading = gh.github().read_pull_request(gh.repo(), "fleet/t1").await;
        assert_eq!(reading, Ok(Some(pr(expected, ChecksState::None, None))));
        assert_eq!(
            gh.argv(),
            ["pr view fleet/t1 --json number,url,state,headRefOid"]
        );
    }
}

/// github.ts:50-58: gh exits 1 when a check failed; failing and cancelled checks name it, in order.
#[tokio::test]
async fn failing_and_cancelled_checks_fail_by_name() {
    let gh = FakeGh::new("fail");
    gh.answer("view", &viewed("OPEN"), "", 0);
    gh.answer(
        "checks",
        r#"[{"bucket":"pass","name":"linux"},{"bucket":"fail","name":"ts-corpus"},{"bucket":"pending","name":"slow"},{"bucket":"cancel","name":"windows"}]"#,
        "",
        1,
    );
    let reading = gh.github().read_pull_request(gh.repo(), "fleet/t1").await;
    assert_eq!(
        reading,
        Ok(Some(pr(
            PullRequestState::Open,
            ChecksState::Fail,
            Some(vec!["ts-corpus", "windows"])
        )))
    );
}

/// github.ts:50 and :57: gh exits 8 while a check runs; one pending is pending.
#[tokio::test]
async fn a_running_check_is_pending() {
    let gh = FakeGh::new("pending");
    gh.answer("view", &viewed("OPEN"), "", 0);
    gh.answer(
        "checks",
        r#"[{"bucket":"pass","name":"linux"},{"bucket":"pending","name":"ts-corpus"}]"#,
        "",
        8,
    );
    let reading = gh.github().read_pull_request(gh.repo(), "fleet/t1").await;
    assert_eq!(
        reading,
        Ok(Some(pr(PullRequestState::Open, ChecksState::Pending, None)))
    );
}

/// github.ts:54 and :58: no checks (gh says so on stderr and prints nothing), or only skipped ones.
#[tokio::test]
async fn no_checks_or_only_skipped_ones_are_none() {
    for (stdout, stderr, code) in [
        ("", "no checks reported on the 'fleet/t1' branch\n", 1),
        (r#"[{"bucket":"skipping","name":"linux"}]"#, "", 0),
        ("[]", "", 0),
    ] {
        let gh = FakeGh::new("no-checks");
        gh.answer("view", &viewed("OPEN"), "", 0);
        gh.answer("checks", stdout, stderr, code);
        let reading = gh.github().read_pull_request(gh.repo(), "fleet/t1").await;
        assert_eq!(
            reading,
            Ok(Some(pr(PullRequestState::Open, ChecksState::None, None))),
            "{stdout:?} {stderr:?}"
        );
    }
}

/// github.ts:40: a branch with no pull request has none (gh's own words).
#[tokio::test]
async fn a_branch_without_a_pull_request_has_none() {
    let gh = FakeGh::new("none");
    gh.answer(
        "view",
        "",
        "no pull requests found for branch \"fleet/does-not-exist-xyz\"\n",
        1,
    );
    let reading = gh
        .github()
        .read_pull_request(gh.repo(), "fleet/does-not-exist-xyz")
        .await;
    assert_eq!(reading, Ok(None));
}

/// github.ts:39-42: what gh said, its first line, when GitHub cannot be asked; or that gh could not.
#[tokio::test]
async fn a_failure_says_gh_s_first_line_or_that_gh_could_not_read() {
    let gh = FakeGh::new("signed-out");
    gh.answer(
        "view",
        "",
        "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable.\n",
        4,
    );
    assert_eq!(
        gh.github().read_pull_request(gh.repo(), "fleet/t1").await,
        Err(GhError(
            "To get started with GitHub CLI, please run:  gh auth login".into()
        ))
    );
    let gh = FakeGh::new("silent");
    gh.answer("view", "", "", 1);
    assert_eq!(
        gh.github().read_pull_request(gh.repo(), "fleet/t1").await,
        Err(GhError("gh could not read the pull request.".into()))
    );
}

/// github.ts:35-37: no gh to start.
#[tokio::test]
async fn no_gh_installed_is_said() {
    let dir = TempDir::new("missing");
    let github = GitHub::with_program(dir.path().join("gh"));
    assert_eq!(
        github.read_pull_request(dir.path(), "fleet/t1").await,
        Err(GhError("The gh command is not installed.".into()))
    );
    let listed = github.list_issues(dir.path()).await.unwrap_err();
    assert!(
        listed.0.starts_with("The gh command could not be run: "),
        "{listed}"
    );
}

/// github.ts:72-75: the merged pull requests, as gh lists them.
#[tokio::test]
async fn lists_the_merged_pull_requests() {
    let gh = FakeGh::new("merged-list");
    gh.answer(
        "prlist",
        r#"[{"baseRefName":"rust","mergedAt":"2026-11-09T03:56:13Z","number":283,"title":"段階 3: 起動の adapter と OpenCode の設定を orchestrator の launch に移す(#248)"},{"baseRefName":"rust","mergedAt":"2026-11-09T03:39:10Z","number":282,"title":"段階 3: herdr-api の型を herdr の schema の全体から Rust の生成器で作る(#245)"}]"#,
        "",
        0,
    );
    let listed = gh.github().list_merged_pull_requests(gh.repo()).await;
    assert_eq!(
        listed,
        Ok(Listing {
            items: vec![
                MergedPullRequest {
                    number: 283,
                    title: "段階 3: 起動の adapter と OpenCode の設定を orchestrator の launch に移す(#248)".into(),
                    merged_at: "2026-11-09T03:56:13Z".into(),
                    base_ref_name: "rust".into(),
                },
                MergedPullRequest {
                    number: 282,
                    title: "段階 3: herdr-api の型を herdr の schema の全体から Rust の生成器で作る(#245)".into(),
                    merged_at: "2026-11-09T03:39:10Z".into(),
                    base_ref_name: "rust".into(),
                },
            ],
            limit_reached: false,
        })
    );
    assert_eq!(
        gh.argv(),
        ["pr list --state merged --limit 200 --json number,title,mergedAt,baseRefName"]
    );
}

/// github.ts:77-80: the issues, open and closed, as gh lists them (labels carry more than the name).
#[tokio::test]
async fn lists_the_issues() {
    let gh = FakeGh::new("issues");
    gh.answer(
        "issues",
        r#"[{"closedAt":null,"createdAt":"2026-11-09T04:07:09Z","labels":[{"id":"LA_kwDOU5_xmM8AAAADBp3cPA","name":"rust-migration","description":"Work of the Rust replacement (rust branch)","color":"1D76DB"},{"id":"LA_kwDOU5_xmM8AAAADBp3e6g","name":"phase:3","description":"Phase 3 of docs/rust-migration/plan.md","color":"C5DEF5"}],"number":284,"title":"段階3: report.jsonのUnixファイル操作をrustixへ置き換える"},{"closedAt":"2026-11-09T05:00:00Z","createdAt":"2026-11-09T03:16:14Z","labels":[],"number":279,"title":"段階 3: orchestrator の manifest に saphyr、saphyr-parser、indexmap を足す"}]"#,
        "",
        0,
    );
    let listed = gh.github().list_issues(gh.repo()).await;
    assert_eq!(
        listed,
        Ok(Listing {
            items: vec![
                IssueSummary {
                    number: 284,
                    title: "段階3: report.jsonのUnixファイル操作をrustixへ置き換える".into(),
                    created_at: "2026-11-09T04:07:09Z".into(),
                    closed_at: None,
                    labels: vec![
                        Label {
                            name: "rust-migration".into()
                        },
                        Label {
                            name: "phase:3".into()
                        }
                    ],
                },
                IssueSummary {
                    number: 279,
                    title:
                        "段階 3: orchestrator の manifest に saphyr、saphyr-parser、indexmap を足す"
                            .into(),
                    created_at: "2026-11-09T03:16:14Z".into(),
                    closed_at: Some("2026-11-09T05:00:00Z".into()),
                    labels: vec![],
                },
            ],
            limit_reached: false,
        })
    );
    assert_eq!(
        gh.argv(),
        ["issue list --state all --limit 500 --json number,title,createdAt,closedAt,labels"]
    );
}

/// Issue #189, item 6: a list as long as the number asked for may leave some out, and says so;
/// one shorter does not.
#[tokio::test]
async fn a_list_that_reaches_its_limit_says_so() {
    let merged = |n: usize| {
        let rows: Vec<String> = (0..n)
            .map(|i| {
                format!(r#"{{"baseRefName":"rust","mergedAt":"2026-11-09T03:56:13Z","number":{i},"title":"t"}}"#)
            })
            .collect();
        format!("[{}]", rows.join(","))
    };
    let issues = |n: usize| {
        let rows: Vec<String> = (0..n)
            .map(|i| {
                format!(r#"{{"closedAt":null,"createdAt":"2026-11-09T04:07:09Z","labels":[],"number":{i},"title":"t"}}"#)
            })
            .collect();
        format!("[{}]", rows.join(","))
    };
    for (rows, reached) in [(199, false), (200, true)] {
        let gh = FakeGh::new("merged-limit");
        gh.answer("prlist", &merged(rows), "", 0);
        let listed = gh
            .github()
            .list_merged_pull_requests(gh.repo())
            .await
            .unwrap();
        assert_eq!((listed.items.len(), listed.limit_reached), (rows, reached));
    }
    for (rows, reached) in [(499, false), (500, true)] {
        let gh = FakeGh::new("issues-limit");
        gh.answer("issues", &issues(rows), "", 0);
        let listed = gh.github().list_issues(gh.repo()).await.unwrap();
        assert_eq!((listed.items.len(), listed.limit_reached), (rows, reached));
    }
}

/// github.ts:64-68: a list gh failed says what gh said, or that it failed; an answer that is not
/// JSON says so.
#[tokio::test]
async fn a_list_that_fails_says_why() {
    let gh = FakeGh::new("list-fail");
    gh.answer(
        "prlist",
        "",
        "HTTP 502: Bad Gateway (https://api.github.com/graphql)\n",
        1,
    );
    gh.answer("issues", "", "", 1);
    let github = gh.github();
    assert_eq!(
        github.list_merged_pull_requests(gh.repo()).await,
        Err(GhError(
            "HTTP 502: Bad Gateway (https://api.github.com/graphql)".into()
        ))
    );
    assert_eq!(
        github.list_issues(gh.repo()).await,
        Err(GhError("gh issue list failed or timed out.".into()))
    );
    let gh = FakeGh::new("list-not-json");
    gh.answer("prlist", "Showing 2 of 2 pull requests", "", 0);
    assert_eq!(
        gh.github().list_merged_pull_requests(gh.repo()).await,
        Err(GhError(
            "gh pr list answered something other than JSON.".into()
        ))
    );
}

/// Issue #255: the module only reads. Every command it runs, through every public method and
/// branch, is one of the four reads; and its source names no command that writes, nor gh's
/// sign-in.
#[tokio::test]
async fn gh_only_reads_and_never_reads_the_sign_in() {
    let gh = FakeGh::new("reads-only");
    gh.answer("view", &viewed("OPEN"), "", 0);
    gh.answer("checks", r#"[{"bucket":"fail","name":"linux"}]"#, "", 1);
    gh.answer("prlist", "[]", "", 0);
    gh.answer("issues", "[]", "", 0);
    let github = gh.github();
    github
        .read_pull_request(gh.repo(), "fleet/t1")
        .await
        .unwrap();
    github.list_merged_pull_requests(gh.repo()).await.unwrap();
    github.list_issues(gh.repo()).await.unwrap();
    let argv = gh.argv();
    assert_eq!(argv.len(), 4);
    for line in &argv {
        let command: Vec<&str> = line.split(' ').take(2).collect();
        assert!(
            [
                ["pr", "view"],
                ["pr", "checks"],
                ["pr", "list"],
                ["issue", "list"]
            ]
            .iter()
            .any(|read| command == read),
            "{line}"
        );
    }

    let source = include_str!("../src/github.rs");
    for word in [
        "\"create\"",
        "\"merge\"",
        "\"edit\"",
        "\"close\"",
        "\"reopen\"",
        "\"comment\"",
        "\"review\"",
        "\"ready\"",
        "\"delete\"",
        "\"lock\"",
        "\"transfer\"",
        "\"develop\"",
        "\"pin\"",
        "\"api\"",
        "\"auth\"",
        "\"label\"",
        "\"release\"",
        "\"repo\"",
        "\"workflow\"",
        "\"run\"",
        "hosts.yml",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GH_ENTERPRISE_TOKEN",
    ] {
        assert!(!source.contains(word), "github.rs names {word}");
    }
}

/// The orchestrator's ports take boxed futures that are `Send` (ADR 0242-phase-3-split).
#[test]
fn every_future_is_send() {
    fn send<T: Send>(_: T) {}
    let (github, path) = (GitHub::new(), Path::new("/nonexistent"));
    send(github.read_pull_request(path, "fleet/t1"));
    send(github.list_merged_pull_requests(path));
    send(github.list_issues(path));
}
