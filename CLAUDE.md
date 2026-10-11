# herdr-fleet

Herdr 上で複数のコーディングエージェント(pi / Claude Code / Codex / Cursor / Antigravity / OpenCode)を役割分担させ、ブラウザから見て操作するための個人用ツール。herdr-web-ui v0.3.45 の fork で、上流の履歴は取り込んでいない(起点は NOTICE)。上流の変更は自動では取り込まず、差分を読んでから必要な分だけ手で移す。

## 構成

- `server/` — Bun の単一プロセス。HTTP / WebSocket(`index.ts`)、Herdr の socket クライアント(`herdr/client.ts`)、全ペインの状態イベントを購読する collector(`collector.ts`)、ターミナル表示用の PTY sidecar(`pty/`)、承認画面の解析(`prompt.ts`)、会話ログの解析(`conversation.ts` ほか)
- `server/fleet/` — エージェントを起動してターンを追う orchestrator。エージェント CLI ごとの違いは `adapters.ts` に閉じ込め、orchestrator は種別に依存させない。HTTP API は `/api/fleet/*`(`api.ts`)
- `bin/fleet.ts` — `/api/fleet` を呼ぶ薄い CLI。起動されたエージェントは、指示文と環境変数(`HERDR_FLEET_URL` / `HERDR_FLEET_GROUP` / `HERDR_FLEET_DEPTH`)を通じてこれを使う
- `agents/*.md` — 同梱の役割定義。ユーザー分は `~/.config/herdr-fleet/agents/`、プロジェクト分は `.herdr-fleet/agents/` に置き、後に読んだものが同名の役割を上書きする
- `standing.md` — 常に守る指示。ユーザー分 `~/.config/herdr-fleet/standing.md` と、プロジェクト分 `.herdr-fleet/standing.md`(作業フォルダから上へ探して最も近いもの)を、この順で、すべてのエージェントの指示文の末尾に足す
- `src/` — React の Web UI。`shared/` はサーバとクライアントで共有する型(fleet の run と使用量は `shared/fleet.ts`)
- `src/ui/` — Web UI の土台。すべてのコンポーネントは `Root` を頂点とする階層の下に置く。各コンポーネントは Passive View として描画用の値だけを受け取り、動作はイベントとして親に渡す(親は文脈を足して上へ渡すか、扱って止める: `relay`)。Root の `Mediator` が、並行する領域を持つ状態機械(`state.ts` の純粋な遷移関数)で裁定し、副作用(API の呼び出し)を実行する。状態は、View ごとの Presenter(`FleetPresenter` など)が、その View が描く領域だけを `useRegions` / `useSelected`(`presenter.ts`)で購読して view model にし、View に渡す。状態全体を上から配らない(ある領域の変化で、関係のない画面まで再描画しないため)。View に置いてよいのは見た目だけの状態(hover、スクロール位置、開閉、xterm の内部、表示用の時計)。App が持っていた状態(サーバとの接続、選択中のペイン、通知など)は Mediator に移した。時間で起きる振る舞いは `later` effect、SSE の購読は open-stream / close-stream effect で表す。ペインのターミナルの WebSocket も Mediator が持つ(`open-pane-socket` effect)。ただし `pty-data` のバイト列、キー入力、秘密の入力は状態を通さず、View の xterm が登録した宛先へ直接渡す。移行の例外として View に残しているのは次のとおり
  - PaneTerminal: xterm の操作に付随する API 呼び出し(スクロール、選択範囲のテキストの取得、ドロップしたファイルのアップロード)と、秘密の入力の送信の完了待ち
  - ChatView: ツール出力の全文を読む `useWholeOutput`
  - チャットの状態(`chat` と `conversation`)は 2 つ持つ。ペインのもの(Pane 画面のチャット、または Fleet 画面のプロジェクトの会話)と、その横のもの(`side`: Fleet 画面の Overview で開いたスレッドやエージェント)。横のものへのイベントと副作用には `lens: "side"` を付け、同じ遷移を `side` に入れ替えて走らせる。Fleet 画面の間、Pane 画面のチャットは開かない(`PaneTerminal` の `chatShown`)
  - xterm の DOM の振る舞いをモジュールに分けることは見送った

## 開発コマンド

依存は `bun install --ignore-scripts` で入れる。依存パッケージのライフサイクルスクリプトを実行しない方針。

Herdr のペイン内では `HERDR_*` 環境変数がそのセッションを指しているので、テストは必ずこれを外して実行する。外さないと、テストが普段使いのセッションを操作しうる。

```bash
# 型検査
bun run typecheck
# Herdr を使わないテスト(HERDR_* を外し、socket の宛先を存在しないパスに向ける)
env $(env | grep -oE '^HERDR[A-Z_]*' | sed 's/^/-u /') HERDR_TEST_MODE=unit HERDR_SOCKET=/nonexistent/herdr.sock bun test <files>
# Herdr を使うテスト(専用セッション herdr-fleet-test を起動する。テスト後も常駐する)
env $(env | grep -oE '^HERDR[A-Z_]*' | sed 's/^/-u /') bun scripts/ci-tests.ts integration
# 本番ビルド
bun run build
```

- integration テストのうち 1 件(Windows のミラー表示での paste)は、上流の v0.3.45 でも同じように失敗する。attach-held と output flow control の 2 件は、全件をまとめて走らせたときだけ負荷で失敗することがあり、単独で実行すれば通る
- `bun run test:ui` は chromium を `CHROME_PATH`(この PC では `/usr/bin/chromium`)で指定して走らせる。1 つ目の失敗で止まる。fleet 画面だけなら `bun scripts/fleet-screen-regression.ts`(`FLEET_SCREENSHOTS=<dir>` でスクリーンショットを残す)
- `bun run e2e` は実際の pi にプロンプトを送るので、モデルの利用料が発生する。実行の前にユーザーの承認を取る
- テスト用セッションを止めるときは `herdr --session herdr-fleet-test server stop`

## 守ること

- **上流から削除した機能を戻さない。** 自己更新、SSH リモート PC と bridge の登録、OAuth トークンを読む使用量メータ、音声入力の4つ。いずれも、他人のコードを取得して実行するか、認証情報や音声を外部に送る作りだった。使用量は、各 CLI 自身が答える経路(`codex app-server` の `account/rateLimits/read`、`claude -p /usage`、`agy -p /usage`、cursor の対話画面の `/usage`)と、エラー検知によるクールダウンだけで取得する(`server/fleet/usage.ts`)
- **アクセス制御を緩めない。** token も紐付け済みの端末もない状態で通すのは、ループバックのアドレスからループバックの Host で来たリクエストだけ。DNS rebinding を防ぐため。ファイル表示はペインの作業フォルダーと `os.tmpdir()` の配下に限る。push 通知の宛先はブラウザベンダーの push サービスに限る。`git` は `core.fsmonitor=false` で実行する。いずれも回帰テストがある
- **fleet サーバーは GitHub に書き込まない。** スレッドの取り込みの push、PR の作成、マージは、使う人が Fleet 画面で押した操作を `[fleet]` のメッセージで受けたエージェントが行う(lead がブランチの操作、coordinator がマージ。`agents/lead.md`、`agents/coordinator.md`)。サーバーは `gh` で読んで結果を確かめ(`server/fleet/github.ts`)、マージを確かめてから worktree とブランチを消すだけ。gh のサインイン情報は読まない。サーバー自身が手を下すのは、取り消せない確認を経た Discard だけ
- **UI の文言は英語をキーにする。ラベルは英語のまま出し、文だけ `src/lib/i18n.ja.ts` に日本語訳を置く。** 文は、設定の説明、エラーや知らせの本文、確認、案内で、英語をピリオドで終える(`isSentence`)。言語の切り替えは置かない。`src/lib/i18n.test.ts` は、文の訳の欠け、ラベルの訳、使われていない訳で失敗する。文言を消したら、対応する訳も消す
- **Herdr の socket API の癖。** `agent.start` は `launch_pending` のまま即座に返る。準備完了は `agent.get` の `interactive_ready` で判定する(`server/fleet/runtime.ts`)。`herdrRpc` は既定で 10 秒でタイムアウトする。それより長く待つ呼び出しには `timeoutMs` を渡す。`herdr terminal attach` は、つないでいる間ペインのターミナルを attach 側の pty の大きさにし、herdr のレイアウト変更を反映しない(切ると herdr の画面が戻す)。そのため attach はペイン自身の大きさで行い、レイアウトが動いたら一度切って測り直す。ブラウザがペインの大きさを決めるのは、Terminal 表示が前面にあり、そのウィンドウにフォーカスがある間だけ(最後に `resize` した端末が勝つ。tmux の `window-size latest` と同じ)で、フォーカスが外れる(herdr のターミナルに移るなど)・Chat 表示・背面・切断で `release` して herdr の大きさに戻す。大きさを決めていない間は、herdr の大きさの画面を、設定の文字サイズを下限として枠に合わせた文字サイズで描く(`PaneTerminal` の `fitGrid`)。API はペインの列数を返さず、`rect` は枠線込みなので、大きさはシェルの tty から読む(`server/pane-grid.ts`)
- **エージェント CLI の癖。** cursor と agy は、信頼の確認画面やサインイン画面(agy はツール実行の承認画面も)を出していても herdr が `idle` と報告する。adapter の `question` が起動直後とターンの終わりに画面を見て、run を `blocked` にする。cursor は herdr が ready と報告した後に画面を描き、`--add-dir` で渡したフォルダについても信頼を求める。そのため `inputReady` で入力欄が出るまで待ち、結果ディレクトリは run ごとではなく共通の親を渡す。agy は未知のモデルを指定されると、警告だけ出して既定のモデルで起動する。これは `readyError` が起動失敗として扱う。承認は、各 CLI の auto mode(claude `--permission-mode auto`、codex `--approve-for-me`、cursor `--auto-review`、agy `--mode accept-edits`)に任せる。すべてを承認するモードは使わない。codex の `--approve-for-me` はコマンドを workspace-write サンドボックスで動かし、このサンドボックスは fleet サーバーのループバックへの通信も止める。ネットワークは開けず、fleet コマンドが届かなければそのコマンドだけサンドボックスの外での実行を求めるよう、指示文で伝える(求めたものは codex の自動レビューが判断する)。`--approve-for-me` は `--sandbox` と併用できず、`-c sandbox_mode="read-only"` も上書きする。そのため、編集しない役割(`edits: false`)は codex に担わせない。cursor の auto-review は作業フォルダの外への書き込みを承認しないので、cursor の `permissions.allow`(`~/.config/cursor/cli-config.json`)に結果ディレクトリへの `Write(<stateDir>/fleet-results/**)` を足しておく結果は、run ごとの結果ファイル(`<stateDir>/fleet-results/<runId>/handoff.md`)で受け取る
- **使用量の取得口の癖。** `agy -p /usage --output-format json` はモデルを呼ばずに答える(トークン 0)。cursor の `/usage` は対話画面にしかなく、`-p` で送るとモデルに渡る可能性がある。そのため fleet は、ターンが終わった cursor のペインで `/usage` を打ち、Esc で閉じる(実機で確認済み)。解除日はロケールに従って書かれる(ja_JP では `Resets 10月26日`)。`claude -p /usage` もモデルを呼ばずに答えるが、出力は人が読むための文章で、JSON の項目ではない。ユーザーの設定を読むと SessionStart などの hook が probe のたびに動くので、`--setting-sources project` で外す(サインインは設定ではないので効いたまま)。`--bare` は OAuth を読まなくなるので使えない。`--no-session-persistence` でもセッションの記録は残らないが、作業フォルダの `~/.claude/projects/<フォルダ>/memory` は空のまま作られる。そのため probe は、CLI ごとに固定の私用フォルダ(`<stateDir>/usage-probe/<種類>`、0700、実行のたびに空にする)で実行する。フォルダが固定なので、memory のフォルダは 1 つしか作られない。共有の一時フォルダで実行しないのは、ほかのユーザーが置いた `.claude/settings.json` や `CLAUDE.md` を CLI が読みうるため。子プロセスには、起動とサインインに要る環境変数だけを渡す(`server/cli-child.ts`)。`ANTHROPIC_*`・`OPENAI_*`・`GEMINI_*` などの API キーと `HERDR_*` は渡さない。API キーがあると、CLI はプランではなく API の使用量を答えうるため。Explain の `claude -p` も同じ扱い
- **opencode の癖。** 判断する auto mode がない。既定の permission は `"*": "allow"` で、`--auto` は拒否されていないものをすべて承認するので使わない。代わりに adapter の `env` が、ペインの環境変数 `OPENCODE_PERMISSION` で規則を渡す(利用者の設定のあとに足され、最後に当たった規則が勝つ。`adapters.ts` の `opencodePermission`)。編集は通し、シェルは、引数なしの短い一覧と fleet のコマンド以外を ask、Web も ask にする。リダイレクトのあるコマンドは、文全体の文字列(`>` を含む)で規則に当たるため `ls *` のような規則を通り抜ける。そこで一覧は末尾に `*` のない完全一致にし、fleet のコマンドだけ `*` を許し、そのあとに `*>*` `*<*` `*--output*` `*--no-index*` `*--ext-diff*` `*--textconv*` を ask で並べる(最後に当たった規則が勝つ。`adapters.test.ts` が opencode の照合を写して確かめる)。結果ファイルは作業フォルダの外なので、edit の規則(パターンは worktree からの相対パスなので先頭に `*`。その run のフォルダだけ)と `external_directory` の規則で通す。ask の画面は `Permission required` / `Allow once` で、`question` が run を `blocked` にする。`edits: false` は、`OPENCODE_CONFIG_CONTENT` で定義する agent `fleet-readonly`(`edit: * deny` のあとに結果ファイルだけ allow)を `--agent` で選んで実現する。環境変数はペインの作成時に決まり、指示文のファイルはそのあとにできるので、指示文は設定では渡せない。`instructionsInPrompt` で最初のプロンプトの先頭に付ける。TUI に thinking の指定はない(`run --variant` だけ)。使用量を答える口はなく、エラー検知(`<理由> [retrying … attempt #N]` の行)によるクールダウンだけで、プロバイダごとに数える。herdr は opencode の状態を herdr が入れたプラグイン(`~/.config/opencode/plugins/herdr-agent-state.js`)で受けるので、`--pure` / `OPENCODE_PURE` は使わない。そのため、利用者の設定のプラグインと、リポジトリの `.opencode/` の設定、MCP の項目は起動のときに読み込まれる。起動しただけで起きる副作用は `OPENCODE_DISABLE_AUTOUPDATE=true`、`OPENCODE_DISABLE_SHARE=true`、`OPENCODE_DISABLE_LSP_DOWNLOAD=true` で止める。`opencode debug agent <name>` はモデルを呼ばずに、解決後の permission を出す(実機で確かめるときは、HOME と XDG_* を空のフォルダに向ける)
- **CLI を実機で起動する検証の副作用。** gemini や agy は、起動しただけで自分自身を更新することがある。agy は `AGY_CLI_DISABLE_AUTO_UPDATE=true` で止まる(`1` では止まらない)。確認画面で止まっている CLI に選択肢を送ると、その CLI の設定(フォルダの信頼など)が永続的に書き換わる

## コミットと PR

- Conventional Commits で、1 コミット 1 関心事。PR を作って main に merge commit でマージする(コミット単位の履歴を残すため)
- 以下はユーザーの承認を取ってから行う。いずれも外部に出る操作で、取り消しにくいため
  - GitHub への push と PR のマージ
  - モデルの利用料が発生する検証
- README は日本語のみ
