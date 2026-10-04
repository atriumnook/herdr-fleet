# herdr-fleet

[Herdr](https://herdr.dev/) 上で動く複数のコーディングエージェント(pi / Claude Code / Codex / Cursor / Antigravity)を、ブラウザから見て操作するための個人用ツール。

現時点の中身は、[herdr-web-ui](https://github.com/devswha/herdr-web-ui) v0.3.45 から派生した Web UI です。上流の履歴は取り込んでおらず、起点のコミットは [NOTICE](NOTICE) に記録しています。上流の変更は自動では取り込まず、差分を読んでから手で移します。

## 上流から外したもの

外部へ送信するもの、他人のコードを取得して実行するもの、認証を弱めるものを中心に削除しました。

| 機能 | 外した理由 |
|---|---|
| 自己更新(updater / supervisor)、Herdr 本体の更新 | git タグからの clone・ビルド・切り替えを自動で行う |
| リモート PC(SSH)、bridge の登録 | GitHub Releases のバンドルを配布して実行し、リモートの `authorized_keys` に追記する |
| 使用量メータ | 各サービスの OAuth トークンを読んで、非公開のエンドポイントを呼ぶ |
| 音声入力 | 音声と API キーを OpenAI に送る |
| Herdr プラグイン定義、install スクリプト | ビルドと起動のコマンドが自動で実行される |
| 韓国語・中国語の翻訳、配布サイト、動画素材 | 使わない |

## アクセス制御

- token(`HERDR_FLEET_TOKEN`)も紐付け済みの端末もないリクエストは、このPC上からループバックの Host で来たものだけを通す。DNS rebinding で来たリクエスト(送信元はループバックでも Host が外部名)は拒否する
- 他の端末は、PC 上の 設定 → デバイス で発行したペアリングコードで紐付ける
- ファイルの表示は、ペインの作業フォルダーと一時フォルダー(`os.tmpdir()`)の配下に限る。シンボリックリンクは解決してから判定する
- push 通知の宛先は、ブラウザベンダーの push サービス(FCM / Mozilla / Apple / WNS)に限る
- `@` 補完のための `git ls-files` は、`core.fsmonitor` を無効にして実行する

## 必要なもの

- [Herdr](https://herdr.dev/)
- [Bun](https://bun.sh/)
- Node.js(ターミナル表示の PTY sidecar に使う)

## 起動

```bash
bun install --ignore-scripts
bun run start
```

既定では `http://127.0.0.1:7317` で待ち受けます。

| 環境変数 | 意味 |
|---|---|
| `HOST` / `PORT` | 待ち受けアドレス(既定 `127.0.0.1` / `7317`) |
| `HERDR_FLEET_TOKEN` | アクセストークン。設定すると、ループバックからのアクセスにも token か紐付け済み端末が必要になる |
| `HERDR_FLEET_STATE_DIR` | 状態(紐付けた端末、push の鍵と購読)の保存先。既定は `~/.config/herdr-fleet` |
| `HERDR_FLEET_HERDR_BIN` | 使う `herdr` 実行ファイル |
| `HERDR_FLEET_TAILSCALE_OWNER` | Tailscale 経由で入れる所有者のログイン名 |
| `HERDR_FLEET_PUSH_SUBJECT` | push 通知の VAPID subject |

## 使用量と振り分け

fleet はエージェントを起動する前に、その CLI のサブスクの使用量を確かめます。どちらかの枠(5 時間・週・月)の使用率が `maxUsedPercent`(既定 90)以上なら、その候補を飛ばします。rate limit のエラーで止まった CLI もクールダウンに入れて飛ばします。クールダウンは、エラー文に解除時刻があればその時刻まで、なければ `rateLimitCooldownMinutes`(既定 60 分)の間続きます。

使用量は、各 CLI 自身に問い合わせて取得します。認証情報のファイルは読みません。

| CLI | 取得方法 |
|---|---|
| Codex | `codex app-server` の `account/rateLimits/read` |
| Claude Code | `claude -p /usage`(モデルを呼ばず、セッションも保存しない)。全モデル共通の 5 時間枠と週枠を使う |
| Antigravity | `agy -p /usage`(モデルを呼ばないので、トークンを消費しない)。Gemini とそれ以外のモデル群で別々に数える |
| Cursor | ターンが終わったペインで `/usage` を開いて画面から読む。前回の値から 10 分以上たったときだけ読む |
| pi | 取得しない。エラー検知によるクールダウンだけで扱う |

役割の `fallbackModels` には、同じ CLI のモデルのほかに、`<agent>:<model>` の形で別の CLI を並べられます(例: `["codex:gpt-6", "claude:claude-sonnet-5-5"]`)。fleet は、最初に使える候補で起動します。どの候補も使えなければ、理由を並べて起動を断ります。`fleet spawn --model codex:gpt-6` のように、呼び出し側から別の CLI を指定することもできます。

Web UI では、ヘッダーの Fleet ボタン(対応が必要な run の数を表示)から Fleet 画面を開けます。対応が必要なもの、失敗したもの、作業中のもの、完了したものの順に run を並べ、使用量とクールダウンを見出しの横に表示します。run を選ぶと、問いかけ、振り分けの経緯、結果を見られます。

```bash
fleet usage             # 使用量とクールダウンの一覧(古い値は取り直す。--refresh ですべて取り直す)
fleet usage clear agy   # クールダウンを解除する(アカウント名、CLI 名、または省略ですべて)
```

## 開発

```bash
bun run typecheck
bun run test:unit          # Herdr を使わないテスト
bun run test:integration   # Herdr を使うテスト
bun run build
```

- `bun test` を実行すると、まず `scripts/test-herdr.ts` が preload され、テスト専用の Herdr セッション `herdr-fleet-test` を起動する。このセッションはテスト後も常駐する。止めるときは `herdr --session herdr-fleet-test server stop`
- `bun run test:unit` は `HERDR_TEST_MODE=unit` を付けて preload を止めるが、`HERDR_*` 環境変数はそのまま引き継ぐ。Herdr のペイン内で実行すると普段使いのセッションに接続しうるので、`HERDR_*` を外して実行する

## 今後

既存の画面を、Passive View と状態機械の Mediator からなる構成(`src/ui/`)と、Liquid / Spatial UI の見た目に、1 つずつ移していく予定です。

## ライセンス

MIT。上流の著作権表示は [LICENSE](LICENSE) に、派生元の情報は [NOTICE](NOTICE) にあります。
