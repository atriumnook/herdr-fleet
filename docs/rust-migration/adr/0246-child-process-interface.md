# child-process の公開の口: 環境変数の方針、私用のフォルダー、上限つきの runner、git、opencode の stub

- 状態: 採用
- 決めた日: 2026-11-09
- Issue: #246

## 状況

ADR `0242-phase-3-split` の「子プロセス」は、ペインの外で起動する子プロセス(使用量の probe、モデル一覧、`opencode api`、git、`gh`、利用者の setup のコマンド)をすべて child-process の runner に通すと決め、runner が持つものを挙げた。時間の上限を過ぎたら SIGTERM、その 2 秒後に SIGKILL、さらに 2 秒で読み取りをあきらめる。ほかに、標準出力と標準エラーの上限、同時に動かす数の上限、`CancellationToken`、標準入力に書き標準出力を 1 行ずつ読むやりとり、起動ごとに呼ぶ側が選ぶ環境変数の方針を持つ。この Issue(C1)は、その口を、あとの Issue(C2 #253、L3 #254、L4 #258、L6 #255、段階 4 の core)が使う形で決める必要があった。

制約は次のとおり。

- child-process の依存は tokio、tokio-util、rustix(Unix だけ)で、serde_json はない(ADR `0244-phase-3-dependencies`)。manifest はこの Issue では書けない(ADR `0242-phase-3-split` の「Issue の分け方」)
- OpenCode の会話の読み取りが受ける trait `OpencodeApi` は transcript が定義し、同期の関数である(`rust/crates/transcript/src/opencode/mod.rs:29`)。本番では core が child-process の OpenCode の client を包む(ADR `0107-crate-split` の 59 行目)
- `unsafe_code = "forbid"`(`rust/Cargo.toml`)。テストはプロセスの環境変数を変えられない

## 決定

### module

`src/` に `env`、`work_dir`、`runner`、`git`、`opencode` を置く。`env`、`work_dir`、`runner` の公開の型と関数は crate の root から使う(`herdr_fleet_child_process::Runner` など)。`git` と `opencode` は module のまま公開する(`git::command`、`opencode::OpencodeCli`)。`git` には `TIMEOUT` のように短い名前の定数があり、root に置くと何の時間か読めないため。

### 環境変数(`env`)

- `Env` は `BTreeMap<OsString, OsString>`。OS の環境変数は UTF-8 とは限らないので、`String` にすると値を失うか、読み取りで panic する
- `child_env(&Env, also_keep: &[&str]) -> Env` と `claude_env(&Env) -> Env` は `server/cli-child.ts` の `childEnv` と `claudeEnv` の写し。名前が UTF-8 でない変数は、どの規則にも当たらず渡さない。残す変数の値は、そのまま渡す
- `EnvPolicy` は `Only(Env)`(この変数だけ。`env_clear` のあとに足す)と `Inherit(Env)`(サーバーの環境変数に、この変数を上書きで足す)の 2 つ。`Command::new` の引数で、既定の値はない。呼ぶ側は起動ごとに必ずどちらかを書く。`Only` は使用量の probe、モデル一覧、`opencode api` が `child_env` か `claude_env` の結果を渡す。`Inherit` は git、`gh`(`GH_PROMPT_DISABLED` など 4 つ、`server/fleet/github.ts:14`)、利用者の setup のコマンド(`GIT_TERMINAL_PROMPT=0`、`server/fleet/thread.ts:174`)が使う

### 私用のフォルダー(`work_dir`)

`empty_work_dir(&Path) -> io::Result<()>` は `emptyWorkDir`(`server/cli-child.ts:36`)の写し。0700 で作り(途中のフォルダーも 0700)、すでにあれば 0700 に戻し、中身を消す。フォルダーの場所に symlink かファイルがあれば、`ErrorKind::NotADirectory` で断り、何も消さない。中の symlink は、指す先をたどらずに symlink だけを消す。

### runner(`runner`)

```rust
pub struct Runner;                 // Clone。clone は同じ上限を分け合う
impl Runner {
    pub fn new(max_children: usize) -> Self;   // 0 は panic
    pub async fn run(&self, command: Command, cancel: &CancellationToken) -> Result<Output, RunError>;
    pub async fn session(&self, command: Command, cancel: &CancellationToken) -> Result<Session, RunError>;
}
pub struct Command;
impl Command {
    pub fn new(program: impl Into<OsString>, cwd: impl Into<PathBuf>, env: EnvPolicy, timeout: Duration) -> Self;
    pub fn arg(self, …) -> Self;  pub fn args(self, …) -> Self;
    pub fn stdin(self, input: Vec<u8>) -> Self;          // 書いてから閉じる。なければ /dev/null
    pub fn timeout(self, …) -> Self;  pub fn kill_grace(self, …) -> Self;    // 既定は KILL_GRACE(2 秒)
    pub fn stdout_limit(self, StreamLimit) -> Self;      // 既定は Fail(8 MiB)
    pub fn stderr_limit(self, StreamLimit) -> Self;      // 既定は Head(4096)
}
pub enum StreamLimit { Fail(usize), Head(usize), Tail(usize) }
pub struct Output { pub code: Option<i32>, pub stdout: Vec<u8>, pub stderr: Vec<u8> }
pub enum RunError { Spawn(io::Error), Io(io::Error), TimedOut, Cancelled, TooLarge { stream: Stream, limit: usize } }
pub struct Session;
impl Session {
    pub async fn send_line(&mut self, line: &str) -> Result<(), RunError>;
    pub async fn next_line(&mut self) -> Result<Option<String>, RunError>;
    pub async fn close(self);
}
```

- 同時に動かす数の上限は、`Runner` が持つ `tokio::sync::Semaphore` で数える。使い道ごとに 1 つの `Runner` を作る(`opencode api` は 4 つまで、`server/opencode-cli.ts:19`)。process 全体で 1 つの上限にはしない。TypeScript も使い道ごとに数えており、probe とモデル一覧と `opencode api` が互いを待つことはないため
- 時間の上限は、順番を待ち終えて起動したときから数える(`server/opencode-cli.ts` の `slot` の中で timer を始めるのと同じ)。順番を待つ間に取り消されたら、起動せずに `Cancelled` を返す
- 終了コードが 0 でないことは、エラーにせず `Output` の `code` で返す。`opencode api` は終了コード 1 の本文から HTTP の状態を読み(`server/opencode-cli.ts:149`)、git は失敗の文を `stderr` から読むため
- 止め方: 時間の上限か取り消しで、子の pid に SIGTERM を rustix の `kill_process` で送る。`kill_grace` 後に SIGKILL(tokio の `start_kill`)、さらに `kill_grace` 後に読み取りをあきらめ、`TimedOut` か `Cancelled` を返す。子が SIGTERM で終わり、出力が閉じれば、その時点で返す。process group には送らない。SIGTERM を送るのは、tokio がまだ子を回収していないとき(`Child::id` が `Some`)だけにする。回収したあとの pid は、別のプロセスのものになっていることがあるため。Windows には SIGTERM がないので、`cfg(not(unix))` では最初の段階から `start_kill` にする
- `StreamLimit` は、出力を最後まで読み、どれだけ残すかを決める。`Fail(n)` は n バイトを超えたら `TooLarge` で失敗し、子を待たずに SIGKILL を送る(`server/opencode-cli.ts:131` と同じ)。`Head(n)` は先頭の n バイト、`Tail(n)` は末尾の n バイトを残す。`Tail` は setup のコマンドの出力の最後の 20 行(`server/fleet/thread.ts:182`)のため。既定の `Fail(8 MiB)` は ADR `0242-phase-3-split` が probe とモデル一覧に決めた値、`Head(4096)` は `server/opencode-cli.ts:127` が標準エラーを読む量。TypeScript は上限を超えた標準エラーを空の文字列にするが、Rust は先頭の 4096 バイトを残す。失敗の文の先頭が読めるほうが、原因を探しやすいため
- `Session` は `codex app-server` の JSON-RPC(`server/fleet/usage.ts:426`、`server/fleet/model-lists.ts:127`)のための口。時間の上限は、起動から `close` までの全体にかかる(TypeScript の 1 つの `setTimeout` と同じ)。行の長さの上限は、標準出力の `StreamLimit` のバイト数にする。標準エラーは読まずに `/dev/null` に捨てる(TypeScript の `stderr: "ignore"`)。UTF-8 でないバイトは U+FFFD に置き換える。`close` は標準入力を閉じ、終わっていない子を run と同じ順で止める。`close` を呼ばずに落とした `Session` は、tokio の `kill_on_drop` で SIGKILL を受ける。`Session` も、`close` まで `Runner` の上限の 1 つを使う

### git(`git`)

`git::command(cwd, &[args]) -> Command` は、`git -c core.fsmonitor=false -c core.quotepath=false -C <cwd> <args>` を、`EnvPolicy::Inherit` に `GIT_OPTIONAL_LOCKS=0` と `GIT_TERMINAL_PROMPT=0` を入れて作る。時間の上限は `git::TIMEOUT`(5 秒、`server/fleet/thread.ts:31`)。`git::QUICK_TIMEOUT`(3 秒、`server/fleet/thread.ts:21` の `gitRoot` と `server/files.ts:20` の `gitFiles`)は、呼ぶ側が `.timeout(git::QUICK_TIMEOUT)` で使う。関数は起動せずに `Command` を返し、呼ぶ側が自分の `Runner` で動かす。上限や時間を呼ぶ側が変えられ、同時に動かす数を使い道ごとに数えられるため。

`core.quotepath=false` は、TypeScript では `server/fleet/thread.ts` の `git` だけが付け、`gitRoot` と `gitFiles` は付けない。Rust はすべての git に付ける。`rev-parse --show-toplevel` と `ls-files -z` は quotepath の設定によらずパスをそのまま書くので、出力は変わらない。

### opencode の stub(`opencode`)

C2 が中身を書く公開の型と関数を、次の signature で置く。

```rust
pub enum OpencodeError { Http { status: u16, tag: String }, Other(String) }
pub struct OpencodeCliOptions { pub work_dir: PathBuf, pub command: OsString, pub env: Env,
                                pub attempts: u32, pub timeout: Duration, pub kill_grace: Duration,
                                pub max_reply_bytes: usize, pub max_children: usize }
impl OpencodeCliOptions { pub fn new(work_dir: impl Into<PathBuf>, env: Env) -> Self }   // 既定値は server/opencode-cli.ts のもの
pub struct OpencodeCli;
impl OpencodeCli {
    pub fn new(options: OpencodeCliOptions) -> Self;
    pub async fn get(&self, path: &str) -> Result<serde_json::Value, OpencodeError>;
    pub async fn service_running(&self) -> bool;
}
pub async fn opencode_api_get(options: OpencodeCliOptions, path: &str) -> Result<serde_json::Value, OpencodeError>;
```

- trait は置かない。会話の読み取りが受ける trait は transcript の `OpencodeApi` で、core がこの client を包む(ADR `0107-crate-split` の 59 行目)。child-process にも trait を置くと、同じ形の trait が 2 つになる
- エラーの形は transcript の `OpencodeError`(`Http { status, tag }` と `Other`)と同じにし、core の変換を項目の写しだけにする
- 関数は async にする。runner が tokio の上で動くため。transcript の trait は同期なので、core は `spawn_blocking` の中から tokio の `Handle::block_on` で呼ぶ
- `get` の返り値の `serde_json::Value` のために、child-process に serde_json が要る。manifest の直しは #277 で行い、#246 はそれを待つ。#277 のあと、テストが安全上の判定の表を読む小さな JSON の関数(`tests/common/json.rs`)を serde_json に替えるかは、#246 の PR で決める

## 検討した代わり

- `EnvPolicy` に既定の値を置く(`Command::new` の引数にしない): 呼ぶ側が書き忘れたとき、最小の環境か利用者の環境のどちらかが黙って選ばれる。最小を既定にすると `gh` がサインインを読めず、利用者の環境を既定にすると probe に API キーが渡る(`server/cli-child.ts:16-20` の注記)。ADR `0242-phase-3-split` が「呼ぶ側が起動ごとに明示する」と決めているので、引数にした
- 同時に動かす数の上限を process 全体で 1 つにする: TypeScript は使い道ごとに数える。1 つにすると、遅い `opencode api` が使用量の probe を待たせる
- 上限を超えた出力を、すべて失敗にする(`StreamLimit` を 1 種類にする): setup のコマンドは長い出力の末尾が要り、標準エラーは失敗の文の先頭が要る。どちらも、上限を超えたことで失敗にすると、TypeScript が返していた結果を返せない
- SIGTERM を process group に送る: TypeScript は子の pid にだけ送る(`child.kill`)。group に送ると、git の alias や setup のコマンドが起動したプロセスまで止まり、振る舞いが変わる。ADR `0242-phase-3-split` も process group を使わないと決めている
- git の関数が自分で起動する(`git::run(cwd, args)`): 時間の上限、出力の上限、同時に動かす数を呼ぶ側が選べなくなる。L6 は diff の 1 MiB(`DIFF_MAX_BYTES`)と、worktree の削除の長い時間の上限を使う
- 安全上の判定の表を読むために、#277 を待ってからテストを書く: 表のテストは、テストを先に書く決まり(`.herdr-fleet/standing.md` の「Cutting and checking the work」の 3)の最初の手順で、待つと runner と git の作業も止まる。表は文字列、オブジェクト、配列だけで、JSON を読む関数はテストの中の 194 行(`tests/common/json.rs`)で足りた

## 依存

なし(外部 crate を足さない)。child-process への serde_json の追加は #277 が行う。serde_json はすでに workspace の依存にある。

## 結果

- C2、L3、L4、L6 は、子プロセスを `Runner::run` か `Runner::session` で動かす。環境変数の方針、時間の上限は `Command::new` で必ず書く
- 使用量の probe、モデル一覧、git、`gh`、setup のコマンドは、時間の上限で SIGTERM のあと SIGKILL を受ける。TypeScript の `server/fleet/thread.ts`、`server/fleet/github.ts`、`server/files.ts`、使用量の probe、モデル一覧は SIGTERM を 1 回送るだけだった。この違いの根拠は `server/opencode-cli.ts:119-122` の注記で、probe とモデル一覧については ADR `0242-phase-3-split` が決めている。git、`gh`、setup のコマンドに当てるのは、runner を 1 つにした結果である
- git と `gh` の標準出力にも既定の上限 `Fail(8 MiB)` がかかる。TypeScript は上限を置かない。8 MiB を超えうる読み取り(大きな diff など)は、L6 が `stdout_limit` で上限を選ぶ
- #277 がマージされるまで、`opencode` の module には stub を置けない。#246 は #277 を待つ

## 確かめたこと

PC は Linux 7.2.15(omarchy)、rustc 1.99.1、git 2.56.0、`rust/` で実行した。

- テストを先に書き、`todo!()` の stub で走らせて失敗を見た: `cargo test --locked -p herdr-fleet-child-process --no-fail-fast` で、env 9 件のうち 8 件、git 6 件、runner 25 件が失敗した(`panicked at crates/child-process/src/env.rs:12:5`、`src/work_dir.rs:5:5`、`src/runner.rs:74:9` ほか)。通った 1 件は表を読む JSON の関数のテストで、stub を呼ばない
- 実装のあと、同じコマンドで 40 件すべてが通った。5 回続けて走らせ、5 回とも通った
- `core.fsmonitor` に印のファイルを作る script を設定したリポジトリで、runner を通さない `git status --porcelain` は印を作り、`git::command` の `status`、`ls-files`、`diff` は作らなかった(`tests/git.rs` の `never_runs_the_fsmonitor_the_repository_names`)。環境変数 `GIT_CONFIG_COUNT` で `core.fsmonitor` を設定しても、`-c core.fsmonitor=false` が勝つことを手で確かめた(git 2.56.0)
- SIGTERM を無視する子(`trap '' TERM; exec sleep 30`)は、時間の上限 0.3 秒のあと、2 秒後の SIGKILL で終わった(`a_child_that_ignores_sigterm_gets_sigkill_after_the_grace`)。子が起動した孫が出力の pipe を持ち続ける場合は、SIGKILL のさらに `kill_grace` 後に読み取りをあきらめた(`the_read_is_given_up_a_grace_after_sigkill`)。SIGTERM のあとも、子が起動した孫は生きていた(`sigterm_goes_to_the_child_alone`)
