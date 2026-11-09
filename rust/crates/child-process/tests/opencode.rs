//! The client of the person's OpenCode 2 background service through `opencode api`
//! (`server/opencode-cli.ts`): the service asked first, the limits of each read, what is read again
//! and what is not, and the folder and environment the CLI runs with.
//!
//! Each test starts a fake `opencode` in a temporary folder of its own, which records what it was
//! asked and answers from files; no real OpenCode or background service is started (issue #253).
//! The tests moved from `server/opencode-cli.test.ts` name its `test`, and their expected values are
//! its own. The others are worked out by hand from the constants of `server/opencode-cli.ts` and
//! the acceptance of issue #253.

#![cfg(unix)]

mod common;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{TempDir, fake, read, sh_quote};
use herdr_fleet_child_process::KILL_GRACE;
use herdr_fleet_child_process::opencode::{
    OpencodeCli, OpencodeCliOptions, OpencodeError, opencode_api_get,
};

const SID: &str = "ses_testsession0001";

/// A stand-in `opencode`: `service status` answers from the file `state`, `api GET <path>` from a
/// case named by the path's last part. Each call appends a line to `log`: its arguments, its
/// folder, what that folder held, `XDG_DATA_HOME`, how many variables it got that it must not
/// (`HERDR_*`, API keys, `OPENCODE_PASSWORD`), and `OPENCODE_DISABLE_AUTOUPDATE`.
struct Fake {
    dir: TempDir,
    program: PathBuf,
}

impl Fake {
    fn new(label: &str) -> Self {
        let dir = TempDir::new(label);
        let q = |name: &str| sh_quote(&dir.join(name));
        std::fs::write(dir.join("state"), "running").unwrap();
        std::fs::write(dir.join("attempts"), "0").unwrap();
        std::fs::write(
            dir.join("big.json"),
            format!(
                r#"{{"data":[{{"id":"msg_big","type":"user","text":"{}"}}]}}"#,
                "x".repeat(400_000)
            ),
        )
        .unwrap();
        std::fs::write(
            dir.join("ok.json"),
            format!(r#"{{"data":{{"id":"{SID}"}}}}"#),
        )
        .unwrap();
        std::fs::write(dir.join("cut.json"), r#"{"data":{"id":"ses_te"#).unwrap();
        let script = format!(
            r#"echo "$* | cwd=$(pwd) | files=[$(ls -A | tr '\n' ' ')] | xdg=$XDG_DATA_HOME | env=$(env | grep -c '^HERDR\|API_KEY\|OPENCODE_PASSWORD') auto=$OPENCODE_DISABLE_AUTOUPDATE" >> {log}
if [ "$1" = service ] && [ "$2" = status ]; then
  case "$(cat {state})" in
    running) echo http://127.0.0.1:1;;
    slow) sleep 1.2; echo http://127.0.0.1:1;;
    *) echo stopped;;
  esac
  exit 0
fi
if [ "$1" = api ]; then
  case "$3" in
    */big) cat {big};;
    */cut) n=$(cat {attempts}); echo $((n+1)) > {attempts}
           if [ "$n" -lt 1 ]; then cat {cut}; else cat {ok}; fi;;
    */hang) trap '' TERM; sleep 5; cat {ok};;
    */fail) echo 'boom: "quoted" detail' >&2; exit 3;;
    */huge) head -c 5000 /dev/zero | tr '\0' a;;
    */nine) printf '"'; head -c 9437184 /dev/zero | tr '\0' a; printf '"';;
    */over) printf '"'; head -c 33554432 /dev/zero | tr '\0' a; printf '"';;
    */slow) echo start >> {overlap}; sleep 0.3; echo end >> {overlap}; cat {ok};;
    */alwayscut) cat {cut};;
    */missing) echo '{{"_tag":"SessionNotFoundError","message":"x"}}'; echo "HTTP 404 Not Found" >&2; exit 1;;
    */nostatus) echo '{{"message":"x"}}'; exit 1;;
    */noisy) printf 'first\tline\n\033[31msecond' >&2; head -c 300 /dev/zero | tr '\0' c >&2; exit 4;;
    */blank) printf ' \n\t' >&2; exit 5;;
    */tag) cat {tag}; echo "HTTP 400 Bad Request" >&2; exit 1;;
    */deep) i=0; while [ $i -lt 200 ]; do printf '['; i=$((i+1)); done; i=0; while [ $i -lt 200 ]; do printf ']'; i=$((i+1)); done;;
    */litter) touch left-behind; cat {ok};;
    *) cat {ok};;
  esac
  exit 0
fi
exit 2"#,
            log = q("log"),
            state = q("state"),
            big = q("big.json"),
            attempts = q("attempts"),
            cut = q("cut.json"),
            ok = q("ok.json"),
            overlap = q("overlap"),
            tag = q("tag.json"),
        );
        let program = fake(dir.path(), "opencode", &script);
        Self { dir, program }
    }

    fn work(&self) -> PathBuf {
        self.dir.join("work")
    }

    /// The options a server with `HERDR_*`, an API key and `OPENCODE_PASSWORD` in its environment
    /// would give, for this fake.
    fn options(&self) -> OpencodeCliOptions {
        let env: BTreeMap<OsString, OsString> = [
            ("PATH", std::env::var("PATH").unwrap_or_default()),
            ("HOME", self.dir.path().display().to_string()),
            ("HERDR_PANE_ID", "p".into()),
            ("OPENAI_API_KEY", "sk".into()),
            ("OPENCODE_PASSWORD", "pw".into()),
            ("XDG_DATA_HOME", "/xdg-data".into()),
        ]
        .into_iter()
        .map(|(name, value)| (name.into(), value.into()))
        .collect();
        let mut options = OpencodeCliOptions::new(self.work(), env);
        options.command = self.program.clone().into();
        options
    }

    fn cli(&self) -> OpencodeCli {
        OpencodeCli::new(self.options())
    }

    fn with(&self, change: impl FnOnce(&mut OpencodeCliOptions)) -> OpencodeCli {
        let mut options = self.options();
        change(&mut options);
        OpencodeCli::new(options)
    }

    fn set_state(&self, state: &str) {
        std::fs::write(self.dir.join("state"), state).unwrap();
    }

    fn calls(&self) -> Vec<String> {
        read(&self.dir.join("log"))
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn calls_of(&self, needle: &str) -> usize {
        self.calls()
            .iter()
            .filter(|line| line.contains(needle))
            .count()
    }
}

fn other(result: Result<serde_json::Value, OpencodeError>) -> String {
    match result {
        Err(OpencodeError::Other(message)) => message,
        unexpected => panic!("expected a failed read, got {unexpected:?}"),
    }
}

#[test]
fn the_options_are_those_of_the_typescript() {
    // server/opencode-cli.ts: CLI_TIMEOUT_MS 20_000, KILL_GRACE_MS 2_000, MAX_CHILDREN 4,
    // attempts 3, command "opencode"; the reply limit is left to OpencodeCli and opencode_api_get
    let env: BTreeMap<OsString, OsString> = [("HOME".into(), "/home/x".into())].into();
    let options = OpencodeCliOptions::new("/work", env.clone());
    assert_eq!(options.work_dir, PathBuf::from("/work"));
    assert_eq!(options.command, OsString::from("opencode"));
    assert_eq!(options.env, env);
    assert_eq!(options.attempts, 3);
    assert_eq!(options.timeout, Duration::from_secs(20));
    assert_eq!(options.kill_grace, KILL_GRACE);
    assert_eq!(options.max_reply_bytes, None);
    assert_eq!(options.max_children, 4);
}

/// `server/opencode-cli.test.ts`: "a reply of hundreds of kilobytes arrives whole at the reading
/// end (the writer's own cut is not reproducible here)".
#[tokio::test]
async fn a_reply_of_hundreds_of_kilobytes_arrives_whole() {
    let fake = Fake::new("big");
    let body = fake.cli().get("/api/session/big").await.unwrap();
    assert_eq!(body["data"][0]["text"].as_str().unwrap().len(), 400_000);
}

/// `server/opencode-cli.test.ts`: "a reply cut short (a file standing in for the cut) is read
/// again; one that stays cut is a failed read, not a crash". A reply that stays cut is read 3 times
/// in all (`attempts ?? 3`).
#[tokio::test]
async fn a_cut_reply_is_read_again_and_one_that_stays_cut_is_a_failed_read() {
    let fake = Fake::new("cut");
    assert_eq!(
        fake.cli().get("/api/session/cut").await.unwrap(),
        serde_json::json!({ "data": { "id": SID } })
    );
    assert_eq!(fake.calls_of("/api/session/cut"), 2);
    let message = other(fake.cli().get("/api/session/alwayscut").await);
    assert!(message.contains("no JSON"), "{message}");
    assert_eq!(fake.calls_of("/api/session/alwayscut"), 3);
}

/// `server/opencode-cli.test.ts`: "a CLI that ignores SIGTERM is killed, and the read ends with a
/// timeout that is not tried again".
#[tokio::test]
async fn a_cli_that_ignores_sigterm_is_killed_and_the_timeout_is_not_tried_again() {
    let fake = Fake::new("hang");
    let started = Instant::now();
    let cli = fake.with(|options| {
        options.timeout = Duration::from_millis(300);
        options.kill_grace = Duration::from_millis(200);
    });
    let message = other(cli.get("/api/session/hang").await);
    assert!(message.contains("timed out"), "{message}");
    assert!(started.elapsed() < Duration::from_millis(2_500));
    assert_eq!(fake.calls_of("/api/session/hang"), 1);
}

/// `server/opencode-cli.test.ts`: "an error exit with nothing to read is not tried again, and keeps
/// what the CLI said".
#[tokio::test]
async fn an_error_exit_with_nothing_to_read_is_not_tried_again_and_keeps_what_the_cli_said() {
    let fake = Fake::new("fail");
    let message = other(fake.cli().get("/api/session/fail").await);
    assert!(message.contains("exit 3"), "{message}");
    assert!(message.contains(r#"boom: "quoted" detail"#), "{message}");
    assert_eq!(fake.calls_of("/api/session/fail"), 1);
}

/// `server/opencode-cli.test.ts`: "a reply past the limit is dropped, not held". Not read again
/// either (issue #253).
#[tokio::test]
async fn a_reply_past_the_limit_is_dropped_not_held() {
    let fake = Fake::new("huge");
    let cli = fake.with(|options| options.max_reply_bytes = Some(1000));
    let message = other(cli.get("/api/session/huge").await);
    assert!(message.contains("more than 1000 bytes"), "{message}");
    assert_eq!(fake.calls_of("/api/session/huge"), 1);
}

/// What the CLI said is kept as one printable line: each run of characters outside printable
/// ASCII one space, at most 200 characters (`head`, `server/opencode-cli.ts:54`); nothing but white
/// space adds nothing (`stderr.trim() ? ... : ""`). Worked out by hand: "first line [31msecond" is
/// 21 characters, and 179 `c` fill the 200.
#[tokio::test]
async fn what_the_cli_said_is_kept_as_one_printable_line() {
    let fake = Fake::new("noisy");
    assert_eq!(
        other(fake.cli().get("/api/session/noisy").await),
        format!(
            "opencode api returned no JSON (exit 4: first line [31msecond{})",
            "c".repeat(179)
        )
    );
    assert_eq!(
        other(fake.cli().get("/api/session/blank").await),
        "opencode api returned no JSON (exit 5)"
    );
}

/// A page of messages may be up to 32 MiB (`MAX_REPLY_BYTES`), a model list through
/// `opencode_api_get` up to 8 MiB (`MODEL_REPLY_BYTES`) when the options name no limit.
#[tokio::test]
async fn a_page_may_be_32_mib_and_a_model_list_8_mib() {
    let fake = Fake::new("limits");
    // 9 MiB of `a` between two quotes: past 8 MiB, under 32 MiB
    let body = fake.cli().get("/api/model/nine").await.unwrap();
    assert_eq!(body.as_str().unwrap().len(), 9 * 1024 * 1024);
    let message = other(opencode_api_get(fake.options(), "/api/model/nine").await);
    assert!(
        message.contains(&format!("more than {} bytes", 8 * 1024 * 1024)),
        "{message}"
    );
    // 32 MiB and two quotes: past 32 MiB
    let message = other(fake.cli().get("/api/model/over").await);
    assert!(
        message.contains(&format!("more than {} bytes", 32 * 1024 * 1024)),
        "{message}"
    );
    // a limit the options name holds for opencode_api_get too
    let mut options = fake.options();
    options.max_reply_bytes = Some(10 * 1024 * 1024);
    assert!(opencode_api_get(options, "/api/model/nine").await.is_ok());
}

/// `server/opencode-cli.test.ts`: "no more CLIs run at once than allowed, however many ask".
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_more_clis_run_at_once_than_allowed_however_many_ask() {
    let fake = Fake::new("overlap");
    let cli = Arc::new(fake.with(|options| options.max_children = 2));
    let mut reads = tokio::task::JoinSet::new();
    for _ in 0..6 {
        let cli = Arc::clone(&cli);
        reads.spawn(async move { cli.get("/api/session/slow").await });
    }
    while let Some(read) = reads.join_next().await {
        read.unwrap().unwrap();
    }
    let (mut open, mut most) = (0, 0);
    for line in read(&fake.dir.join("overlap")).lines() {
        open += if line == "start" { 1 } else { -1 };
        most = most.max(open);
    }
    assert_eq!(most, 2);
}

/// `server/opencode-cli.test.ts`: "panels asking whether the service runs share one question".
#[tokio::test]
async fn panels_asking_whether_the_service_runs_share_one_question() {
    let fake = Fake::new("share");
    let cli = fake.cli();
    let answers = tokio::join!(
        cli.service_running(),
        cli.service_running(),
        cli.service_running()
    );
    assert_eq!(answers, (true, true, true));
    assert_eq!(fake.calls_of("service status"), 1);
}

/// Callers that ask while a question is still out share its answer, also when the question takes
/// longer than the answer is kept (`asking ??=`, `server/opencode-cli.ts:159`).
#[tokio::test]
async fn callers_waiting_on_a_slow_question_share_its_answer() {
    let fake = Fake::new("slow-share");
    fake.set_state("slow");
    let cli = fake.cli();
    let answers = tokio::join!(
        cli.service_running(),
        cli.service_running(),
        cli.service_running()
    );
    assert_eq!(answers, (true, true, true));
    assert_eq!(fake.calls_of("service status"), 1);
}

/// The answer is kept for a second (`SERVICE_TTL_MS`), and asked again after it.
#[tokio::test]
async fn the_answer_is_kept_for_a_second() {
    let fake = Fake::new("ttl");
    let cli = fake.cli();
    assert!(cli.service_running().await);
    fake.set_state("stopped");
    assert!(cli.service_running().await);
    assert_eq!(fake.calls_of("service status"), 1);
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    assert!(!cli.service_running().await);
    assert_eq!(fake.calls_of("service status"), 2);
}

/// `server/opencode-cli.test.ts`: "an HTTP error carries its status and tag".
#[tokio::test]
async fn an_http_error_carries_its_status_and_tag() {
    let fake = Fake::new("http");
    assert_eq!(
        fake.cli().get("/api/session/missing").await,
        Err(OpencodeError::Http {
            status: 404,
            tag: "SessionNotFoundError".into()
        })
    );
    // no `HTTP <code>` on stderr and no `_tag`: 0 and "" (server/opencode-cli.ts:151-152)
    assert_eq!(
        fake.cli().get("/api/session/nostatus").await,
        Err(OpencodeError::Http {
            status: 0,
            tag: String::new()
        })
    );
}

/// A `_tag` that is not a string is written as JavaScript's `String` writes it (`String(record(body)
/// ["_tag"] ?? "")`, `server/opencode-cli.ts:152`). The expected values are Bun's answers to that
/// expression for each body.
#[tokio::test]
async fn a_tag_that_is_not_a_string_is_written_as_javascript_writes_it() {
    let fake = Fake::new("tag");
    for (body, expected) in [
        (r#"{"_tag":1.0}"#, "1"),
        (r#"{"_tag":["a",null,"b"]}"#, "a,,b"),
        (r#"{"_tag":{}}"#, "[object Object]"),
        (r#"{"_tag":1e21}"#, "1e+21"),
        (r#"{"_tag":0.0000001}"#, "1e-7"),
        (r#"{"_tag":true}"#, "true"),
        (r#"{"_tag":-0}"#, "0"),
        (r#"{"_tag":null}"#, ""),
        ("[1]", ""),
    ] {
        std::fs::write(fake.dir.join("tag.json"), body).unwrap();
        assert_eq!(
            fake.cli().get("/api/session/tag").await,
            Err(OpencodeError::Http {
                status: 400,
                tag: expected.into()
            }),
            "{body}"
        );
    }
}

/// serde_json reads no deeper than 128 levels, where `JSON.parse` (Bun) reads 200: such a reply is
/// no JSON, read 3 times like a cut one. A known difference from TypeScript, written in
/// `OpencodeCli`'s documentation.
#[tokio::test]
async fn a_reply_nested_past_serde_jsons_limit_is_no_json() {
    let fake = Fake::new("deep");
    let message = other(fake.cli().get("/api/session/deep").await);
    assert!(message.contains("no JSON (exit 0)"), "{message}");
    assert_eq!(fake.calls_of("/api/session/deep"), 3);
}

/// `server/opencode-cli.test.ts`: "it runs in a folder of its own, with only the environment it
/// needs". `XDG_*` passes (`childEnv`).
#[tokio::test]
async fn it_runs_in_a_folder_of_its_own_with_only_the_environment_it_needs() {
    let fake = Fake::new("env");
    fake.cli().get("/api/session/ok").await.unwrap();
    let last = fake.calls().pop().unwrap();
    let work = std::fs::canonicalize(fake.work()).unwrap();
    assert!(last.contains(&format!("cwd={}", work.display())), "{last}");
    assert!(last.contains("xdg=/xdg-data"), "{last}");
    assert!(last.ends_with("env=0 auto=true"), "{last}");
}

/// The folder is emptied before the client's first run, and not under a run of its own after that
/// (`prepared`, `server/opencode-cli.ts:111`); `opencode_api_get` makes a client per call, so each
/// call empties it.
#[tokio::test]
async fn the_folder_is_emptied_before_the_first_run_and_for_each_model_list() {
    let fake = Fake::new("empty");
    std::fs::create_dir(fake.work()).unwrap();
    std::fs::write(fake.work().join("stale"), "from a run before").unwrap();
    let cli = fake.cli();
    cli.get("/api/session/litter").await.unwrap();
    cli.get("/api/session/ok").await.unwrap();
    opencode_api_get(fake.options(), "/api/model")
        .await
        .unwrap();
    let calls = fake.calls();
    let files: Vec<&str> = calls
        .iter()
        .map(|line| line.split(" | ").nth(2).unwrap())
        .collect();
    assert_eq!(
        files,
        ["files=[]", "files=[left-behind ]", "files=[]", "files=[]",],
        "{calls:#?}"
    );
}

/// A link or a file in the folder's place is refused (`empty_work_dir`): the CLI is never run
/// elsewhere, a read fails, and the service counts as not known to run.
#[tokio::test]
async fn a_folder_that_cannot_be_emptied_runs_nothing() {
    let fake = Fake::new("refused");
    let elsewhere = fake.dir.join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, fake.work()).unwrap();
    other(fake.cli().get("/api/session/ok").await);
    assert!(!fake.cli().service_running().await);
    assert!(!other(opencode_api_get(fake.options(), "/api/model").await).is_empty());
    assert_eq!(fake.calls(), Vec::<String>::new());
}

/// `server/opencode-cli.test.ts`: "an OpenCode without `service` and `api` (1.x) leaves the pane
/// on its scrollback and is asked nothing more". The pane's scrollback is transcript's part (its
/// reader takes "no service" as no conversation); here the client answers "no service" after one
/// `service status`, and asks nothing more.
#[tokio::test]
async fn an_opencode_without_service_and_api_is_asked_nothing_more() {
    let dir = TempDir::new("old");
    let log = dir.join("old-log");
    // what 1.19 does with `opencode service status`: its help on stderr, nothing on stdout, exit 1
    let old = fake(
        dir.path(),
        "opencode",
        &format!(
            "echo \"$@\" >> {}\necho \"Commands: opencode [project]\" >&2\nexit 1",
            sh_quote(&log)
        ),
    );
    let env: BTreeMap<OsString, OsString> = [
        ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
        ("HOME".into(), dir.path().as_os_str().to_owned()),
    ]
    .into();
    let mut options = OpencodeCliOptions::new(dir.join("work"), env);
    options.command = old.into();
    let message = other(opencode_api_get(options.clone(), "/api/session").await);
    assert!(
        message.contains("no OpenCode service is running"),
        "{message}"
    );
    assert_eq!(read(&log).lines().collect::<Vec<_>>(), ["service status"]);
    assert!(!OpencodeCli::new(options).service_running().await);
}

/// `server/opencode-cli.test.ts`: "whether the service runs is asked, not assumed, and a stopped
/// one is never asked anything else". As above, the reader's part is transcript's.
#[tokio::test]
async fn whether_the_service_runs_is_asked_and_a_stopped_one_is_never_asked_anything_else() {
    let fake = Fake::new("stopped");
    assert!(fake.cli().service_running().await);
    fake.set_state("stopped");
    let fresh = fake.cli();
    assert!(!fresh.service_running().await);
    let before = fake.calls().len();
    let message = other(opencode_api_get(fake.options(), "/api/session").await);
    assert!(
        message.contains("no OpenCode service is running"),
        "{message}"
    );
    let after = fake.calls();
    assert!(after.len() > before);
    assert!(
        after[before..]
            .iter()
            .all(|line| line.starts_with("service status")),
        "{after:#?}"
    );
}
