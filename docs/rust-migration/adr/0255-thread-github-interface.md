# thread の git と GitHub の読み取りの公開の口

- 状態: 採用
- 決めた日: 2026-11-09
- Issue: #255

## 状況

ADR `0242-phase-3-split` は、`server/fleet/thread.ts` と `server/fleet/github.ts` を orchestrator の `thread` と `github` の module に移し(L6)、git、`gh`、利用者の setup のコマンドを C1 の runner で起動すると決めた。module の公開の口は L6 が決める。この口を呼ぶのは、あとの O1(#256。spawn と、委ねたターンの決着の `diffStat`)、O6(#266。landing と `LandingTools` の impl)、L8(#259。`fleet report`)と API(#269)である。そのため、次のことを決める必要があった。

- C1 の `Runner` を、呼ぶ側から受け取るか、module の中で作るか
- テストが偽の `gh` を渡す方法。`unsafe_code = "forbid"` の下では、テストが `std::env::set_var` で `PATH` を変えられない
- Issue #189 の 6(`gh pr list --limit 200` と `gh issue list --limit 500` が、上限に達したことを知らせない)を、Rust 版でどう扱うか。2026-11-09 の時点で main は直っていない(`git diff origin/rust origin/main -- server/fleet/github.ts` は空)
- C1 の runner が、時間切れで止めた子の出力を返さないこと(`RunError::TimedOut`)への対処

architect(fleet の run `305f385f`)に問い、その答えに従った。

## 決定

### thread

- TypeScript と同じく、async の自由関数にする: `git_root`、`main_worktree`、`git_head`、`git_branch`、`diff_stat`、`diff_text`、`branch_state`、`branch_head`、`is_merged`、`remove_thread`、`exclude_worktrees`、`run_setup`。TypeScript が `null` を返す場面では `None` を返す
- `Runner` は引数で受け取らず、module の中に `Runner::new(usize::MAX)` を 1 つだけ置き(`LazyLock` の static)、すべての呼び出しがそれを使う。git と setup のコマンドは、TypeScript でも同時に動かす数を数えない。引数にすると、Runner を作る呼ぶ側(O6 の `LandingTools` の impl と、API の `fleet report`)のそれぞれが「上限なし」を書くことになり、上限のある Runner(`opencode api` の 4 つなど)を誤って渡すと、git が別の用途の子プロセスを待つ。上限を置くときは、`thread.rs` の中だけを変える
- `remove_thread` は `Result<(), String>` を返す。`Err` の文は、残したもの(worktree かブランチ)とその理由で、TypeScript の戻り値の文と同じ。`Result` は `#[must_use]` なので、O6 がこの文を捨てるとコンパイラが警告する
- `worktree_path(repo, thread_id)` を足す。worktree の場所(`<repo>/.herdr-fleet/worktrees/<thread の id>`)を、TypeScript は spawn(`orchestrator.ts:528`)と thread を閉じる処理(`:1146`)の 2 か所で組み立てている
- `DiffText { diff, truncated }` は `Serialize` を持つ。API は diff をこの形の JSON で返し、画面がそれを読む(`server/fleet/api.ts:154`、`src/lib/api.ts:487`)
- `exclude_worktrees` は、`info/exclude` の読み取り、確認、追記を、プロセスの中の 1 つの `Mutex` の下で行う。TypeScript ではこの 3 つが 1 つの event loop の上で続けて動き、割り込まれなかった。Rust の multi-thread の runtime では、同じリポジトリに同時に始めた 2 つの thread が、どちらも行がないと読んで 2 行書きうる(テストで再現した)
- git が起動できないか時間切れで止められたとき、`remove_thread` の文は TypeScript と同じ `git could not remove it`(ブランチは `git could not delete it`)になる。TypeScript は止めた git の何も言わない標準エラーを読んだためである
- すべての future が `Send` であることを、テストで確かめる。O1 の port は `Send` の boxed future を求める(ADR `0242-phase-3-split`)

### github

- `GitHub` の値が、起動するプログラムを持つ。`GitHub::new()` は `gh` を使い、テストは `GitHub::with_program(<偽の gh のパス>)` を使う。Runner は thread と同じ理由で値の中で作る
- method は `read_pull_request`(`Result<Option<PullRequestReading>, GhError>`)、`list_merged_pull_requests`、`list_issues`(どちらも `Result<Listing<T>, GhError>`)の 3 つ。`PullRequestReading` は protocol の `PullRequest` と head の commit を持つ。`GhError` は人が読む文だけを持つ。O6 は TypeScript と同じく、この文を画面の `prError` と landing のエラーに入れるだけである
- `gh` の argv、時間の上限(20 秒)、足す環境変数(`GH_PROMPT_DISABLED=1`、`GH_NO_UPDATE_NOTIFIER=1`、`NO_COLOR=1`、`GIT_TERMINAL_PROMPT=0`)は TypeScript と同じ。環境変数は、サーバーの環境を引き継いだうえで、この 4 つを足す(`EnvPolicy::Inherit`)

### #189 の 6: 一覧の上限

- `Listing<T> { items, limit_reached }` を返す。`limit_reached` は、返った件数が頼んだ件数(200 と 500)以上のとき立つ。argv は TypeScript のまま(`--limit 200`、`--limit 500`)
- 根拠: `gh pr list --state merged` は、state の絞り込みを GitHub の側で行い、最大 `--limit` 件を返す。architect が、このリポジトリで読むだけのコマンドで確かめた(`--state merged --limit 12` は MERGED を 12 件返した。`--state all --limit 12` の 12 件のうち 6 件は OPEN だった)。そのため、件数が上限より少なければ一覧は全部で、上限と同じなら古いものが漏れている可能性がある
- 報告にどう書くかは L8 が決める。マージ済みがちょうど 200 件のときは、漏れがなくても `limit_reached` が立つので、文は「古いものが漏れている可能性がある」にする

### setup のコマンドの時間切れ

- 10 分を過ぎたら runner が止め(SIGTERM、2 秒後に SIGKILL)、`SetupOutcome { ok: false, output: "It ran longer than 10 minutes, and was stopped." }` を返す。取り消したときは `ok: false` と `cancelled` を返す。O1 は TypeScript と同じく、`run_setup` のあとで取り消しを見て、取り消しなら `setup_failed` にしない(`orchestrator.ts:644-645`)
- TypeScript は時間切れで SIGTERM を 1 回送り、子が終われば、それまでの出力の最後の 20 行を返す。子が SIGTERM を無視するか、孫のプロセスが pipe を持ち続けると、`runSetup` は返らない。Rust は必ず返るが、途中の出力を返さない。途中の出力も返すには C1 の公開の enum `RunError` を変える必要があり(expand、migrate、contract の 3 つの Issue)、まれな失敗のためには見合わない

## 検討した代わり

- `Runner` を引数で受け取る: 上の「thread」の理由で取らない。この形で書いた最初の版を、architect の答えで直した
- `Git { runner }` の struct: 持つものが Runner だけで、プログラムは C1 の `git::command` が `git` に決めている。テストは本物の git を使うので、struct にしても隠すものがない
- `gh` のプログラムを各 method の引数にする: 本番の呼ぶ側のすべてが `"gh"` を書くことになる
- 一覧で `limit + 1` 件を頼み、超えたら切る: 判定は正確になるが、argv が TypeScript と変わる
- 一覧を `--search "merged:>=<日付>"` や `--base` で GitHub の側で絞る: 漏れ自体を減らせるが、metrics の時間帯と base の決まり(`server/fleet/metrics.ts`)を github も知ることになる。Issue #255 はこの変更を求めていない

## 依存

なし

## 結果

- O1 と O6 は、`thread` の関数と `GitHub` を、O1 が定義する trait の impl から呼ぶ。architect は、TypeScript のテストが `gitRoot`、`excludeWorktrees`、`gitHead`、`diffStat`、`runSetup` も偽物に差し替えていること(`orchestrator.ts:122-130`、`orchestrator.test.ts:98-100`)を見つけた。ADR `0242-phase-3-split` の「これらは LandingTools を通らずに thread.ts の関数を直接呼ぶ。TypeScript のテストも一時の git リポジトリで本物の関数を通す」という文は、このテストと合わない。O1 の trait にこの 5 関数を含めるかは O1 が決める。L6 の関数の signature は、そのまま trait の method に写せる
- L8 は `Listing` の `limit_reached` を読み、上限に達した一覧を報告に書く
- TypeScript と変わる点は次の 4 つ。どれも Issue #255 の PR の本文に書く
  - setup のコマンドの時間切れでは、途中の出力の代わりに止めた理由を返す(上の節)
  - `sh` を起動できないとき(作業フォルダーがないなど)、TypeScript の `runSetup` は reject し、Rust は `ok: false` と `could not start: …` を返す
  - `diff_stat` は、numstat が 8 MiB を超える(10 万を超えるファイルの変更)と `None` を返す。TypeScript はすべて読んで数える。一部だけを数えた値より、値がないほうを選んだ(ADR `0246-child-process-interface` は、8 MiB を超えうる読み取りの上限を L6 が選ぶとした)
  - 一覧が上限に達したことを `limit_reached` で知らせる(#189 の 6)

## 確かめたこと

- `cargo test --locked -p herdr-fleet-orchestrator --test thread --test github`: thread 17 件、github 16 件が通る。`thread.test.ts` の 7 件の `it` は、`tests/thread.rs` の最初の 7 件にある
- `gh pr view`、`gh pr checks`、`gh pr list --state merged`、`gh issue list --state all` と、pull request のないブランチへの `gh pr view` の実際の出力を、gh 2.103.3 でこのリポジトリから読み、偽の `gh` の答えにした
