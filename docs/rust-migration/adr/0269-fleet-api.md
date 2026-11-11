# `/api/fleet` の axum の router と、その公開の口

- 状態: 採用
- 決めた日: 2026-11-12
- Issue: #269

## 状況

#269(API)は、`server/fleet/api.ts` の `/api/fleet` のルートを、orchestrator の `api` の module に axum の `Router` として移す。core はこの router を `/api/fleet` に mount する(ADR `0107-crate-split`、`0242-phase-3-split`)。受け入れ条件は次の 5 つ。

- `pub fn router(…) -> axum::Router` がすべてのルートを持つ。本文の検査、エラーコードと HTTP の状態の表が TypeScript と同じ
- handler は操作を `tokio::spawn` の中で動かし、`CancellationToken::drop_guard` を持つ
- `X-Herdr-Fleet: 1` の確認は router に置かない
- `api.test.ts` の 12 件の `it` を、`tower::ServiceExt::oneshot` で router を呼ぶ Rust のテストに移す
- `GET /report` は、thread の worktree の中の `cwd` からも、project をリポジトリ本体に決める(`mainWorktree()`)

公開の口を決める前に、次のことを決める必要があった。

- `router` の引数の型。TypeScript の `handleFleetRequest` は、orchestrator のほかに、省略できる 5 つの引数(`usage`、`settings`、`entrances`、`models`、`report`)を取る。引数がないルートは 404 を返す
- factory report を組み立てる場所と、テストが差し替える口。TypeScript では `server/index.ts:544-551` のクロージャが組み立てる
- `planned_label` の正規表現の読み方(#269 のコメント 2)
- `cwd` を省いたときの既定(TypeScript の `process.cwd()`)
- 取り消しの helper の形と、それを通す操作の範囲
- エラーと状態コードの表を公開するか
- `src/api/` の中の分け方
- method とパスの一覧が TypeScript と一致することの確かめ方

read-only の architect(fleet の run `6f0e9dd4`、Claude Code)に 8 つの問いを出し、その答えに従った。

## 決定

### 公開の口

公開するのは次の 3 つだけにする。本文の検査、エラーと状態コードの表、取り消しの helper、report の組み立ては、すべて `api/` の中に private で置く。

```rust
pub struct FleetApiDeps {
    pub fleet: Orchestrator,
    pub usage: Option<UsageTracker>,
    pub settings: Option<FleetSettingsStore>,
    pub entrances: Option<EntranceStore>,
    pub models: Option<ModelCatalog>,
    pub report: Option<FactoryReporter>,
}

pub struct FactoryReporter {
    pub events: Arc<EventLog>,
    pub github: GitHub,
    pub time_zone: jiff::tz::TimeZone,
}

pub fn router(deps: FleetApiDeps) -> axum::Router
```

- `FleetApiDeps` の 5 つの `Option` は、TypeScript の省略できる引数に 1 対 1 で対応する。`None` の部分のルートは 404 `not_found` を返す。pub な項目を持つ struct にしたのは、この crate の `OrchestratorDeps`、`FleetSettingsDeps`、`EntranceDeps` と同じ書き方にするため
- `UsageTracker` と `ModelCatalog` は Clone の handle なので値で受ける。core は同じ handle を orchestrator の `UsageGate` と `ModelGate` にも渡す。`FleetSettingsStore` と `EntranceStore` は、TypeScript でも `handleFleetRequest` だけが使うので、router が所有する
- router の state は `Arc<FleetApiDeps>` にする。core は `Router::new().nest(protocol::FLEET_API, router(deps))` と書くだけでよい

### factory report

- report は `api/report.rs` が最後まで組み立てる。手順は TypeScript の `factoryReport` と同じ: `main_worktree(cwd)`(なければ `not_a_repository`)、`git_branch(project)`(なければ `HEAD`)、`gh` の 2 つの一覧、`read_events`、`metrics`、`render`。ADR `0259-metrics-interface` の「結果」が、この組み立てを API に置くと決めている。core は `FactoryReporter` を作って渡すだけになる
- `events` は path ではなく `Arc<EventLog>` で受ける。core は同じ `EventLog` を orchestrator の `events` にも渡すので、記録のファイルの場所を決めるのは core の 1 か所になる
- `to` は orchestrator の clock の時刻、`from` は `to - floor(hours × 3,600,000)`。TypeScript は小数を含む `from` と整数の時刻を `>=` で比べるので、小数を切り捨てても同じ出来事が数えられる
- `metrics` の `current` には、registry のすべての run の id と状態を渡す。`quiet_ms` は TypeScript の `QUIET_MS` と同じく定数 `fleet::QUIET` を使う
- 記録のファイル(最大で 8 MiB の 2 世代)は `spawn_blocking` で読む
- `gh` が失敗したら 500 `internal_error` で、本文は `gh` の文にする(TypeScript の `ghJson` は素の Error を投げ、表が 500 にする)
- テストは、既存の差し替え口 `GitHub::with_program` に偽の `gh`(shell script)を渡し、本物の `git` で `main_worktree` と `git_branch` を通す。新しい trait は足さない。そのため report のテストは、止めた tokio の時計(`start_paused`)ではなく、普通の `#[tokio::test]` で走らせる(ADR `0256-orchestrator-foundation` の、止めた時計では git を動かさないという決まりと同じ)

### `planned_label`

- `regex::Regex::new` で読み、読めなければ `invalid_planned_label` で断る。空の文字列は、TypeScript と同じく「指定なし」として扱う
- regex crate は、先読み・後読み・後方参照を受け付けない。照合の時間は入力の長さに比例する。ADR `0193-phase-2-dependencies` は、先読みを持つ fancy-regex を、入力によって照合の時間が指数で増えるという理由で退けた。`planned_label` は利用者が渡す文字列なので、この理由がそのまま当たる

### `cwd` の既定

- `GET /roles`、`GET /settings`、`POST /settings` で `cwd` がないか空のときは、要求ごとに `std::env::current_dir()` を読む。state に既定のフォルダーの項目は置かない。orchestrator も、cwd のない spawn、thread、project で、呼ばれるたびにプロセスのフォルダーを読む。項目を足すと、サーバーのフォルダーが 2 通りになりうる

### 取り消し

- private な `in_task(work)` が、新しい `CancellationToken` と、その `drop_guard` を作り、`work(token)` を `tokio::spawn` で動かして待つ。axum は接続が切れると handler の future を drop するので、guard が token を cancel する。spawn した task は drop されないので、後始末(spawn の途中ならペインを閉じる)は最後まで走る
- token を取る method かどうかに関係なく、handler の中で await するものはすべて `in_task` を通す(`interrupt`、`focus`、`close_done`、`diff`、`checks`、`read`、`threads`、`usage.refresh`、`models.list_all`、report も含む)。Bun は接続が切れても promise を最後まで走らせるので、TypeScript ではどの操作も途中で止まらない。await を spawn の外に置くと、たとえば `close_done` が herdr を変えたあと、記録を保存する前に止まりうる
- task が panic したときは、500 `internal_error` で、本文は panic の文にする

### エラーと状態コードの表

- 表は `api/error.rs` に private で置き、公開しない。TypeScript も `STATUS` と `fleetError` を export しておらず、今この表を呼ぶ 2 つ目の呼び手はない
- `api.ts:294-297` の表をそのまま写し、2 つのコードを足す。どちらも TypeScript の表にない
  - `guard_plugin_missing` は 500(#269 のコメント 1)。編集しない役割の opencode を起動するのに要る fleet-guard の `index.js` が、サーバーの install にないときのエラーで、要求した側の誤りではない
  - `internal_error` は 500。Rust の settings と entrances の store は、TypeScript が素の Error を投げた箇所(TypeScript では 500)で `FleetError::new("internal_error", …)` を返す。表に行がないと 400 になり、TypeScript と違ってしまう
- `OrchestratorError` は、コードではなく variant で分ける。同じ `agent_blocked` でも、`FleetError` として返るときは 409 で、herdr のエラー(`RuntimeError::Blocked`)として返るときは、TypeScript では `HerdrError` だったので 502 になる

| 元のエラー | 状態 | 本文の code と message |
|---|---|---|
| `FleetError`(`OrchestratorError::Fleet` も) | 表の値。表にないコードは 400 | そのまま |
| `WaitTimeout` | 408 | `wait_timeout`、Display の文、`run` も付ける |
| `RuntimeError::Cancelled` | 499 | `aborted`、`request cancelled` |
| `RuntimeError::StartFailed`、`NotReady` | 表の値(502、504) | `error.code()`、文 |
| `RuntimeError::Blocked`、`NotFound`、`Herdr` | 502 | `error.code()`、文 |
| `OrchestratorError::Io`、`GhError`、panic | 500 | `internal_error`、文 |
| ルートがない | 404 | `not_found`、`Unknown fleet endpoint` |

- 本文は protocol の `ErrorBody` で作り、Content-Type は TypeScript の `jsonResponse` と同じ `application/json; charset=utf-8` にする

### `src/api/` の中の分け方

| ファイル | 持つもの |
|---|---|
| `mod.rs` | 公開の 3 つ、ルートの表、`not_found`、`in_task` |
| `handlers.rs` | ルートごとの handler(要求を分け、検査し、`in_task` を通して呼び、JSON で返す) |
| `body.rs` | 本文の読み取り(`invalid_json`、`invalid_body`)、`group`、spawn・thread・brief・comments・land の action・`from_pane` などの検査(`api.ts:200-283` と各ルートの検査)。I/O を持たない |
| `error.rs` | `ApiError`、状態コードの表、`json_response` |
| `report.rs` | `planned_label` と report の組み立て |
| `js.rs` | JavaScript の `Number(text)`(`?hours=` と `?lines=` を読む) |

### method とパスの一覧と、axum との違い

- ルートの表は router の中に private で置く。パスは `protocol::fleet_routes` の定数を使う。テストは、`api.ts` の doc comment(22-52 行)から手で書いた 29 組の method とパスで router を呼び、それぞれが 404 `not_found` にならないことを確かめる。25 のパスに一覧にない method で送ったとき、一覧にないパス、`None` の部分のルートが 404 `not_found` になることも確かめる。`pub const ROUTES` は置かない。const の一覧は handler を持てないので、テストが router ではなく const を確かめることになるため
- axum の既定の振る舞いを、TypeScript に合わせて 4 つ変える
  - 一覧にないパスも、既知のパスへの別の method も、405 ではなく 404 `not_found` にする(`.fallback` と `.method_not_allowed_fallback`)
  - GET のルートに来た HEAD は 404 にする。axum は HEAD を GET の handler に渡すが、`api.ts` のどの分岐も `method === "GET"` を見る
  - 本文は `Bytes` で受けて `serde_json::from_slice` で読む。axum の `Json` は Content-Type のない要求を 415 で断るが、TypeScript は Content-Type を見ない
  - `POST /runs/:target/<step>` は、step が POST を受けないもの(`diff`、`landing`、`read`、知らない名前)でも、先に本文を読む。`api.ts` は step を見る前に本文を読む(173-174 行)ので、JSON のオブジェクトでない本文には `invalid_json` か `invalid_body` を返し、読めた本文には 404 を返す
- query は `Query<Vec<(String, String)>>` で受け、同じ名前の値が複数あれば最初の値を使う(`URLSearchParams.get` と同じ)

### `X-Herdr-Fleet`

- router はこのヘッダーを見ない。core のアクセス制御が見る(ADR `0107-crate-split`、`0242-phase-3-split`。段階 3 では #270 の最小の core)。`api.test.ts` の `it`「refuses a change without X-Herdr-Fleet: 1, which a page on another site cannot send」と、ほかの `it` の中の 403 を期待する行(usage の refresh と clear、entrances、plan、settings)は #270 に引き継ぐ。Rust のテストは、ヘッダーのない変更の要求を router が通すことを確かめる

## 検討した代わり

- 依存ごとの trait(TypeScript の `Pick<…>` を写す形): どれも本物の実装が 1 つしかなく、テストのためだけの差し替え口になる。TypeScript のテストも本物の store を使う。Rust の store も中身(usage の probe、モデル一覧の source、clock)を差し替えられる
- 依存ごとのルートの塊(`usage_routes(u)` などを core が merge する): どのルートがあるかを core が知ることになり、ルートの一覧が複数の関数に分かれる
- report を TypeScript と同じクロージャで受け、組み立てを core に置く: 受け入れ条件のテストが router を通して `main_worktree` を確かめるには、router が `main_worktree` を呼んでからクロージャに渡すことになり、report の作り方が api と core の 2 つの crate に分かれる。ADR `0259-metrics-interface` の決定とも合わない
- GitHub の一覧を返す trait を api に置く: 既存の差し替え口(`GitHub::with_program`)の横に 2 つ目を作ることになる
- `planned_label` に fancy-regex を使う: 上の「`planned_label`」の理由で取らない
- 状態に既定のフォルダー(`default_cwd`)を置く: 上の「`cwd` の既定」の理由で取らない
- `Number(text)` を protocol の `js` に移す Issue を開き、#269 をそれまで待たせる(architect の推奨): ECMAScript どおりの実装は `cli::js::number` にしかなく、orchestrator は cli に dev-dependency でしか依存しない。protocol は #269 の書くパスにない。待たせると #269 の後に続く #270 と #274 も止まる。そのため `api/js.rs` に private な写しを置き、protocol に移して写しを消す作業を #352 に分けた(下の「結果」)

## 依存

なし。axum、tokio、tokio-util、regex、jiff、serde_json、dev-dependency の tower と http-body-util は、ADR `0244-phase-3-dependencies` などで orchestrator の manifest に入っている。

## 結果

- core(#270)は、`FleetApiDeps` と `FactoryReporter` を作って `router` を `/api/fleet` に nest し、その前に `X-Herdr-Fleet` を含むアクセス制御を置く
- CC(#274)は、`router` に本物の TCP で Rust の CLI を当てる
- TypeScript と違う振る舞い(すべて PR に書く):
  - `planned_label` の先読み・後読み・後方参照のあるパターン(例: `^(?!tracking$).*`)は、TypeScript では通り、Rust では `invalid_planned_label` で断られる。両方で読めるパターンでも、`\d`、`\w`、`\s`、`.` が当たる範囲が違う(regex の既定は Unicode)。ラベルの名前が ASCII なら結果は同じ
  - `POST /settings` の patch のうち、型が違うために protocol の `FleetSettingsPatch` に読めない値(数のところに文字列など)は、`invalid_settings` で断る。コードは TypeScript と同じだが、文は serde の文になる
  - `RuntimeError::NotFound` は herdr の 3 つのコード(`agent_not_found`、`not_found`、`pane_not_found`)をまとめるので、502 の本文の code は常に `agent_not_found` になる。ADR `0242-phase-3-split` が決めた variant から生じる違いで、状態は TypeScript と同じ 502
  - 末尾が `/` のパス(`/runs/`)は 404 になる。TypeScript は `/runs` と同じに扱う。CLI と fleet CLI の corpus に、末尾が `/` の要求はない
  - パスの target の percent-encoding が UTF-8 として読めないとき、axum は 400 を text で返す。TypeScript は `decodeURIComponent` の例外が handler の外に出て、サーバーの既定のエラーになる。どちらの場合も要求は失敗する。CLI は `encodeURIComponent` で encode するので、この場合は起きない
  - 本文が 2 MiB を超える要求は、axum の既定の上限で 413 になる。Bun は既定で 128 MiB まで受ける。計画は 64 KiB を超えると `invalid_plan` で断られ、ほかの本文がこの大きさになることはない
  - `?lines=` の小数(`2.5`)は切り捨てて 2 行にする。TypeScript は 2.5 をそのまま runtime に渡す。`timeout_ms` の小数も切り捨てる(1 以上の値だけを受けるので、0 にはならない)
  - usage の読み取りの `readAt` などの JavaScript の数は、整数でも `1.0` と書かれる(protocol の型が `f64` のため)。JSON を読む側(JavaScript の `JSON.parse` など)は、どちらも同じ数として読む
- `api/js.rs` の `number` は `cli::js::number` の写しで、2 か所に同じ規則がある。protocol に移して写しを消す作業は #352 にある

## 確かめたこと

PC は Linux 7.2.15(omarchy)、`rust/` で `HERDR_*` を外して実行した。

- テストを先に書き、`router` を `todo!("#269")` の stub にして `cargo test --locked -p herdr-fleet-orchestrator --test api` を走らせ、20 件すべてが `panicked at crates/orchestrator/src/api/mod.rs:44:5` で失敗することを見た(`test result: FAILED. 0 passed; 20 failed`)
- 実装のあと、同じコマンドで 20 件が通った。内訳は、`api.test.ts` から移した 11 件(`X-Herdr-Fleet` の 1 件を除く)、ヘッダーを router が見ないことの 1 件、ルートの一覧の 3 件、report の `main_worktree` とエラーの 2 件、取り消しの 1 件、herdr のエラーと `guard_plugin_missing` の 2 件
- `in_task` の `drop_guard` の行を消すと、取り消しのテストが `w1:p1 was not closed: []` で失敗し、戻すと通ることを見た
- `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace` が通った
