# 段階 3 の外部 crate と、fleet の protocol の型の書き方

- 状態: 採用
- 決めた日: 2026-11-09
- Issue: #244

## 状況

ADR `0242-phase-3-split` は、段階 3 の外部 crate を 1 つの Issue(この #244)でまとめて足すと決め、その一覧(tokio、tokio-util、axum、ureq(`default-features = false`)、rustix、jiff、dev-dependency の tower と http-body-util)を挙げた。`rust/Cargo.lock` と crate の manifest は、この Issue のあとは別の Issue を開かないと書けない。そのため、段階 3 のあとの Issue が使う feature を、この Issue で crate ごとに決める必要があった。計画の「守ること」は、追加する crate のライセンス、保守の状況、`build.rs` が実行することを読んでから入れ、ADR に書くと決めている。

あわせて、protocol に `shared/fleet.ts` と `shared/plan.ts` の型を置くにあたり、次のことを決める必要があった。

- TypeScript の「項目がない」と「null」の区別を、fleet の型でどう書くか
- fleet CLI が `/api/fleet` の応答を読む型。fleet CLI の corpus(`fixtures/fleet-cli/`、87 件)の応答は stub のもので、`AgentRun` が必須とする `herdrName`、`cwd`、`depth` などを持たない。`fixtures/fleet-cli/threads.json` の `"checks": "passing"` は `PullRequest` の `checks` の 4 つの値にない
- JavaScript の number を Rust のどの数の型で持つか
- `wait` の時間切れの応答 `{ error, run }`(`server/fleet/api.ts:300`)を、protocol のエラーの本文の型でどう書くか

CLI が読む型は protocol の公開の口(crate の interface)なので、architect(fleet の run 9520dd90、読むだけ)に聞き、その答えに従った。

## 決定

### 外部 crate と、crate ごとの feature

`rust/Cargo.toml` の `[workspace.dependencies]` は、段階 3 の外部 crate のうち 6 つについて版だけを決め、feature を有効にしない(axum、rustix、tokio-util、tower、ureq は `default-features = false`、tokio は既定の feature がない)。各 crate が、自分の使う feature を自分の manifest に書く。例外は 2 つある。jiff は既定の feature を workspace の指定で有効にする(cli だけが使い、既定の feature をすべて使うため)。indexmap は protocol だけが使う feature `serde` を workspace に書く(serde_json もこの crate を使うので、feature を合わせる場所を 1 つにした)。cargo は workspace の中で同じ crate の feature を合わせるので、build の結果は 1 か所に書いた場合と同じになる。crate ごとに書くのは、どの crate が何のために使うかを manifest で読めるようにするため。

| 外部 crate | 使う crate | feature | 使い道 |
|---|---|---|---|
| tokio | herdr | `io-util`、`macros`、`net`、`rt`、`sync`、`time` | herdr の socket(Unix のソケットと Windows の named pipe は `net`)、購読と collector の timer、`select!` |
| tokio | child-process | `io-util`、`macros`、`process`、`rt`、`sync`、`time`。dev は `rt-multi-thread` | `tokio::process`、時間の上限、同時に動かす数の `Semaphore`、標準入出力の行の読み書き |
| tokio | orchestrator | `macros`、`net`、`rt`、`sync`、`time`。dev は `rt-multi-thread`、`test-util` | `tokio::spawn`、`tokio::sync::Mutex`(`KeyedSerial`)、`tokio::time`。`net` は CC(#274)の `TcpListener`。`test-util` は `#[tokio::test(start_paused = true)]` |
| tokio | core | `macros`、`net`、`rt-multi-thread`、`signal`、`sync`、`time` | `#[tokio::main]`、`axum::serve` の `TcpListener`、終了のシグナル |
| tokio-util | child-process、orchestrator、core | なし | `CancellationToken`(feature なしで使える) |
| axum | orchestrator | `json`、`query`。dev は `http1`、`tokio` | `/api/fleet` の router、`Json` と `Query`。dev の 2 つは CC が本物の TCP で `axum::serve` を動かすため |
| axum | core | `http1`、`json`、`query`、`tokio` | `axum::serve` で待ち受け、router を mount する |
| ureq | cli | なし(`default-features = false`) | `http://127.0.0.1:<port>` への平文の HTTP。既定の `rustls` と `gzip` は使わない。JSON は cli が serde_json で読み書きするので、ureq の `json` も使わない |
| rustix | child-process(`cfg(unix)` だけ) | `process`、`std` | `kill_process` で SIGTERM を送る。Windows は tokio の `start_kill`(ADR `0242-phase-3-split` の「子プロセス」) |
| jiff | cli | 既定(`std`、`tz-system`、`tz-fat`、`tzdb-bundle-platform`、`tzdb-zoneinfo`、`tzdb-concatenated`、`perf-inline`) | `run` に渡された `TZ` の名前から地域の時刻を作る。名前を引くのに tz データベースが要り、Windows では同梱のもの(`tzdb-bundle-platform`)を使う。`tz-fat` は地域の時刻の切り替わりのデータを多く持ち、検索を速くする(読み込むときのメモリーは増えうる)。CLI が 1 回の実行で引く地域は 1 つなので、既定のまま有効にした。`tz-system` は有効だが、ADR `0242-phase-3-split` のとおり CLI は `TimeZone::system()` を呼ばない |
| tower | orchestrator(dev) | `util` | テストが `ServiceExt::oneshot` で router を直接呼ぶ |
| http-body-util | orchestrator(dev) | なし | テストが `BodyExt::collect` で応答の本文を読む |
| indexmap | protocol | `serde` | `FleetSettingsPatch` の `roles`・`projects` と、`PlanAnswer` の `choices` の map を、JSON のオブジェクトに書かれた順のまま持つ(下の「map の順」) |

workspace にすでにある crate(段階 2 で入れたもの)を、段階 3 の crate に次のとおり足した。新しい外部 crate ではない。

- serde と serde_json: herdr-api(生成する型)、herdr(socket の JSON)、orchestrator、core、cli
- regex: orchestrator(`server/fleet/adapters.ts` の `stripVTControlCharacters` ほかの正規表現)
- sha2: orchestrator(`server/fleet/agents.ts:75` の役割のファイルの sha256)

一覧から外したものはない。一覧にない crate として indexmap を足した。理由は下の「map の順」に書いた。indexmap は serde_json の `preserve_order` がすでに使っており(`Cargo.lock` の package は増えない)、足したのは protocol の直接の依存と、indexmap の feature `serde` だけである。次のものは足さないと決めた。

- 乱数の crate(getrandom など): run の id(`server/fleet/registry.ts` の `randomBytes(4)`)は、std の `std::hash::RandomState`(プロセスごとに OS の乱数で鍵を作る)で値を作れる。std の `std::random` は rustc 1.99.1 では不安定の機能(`E0658`)で使えない。どう作るかは #249(L5)が決める
- 16 進の crate: `format!("{:08x}")` で足りる
- 引数の解析の crate(clap など): `bin/fleet.ts` は `node:util` の `parseArgs` を使い、corpus はそのエラーの文を比べるので、CLI は同じ文を自分で書く(#251)

workspace の中の依存は ADR `0107-crate-split` の表のまま変えない(herdr → herdr-api、orchestrator → protocol・screen・herdr・child-process、core → 7 つ、cli → protocol)。ADR `0242-phase-3-split` の CC のため、`[workspace.dependencies]` に `cli` を足し、orchestrator の `[dev-dependencies]` に `cli` を足し、cli に lib の target(`src/lib.rs`)を足した。cli は dev-dependency を含めて orchestrator に依存しないので、循環はない。

あとの Issue で feature や crate が足りないと分かったら、段階 2 と同じく、足す Issue を別に開いて待つ(ADR `0242-phase-3-split` の「Issue の分け方」)。

### 「項目がない」と「null」

決まりは ADR `0193-protocol-types` のままで、それを `rust/crates/protocol/src/absent.rs` の 1 か所に書いた(段階 2 の `conversation.rs` にあった関数 `present` もここに移した)。fleet の型も同じ決まりで書く。

- TypeScript の `field?: T` は `Option<T>` に `#[serde(default, skip_serializing_if = "Option::is_none")]` を付ける。`None` のときは項目を書かない
- TypeScript の `field: T | null` は `Option<T>` に `#[serde(deserialize_with = "Option::deserialize")]` を付ける。項目は必須で、`None` は `null` と書く
- TypeScript の `field?: T | null` は `Option<Option<T>>` に、上の 2 つと `deserialize_with = "present"` を付ける。fleet の型では `FleetSettingsPatch` の役割の `thinking`(`null` で段階を消す)がこれに当たる。役割そのものを `null` にする(役割のファイルの候補に戻す)`roles` の値は `Option<RolePatch>` にする
- `TurnOutcome`(`{ report }` か `{ report: null, problem }`)は Rust の enum にし、JSON との変換は非公開の struct を通す。`report` が `null` で `problem` がない形と、両方を持つ形は読み取りのエラーにする
- fleet CLI が読む型(次の節)は、すべての項目を `field?: T` の形にする

### fleet CLI が読む型(`protocol::fleet_cli`)

architect の答えに従い、次のとおりにした。

- protocol に公開の module `fleet_cli` を置き、`bin/fleet.ts` が応答を読む形を、`bin/fleet.ts` と同じ名前で写した(`Run`、`ThreadSummary`、`UsageEntry`、`PullRequest`、`ContractItem`、`UsageReading`、`UsageWindow`、`Cooldown`、`Role`、`Plan`、`ErrorDetail`)。root には再 export しない。root にはサーバーが書く同じ名前の型(`ThreadSummary` など)があるため
- すべての項目を任意にする。ADR `0107-crate-split` は「応答の読み方は今の CLI と同じく、項目が欠けても失敗しないようにする」と決めている。`#[serde(default)]` の `String` にすると、欠けた項目が `""` として書き戻され、往復が一致しない
- エージェントの種類と状態は `String` で持つ。TypeScript の CLI は知らない値もそのまま表示する。CLI が値で分岐する 3 つ(run の state、thread の state、contract の state)には、protocol の enum に読む `known_state()` を付ける。知らない値と欠けた値は `None` を返す
- 知らない項目を `#[serde(flatten)]` で残すことはしない。`--json` はサーバーが返した JSON をそのまま書く(`bin/fleet.ts` の `print`)。CLI は応答を `serde_json::Value` でも読み、その値を `protocol::js::stringify_pretty` で書く。flatten で残しても、serde_json は `f64` の整数を `1262401445000.0` と書き、項目の順も変わるので、`--json` には使えない。また flatten があると、rename を忘れた項目が残りの map に入って書き戻され、往復のテストが項目名の誤りを見つけられない(architect が試作で確かめた)
- 応答の包み(`RunBody`、`RunsBody`、`ThreadsBody`、`UsageBody`、`RolesBody`、`PlanBody`、`ErrorBody`、`TextBody`、`ReportBody`、`ClearedBody`)は中身の型を型の引数に持つ(既定は `fleet_cli` の型)。CLI は同じ本文を `RunBody<serde_json::Value>`(`--json` に書く値)と `RunBody`(文の表示と終了コード)の 2 通りに読める
- 本文が JSON でないとき(corpus の `server-error-text` の `bad gateway`)は、CLI が `ErrorBody::default()` を使う。TypeScript の `.catch(() => ({}))`(`bin/fleet.ts:92`)と同じ

同じ項目名を、サーバーが書く型と `fleet_cli` の型の 2 か所に書くことになる。食い違えば、`protocol/tests/fleet_cli.rs` の照合のテスト(サーバーの型で書いた JSON を `fleet_cli` の型で読み、各項目を比べる)が見つける。

### map の順

JavaScript のオブジェクトは、キーを足した順に並べる(配列の添字の形のキーだけは先に、値の順に並べる)。fleet の型のうち、キーが利用者の決める名前の map(`FleetSettingsPatch` の `roles` と `projects`、`PlanAnswer` の `choices`)は、Rust では `indexmap::IndexMap` にし、読んだ JSON の順のまま持つ。`BTreeMap` にすると名前の順に並べ替わり、settings の store が書く fleet.json と、server が保存する計画の JSON のキーの順が TypeScript と変わる(`/code-review high` の指摘)。添字の形のキーを先に並べる規則は、書くときに `protocol::js::stringify_pretty` が当てる。

### 数の型

JavaScript の number を、値の出どころで次のとおりに分けた。

- `Clock`(`Date.now()`)から作る時刻は `i64`: `AgentRun` の `startedAt`・`updatedAt`・`resolvedAt`、`LandingStep` の `at`、計画の `writtenAt`・`answeredAt`・`closedAt`
- 使用量の時刻と割合は `f64`: `UsageWindow` の `usedPercent`・`resetsAt`、`UsageReading` の `readAt`、`Cooldown` の `until`・`since`。Codex の秒に 1000 を掛けた値は小数を持ちうる。`Cooldown` の `until` は `resetsAt` から作られうる(`server/fleet/usage.ts:277`)
- 数えるものは整数: `depth`、行の番号、計画の版は `u32`。pull request の番号、差分の行の数、`ahead`・`behind` は `u64`
- `FleetSettings` の `maxUsedPercent`、`rateLimitCooldownMinutes`、`maxConcurrent` は `f64`。`server/fleet/config.ts:108` は `maxUsedPercent` の小数を通し、ほかの 2 つは切り捨てるだけで上限を置かない(`count`、`:97`)ので、fleet.json の値は `u32` を超えうる(`/code-review high` の指摘)。`FleetSettingsPatch` の 3 つの数は `f64` にする。整数でない値は、settings の store(#260)が TypeScript と同じ文(`must be a whole number from …`)で断るため
- `fleet_cli` の数はすべて `f64`(TypeScript の CLI は number として読むだけ)

serde_json は `f64` の整数を `80.0` と書き、JavaScript の `JSON.stringify` は `80` と書く。JSON の値としては同じで、Web UI と CLI の読み取りは変わらない。書いた文を比べる場面(CLI の `--json` と、数を埋め込む文)は `protocol::js` の関数で書く。

### `wait` の時間切れの本文

protocol の `ErrorBody` に、任意の `run: Option<AgentRun>` を足した。`server/fleet/api.ts:300` は `wait_timeout` の 408 で `{ error, run }` を返し、CLI はその run を表示して終了コード 124 で終わる(`bin/fleet.ts:175-176`)。項目がないと、Rust の core が 408 の本文から run を落とす。

### `protocol::js` の `JSON.stringify`

`--json` と、CLI が文に埋め込む数(`${usedPercent}%`、`PR #${number}`、`version ${version}`)は、JavaScript の書き方(`JSON.stringify(value, null, 2)` と Number::toString)で書く必要がある。この関数は transcript の非公開の module(`rust/crates/transcript/src/js_json.rs`)にしかない。ADR `0193-protocol-types` は、2 つ以上の crate が使う JavaScript の振る舞いを `protocol::js` に置くと決めている。cli(#251)は protocol の `src/` を書けないので、この Issue が `protocol::js` に `stringify_pretty` と `number_to_string` の写しを足した(`rust/crates/protocol/src/js/json.rs`)。transcript を移して写しを消すのは #275 にした。transcript のファイルは、この Issue の書くパスにないため。

### orchestrator の module

`rust/crates/orchestrator/src/lib.rs` に、ADR `0242-phase-3-split` の表の module をすべて `pub mod` で宣言した。公開にするのは、あとの Issue が自分の module の公開の口を、`lib.rs` を書かずに決められるようにするため。`clock` の `Clock`・`SystemClock` と、`error` の `FleetError` は root にも再 export した。`FleetError` は code と message の文字列を持ち、`Display` は message だけを書く(TypeScript の `error.message`)。`protocol::ErrorBody` への変換を持つ。

### 手順のうち、人に聞くところを置き換えた判断

- 版は、2026-11-09 に crates.io にあった最新の安定版にした(下の「依存」)。jiff 0.2.41 は前日の公開で、同じ保守者が 2026-11-02 から 3 つの版を出している。古い版を選ぶ根拠になる不具合の報告は見ていないので、最新の版にした。`Cargo.lock` が版を固定するので、問題が見つかれば版を下げる Issue で戻せる

## 検討した代わり

- CLI がサーバーの型(`AgentRun` など)で読む: corpus の run は必須の項目を持たず、`"checks": "passing"` のように enum にない値があるので、読めない。必須の項目に既定値を付けると、書き戻しで `"herdrName": ""` が増えて往復が一致せず、サーバーの型も弱くなる
- CLI が `serde_json::Value` だけで読む: 往復のテストが `Value` から `Value` への写しになり、何も確かめない。項目名と状態の文字列が CLI に散らばる
- `fleet_cli` の型に `#[serde(flatten)]` で知らない項目を残す: 上の節のとおり、`--json` に使えず、往復のテストが項目名の誤りを見逃す
- tokio の feature を `[workspace.dependencies]` に 1 回だけ書く(段階 2 の serde_json と同じ形): build の結果は同じだが、どの crate が何のために使うかが manifest から読めない。tokio の feature は crate ごとに目的が違う(child-process の `process`、core の `signal`)ので、crate ごとに書いた
- axum の既定の feature(`form`、`matched-path`、`original-uri`、`tower-log`、`tracing` ほか)を使う: `/api/fleet` は JSON と query だけを読み、form も tracing も使わない
- ureq の `json` feature: cli はすでに serde_json に依存しており、本文を文字列として送り、受け取れば足りる
- 乱数、16 進、引数の解析の crate: 上の「外部 crate と、crate ごとの feature」のとおり、std か自作の数行で足りる

## 依存

この Issue で足した外部 crate(版、入手元、ライセンス、保守の状況は 2026-11-09 に crates.io の API で読んだもの)。

| crate | 版 | 入手元 | ライセンス | 保守の状況 | `build.rs` |
|---|---|---|---|---|---|
| tokio | 1.54.1 | crates.io、https://github.com/tokio-rs/tokio | MIT | 2026-10-21 公開。201 版。tokio-rs の organization が保守する | なし |
| tokio-util | 0.7.20 | crates.io、https://github.com/tokio-rs/tokio | MIT | 2026-10-09 公開。39 版。tokio と同じリポジトリ | なし |
| axum | 0.8.9 | crates.io、https://github.com/tokio-rs/axum | MIT | 2026-04-14 公開。94 版。tokio-rs の organization が保守する | なし |
| ureq | 3.5.1 | crates.io、https://github.com/algesten/ureq | MIT OR Apache-2.0 | 2026-11-02 公開。118 版。2018 年から続く | なし |
| rustix | 1.1.6 | crates.io、https://github.com/bytecodealliance/rustix | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | 2026-10-27 公開。171 版。Bytecode Alliance が保守する | あり。環境変数 `RUSTC`(`RUSTC_WRAPPER` があればそれ)で rustc を起動し、標準入力で渡した短いコードが compile できるかで使える言語の機能を試し、`cargo:rustc-cfg` を出す。compile の結果は cargo の `OUT_DIR` の中の 1 つのファイル(`rustix_test_can_compile`)にだけ書く。`--cfg rustix_use_libc` などの cfg を読む。ネットワークは使わない |
| jiff | 0.2.41 | crates.io、https://github.com/BurntSushi/jiff | Unlicense OR MIT | 2026-11-08 公開。73 版。2024 年から続き、2026-10 から 2026-11 に 4 版 | なし |
| tower | 0.5.3 | crates.io、https://github.com/tower-rs/tower | MIT | 2026-01-12 公開。26 版。tower-rs の organization が保守する | なし |
| http-body-util | 0.1.5 | crates.io、https://github.com/hyperium/http-body | MIT | 2026-08-12 公開。9 版。hyperium の organization が保守する | なし |
| indexmap | 2.14.2(すでに `Cargo.lock` にあった版) | crates.io、https://github.com/indexmap-rs/indexmap | Apache-2.0 OR MIT | 2026-09-05 公開。57 版。indexmap-rs の organization が保守する | なし |

`Cargo.lock` に新しく入った package は 54 個(上の 8 個を含む)。ライセンスはすべて次のどれか: MIT、MIT OR Apache-2.0、Apache-2.0 OR MIT、Apache-2.0、Unlicense OR MIT、Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT、MIT AND BSD-3-Clause(matchit)、Apache-2.0 OR BSL-1.0(ryu)。推移的な crate の `build.rs` は次のとおり。

- httparse 1.10.1(axum が使う hyper から): 環境変数 `RUSTC` の rustc を `--version` で起動し、版から SIMD の `cargo:rustc-cfg` を出す。ネットワークとファイルの書き込みはない
- portable-atomic 1.15.0 と portable-atomic-util 0.2.8(jiff から): ポインターの大きさの atomic を持たない target(`cfg(not(target_has_atomic = "ptr"))`)でだけ依存に入る。Linux、macOS、Windows の x86_64 と aarch64 では build されない
- jiff-tzdb と jiff-tzdb-platform(jiff から): Windows と wasm でだけ依存に入り、`build.rs` はない
- 手続きマクロ: tokio-macros(syn 2.0.119 を使う)が build のときに動く。jiff-static は `cfg(any())` の依存で、build されない

## 結果

- 段階 3 の Issue は、上の表の feature で書ける。足りない feature は、足す Issue を別に開いて待つ
- fleet CLI(#251)は、応答を `protocol::fleet_cli` の型と `serde_json::Value` の 2 通りに読み、`--json` を `protocol::js::stringify_pretty` で書き、数を `protocol::js::number_to_string` で文に埋め込む。状態の分岐は `known_state()` の enum の網羅の match で書ける
- API の Issue(#269)は、エラーを `protocol::ErrorBody` で書き、`wait_timeout` の 408 では `run` を入れる。`FleetError` から `ErrorBody` への変換がある
- CC(#274)への注意(architect の答えから): `--json` で run を書く 10 件(`focus-json`、`interrupt-json`、`list-json`、`project-json`、`send-failed-json`、`spawn-json`、`thread-brief-json`、`threads-json`、`wait-replaced-json`、`wait-timeout-json`)は、本物の core の応答では件の `stdout` と一致しない。core が `AgentRun` の必須の項目(`herdrName` など)を必ず書き、CLI がそれをそのまま書くため。`usage-json` も、`UsageReading` の項目の順(`windows`、`readAt`)が件(`readAt`、`windows`)と違うので一致しない。CC がこれらの分け方を決める
- `AgentRun` は、TypeScript が必須とする項目を必須にし、種類と状態を enum で読む。TypeScript の registry は `runs.json` を検査せずに読み、`id` と `paneId` が文字列の run をすべて残す(`server/fleet/registry.ts:39-45`)。Rust の registry(#249)が `runs.json` を `Vec<AgentRun>` として一度に読むと、1 件の読み取りの失敗で全件を失う。#249 は 1 件ずつ読み、読めない run をどう扱うかを決めて PR に書く(`/code-review high` の指摘)
- #275 が終わるまで、`JSON.stringify` の写しが protocol と transcript の 2 か所にある
- `protocol/src/plan.rs` は型と `PLAN_LIMITS` だけを持つ。`parsePlan`、`numberClaims`、`planAsks`、`planOpen` は #250(L7)が足す

## 確かめたこと

PC は Linux 7.2.15(omarchy)、rustc 1.99.1、`rust/` で実行した。

- テストを先に書き、実装の前に走らせて失敗を見た
  - `cargo test --locked -p herdr-fleet-protocol --test fleet`: 10 件すべてが stub の `todo!()` で失敗した(`panicked at crates/protocol/src/fleet.rs:472:5` ほか)。`shared/fleet.test.ts` の 5 件の `it` はこのファイルの最初の 5 件で、期待値は TypeScript のテストのもの。ほかの 5 件の期待値は手で求め、bun で `shared/fleet.ts` の関数を呼んで同じ値になることを確かめた
  - `cargo test --locked -p herdr-fleet-protocol --test fleet_cli`: 項目に serde の属性を付けない素朴な型で 5 件すべてが失敗した。corpus の往復では、JSON の本文 67 個のうち 46 個が一致しなかった(例: `list-json: GET /runs: wrote {"runs":[{…,"pane_id":null,…}]}`)
  - `cargo test --locked -p herdr-fleet-protocol --test js`: `JSON.stringify` の 3 件が stub の `todo!()` で失敗した(`panicked at crates/protocol/src/js/json.rs:7:5`)
  - `cargo test --locked -p herdr-fleet-orchestrator`: `clock` と `error` の 3 件が stub の `todo!()` で失敗した
- `/code-review high` の指摘で足したテスト(`fleet_types.rs` の map の順と、`u32` を超える数)は、直す前のコードで 2 件とも失敗した(`maps_keep_the_order_the_object_lists_them_in` はキーの順の違い、`the_settings_carry_counts_past_u32` は読み取りのエラー)
- 実装のあと、`cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace`(235 件)、`cargo test --locked -p herdr-fleet-protocol` が通った
- CI の手順 `Parsing crates have no I/O dependencies`(`.github/workflows/rust.yml`)を手元で走らせ、終了コード 0 だった。screen と transcript から届く package に tokio、axum、hyper、herdr、child-process はなかった
- `PLAN_LIMITS`、`REPORT_STATES` と `LandAction::ALL` の順、`/api/fleet` のルートは、テストが TypeScript のファイル(`shared/plan.ts`、`server/fleet/api.ts`)と corpus の要求の path を読んで比べる
- std の `std::random::random` を rustc 1.99.1 で compile し、`error[E0658]: use of unstable library feature 'random'` を確かめた
