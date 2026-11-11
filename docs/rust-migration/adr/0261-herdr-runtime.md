# HerdrRuntime の公開の口、エラーの変換、取り消し

- 状態: 採用
- 決めた日: 2026-11-11
- Issue: #261

## 状況

O1(#256)は、orchestrator が herdr に頼む口 `AgentRuntime` と、その失敗 `RuntimeError` を `runtime.rs` に置いた。この Issue は、herdr の上でこの口を実装する `HerdrRuntime`(今の `server/fleet/runtime.ts`)を `herdr_runtime.rs` に書く。herdr の呼び出しは H2(#252)の `Herdr::rpc` と `Herdr::call` を使う(ADR `0252-herdr-client`)。herdr のエラーコードから `RuntimeError` への変換は `HerdrRuntime` だけが行う(ADR `0107-crate-split`、ADR `0242-phase-3-split`)。

ADR `0242-phase-3-split` は `AgentRuntime` の signature とエラーの表を決めていたが、次のことは決めていなかった。

- `HerdrRuntime` の作り方と、起動の待ち時間(30 秒など)をテストで短くする方法。HR のテストは本物の時計で動かす(ADR `0242-phase-3-split` の「非同期と時刻」)ので、TypeScript の待ち時間のままでは、準備ができない件のテストだけで 30 秒かかる
- TypeScript が `HerdrError` ではない普通の `Error` で投げる失敗(`A worktree run needs a branch name.` など)の表し方。`RuntimeError` にはそれに当たる variant がない
- 応答の形の表と違う答えを、どの method で失敗とするか
- `CancellationToken` で取り消されたときの振る舞い

どれも orchestrator の crate の公開の口なので、architect(fleet の run `9da49253`、読むだけ)に問い、その答えに従った。

## 決定

### 作り方と待ち時間

- `HerdrRuntime::new(herdr: herdr::Herdr)` で作る。socket の場所(`herdr::socket::socket_path`)と呼び出しの時間の上限は `Herdr` が持つので、`HerdrRuntime` はどちらも知らない。TypeScript の `new HerdrRuntime(socketPath?)` に当たる
- 起動の待ち時間は `StartTimings { timeout, ready_poll, failure_poll, retry_step }` にまとめる。`Default` は TypeScript の定数(30 秒、250 ミリ秒、500 ミリ秒、300 ミリ秒。`retry_step` は「n 回目のやり直しの前に n × 300 ミリ秒待つ」の 300 ミリ秒)である。`with_start_timings(self, StartTimings)` で置き換える。やり直しの回数(4 回)は時間ではないので定数のままにする。O1 の `Timings` と herdr の `PaneStatusOptions` と同じ形である
- 準備ができないときの文は `<名前> did not become ready within <秒>s` で、秒は `timeout.as_secs_f64()` を書く。TypeScript の `START_TIMEOUT_MS / 1000` と同じ表記になる(30 秒なら `30s`、300 ミリ秒なら `0.3s`)

### エラーの変換

`HerdrError::code()` を次のように変える。変換は `herdr_runtime.rs` の `runtime_error` の 1 か所だけにある。

| herdr のコード | `RuntimeError` |
|---|---|
| `agent_blocked` | `Blocked` |
| `agent_not_found`、`not_found`、`pane_not_found` | `NotFound` |
| ほか(herdr のコードと、クライアントの `timeout`・`bad_frame`・`socket_error`・`closed`・`connect_failed`) | `Herdr { code, message }` |

- `StartFailed` と `NotReady` は、`HerdrRuntime` が自分で判定したときだけ作る。herdr が `agent_start_failed` というコードを返しても `Herdr` のままにする。TypeScript も、自分で作る `FleetError` と herdr の `HerdrError` を分けている(`runtime.ts:166,183`、`api.ts:301-302`)
- TypeScript が普通の `Error` で投げる失敗は、`Herdr { code: "internal_error", message: <TypeScript と同じ文> }` にする。`/api/fleet` はこれを 500 の `internal_error` で答えていた(`api.ts:304`)。Rust で起こりうるのは次の 2 つだけである
  - `A worktree run needs a branch name.`: O1 は worktree のとき必ず branch を渡すので実際には起きないが、型が `Option` なので確かめを残す
  - `herdr knows no workspace for pane <id>.`: 生成した `PaneInfo.workspace_id` は必須の文字列なので、空のときだけ起きる(TypeScript の `!workspaceId` も空で投げる)
- `not an available shell` のやり直しは、`RuntimeError` に変える前に `HerdrError::message()` を、大文字と小文字を区別せずに見る。TypeScript の `instanceof HerdrError` と同じく、herdr のエラーに限らず、すべての `HerdrError` が対象である

### `rpc` と `call` の使い分け

- 答えを読む method(`worktree.create`、`workspace.create`、`tab.create`、`pane.split`、`pane.get`、`pane.read`、`agent.get`、`agent.read`)は `call` で呼ぶ。表と違う形の答えは `Herdr { code: "bad_frame" }` になる
- TypeScript が答えを読まない 6 つ(`pane.close`、`pane.report_metadata`、`agent.start`、`agent.focus`、`agent.prompt`、`agent.send_keys`)は `rpc` で呼び、herdr のエラーだけを失敗にする。ADR `0252-herdr-client` が、形の違いを失敗にしたくない呼ぶ側に認めた使い方である。`call` にすると、herdr が受け取ったプロンプトを失敗と報告する、herdr が CLI を起動したあとに spawn がペインを閉じる、worktree の root のペインを閉じ終えたのに場所の作成を失敗にする、といったことが起きる
- 待つ間の読み取り(起動の準備の `agent.get`、起動の失敗を見る `pane.get` と `pane.read`、`screen` のスクロールの問い合わせ)は、TypeScript と同じく、失敗(`bad_frame` を含む)を捨てて続ける

### 取り消し

herdr の状態を変える呼び出しは最後まで走らせ、token と競わせるのは待ち時間だけにする。

- `create_location` は、入口で token を見て、取り消し済みなら `Cancelled` を返す。そのあとの呼び出し(どれもペインか worktree を作る)は最後まで走らせる。取り消しのあとに作ったペインは、spawn が次の `start` で `Cancelled` を受け、`abandon_spawn` が閉じる(`fleet/spawn.rs` の `abandon_spawn`)。TypeScript も同じ順で閉じる
- `start` は、やり直しのたびに token を見る。やり直しの前の待ちと、準備・起動の失敗の待ちは token と競わせ、取り消されたら `Cancelled` を返す。`agent.start` の呼び出し自体は競わせない
- `prompt` は、入口で token を見る。`agent.prompt` のあとの `agent.get` の前には見ない(`runtime.ts:204-205` と同じ)
- 準備の待ちは、TypeScript と同じく、各問い合わせの前に期限を見るループにする。外側を `tokio::time::timeout` で包むと、期限の直前に始めた `agent.get` の答えを捨て、TypeScript と結果が変わる

### herdr_api の型の名指し

`Herdr::call::<M>` の method の型(`herdr_api::methods::AgentGet` など)と params の型は、herdr の crate が再 export する `herdr::herdr_api` から名指す(ADR `0328-herdr-reexports-herdr-api`)。orchestrator の manifest には herdr-api を足さない。

## TypeScript との違い

- 取り消しの速さ: TypeScript は、`agent.start` の呼び出しの最中に取り消されると、取り消しのあとに abort の listener を登録する(`runtime.ts:159`)ので、待ちが取り消しに気づかず最大 30 秒続く。Rust の `CancellationToken::cancelled()` は取り消し済みならすぐ完了するので、すぐ `Cancelled` を返す。ペインを閉じるのは、どちらも spawn の後始末である
- TypeScript の `createLocation` が、取り消しのときに残ったペインを閉じる処理(`runtime.ts:137`)は移さない。この処理は `AbortError` のときだけ動くが、`herdrRpc` は signal を受け取らず `HerdrError` しか投げないので、TypeScript でもこの処理には届かない
- 必須の項目が欠けた答え: TypeScript は `herdr pane.split returned no pane.` などの普通の `Error`(500 の `internal_error`)を投げる。Rust では、生成した型が `pane` と `root_pane` を必須にしているので、`Herdr { code: "bad_frame" }` になる。ADR `0252-herdr-client` が受け入れた違いである
- `NotFound` は herdr の文を持たず、コードは `agent_not_found` になる(`runtime.rs` の `RuntimeError::code`)。たとえば、閉じたペインを `caller_pane_id` に渡した spawn は、TypeScript では 502 の `pane_not_found` と herdr の文を返し、Rust では `NotFound` になる。ADR `0242-phase-3-split` の表のとおりで、変えるなら O1 の `runtime.rs` の Issue になる

## 検討した代わり

- `with_start_timeout(Duration)` だけを置く: やり直しのテストだけで 300 + 600 + 900 + 1200 = 3,000 ミリ秒かかり、起動の失敗のテストは 1 件ごとに 500 ミリ秒以上かかる
- `HerdrRuntime::new(herdr, timings)` の 2 引数: 本番の呼び出し(LIVE の core)が毎回 `StartTimings::default()` を書くことになる
- tokio の止めた時計でテストする: 止めた時計は、すべての task が待ち状態になると次の timer の時刻まで進むので、偽のサーバーの socket を待つ間に呼び出しの時間の上限(10 秒)が過ぎる(ADR `0242-phase-3-split` の「非同期と時刻」)
- 普通の `Error` を `RuntimeError` の新しい variant にする: `runtime.rs` は O1 のファイルで、この Issue の書くパスにない。コード `internal_error` で 500 を表す先例(`OrchestratorError::Io`、`FleetError::new("internal_error", …)`)がある
- 6 つの method も `call` で呼ぶ: 上の「`rpc` と `call` の使い分け」の 3 つの誤りが起きる
- `create_location` の呼び出しごとに token と競わせ、`HerdrRuntime` が残ったペインを閉じる: 途中で drop した `worktree.create` や `pane.split` では、herdr がペインを作っていても答えを読んでいないので、ペインの id が分からず閉じられない。ペインを閉じる役目も、`HerdrRuntime` と spawn の 2 か所に分かれる

## 依存

なし(orchestrator の manifest にある herdr、protocol、tokio、tokio-util だけを使う)。

## 結果

- LIVE(#270)の core は、`HerdrRuntime::new(Herdr::new(socket_path(|name| std::env::var_os(name))))` で runtime を作り、`Orchestrator` に渡す
- API(#269)は、`RuntimeError::Herdr` のコード `internal_error` を 500 で答える必要がある(TypeScript の普通の `Error` に当たる)。コードを見ずに `Herdr` を一律 502 にすると、TypeScript と違う status になる
- worktree の経路で `worktree.create` のあとの `pane.split` か root の `pane.close` が失敗すると、TypeScript と同じく、root のペイン、分けたペイン、worktree が残る。直すなら別の Issue にする

## 確かめたこと

2026-11-11、Linux(Omarchy、kernel 7.2.15)、herdr 0.9.1。

- テストを先に書き、口だけ置いて中身を `todo!()` にした stub で `cargo test --locked -p herdr-fleet-orchestrator --test herdr_runtime` を走らせ、`test result: FAILED. 0 passed; 41 failed; 3 ignored` を確かめた
- 実装のあと、同じコマンドで 41 件が通った。H2 の偽のサーバーで、10 の method が送る method と params、4 つの場所の分かれ方、`launch_pending` のあとの `interactive_ready` の待ち、250 ミリ秒ごとの問い合わせ、`not an available shell` の 4 回までのやり直しと待ちの伸び、起動の失敗、準備ができないこと、取り消し、エラーコードの変換を確かめる
- 隔離した herdr のセッション `herdr-fleet-rs-5875b04e`(`HERDR_*` を外し、`ZDOTDIR` を worktree の `rust/.dev-state/` の空のフォルダーにした)で `-- --ignored` を走らせ、`runtime.herdr.test.ts` の 3 件を移したテストが通った。`screen` のスクロールの判定を外した実装では、スクロールのテストが失敗することも確かめた
- herdr 0.9.1 の `worktree.create` は、worktree のワークスペースのほかに、repo のフォルダーのワークスペースも開く。repo のワークスペースは、worktree のワークスペースを閉じるまで `workspace.close` で閉じられない(`workspace_group_close_required`)。live テストは、作成の前後で増えたワークスペースを新しいほうから閉じる。TypeScript のテストは repo のワークスペースを閉じずに残す
