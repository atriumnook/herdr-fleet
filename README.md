# herdr-fleet

[Herdr](https://herdr.dev/) 上で動く複数のコーディングエージェント(pi / Claude Code / Codex / Cursor / Antigravity / OpenCode)を、ブラウザから見て操作するための個人用ツール。

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

## チャット

ペインを Chat 表示にしたときと、Fleet 画面の会話(coordinator の会話と、Overview で開いたスレッドのチャット)に共通の機能です。

### プロンプトのレール

- チャットの右端に、あなたが打ったプロンプト 1 つにつき 1 本の目盛りを並べます。目盛りの位置は会話の中の位置で、今読んでいるプロンプトは太く描きます。プロンプトが 2 つ以上あるとき(1 つでも、前のページがあるとき)に出ます
- ポインタを合わせると、近いプロンプトの本文と、そのターンでしたことをカードで出します。クリックすると、そのプロンプトへ移ります。目盛りはキーボードでも選べます(↑ ↓ Home End で選び、Enter で移る)
- `Mod+Shift+[` で前の、`Mod+Shift+]` で次のプロンプトへ移ります(Mod は macOS では Cmd、それ以外では Ctrl)。会話が開いているときだけ受け付けます。キーは 設定 → Shortcuts で変えられます
- パレットに語を打つと、開いている会話のプロンプトのうち、その語を含むものを 5 件まで出します。選ぶと、そのプロンプトへ移ります
- タッチ画面では、ボタンからプロンプトの一覧をシートで開きます
- fleet が送ったメッセージ(`[fleet]` で始まるもの)はプロンプトに数えません。ペインの会話から頼んだ依頼は、`[from pane …]` の行を除いて出します

### 質問のカードと Explain

- エージェントが返答の最後に平文で質問したときは、チャットに質問のカードを出します。判定にモデルは使わず、最後の文が `?` で終わるか、日本語の問いかけの言い方で終わるかを見ます。引用・コード・URL の中の `?` と、「ご不明な点は…」のような締めの挨拶は除きます。推測なので、カードを出してもペインを Needs you にはしません
- 返答の最後に選択肢の箇条書きがあれば、カードに並べます。押すと、その選択肢をメッセージ欄に入れます。送るのはあなたです。メッセージ欄に書きかけの文があるときは押せません
- 承認の画面のカードには、あなたが最後に送ったメッセージを 1 行で添えます(長い作業のあとの質問でも、何を頼んだかが分かるように)
- 承認の画面のカードと質問のカードには Explain があります。押すと、その質問の理由、各選択肢の結果、どれを選ぶとよいかを Claude Haiku が説明します
- **Explain は会話の一部を外部に送ります。** 押したときだけ、claude の CLI 自身のサインインで `claude -p` を 1 回実行し、次を Anthropic に送ります。質問と選択肢、あなたの直近 3 つのメッセージ(各 600 字まで)、あなたの最後のメッセージより後のツール呼び出しの要約(新しい 12 件まで)、エージェントの文章で、全体で 12,000 字までです。ペインのエージェントが claude 以外でも送ります。ボタンの横にも、送るものを書いています。あなたの Claude の利用枠を使います
- `claude -p` は、ツール・MCP・個人の設定と hook を使わず(`--tools "" --strict-mcp-config --setting-sources project`)、セッションを残さず(`--no-session-persistence`)、毎回空にした `<stateDir>/explain/work` の中で動きます。渡す環境変数は起動とサインインに要るものだけで、`ANTHROPIC_*`・`CLAUDE_CODE_*`・`HERDR_*` は渡しません
- 同時に動くのは 1 本で、待つのは 2 本までです。同じ内容の説明は 10 分間使い回し、90 秒で打ち切ります。claude の使用量が上限を超えているか、クールダウン中(「使用量と振り分け」)は呼び出しません。閲覧専用の端末からは使えません
- 説明の中のリンクは、クリックできない文字で出します

## 設定

Fleet 画面のサイドバーの Fleet settings で、fleet の設定を変えます。変更するたびに `~/.config/herdr-fleet/fleet.json` に保存し、画面で扱わない項目はそのまま残します。fleet は設定を使うたびにこのファイルを読み直すので、サーバーを再起動する必要はありません。fleet.json が JSON として読めないときは、上書きせずにエラーを出します。手で直してから変えてください。閲覧専用の端末では変えられません。

- Roles: 役割ごとに、CLI とモデルの候補を試す順に並べます。thinking の段階も役割ごとに選べます。今の使用量でどの候補が起動するかと、候補を飛ばす理由を出します。ファイルを編集しない役割(coordinator と architect)には、編集を止められる CLI(今は claude と pi)だけを選べます。プロジェクトの `.herdr-fleet/fleet.json` がその役割を設定しているときは、そのプロジェクトではそちらの候補で起動することを示します。Reset to default を押すと、役割の定義ファイルの候補に戻ります
- Usage: 候補を飛ばす使用率(`maxUsedPercent`)と、クールダウンの長さ(`rateLimitCooldownMinutes`)
- Projects: プロジェクトごとの準備のコマンド(下の「スレッド」)
- Limits: 同時に起動・作業するエージェントの数(`maxConcurrent`)と、手伝いのペインをターンの終わりに閉じるか(`closeOnSettle`)
- Entrances: ペインの会話から頼むためのスキルを置くか(下の「ペインの会話から頼む」)。これだけは fleet.json ではなく、各 CLI のスキルのフォルダに書きます

## 使用量と振り分け

fleet はエージェントを起動する前に、その CLI のサブスクの使用量を確かめます。どちらかの枠(5 時間・週・月)の使用率が `maxUsedPercent`(既定 90)以上なら、その候補を飛ばします。rate limit のエラーで止まった CLI もクールダウンに入れて飛ばします。クールダウンは、エラー文に解除時刻があればその時刻まで、なければ `rateLimitCooldownMinutes`(既定 60 分)の間続きます。

使用量は、各 CLI 自身に問い合わせて取得します。認証情報のファイルは読みません。
Fleet 画面を開いている間は、codex・claude・agy の使用量を 5 分ごとに自動で取り直します(いずれもモデルを呼ばないので、トークンを使いません)。取得に失敗する CLI は、間隔を倍々に延ばし、最大 1 時間おきにします。cursor は自動では読まず、ターンが終わったときか、Refresh usage を押したときに読みます。左の一覧に、最後に読んだ時刻を出します。

| CLI | 取得方法 |
|---|---|
| Codex | `codex app-server` の `account/rateLimits/read` |
| Claude Code | `claude -p /usage`(モデルを呼ばず、セッションも保存しない)。全モデル共通の 5 時間枠と週枠を使う |
| Antigravity | `agy -p /usage`(モデルを呼ばないので、トークンを消費しない)。Gemini とそれ以外のモデル群で別々に数える |
| Cursor | ターンが終わったペインで `/usage` を開いて画面から読む。前回の値から 10 分以上たったときだけ読む |
| pi | 取得しない。エラー検知によるクールダウンだけで扱う |
| OpenCode | 取得しない。エラー検知によるクールダウンだけで扱う。プロバイダ(`anthropic/...` の `anthropic`)ごとに別々に数える |

OpenCode は、モデルを `opencode:<プロバイダ>/<モデル>` の形で指定します。ほかの CLI と違う点は次のとおりです。

- 要求を判断する auto mode がありません(既定はすべて許可で、`--auto` はすべて承認します)。fleet は `--auto` を使わず、起動するペインの環境変数 `OPENCODE_PERMISSION` で規則を渡します。ファイルの編集は通します。シェルのコマンドは、引数なしの短い一覧(`git status`、`git ls-files`、`ls`、`pwd`)と fleet のコマンドを除いて、実行の前に使う人へ確かめます。push もここに入ります。リダイレクト(`>`、`<`)や `--output`、`--no-index`、`--ext-diff`、`--textconv` を含むコマンドは、一覧にあっても確かめます。`git diff`、`git log`、`git show` は、リポジトリの設定が指す外部の差分コマンドを動かしうるので、引数なしでも確かめます。OpenCode は、リダイレクト付きのコマンドを文全体の文字列で規則に当てるためです。結果ファイルへの編集は、その run のフォルダだけ通します。Web の取得と検索も確かめます。確かめる画面が出ている間、run は blocked になります。自分の opencode の設定で agent ごとに permission を書いていると、それが fleet の規則より優先されることがあります
- 自己更新、セッションの共有、言語サーバーのダウンロードは、ペインの環境変数で止めます。プラグインは止めません。herdr が opencode の状態を知るために使っているからです。そのため、利用者の設定にあるプラグインと、リポジトリの `.opencode/` の設定、MCP の項目は、起動のときに読み込まれます
- 指示文は、設定ではなく最初のプロンプトの先頭に付けます。thinking の段階は渡せません
- `edits: false` の役割は、fleet が環境変数で定義するエージェント `fleet-readonly` で起動します。結果ファイルのほかは編集できません

役割の `fallbackModels` には、同じ CLI のモデルのほかに、`<agent>:<model>` の形で別の CLI を並べられます(例: `["codex:gpt-6", "claude:claude-sonnet-5-5"]`)。fleet は、最初に使える候補で起動します。どの候補も使えなければ、理由を並べて起動を断ります。`fleet spawn --model codex:gpt-6` のように、呼び出し側から別の CLI を指定することもできます。

Web UI では、ヘッダーの Fleet ボタン(対応が必要な run の数を表示)から Fleet 画面を開けます。

- 左の一覧は、プロジェクト(coordinator とスレッドが働いたリポジトリ)と、各アカウントの使用量です。New project でフォルダを選ぶと、新しいプロジェクトになります
- 中央は、そのプロジェクトの coordinator との会話です。coordinator のペインのチャットそのもので、coordinator が起こしたスレッドは、起こしたターンの下にカードで出ます。coordinator がいないプロジェクトでは、最初の依頼を送ると coordinator が起動します
- 右の Overview は、スレッドを Needs you(失敗も含む)、Ready for review、Landing(PR を出した)、Working、Idle の順にまとめます。Resolved は畳みます。Agents は、スレッドの外で動いているエージェントです
- スレッドを開くと、Overview の中に lead のチャットが開きます。lead と手伝いを切り替えられ、承認の画面にもここで答えます。拡大すると中央いっぱいに開きます。Terminal で、そのペインを Pane 画面で開きます。Resolve で済みにできます
- ブランチを持つスレッドには Chat / Changes / Checks のタブと、取り込みの操作が付きます(下の「スレッドの取り込み」)
- 幅の狭い画面では、Overview は下からのシートになり、開いたスレッドは画面全体に出ます

```bash
fleet usage             # 使用量とクールダウンの一覧(古い値は取り直す。--refresh ですべて取り直す)
fleet usage clear agy   # クールダウンを解除する(アカウント名、CLI 名、または省略ですべて)
```

## スレッド

スレッドは、プロジェクトの作業の 1 単位です。専用のワークスペースを持ち、git リポジトリでは専用の worktree(ブランチ `fleet/<id>`)で作業します。worktree はリポジトリの中の `.herdr-fleet/worktrees/<id>` に作ります。リポジトリを信頼済みの CLI(claude、codex、cursor で確認)は、その下のフォルダについて改めて信頼を聞かないためです。元のチェックアウトの `git status` に出ないよう、リポジトリの `.git/info/exclude` に 1 行足します(`.gitignore` は変えません)。スレッドの lead は自分でも手を動かし、他のエージェントに渡した作業は、そのワークスペースのタブに 1 人ずつ開きます。lead は、受け入れ条件を結果ファイルの隣の `contract.md` に書き、それと照らし合わせて終わります。

```bash
fleet thread --title "通知の重複を直す" --task "リトライで通知が 2 回届く。再現してから直す。"
```

新しい worktree には依存が入っていないので、lead が起動する前に走らせる準備のコマンドを、リポジトリごとに設定画面の Projects で書けます(保存先は `~/.config/herdr-fleet/fleet.json`)。リポジトリ側の `.herdr-fleet/fleet.json` に書いたものは使いません(リポジトリが、fleet に実行させるコマンドを決められないようにするため)。

```json
{ "projects": { "/home/me/git/app": { "setup": "bun install --ignore-scripts" } } }
```

### 計画

lead は、大きい変更(おおむね 3 ファイルを超える変更か、使う人に見える振る舞いの変更)を作る前に、計画を JSON で書いて `fleet plan <file.json>` で渡し、BLOCKED でターンを終えます。fleet は計画を検査し、コードの抜粋をスレッドの worktree から読んで、`<stateDir>/fleet-plans/<run id>.json` に保存します。保存先は lead が書く結果フォルダの外で、読むたびに検査し直し、検査を通らないものは表示しません。抜粋は worktree の中のファイルだけを読みます(symlink は解決してから確かめます)。計画に問題があれば、fleet は問題をすべて並べて lead に返します。

計画は主張の木です。1 段目は使う人ができること・見えることを 1 つずつ、2 段目はその仕組み、3 段目は場所(`file:line`)を書きます。各主張には証拠を 1 つ付けます(worktree のコードの行、lead が提案するコード、スキーマ、呼び出しの流れ、箇条書き)。使う人が決めることは、それが変える主張の上に置き、推奨の選択肢を付けます。1 つの計画で決めることは 5 個までです。

lead が BLOCKED で止まると、スレッドは Needs you になります。Fleet 画面でスレッドを開くと Plan タブが出ます。木は 1 段目だけを閉じた状態で出し、開くと証拠・決めること・下の段が出ます。使う人は選択肢を選び、主張にコメントを付け、Respond を押します。確認のあと、fleet が回答を `[fleet]` で始まる 1 通にまとめて lead に送ります。開かなかった決定は lead の推奨のままとして送り、そう書きます。コメントは引用として送り、lead にはコマンドとして扱わないよう指示しています。lead のターンが終わっているときだけ送れます。lead が新しい計画を出すと版が上がり、古い版への回答は断ります。回答がないまま lead の次のターンが終わると(coordinator が会話で決まったことを伝えた場合など)、fleet はその計画を閉じ、それ以降は回答を受け付けません。coordinator は計画に答えず、使う人を Plan タブに案内します。

### スレッドの取り込み

スレッドの変更を main(スレッドを起こしたときに元のチェックアウトがいたブランチ)に入れる作業も、エージェントが行います。lead は自分のブランチにコミットするだけで、push、PR の作成、マージ、ほかのブランチの変更は、使う人が Fleet 画面でその操作を押したときだけ行います。押した操作は `[fleet]` で始まるメッセージで届き、その 1 つの操作だけを承認したものとして扱います(`agents/lead.md`、`agents/coordinator.md`)。

| 操作 | 誰が行うか | 内容 |
|---|---|---|
| Send to lead | lead | Changes で行に付けたコメントを、1 通にまとめて送る。lead は直してコミットする |
| Update branch | lead | main をブランチに取り込み(merge)、確かめ直してコミットする |
| Create PR | lead | ブランチを push し(force push はしない)、`gh pr create` で PR を作る。マージはしない |
| Fix CI | lead | 落ちたチェックのログを読んで直し、PR のブランチに push する |
| Merge into main | coordinator | 元のチェックアウトで `git merge --no-ff` する。未コミットの変更があるか別のブランチにいれば、手を止めて知らせる。push はしない |
| Merge PR | coordinator | `gh pr merge --merge` でマージし、元のチェックアウトを `git pull --ff-only` で最新にする |
| Discard | fleet | lead と手伝いのペインを閉じ、worktree とブランチを消す。取り消せない |

Merge into main、Merge PR、Discard は、何が起きるかと取り消せるかを示す確認を挟みます。lead の操作は lead の手が空いているとき(ターンが終わっているとき)だけ押せます。coordinator の操作は、coordinator の手が空くのを待って渡します。coordinator がいなければ起動して渡します。

エージェントの報告をそのまま信じず、エージェントのターンが終わったら、fleet が git と GitHub を読んで操作が済んだかを確かめます。PR があるか、ブランチが main に入ったか、PR がマージされたか、を見ます。済んでいなければ、スレッドは Needs you になり、見つけたことをスレッドに出します。マージを確かめたら、fleet がペインを閉じ、worktree とブランチを消して、スレッドを Resolved にします。コミットされていない作業が worktree に残っていれば、worktree は消さずに残し、そう知らせます。ブランチは、git がマージ済みと言うときか、GitHub がマージしたコミットがこのブランチの指すコミットと同じときだけ消します。

Checks は、マージの前に確かめることをまとめて出します。開いたときに git と GitHub を読みます。

- Branch: worktree にコミットされていない変更がないか、main から遅れていないか(遅れていれば Update branch)
- Thread: 受け入れ条件、lead と別の CLI でのレビュー、まだ送っていないコメント
- Pull request: PR の状態と CI。CI が落ちるとスレッドは Needs you になる

GitHub は `gh` で読みます。サインインは gh が持っているもので、fleet はトークンを読みません。fleet 自身は GitHub に書き込みません(push、PR の作成、マージはエージェントが行います)。PR が開いているスレッドがある間は、fleet が 1 分おきに PR とチェックを読み直します。使う人が GitHub でマージしたときも、それを見つけてスレッドを片付けます。main から遅れているかどうかは、手元の main と比べます(fetch はしません)。

push とマージは、エージェントが指示と各 CLI の auto mode のもとで行います。指示に反した push を技術的に止める仕組みはありません。fleet が後から確かめるだけです。codex は `--approve-for-me` のサンドボックスがネットワークを止めるので、push のたびにサンドボックスの外での実行を求め、その可否は codex の自動レビューが決めます。

## coordinator

coordinator は、プロジェクトに 1 人の、使う人が話しかける相手です。git リポジトリ(リポジトリでなければそのフォルダ)ごとに 1 人で、元のチェックアウトにある専用のワークスペース「<リポジトリ名> · fleet」で動きます。コードを読んで答え、手を動かす依頼はスレッドに分けて起こします。自分ではファイルを編集しません。そのため、編集の道具を外して起動できる CLI だけが、coordinator を担います。今は claude と pi です。codex は、`--approve-for-me` が読み取り専用のサンドボックスを上書きするため、外しています。coordinator はスレッドの終わりを待ちません。

lead が迷ったときは、迷いの種類で行き先が決まります。

- どう作るか(設計、方式、既存のコードとの整合): lead が architect に聞きます。architect はコードを根拠に答え、ファイルは編集しません。何を作るかは決めず、そういう問いだとわかったら BLOCKED で返します
- 何を作るか・なぜ作るか(要件、範囲、優先度): 取り消せる仮定で先へ進めるなら、lead は最も妥当な仮定を置いて進み、HANDOFF の Assumptions に書きます。取り消しにくいときだけ、選択肢・推奨・architect の見立てを付けた BLOCKED の HANDOFF で尋ねます
- 実行してよいか: 各 CLI の承認画面で、使う人に直接聞きます

lead が BLOCKED でターンを終えると、fleet がその HANDOFF を問いとしてスレッドの run に残します。coordinator の手が空いたら(fleet が渡したターンが終わり、herdr も作業中と言っておらず、入力欄に使う人の打ちかけの文がないとき)、溜まった問いを `[fleet]` で始まる 1 通にまとめて渡します。打ちかけの文があれば、少し待ってからもう一度試します(今は claude の入力欄を見分けます)。coordinator は、使う人がこの会話で既に決めたことならそれを lead に `fleet send` で伝え、そうでなければ選択肢と推奨を付けて使う人に聞きます。coordinator が動いていない間の問いは、そのプロジェクトで次に起動した coordinator に渡します。問い以外(PASS、ISSUES、失敗、画面での承認待ち)は coordinator を起こさず、スレッドの一覧と push 通知で使う人に届きます。承認の画面には、coordinator は答えません。

`fleet threads` は、スレッドごとに状態を返します。Working(lead が作業中)、Needs you(lead の問いか承認の画面、済まなかった取り込みの操作、落ちた CI で、使う人を待っている)、Ready for review(PASS で終わった)、Landing(PR が開いている)、Idle(それ以外で終わった)、Failed(失敗した)、Ended(ペインが閉じた)、Resolved(使う人が済みにしたか、取り込んだか捨てた。lead がまた動くと外れる)のいずれかです。PR があれば、その番号、状態、CI、URL も出します。

```bash
fleet project --task "通知の重複と README の古い記述を直して"   # coordinator がいなければ起動し、いればこの依頼を渡す
fleet threads                                                     # このプロジェクトのスレッド: 状態、ブランチ、HANDOFF の 1 行目、受け入れ条件
```

役割の定義に `edits: false` と書くと、その役割はファイルを編集しない役割になります(claude では Edit / Write / NotebookEdit を、pi では `--exclude-tools edit,write` で edit と write を外して起動します)。編集を止められない CLI の候補は、理由を記録して飛ばします。シェルのコマンドは使えるので、シェルでの書き込みは指示文と各 CLI の auto mode で抑えます。pi には auto mode がないので、指示文だけが歯止めです。

## ペインの会話から頼む

herdr のペインで動いているエージェント CLI(claude、pi、codex、cursor、agy)の会話からも、fleet に頼めます。会話で「fleet に頼んで」と言うと、CLI がそのリポジトリの coordinator に頼みごとを送ります。Fleet 画面の会話欄から送るのと同じ扱いで、coordinator がいなければ起動します。

使う前に、Fleet settings の Entrances で、スキル herdr-fleet を置きます。置く先は、各 CLI がスキルを読む次の 3 つのフォルダです。

| フォルダ | 読む CLI |
|---|---|
| `~/.claude/skills` | claude、cursor |
| `~/.agents/skills` | pi、codex、cursor |
| `~/.gemini/config/skills` | agy |

- スキルのファイルに書くのは、fleet コマンドの場所とサーバーのアドレスだけです。頼み方は、CLI がそのつど `fleet guide` で読みます。そのため herdr-fleet を更新してもファイルを書き直す必要はありません。herdr-fleet のフォルダかポートが変わったときは Outdated と出るので、Update で書き直します。fleet が書いていないファイルが同じ場所にあれば、上書きも削除もしません
- CLI は、会話で分かったこと(原因、決めた方針、関係するファイル、完了の条件)を頼みごとの本文に書きます。coordinator はペインの会話を読めないためです
- 頼んだ仕事は coordinator に引き渡します。ペインの CLI は完了を待ちません。coordinator の返事とスレッドは Fleet 画面と通知に出て、ペインの会話には戻りません。送り返すと、そのペインで打ちかけの文に割り込むためです。進み具合を聞かれたときは、CLI が `fleet threads` で答えます
- 届いた頼みごとには、Fleet 画面の会話で「From a pane」と、送ったペインの名前が付きます。Open pane を押すと、そのペインを Pane 画面で開きます
- fleet が起動したエージェント(`HERDR_FLEET_RUN` があるもの)は、このスキルを使いません。`fleet project` も断ります。報告は、指示文にある相手にします
- サーバーにトークンを設定しているときは、ペインに `HERDR_FLEET_TOKEN` がないと送れません。スキルにはトークンを書きません
- ペインの codex がサンドボックスで fleet サーバーに届かないときは、CLI がそのコマンドだけサンドボックスの外での実行を求めます

## 開発

```bash
bun run typecheck
bun run test:unit          # Herdr を使わないテスト
bun run test:integration   # Herdr を使うテスト
bun run build
```

- `bun test` を実行すると、まず `scripts/test-herdr.ts` が preload され、テスト専用の Herdr セッション `herdr-fleet-test` を起動する。このセッションはテスト後も常駐する。止めるときは `herdr --session herdr-fleet-test server stop`
- `bun run test:unit` は `HERDR_TEST_MODE=unit` を付けて preload を止めるが、`HERDR_*` 環境変数はそのまま引き継ぐ。Herdr のペイン内で実行すると普段使いのセッションに接続しうるので、`HERDR_*` を外して実行する

## 目指す姿

複数のサブスク(Claude Code / Codex / Cursor / Antigravity / OpenCode / pi)を、一つのチームとして働かせます。使う人は Web UI で「これをやって」と頼むだけで済み、役割の割り振りと、使用量に応じた CLI の選び分けは fleet が行います。頼む、経過を見る、取り込む、設定する、は Fleet 画面でできます。ペインで動いている CLI の会話からも頼めます。目指す形は次のとおりです。

- **窓口は Web UI。** 頼む、設定する、経過を見る、呼ばれたら判断する、を画面で完結させる。`fleet` CLI と `fleet.json` は、エージェント同士と内部で使う手段で、使う人が知っている必要はない
- **話しかける相手はプロジェクトに 1 つの会話。** その会話の coordinator が、頼まれたことをスレッドに分けて起こし、進み具合を追い、質問に答え、結果を報告する
- **スレッドは専用のブランチと会話を持つ。** 1 つのスレッドに 1 つのワークスペースと、git リポジトリなら 1 つの worktree。スレッドの lead は自分でも手を動かし、並べて進められる部分、広い調査、別の CLI の目が要るレビューだけを他のエージェントに渡す。渡したエージェントはそのワークスペースのタブに 1 人ずつ開き、表示中の画面は奪わない。渡した結果はファイルで受け取り、会話には要点だけを入れる
- **CLI は使用量で選ぶ。** スレッドの lead と渡す先は、役割ごとの候補の順番と使用量で CLI を選ぶ。coordinator は、編集を止められる CLI に限る(今は claude と pi)。レビューは、書いた CLI とは別の CLI に回す
- **スレッドの一生を状態で示す。** 作業中、待っている、結果を見てほしい(マージする・PR を作る・捨てるを選ぶ)、取り込み中、閉じた。エージェント 1 人の状態(Working / Needs you / Done / Idle / Failed)とは別に数える
- **質問はまず持ち主へ。** スレッドの lead が迷ったら coordinator に聞き、coordinator が決められないときだけ使う人に聞く。コマンドの承認は使う人だけが答え、fleet が代わりに答えることはしない。呼ぶときは画面と push 通知で知らせる
- **スレッドを閉じると片付ける。** ワークスペースと worktree を消す(マージしていない変更があれば先に確かめる)。準備のコマンド(依存のインストールなど)はプロジェクトごとに設定する
- **設定は画面から。** 役割ごとの CLI とモデルの候補の順番、使用量の上限を設定画面で変える。保存先は `fleet.json`
- **ペインの会話から頼む経路は追加の入口。** pi や Claude Code などの会話から、スキル herdr-fleet を通して coordinator に頼む。このスキルは fleet コマンドを呼ぶだけなので、herdr-fleet の作りを縛らない

## ライセンス

MIT。上流の著作権表示は [LICENSE](LICENSE) に、派生元の情報は [NOTICE](NOTICE) にあります。
