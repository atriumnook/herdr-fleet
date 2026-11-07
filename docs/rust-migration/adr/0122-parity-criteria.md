# 段階 1 の基準を 3 つの形で作り、HTTP/WS の契約のサーバーを起動の指定で起動する

- 状態: 採用
- 決めた日: 2026-11-08
- Issue: #122

## 状況

計画(`docs/rust-migration/plan.md`)の段階 1 は、一致を確かめる基準のうち 4 つ(会話ログの corpus、fleet CLI の契約、HTTP/WS の契約、安全上の判定の表)を作り、TypeScript 版で通す。HTTP/WS の契約は、サーバーの起動の仕方(TypeScript か Rust か)を引数で選べるようにする。`docs/rust-migration/parity.md` には、TypeScript の全テストファイル(この ADR では、テストと回帰検査の script と読む。範囲は下の「parity.md」)と引き継ぎ先の欄を置く。段階 2〜4 では、ADR `0107-crate-split` の Rust の crate が同じ基準を通す。

段階 1 の作業を Issue に分ける前に、4 つの基準をどの形で作るかを決める必要があった。基準の形は、Rust の crate がテストのために公開する関数と起動の仕方(transcript の crate の呼び出し、core のテスト用の起動の仕方)を決めるので、あとから変えにくい。

今のテストの状態(2026-11-08 の `rust`、コミット `e95cb1f`。調べ方は「確かめたこと」):

- 正解のデータを持つ corpus は、画面の corpus(`fixtures/screens/`、`scripts/screen-fixtures.ts`)だけ。transcript の解析のテストは、入力をテストの中の文字列か一時ファイルで作り、期待値もテストの中に書いている。リポジトリに transcript のファイルはない
- HTTP/WS の契約のテストは `server/*.contract.test.ts` の 15 ファイル(約 170 件の `it`、5,391 行)。どれも `createServer` をテストと同じプロセスで呼び、テスト用のオプション(`pushEndpoint` の関数、待ち時間、`tailscaleOwner` など)を引数で渡し、`HOME`、`TMPDIR`、`PI_CODING_AGENT_DIR` などの環境変数をテストのプロセスで書き換えている。サーバーの内部(`SUBMIT_DELAY_MS`、`OUTPUT_*` の定数、`forgetTranscriptState`、`DeviceStore`)も import している
- fleet CLI のテストは `bin/fleet.test.ts` の 3 件で、stub のサーバーに送られた要求を比べる
- 安全上の判定は、多くが入力から判定を返す純粋な関数(`server/access.ts` の `decideAccess`、`server/push.ts` の `isPushServiceEndpoint`、`server/cli-child.ts` の `childEnv` など)で、テストは配列の表と個別の assert が混ざっている。ループバックでない接続元は、black-box のテストでは作れない(テストの client は常に 127.0.0.1 から接続する)

もとにした報告は `docs/rust-migration/architecture/2026-11-08-parity-criteria-review.html`(`improve-codebase-architecture` の手順で、基準に関わる TypeScript のテストを調べたもの)。決める前に architect(`spawn --role architect --read-only`、run `42548e4e`)に聞いた。

## 決定

### 基準は 3 つの形で作る

| 形 | 基準 | 中身 | TypeScript の runner | Rust の runner |
|---|---|---|---|---|
| ライブラリの関数に当てるデータの corpus | 会話ログの corpus、安全上の判定の表 | 入力と期待値を JSON とファイルで書く。画面の corpus と同じ作り | `scripts/` の runner と `*.test.ts` | 判定を持つ crate の `tests/`。同じ fixtures を読む |
| CLI のプロセスに当てるデータの corpus | fleet CLI の契約 | argv、環境変数、stub のサーバーの応答から、CLI が送った要求、標準出力、標準エラー、終了コードを比べる | `scripts/fleet-cli-fixtures.ts` が stub のサーバーを起動し、選んだ CLI の実行ファイルを動かす | 同じ TypeScript の runner を Rust の CLI に向ける |
| サーバーのプロセスに当てる black-box のテスト | HTTP/WS の契約 | テストは URL を通してだけサーバーと話す | `scripts/contract/launch.ts` でサーバーを起動する `*.contract.test.ts` | 同じテストを Rust の core に向ける |

CLI とサーバーは、どちらも TypeScript の runner が別のプロセスとして起動する。テストの対象は環境変数で選ぶ。

- fleet CLI: `HERDR_FLEET_CLI_TARGET` を `ts`(既定。`bun bin/fleet.ts`)か `rust:<実行ファイルのパス>` にする
- HTTP/WS: `HERDR_FLEET_CONTRACT_TARGET` を `ts`(既定)か `rust:<実行ファイルのパス>` にする。計画の「引数で選ぶ」は、`scripts/ci-tests.ts` が引数 `--target <ts|rust:パス>` で受け、この環境変数にして `bun test` に渡す

### HTTP/WS の契約: 起動の指定

テストは、サーバーを起動の指定(launch spec)で起動する。

```ts
const server = await launchServer({
  env: { HERDR_FLEET_TOKEN: "test-access-token", HOME: root },
  test: { machines: false, tailscaleOwner: null, acceptLoopbackPush: true },
});
await fetch(`${server.url}/api/session`);
await server.stop();
```

- `env` は子プロセスの環境変数で、本番のサーバーがすでに環境変数で受けているものだけを書く: `HOST`、`HERDR_FLEET_TOKEN`、`HERDR_FLEET_TAILSCALE_OWNER`、`HERDR_FLEET_STATE_DIR`、`CODEX_HOME`、`HOME`、`CLAUDE_CONFIG_DIR`、`PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`、`TMPDIR`、`PATH`、`HERDR_FLEET_HERDR_BIN`、`XDG_CONFIG_HOME`。launcher は子プロセスの環境を一から組み立てる。テストのプロセスの `HERDR_*` と API キーは渡さず、`HERDR_SOCKET` にはテスト用の herdr のセッションの socket(`scripts/test-herdr.ts` の `testSocketPath`)を入れる。`PORT` は launcher が決める(下の「ポート」)ので、`env` には書けない。一覧にない名前を `env` に書くと、launcher はその名前を含む `Error` を投げる
- `test` はテスト用のオプションで、本番の環境変数では表せず、データだけで書けるものに限る。一覧は次の表のとおりで、表にない名前を書くと、launcher はその名前を含む `Error` を投げ、テスト用のエントリーポイントはその名前を標準エラーに書いて終了コード 2 で終わる。関数を値に持つオプション(`createServer` の `fleet`、`explain`、`sideChats`、関数の `terminalAttach`)は入れない

| オプション | 型 | 意味(TypeScript の `createServer` の対応) |
|---|---|---|
| `tailscaleOwner` | 文字列か `null` | Tailscale のログインの持ち主として扱う名前。`null` は持ち主なし。どちらでも `tailscale status` を読まない(`tailscaleOwner`) |
| `machines` | 真偽値 | `false` で、PC の一覧(`/api/machines`。この PC の herdr の状態を数秒ごとに読む)を動かさない(`machines`) |
| `acceptLoopbackPush` | 真偽値 | `true` で、push の購読の宛先に 127.0.0.1 も受ける(`pushEndpoint` に `server/push.fake.ts` の `loopbackPush` を渡す) |
| `alertTiming` | `{short?, long?, longTurn?}`(ミリ秒の数) | push の知らせを送る前に待つ時間(`alertTiming`) |
| `submitDeadlineMs` | 数(ミリ秒) | `SUBMIT_DEADLINE_MS` の代わり(`submitDeadlineMs`) |
| `attachRetryForMs`、`attachHeldRetryMs`、`attachRelookupForMs` | 数(ミリ秒) | attach をやり直す時間の上限と間隔(同名のオプション) |
| `terminalAttach` | 真偽値 | herdr が `terminal attach` を使えるかの答えを、herdr に聞かずに決める(真偽値の `terminalAttach`) |
| `localPty` | 真偽値 | `false` で、サーバーがペインのターミナルを自分の PTY で動かせないものとして扱う(`sidecar`。Rust には Node の PTY sidecar がないので、外から見える振る舞いで名前を付けた) |
- `test` を読むのは、テスト用のエントリーポイントだけにする。テスト用のエントリーポイントは `test` の JSON を標準入力で受け、待ち受けを始めたら標準出力に `{"listening":{"hostname":…,"port":…}}` を 1 行書く。SIGTERM を受けると、本番(`server/index.ts` の `import.meta.main` の部分)と同じく、サーバーを止めて 2 秒待ち(attach の sidecar が herdr の attach の枠を返すため)、終了コード 0 で終わる
  - TypeScript: `scripts/contract/server.ts`。`createServer(テスト用のオプション)` を呼ぶだけで、残りの設定は `createServer` が環境変数から読む。`server/` に置かないのは、ADR `0107-crate-split` の対応表の検査が `server/` の全ファイルを数えるため
  - Rust(段階 4): core が持つ。本番の `rust/crates/core/src/main.rs` は `serve(Config::from_env()?, Seams::default())`、テスト用の `rust/crates/core/examples/contract-server.rs` は `serve(Config::from_env()?, spec.into())` を呼ぶ。`Seams` は lib の公開の型だが `Deserialize` を実装せず、JSON から読む型は example の中だけに置く。本番の実行ファイルは環境変数と引数からしか設定を読まないので、本番の実行ファイルにテスト用のオプションを渡す経路はない。今の TypeScript でも、`pushEndpoint` を `createServer` に渡すのはテストだけである
- ポート: launcher が 7400〜7499 から空いているポートを選んで `PORT` に入れる。使用中で起動に失敗したら、別のポートで起動し直す
- すでに動いているサーバーの URL に向ける口(`url:<base>`)は作らない。計画の「任意のサーバーの URL に向けて走らせられる black-box のテスト」は、「テストが URL を通してだけサーバーと話す」と読む

black-box に書き換えたファイルの決まり:

- 先頭に `// black-box: scripts/contract/launch.ts` と書く。`scripts/contract/check-imports.ts` が、この印のあるファイルの import を調べる。import してよいのは `shared/`、`server/herdr/client.ts`(テスト用の herdr を操作する道具として)、`server/pane-grid.ts`(ペインの tty の大きさを測る)、`server/pty/session.ts`(herdr にもう 1 つの client としてつなぐ)、`server/push.fake.ts`、`src/lib/api.ts`(Web UI の URL を組み立てる関数)、`scripts/contract/`、`scripts/test-herdr.ts`、`node:` と `bun:` の組み込みだけ
- 契約の値(`SUBMIT_DELAY_MS`、`OUTPUT_HIGH_BYTES`、`OUTPUT_HARD_BYTES`、`OUTPUT_STALL_MS`、Claude Code のプロジェクトのフォルダー名の決まり)は、`server/` から import せず、テストに値で書く。テストの対象の実装から期待値を取ると、TypeScript の値が変わったときにテストが黙って追従し、契約が何を約束しているかがテストに残らない。`shared/` の定数(例: `shared/terminal-flow.ts` の `OUTPUT_STALLED_CLOSE_CODE`)は import してよい。`shared/` は Web UI(契約のクライアントの側)も使う定義で、Rust の protocol の crate が引き継ぐ
- black-box にできない `it` は、`server/<名前>.herdr.test.ts` に移し、プロセスの中のテストとして残す。architect が挙げたものは次の 5 種類: `PtySession.prototype.write` の spy(`server/secret.contract.test.ts`)、あとで解決する Promise を `terminalAttach` に渡す件(`server/submit.contract.test.ts`)、fleet の runtime の fake(`server/api.contract.test.ts`)、サーバーの pid を名前に含む一時ファイルで書き込みを失敗させる件(`server/device-access.contract.test.ts`)、動いているサーバーの `PATH` を途中で変えて Node の PTY sidecar の起動を失敗させる件(`server/output.contract.test.ts`)。テストのプロセスの環境変数を途中で書き換える `it` は、確かめているのが「その環境変数の値をサーバーが読むこと」なら、その値で起動したサーバーで black-box にする(例: `server/pi.contract.test.ts` の `PI_CODING_AGENT_DIR`)。「動いている間の変化にサーバーが追従すること」なら、`*.herdr.test.ts` に移す
- `scripts/ci-tests.ts` の `needsHerdr` に `.herdr.test.ts` を足す。`server/fleet/runtime.contract.test.ts` は `HerdrRuntime` だけを試し、HTTP/WS を通らないので、`server/fleet/runtime.herdr.test.ts` に名前を変える。これで `*.contract.test.ts` は black-box の HTTP/WS の契約だけになる
- push: すべてのサーバーを `acceptLoopbackPush` 付きで起動すると、ベンダーでない宛先を拒否する処理を試さなくなる。このオプションなしで起動したサーバーに `POST /api/push/subscribe` を送り、400 が返る件を 1 つ置く

### 会話ログの corpus

- 置き場所: `fixtures/conversations/<source>/<case>/`。`case.json` の `about` には、画面の corpus と同じく、件のもとになったテストのファイルと名前を書く。runner は、この ADR にない項目のある `case.json` を、項目の名前を示して失敗させる。`source` は `claude`、`codex`、`pi`、`omp`、`opencode`(transcript の解析があるのはこの 5 つだけ)。中身は `case.json` と入力のファイル(transcript、Codex の home の木 `codex-home/sessions/<年>/<月>/<日>/…`、OpenCode の記録した応答 `api.json`)
- 実行の仕方: runner は件ごとに新しい一時フォルダー(`$CASE`)を作り、件のフォルダーのファイル(`case.json` を除く)をバイト列のまま複写して、`case.json` の `steps` を順に実行する。1 件の手順は 1 つの状態を共有する(TypeScript ではモジュールの cache、Rust では ADR `0107-crate-split` の `Transcripts` の値 1 つ)。TypeScript の runner は、件の前に `forgetTranscriptState`、`forgetHistoryChains`、`forgetPiModels` を呼ぶ
- 呼び出しの名前は、ADR `0107-crate-split` が transcript の crate に決めた口(会話のページ、metadata、画像、ツールの出力)に合わせる
  - `page`: `source`、`path`、`page: {before?, since?, from?}`。metadata は `page` の答えの中で比べる
  - `image`: `source`、`path`、`ref`。Codex だけ `cwd` も渡す
  - `toolOutput`: `source`、`path`、`ref`
  - `unansweredQuestions`: Codex の答えのない質問
  - OpenCode: `page`(`sessionId`、`working`、`page`)、`toolOutput`、`image`
- ファイルを変える手順: `append`(後ろに足す)、`replace`(別の inode のファイルに置き換える)、`rewrite`(同じ inode のまま書き直す。runner は書いたあと mtime を前の値より 1 秒進める。今のコードは書き直しを大きさと mtime と ctime で見つけるため)、`remove`
- 件に与える入力:
  - pi のモデルのコンテキストの大きさ `piContextWindows: {"<provider>/<model>": <数>}`。TypeScript の runner は一時フォルダーに `models.json` を書き、`PI_CODING_AGENT_DIR` をそこに向ける。Rust の runner は検索の関数として渡す(ADR `0107-crate-split`)
  - OpenCode の記録した応答: `serviceRunning` と、GET のパスごとの `{status, body}`。404 と 400 で振る舞いが変わるので、状態コードも記録する
  - OpenCode の時計: 手順 `{"at": <ミリ秒>}` の値を `now` として渡す
- 毎回違う値の扱い:
  - `history_id`、null でない `cursor`、`version` は値を書かない。`"$名前"` が最初に出たところでその値に名前を付け、2 回目からは同じ値であることを確かめる。`"!$名前"` は違う値であることを確かめる。あとの手順の `page.before` などにも `"$名前"` を渡せる
  - 値を書けないのは、`history_id` がファイルの dev と ino から作られ、書き直しを見つけると randomUUID が足され、Codex の連なりでは前のロールアウトの絶対パスのハッシュが足されるため。`cursor` は `history_id` とバイトの位置をつないだもの、`version` はプロセスごとの randomUUID から作る
  - `cursor: null`(会話の始まり)は値のまま書く
  - 名前は 1 件の中だけで通じる。画面の corpus の `sameIdAs` のような、件をまたぐ関係は持たない。件をまたぐ関係を持つと、`--update` がほかの件の `case.json` も書き換え、source ごとの Issue がほかの source のフォルダーに書き込むことになる
  - 画像のバイト列は `{mediaType, sha256, length}` で比べる
  - 答えに一時フォルダーのパスが出たら、`$CASE` に置き換えて比べる
  - 失敗は `{"error": "HistoryChanged"}`、`{"error": "ConversationUnavailable", "reason": "…"}`、`{"error": "ConversationNotStarted", …}` と書く
- 件にしないもの: 一時フォルダーの絶対パスを transcript に書き込む件(Codex のローカルの画像は `cwd` からの相対パスで書く)、時計を注入できない時間の経過(Codex の連なりの cache の 30 秒)。これらは TypeScript のテストに残り、parity.md で引き継ぎ先を決める
- `--update` の決まりは画面の corpus と同じにする。期待値のない件と、名前を指定した件だけを書き、毎回違う値には `$h`、`$c1`、`$v1` のような名前を自動で付ける
- 段階 2 への注意: `rust/crates/transcript/clippy.toml` はファイルへの書き込みを禁じ、CI の clippy は `--all-targets` で走るので、テストのコードにもこの禁止が当たる。ファイルを変える手順を実行する Rust の runner は、runner の module だけに `#[allow(clippy::disallowed_methods, clippy::disallowed_types)]` を理由とともに書く(ADR `0107-crate-split` はテストでの一時ファイルを認めている)

### 安全上の判定の表

判定ごとに、持ち主の crate を 1 つ決める。表は `fixtures/security/<持ち主>/<判定>.json`(1 ファイルに件の配列)、TypeScript の runner は `scripts/security-fixtures/format.ts` と持ち主ごとの `scripts/security-fixtures/<持ち主>.ts`、`scripts/security-fixtures/<持ち主>.test.ts`、Rust の runner は持ち主の crate の `tests/` に置く。

表に置くのは、入力がデータだけで決まり、black-box のテストでは作れない入力(ループバックでない接続元、tagged のノード、owner、tailnet の X-Forwarded-For)を含みうる判定である。HTTP/WS の契約には、今の契約のテストにある、ルートに要求を送って判定の結果(状態コードと本文)を見る件を、black-box のまま残す。対象は token、Host、Origin、proxy のヘッダー、紐付けた端末、`X-Herdr-Fleet`、ファイル表示の範囲、push の宛先の件で、主に `server/api.contract.test.ts` と `server/device-access.contract.test.ts` にある。表だけでは判定を呼び忘れたルートを見つけられず、契約だけではループバック以外の接続元を作れないので、両方に置く。

| 持ち主 | 表に置く判定(今の関数) |
|---|---|
| core | `decideAccess`、`isLoopbackAddress`、`isLoopbackHost`、`cameThroughProxy`(ヘッダーの一覧を入力にする)、`isAuthenticated`、`requiresAuth`、`sameOrigin`(URL とヘッダーを入力にする)、`parseViewPath`、ファイルの応答のヘッダー(`fileResponse` のうちヘッダーだけ。本文は比べない。表のファイル名は `fileResponseHeaders.json`)、`isPushServiceEndpoint`、`parseSubscription`(第 2 引数 `acceptEndpoint` を渡さず、宛先を `isPushServiceEndpoint` で判定する形で) |
| child-process | `childEnv`、`claudeEnv` |
| orchestrator | `opencodeGitEnv`、`opencodeConfig`(入力の `OpencodeRole` から設定の JSON への完全一致。OpenCode では最後に当たった規則が勝つので、規則の順序も比べる) |

- HTTP/WS の契約だけに置くもの: `withinRoots`(symlink を realpath で解くのでファイルシステムが要る)、`fileRoots`(`os.tmpdir()` を読む)、端末の紐付け(ファイルに書く)、`X-Herdr-Fleet` の確認(今は `server/fleet/api.ts` に直接書かれていて呼べる関数がない)、変更の要求の origin の拒否、ベンダーでない push の宛先の拒否
- どちらにも置かないもの: fleet-guard の `allowed()`(`opencode/fleet-guard/guard.js`)。OpenCode が読み込む JavaScript のプラグインで、Rust 版も同じフォルダーを同梱するので、`server/fleet/opencode-guard.test.ts` をそのまま残す。サーバーが git を `core.fsmonitor=false` で動かす決まりは、呼べる関数がなく 2 か所に重複している(ADR `0107-crate-split`)ので、段階 3 で child-process の Rust のテストに引き継ぐ
- `server/fleet/adapters.test.ts` が OpenCode の規則の照合を再実装して判定を試すテストは TypeScript に残す。設定の JSON が一致すれば、判定も一致する

### fleet CLI の契約

- 置き場所: `fixtures/fleet-cli/<case>.json`。1 件に、`about`(件のもとになったテストか、件が示すこと)、argv、環境変数、標準入力(`fleet plan -` のため)、stub のサーバーが要求の順に返す応答(状態コードと本文)、期待する要求(要求ごとに `method`、`path`、ヘッダーのうち `X-Herdr-Fleet` と認証、本文を別の項目で)、標準出力、標準エラー、終了コードを書く
- `HERDR_FLEET_URL` は runner が stub の URL にする。件が変えられるのは末尾の `/` の有無だけで、`HERDR_FLEET_URL` を外す件は作らない(外すと CLI は既定の 127.0.0.1:7317、つまり稼働中の fleet に送る)
- 時刻の表示(`bin/fleet.ts` の `toLocaleString()`)は、ロケールと時刻帯で変わる。runner は CLI を `TZ=UTC`、`LANG=en_US.UTF-8` で動かし、件の時刻は今から 10 年以上離れた過去か未来にする(クールダウンを表示するかは今の時刻との比較で決まるため)。Rust の CLI が合わせるのは、この固定した環境での表示だけとする

### parity.md

- 行にするファイル: `git ls-files` のうち、`*.test.ts` と `*.test.tsx`(158)、`scripts/*-regression.ts`(37)、`scripts/*-qa.ts`(6)、`e2e/*.ts`(1)、手で走らせる検査の `scripts/opencode-live-check.ts` と `scripts/pty-compare.ts`。段階 1 のほかの Issue が足すテストのファイルも、この glob に当たれば行にする。計測の script(`scripts/benchmark-codex-transcript.ts`)は、parity.md に理由を書いて除く
- 引き継ぎ先の欄に書く値は 4 種類: 基準の名前、Rust の crate のテスト、「そのまま残す」(例: `src/` の Web UI のテスト。Rust の core は Web UI を変えずに配信する。fleet-guard のテスト)、「なし: <理由>」(例: Node の PTY sidecar の起動の失敗を試す件)。「なし: <理由>」の値がないと、引き継ぎ先を書けない行が残り、段階 7 の完了条件「parity.md の全行に引き継ぎ先がある」を満たせなくなる。段階 1 では、引き継ぎ先がまだ決まらない行を空欄にしてよい(段階 7 までに埋める)
- 検査の script を置く。glob で集めたファイルの一覧と表の行を比べ、欠けた行と余った行で失敗させる
- 既存の TypeScript のテストは消さない。corpus に移した内容は、引き継ぎ先の欄で示す

### 段階 1 の Issue の分け方

書くパスが重なる Issue は待つ関係にする。runner(`scripts/conversation-fixtures.ts`、`scripts/contract/`、`scripts/security-fixtures/format.ts`)を最初の Issue が作り、あとの Issue は自分の fixtures のフォルダーか自分のテストのファイルだけを書く。あとの Issue が runner に足りない口を見つけたら、runner を直す Issue を別に開き、それを待つ(2 つの thread が同時に runner を書かないため)。

段階 1 の Issue は #123〜#134 で、#122 がこの ADR の Issue である。計画の項目と Issue の対応は、tracking issue #105 のコメントにある。

## 検討した代わり

- すでに動いているサーバーの URL に向ける口(`url:<base>`): どのテストも state フォルダー、token、`HOME` の下の transcript を自分で決めてサーバーを起動するので、外で動いているサーバーに向けられるテストがない。稼働中のサーバー(ポート 7317)に向けてしまう危険もある
- テスト用のオプションを cargo の feature で囲む案: 1 回の build で選んだ package の間で feature は合わさる(resolver 3 でも同じ)。workspace のどれか 1 つの crate が feature を有効にすると、`cargo build --workspace` で作る本番の `herdr-fleet` にもテスト用のコードが入る。cfg で囲んだコードは、既定の build では clippy が調べない
- テスト用のエントリーポイントを `[[bin]]` と `required-features` で作る案: 動くが、bin を 1 つ作るためだけの feature が増える。example なら feature は要らず、CI の `cargo test` と `cargo clippy --all-targets` が build し、`cargo install` は入れない
- テスト用のエントリーポイントのために 12 個目の crate を作る案: ADR `0107-crate-split` を置き換える ADR が要り、example と比べて得るものがない
- 本番のサーバーが、テスト用のオプションを環境変数で受ける案: `acceptLoopbackPush` のような、本番では許さない振る舞いを環境変数 1 つで有効にできてしまう。CLAUDE.md の「push 通知の宛先はブラウザベンダーの push サービスに限る」「アクセス制御を緩めない」に反する
- 今の契約のテストを残し、black-box のテストを別に作る案: 同じ振る舞いを 2 つのテストで書くことになり、片方だけが直されて食い違う
- 会話ログの corpus で、件をまたいで同じ値を示す(画面の corpus の `sameIdAs` と同じ作り): 上の「毎回違う値の扱い」に書いた理由で選ばなかった
- fleet-guard の `allowed()` を安全上の判定の表に入れる案: Rust 版も同じ JavaScript を同梱するので、Rust で同じ判定を作る必要がなく、表にしても通す実装が 1 つしかない
- parity.md を `*.test.ts(x)` だけにする案: 計画の表は UI の回帰(`bun run test:ui`、`scripts/fleet-screen-regression.ts`)も基準にしており、`scripts/*-regression.ts` を行にしないと、切り替えの前に引き継ぎ先を確かめられない

## 依存

なし。この ADR は外部の crate も道具も足さない。

## 結果

- 段階 1 の Issue は、この ADR のファイルの配置と決まりに従う
- 段階 2 の screen と transcript の crate は、`fixtures/screens/` と `fixtures/conversations/` を cargo test から読む。transcript の crate は、`page`、`image`、`toolOutput`、`unansweredQuestions` と OpenCode の `page`、`toolOutput`、`image` に当たる口を持つ
- 段階 3 の child-process と orchestrator の crate は、`fixtures/security/child-process/` と `fixtures/security/orchestrator/` を cargo test から読む。fleet CLI の Rust の実行ファイルは、`HERDR_FLEET_CLI_TARGET=rust:<パス>` で同じ corpus を通す
- 段階 4 の core の crate は、`serve(Config, Seams)` を lib に持ち、`examples/contract-server.rs` を置く。`fixtures/security/core/` を cargo test から読み、`HERDR_FLEET_CONTRACT_TARGET=rust:<パス>` で HTTP/WS の契約を通す
- black-box の契約は、テストのたびにサーバーを別のプロセスで起動するので、今より遅くなる
- プロセスの中でしか試せない `it` は、black-box の契約から外れて `*.herdr.test.ts` に残る。その引き継ぎ先は parity.md で 1 件ずつ決める
- 会話ログの corpus は、絶対パスで書かれた Codex の画像と、時間で変わる Codex の cache を扱わない

## architect の答えと違う判断

architect の答え(run `42548e4e`)の推奨をすべて採った。答えが決めていなかったところと、採らなかった任意の提案は次のとおり。

- fleet CLI の対象の選び方: 答えは決めていなかった。HTTP/WS と同じ形にし、環境変数 `HERDR_FLEET_CLI_TARGET` で選ぶ
- 2 つ以上の batch が使うテストの helper: 答えは「2 つの batch が使う helper を、別の PR で `scripts/contract/` に足す」とした。この ADR は、その PR を Issue として開き、helper が要る batch はその Issue を待つ、と決めた。並行する thread が同じパスを書かないことを、Issue の待つ関係で示すため
- `docs/rust-migration/GLOSSARY.md` への用語(起動の指定、テスト用のオプション)の追加: 答えは ADR と同時に足すとした。この thread が書けるパスは `docs/rust-migration/architecture/` と `docs/rust-migration/adr/` だけなので、HTTP/WS の契約の最初の Issue が足す
- herdr の要らない corpus を走らせる job を `.github/workflows/rust.yml` に足す提案(答えでは任意): 段階 1 では足さない。計画の段階 1 の完了条件は TypeScript 版で通ることで、CI は求めていない。段階 2 で Rust の runner が同じ fixtures を読むと、fixtures と Rust の答えの一致は CI で確かめられる。TypeScript の答えとの一致を CI で確かめるかは、段階 2 の Issue で決める

## 確かめたこと

2026-11-08、Linux 7.2.15、`rust` のコミット `e95cb1f` で、読み取りだけを実行した。

- `git ls-files '*.test.ts' '*.test.tsx' | wc -l` は 158(bin 1、scripts 2、server 76、shared 4、src 75)
- `ls scripts/*-regression.ts | wc -l` は 37、`ls scripts/*-qa.ts | wc -l` は 6
- `wc -l server/*.contract.test.ts` は 15 ファイルで 5,391 行。`grep -cE '\bit(\.skipIf\(.*\))?\('` の合計は 171(`it.skipIf` を含む。文字列の中の一致も数えうるので約 170 とした)
- `server/*.contract.test.ts` の `createServer(` の引数と `process.env` の書き換えと import を grep で集めた。使われていたオプションは `hostname`、`token`、`stateDir`、`tailscaleOwner`、`machines`、`sidecar`、`terminalAttach`、`alertTiming`、`pushEndpoint`、`attachRetryForMs`、`attachHeldRetryMs`、`attachRelookupForMs`、`submitDeadlineMs`、`codexHome`、`fleet`
- `server/index.ts` が `HOST`、`HERDR_FLEET_TOKEN`、`HERDR_FLEET_TAILSCALE_OWNER` を、`server/state-dir.ts` が `HERDR_FLEET_STATE_DIR` を環境変数から読むことを、ソースで確かめた
- `fixtures/` に transcript がないこと(`ls fixtures` は `screens` だけ)を確かめた
- Rust の build、herdr、サーバーは動かしていない
