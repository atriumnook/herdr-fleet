# herdr の crate の公開の口: RPC、応答の形の表、購読、EventSource

- 状態: 採用
- 決めた日: 2026-11-09
- Issue: #252

## 状況

ADR `0242-phase-3-split` は、herdr の crate のクライアントについて次のことを決めていた。

- すべての method を `rpc::<M>(params)` の 1 つの口で呼び、`rpc` は `ResponseResult` を返す
- method ごとに、期待する応答の形の表を手で書き、`rpc` の結果をその形に変える関数を置く
- ペインの状態の購読(H3、#257)は port `EventSource`(subscribe と snapshot)で herdr を読み、本物はこの Issue(H2)のクライアントが実装する
- `pane_status` の `PaneStatusHandler` と `start` の signature

残っていたのは、`HerdrError` の形、表の書き方、購読の形(callback か、呼ぶ側が読む stream か)、`EventSource` の signature、時間の上限の渡し方、socket の場所の関数の形である。H3 と HR(#261、`HerdrRuntime`)のテストが使う偽のサーバーを、orchestrator のテストからどう使うかも決める必要があった。HR のテストは orchestrator の crate にあり、herdr の `tests/common/` を import できない。この Issue は manifest と `Cargo.lock` を書けない(ADR `0242-phase-3-split`)。

どれも crate の公開の口なので、architect(fleet の run `6d60c056`、読むだけ)に 5 つの問いを出し、その答えに従った。

## 決定

### RPC と時間の上限

- `Herdr` は socket のパスと時間の上限だけを持つ値で、接続を持たない。`Herdr::new(path)` の上限は `Herdr::DEFAULT_TIMEOUT`(10 秒、TypeScript の `DEFAULT_TIMEOUT_MS`)である。上限を変えるときは `with_timeout(duration)` で上限だけが違う複製を作る。`rpc` と `call` は 1 つずつで、上限を引数に取らない
- `rpc::<M>(params)` は、要求ごとに接続を開き、`{"id", "method", "params"}` の 1 行を送る。空でない最初の行を答えとして読む。行が途中で切れたときは、残りを次の読み取りにつなぐ。id は TypeScript と同じ `br-<時刻の 36 進>-<連番>` である
- 結果が `ResponseResult` のどの形にも読めないときは `bad_frame` にする。TypeScript は結果をそのまま返していた。ADR `0242-phase-3-split` が `rpc` の戻り値を `ResponseResult` に決めたことによる違いである。schema にない `type` は `ResponseResult::Other` として返る

### `HerdrError`

enum にし、variant は `Timeout`、`BadFrame`、`SocketError`、`Closed`、`ConnectFailed`(どれも TypeScript と同じ文を持つ)と、herdr のエラーの `Herdr { code, message }` の 6 つにする。`code()` は TypeScript の `HerdrError.code` と同じ文字列(`timeout` など、または herdr のコード)を返し、`message()` と `Display` は文を返す。クライアントが作る失敗は閉じた集まりで、herdr のコードは開いた集まりなので、variant で分ける。コードの文字列を書くのは `code()` の 1 か所になる。herdr のエラーのコードと文がないときは、TypeScript と同じく `herdr_error` と `herdr request failed`(購読では `subscription failed`)にする。

### 応答の形の表

- trait `Answer: Method { type Output; fn answer(ResponseResult) -> Result<Output, HerdrError>; }` を、herdr-api の method の marker 型に実装する。実装は `src/answer.rs` の 1 つの macro の一覧から作り、1 行が 1 つの method である。`Output` はその形の項目の struct、`ok` なら `()` にする。行ごとに項目を取り出す決まりは置かない
- `Herdr::call::<M: Answer>(params)` は、`rpc` の結果を `M::answer` で変える。表と違う形のときは `bad_frame` で、文は method、表の形、届いた形を書く。表にない method は `call` で呼べず(compile できない)、段階 4 の Issue が新しい method を呼ぶときは、その Issue が表に 1 行足す
- 同じ macro が、表の一覧 `ANSWERS`(method の名前と `type`)を作る。本物の herdr のテスト `live::herdr_answers_each_method_in_the_tables_shape` は、すべての行を呼んで形を確かめ、呼んだ method の集まりが `ANSWERS` と等しいことを確かめる。表に行を足し、このテストにその method の呼び出しを足さないと、このテストが失敗する
- `events.subscribe` は表に載せない。その答えは `rpc` ではなく購読の stream で読む

表(herdr 0.9.1、protocol 22 で確かめた):

| method | 形 | TypeScript が読む箇所 |
|---|---|---|
| `ping` | `pong` | `server/herdr/client.ts` の `ping` |
| `session.snapshot` | `session_snapshot` | `sessionSnapshot` |
| `workspace.create` | `workspace_created` | `runtime.ts` の `createLocation` |
| `worktree.create` | `worktree_created` | 同上 |
| `tab.create` | `tab_created` | 同上 |
| `pane.split` | `pane_info` | 同上 |
| `pane.get` | `pane_info` | 同上、`paneScrollInfo` |
| `pane.read` | `pane_read` | `paneRead`、`watchStartupFailure` |
| `pane.close` | `ok` | 読まない |
| `pane.report_metadata` | `ok` | 読まない |
| `agent.start` | `agent_started` | 読まない |
| `agent.get` | `agent_info` | `waitReady`、`get`、`screen` |
| `agent.focus` | `agent_info` | 読まない |
| `agent.prompt` | `agent_prompted` | 読まない |
| `agent.read` | `pane_read` | `read`、`screen` |
| `agent.send_keys` | `ok` | 読まない |

TypeScript が応答を読まない 6 つの method も、`call` は表の形でなければ断る。表の形は実機のテストで確かめているので、この違いを受け入れる。

### 購読と `EventSource`

```rust
pub trait EventSource: Send + Sync + 'static {
    fn subscribe(&self, subscriptions: Vec<herdr_api::Subscription>) -> EventStream;
    fn snapshot(&self) -> SnapshotFuture; // Vec<PaneInfo> を返す 'static の future
}
pub enum StreamItem { Started, Event(EventFrame), Error(HerdrError) }
pub struct EventFrame { pub event: Option<String>, pub data: serde_json::Value }
```

- 購読は callback ではなく、呼ぶ側が持つ `EventStream` にし、`next().await` で読む。H3 は、状態(`heard`、`lastEventOf`、`actedOn`、`focusedAt` など)を 1 つの task が持ち、`select!` で複数の stream、snapshot、timer を待てる。Bun が callback を 1 つずつ最後まで動かすのと同じ順になり、lock が要らない
- TypeScript の 4 つの callback は次のように対応する: `onStarted` は `Started`、`onEvent` は `Event`、`onError` は `Error`、`onClose` は `next()` が `None` を返すこと。つなげなかったときは `Error(ConnectFailed)` のあと `None` になり、H3 は「つなげなかった」と「herdr が閉じた」を同じ処理で扱える。つなぎ直しはしない(呼ぶ側が行う)
- 閉じるのは drop で、`close()` は置かない。drop すると接続が閉じ、まだ読んでいない項目も捨てる(TypeScript の「呼ぶ側が閉じたあとに残った frame は、置き換えた購読のもの」)
- `subscribe` は同期の関数で、すぐに返り、裏で接続する(Tokio の runtime の中で呼ぶ)。読む task は上限 256 の `mpsc` channel に入れる。読む側が止まると読む task も止まり、herdr の socket の buffer が埋まって、herdr が購読を閉じる(`events_lost`)。H3 はつなぎ直し、取り逃した状態を snapshot で読み直す(TypeScript の collector と同じ)。上限のない channel にすると、遅れは herdr ではなくこのプロセスのメモリーに溜まる。`next` は cancel-safe である
- 最初の `result.type == "subscription_started"` だけが `Started` で、それより前の frame も `Event` として渡す。JSON でない行は飛ばす。`EventFrame` は届いた JSON のまま作り、`event` が文字列でなければ `None`、`data` がなければ `Null` にする。生成した `EventEnvelope` は使わない。状態の frame は `event` が `pane.agent_status_changed` で、`data` に `type` がなく、`EventEnvelope` に読めない(`server/collector.ts` の冒頭のコメント)
- `snapshot` は `SessionSnapshot` ではなく `Vec<PaneInfo>` を返す。collector が読むのは `panes` だけで(TypeScript の偽物も `{ panes }` を返す)、`SessionSnapshot` を返すと、H3 の偽物が要らない項目まで作ることになる。future を `'static` にするのは、H3 が snapshot を待つ間も event を扱うため
- `Herdr` が持つ購読と snapshot は、`impl EventSource for Herdr` だけにする。TypeScript で購読するのは collector だけである
- 偽物は `EventStream::channel()` で作る。`EventSender::send` は async で、stream が drop されたら `false` を返す。`is_closed()` は TypeScript の偽物の `closedByCollector` に当たる

### `pane_status` の stub

- ADR `0242-phase-3-split` の signature のとおりにし、ペインの型は別名を置かずに `herdr_api::PaneInfo` と書く
- `PaneStatusOptions` は `Copy` で、既定の値は TypeScript の定数(250 ミリ秒、5 秒、60 秒、500 ミリ秒、5 秒、150 ミリ秒)である。`focus` の既定は true にする。TypeScript の 2 つの呼び出し元(`server/index.ts`、`collector.test.ts`)は、どちらも `onFocus` を渡すため
- `start` は `todo!("#257")` で、使わない引数は `let _ = (…)` で受ける(`-D warnings` を通すため)。`PaneStatus` は外から作れないよう private の項目を持ち、`stop(&self)` は空の stub で、何度呼んでも同じ結果になる
- doc に、`start` は今の Tokio の runtime に spawn すること、受け手の method は 1 つずつ呼ばれ、止まってはいけないことを書いた

### socket の場所と marker

- `socket::socket_path(env)` は環境変数を読む関数を引数に取る。core は `|name| std::env::var_os(name)` を渡す。edition 2024 と `forbid(unsafe_code)` の下では、テストがプロセスの環境変数を書けないため(CLI の `run` と同じ理由)。空の `HERDR_SOCKET` は、TypeScript と同じく設定がないものとして扱う。`HOME` は文字列としてつなぎ、`HOME` がなければ `/.config/herdr/herdr.sock` になる
- Windows の `%APPDATA%\herdr\herdr.sock`、named pipe の名前(`socket::pipe_name`)、named pipe への接続は `cfg(windows)` に置く。Windows での動作の確認は段階 6 に残す
- marker の読み取り(`marker::marker_owner`、`parse_process_line`、`stale_marker`)は副作用のない関数で、すべての platform で compile し、Linux でテストする

### 偽のサーバー

`rust/crates/herdr/tests/common/fake_herdr.rs` に置く。std、tokio、serde_json だけに依存し、`super::` を使わず、先頭に `#![cfg(unix)]` を置く。HR のテストは、このファイルを `#[cfg(unix)] #[path = "../../herdr/tests/common/fake_herdr.rs"] mod fake_herdr;` で取り込む。偽のサーバーが使う tokio の feature(`net`、`io-util`、`rt`、`sync`、`time`)は、orchestrator が herdr に依存するかぎり orchestrator のテストの build でも有効になる(`cargo tree -p herdr-fleet-orchestrator -e features -i tokio`、architect が確かめた)。HR はこのファイルを読むだけで、書かない。

## 検討した代わり

- callback(TypeScript の形): tokio では、読む task から呼ばれる callback が H3 の状態を `Arc<Mutex<_>>` で共有することになる。また、`onClose` の中から `close()` を呼ぶ場合の決まりが要る。stream なら 1 つの task が状態を持てる
- `async fn subscribe -> Result<EventStream, _>`: つなげなかったときの扱いが H3 に 2 か所できる
- `HerdrError` を TypeScript と同じ `{ code, message }` の struct にする案: クライアントの 5 つのコードの文字列が、作る箇所と見分ける箇所のそれぞれに書かれる
- method ごとの関数(TypeScript の `paneRead` などの形): ADR `0242-phase-3-split` が 1 つの口に置き換えた形に戻る。`rpc` の結果と変換の関数を別々に呼ぶ形では、method と別の method の変換を組み合わせても compile が通る
- `rpc_within` のように上限を引数に取る口を別に置く案: 口が倍になり、既定の値が複数の場所に書かれる
- 偽のサーバーを `src/` の `pub mod testing` に置く案: core が link する library に、Unix の listener と一時フォルダーのコードが入る。cargo の feature `testing` は manifest の Issue を待つことになる

## 依存

なし(herdr の manifest にある tokio、serde、serde_json、herdr-api だけを使う)。

## 結果

- H3(#257)は、`EventSource` の偽物を `EventStream::channel()` で作り、`pane_status` の中身を書く。stub の signature は変えない。tokio の止めた時計を使うテストは、herdr の dev-dependency に `test-util` を足す #289 を待つ(herdr だけの build では `start_paused` が compile できない)
- HR(#261)は、`Herdr::call::<M>` で表の method を呼び、`HerdrError::code()` から `RuntimeError` に変える。`not an available shell` のやり直しは `message()` を読む。テストは `fake_herdr.rs` を `#[path]` で取り込む
- 段階 4 の Issue が新しい method を呼ぶときは、`src/answer.rs` の表に 1 行足し、`live::herdr_answers_each_method_in_the_tables_shape` にその method の呼び出しを足す
- TypeScript の `paneRead` などの包む関数(`strip_ansi` の既定、`focus: false` など)は移していない。呼ぶ側が params に書く。`ping` の `terminal_attach` の判定(`terminalAttachSupported`)は、それを使う段階 4 の core に残した

## 確かめたこと

2026-11-09、Linux(Omarchy、kernel 7.2.15)、Rust 1.99.1、herdr 0.9.1(protocol 22)。

- `cargo test --locked -p herdr-fleet-herdr --test client`: 41 件が通った(偽のサーバーで、要求の形、応答とエラーの読み取り、時間の上限、途中で切れた行、購読、表を確かめる。marker の 6 件と socket の場所も含む)
- 隔離した herdr のセッション `herdr-fleet-rs-8bcf3fda`(`HERDR_*` を外し、`ZDOTDIR` を worktree の `rust/.dev-state/` の空のフォルダーにした)で `cargo test --locked -p herdr-fleet-herdr --test client -- --ignored`: 8 件が通った(`client.test.ts` の 7 件と、表の 16 の method)。`agent.*` は pi を `--no-session` で起動して確かめ、`agent.prompt` にはモデルを呼ばない pi のコマンド `/hotkeys` だけを送った
- `cargo clippy --locked --target x86_64-pc-windows-gnu -p herdr-fleet-herdr --all-targets -- -D warnings`: 通った(`cfg(windows)` の部分の型検査。Windows での動作は確かめていない)
