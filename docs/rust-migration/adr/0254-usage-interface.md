# orchestrator の usage の公開の口: UsageTracker、クールダウン、CLI ごとの probe

- 状態: 採用
- 決めた日: 2026-11-09
- Issue: #254

## 状況

#254(L3)は `server/fleet/usage.ts` を `rust/crates/orchestrator/src/usage/` に移す。あとの Issue が、この module の公開の口を使う。

- O2(#263): O1 の trait `UsageGate` を `UsageTracker` に実装する(ADR `0242-phase-3-split` の 174 行目)。使うのは `unavailable`、`known`、`note_failure`、`claim_screen`、`record`
- API(#269): `list`、`refresh`、`clear_cooldown`(`server/fleet/api.ts:111-121`)
- ST(#260): `known` だけ(`server/fleet/settings.ts:35`)
- 段階 4 の core: tracker を作り、`default_probes` を渡す(`server/index.ts:519-522`)

口は crate の interface なので、決まり(`.herdr-fleet/standing.md` と lead の規則 2)により、architect に聞いてから決めた。architect(fleet の run `04110847`、読むだけ)には、`todo!()` の stub の草案とテストを見せ、決定ごとに残すか変えるかを聞いた。下の決定は、その答えのとおりである。

前提と制約は次のとおり。

- 記録に載る時刻は `Clock`(`rust/crates/orchestrator/src/clock.rs`、ミリ秒の `i64`)から読み、待ち時間は `tokio::time` で表す(ADR `0242-phase-3-split` の「非同期と時刻」)
- probe の子プロセスは child-process の `Runner` で動かす。時間の上限を過ぎたら SIGTERM、2 秒後に SIGKILL を送り、標準出力は 8 MiB までにする(ADR `0242-phase-3-split` の「子プロセス」、ADR `0246-child-process-interface`)
- `unsafe_code = "forbid"` なので、テストはプロセスの環境変数(`TZ` も)を変えられない
- protocol の `UsageEntry`、`UsageReading`、`UsageWindow`、`Cooldown` は時刻を `f64` で持つ(ADR `0244-phase-3-dependencies`)

## 決定

### module の分け方

`usage/` に次のファイルを置く。probe の argv と、その出力の parser は同じファイルに置く(ADR `0107-crate-split`)。

- `codex.rs`(`codex app-server` の JSON-RPC と `parse_codex_rate_limits`)、`agy.rs`(`agy -p /usage` と `parse_agy_usage`)、`claude.rs`(`claude -p /usage` と `parse_claude_usage`)
- `cooldown.rs`: `rate_limit_until`
- `probe.rs`: probe の型、`ProbeOptions`、`default_probes`、子プロセスを動かす共通の関数
- `tracker.rs`: `UsageTracker` と定数
- `js_time.rs`(private): JavaScript の `Date.UTC`、`Date.parse`(ISO の形だけ)、`toISOString`、`Math.round` の写しと、`zonedTime`(`usage.ts:75`)の写し

### 公開の口

```rust
pub fn usage_key(kind: FleetAgentKind, model: Option<&str>) -> String;
pub fn parse_codex_rate_limits(result: &Value, now: i64) -> Option<UsageReading>;
pub fn parse_agy_usage(output: &Value, now: i64, time_zone: &TimeZone) -> Readings;
pub fn parse_claude_usage(text: &str, now: i64) -> Option<UsageReading>;
pub enum RateLimit { NotOne, Until(Option<f64>) }
pub fn rate_limit_until(message: &str, now: i64, time_zone: &TimeZone) -> RateLimit;

pub type Readings = BTreeMap<String, UsageReading>;
pub type ProbeFuture = Pin<Box<dyn Future<Output = Result<Readings, String>> + Send>>;
pub type UsageProbe = Arc<dyn Fn() -> ProbeFuture + Send + Sync>;
pub struct ProbeOptions { pub work_dir: PathBuf, pub command: Option<OsString>, pub env: Env,
                          pub clock: Arc<dyn Clock>, pub time_zone: TimeZone }
impl ProbeOptions { pub fn new(work_dir: impl Into<PathBuf>, env: Env, clock: Arc<dyn Clock>) -> Self }
pub fn codex_probe(options: ProbeOptions) -> UsageProbe;   // agy_probe、claude_probe も同じ形
pub fn default_probes(state_dir: &Path, env: &Env, clock: Arc<dyn Clock>) -> HashMap<FleetAgentKind, UsageProbe>;
pub const CODEX_TIMEOUT: Duration;  // 15 秒。AGY_TIMEOUT と CLAUDE_TIMEOUT は 30 秒

pub const PROBE_TTL: Duration;       // 60 秒
pub const AUTO_REFRESH: Duration;    // 5 分
pub const BACKOFF_CAP: Duration;     // 1 時間
pub const PROBE_TIMEOUT: Duration;   // 35 秒
pub const SCREEN_TTL: Duration;      // 10 分
pub const UNDATED_WINDOW: Duration;  // 24 時間
pub struct UsageTrackerOptions { pub file: Option<PathBuf>, pub probes: HashMap<FleetAgentKind, UsageProbe>,
                                 pub probe_ttl: Duration, pub probe_timeout: Duration,
                                 pub clock: Arc<dyn Clock>, pub time_zone: TimeZone }
impl UsageTrackerOptions { pub fn new(file: Option<PathBuf>, clock: Arc<dyn Clock>) -> Self }
#[derive(Clone)] pub struct UsageTracker;
impl UsageTracker {
    pub fn new(options: UsageTrackerOptions) -> Self;
    pub fn list(&self) -> Vec<UsageEntry>;
    pub async fn refresh(&self, force: bool, max_age: Option<Duration>);
    pub async fn unavailable(&self, kind: FleetAgentKind, model: Option<&str>, max_used_percent: f64) -> Option<String>;
    pub fn known(&self, kind: FleetAgentKind, model: Option<&str>, max_used_percent: f64) -> Option<String>;
    pub fn note_failure(&self, kind: FleetAgentKind, model: Option<&str>, message: &str, default_minutes: f64) -> bool;
    pub fn claim_screen(&self, kind: FleetAgentKind, model: Option<&str>) -> bool;
    pub fn record(&self, kind: FleetAgentKind, model: Option<&str>, reading: UsageReading);
    pub fn clear_cooldown(&self, target: Option<&str>) -> Vec<String>;
}
```

- `UsageTracker` は `Arc` で状態を共有する handle で、clone は同じ状態を指す(ADR `0242-phase-3-split` の `Orchestrator` と同じ形)。状態は `std::sync::Mutex` に置き、lock を await の間に持たない
- probe は tracker が `tokio::spawn` した task で動く。呼んだ側の future が落とされても(axum は接続が切れると handler の future を落とす)、probe は終わりまで動いて記録される。TypeScript の promise と同じ振る舞いである。同じ CLI の probe が動いている間に来た呼び出しは、`force` でも新しい probe を起動せず、その終わりを待つ(`tokio::sync::watch`)
- probe の closure も、probe の task の中で呼ぶ。closure が future を返す前に panic しても、その CLI の probe は失敗として記録され、次の呼び出しでまた動く。動いている印(`in_flight`)は drop guard が消す
- probe の型は closure にする。テストと O2・API のテストは本物の tracker に偽の probe を渡す(`api.test.ts:43`、`orchestrator.test.ts:549`)ので、偽物を 1 行で書けるほうがよい。エラーは、tracker が `UsageEntry.error` に入れる文字列
- 各 probe は自分の `Runner::new(1)` を持つ。tracker は 1 つの CLI に同時に 1 つの probe しか動かさないので、1 で足りる。`Runner` は公開の口に出さない(ADR `0246-child-process-interface` の「使い道ごとに 1 つの Runner」。child-process の `OpencodeCli` も Runner を自分で作る)
- 公開の純粋な関数の `now` は、`Clock::now_ms()` と同じ `i64` で受ける(screen の `cursor_usage` と同じ)。返す値と保存する値の時刻は protocol の型のとおり `f64`
- 地域の時刻: 純粋な関数(`rate_limit_until`、`parse_agy_usage`)は `&TimeZone` を受ける。tracker と probe は `time_zone` の項目を持ち、`new` が `TimeZone::system()`(`TZ`、なければ `/etc/localtime`。Bun がローカルの地域を決めるときに読むものと同じ)を入れる。core はどちらの地域も設定しない。片方だけ変えると、tracker と probe の地域が食い違うため。手で求めた期待値のテストは固定の地域を渡す。`usage.test.ts` から移した `takes an ISO time, a relative one or the next clock time` だけは、TypeScript のテストと同じくプロセスの地域で動かし、同じ assert(地域の時刻で 15:45、24 時間以内)をする。ADR `0242-phase-3-split` の「CLI は `TimeZone::system()` を呼ばない」は、CLI の `run` が渡された `env` だけで動くための決まりで、core のプロセスには当たらない
- `record` は `(kind, model)` で受け、鍵は `usage_key` で作る。ほかのメソッドと同じ受け方で、鍵の作り方を知るのは usage の module だけになる(orchestrator が `usageKey` を使うのは `orchestrator.ts:1618` の 1 か所で、そのまま `record` に渡す)
- 保存の形: `JSON` の配列を、`registry::write_whole`(`<file>.<pid>.tmp` に 0600 で書いて rename、なければフォルダーを 0700 で作る)で書く。書けなければ標準エラーに知らせ、記録は失わない(`usage.ts:383-396`)

### TypeScript との違い

ADR `0242-phase-3-split` が決めた違い:

- probe の子プロセスは、時間の上限で SIGTERM のあと SIGKILL を受け、標準出力は 8 MiB まで読む。TypeScript は SIGTERM を 1 回送るだけで、出力を限りなく読む。SIGTERM を無視する CLI がいると、子プロセスと読み取りが残る(`server/opencode-cli.ts:119-122` の注記)。時間の上限の値は TypeScript のまま(codex 15 秒、agy と claude 30 秒)。tracker は自分の時間の上限(35 秒)を持つので、tracker の振る舞いは変わらない

この Issue で受け入れた違い(どれも、保存と表示の形だけで、振り分けの判断は変わらない):

- 保存のファイルは、整数の値の `f64` を `1791103555000.0` と書く(TypeScript は `1791103555000`)。TypeScript の `JSON.parse` も Rust も両方を読む。ファイルは fleet だけが読む私用の状態で、バイト列を比べる契約はない。API(#269)の JSON も同じなので、#269 のテストは本文を JSON の値として比べる
- ファイルの中の entry の順: probe の答えを `BTreeMap` で受けるので、一度に新しく知った鍵(`agy:gemini` と `agy:3p`)は鍵の順に足す。TypeScript は probe が返した順に足す。`list()` は並べ直すので、ファイルの順を読むコードはない
- `list()` の順は、Bun 1.4.4 の `localeCompare`(en-US)と同じ順を ASCII の鍵について作る(空白、記号、数字、文字の順に重みを比べ、最後に小文字を先にする)。ASCII の外の文字(`é` など)は文字のあとに code point の順で並べる。ロケールは `é` を `e` の隣に置くので、そこだけ違う。鍵の provider の部分は利用者のモデル名(`pi` と `opencode` の `<provider>/<model>`)から来るので、ASCII の外の文字を含む provider の名前を利用者が書いたときに、この違いが一覧の順に出る
- 失敗の文: 子プロセスが時間の上限を過ぎたときは `<CLI> did not answer within <秒>s`、シグナルで終わったときは `<CLI> was ended by a signal`、起動できなかったときは child-process の文(`could not start: …`)、答えが JSON でないときは `<CLI>: the answer is not JSON: …` にする。TypeScript は、kill のあとの終了コードで `exited with …` を書くか、Bun と JSON の例外の文をそのまま書く。この文は `UsageEntry.error` に入って画面に出るだけで、判断には使わない
- `Date.parse` は ISO の形(日付だけ、日付と時刻、`Z` か `+09:00` か `+0900` の時差)だけを読む。エンジンによっては `Oct 4 2026` のような形も読むが、usage が読む CLI はその形を書かない
- 正規表現: JavaScript の `\d` を `[0-9]`、`\b` を ASCII の語の境界 `(?-u:\b)`、`.` を行の区切り(`\n`、`\r`、U+2028、U+2029)以外の文字、`\s` を JavaScript の空白と行の区切りの文字の集合にして、`u` の flag のない JavaScript と同じに読む(`/code-review high` の指摘)。1 回だけの `.?` は UTF-16 の 1 単位なので、U+FFFF より後ろの文字(2 単位)を除く(PR #295 の codex のレビューの指摘。Bun 1.4.4 で `RATE_LIMITED.test("rate😀limit")` は false)。時計の時刻の `\s` も同じ集合にした(同じレビューの指摘)。大文字小文字を同一視する規則だけは Rust の regex の Unicode の規則のままで、JavaScript と違うのは、ASCII に折りたたまれる ASCII の外の文字(`ſ`、ケルビンの記号)だけである
- `toISOString` は `Date` が持てる範囲(±8.64e15 ミリ秒)の外の時刻で例外を投げる。Rust は `String(new Date(t))` と同じ `Invalid Date` を書く(`retry in 100000000000000000000 days` のような文で起きる。`/code-review high` の指摘)

## 検討した代わり

- `Runner` を `ProbeOptions` と `default_probes` で受ける(草案): core が `Runner::new(3)` と書くと、3 は `default_probes` が持つ probe の数で、probe を足すときに core も直す必要がある。probe が自分で作れば、Runner は口から消える。代わりに、時間切れの `Session` の子が回収されるまで、同じ CLI の次の probe は起動を待つ(長くて `KILL_GRACE` の 2 倍)
- probe を trait にする: 偽物ごとに型が 1 つ要る。TypeScript の `UsageProbe` も関数の型である
- `rate_limit_until` が中で `TimeZone::system()` を読む: 手で求めた期待値のテスト(Asia/Tokyo の `3:45 PM`、America/New_York で夏時間が始まる夜の `2:30 am`)を書けない。テストはプロセスの `TZ` を変えられない
- `rate_limit_until` の返り値を `Option<Option<f64>>` にする: `None` と `Some(None)` のどちらが「レート制限ではない」かを型が示さない
- 公開の関数の `now` を `f64` にする(草案): `Clock` は `i64` を返し、screen の `cursor_usage` も `i64` で受ける。同じ役の引数の型が crate ごとに違うことになる
- `record` を鍵の文字列で受ける(TypeScript の形): O2 が `usage_key` を呼んでから渡すことになり、鍵の作り方を知る場所が 2 つになる
- TZif のファイルを自分で読む: workspace にすでに jiff がある(ADR `0244-phase-3-dependencies`)。orchestrator の manifest に jiff を足すのは #288 が行う

## 依存

この Issue では追加しない。jiff 0.2.41 は workspace にあり、orchestrator の依存に足すのは #288 である。#254 は #288 のマージを待つ。

child-process の `Session` の future が `Send` でないと、probe を `tokio::spawn` の task で動かせない(`runner.rs:708` の `ended` が `watch::Ref` を await の間に持つ)。直すのは #293 で、#254 は #293 のマージも待つ。

## 結果

- O2 は `UsageGate` を `UsageTracker` に実装でき、`unavailable` と `refresh` の future は `Send` である(`tests/usage.rs` の `the_futures_callers_box_are_send` がコンパイルで確かめる)
- API は `list`、`refresh(force, max_age)`、`clear_cooldown(target)` をそのまま呼べる。`clear_cooldown(Some(""))` は TypeScript の `""` と同じく、すべてを解く
- core は `UsageTrackerOptions::new(Some(state_dir.join("fleet-usage.json")), clock)` の `probes` に `default_probes(&state_dir, &env, clock)` を入れて作る。`UsageTracker::new` は task を起動しないので、tokio の runtime の外でも作れる。`refresh` と `unavailable` は runtime の中で呼ぶ
- ST が `known` を受ける trait を O1 の `UsageGate` と共有するかは、#256 と #260 が決める
- CLI の種類の名前は、`launch` と同じく `FleetAgentKind` の serde の名前から取る(`usage/mod.rs` の `kind_name`)。名前の表は protocol の enum の 1 つだけで、取り出す関数が `launch/mod.rs` と `usage/mod.rs` に 1 つずつある。protocol に `FleetAgentKind::as_str` を置いて 1 つにする作業は、この Issue の書くパスの外にある

## 確かめたこと

PC は Linux 7.2.15(omarchy)、rustc 1.99.1、Bun 1.4.4。`rust/` で実行した。#288 と #293 のマージの前なので、作業ツリーにだけ orchestrator の manifest の jiff と child-process の `ended` の直しを当てて(コミットしない)確かめた。

- テストを先に書き、`todo!()` の stub で `cargo test -p herdr-fleet-orchestrator --test usage --no-fail-fast` を走らせ、44 件すべてが stub の panic で失敗した(`panicked at crates/orchestrator/src/usage/tracker.rs:33:9` ほか)
- architect が見つけた欠陥(closure が future を返す前に panic すると、その CLI の probe が二度と動かない)は、直す前に `a_probe_that_panics_before_its_future_is_asked_again` が `panicked at crates/orchestrator/tests/usage.rs:201:28`(`no entry codex`)で失敗した
- 一覧の順は、Bun 1.4.4 で `[...keys].sort((a, b) => a.localeCompare(b))` を走らせた出力を期待値にした。小文字にして比べるだけの最初の実装では、`lists_the_accounts_in_the_order_of_locale_compare` が失敗した
- `/code-review high` の指摘(範囲外の時刻、`.` と `\s`)は、直す前に `writes_a_time_past_what_a_date_holds_as_invalid_date` と `reads_dots_and_spaces_as_javascript_does` が失敗した(`left: Until(None)` / `right: NotOne`、`+292278994-08-17T07:12:55.807Z`)
- codex のレビューの指摘(`.?` と U+FFFF より後ろの文字、時計の時刻の `\s`)は、直す前に `reads_code_units_and_the_clocks_spaces_as_javascript_does` が `usage.rs:942` で失敗した(`left: Until(None)` / `right: NotOne`)。期待値は Bun 1.4.4 の答えと、手で求めた時刻
- 実装のあと、`cargo test --locked -p herdr-fleet-orchestrator --test usage` の 48 件と、`cargo test --locked --workspace` の全件が通った。`cargo fmt --check` と `cargo clippy --locked --workspace --all-targets -- -D warnings` も通った
