# herdr-fleet

Herdr 上で複数のコーディングエージェント(pi / Claude Code / Codex / Cursor / Antigravity)を役割分担させ、ブラウザから見て操作するための個人用ツール。herdr-web-ui v0.3.45 の fork で、上流の履歴は取り込んでいない(起点は NOTICE)。上流の変更は自動では取り込まず、差分を読んでから必要な分だけ手で移す。

## 構成

- `server/` — Bun の単一プロセス。HTTP / WebSocket(`index.ts`)、Herdr の socket クライアント(`herdr/client.ts`)、全ペインの状態イベントを購読する collector(`collector.ts`)、ターミナル表示用の PTY sidecar(`pty/`)、承認画面の解析(`prompt.ts`)、会話ログの解析(`conversation.ts` ほか)
- `server/fleet/` — エージェントを起動してターンを追う orchestrator。エージェント CLI ごとの違いは `adapters.ts` に閉じ込め、orchestrator は種別に依存させない。HTTP API は `/api/fleet/*`(`api.ts`)
- `bin/fleet.ts` — `/api/fleet` を呼ぶ薄い CLI。起動されたエージェントは、指示文と環境変数(`HERDR_FLEET_URL` / `HERDR_FLEET_GROUP` / `HERDR_FLEET_DEPTH`)を通じてこれを使う
- `agents/*.md` — 同梱の役割定義。ユーザー分は `~/.config/herdr-fleet/agents/`、プロジェクト分は `.herdr-fleet/agents/` に置き、後に読んだものが同名の役割を上書きする
- `src/` — React の Web UI。`shared/` はサーバとクライアントで共有する型

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

- integration テストのうち 2 件(attach 中の resize、Windows のミラー表示での paste)は、上流の v0.3.45 でも同じように失敗する。attach-held と output flow control の 2 件は、全件をまとめて走らせたときだけ負荷で失敗することがあり、単独で実行すれば通る
- `bun run e2e` は実際の pi にプロンプトを送るので、モデルの利用料が発生する。実行の前にユーザーの承認を取る
- テスト用セッションを止めるときは `herdr --session herdr-fleet-test server stop`

## 守ること

- **上流から削除した機能を戻さない。** 自己更新、SSH リモート PC と bridge の登録、OAuth トークンを読む使用量メータ、音声入力の4つ。いずれも、他人のコードを取得して実行するか、認証情報や音声を外部に送る作りだった。使用量は、公式の経路(`codex app-server` の `account/rateLimits/read`、Claude の statusLine の `rate_limits`)と、エラー検知によるクールダウンだけで取得する
- **アクセス制御を緩めない。** token も紐付け済みの端末もない状態で通すのは、ループバックのアドレスからループバックの Host で来たリクエストだけ。DNS rebinding を防ぐため。ファイル表示はペインの作業フォルダーと `os.tmpdir()` の配下に限る。push 通知の宛先はブラウザベンダーの push サービスに限る。`git` は `core.fsmonitor=false` で実行する。いずれも回帰テストがある
- **UI の文言は英語をキーにして、`src/lib/i18n.ja.ts` に日本語訳を置く。** `src/lib/i18n.test.ts` は、訳の欠けと使われていない訳の両方で失敗する。文言を消したら、対応する訳も消す
- **Herdr の socket API の癖。** `agent.start` は `launch_pending` のまま即座に返る。準備完了は `agent.get` の `interactive_ready` で判定する(`server/fleet/runtime.ts`)。`herdrRpc` は既定で 10 秒でタイムアウトする。それより長く待つ呼び出しには `timeoutMs` を渡す
- **エージェント CLI の癖。** cursor と agy は、信頼の確認画面やサインイン画面(agy はツール実行の承認画面も)を出していても herdr が `idle` と報告する。adapter の `question` が起動直後とターンの終わりに画面を見て、run を `blocked` にする。agy は未知のモデルを指定されると、警告だけ出して既定のモデルで起動する。これは `readyError` が起動失敗として扱う。結果は、run ごとの結果ファイル(`<stateDir>/fleet-results/<runId>/handoff.md`)で受け取る
- **CLI を実機で起動する検証の副作用。** gemini や agy は、起動しただけで自分自身を更新することがある。agy は `AGY_CLI_DISABLE_AUTO_UPDATE=true` で止まる(`1` では止まらない)。確認画面で止まっている CLI に選択肢を送ると、その CLI の設定(フォルダの信頼など)が永続的に書き換わる

## コミットと PR

- Conventional Commits で、1 コミット 1 関心事。PR を作って main に merge commit でマージする(コミット単位の履歴を残すため)
- 以下はユーザーの承認を取ってから行う。いずれも外部に出る操作で、取り消しにくいため
  - GitHub への push と PR のマージ
  - モデルの利用料が発生する検証
- README は日本語のみ
