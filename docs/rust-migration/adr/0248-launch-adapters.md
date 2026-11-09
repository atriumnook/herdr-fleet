# 起動の adapter の形と、TypeScript と変えた 4 つの点

- 状態: 採用
- 決めた日: 2026-11-09
- Issue: #248

## 状況

ADR `0242-phase-3-split` は、エージェント CLI ごとの起動の引数、環境変数、thinking、agy の `--settings`、OpenCode の設定を、orchestrator の `launch` module に置くと決め(L2)、module の公開の口はその Issue が決めるとした。`launch` を呼ぶのは、あとの O1(#256、spawn)と O2(#263、候補の選び方)である。そのため、次のことを決める必要があった。

- adapter の形(trait か、値と関数の struct か)と、画面の判定(段階 2 で screen の crate に移った `screen_checks`)との関係
- TypeScript がプロセスの環境変数(`process.env`)とソースのファイルの場所から読むもの(`opencodeGitEnv` の `GIT_CONFIG_*`、fleet-guard のプラグインのパス)を、Rust でどう渡すか。`unsafe_code = "forbid"` の下では、テストが `std::env::set_var` を呼べない(edition 2024 で unsafe)
- fleet-guard の `index.js` がないときの起動の失敗の伝え方(ADR `0242-phase-3-split` の「fleet-guard のプラグインの場所」)
- Issue #248 の「main の欠陥」の #176 の 6、#189 の 8、#190 を、Rust 版でどう扱うか。2026-11-09 の時点で、どれも main で直っていない(`git diff origin/rust origin/main -- server/fleet/adapters.ts` は空で、CLAUDE.md の agy の段落も変わっていない)

architect(fleet の run `7b51ed0d`)に 4 つの問いを出し、その答えに従った。

## 決定

### adapter の形

- `launch::Adapter` は、値と関数のポインターを持つ struct にし、CLI ごとに 1 つの `static` を置く。`adapter_for(kind) -> &'static Adapter` で引く。状態を持たず、CLI の種類は `FleetAgentKind` で閉じているので、trait にしない。screen の crate の `ScreenChecks` と同じ形である
  - 値: `kind`、`instructions_in_prompt`、`read_only_args`、`read_only_edits_result`、`note`、`usage_command`、`runs_fleet_command`(agent が fleet コマンドを実行できるか。agy だけ false)、`asks_before_outside_reads`(auto mode でも、作業フォルダーの外のファイルを読む前に確認画面を出すか。agy だけ true)
  - 関数のポインター: `launch_args`、`env`、`read_only_note`。`refusal` は関数のポインターではなく、上の値を読む共通の method(下の「断る役割」)
- 画面の判定には触れない。呼ぶ側(O1)は `screen::screen_checks(kind)` を直接呼ぶ。adapter から同じ判定に届く道を 2 つにしないため
- 引数は `LaunchOptions`、ペインの環境変数は `PaneContext` から作る。TypeScript の同名の interface と同じ項目を持ち、パスは `&str` で受ける(herdr の `agent.start` に渡す argv は文字列で、TypeScript も文字列で扱う)
- adapter は CLI ごとのモデル一覧(`models`)を持たない(ADR `0242-phase-3-split`)

### 断る役割(`Adapter::refusal`)

- `RoleFit { read_only, spawning, reads_outside_folders }` は、役割の事実だけを持ち、役割の名前を持たない。`launch` は役割を名前で知らない
- `Adapter::refusal(&RoleFit)` は、CLI ごとの関数ではなく、すべての CLI に共通の 1 つの method で、次の順に調べる
  1. `read_only` で、CLI に `read_only_args` がない: `"<kind> cannot be kept from editing files"`。TypeScript が候補の選び方の中に書いた判定(`orchestrator.ts:461`)を、文を変えずに移す(`orchestrator.test.ts` がこの文を確かめる)
  2. `spawning` で、`runs_fleet_command` が false(#189 の 8)
  3. `reads_outside_folders` で、`asks_before_outside_reads` が true(#190)
- O2 が `RoleFit` を役割の定義から作る: `read_only` は `edits: false`、`spawning` は役割の上書きか定義の `spawning`、`reads_outside_folders` は名前が `reviewer` であること(役割の定義に、この事実を示す項目がまだないため)。O2 の候補の選び方の順は TypeScript と同じく、呼んだ側の `avoid`、`refusal`、モデル一覧、使用量

### プロセスから読むもの(`Host`)

- `PaneContext` は `host: &Host` を持つ。`Host` は、fleet のサーバーの `GIT_CONFIG_COUNT`・`GIT_CONFIG_KEY_<n>`・`GIT_CONFIG_VALUE_<n>` と、fleet-guard のフォルダーだけを、外から見えない項目で持つ
- `Host::from_process()` がこのプロセスから作り(UTF-8 でない値は、ないものとして扱う)、`Host::new(git_config, guard_plugin)` はテストが別の値で作る。`new` は `GIT_CONFIG_*` 以外の変数を捨てる。O1 は起動のときに 1 度作り、`fleet_command` や結果フォルダーと並べて持つ
- 2 つの値はどちらも run ではなくプロセスのもので、O1 が「opencode は `GIT_CONFIG_*` と fleet-guard を読む」ことを知らずに済む。`PaneContext` は `Debug` を持つので、サーバーの環境変数をすべて持つと、ログに API キーやトークンが出うる。`Host` は `GIT_CONFIG_*` しか持たない
- `guard_plugin_dir()` は、ADR `0242-phase-3-split` のとおり、`CARGO_MANIFEST_DIR`(`rust/crates/orchestrator`)から 3 つ上の `opencode/fleet-guard` を返す。`guard_plugin_dir()`、`git_env(base)`、`config(role, guard)` は、安全上の判定の表のテストのために公開する

### fleet-guard がないとき

- 編集しない役割の opencode のペインで `<guard_plugin>/index.js` がファイルとしてなければ、`Adapter::env` はコード `guard_plugin_missing` の `FleetError` を返し、文に探したパスを書く。編集する役割はプラグインを読み込まないので、確かめない
- 新しいコードにするのは、`agent_start_failed` にすると、O2 の候補の選び方がモデルの失敗として扱い(`orchestrator.ts:480-481` の `usage.noteFailure`)、そのモデルを使うすべての役割で、モデルをクールダウンにして次の候補を試すためである。`index.js` がないのは install の壊れ(build した worktree を動かした、消したなど)で、モデルの失敗ではない。飛ばす理由にもしない(編集しない役割が、誰も気づかないまま opencode から外れるため)
- 判定は設定を作る `env` の中に置く。呼ぶ側が fleet-guard のない編集しない役割のペインを作れないようにするため

### main の欠陥(Rust 版に写さないもの)

- #176 の 6(agy の `--effort` と model の level の衝突): TypeScript と同じく、level を名前に含む agy の model id(`-low`、`-medium`、`-high`、`-xhigh`、`-max` で終わる)には `--effort` を付けない。fleet の argv から agy の衝突(`--model X conflicts with --effort=Y`)は起きない。衝突と未知のモデルを `readyError` が起動の失敗として扱うのは screen の crate(段階 2)である
- #189 の 8(agy の sandbox の note と、fleet コマンドを使う役割の矛盾): agy は `spawning` の役割(lead、coordinator)を断る(上の 2)。fleet コマンドを使う役割が agy で起動しないので、sandbox の note(fleet コマンドは失敗する)と役割の指示は矛盾しない。coordinator は編集しない役割なので、TypeScript と同じく上の 1 の文で断られる
- #190(agy のレビュアーが作業フォルダーの外のファイルの確認画面で止まる): agy は `reads_outside_folders` の役割を断る(上の 3)。thread が `--avoid agy` を付けなくても、fleet は agy でレビュアーを起動しない(#190 の「当面の扱い」は、thread ごとに `--avoid agy` を付けることだった)

### TypeScript から変えた点

1. fleet-guard の `index.js` がなければ、編集しない役割の opencode の起動を失敗にする(ADR `0242-phase-3-split` が決めた)。コードは `guard_plugin_missing`
2. agy のペインに `AGY_CLI_DISABLE_AUTO_UPDATE=true` を渡す。TypeScript の agy の adapter はペインに環境変数を渡さない。Issue #248 の受け入れ条件がこれを起動に関わる癖として挙げ、CLAUDE.md の「CLI を実機で起動する検証の副作用」は agy が起動しただけで自分を更新しうると書き、`scripts/agy-live-check.ts` は agy のペインをこの値で起動している
3. agy は `spawning` の役割を断る(#189 の 8)
4. agy は `reads_outside_folders` の役割を断る(#190)

main が #190 を直したら、1 行を変えて合わせる。agy が確認画面なしで読めるようになれば agy の `asks_before_outside_reads` を false に、役割の定義に項目が足されれば O2 がその項目を読む。どちらも新しい ADR に書く。

## 検討した代わり

- adapter を trait にし、CLI ごとに型を置く: 状態がなく、呼ぶ側は `FleetAgentKind` から引くだけなので、trait object か generic の分だけ複雑になり、隠せるものは増えない
- `Adapter::screen()` で画面の判定を返す: `screen::screen_checks(kind)` を渡すだけで、同じ判定に届く道が 2 つになる
- 断る役割を CLI ごとの関数にし、agy の中で名前 `reviewer` を見る: 同梱の役割の名前が `launch` に入り(`/code-review high` の指摘)、編集しない役割の判定(O2 の中)と断る判定が 2 か所に分かれる
- #189 の 8 で、役割の名前(`lead`、`coordinator`)で断る: 利用者が足した役割で fleet コマンドを使うものを見落とす。fleet コマンドで agent を起動するかは、役割の `spawning` が示す
- #190 を screen の側(agy の `question` が確認画面で run を `blocked` にする)と thread ごとの `--avoid agy` だけに任せる: `blocked` のレビュアーは人の答えを待つが、人はいない。Issue #248 は欠陥を写すことを禁じている
- #190 で、agy の `--settings` で作業フォルダーの外の読み取りを許す: そのための設定の項目を、実物の agy で確かめられない(モデルを呼ばずには確認画面に届かない)。確かめていない項目には頼らない
- #190 で、`--add-dir` に決まりのファイルのフォルダーを足す: どのフォルダーを読むかは project の決まり(`standing.md`)が決め、fleet は知らない
- `PaneContext` に `server_env`(サーバーの環境変数のすべて)と `guard_plugin` の 2 つの項目を足す: O1 が adapter の読むものを知る必要があり、`Debug` で秘密がログに出うる
- guard がないとき `agent_start_failed` を返す、または候補を飛ばす理由にする: 上の「fleet-guard がないとき」のとおり

## 依存

なし

## 結果

- O1 は、起動のときに `Host::from_process()` を 1 度作る。spawn では `adapter_for(kind)` を引き、`PaneContext` に `host` を渡す。`Adapter::env` は、TypeScript と同じくペインを作る前(`createLocation` の前、`orchestrator.ts:507`)に呼び、エラーなら起動の失敗としてそのまま返す。画面の判定は `screen::screen_checks(kind)` で引く
- O2 は、役割の定義から `RoleFit` を作り、候補ごとに `Adapter::refusal` を呼び、`Some` なら飛ばす理由にする。TypeScript が候補の選び方の中に書いた「編集しない役割を `read_only_args` のない CLI に渡さない」判定は、この method に移ったので、O2 には書かない。`guard_plugin_missing` では、モデルのクールダウンも次の候補も試さない
- `/api/fleet` のコードと HTTP の状態の表(`server/fleet/api.ts:294`、Rust では API の Issue #269)には `guard_plugin_missing` の行がない。サーバーの故障なので 500 にする(#269 に書いた)
- 名前が `reviewer` でないレビューの役割は agy で断らず、その run は agy の確認画面で `blocked` になる(TypeScript と同じ)。決まりが作業フォルダーの外のファイルを挙げない project でも、`reviewer` は agy で起動しない。人のいない fleet で、レビュアーが確認画面で止まらないことと引き換えにした
- 画面の判定を足す・直すときは screen の crate を書き、`launch` は変えない
- 配布するときの fleet-guard の置き場所は、段階 6 で決める(ADR `0242-phase-3-split`)

## 確かめたこと

- `cargo test --locked -p herdr-fleet-orchestrator --test launch --test opencode_config`(Arch Linux、rustc 1.99.1。`rust/rust-toolchain.toml` の版): launch 33 件、opencode_config 17 件が通る。安全上の判定の表 `opencodeConfig.json`(9 件)と `opencodeGitEnv.json`(10 件)は全件が一致し、設定の JSON は鍵の順まで TypeScript の `JSON.stringify` と同じ文字列になる
- 実装の前に同じコマンドを走らせ、stub の `todo!()` で launch 29 件(当時の 31 件のうち)、opencode_config 16 件が失敗することを確かめた。`/code-review high` の指摘で足した 2 件(node の `dirname` の値、`:low` のような model)と、architect の答えで変えた 3 件(`refusal` の 2 件、`guard_plugin_missing`)も、直す前に失敗することを確かめた
