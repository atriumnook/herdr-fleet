# herdr-fleet

herdr-fleet は、herdr のペインで動く複数のコーディングエージェントに役割を分けて仕事を渡し、その画面と会話をブラウザやデスクトップから見て操作するための道具である。この用語集は、Rust への置き換えの ADR、crate、型の名前で使う語を定める。

## herdr の側

**herdr**:
ターミナルのペインをセッション・ワークスペース・タブに並べて動かす、herdr-fleet の土台のプログラム。herdr-fleet は herdr を通じてペインを読み書きする。

**セッション(session)**:
1 つの herdr のサーバーが持つ、ワークスペースの集まり全体。
_Avoid_: 会話のセッション(エージェント CLI の会話の記録は「transcript」と呼ぶ)

**ワークスペース(workspace)**:
herdr のセッションの中で、タブをまとめる単位。thread は 1 つのワークスペースを持つ。
_Avoid_: Cargo の workspace(Rust の crate の集まりは「Cargo workspace」と書く)

**ペイン(pane)**:
herdr の中で 1 つのプログラムが動くターミナルの区画。herdr-fleet が見て操作する最小の対象。
_Avoid_: ウィンドウ、ターミナル(ペインの画面の描画を指すときは「ターミナル表示」)

**エージェント(agent)**:
ペインの中で動いているエージェント CLI の 1 つの実行。
_Avoid_: bot、worker(worker は役割の名前)

**エージェント CLI(agent CLI)**:
エージェントとして動かすコマンドラインのプログラム。pi、Claude Code、Codex、Cursor、Antigravity(agy)、OpenCode がある。
_Avoid_: ツール、モデル

**エージェントの種類(agent kind)**:
エージェント CLI を区別する名前(`pi`、`claude`、`codex`、`cursor`、`agy`、`opencode`)。Rust の型の名前は `FleetAgentKind`。
_Avoid_: `AgentKind`(HTTP の応答で、種類と表示名を組にした型の名前)

**エージェントの状態(agent status)**:
herdr がペインのエージェントについて報告する状態(`idle`、`working`、`blocked`、`done`、`unknown`)。

**画面(screen)**:
ペインがその時点で描いているターミナルの文字と色。herdr から読む。
_Avoid_: 出力、ログ

**attach**:
ペインのターミナルの出力をそのまま受け取り、入力を送り返すつなぎ方。

**ミラー(mirror)**:
attach できない herdr(Windows)で、ペインの画面を繰り返し読んで、attach と同じ形で見せるつなぎ方。

## 画面と会話の解析

**承認画面(approval prompt)**:
エージェント CLI が人の答えを待って描く、選択肢つきの問い(ツールの実行の承認、質問、計画の確認、メニュー)。
_Avoid_: ダイアログ、モーダル

**カード(card)**:
承認画面を解析して、チャットに選択肢として出したもの。カードの答えは、ペインに送るキー入力に変わる。

**解析した承認画面(parsed prompt)**:
承認画面を解析した結果の値で、カードと、そのカードの答え方を合わせて持つ。Rust の型の名前は `ParsedPrompt`。カードだけを複写しても、答え方は付いてこない。
_Avoid_: プロンプト(単独で書くと、エージェントに渡す指示文と区別できない)

**答え方(answering)**:
カードの答えを、ペインに送るキー入力に変える決まり。カーソルのある行、選択肢ごとのキー、自由入力と複数選択の送り方からなる。承認画面を解析したときに決まる。Rust の型の名前は `Answering`。
_Avoid_: responder(カードを読んだ読み手の名前。答え方そのものではない)

**content id**:
カードが示す内容(エージェント、種類、問い、本文、選択肢など)から作る、カードの名前。同じ内容のカードは同じ content id を持ち、カーソルの位置は含まない。
_Avoid_: カードの id(Web UI が受け取る id は、core が問いごとに作り直した別の値)

**画面の判定(screen check)**:
fleet がエージェントの画面を見て下す判定(起動の失敗、herdr が `idle` と報告する間の問い、入力欄が出たか、入力欄の書きかけ、ターンの失敗)。エージェントの種類ごとに異なる。

**秘密の入力(secret prompt)**:
パスワードなど、画面に出さずに 1 行で入力させる問い。

**transcript**:
エージェント CLI が自分で保存する会話の記録。herdr-fleet は読むだけで書かない。
_Avoid_: ログ、履歴、セッション

**transcript の形式(transcript format)**:
エージェント CLI ごとに異なる transcript の読み方(ファイルの場所、ターンの区切り方、履歴の境目)。会話のページを作る処理は、形式を通してだけ CLI ごとの違いに触れる。Rust の trait の名前は `TranscriptFormat`。
_Avoid_: パーサー(transcript の 1 行を読む処理は形式の一部)

**会話(conversation)**:
transcript から組み立てた、チャットに出す形の発言の並び。

**会話のターン(conversation turn)**:
会話の中で、人かエージェントの片方が続けて話した一続き。ターンは本文、思考、ツールの呼び出しと結果などの部分(part)からなる。
_Avoid_: メッセージ(transcript の 1 行や 1 メッセージとは数が一致しない)

**corpus**:
解析の正しさを確かめる入力と期待値の組の集まり。画面の corpus と会話ログの corpus がある。

## fleet

**fleet**:
1 人の呼び出し元(人、または fleet のエージェント)が起動したエージェントの集まり。

**orchestrator**:
fleet のうち、run を起動し、委ねたターンを追い、thread とその記録を扱う部分。エージェントの種類には依存せず、種類ごとの違いはエージェント adapter に任せる。

**役割(role)**:
エージェントに与える仕事の型。指示文、使うエージェント CLI とモデルの候補、編集してよいかを持つ(lead、coordinator、architect、reviewer、worker など)。

**run**:
fleet が 1 つのペインで起動した 1 つのエージェントの、起動から終わりまでの記録。役割、エージェントの種類、モデル、状態、最後の結果を持つ。
_Avoid_: ジョブ、タスク、プロセス

**run の状態(run state)**:
run の今の段階。エージェントの状態に、fleet が足す `starting`(まだ状態がない)、`failed`、`stopped`(run が終わった)を加えたもの。

**委ねたターン(delegated turn)**:
run のエージェントに 1 つの指示を渡してから、その応答が落ち着くまで。
_Avoid_: ターン(単独で書くと会話のターンと区別できない)

**brief**:
仕事を渡すエージェントが書く、仕事の説明(目的、書いてよいパス、文脈、終わりの条件、確かめ方)。

**結果ファイル(result file)**:
run ごとに用意し、エージェントが委ねたターンの終わりに HANDOFF を書くファイル。

**HANDOFF**:
委ねたターンの結果の報告。PASS、ISSUES、BLOCKED のどれかの行で始まる。

**thread**:
プロジェクトの仕事の 1 つ。自分のワークスペースと、リポジトリの中なら自分のブランチの worktree を持ち、lead が進める。
_Avoid_: スレッド(並行処理の thread とは別物なので、英語のまま書く)

**lead**:
thread を進める役割。部分を helper に渡し、ブランチを取り込む。

**coordinator**:
プロジェクトの thread を起こし、結果を受け、マージを行う役割。

**helper**:
lead などが仕事の一部を渡すために起動した run。

**契約(contract)**:
lead が作業の前に書く、他人が確かめられる受け入れの条件の一覧。

**計画(plan)**:
lead が大きな変更の前に人に渡す、主張の木。人はその場で答えを返す。

**常に守る指示(standing orders)**:
すべてのエージェントの指示文の末尾に足す決まり。

**エージェント adapter(agent adapter)**:
エージェント CLI ごとの違い(起動の引数、環境変数、画面の判定、使用量の読み方、モデル一覧)をまとめたもの。fleet の orchestrator は種類に依存しない。
_Avoid_: ドライバー、プラグイン

**使用量(usage)**:
エージェント CLI のサブスクリプションの、時間枠ごとに使った割合と解除の時刻。各 CLI 自身が答える経路で読む。

**クールダウン(cooldown)**:
rate limit のエラーを検知してから、その CLI かアカウントを fleet が使わない期間。

**モデル一覧(model list)**:
エージェント CLI が、モデルを呼ばずに答える、自分の使えるモデルの名前の一覧。

## 画面と接続

**core**:
herdr-fleet のサーバー。herdr とつながり、Web UI、デスクトップの画面、fleet CLI に応える。
_Avoid_: バックエンド、デーモン

**Web UI**:
core が配信する、ブラウザ(スマホを含む)で動く画面。

**デスクトップの画面(desktop)**:
ブラウザを使わずに PC の上で動く画面。Web UI と同じことができる。

**fleet CLI**:
エージェントが自分の指示文に従って使う `fleet` コマンド。core を通じて fleet を操作する。

**lens**:
1 つのペインを見る見せ方。チャット(会話とカード)と、ターミナル表示がある。

**サイドチャット(side chat)**:
ペインの会話の横で、そのペインについて尋ねる別の会話。core が別に動かす Claude Code が答える。

**サイドターミナル(side terminal)**:
ペインのワークスペースで、エージェントのいないシェルを開いたタブ。サイドパネルに出す。

**Explain**:
カードの問いについて、なぜ聞かれているか、各選択肢で何が起きるか、どれを選ぶとよいかの説明。人が頼んだときだけ作る。

**紐付けた端末(paired device)**:
PC で発行した短いコードで、token の代わりに自分専用の資格を受け取ったブラウザ。

**state フォルダー(state folder)**:
core が紐付けた端末、push の鍵と購読、run の記録などを置くフォルダー。

## 一致を確かめる基準

ここでの「契約」は、Rust 版と TypeScript 版を比べる基準の名前で、いつも「fleet CLI の契約」「HTTP/WS の契約」と対象を付けて書く。lead が作業の前に書く受け入れの条件の一覧(上の「契約(contract)」)とは別物である。

**基準(parity criterion)**:
Rust 版が TypeScript 版と同じに振る舞うかを決める、自動で走るテストの 1 つ。画面の corpus、会話ログの corpus、fleet CLI の契約、HTTP/WS の契約、安全上の判定の表、UI の回帰がある。
_Avoid_: 仕様、受け入れテスト

**fleet CLI の契約(fleet CLI contract)**:
fleet CLI に与える argv・環境変数・サーバーの応答と、CLI が送る要求・標準出力・標準エラー・終了コードの組を並べた基準。TypeScript の CLI にも Rust の CLI にも当てる。
_Avoid_: 契約(対象を付けずに書くと、lead の契約と区別できない)

**HTTP/WS の契約(HTTP/WS contract)**:
起動の指定で起動した core に URL を通してだけ話し、要求と応答を確かめる black-box のテストの集まり(`*.contract.test.ts`)。TypeScript のサーバーにも Rust の core にも向ける基準。
_Avoid_: 契約(対象を付けずに書くと、lead の契約と区別できない)、API テスト

**起動の指定(launch spec)**:
HTTP/WS の契約のテストが core を起動するときに渡す、子プロセスの環境変数(`env`)とテスト用のオプション(`test`)の組。
_Avoid_: 起動オプション、起動設定

**テスト用のオプション(test options)**:
起動の指定のうち、本番の環境変数では表せず、データだけで書ける core の設定(Tailscale の持ち主、push の宛先の判定の置き換え、待ち時間など)。テスト用のエントリーポイントだけが読む。
_Avoid_: seam、テスト用のフック

**テスト用のエントリーポイント(test entry point)**:
テスト用のオプションを標準入力で受けて core を起動する、テストのためのプログラム(TypeScript では `scripts/contract/server.ts`)。本番のプログラムには、テスト用のオプションを渡す経路がない。
_Avoid_: テスト用サーバー、モックサーバー
