# fleet の設定の store の公開の口

- 状態: 採用
- 決めた日: 2026-11-11
- Issue: #260

## 状況

#260(ST)は、Web UI の設定の画面が読み書きする fleet.json の store(`server/fleet/settings.ts`)を、orchestrator の `settings` の module に移す。この module を呼ぶのは API(#269)の `GET /api/fleet/settings` と `POST /api/fleet/settings`(`server/fleet/api.ts:124-131`)と、store を作る段階 4 の core(`server/index.ts:558`)で、module の公開の口は ST が決める(ADR `0242-phase-3-split`)。口は crate の interface なので、architect(fleet の run `90b293ba`、読むだけ)に草案を見せ、点ごとに残すか変えるかを聞いた。下の決定は、その答えのとおりである。

前提と制約は次のとおり。

- #260 が書けるのは `settings.rs`、`tests/settings.rs`、この ADR だけで、manifest、`lib.rs`、ほかの module は書けない
- orchestrator は環境変数もホームのフォルダーも読まない。利用者の設定のフォルダーは呼ぶ側が渡す(`config.rs` の冒頭)
- patch は protocol の型 `FleetSettingsPatch`(serde)で受け取る(ADR `0244-phase-3-dependencies`)
- ADR `0247-roles-and-config` は、fleet コマンドを使う役割を agy に載せる設定の変更を、ST が `invalid_settings` で断ると決めた(main の欠陥 #189 の 8)。ADR `0248-launch-adapters` は、その判定を `Adapter::refusal(&RoleFit)` の 1 つにまとめた(フォルダーの外を読む役割を agy に載せない #190 も含む)

## 決定

### 公開の口

```rust
pub type UsageKnown = Arc<dyn Fn(FleetAgentKind, Option<&str>, f64) -> Option<String> + Send + Sync>;

pub struct FleetSettingsDeps {
    pub agents: fleet::RoleSource,   // その folder にある役割
    pub usage: Option<UsageKnown>,   // 使用量でいま飛ばされる理由。None は何も知らない
    pub user_dir: PathBuf,           // 利用者の fleet.json のフォルダー(config::user_fleet_dir)
}

impl FleetSettingsStore {
    pub fn new(deps: FleetSettingsDeps) -> Self;
    pub fn read(&self, cwd: &Path) -> Result<FleetSettings, FleetError>;
    pub fn update(&self, cwd: &Path, patch: &FleetSettingsPatch) -> Result<FleetSettings, FleetError>;
}
```

- 使用量は関数 1 つの依存なので、`Arc<dyn Fn>` で受ける(`fleet/mod.rs` の `ConfigSource` などと同じ形)。core は `UsageTracker::known`(ADR `0254-usage-interface`)を closure で包んで渡す
- `user_dir` は必須にする。TypeScript の既定値 `userFleetDir()` は環境変数を読むため
- `read` と `update` は同期の関数にする。中身は小さなファイルの読み書きだけで、`EntranceStore`(`entrances.rs`)と同じ形である。`update` は `std::sync::Mutex<()>` を、ファイルを読み、patch を当て、書き、読み直し終えるまで持つ(TypeScript の `queue` に当たる)。poison は `PoisonError::into_inner` で無視する。`read` は lock を取らない(TypeScript の `read` も queue に入らない)
- fleet.json のパスは `FleetSettings.file` で返し、method としては公開しない(TypeScript の getter も private)
- patch を当てる関数 `apply_patch` は公開しない。TypeScript で `applyPatch` を呼ぶのは `update` だけで、テストは `update` を通す

### エラー

- エラーは `FleetError` で返す。コードは TypeScript と同じく、fleet.json が読めないか JSON の object でなければ `settings_unreadable`、使えない patch は `invalid_settings`、知らない役割は `unknown_role`
- fleet.json が書けないときは `FleetError::new("internal_error", "<パス>: <OS のエラー>")` にする。TypeScript はファイルシステムのエラーをそのまま投げ、API は `internal_error` の 500 で答える(`api.ts:304`)。同じ形は `entrances.rs` の `unwritable` にある。#269 は状態コードの表で `internal_error` を 500 にする(TypeScript の表にない `FleetError` は 400 になるため、`api.ts:301`)

### 型の検査

TypeScript が実行時に調べる型(候補の CLI が知っている名前か、`closeOnSettle` が真偽値か、thinking が知っている level か、`roles` と `projects` が object か)は、patch を `FleetSettingsPatch` に読むときに serde が調べる。#269 は、object だが `FleetSettingsPatch` として読めない `patch` を `invalid_settings` で答え、そのテストを 1 件足す。TypeScript が `invalid_body` で答えるのは、`patch` が object でないときだけである(`api.ts:128-130`)。

これで生じる TypeScript との違いを受け入れる。

- 最上位の項目と候補の `model` の `null` は、項目がないものとして読まれる(`absent.rs` の決まり)。TypeScript は `invalid_settings` で断る(`settings.ts:171`、`:175`、`:179`、`:184`、`:201`、`:224-225`)
- `roles: {"nobody": 5}` は、TypeScript では 404 の `unknown_role`、Rust では読めない patch として 400 の `invalid_settings` になる

### 読む形

fleet.json は serde_json で読む。Bun の `JSON.parse` が読み、serde_json が断る 2 つの形(f64 の範囲を超える数と、対のないサロゲートのエスケープ)は、crate のほかの読み手と同じく読めない値として扱う(ADR `0193-phase-2-dependencies` の「`JSON.stringify` と serde_json」)。そのような fleet.json は `read` も `update` も `settings_unreadable` で答え、ファイルは書き換えない。TypeScript との違いは次のとおりで、Bun 1.4.4 で TypeScript の store を動かして確かめた。

- `{"maxConcurrent":1e400}`: TypeScript は `Infinity` として読み(`read` の答えの JSON では `"maxConcurrent":null`)、ほかの項目の `update` で `"maxConcurrent": null` と書き戻す
- `{"unknown":"\ud800"}`: TypeScript は読み、`update` でも `"unknown": "\ud800"` のまま残す

TypeScript に合わせるには、`serde_json::Value` が持てない値(`Infinity` と、対のないサロゲートを含む文字列)を持ち、書くときに同じ形に戻す JSON の読み手と書き手が要る。f64 の範囲を超える数は、手で書き換えないかぎり fleet.json に入らない(TypeScript の store が書く数は、項目ごとに 1 から 100・1440・32 までの整数に限られる)。対のないサロゲートのエスケープは、手で書き換えるか、TypeScript の store にそれを含む setup や model を送ったときだけ入る。Rust の store は patch も serde_json で読むので、書くことはない。そのため写さず、使う人がファイルを直すまで設定の画面からは変えられないことを受け入れる。

### 書く形

- 書くバイト列は TypeScript と同じ `JSON.stringify(raw, null, 2)` と改行にする。`protocol::js::stringify_pretty` が数を JavaScript と同じ形で書き(`2.0` は `2`、`1e21` は `1e+21`)、整数に読める key を JavaScript と同じく前に並べる。知らない key は、ファイルにあった順のまま残す(serde_json の `preserve_order`)。key を消すときは順を保つ `shift_remove` を使う
- 一時ファイルは `<file>.<pid>.<番号>.tmp` にし、0600 で作って fleet.json の上に rename する。書けなければ一時ファイルを消す。`plan.rs` と `entrances.rs` と同じ形である。TypeScript は `<file>.<pid>.tmp` の 1 つの名前を使い回すが、同じプロセスの中で 2 つの書き込みが同じ名前を使わないよう、番号を足した(`update` は lock を持つので、この store の中では重ならない)

### 役割を CLI が引き受けられるか

- 画面の候補の `skip` と、`update` で断る判定の両方に `adapter_for(kind).refusal(&fit)` を使う。読み取りだけの役割に `read_only_args` のない CLI を選んだときの文は、TypeScript と同じ `<役割> edits no file, and <CLI> cannot be kept from editing files` のまま。ほかの理由は `<役割> cannot run on <CLI>: <理由>` にする
- `RoleFit` は settings.rs の private の関数 `role_fit` で作る。`read_only` は `edits: false`、`spawning` は `may_spawn`、`reads_outside_folders` は名前が `reviewer` であること(ADR `0248-launch-adapters` の「断る役割」)
- `read` の `skip` は cwd の project で使う設定を示すため、利用者と project の fleet.json を合わせた `spawning` を使う。`update` は利用者の fleet.json を全 project に対して変更するため、利用者の設定だけで拒否を決める
- ADR `0247-roles-and-config` は、`role_fit` を O1 が置くと決めたが、O1 は置かずにマージされた。#263(O2)と同じ規則を 2 か所に書かないよう、`AgentDefinition::role_fit` を agents.rs に置いて ST と O2 が使う Issue を #329 で開いた。#260 はそれを待たない

### 役割の並び

`ROLE_FLOW` の順のあとの役割は、TypeScript の `a.name.localeCompare(b.name)` の順に並べる。Bun 1.4.4 の en-US の並びを `locale_compare` に写した。写したのは ASCII の文字の並びだけで、ASCII でない文字は英字のあとに code point の順で並べる。そのため、ASCII でない文字を含む名前の役割は TypeScript と違う順になる(Bun 1.4.4 で `zeta, éclair, eclair, Ångström, alpha` は `alpha, Ångström, eclair, éclair, zeta`、Rust は `alpha, eclair, zeta, Ångström, éclair`)。locale の照合を写すには照合の crate(icu4x の `icu_collator` など)が要り、manifest を書けない #260 では足せない。

同じ規則が `usage/tracker.rs` にもある。#260 は `tracker.rs` を書けないので写し、1 つにまとめる Issue を #330 で開いた。ASCII でない文字の並びも #330 で扱う。Bun の並びを期待値にしたテスト `lists_role_names_past_ascii_as_locale_compare_does` を `#[ignore]` で置いた。

## 検討した代わり

- エラーを `SettingsError { Fleet(FleetError), Io(io::Error) }` にする: API は `FleetError` と同じ形の本文を作るだけで、型を分けても呼ぶ側の扱いは変わらない。`entrances.rs` は書けないときも `FleetError` の `internal_error` で返している
- エラーを `fleet::OrchestratorError` にする: 設定の store が orchestrator の module に依存し、run を持たない store に `WaitTimeout` などの variant が見える
- `update` を async にして tokio の `Mutex` を使う: await の間に待つものがなく、同期の `EntranceStore` と形がそろわない
- 使用量を trait(`known` の 1 つの method)で受ける: 関数 1 つの依存は closure で受けるのが、この crate の形である
- `role_fit` を agents.rs に置く Issue を先に開き、#260 を待たせる: #260 を待つ #269 も止まる。private の関数は、#329 で agents.rs の関数に替えられる
- agy の判定を入れず、TypeScript と同じく読み取りだけの判定にとどめる: ADR `0247-roles-and-config` が ST に課した判定で、入れないと設定の画面から lead を agy に載せられる(#189 の 8)

## 依存

なし。

## 結果

- #269 は `read` と `update` を呼び、`FleetError` を状態コードの表で答える。読めない patch は `invalid_settings` にする
- 段階 4 の core は、`UsageTracker::known` を包んだ `UsageKnown` と、`config::user_fleet_dir` のフォルダーを渡して store を作る
- 設定の画面から、fleet コマンドを使う役割(`spawning`)とレビュアーを agy に載せる変更は `invalid_settings` で断られ、すでに fleet.json で載せている候補には `skip` の理由が出る。TypeScript は受け付けていた
- #329 と #330 は、`settings.rs` の private の関数を共通の関数に替える

## 確かめたこと

- Arch Linux(Linux 7.2)、Rust 1.99.1、Bun 1.4.4
- `cargo test --locked -p herdr-fleet-orchestrator --test settings`: 17 件が通り、1 件(ASCII でない名前の並び、#330)は `#[ignore]`。`settings.test.ts` の 9 件の `it` と、TypeScript が書いたバイト列との比較、TypeScript が書いたファイルの読み取り、0600 と一時ファイルが残らないこと、agy の判定、project の `spawning` を反映した `skip`、書けないときの `internal_error`、serde_json が断る fleet.json を書き換えないこと
- TypeScript の書くバイト列と読む値は、TypeScript の `FleetSettingsStore` を Bun で動かして取った(`HERDR_*` を外して実行。テストのコメントに手順を書いた)
- 並びの期待値は `bun -e` の `localeCompare` で取った(`LANG=en_US.UTF-8`)
