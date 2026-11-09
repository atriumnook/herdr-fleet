# metrics と `fleet report` の文の公開の口

- 状態: 採用
- 決めた日: 2026-11-09
- Issue: #259

## 状況

#259(L8)は、`server/fleet/metrics.ts` を orchestrator の `metrics` の module に移す。この module を呼ぶのは API(#269)の `/api/fleet/report` のルートで、module の公開の口は L8 が決める(ADR `0242-phase-3-split`)。#259 は main の欠陥 4 件(#176 の 8、#189 の 1、5、7)を Rust 版に写さないことを求める。そのため、次の 4 つを決める必要があった。

- 報告の時刻の書き方。metrics.ts は `toLocaleString("sv-SE").slice(0, 16)` で、サーバーの地域の時刻を `YYYY-MM-DD HH:MM` で書く。orchestrator には地域の時刻を扱う crate がなく、#259 は manifest を書けない
- 出来事の記録に終わりのない run の扱い(#176 の 8、#189 の 5)。fleet は保存した状態が変わったときだけ state の出来事を書く。そのため、registry から捨てられた run(7 日触られていない run。`registry.rs` の `STALE_RUN_MS`)や、終わりの出来事の書き込みに失敗した run は、記録の上では working のまま残り、metrics.ts はそのあとの停滞を 0 と数える。記録には、サーバーの起動や run の削除の出来事がない(`events.rs` は #249 のファイルで、#259 からは書けない)
- `gh` の一覧が上限(200 件と 500 件)に達したことの伝え方(#176 の 8)
- 出来事の記録の読み方。#249 は記録の大きさに上限を置き、古い世代を `<file>.1` に移す(`rotated_path`)

architect(fleet の run `035296bf`)に問い、その答えに従った。

## 決定

公開する関数は 3 つ: `read_events(file)`、`metrics(&MetricsInput) -> FactoryMetrics`、`render(project, base, &FactoryMetrics, &jiff::tz::TimeZone) -> String`。

### 時刻

- `render` は、呼ぶ側が渡す `jiff::tz::TimeZone` の時刻で書く。書式は `%Y-%m-%d %H:%M` で、秒は切り捨てる(metrics.ts と同じ)。API(#269)は、Bun と同じくサーバーの地域(`TimeZone::system()`)を渡す。metrics.rs は `TimeZone::system()` を呼ばない
- jiff は #288(PR #299)で orchestrator の依存に入る。#259 の PR は #299 のマージを待つ
- GitHub の時刻(`mergedAt`、`createdAt`、`closedAt`)は `jiff::Timestamp` で読む。読めない文字列の項目は、どの時間帯にも入らない(metrics.ts では `Date.parse` が `NaN` を返す場合に当たる)

### 記録に終わりのない run

- `MetricsInput` は `current: &HashMap<String, AgentState>` を持つ。中身は、fleet が `to` の時点で持つ run の id と状態で、API が registry から集めて渡す
- `to` までの state の出来事で working か starting で終わる run のうち、`current` にない run と、`current` の状態が working でも starting でもない run は、最後の state の出来事の時刻に止まったとみなす。停滞の計算は、その出来事を動いていない状態として再生する
- 止まったとみなした run の数を `FactoryMetrics::unended` に持つ。`render` は、その数が 1 以上のときだけ「Without the person」の節に 1 行書く。0 のときの報告は metrics.ts と同じ文になる
- 何を「動いている」と数えるか(working と starting)は metrics.rs だけが決める。そのために、run の id の集合ではなく、id と状態の map を受け取る

### `gh` の上限

- `MetricsInput` は `&Listing<MergedPullRequest>` と `&Listing<IssueSummary>` を受け取る(`github.rs`。#255)。`FactoryMetrics` は 2 つの `limit_reached` を持つ
- `render` は「Output」の節で、上限に達した一覧ごとに 1 行書く。件数は `github.rs` の定数(`MERGED_PULL_REQUESTS_LIMIT`、`ISSUES_LIMIT`)から取る。上限に達していなければ何も書かない

### 出来事の記録の読み方

- `read_events` は、`rotated_path(file)` を先に、次に `file` を読む。片方がなくても、ある方を読む(#259 への atriumnook のコメント、2026-11-09T04:07)
- 2 つのファイルを読む間に記録が `<file>.1` に移ると、移った世代を読み落とす。そのため、`<file>.1` の大きさと更新時刻が読む前と後で違えば、3 回まで読み直す(`/code-review high` の指摘)
- バイト列を `\n` で分け、行ごとに `serde_json::from_slice` で読む。読めない行と空白だけの行は飛ばす。UTF-8 でないバイトがある行は、その行だけが読めなくなる
- 古い記録にある `anomaly` の行は `TimedEvent` に読めないので飛ばす。#238 で取り込んだ main は `anomaly` の出来事を書かなくなり、代わりに書く `restart` の出来事を metrics が読む(#189 の 7)。metrics.ts も `anomaly` を数えないので、数は変わらない

## 検討した代わり

- 時刻: `render` が「その時刻の UTC からの差(秒)を返す関数」を受け取り、暦の日付を手で計算する。API も差を出すのに jiff が要り、時刻の変換が 2 か所に分かれる。Howard Hinnant の暦の計算はすでに 4 か所に手書きされていて、5 か所目になる
- 時刻: UTC で書き `UTC` を添える。metrics.ts はサーバーの地域の時刻で書き、変える根拠になる Issue も仕様もない
- 時刻: manifest を変える Issue を新しく開く。#288 がすでに開いていた
- 終わりのない run: サーバーの起動の出来事を先に足し、#259 をそれまで待たせる。`events.rs`(#249)、起動時に書く処理(#270 か O1。どちらもまだない)、再起動をまたいで動き続ける run の扱いの 3 つを決める必要があり、#259 を待つ #269 も止まる
- 終わりのない run: 止まった時刻を `to` や再起動の時刻とする。その時刻まで動いていたことを示す記録がない
- `gh` の上限: 一覧の一番古い項目の日付を時間帯と比べ、欠けていないと言い切る。一覧は作られた日の新しい順なので、早く作られて時間帯の中でマージされた pull request は、上限に達すると漏れうる(#189 の 6)

## 依存

なし。jiff は #288(ADR `0288-orchestrator-jiff`)が足す。

## 結果

- API(#269)は、`read_events` の結果、`gh` の 2 つの `Listing`、registry の run の状態、サーバーの `TimeZone` を渡して報告を作る
- 直らない場合: サーバーが止まっていた間に終わった run は、再起動したサーバーがその時刻に終わりの出来事を書くまで、動いていると数えられる。herdr はサーバーが止まっている間もペインを動かすので、その時間は「動いていたか分からない時間」である。サーバーの起動の出来事と、報告でのこの時間の示し方は、#303 で決める
- metrics.ts と違う振る舞いは、上の 4 つと、#189 の 1 の 1 つ: `interactive` も `turn` の出来事もない古い出来事の run が `stopped` で終わったとき、「HANDOFF なしで終わった」と数えない(lead だったかもしれないため)。`failed` で終わった run は、これまでどおり数える
- `MetricsInput::planned` は `regex::Regex` で、ECMAScript の先読み・後読み・後方参照は使えない(ADR `0193-phase-2-dependencies`)。metrics.ts は `RegExp` を受け取る。`planned_label` を正規表現として読み、読めなければ断るのは API なので、TypeScript で有効なパターンの扱いは #269 が決める(codex のレビューの指摘)
- 役割の名前の並べ替えは、バイトの順にする。metrics.ts は `localeCompare` で並べる。役割の名前が英小文字と数字とハイフンだけなら、2 つの順は同じになる。agent の名前は英小文字だけなので、同じ順になる

## 確かめたこと

PC は Linux 7.2.15(omarchy)、`rust/` で実行した。

- `cargo test --locked -p herdr-fleet-orchestrator --test metrics`: metrics.test.ts から移した 10 件と、Rust 版の振る舞い(報告の全文、地域の時刻、metrics.ts と違う振る舞い)を確かめる 10 件の、計 20 件が通った
- metrics.test.ts の `result` の報告を、bun 1.4.4 で `TZ=Etc/GMT-1` にして metrics.ts の `render` で書き、Rust の `render` の出力(同じ出来事、地域は UTC+1 の固定)と全文が一致した
