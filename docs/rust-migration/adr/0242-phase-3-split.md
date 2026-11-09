# 段階 3 を 29 の Issue に分け、herdr と fleet の crate の interface を決める

- 状態: 採用
- 決めた日: 2026-11-09
- Issue: #242
- 置き換える: 0107-crate-split(一部だけ。`server/collector.ts` の引き継ぎ先を core から herdr に変えること、`gh` と利用者の setup のコマンドも child-process の runner で起動すること、表にない 4 つのファイルの行を足すことの 3 点。ほかの決定は 0107 のまま)

## 状況

計画(`docs/rust-migration/plan.md`)の段階 3 は、herdr の socket のクライアント(`scripts/herdr-schema.json` から型を作る)、ペインの状態の購読、runtime、orchestrator、adapter、使用量、モデル一覧、`fleet` CLI を Rust で作る。完了条件は 3 つある: fleet CLI の契約が Rust の CLI と Rust の core で通る。orchestrator の振る舞い(今の `server/fleet/*.test.ts` の内容)が Rust のテストにある。隔離した herdr のセッションで、Rust の core が thread を 1 つ起動して終えられる。置き場所は ADR `0107-crate-split` の herdr-api、herdr、child-process、orchestrator、cli と core で、基準は ADR `0122-parity-criteria`(fleet CLI の契約は `fixtures/fleet-cli/` と `scripts/fleet-cli-fixtures.ts`、安全上の判定の表の child-process と orchestrator の分は `fixtures/security/`)が決めている。

段階 3 の作業を、並行する thread が 1 つずつ受け持つ Issue に分ける前に、次のことを決める必要があった。どれも crate の interface に関わり、あとから変えにくい。

- ペインの状態の購読をどの crate に、どの段階で置くか
- 非同期の runtime、HTTP のライブラリ、時刻の扱い
- herdr-api の型をどう生成するか
- orchestrator の 1 つの class を、並行する Issue がそれぞれ別のファイルを書ける形にどう分けるか
- 完了条件の「Rust の CLI と Rust の core で通る」と「Rust の core が thread を 1 つ起動して終える」を、どの Issue のどの検査で満たすか
- 子プロセスの決まりをどこまで 1 か所にするか

今の `rust` の状態(2026-11-09、コミット `d7965e3`):

- herdr-api、herdr、child-process、orchestrator、cli、core の `src/` は、責務を書いたコメントだけで、型も関数もない。protocol は段階 2 の型(`FleetAgentKind`、`UsageReading`、承認画面と会話の型)を持ち、screen は adapter の画面の判定(`screen_checks`、`cursor_usage`)を持つ
- workspace の外部 crate は段階 2 のもの(base64、regex、serde、serde_json、sha2、unicode-normalization、unicode-segmentation)だけで、tokio も HTTP のライブラリもない。`unsafe_code = "forbid"` が vt を除くすべての crate に効く
- CI(`.github/workflows/rust.yml`)には herdr がない。本物の herdr に当てるテストは手で走らせるしかない

TypeScript のコードの構成のうち、分け方を左右したもの(行番号は `d7965e3`):

- `server/fleet/orchestrator.ts`(1,936 行)は 1 つの class で、private の Map を 16、Promise の連なりの lock を 4 つ(`reconcileLocks`、`threadLocks`、`projectStarts`、`spawnGate`)持ち、ターンの決着(`finalize` 1420、`settleThreadTurn` 1478)がほとんどの関心を呼ぶ。テスト(`orchestrator.test.ts`、156 件の `it`)のほとんどは run を spawn してから始まり、describe は関心をまたぐ
- ペインの状態の購読(`server/collector.ts`、480 行、54 件の `it`)は herdr のクライアントだけを import し、中身の大半は herdr の購読の癖への対処(冒頭のコメント 4-40)である。知らせを fleet と HTTP に配るのは `server/index.ts:1048-1083` の受け手で、fleet は知らせを起こすきっかけとしてだけ使い、状態は `runtime.get` で読み直す(`orchestrator.ts:1358-1361`)
- 子プロセスの時間の上限・SIGKILL・出力の上限・同時に動かす数をすべて持つのは `server/opencode-cli.ts` だけで、使用量の probe(`server/fleet/usage.ts:403, 426`)とモデル一覧(`server/fleet/model-lists.ts:30`)は SIGTERM を 1 回送るだけで出力を限りなく読む
- herdr のエラーコードを orchestrator(`orchestrator.ts:1235, 1406`)と `/api/fleet`(`api.ts:302`)が直接見ている
- 今の herdr-api の生成物(`shared/herdr-api.generated.ts`、230 行)は 9 つの根から届く型だけで、method の応答を覆わない。呼ぶ側が応答の形をその場で書いている(`agent.get` だけで 6 か所)
- fleet CLI の契約(87 件)は stub のサーバーの応答だけを持ち、本物の CLI を本物の core に当てる件はない
- ADR `0107-crate-split` の表にない 4 つのファイルがある: `server/fleet/events.ts`、`metrics.ts`、`outbox.ts`、`report.ts`(0107 のあとで main に足された)

もとにした報告は `docs/rust-migration/architecture/2026-11-09-fleet-crates-review.html`(`improve-codebase-architecture` の手順で調べたもの)。決める前に architect(`spawn --role architect --read-only`、run `32b62efd`)に 9 つの問いを聞き、答えの分け方と interface をこの ADR の決定にした。architect の表(28 の Issue)に、段階 3 の関門の前の main の取り込み(M)を lead が足した。

## 決定

### Issue の分け方

段階 3 を次の 29 の Issue にする(ラベル `rust-migration` と `phase:3`)。土台の Issue(D)が外部 crate、manifest、protocol の型、orchestrator の module の宣言をまとめて書き、各領域の最初の Issue(H2、C1、O1)が、その領域のあとの Issue が中身を書く stub を最終の signature で置く。パスの `herdr/` などは `rust/crates/herdr/` などを、`O/` は `rust/crates/orchestrator/` を指す。この ADR の中の D、H1 などの略称は、表の Issue を指す。

| Issue | 中身 | 待つ Issue | 書くパス |
|---|---|---|---|
| #244(D) | 段階 3 の外部 crate と依存の ADR。protocol の fleet の型(`shared/fleet.ts`、エラーの本文、`X-Herdr-Fleet` の定数、ルートのパス、計画の型)、fleet CLI の corpus の応答の往復のテスト。orchestrator の `lib.rs`、空の module のファイル、`error.rs`、`clock.rs` | なし | `rust/Cargo.toml`、`rust/Cargo.lock`、`{herdr-api,herdr,child-process,orchestrator,cli,core}/Cargo.toml`、`protocol/src/`、`protocol/tests/`、`O/src/{lib,error,clock}.rs`、空の module のファイル、依存の ADR |
| #245(H1) | herdr-api: Rust の生成器、schema の全体の型と `Method` の trait、一致の検査 | D | `herdr-api/src/`、`herdr-api/tests/` |
| #246(C1) | child-process: `childEnv`・`claudeEnv` と安全上の判定の表、空の私用のフォルダー、上限つきの runner、git の起動。`opencode` の stub | D | `child-process/src/`、`child-process/tests/common/`、`child-process/tests/{env,runner,git}.rs` |
| #247(L1) | 役割と設定: agents(roles)、brief、config(`parse_candidate`)、entrances | D | `O/src/{agents,brief,config,entrances}.rs`、`O/tests/{agents,roles,brief,config,entrances}.rs` |
| #248(L2) | 起動の adapter(CLI ごとの引数と環境変数、thinking、agy の settings、OpenCode の設定)と安全上の判定の表。`models` は持たない | D | `O/src/launch/`、`O/tests/{launch,opencode_config}.rs` |
| #249(L5) | run の記録: `RunRegistry`(run の唯一の持ち主、`update`)、report.json の読み取り、出来事の記録、outbox | D | `O/src/{registry,report,events,outbox}.rs`、`O/tests/{registry,report,events,outbox}.rs` |
| #250(L7) | 計画の検査(`shared/plan.ts`)と計画の記録(`server/fleet/plan.ts`) | D | `protocol/src/plan.rs`、`protocol/tests/plan.rs`、`O/src/plan.rs`、`O/tests/plan_store.rs` |
| #251(CLI) | Rust の `fleet` が fleet CLI の契約の 87 件を通す。workflow に Rust の CLI での契約を足し、その ADR を書く | D | `cli/src/`、`cli/tests/`、`.github/workflows/rust.yml`、CI の ADR |
| #252(H2) | herdr のクライアント: `rpc::<M>`、購読、socket の場所と named pipe、marker の読み取り、`EventSource` の実装、`pane_status` の stub | D、H1 | `herdr/src/`、`herdr/tests/client.rs`、`herdr/tests/common/` |
| #253(C2) | OpenCode の CLI のクライアント(`server/opencode-cli.ts`) | C1 | `child-process/src/opencode.rs`、`child-process/tests/opencode.rs` |
| #254(L3) | 使用量: `UsageTracker`、クールダウン、CLI ごとの probe と parser | C1 | `O/src/usage/`、`O/tests/usage.rs` |
| #255(L6) | thread の git と setup のコマンド(`thread.ts`)、GitHub の読み取り(`github.ts`) | C1 | `O/src/{thread,github}.rs`、`O/tests/{thread,github}.rs` |
| #256(O1) | orchestrator の土台(状態の持ち方、`AgentRuntime` と `RuntimeError`、gate の trait、`KeyedSerial`、timer、取り消し、ターンの決着、全 cluster の stub、`FakeRuntime`)と spawn・ターン | L1、L2、L5 | `O/src/runtime.rs`、`O/src/fleet/`、`O/tests/common/`、`O/tests/{spawn,turns,result_files,agent_kinds}.rs` |
| #257(H3) | ペインの状態の購読(`server/collector.ts` の全体)と 54 件のテスト | H2 | `herdr/src/pane_status/`、`herdr/tests/pane_status.rs` |
| #258(L4) | モデル一覧と catalog(`model-lists.ts`、`models.ts`) | C2 | `O/src/models/`、`O/tests/models.rs` |
| #259(L8) | metrics と `fleet report` の文(`metrics.ts`) | L5、L6 | `O/src/metrics.rs`、`O/tests/metrics.rs` |
| #260(ST) | fleet の設定の store(`settings.ts`) | L1、L2、L3、O1 | `O/src/settings.rs`、`O/tests/settings.rs` |
| #261(HR) | `HerdrRuntime` の adapter(herdr のコードから `RuntimeError` への変換)と本物の herdr のテスト | H2、O1 | `O/src/herdr_runtime.rs`、`O/tests/herdr_runtime.rs` |
| #262(O3) | thread と project の開始、coordinator の特定 | O1、L6 | `O/src/fleet/{threads,projects}.rs`、`O/tests/{threads,projects}.rs` |
| #263(O2) | 候補、モデルの代わり、知らないモデル、使用量による振り分け、thinking の方針。`UsageGate`・`ModelGate` の impl | O1、L3、L4 | `O/src/fleet/candidates.rs`、`O/tests/candidates.rs` |
| #264(O4) | 知らせの配達と thread の質問 | O3 | `O/src/fleet/notices.rs`、`O/tests/notices.rs` |
| #265(O5) | orchestrator の中の計画 | O4、L7 | `O/src/fleet/plans.rs`、`O/tests/plans.rs` |
| #266(O6) | landing、マージの確認、GitHub の読み取り、thread を閉じる。`LandingTools` の impl | O4、L6 | `O/src/fleet/landing.rs`、`O/tests/landing.rs` |
| #267(O7) | lead のあとを継ぐ thread(起動し直し) | O2、O5、O6 | `O/src/fleet/restart.rs`、`O/tests/restart.rs` |
| #268(O8) | 人のいない project の監督(自律、停滞、GitHub でのマージ) | O6 | `O/src/fleet/autonomy.rs`、`O/tests/autonomy.rs` |
| #269(API) | `/api/fleet` の axum の router、`api.test.ts`、fleet CLI の契約の 87 件の要求を受け付ける検査 | O2、O5、O7、O8、ST、L8 | `O/src/api/`、`O/tests/{api,cli_requests}.rs` |
| #270(LIVE) | 最小の core(bin `herdr-fleet`)と、隔離した herdr のセッションで thread を 1 つ起動して終える `#[ignore]` のテスト | API、HR、H3、CLI | `core/src/`、`core/tests/live_thread.rs` |
| #271(M) | 段階 3 の関門の前に main を `rust` に取り込み、Rust 版が合わせていない変更を追いかけの Issue にする | LIVE(間接にすべて) | main が変えたパス、`docs/rust-migration/parity.md`(新しいテストのファイルの行) |
| #272(V) | parity.md の段階 3 の行、GLOSSARY、stub が残っていないことの確認 | M(間接にすべて) | `docs/rust-migration/parity.md`、`docs/rust-migration/GLOSSARY.md` |

最も早く始められる順は次のとおり。同じ段の Issue は並行できる。

| 段 | Issue |
|---|---|
| 0 | D |
| 1 | H1、C1、L1、L2、L5、L7、CLI |
| 2 | H2、C2、L3、L6、O1 |
| 3 | H3、L4、L8、ST、HR、O3 |
| 4 | O2、O4 |
| 5 | O5、O6 |
| 6 | O7、O8 |
| 7 | API |
| 8 | LIVE |
| 9 | M |
| 10 | V |

最長の経路は D → L1・L2・L5 → O1 → O3 → O4 → O6 → O7 → API → LIVE → M → V で、orchestrator のテストが呼ぶ method の依存で決まる。O4(thread の質問)と O5(計画)のテストは `startProject` を呼び(`orchestrator.test.ts:1888-2094` で 10 回、`:2744-2943` で 3 回)、landing は coordinator への手順を outbox に入れて notices が届け(`orchestrator.ts:819, 1307`)、起動し直しのテスト(`:1196-1845` の 22 件)は `land` を 14 回、`submitPlan` を 3 回呼ぶ。

共通のファイルを書く Issue は次のとおりに限る。どれも、同時に走りうる Issue と書くパスが重ならない。

- `rust/Cargo.toml`、`rust/Cargo.lock`、crate の manifest、`O/src/lib.rs`: D だけ。外部 crate か module の宣言が足りないと分かったら、段階 2 と同じく、足す Issue を別に開いて待つ
- `herdr/src/lib.rs` は H2、`child-process/src/lib.rs` は C1、`O/src/fleet/mod.rs` は O1 だけが書く。H3、C2、O2〜O8 は自分のファイルの中身を埋め、宣言を足さない
- `tests/common/` は O1(orchestrator)、C1(child-process)、H2(herdr)だけが書く。L 系の Issue のテストのファイルは自分の中で完結させる
- 共通のファイル(`O/src/fleet/turns.rs` の hook の signature など)に直しが要ると分かったら、直す Issue を別に開いて待つ

O0(振る舞いのない orchestrator の土台)を単独の Issue にする案は取らない。O0 のあとに動けるのは O1 と HR だけで、HR は最長の経路に乗らないので、O0 を分けても並行は増えない。段階 2 の S1・T1 と同じく、土台と最初の振る舞い(spawn とターン)を 1 つの Issue(O1)にする。`/api/fleet` の router は最後の 1 つの Issue(API)のままにする。ルートを cluster の Issue に分けると、複数の Issue が 1 つの router を同時に書くことになる。

### ペインの状態の購読

`server/collector.ts` の全体(状態の接続、構造の接続、focus の接続、replay、resync、backstop、debounce)を、段階 3 の H3 が herdr の crate の module `pane_status` に移す。ADR `0107-crate-split` の表の行 `server/collector.ts | core` を、この ADR が `herdr` に置き換える。

```rust
// herdr::pane_status
pub trait PaneStatusHandler: Send + Sync + 'static {
    fn on_status(&self, pane: &str, status: AgentStatus, agent: Option<&str>, replay: Option<Replay>);
    fn on_baseline(&self, panes: &[Pane]);
    fn on_resync(&self, _panes: &[Pane], _newer: &HashSet<String>) {}
    fn on_pane_ended(&self, pane: &str);
    fn on_structure_change(&self);
    fn on_focus(&self, _pane: &str) {}
}
pub fn start(source: Arc<dyn EventSource>, handler: Arc<dyn PaneStatusHandler>, options: PaneStatusOptions) -> PaneStatus; // PaneStatus::stop と Drop
```

- `EventSource`(subscribe と snapshot)は herdr の crate の port で、本物は H2 のクライアントが実装し、テストは偽物を渡す(今の `StatusCollectorDeps`、`server/collector.ts:87`)。focus の接続を開くかは `PaneStatusOptions` で選ぶ
- 理由: collector の中身は herdr の購読の癖への対処で、collector が使うのは herdr のクライアントだけである(`server/collector.ts:2`)。core に置くと、herdr の socket の知識が herdr と core の 2 つの crate に分かれる。replay と focus は切り離せない(`focusedAt` が `newerThan` の比較に入る、`:344`、`:348`)ので、replay を段階 4 に回す分け方を取ると、段階 3 の LIVE が replay のない購読で動き、段階 4 で作り直すことになる。push、配信、`CompletionTracker` は collector の中ではなく受け手の側(`server/index.ts:1048-1083`)にある
- orchestrator は購読に依存しない。core が受け手を組み立てる: `on_status` → `on_pane_status(pane)`、`on_pane_ended` → `on_pane_ended(pane)`、`on_resync` → `reconcile_all()`。段階 3 は LIVE の最小の core がこれを書き、段階 4 が同じ受け手に配信、push、`CompletionTracker` を足す

### 非同期と時刻

- tokio を herdr(socket、購読、collector の timer)、child-process(`tokio::process`、時間の上限、同時に動かす数の `Semaphore`)、orchestrator、core に入れる。cli、protocol、screen、transcript、herdr-api には入れない(screen と transcript は CI の検査が禁じている)
- D が `O/src/clock.rs` に `trait Clock { fn now_ms(&self) -> i64 }` と `SystemClock` を置く。記録に載る時刻(`startedAt`、`updatedAt`、クールダウンの期限、outbox の時刻)はすべて `Clock` から読む。待ち時間(grace、settle check、下書きの再試行、`wait` の時間の上限)はすべて `tokio::time` で表す
- orchestrator のテストは `#[tokio::test(start_paused = true)]` で動かし、テストの `Clock` は「固定の起点 + tokio の `Instant` の経過」にする。止めた時計が進めた分だけ記録の時刻も進むので、`Date.now() - since < grace` の比較(`orchestrator.ts:1393`)が TypeScript と同じ順に決まる。TypeScript のテストは本物の timer と 5 ミリ秒ごとの poll で待つ(`orchestrator.test.ts:17` の `GRACE = 60`、sleep と poll が 73 か所)。同じ形を写すと遅く、負荷で不安定になる
- 止めた時計を使うのは、本物の I/O を await しないテストだけにする。止めた時計は、runtime が待っている間に次の timer まで時計を進めるので、子プロセスや socket を待つテストでは時間の上限がすぐに過ぎる。child-process、L3、L4、L6、H2、HR のテストは本物の時計で、短い上限を渡して動かす。orchestrator の記録の読み書きは、TypeScript と同じく同期の `std::fs` にする

### HTTP

- orchestrator の `api` module が `pub fn router(…) -> axum::Router` を返し、core が `/api/fleet` に mount する(ADR `0107-crate-split`)。テストは `tower::ServiceExt::oneshot` で router を直接呼び、ポートを使わない。`X-Herdr-Fleet: 1` の確認は core のアクセス制御に置き、段階 3 では LIVE の最小の core が持つ
- CLI は ureq を `default-features = false`(TLS なし、平文の HTTP だけ)で使う。CLI の宛先は fleet のサーバーが渡す `http://127.0.0.1:<port>` で、TLS は要らない。std に HTTP のクライアントはなく、方針(標準 > 実績のあるライブラリ > 自作)で自作より ureq が先に来る
- CLI の時刻(`bin/fleet.ts:127` の `toLocaleString()`)は jiff で、ロケールによらず en-US の形を `TZ` の示す地域の時刻で書く。fleet CLI の契約は `TZ=UTC`、`LANG=en_US.UTF-8` で固定している(ADR `0122-parity-criteria`)ので、件は通る。en_US 以外のロケールでは TypeScript と表示が違い、CLI の Issue がそれを parity.md の備考に書く

### 外部 crate

段階 3 の外部 crate は D がまとめて足す: tokio、tokio-util(`CancellationToken`)、axum(orchestrator と core)、ureq(cli)、rustix(child-process の SIGTERM、`cfg(unix)`)、jiff(cli)、dev-dependency の tower と http-body-util。`Cargo.lock` と crate の manifest は 1 つのファイルで、Issue ごとに足すと並行する Issue が同じファイルを書くため。workspace の中の依存(orchestrator → screen、herdr、child-process など)も `Cargo.lock` を変えるので、D が段階 3 のすべての manifest に書く。版、入手元、ライセンス、保守の状況、`build.rs` が実行することは、D の依存の ADR に書く(計画の「守ること」)。

### herdr-api の生成

- 生成器は Rust で書き、herdr-api の `tests/` に置く(`build.rs` は使わない)。生成物 `src/generated.rs` をコミットし、テストが `scripts/herdr-schema.json` から作った結果と比べる。環境変数(`HERDR_API_UPDATE=1`)を付けたときだけ書き直す
- 生成するのは schema の全体(102 の method の params と result、26 の event)。method ごとに `trait Method { const NAME: &str; type Params; type Result; }` を生成し、H2 のクライアントは `rpc::<M>(params)` の 1 つの口で呼ぶ。enum は開いた形(知らない値を保つ)にし、名前の衝突は TypeScript の生成器と同じく節の名前を前に付ける
- 理由: 全体から生成すれば、呼ぶ側は応答の形を書かず、herdr の形式を知るのは herdr-api だけになる。根の一覧(人が書く一覧)も要らなくなり、段階 4 の Issue が herdr-api を書き足すこともない。生成器を Rust にするのは、切り替えのあとも herdr の schema は変わり、生成器が bun なしで動く必要があるため。生成器が写せない形は `serde_json::Value` にし、H1 の PR に一覧を書く

### orchestrator の状態の持ち方

- `Orchestrator` は `Arc<Inner>` の clone できる handle で、method は `&self` を取る
- run は L5 の `RunRegistry` が持つ。中は 1 つの `std::sync::Mutex` で、読むと clone を返し、書くのは `update(id, |run| …)` だけで、`update` がファイルに保存する。lock は await をまたいで持たない。TypeScript は同じ `AgentRun` のオブジェクトをその場で書き換え、await のあとでもほかの処理の書き換えが見える(例: `reconcileRun` は `runtime.get` のあと `isLive(run)` を見直す、`orchestrator.ts:1387-1389`)。Rust では、await のたびに id で読み直す
- run ごとの一時の状態(`pending`、`generations`、`waiters` など 16 の Map、`orchestrator.ts:210-232`)は、cluster のファイルがそれぞれ自分の `State` struct を定義し、`Inner` は `Mutex<turns::State>` のような項目で持つ。O1 は全 cluster のファイルを作り、`State` は空の struct、hook は最終の signature で何もしない関数として置く。hook の stub は `todo!()` にせず、既定の値を返す(O1 のテストが `finalize` を通るとき、ほかの cluster の hook を呼ぶため)。stub には `// stub: #<Issue>` を書き、V が grep で残りがないことを確かめる
- lock: `reconcileLocks`、`threadLocks`、`projectStarts` は、鍵ごとに順に動かす小さな型 `KeyedSerial<K>`(`Mutex<HashMap<K, Arc<tokio::sync::Mutex<()>>>>`。使う者がいなくなった鍵は消す)にする。tokio の Mutex は来た順に渡すので、Promise の連なりと同じ順になる。TypeScript が lock を取らずに待つ `await this.reconcileLocks.get(id)`(`orchestrator.ts:720, 783, 893, 1127, 1316`)は、取ってすぐ放す `wait_idle(id)` にする。`spawnGate` は、予算の確認から最初の保存までを 1 つの `tokio::sync::Mutex<()>` で守る。setTimeout の handle(`draftRetries`、`settleChecks`)は、`tokio::spawn` の task の `AbortHandle` を Map に持ち、`stop()` がすべてを abort する
- 取り消し: TypeScript は `request.signal` を orchestrator に渡し、spawn の途中で取り消されると pane を閉じる(`abandonSpawn`、`orchestrator.ts:625`)。Rust で future を drop して取り消すと、この後始末が走らない。そのため orchestrator の method は `CancellationToken` を受け、HTTP の handler は操作を `tokio::spawn` の中で動かし、接続が切れたら token を cancel する。後始末は最後まで走る
- Runtime の port: `AgentRuntime` は dyn にできる trait にし、method は `Pin<Box<dyn Future<Output = …> + Send + '_>>` を返す(型の別名を O1 が置く)。`Orchestrator<R: AgentRuntime>` の generic にすると、型の引数が router と core まで広がる。port のエラー `RuntimeError` は O1 が置く

  | variant | もとの TypeScript |
  |---|---|
  | `Blocked` | `agent_blocked`(`orchestrator.ts:1235`) |
  | `NotFound` | `agent_not_found`・`not_found`・`pane_not_found`(`orchestrator.ts:1406`) |
  | `StartFailed(String)` | `FleetError agent_start_failed`(`runtime.ts:166`) |
  | `NotReady(String)` | `FleetError agent_not_ready`(`runtime.ts:183`) |
  | `Cancelled` | AbortError(API は 499 `aborted`、`api.ts:303`) |
  | `Herdr { code: String, message: String }` | ほかの `HerdrError`。`/api/fleet` はコードとともに 502 で返し(`api.ts:302`)、CLI は `code: message` を出すので、コードを落とさない |

  herdr のコードから variant への変換は HR の adapter だけが行う(ADR `0107-crate-split`)。`not an available shell` のやり直し(`runtime.ts:151`)も HR の中に残す
- O1 は、使用量とモデル一覧を O1 が定義する小さな trait(`UsageGate`、`ModelGate`。TypeScript の `Pick<UsageTracker, …>`、`orchestrator.ts:157-160`)で受け、L3 と L4 の型への impl は O2 が書く。git と GitHub の読み取りも trait(`LandingTools`、`orchestrator.ts:171`)で受け、本物の impl は O6 が書く
- adapter は CLI ごとのモデル一覧(`server/fleet/adapters.ts:79-84` の `models`)を持たず、L4 の models module が `FleetAgentKind` ごとに持つ。adapter に残すと L2 が L4 を待ち、L4 は C2 を待つ。ADR `0107-crate-split` の「出力の parser はそのコマンドの argv の隣に置く」にも合う
- 候補の文字列を読む `parseCandidate`(`orchestrator.ts:191`、純粋な関数)は L1 の config に置き、O2 と ST が使う

### 子プロセス

- C1 の runner に、ペインの外で起動する子プロセスをすべて通す: 使用量の probe、モデル一覧、`opencode api`、git、`gh`、利用者の setup のコマンド。runner は時間の上限を過ぎたら SIGTERM を送り、2 秒後に SIGKILL、さらに 2 秒で読み取りをあきらめる。標準出力と標準エラーの上限、同時に動かす数の上限、`CancellationToken`、標準入力に書いて行を読む session(`codex app-server` の JSON-RPC、`usage.ts:426`、`model-lists.ts:127`)を持つ
- 環境変数の方針(最小の環境にするか、利用者の環境を引き継いで指定したものを足すか)は、呼ぶ側が起動ごとに明示する。`gh`(`GH_PROMPT_DISABLED` など 4 つを足す、`github.ts:14`)と利用者の setup のコマンド(`sh -c`、10 分、`thread.ts:173-183`)は引き継ぐ側。ADR `0107-crate-split` はこの 2 つを child-process の外に置いた(利用者の環境が要るため)が、環境変数の方針を呼ぶ側が選べばその理由は満たせ、時間の上限・kill・出力の上限を書く場所が 1 つになる。`gh` の argv と出力の読み取りは orchestrator の `github` module(L6)が持つ。ADR `0107-crate-split` が段階 3 に残した「`gh` を child-process に移すか」への答えは、「起動は runner を通し、argv と読み取りは orchestrator に置く」である
- 使用量の probe とモデル一覧は、TypeScript より強い決まりで動かす: SIGTERM のあと SIGKILL、標準出力は 8 MiB まで(OpenCode のモデル一覧と同じ、`opencode-cli.ts:175`)。時間の上限の値は TypeScript のまま(モデル一覧 20 秒、claude と agy の使用量 30 秒、codex app-server 15 秒)。今の TypeScript は SIGTERM を 1 回送るだけで、SIGTERM を無視する CLI がいると子プロセスと読み取りが残る。この危険は `opencode-cli.ts:119-122` の注記が書いており、これを違いの根拠として parity.md と各 Issue の PR に書く。使用量の tracker は自分の時間の上限(`usage.ts:330`)を持つので、tracker の振る舞いは変わらない
- process group は使わない(TypeScript も子の pid にだけ送る)。SIGTERM は rustix の safe な API で送るので、`unsafe` は要らない。`Child::kill`(SIGKILL)だけにしないのは、TypeScript が先に SIGTERM を送り、CLI に片付けの機会を与えているため。Windows(段階 6)では `cfg(unix)` の外で `start_kill` を使う

### fleet CLI の契約を Rust の CLI と Rust の core で通す

計画の完了条件「fleet CLI の契約が Rust の CLI と Rust の core で通る」を、次の 3 つで満たす。corpus は CLI の側の契約(stub のサーバーの応答)しか持たないので、core が CLI の要求を受け付けること(2)と、CLI が core の応答を読めること(1 と、型を protocol で共有すること)を分けて確かめる。

1. D: corpus の 87 件の `responses[].body` を CLI が読む protocol の型に読み、同じ JSON に書き戻す往復のテスト。CLI の Issue は、Rust の `fleet` で 87 件を `HERDR_FLEET_CLI_TARGET=rust:<パス>` で通す
2. API: 87 件の `expected.requests` のそれぞれを、偽の runtime を持つ Rust の router に送り、受け付けられることを確かめる。受け付けるとは、ルートに当たり(`api.ts:200` の `notFound()` ではない)、本文の検査を通る(エラーコードが `invalid_json`、`invalid_body`、`missing_*`、`invalid_*` のどれでもない)こと。2xx の応答は CLI が読む protocol の型に読めなければならない。run の id などの状態が違うために出る領域のエラー(`run_not_found` など)は受け付けたものとして数える
3. LIVE: Rust の CLI を Rust の core に向けて動かす。thread の lead の `fleetCommand` を Rust の `fleet` にし、テスト自身も Rust の `fleet thread` と `fleet wait` で操作する

件ごとに状態を用意して応答まで比べる案は取らない。87 件の状態を作ることになり、`/api/fleet` の black-box の比較は段階 4 の HTTP/WS の契約が受け持つ。

### Rust の core が thread を 1 つ起動して終える

- 段階 3 に、bin `herdr-fleet` の最小の core を置く(LIVE)。持つのは、`/api/fleet` の mount、orchestrator、HR の adapter、ペインの状態の購読の受け手、起動時の `reconcile_all`、pull request の読み取りと監督の interval(`server/index.ts:2051-2062`)だけで、段階 4 がほかを足す
- アクセス制御を緩めない(CLAUDE.md の「守ること」)。最小の core は `127.0.0.1` だけで待ち受け、Host がループバックでない要求と、GET 以外で `X-Herdr-Fleet: 1` のない要求を断る。token は段階 4 で入れる。token のない状態で通すのは、ループバックのアドレスからループバックの Host で来た要求だけ、という今の決まりの範囲に収まる
- エージェントは本物の CLI にする: claude で、モデルは別名 `haiku`(サブスクリプションの中で最も安い)。API キーは使わない(決まりの 4)。テストは `#[ignore]` で、関門の前に手で走らせ、出力を PR に貼る。偽のエージェントは取らない。herdr の `agent.start` は種類の名前で CLI を起動し、`interactive_ready` まで待つ(`runtime.ts:95-105`)。手で報告したエージェントが `interactive_ready` になるかは確かめていない。また、この確認の目的は herdr との実際のやりとりで、偽物ではそれを確かめられない
- 手順: 一時の git リポジトリに `.herdr-fleet/fleet.json` を置き、lead の候補を `claude:haiku` にする。Rust の `fleet thread` で始め、task は「report.json に state ready を書いて終える」にする。`fleet wait` でターンが終わるのを待ち、report が `ready` であることを確かめる。最後に `POST /api/fleet/runs/:target/land {action: "discard"}` で thread を終える。discard は pane、worktree、ブランチを消すので、worktree の作成(herdr の `worktree.create`)から後始末までを 1 回で通る
- 隔離: `HERDR_*` を外す。herdr のセッションは `herdr-fleet-rs-<run id>` で、終わったら止める。ポートは 7400〜7499。state は `rust/.dev-state/<run id>/`。core の `XDG_CONFIG_HOME` も `rust/.dev-state/<run id>/config` に向ける。fleet の利用者の設定(fleet.json、役割、standing)は `HERDR_FLEET_STATE_DIR` ではなく `XDG_CONFIG_HOME` から探されるため(`server/fleet/config.ts:23-25`)で、向けないと Rust の core が稼働中の fleet の `~/.config/herdr-fleet` を読む

本物の herdr に当てるほかのテスト(H2 の `client.test.ts` の 7 件、HR の `runtime.herdr.test.ts` の 3 件)も `#[ignore]` にし、同じ隔離で手で走らせる。CI に herdr を入れる案は、この ADR では取らない(herdr の入手と版の固定を決める別の判断が要る)。

### main の欠陥と main の取り込み

段階 3 が合わせるのは、着手した時点で `rust` に取り込んだ TypeScript である。main の TypeScript は使う人が変え続けているので、段階 3 の関門の前に、#169 と同じ手順で main をもう一度取り込む(M)。M は取り込んだ変更のうち段階 3 の Rust 版が合わせていないものを、追いかけの Issue にする。

使う人の判断(2026-11-09)で、#176・#189・#190・#240 の欠陥は main で直し、取り込みで `rust` に入れる。`rust` の側の TypeScript では直さない。Rust 版で同じ欠陥を作らないよう、それぞれの欠陥を移す Issue に割り当て、Issue の本文の「main の欠陥」に書いた。

| 欠陥 | 中身(短く) | 当たる Issue |
|---|---|---|
| #176 の 1 | MERGED と読めた thread を、lead が helper を待つ間に閉じる | O8 |
| #176 の 2 | `refreshPullRequests` が届けていない知らせを上書きする | O8 |
| #176 の 3 | MERGED の thread を閉じるのが生きている coordinator だけ | O8 |
| #176 の 4 | 送っていないターンで前の HANDOFF を伝える(#238 で直った) | O1 |
| #176 の 5 | `callStandstill` が配達の lock を取らない | O8 |
| #176 の 6 | agy の `readyError` と `--effort` の衝突の記述 | L2 |
| #176 の 7 | thread のターンの終わりごとに `gh pr view` を呼ぶ | O6 |
| #176 の 8 | 出来事の記録に上限がない、`lastError` に画面の文、停滞と `gh` の上限 | L5、L8 |
| #189 の 1 | 古い出来事の `interactive` を false とみなす | L8 |
| #189 の 2 | `scripts/factory-report.ts` の project の決め方 | L8、API |
| #189 の 3 | `checkAnomalies` の問い合わせの繰り返し(#238 で直った) | O8 |
| #189 の 4 | HANDOFF のない非対話のペインを閉じない | O1 |
| #189 の 5 | 停滞の計算が止まった run を動き続けているとみなす | L8 |
| #189 の 6 | `gh pr list` と `gh issue list` の上限 | L6 |
| #189 の 7 | `anomaly` の出来事を metrics が読まない(#238 で直った) | L8 |
| #189 の 8 | agy の sandbox の note と fleet コマンドを使う役割の矛盾 | L1、L2 |
| #189 の 9 | CLI が `--hours` を符号化しない | CLI |
| #190 | agy のレビュアーが作業フォルダーの外のファイルの確認画面で止まる | L2 |
| #240 の 1 | 計画の案内に report.json がない | CLI、L7 |
| #240 の 2 | landing とターンの決着の競合 | O1、O6 |
| #240 の 3 | 起動し直しが失敗したあと計画の回答待ちが残る | O5、O7 |

### 計画の項目と完了条件の対応

計画の段階 3 の項目と完了条件のそれぞれを、どの Issue の受け入れ条件が覆うかを次に示す。

| 計画の項目・完了条件 | Issue |
|---|---|
| herdr の socket クライアント(`scripts/herdr-schema.json` から型を作る) | H1(型の生成)、H2(クライアント) |
| ペインの状態の購読 | H3(購読)、LIVE(core の受け手) |
| runtime | O1(`AgentRuntime` と `RuntimeError`)、HR(`HerdrRuntime`) |
| orchestrator | O1〜O8、L5(記録)、L7(計画)、L8(metrics)、ST(設定)、API(`/api/fleet`) |
| adapter | L2(起動の引数と環境変数、OpenCode の設定)。画面の判定は段階 2 の screen(#200) |
| 使用量 | L3(probe、クールダウン)、O2(使用量による振り分け、cursor の `/usage`) |
| モデル一覧 | C2(`opencode api`)、L4(一覧と catalog)、O2(知らないモデルを飛ばす) |
| `fleet` CLI | CLI |
| 完了条件 1: fleet CLI の契約が Rust の CLI と Rust の core で通る | D(応答の往復)、CLI(87 件)、API(87 件の要求を受け付ける)、LIVE(Rust の CLI を Rust の core に当てる) |
| 完了条件 2: orchestrator の振る舞い(`server/fleet/*.test.ts`)が Rust のテストにある | `orchestrator.test.ts` は O1〜O8、`adapters.test.ts` の起動の部分は L2(画面の判定は段階 2 で screen)、`agents`・`roles`・`brief`・`config`・`entrances` は L1、`api` は API、`metrics` は L8、`models` は L4、`outbox`・`report` は L5、`plan` は L7、`runtime.herdr` は HR、`settings` は ST、`thread` は L6、`usage` は L3。`opencode-guard.test.ts` は parity.md のとおり TypeScript のまま残す。V が parity.md の行を埋めて確かめる |
| 完了条件 3: 隔離した herdr のセッションで、Rust の core が thread を 1 つ起動して終えられる | LIVE(HR、H3、API、CLI を待つ) |
| 計画の「守ること」の各 CLI の癖、使用量とモデル一覧の取得口、OpenCode 2 の制限 | L2、L3、L4、C1、C2、L6 の受け入れ条件と注意 |
| 段階 3 の関門の前の main の取り込み | M |

### ADR 0107 の表の追加と変更

ADR `0107-crate-split` の「TypeScript のファイルの引き継ぎ先」の表に対して、次のとおりにする。0107 は書き換えない(ADR の README の決まり)。

| ファイル | crate | 備考 |
|---|---|---|
| `server/collector.ts` | herdr | 0107 の core から変える(上の「ペインの状態の購読」) |
| `server/fleet/events.ts` | orchestrator | 0107 のあとに足されたファイル。L5 |
| `server/fleet/metrics.ts` | orchestrator | 同じく。L8 |
| `server/fleet/outbox.ts` | orchestrator | 同じく。L5 |
| `server/fleet/report.ts` | orchestrator | 同じく。L5 |

### 手順のうち、人に聞くところを置き換えた判断

`improve-codebase-architecture` と `to-tickets` は、人に聞く手順を持つ。決まり(`.herdr-fleet/standing.md` の「Skills」)に従い、次のように置き換えた。

- 報告を一時フォルダーに書いてブラウザで開く手順: `docs/rust-migration/architecture/` に書き、開かない
- どの候補を掘り下げるかを人に聞く手順: 報告の一番の推奨(候補 1、orchestrator の分け方)を採った。ただし段階 3 の Issue の分け方の全体を決めるので、候補 2〜5 も分け方と interface に入れた
- 候補と分け方を人と問い詰める手順(grilling)と、`to-tickets` の分け方を人に確かめる手順: 同じ問い(購読の置き場所、非同期、HTTP、生成、orchestrator の中の分け方、完了条件の満たし方、LIVE の形、子プロセス、粒度)を architect に聞き、その答えをこの ADR の決定にした
- `to-tickets` の `ready-for-agent` のラベル: この repository の決まり(ラベル `rust-migration` と `phase:<n>`)に替えた

### architect の答えと違う判断

architect の答え(28 の Issue)をそのまま採り、lead は次の 1 点を足した。

- M(段階 3 の関門の前の main の取り込み)を Issue にした。段階 3 の Issue が合わせる TypeScript は着手した時点のもので、#176・#189・#190・#240 の main での直しは取り込みで入るので、取り込んだあとに Rust 版との違いを見つける作業が要る。M は LIVE を待ち(間接にほかのすべてを待つ)、V は M を待つ。M は parity.md に新しいテストのファイルの行を足しうるので、V と同時に走らせない

## 検討した代わり

- 購読を core に置く(ADR `0107-crate-split` のまま): 動くが、herdr の購読の知識が herdr と core の 2 つの crate に分かれる。段階 3 の H3 と LIVE が同じ core の crate を書くことになる
- 購読を分ける(つなぎ直しと購読し直しを段階 3 の herdr に、replay と focus を段階 4 の core に): replay と focus が切り離せず、段階 4 で作り直すことになる
- orchestrator を generic にする(`Orchestrator<R: AgentRuntime>`): 型の引数が router と core まで広がる
- `RuntimeError::Other(String)` だけで herdr のエラーを表す(lead の下書き): `/api/fleet` が返す herdr のエラーコードが失われる
- O0 を単独の Issue にする(lead の下書き): 上の「Issue の分け方」の理由で取らない
- ルートを cluster の Issue に分ける: 複数の Issue が 1 つの router を同時に書く
- herdr-api の生成物を今と同じ 9 つの根に限る、TypeScript の生成器を広げて Rust を出す: 根の一覧を段階 4 の Issue が書き足すことになり、切り替えのあとも bun が要る
- 生成を `build.rs` で行う: build のたびに生成器が動き、生成物を PR で読めない
- CLI の HTTP を std の `TcpStream` で自作する: chunked の読み取りと状態行の読み取りを持つことになる。方針の順で ureq が先に来る
- 使用量の probe とモデル一覧を TypeScript と同じく SIGTERM だけで止める: SIGTERM を無視する CLI がいると子プロセスと読み取りが残る(`opencode-cli.ts:119-122`)
- LIVE を偽のエージェントで走らせる: 上の「Rust の core が thread を 1 つ起動して終える」の理由で取らない
- M を Issue にせず coordinator に任せる: 取り込みのあとの Rust 版との突き合わせが、どの Issue の受け入れ条件にも入らない

## 依存

なし。この ADR は外部の crate を足さない。段階 3 の外部 crate は D の依存の ADR が、CI の手順は CLI の ADR が足す。

## 結果

- 段階 3 の Issue は上の表のとおりに進む。D のあと、H1、C1、L1、L2、L5、L7、CLI の 7 つが並行し、O1 のあと O2〜O8 は表の待つ Issue の順に進む
- 共通のファイルを書くのは D、H2、C1、O1 だけなので、あとの Issue が共通のファイルの直しを見つけると、直す Issue を待つ分だけ遅れる
- herdr の crate が、ペインの状態の購読と tokio の timer を持つ。段階 4 の core は購読の受け手を組み立てるだけになる
- orchestrator のテストは止めた時計で動き、待ちは待つ時間に関係なく一瞬で終わる。`Clock` を通さずに時刻を読むコードは、テストで時計と食い違う
- 段階 3 の終わりに、bin `herdr-fleet` は `/api/fleet` だけを持つ。段階 4 はこの core にルートを足す
- 本物の herdr に当てるテストは CI で走らず、関門の前に手で走らせる
- 使用量の probe とモデル一覧の子プロセスは、TypeScript より早く確実に止まる
- Rust の CLI の時刻の表示は、en_US 以外のロケールで TypeScript と違う

## 確かめたこと

2026-11-09、Linux(omarchy)、`rust` ブランチの `d7965e3` で確かめた。Rust のコードは書いていないので、cargo の検査はない。

- 表の「書くパス」を script に写し、どちらも他方を(間接にも)待たない組を同時に走りうる組として、すべての組の書くパスを比べた(`/` で終わるパスはその下のすべてと重なる扱い、`{a,b}` は展開する)。結果は `issues: 29 / concurrent pairs: 193 / clashes: 0`。architect も同じ表(M を除く 28 件)で `concurrent pairs: 193 / clashes: 0` を得た。M はほかの 27 の実装の Issue をすべて(間接に)待ち、V は M を待つので、組の数は変わらない
- TypeScript の事実(行番号、`it` の数、呼び出しの数)は、subagent 3 つと architect が `grep -n` と `sed -n` で読み、lead が要点を確かめた。`it` の数は `orchestrator.test.ts` の describe ごとに数えた(spawn 14、turns 12、thinking 3、fallbacks 5、unknown model 2、usage routing 14、registry 1、result files 7、agent kinds 11、threads 13、thread outlives lead 22、projects 4、thread questions 9、owners 1、project without the person 11、landing 16、plans 11。計 156)
- tokio の止めた時計の振る舞い(待っている間に時計が進む)は tokio の文書によるもので、この PC では試していない。O1 が最初のテストで確かめる
