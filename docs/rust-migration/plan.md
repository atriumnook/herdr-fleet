# herdr-fleet の Rust への置き換え計画

この文書は、`rust` ブランチで herdr-fleet を Rust に置き換える作業の計画である。作業は herdr-fleet の fleet で動く AI エージェントが、人の判断なしで進める(人が出すのは最初の指示 1 回だけ)。エージェントが守る決まりは `.herdr-fleet/standing.md`、役割は `.herdr-fleet/agents/` にある。この文書は、何を作り、どの順に進め、何をもって終わりとするかを決める。

## 目標

今の herdr-fleet(TypeScript)のすべての機能を、Rust で同等に作る。

- **core**: 1 つの Rust のプロセス。herdr の socket クライアント、全ペインの状態の購読、PTY の attach、承認画面と会話ログの解析、fleet の orchestrator と adapter、使用量とモデル一覧の取得、HTTP/WebSocket、アクセス制御、push 通知を持つ
- **Web UI**: 今の React の UI(`src/`)をそのまま使う。core が今のサーバーと同じ HTTP/WebSocket で応答するので、スマホからの操作は今のまま残る
- **デスクトップ**: GPUI の画面。ターミナルの描画は libghostty(libghostty-vt)を使う。Linux・macOS・Windows で動く
- **`fleet` CLI**: Rust の実行ファイル。今の `bin/fleet.ts` と同じ引数・出力・終了コードを持つ(起動されたエージェントの指示文がこれに依存するため)

## 守ること

- `.herdr-fleet/standing.md` の決まり(元のアプリを止めない、main に触れない、隔離して実行する、API キーを使わない、GitHub で許された操作、マージの前の関門、止まり方)
- `CLAUDE.md` の「守ること」に書かれた振る舞いは、Rust 版でもすべて守る。上流から削除した機能を戻さない、アクセス制御を緩めない、fleet のサーバーは GitHub に書き込まない、各 CLI の癖への対応、使用量とモデル一覧の取得口、OpenCode 2 の制限、会話の読み方。回帰テストがあるものは、Rust 版にも同じ回帰テストを置く
- 依存の追加は「言語・プラットフォーム標準 > 実績があり保守されているライブラリ > 自作」の順。追加する crate は、ライセンス、保守の状況、`build.rs` が何を実行するかを読んでから入れ、ADR に書く
- UI の文言の決まり(英語をキーにし、文だけ `src/lib/i18n.ja.ts` に訳を置く)は、デスクトップの画面にも当てる

## 置き場所と切り替え

- Rust のコードは `rust/`(Cargo workspace)に置く。TypeScript のコードと `fixtures/` は、一致を確かめる基準として残す
- 作業はすべて `rust` ブランチに入る。main は切り替えまで変わらない
- 切り替えは最後の段階で準備し、`rust` から `main` への PR を開くところまでをエージェントが行う。マージと、稼働中のサーバーの入れ替えは人が行う(main は ruleset で守られている)

## 一致を確かめる基準

Rust 版が正しいかは、エージェントの判断ではなく、次の基準(自動で走るテスト)で決める。どの基準も、TypeScript 版で通ることを先に確かめる。

| 基準 | 中身 | 状態 |
|---|---|---|
| 画面の corpus | `fixtures/screens/`。承認画面の解析と adapter の画面の判定(`scripts/screen-fixtures.ts`) | あり(#103) |
| 会話ログの corpus | claude・codex・pi・opencode・omp の会話ログ → 会話の構造 | あり(#123、#127〜#129) |
| fleet CLI の契約 | argv → HTTP の要求 → 応答 → 標準出力と終了コード | あり(#124) |
| HTTP/WS の契約 | 今の `*.contract.test.ts` を black-box のテストにしたもの。テストは、起動の指定(launch spec)で自分が起動したサーバー(TypeScript か Rust を選べる)に、URL を通してだけ話す。すでに動いているサーバーには向けない(ADR `0122-parity-criteria`) | あり(#125、#130〜#133) |
| 安全上の判定の表 | アクセス制御、ファイル表示の範囲、push の宛先、子プロセスの環境変数、git の設定 → 判定 | あり(#126) |
| UI の回帰 | `bun run test:ui`、`scripts/fleet-screen-regression.ts` を Rust の core に向けて走らせる | 段階 4 で使う |

どの TypeScript のテストが、どの基準または Rust のテストに引き継がれたかは、`docs/rust-migration/parity.md` に一覧で残す。一覧に引き継ぎ先のないテストが残っている間は、切り替えの準備ができていない。

## 段階

各段階の作業は、その段階を始めるときに、計画用の thread が Issue に分ける(`phase:<n>`)。各段階の終わりには関門の thread が、下の「完了条件」をすべて確かめる。

### 段階 0: 土台と試作

- `rust/` の Cargo workspace、`rust-toolchain.toml`(版を固定)、Linux の workflow(push と PR ごとに `cargo fmt --check`、`cargo clippy -D warnings`、`cargo test`)
- 試作で確かめる(結果と判断は ADR に書く)
  - GPUI が、この PC(Linux、Wayland、Hyprland)で窓を開き、文字を描ける
  - libghostty-vt を Rust から使える(Zig でのビルド、C API のバインディング)。記録したペインのバイト列を解析し、Ghostty 本体と同じ画面になる
  - macOS と Windows 向けに、空の GPUI アプリがビルドできる(workflow を手動で 1 回)
- 試作が通らない場合の代わりを決める。例: libghostty が使えなければ `alacritty_terminal` か `vte`。どれを選んでも ADR に書く
- `improve-codebase-architecture` で、今の TypeScript のコードから crate の分け方を決め、ADR と `docs/rust-migration/GLOSSARY.md` に書く
- 完了条件: workflow が緑。試作 3 つの結論が ADR にある。crate の分け方の ADR がある

### 段階 1: 一致を確かめる基準を揃える(TypeScript の側)

- 上の表の「段階 1 で作る」をすべて作り、TypeScript 版で通す。作るのは `rust` ブランチの中だけ(main は変えない)
- HTTP/WS の契約は、サーバーの起動の仕方(TypeScript か Rust か)を引数で選べるようにする
- `docs/rust-migration/parity.md` に、TypeScript の全テストファイルを並べ、引き継ぎ先の欄を作る
- 完了条件: すべての基準が TypeScript 版で通る。parity.md に全テストファイルがある

### 段階 2: 解析の crate

- 承認画面の解析、adapter の画面の判定、会話ログの解析(各 CLI)を Rust で作る
- 完了条件: 画面の corpus と会話ログの corpus の全件を、Rust の実装が通す

### 段階 3: herdr と fleet

- herdr の socket クライアント(`scripts/herdr-schema.json` から型を作る)、ペインの状態の購読、runtime、orchestrator、adapter、使用量、モデル一覧、`fleet` CLI
- 完了条件: fleet CLI の契約が Rust の CLI と Rust の core で通る。orchestrator の振る舞い(今の `server/fleet/*.test.ts` の内容)が Rust のテストにある。隔離した herdr のセッションで、Rust の core が thread を 1 つ起動して終えられる

### 段階 4: HTTP/WebSocket の core

- 今のサーバーの全ルート、WebSocket、PTY の attach、アクセス制御、ファイル表示、push 通知、端末の紐付け、サイドチャット、Explain
- 今の React の UI を、Rust の core から配信する
- 完了条件: HTTP/WS の契約と安全上の判定の表が、Rust の core で通る。UI の回帰が Rust の core で通る

### 段階 5: デスクトップの画面

- GPUI で、Web UI の画面(Pane、Fleet、サイドパネル、設定)と同じことができる画面を作る。ターミナルは libghostty で描く
- 完了条件: 画面ごとに、Web UI と同じ操作ができることを確かめるテストがある。スクリーンショットの回帰がある

### 段階 6: マルチプラットフォーム

- macOS と Windows のビルドとパッケージ。各 OS での herdr とのつなぎ方の違いへの対応
- workflow の macOS と Windows は、手動(`workflow_dispatch`)で、段階の関門と切り替えの前だけに走らせる。リポジトリが非公開の間は、Actions の無料枠の残りを確かめ、足りなければ走らせずに `blocked` の Issue にする
- macOS と Windows の workflow(`.github/workflows/rust-cross.yml`)の trigger は、ADR `0111-cross-build` で決め、ADR `0120-cross-build-dispatch-only` が `workflow_dispatch` だけに決め直した。走らせる手順と、GitHub が起動を断ったときに `0111-cross-build` の `pull_request` の trigger を戻す手順も、`0120-cross-build-dispatch-only` にある
- 完了条件: 3 つの OS でビルドとテストが通る

### 段階 7: 切り替えの準備

- 状態の互換: Rust 版が今の state フォルダーのファイル(紐付けた端末、push の鍵と購読、fleet の run、設定)をそのまま読めるか、移す道具を用意する
- 並べて動かす: 隔離した state フォルダーとポートで、Rust 版を TypeScript 版と並べて 1 日分の作業に使い、違いを Issue にする
- 手順書: `docs/rust-migration/cutover.md` に、止める、state を保存する、Rust 版を起動する、戻す、の手順を書く
- `CLAUDE.md` と `README.md` を Rust 版の内容に書き直す。`security-review` を core 全体にかける
- `rust` から `main` への PR を開き、報告の Issue を書く
- 完了条件: parity.md の全行に引き継ぎ先がある。すべての基準が Rust 版で通る。手順書がある。PR が開いている

## 作業の記録

- 作業の待ち行列は GitHub の Issue(ラベル `rust-migration`)。ファイルの台帳は置かない(並行する thread が同じファイルを書き換えて衝突するため)
- 全体の経過は tracking issue(ラベル `rust-migration` と `tracking`)に、段階が終わるたびに coordinator がコメントする。最初の指示を受けた coordinator が、まだなければ作る
- 決めたことは ADR(`docs/rust-migration/adr/NNNN-<題>.md`)に残す。人が後から読んで、なぜそうしたかがわかるように書く
