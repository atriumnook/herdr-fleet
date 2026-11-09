# orchestrator の models module が公開する型と関数と、モデル一覧の時間の扱いを決める

- 状態: 採用
- 決めた日: 2026-11-09
- Issue: #258

## 状況

Issue #258(L4)は、各 CLI のモデル一覧の取得(`server/fleet/model-lists.ts`)と、spawn の前に使えないモデルを飛ばす catalog(`server/fleet/models.ts`)を、orchestrator の `models` module に移す。ADR `0242-phase-3-split` は、CLI ごとのモデル一覧を adapter から外してこの module に置くこと、O2 が `ModelGate` の impl を書くことを決めたが、module が公開する型と関数は決めていない。この module を使うのは次の 3 つで、core は crate の外から使う。

- O2(#263): spawn の前に `unknown` を呼ぶ。ADR `0242-phase-3-split` の port の形(`Pin<Box<dyn Future + Send + '_>>`)に入れるので、future が `Send` でなければならない
- API(#269): `/api/fleet/models` で全種類の一覧を返す。`api.test.ts:46` は codex にだけ source を渡し、ほかの種類の一覧が「error なしの空」になることを確かめる
- core: catalog を 1 つ作り、orchestrator と router に渡す(TypeScript の `server/index.ts:523` と同じ)

制約は次のとおり。L4 が書けるのは `models/` と `tests/models.rs` だけで、manifest も protocol も書けない。workspace に `futures` crate はない。

lead は形を 1 つ提案し、architect(読むだけ)が O2、API、core の使い方と照らして判断した。この ADR は architect の答えを記録する。

## 決定

### 公開するもの

- `ListOptions`(作業フォルダー、プログラム、サーバーの環境変数、opencode が聞き直すまでの時間)と `ListOptions::new`
- `ModelSource { complete: bool, list: Arc<dyn Fn(ListOptions) -> ListFuture + Send + Sync> }` と `source_for(kind)`。`ListFuture` は `Pin<Box<dyn Future<Output = Result<Vec<ListedModel>, String>> + Send>>`
- 出力の parser(`parse_agy_models`、`parse_cursor_models`、`parse_pi_models`、`parse_opencode_models`、`parse_codex_models` と `CodexPage`)。TypeScript のテストが純粋な関数として確かめているため
- `CatalogOptions`(CLI のフォルダーの親、サーバーの環境変数、`clock`、`spawn_wait`、`sources`)と `CatalogOptions::new`。既定は `SystemClock`、3 秒、`|kind| Some(source_for(kind))`
- `ModelCatalog`(`Clone`。clone は一覧を共有する)の `new`、`list(agent, fresh)`、`list_all()`、`unknown(agent, model)`

公開しないものは、CLI ごとの一覧の関数(`list_agy_models` など 5 つ)と、claude の別名の定数である。CLI の一覧を取る関数を `source_for(kind).list` の 1 つにし、テストもそこを通す。こうすると、種類と一覧の関数の対応の誤り(cursor に agy の関数を当てるなど)をテストが見つける。

### 3 つの選択

1. `ModelSource` は trait ではなく、値と関数の struct にする。CLI の種類は `FleetAgentKind` で閉じていて、本物の source は状態を持たない。`launch::Adapter`(ADR `0248-launch-adapters`)と同じ形である。`models.test.ts` の stub は、呼ばれた回数を数える、途中で答えを変える、答えない、テストが答えを渡すまで待つ、という状態を持つ。closure なら stub を式 1 つで書ける。`sources` が `Option<ModelSource>` を返すのは、API のテストと `catalog(undefined)` の件が「source のない種類」を使うためである。`source_for` は `Option` を返さない(本物では 6 種類すべてに source がある)
2. エラーは `String` にする。エラーを読む箇所は、`ModelListing.error`(protocol の `Option<String>`)にそのまま入れる箇所と、`unknown` がエラーの有無だけを見る箇所の 2 つで、種類で分けて扱う呼び手がない。文を作るのは `lists.rs` の中で `RunError`・`OpencodeError`・`io::Error` を文に直す箇所だけにする
3. `list` は `async fn` にしない。呼んだ時点で問い合わせを `tokio::spawn` で始め、待つための future を返す。理由は 2 つある
   - `unknown` は 3 秒で待つのをやめる。問い合わせを待ち手の future の中で動かすと、待ち手が drop したときに問い合わせも drop され、runner が `kill_on_drop` で CLI を止めるので、結果が残らない。すると 3 秒より遅い CLI では、spawn のたびに 3 秒待ち、一覧が一度も残らない。TypeScript は promise を走らせ続け(上限 20 秒)、終わった答えを残す(`models.ts:45`)
   - 呼んだ時点で始まるので、`list_all` は 6 つの `list` を呼んでから順に await するだけで、6 つが並行に動く。`models.test.ts` の「is asked anew by a fresh lookup」が確かめる、await の前に 2 つの問い合わせが始まっていることも、scheduler の順に頼らずに成り立つ

### 時間の扱い

一覧を残す時間(10 分、失敗のあと 1 分)は `Clock::now_ms` で比べ、spawn の待ち(3 秒)と opencode の聞き直し(2 秒)は `tokio::time` で待つ。ADR `0242-phase-3-split` の決まり(記録の時刻は `Clock`、待ち時間は `tokio::time`)のどちらにも当てはまらない時刻は、TypeScript での読み方で分ける。TypeScript が注入できる `now()` で読む時刻は `Clock` から読み、`setTimeout` で待つ時間は `tokio::time` で待つ。`ModelCatalog` は残す時間を `this.now()` で比べ(`models.ts:31, 45`)、spawn の待ちを `setTimeout` で数える(`models.ts:62`)。

tokio の `Instant` にしなかったのは、Linux の `CLOCK_MONOTONIC` が suspend の間に進まないためである。PC が 1 時間 sleep したあと、TypeScript(`Date.now()` の差)は sleep の前に残した一覧を古いとみなして聞き直すが、`Instant` で測ると新しいままとみなす。

### TypeScript と同じにした振る舞い

- 古い問い合わせが新しい(`fresh`)問い合わせのあとに終わると、古い答えが残る(`models.ts:45` は世代を見ずに `kept.set` する)。世代の番号は、問い合わせ中の項目を消すときだけに使う
- source のない種類の一覧は残さない(`models.ts:36` は `kept.set` の前に返す)
- 一覧が空なら、完全でない一覧として、エラー `<種類> listed no models` を付けて 1 分残す
- agy・cursor・pi の CLI がエラーで終わったとき、または 20 秒の上限で止めたときは、`<プログラム> <引数> failed` で失敗する(TypeScript は上限で kill し、終了コードが 0 でなくなるので同じ文になる)

### TypeScript と違う振る舞い

- 一覧の CLI の標準出力は 8 MiB までにする(C1 の runner の既定)。TypeScript には上限がない。ADR `0242-phase-3-split` が、ペインの外の子プロセスをすべて上限つきの runner に通すと決めた
- CLI を起動できないときの文は runner の文(`<プログラム> <引数>: could not start: …`)にする。TypeScript の文は Bun の `Bun.spawn` が投げる文で、Rust では作れない
- `codex app-server` の 1 行が JSON の object でなければ、答えではないとして読み飛ばす。TypeScript は `null` の行で TypeError を投げて一覧を失敗させ、ほかの object でない値は読み飛ばす。`null` の行を codex は送らない
- codex の答えの `id` は整数として読む(`as_i64`)。TypeScript は `2.0` のような小数の書き方も `2` と同じに扱う。codex は整数で送る

## 検討した代わり

- trait の port(`trait ModelLister { fn complete(&self, kind) -> bool; fn list(&self, kind, ListOptions) -> ListFuture; }`)、`async fn list`、tokio の `Instant` で測る残す時間の組。`CatalogOptions` から `clock` が消えるので公開する項目は 1 つ減るが、テストの stub ごとに型と impl が要る。`async fn list` では呼んだ時点で問い合わせが始まらないので、`list_all` に `tokio::join!` か spawn が要り、「fresh lookup」の件の順が scheduler に頼る。時計も TypeScript の壁時計と違う種類になる
- エラーを enum にする: 種類で分けて扱う呼び手がいないので、match する箇所がない

## 依存

なし。

## 結果

- O2 は `impl ModelGate for ModelCatalog` を `Box::pin(self.unknown(kind, model))` で書ける。`ModelCatalog` が `Clone + Send + Sync + 'static` で、`unknown` と `list_all` の future が `Send` であることを、テスト `the_catalog_and_its_lookups_can_move_between_tasks` が確かめる
- API は `ModelCatalog` をそのまま持ち、`list_all().await` を返す。API のテストは、偽の `sources` を渡した本物の `ModelCatalog` で書ける
- core は `ModelCatalog::new(CatalogOptions::new(<stateDir>/model-list, <プロセスの環境変数>))` を 1 つ作り、その clone を orchestrator と router に渡す。catalog を 2 つ作ると、同じ CLI を 2 回起動する
- `list` は tokio の runtime の外で呼ぶと panic する(doc の `# Panics` に書いた)
- protocol に `FleetAgentKind` の全種類の並びと名前の関数がないので、`models` は private の写し(`AGENT_KINDS`、`kind_name`)を持つ。launch(`kind_name`)とテスト(`tests/launch.rs` の `ALL_KINDS`)にも写しがある。写しを置き換える Issue を別に開く。順と名前は `runs_each_cli_in_its_own_folder_under_the_catalogs` が確かめる
- L3(#254)の `UsageTracker` にも `now()` で比べる時刻がある(`usage.ts:291` の `SCREEN_TTL_MS`、`usage.ts:325` の `probedAt`)。上の「時間の扱い」の分け方を当てるかは L3 が決める

## 確かめたこと

- `rust/` で `cargo test --locked -p herdr-fleet-orchestrator --test models`: 38 件が通った(Arch Linux、rustc は `rust-toolchain.toml` の版)。うち 24 件は `models.test.ts` の `it` の移植、14 件は新しいテスト
- 実装の前に同じコマンドを `todo!()` の stub で走らせ、`test result: FAILED. 1 passed; 36 failed` になった。通った 1 件は、C2 の `opencode_api_get` を直接試す移植の件(「opencode's reply is bounded in size and in time」)で、C2 がすでにあるので先に失敗させられない。`Send` のテストは、このあと architect の答えで足した
