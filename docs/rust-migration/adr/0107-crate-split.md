# Cargo workspace を 11 の crate に分ける

- 状態: 採用
- 決めた日: 2026-11-08
- Issue: #107

## 状況

Rust 版の Cargo workspace(`rust/`)を、どの crate に分けるかを決める必要があった。段階 1 以降の Issue は、この ADR の crate の名前と依存の向きに従って作業を分け、#110 がこの ADR に従って crate の雛形を作る。

前提と制約:

- 段階 2 で作る解析(承認画面の解析、エージェント adapter の画面の判定、会話ログの解析)は、herdr の socket、子プロセス、HTTP に依存しない crate に置き、corpus だけでテストできなければならない(Issue #107)
- デスクトップの画面(GPUI)、ターミナルの描画のライブラリのバインディング、`fleet` CLI の実行ファイルにも crate が要る。ライブラリが何かは #109 の ADR が決めるので、ここではバインディングの crate の置き場所だけを決める
- `fleet` CLI は、今の `bin/fleet.ts` と同じ引数・出力・終了コードを持つ(計画の「目標」)
- 対象は `server/`、`shared/`、`bin/` の TypeScript の 84 ファイル(`*.test.ts` を除く、20,508 行)

もとにした報告は `docs/rust-migration/architecture/2026-11-08-typescript-review.html`(`improve-codebase-architecture` の手順で今の TypeScript のコードを調べたもの)。crate の境界は、決める前に architect(`spawn --role architect --read-only`)に聞いた。

今のコードには、ファイルをそのまま crate に写せない結合がある。

- `server/prompt.ts` は型 `QueuedQuestion` を `server/codex.ts` から import する。`codex.ts` は `bun:sqlite`、herdr のクライアント、`/proc` の読み取りを import する
- `server/conversation.ts` と `server/codex.ts` は、transcript の純粋な解析と、transcript の場所の特定(herdr の RPC、sqlite、`/proc`、`opencode api` の子プロセス)を同じファイルに持つ
- `server/fleet/adapters.ts` の画面の判定は純粋な関数だが、同じファイルが子プロセスを起動する `server/fleet/model-lists.ts` を import する
- 子プロセスの決まり(最小の環境変数、専用の空のフォルダー、タイムアウトと kill)は `server/cli-child.ts` の部品を 5 つのファイルが組み立てて使う。git を `core.fsmonitor=false` で動かす決まりは `server/files.ts` と `server/fleet/thread.ts` に重複している
- `server/fleet/orchestrator.ts` と `server/fleet/api.ts` は、herdr との間の seam(`server/fleet/runtime.ts` の `AgentRuntime`)を越えて herdr のエラーコードを直接見ている

## 決定

### crate の一覧

package の名前は `herdr-fleet-<部分>`、フォルダーは `rust/crates/<部分>`。workspace の `[workspace.dependencies]` に `screen = { package = "herdr-fleet-screen", path = "crates/screen" }` のような別名を置き、コードでは短い名前で呼ぶ。core だけは別名を付けない(Rust の組み込みの `core` crate を隠すため)。

| crate(package) | 種類 | 責務 | 依存する crate |
|---|---|---|---|
| herdr-fleet-herdr-api | lib | herdr の socket API の型を、`scripts/herdr-schema.json` から生成して持つ。 | なし |
| herdr-fleet-protocol | lib | herdr-fleet の HTTP・WebSocket・SSE の型、ルートのパスとヘッダー名、fleet の記録の型と、サーバーとクライアントの両方が使う規則(計画の検査、通知の条件、秘密の入力の判定、Codex の patch の読み取り)を持つ。 | herdr-api |
| herdr-fleet-screen | lib | エージェント CLI の画面の文字を読み、カード、答えのキー、画面の判定、Cursor の使用量の画面の読み取りを返す。 | protocol |
| herdr-fleet-transcript | lib | 場所のわかった transcript(ファイルのパス、OpenCode はメッセージを返す port)を読み、会話のページ、metadata、画像、ツールの出力を返す。 | protocol |
| herdr-fleet-herdr | lib | herdr の socket のクライアント(RPC、イベントの購読、Windows の marker と named pipe)。 | herdr-api |
| herdr-fleet-child-process | lib | core がペインの外で起動するすべての子プロセス(エージェント CLI、git、`opencode api`)に、最小の環境変数、専用の空のフォルダー、`core.fsmonitor=false`、タイムアウトと kill、出力の大きさの上限、同時に動かす数の上限を当てる。 | なし |
| herdr-fleet-orchestrator | lib | fleet の run、委ねたターン、thread、役割、エージェント adapter の起動の引数と環境変数、使用量とモデル一覧、run の記録、herdr を操作する Runtime(今の `HerdrRuntime`)を持ち、`/api/fleet` のルートを公開する。 | protocol, screen, herdr, child-process |
| herdr-fleet-core | lib + bin `herdr-fleet` | HTTP・WebSocket のサーバー(ルート、アクセス制御、attach とミラー、エージェントの状態の購読、transcript の場所の特定、push 通知、サイドチャット、Explain、Web UI の配信)。 | herdr-api, protocol, screen, transcript, herdr, child-process, orchestrator |
| herdr-fleet-cli | bin `fleet` | `bin/fleet.ts` と同じ引数・出力・終了コードで、core の `/api/fleet` を呼ぶ。 | protocol |
| herdr-fleet-vt | lib | #109 が選ぶターミナルのライブラリのバインディング。`build.rs` と `unsafe` をこの crate に閉じ込める。 | なし |
| herdr-fleet-desktop | bin `herdr-fleet-desktop` | GPUI の画面。core の HTTP・WebSocket のクライアントとして動く。 | protocol, vt |

依存の順は herdr-api、child-process、vt → protocol、herdr → screen、transcript、cli、desktop → orchestrator → core で、どの crate もこの順で前にある crate にしか依存しない。この ADR は外部の crate を足さない。

### 解析の crate(screen と transcript)の決まり

- screen は `std::fs`、`std::process`、`std::net` を使わない。transcript はファイルを読むだけで、`std::process`、`std::net`、ファイルへの書き込みを使わない。どちらも herdr-fleet-herdr、herdr-fleet-child-process、tokio、HTTP のライブラリに依存しない
- #110 は、screen と transcript のフォルダーに clippy.toml(`disallowed-methods` と `disallowed-types`)を置き、CI で `cargo tree -p herdr-fleet-screen -e normal` と `cargo tree -p herdr-fleet-transcript -e normal` に herdr-fleet-herdr、herdr-fleet-child-process、tokio、axum、hyper、reqwest が出ないことを確かめる。clippy が crate ごとの clippy.toml を読まなければ、ソースの grep に替える
- screen のテストは画面の corpus(`fixtures/screens/`)、transcript のテストは会話ログの corpus と一時ファイルだけで走る
- transcript はパスを受けてファイルを読む。最新のページを探すには形式ごとにターンの始まりを探す必要があり(`server/conversation.ts` の `newestPage`、`pageBefore`)、カーソルと ETag はファイルの dev・ino・size・mtime・ctime から作る。バイト列だけを受ける形にすると、この知識が core に漏れるか、Codex のロールアウトを毎回すべて読むことになる。ロールアウトは数百 MB になり、400 MB のものをすべて解析するのに 1.1 秒と 1.7 GB のメモリを使った(`server/conversation.ts` の `TRANSCRIPT_WINDOW_BYTES` のコメント)
- transcript の cache は 1 つの値(例: `Transcripts`)が持ち、core がそれを 1 つ持つ。テストはそのつど新しい値を作る(TypeScript はモジュールの変数に持ち、`forgetTranscriptState` で消している)
- transcript は、pi のモデルのコンテキストの大きさを、引数で受け取った検索の関数で求める。大きさを pi のカタログから読む `server/pi-models.ts` は `server/commands.ts` も使うので、core に置く
- OpenCode のメッセージは、transcript が定義する trait `OpencodeApi` で受ける(今の `server/opencode-session.ts` の `OpencodeApi` の注入と同じ)。本番の adapter は、core が child-process の OpenCode のクライアントを包んで作る
- screen と transcript をつなぐ型は `QueuedQuestion`(Codex の答えのない質問)だけ。screen が自分の入力の型として定義し、transcript は自分の型を返し、core が詰め替える。詰め替えるのは、今 `server/prompt-api.ts` が 2 つを組み合わせている箇所にあたる

### crate の間の seam で変えること

- orchestrator の Runtime の port は自分のエラーの enum を返す。herdr のエラーコード(`agent_blocked`、`agent_not_found` など)からの変換は herdr の Runtime の adapter だけが行う
- `/api/fleet` のルート(今の `server/fleet/api.ts`)は orchestrator の crate に置き、core は自分のアクセス制御の下にそれを mount する。GET 以外の要求に `X-Herdr-Fleet: 1` を求める確認は core のアクセス制御に移し、ヘッダー名は protocol の定数にする(CLI も送るため)
- herdr のクライアントは herdr 自身の ping の型を返す。`terminal_attach` と `terminal_mirror` を持つ `HerdrIdentity` は、core が protocol の型で組み立てる
- protocol は、自分の通信に載せる herdr の型を herdr-api から再 export する(今の `shared/protocol.ts` と同じ)
- cli は応答の型を protocol から取る。今の `bin/fleet.ts` は `Run`、`ThreadSummary`、`UsageEntry` を `shared/fleet.ts` と別に定義している。応答の読み方は今の CLI と同じく、項目が欠けても失敗しないようにする。正しいかは段階 1 の fleet CLI の契約で確かめる
- 使用量の probe とモデル一覧の取得は orchestrator に残し、出力の parser はそのコマンドの argv の隣に置く。child-process は workspace のどの crate にも依存しない

### TypeScript のファイルの引き継ぎ先

`server/`、`shared/`、`bin/` の `*.ts`(`*.test.ts` を除く)のすべてを並べる。2 つの crate に分かれるファイルは、両方の crate を書き、分け方を備考に書く。crate の名前は `herdr-fleet-` を省いて書く。

| ファイル | crate | 備考 |
|---|---|---|
| `bin/fleet.ts` | cli | |
| `server/access.ts` | core | |
| `server/agent-name.ts` | core | |
| `server/attach-output.ts` | core | |
| `server/auth.ts` | core | |
| `server/claude-store.ts` | core | transcript の場所の特定 |
| `server/cli-child.ts` | child-process | |
| `server/codex-images.ts` | transcript | |
| `server/codex.ts` | transcript, core | transcript: parser、履歴の連なり、答えのない質問、画面との照合。core: `codexTranscriptPath`、`paneCodexHome`、`processCodexHome`(sqlite、`/proc`、ps、herdr) |
| `server/collector.ts` | core | |
| `server/commands.ts` | core | |
| `server/completion.ts` | core | |
| `server/conversation-errors.ts` | transcript | |
| `server/conversation-metadata.ts` | transcript | pi のコンテキストの大きさは引数で受ける |
| `server/conversation.ts` | transcript, core | transcript: 解析、ページング、画像、ツールの出力。core: `paneConversation`、`claudePaneTranscript`、`ompSessionPath` |
| `server/devices.ts` | core | |
| `server/directories.ts` | core | |
| `server/explain.ts` | core | 子プロセスの起動は child-process を使う |
| `server/file-view.ts` | core | |
| `server/files.ts` | core | git の起動の決まりは child-process に移す |
| `server/fleet/adapters.ts` | orchestrator, screen | orchestrator: 起動の引数、環境変数、OpenCode の設定、モデル一覧。screen: 画面の判定(`startupError`、`question`、`readyError`、`inputReady`、`draft`、`turnError`)と `cursorUsage` |
| `server/fleet/agents.ts` | orchestrator | |
| `server/fleet/api.ts` | orchestrator | `X-Herdr-Fleet` の確認は core に移す |
| `server/fleet/brief.ts` | orchestrator | |
| `server/fleet/config.ts` | orchestrator | |
| `server/fleet/entrances.ts` | orchestrator | |
| `server/fleet/github.ts` | orchestrator | |
| `server/fleet/model-lists.ts` | orchestrator | |
| `server/fleet/models.ts` | orchestrator | |
| `server/fleet/opencode-config.ts` | orchestrator | |
| `server/fleet/orchestrator.ts` | orchestrator | |
| `server/fleet/plan.ts` | orchestrator | |
| `server/fleet/registry.ts` | orchestrator | |
| `server/fleet/runtime.ts` | orchestrator | |
| `server/fleet/settings.ts` | orchestrator | |
| `server/fleet/thread.ts` | orchestrator | git の起動の決まりは child-process に移す |
| `server/fleet/types.ts` | orchestrator | |
| `server/fleet/usage.ts` | orchestrator | |
| `server/herdr-marker.ts` | herdr | |
| `server/herdr/client.ts` | herdr | |
| `server/http.ts` | core | |
| `server/index.ts` | core | ルートは core の中で領域ごとの module に分ける(報告の候補 6) |
| `server/machine-api.ts` | core | |
| `server/machines.ts` | core | |
| `server/mirror-input.ts` | core | |
| `server/mirror.ts` | core | |
| `server/opencode-cli.ts` | child-process | |
| `server/opencode-messages.ts` | transcript | |
| `server/opencode-session.ts` | transcript, core | transcript: `OpencodeConversations`。core: `opencodeSessionId`(herdr の `agent.get`) |
| `server/output-window.ts` | core | |
| `server/pane-grid.ts` | core | |
| `server/paste.ts` | core | |
| `server/pi-models.ts` | core | |
| `server/pi-tree.ts` | transcript | |
| `server/pi.ts` | core | transcript の場所の特定 |
| `server/process-start.ts` | core | |
| `server/projects.ts` | core | |
| `server/prompt-api.ts` | core | |
| `server/prompt.ts` | screen | |
| `server/pty/session.ts` | core | |
| `server/pty/sidecar.ts` | core | |
| `server/push.fake.ts` | core | テストだけで使う(dev-dependency か `#[cfg(test)]`) |
| `server/push.ts` | core | |
| `server/side-chat-api.ts` | core | |
| `server/side-chat-context.ts` | core | |
| `server/side-chat.ts` | core | 子プロセスの起動は child-process を使う |
| `server/side-terminal.ts` | core | |
| `server/skill-activity.ts` | transcript | |
| `server/state-dir.ts` | core | |
| `server/static.ts` | core | |
| `server/tailscale.ts` | core | |
| `server/tool-output.ts` | transcript | |
| `server/transcript-records.ts` | transcript | |
| `shared/fleet.ts` | protocol | |
| `shared/herdr-api.generated.ts` | herdr-api | |
| `shared/machines.ts` | protocol | |
| `shared/notify-policy.ts` | protocol | |
| `shared/patch.ts` | protocol | |
| `shared/plan.ts` | protocol | |
| `shared/protocol.ts` | protocol | |
| `shared/secret-prompt.ts` | protocol | |
| `shared/side-chat.ts` | protocol | |
| `shared/side-terminal.ts` | protocol | |
| `shared/terminal-flow.ts` | protocol | |

vt と desktop が引き継ぐ TypeScript のファイルはない。desktop は `src/` の画面の振る舞いを GPUI で作り直す。

### 手順のうち、人に聞くところを置き換えた判断

`improve-codebase-architecture` は、人に聞く手順を 3 つ持つ。決まり(`.herdr-fleet/standing.md` の「Skills」)に従い、次のように置き換えた。

- 報告を一時フォルダーに書いてブラウザで開く手順: `docs/rust-migration/architecture/` に書き、開かない
- どの候補を掘り下げるかを人に聞く手順: 報告の一番の推奨を採った。ただし Issue #107 が求めるのは crate の分け方の全体なので、候補 1、2、3、4、5、7 を crate の境界にし、候補 6 を core の中の module の分け方にした
- 候補を人と問い詰める手順(grilling): 同じ問い(粒度、デスクトップの形、transcript がファイルを読むか、herdr の型の置き場所、名前)を architect に聞き、その答えをこの ADR の決定にした

### architect の答えと違う判断

ない。architect の答えは、lead の下書き(9 crate)に herdr-api と child-process の 2 つの crate を足し、desktop の依存を protocol と vt だけにし、transcript がファイルを読むと決めるものだった。この ADR はそれをそのまま採った。lead の報告の下書きでは `shared/secret-prompt.ts` を screen に入れていたが、Web UI と同じく desktop も秘密の入力を判定するので、architect の答えどおり protocol に置いた。

## 検討した代わり

- 7 crate(解析を 1 つの `parse` crate にし、orchestrator と子プロセスの処理を core に入れ、herdr の型を protocol に入れる): 詰め替えと OpenCode の adapter が要らず、manifest が少ない。選ばなかった理由は 3 つ。orchestrator のテストのたびに HTTP のサーバー、PTY、push まで build することになる。orchestrator が core の内部を呼ぶのを crate の依存で止められない(TypeScript でもすでに `orchestrator.ts` と `api.ts` が seam を越えている)。画面の判定とファイルを読む処理が同じ crate に入り、「screen はファイルを読まない」を crate ごとの lint で確かめられない
- エージェント CLI ごとの crate(claude、codex、pi など): ページング、カードの id の計算、子プロセスの決まりが重複するか、結局共通の crate が要る。新しい CLI を足すときに直す場所は、protocol のエージェントの種類の enum に対する網羅的な match がコンパイラーで示す
- desktop に core を組み込む: state フォルダーのファイル(run の記録、使用量、紐付けた端末、push の鍵)を、組み込んだ core と単独で動く core の 2 つが書くことになる。エージェントのペインは `HERDR_FLEET_URL` で core を指し、スマホも core を使うので、core はデスクトップがなくても動いている必要がある。desktop の build にサーバーの依存が入り、GPUI の executor と tokio が同じプロセスに同居する
- cli と desktop が共有する HTTP のクライアントの crate: cli に要るのは `/api/fleet` へのブロッキングの HTTP、desktop に要るのは GPUI の executor の上の非同期の HTTP、WebSocket、SSE で、共有できるのはデータ(型、ルートのパス、ヘッダー名、エラーの本文の形)だけ。データは protocol に置く。段階 5 で、desktop のクライアントが base URL、token のヘッダー、エラーの解釈より多くを cli と重複させたときに見直す
- transcript がバイト列だけを受ける形: 上の「解析の crate の決まり」に書いた理由で選ばなかった
- herdr の型を protocol に入れる: herdr の型は herdr のスキーマから生成し、`generate:types --check` で一致を確かめる。protocol と変わるきっかけが違い、herdr のクライアントが herdr-fleet の HTTP の型に依存することになる
- 短い package の名前(`protocol`、`screen`、`core`): `core` は Rust の組み込みの crate を隠す。package の名前は `cargo -p`、Cargo.lock、CI のログに出るので、一般的な名前は接頭辞で区別する

## 依存

なし。この ADR は外部の crate を足さない。HTTP のライブラリ、GPUI の版、ターミナルのライブラリ(#109)は、それぞれを足す ADR で決める。

## 結果

- 段階 1 以降の Issue は、この表の crate の名前で作業を分ける。段階 2 は screen(画面の corpus は `fixtures/screens/` にある)と transcript、段階 3 は herdr、child-process、orchestrator、cli、段階 4 は core、段階 5 は vt と desktop
- 解析の crate は、ファイル以外の I/O を持たない。corpus と一時ファイルだけでテストできる
- core は外部のライブラリのバインディング(vt)をリンクしない。core の build に Zig や C のツールチェーンは要らない
- desktop は core が動いていないと何もできない。デスクトップが core を起動するかは段階 5 で決める。どちらにしても `herdr-fleet` の実行ファイルを起動する形なので、crate の依存は変わらない
- エージェント CLI ごとの知識は、関心ごとに 3 つの crate に分かれる(起動の引数は orchestrator、画面の判定は screen、transcript の解析は transcript)
- core に、`QueuedQuestion` の詰め替え(3 つの項目)と、`OpencodeApi` の adapter(child-process の OpenCode のクライアントを trait に合わせて包むもの)が要る
- orchestrator は、`/api/fleet` のルートのために HTTP のライブラリに依存する。その代わり、`/api/fleet` の契約を orchestrator の crate の中でテストでき、core は mount するだけで済む
- crate を足すか分け直すときは、この ADR を置き換える新しい ADR を書く。core の中の module を crate に出すのは、依存の向きを変えない限り、この ADR の変更に当たらない

## 確かめたこと

2026-11-08、Linux(omarchy)、`rust` ブランチの `1819074` で確かめた。Rust のコードは書いていないので、cargo の検査はない。

- 各ファイルの import を grep で抜き出し、解析のファイルが herdr のクライアント、`bun:sqlite`、子プロセスを import している箇所を確かめた(「状況」に書いたもの)
- 対応表がファイルの一覧と一致することを、次のコマンドで確かめた。出力は `files: 84 / rows: 84 / missing: 0 / extra: 0`

  ```bash
  find server shared bin -name '*.ts' ! -name '*.test.ts' | sort > /tmp/ts-files
  grep -oE '^\| `(server|shared|bin)/[^`]+\.ts` \|' docs/rust-migration/adr/0107-crate-split.md \
    | sed -E 's/^\| `([^`]+)` \|$/\1/' | sort > /tmp/adr-rows
  echo "files: $(wc -l < /tmp/ts-files) / rows: $(wc -l < /tmp/adr-rows) / missing: $(comm -23 /tmp/ts-files /tmp/adr-rows | wc -l) / extra: $(comm -13 /tmp/ts-files /tmp/adr-rows | wc -l)"
  ```

- crate の依存に循環がないことを、「crate の一覧」の表の依存の列を `tsort` に渡して確かめた。`tsort` は循環を見つけると `input contains a loop` を出して失敗する。出力は循環の警告なしで 11 の crate を並べ、終了コードは 0

  ```bash
  awk -F'|' '/^\| herdr-fleet-/ { c=$2; gsub(/[ ]/,"",c); sub(/^herdr-fleet-/,"",c); n=split($5,d,","); print c, c; for (i=1;i<=n;i++) { x=d[i]; gsub(/[ ]/,"",x); if (x!="なし") print x, c } }' \
    docs/rust-migration/adr/0107-crate-split.md | tsort
  ```
