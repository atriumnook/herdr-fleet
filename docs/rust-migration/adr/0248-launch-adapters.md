# 起動の adapter の形と、TypeScript と変えた 4 つの点

- 状態: 採用
- 決めた日: 2026-11-09
- Issue: #248

## 状況

ADR `0242-phase-3-split` は、エージェント CLI ごとの起動の引数、環境変数、thinking、agy の `--settings`、OpenCode の設定を、orchestrator の `launch` module に置くと決め(L2)、module の公開の口はその Issue が決めるとした。`launch` を呼ぶのは、あとの O1(#256、spawn)と O2(候補の選び方)である。そのため、次のことを決める必要があった。

- adapter の形(trait か、値と関数の struct か)と、画面の判定(段階 2 で screen の crate に移った `screen_checks`)の持ち方
- TypeScript がプロセスの環境変数(`process.env`)とソースのファイルの場所から読むもの(`opencodeGitEnv` の `GIT_CONFIG_*`、fleet-guard のプラグインのパス)を、Rust でどう渡すか。`unsafe_code = "forbid"` の下では、テストが `std::env::set_var` を呼べない(edition 2024 で unsafe)
- fleet-guard の `index.js` がないときの起動の失敗の伝え方(ADR `0242-phase-3-split` の「fleet-guard のプラグインの場所」)
- Issue #248 の「main の欠陥」の #176 の 6、#189 の 8、#190 を、Rust 版でどう扱うか。2026-11-09 の時点で、どれも main で直っていない(`git diff origin/rust origin/main -- server/fleet/adapters.ts` は空で、CLAUDE.md の agy の段落も変わっていない)

## 決定

### adapter の形

- `launch::Adapter` は、値(`kind`、`instructions_in_prompt`、`read_only_args`、`read_only_edits_result`、`note`、`usage_command`)と関数のポインター(引数、環境変数、読み取りだけの役割の note、断る役割)を持つ struct にし、CLI ごとに 1 つの `static` を置く。`adapter_for(kind) -> &'static Adapter` で引く。状態を持たず、screen の crate の `ScreenChecks` と同じ形である
- 画面の判定は持たず、`Adapter::screen()` が `screen::screen_checks(kind)` を返すだけにする
- 引数は `LaunchOptions`、ペインの環境変数は `PaneContext` から作る。TypeScript の同名の interface と同じ項目を持ち、パスは `&str` で受ける(herdr の `agent.start` に渡す argv は文字列で、TypeScript も文字列で扱う)
- adapter は CLI ごとのモデル一覧(`models`)を持たない(ADR `0242-phase-3-split`)

### プロセスの環境と、fleet-guard のパス

- `PaneContext` に `server_env`(fleet のサーバーの環境変数。`GIT_CONFIG_*` を読む)と `guard_plugin`(fleet-guard のフォルダー)を足す。呼ぶ側(O1)は `std::env::vars()` を集めたものと `launch::opencode::guard_plugin_dir()` を渡す。テストは、別の環境と別のフォルダーを渡して確かめる
- `guard_plugin_dir()` は、ADR `0242-phase-3-split` のとおり、`CARGO_MANIFEST_DIR`(`rust/crates/orchestrator`)から 3 つ上の `opencode/fleet-guard` を返す
- 編集しない役割の opencode のペインで `<guard_plugin>/index.js` がファイルとしてなければ、`Adapter::env` は `FleetError` を返し、文に探したパスを書く。編集する役割はプラグインを読み込まないので、確かめない

### main の欠陥(Rust 版に写さないもの)

- #176 の 6(agy の `--effort` と model の level の衝突): TypeScript と同じく、level を名前に含む agy の model id(`-low`、`-medium`、`-high`、`-xhigh`、`-max` で終わる)には `--effort` を付けない。fleet の argv から agy の衝突(`--model X conflicts with --effort=Y`)は起きない。衝突と未知のモデルを `readyError` が起動の失敗として扱うのは screen の crate(段階 2)である
- #189 の 8(agy の sandbox の note と、fleet コマンドを使う役割の矛盾): `Adapter::refusal(&RoleFit)` を置き、agy は `spawning: true` の役割(lead、coordinator)を断る。O2 は、これを候補の選び方で `avoided`(`orchestrator.ts:460`)と同じく、飛ばす理由として使う。fleet コマンドを使う役割が agy で起動しないので、sandbox の note(fleet コマンドは失敗する)と役割の指示は矛盾しない
- #190(agy のレビュアーが作業フォルダーの外のファイルの確認画面で止まる): agy は名前が `reviewer` の役割も断る。thread が `--avoid agy` を付けなくても、fleet は agy でレビュアーを起動しない(#190 の「当面の扱い」は、thread ごとに `--avoid agy` を付けることだった)。名前で断るのは、作業フォルダーの外のファイルを読む役割かどうかを示す項目が、役割の定義にないためである(同梱の `agents/reviewer.md` は `edits: false` も持たない)。名前の違うレビューの役割(利用者が足した `code-reviewer` など)は断らず、それは agy の確認画面で run が `blocked` になる(screen の crate の agy の `question`)。役割の定義に項目を足すのは役割の読み込み(L1、#247)の範囲で、この Issue では足さない

### TypeScript から変えた点

1. fleet-guard の `index.js` がなければ、編集しない役割の opencode の起動を失敗にする(ADR `0242-phase-3-split` が決めた)
2. agy のペインに `AGY_CLI_DISABLE_AUTO_UPDATE=true` を渡す。TypeScript の agy の adapter はペインに環境変数を渡さない。Issue #248 の受け入れ条件がこれを起動に関わる癖として挙げ、CLAUDE.md の「CLI を実機で起動する検証の副作用」は agy が起動しただけで自分を更新しうると書き、`scripts/agy-live-check.ts` は agy のペインをこの値で起動している
3. agy は `spawning: true` の役割を断る(#189 の 8)
4. agy は `reviewer` の役割を断る(#190)

3 と 4 は main の直しが入れば、それに合わせて置き換える(新しい ADR で)。

## 検討した代わり

- adapter を trait にし、CLI ごとに型を置く: 状態がなく、呼ぶ側は `FleetAgentKind` から引くだけなので、trait object の分だけ複雑になる。screen の crate の `ScreenChecks` と形をそろえた
- fleet-guard のパスと `GIT_CONFIG_*` を `launch` の中でプロセスから読む: テストが別の値を渡せない(`set_var` は unsafe)。読むのは呼ぶ側の 1 か所にした
- #190 で、agy の `--settings` で作業フォルダーの外の読み取りを許す: そのための設定の項目を、実物の agy で確かめられない(モデルを呼ばずには確認画面に届かない)。確かめていない項目には頼らない
- #190 で、`--add-dir` に決まりのファイルのフォルダーを足す: どのフォルダーを読むかは project の決まり(`standing.md`)が決め、adapter は知らない
- #189 の 8 で、役割の名前(`lead`、`coordinator`)で断る: 利用者が足した役割で fleet コマンドを使うものを見落とす。fleet コマンドで agent を起動するかは、役割の `spawning` が示す
- #190 を screen の側(agy の `question` が確認画面で run を `blocked` にする)と thread ごとの `--avoid agy` だけに任せる: Issue #248 は「確認画面なしで読めるようにするか、レビュアーを agy に割り当てないか」のどちらかを求めており、`blocked` で止まるのは #190 が報告した振る舞いそのものである

## 依存

なし

## 結果

- O1 は、spawn で `adapter_for(kind)` を引き、`PaneContext` に `server_env` と `guard_plugin_dir()` を渡し、`Adapter::env` のエラーを起動の失敗として返す
- O2 は、候補ごとに `Adapter::refusal` を呼び、`Some` なら飛ばす理由にする(`edits: false` の役割に `read_only_args` がない CLI を飛ばすのと同じ)
- 画面の判定を足す・直すときは screen の crate を書き、`launch` は変えない
- 配布するときの fleet-guard の置き場所は、段階 6 で決める(ADR `0242-phase-3-split`)

## 確かめたこと

- `cargo test --locked -p herdr-fleet-orchestrator --test launch --test opencode_config`(Arch Linux、rustc 1.99.1。`rust/rust-toolchain.toml` の版): launch 33 件、opencode_config 16 件が通る。安全上の判定の表 `opencodeConfig.json`(9 件)と `opencodeGitEnv.json`(10 件)は全件が一致し、設定の JSON は鍵の順まで TypeScript の `JSON.stringify` と同じ文字列になる
- 実装の前に同じコマンドを走らせ、stub の `todo!()` で launch 29 件(当時の 31 件のうち)、opencode_config 16 件が失敗することを確かめた。`/code-review high` の指摘で足した 2 件(node の `dirname` の値、`:low` のような model)も、直す前に失敗することを確かめた
