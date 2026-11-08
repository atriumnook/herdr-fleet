# 段階 1 の関門の報告

- 確かめた日: 2026-11-08
- 確かめた対象: `rust` ブランチのコミット `bcac92e`(PR #164 のマージ)。報告を書く間に `rust` は `3e9f45f`(PR #165 のマージ)に進んだ。`git diff --stat bcac92e 3e9f45f` は `docs/rust-migration/plan.md | 1 +` の 1 ファイルだけで、テストもスクリプトも fixtures も変わっていないので、下の検査の結果は `3e9f45f` にも当てはまる。`3e9f45f` をマージしたこの報告のブランチで、`bun scripts/parity.ts` と `bun scripts/contract/check-imports.ts` を走らせ直し、同じ結果だった
- 確かめた thread: `e50db2e2`
- 結論: 計画(`docs/rust-migration/plan.md`)の「段階 1: 一致を確かめる基準を揃える」のうち、完了条件「すべての基準が TypeScript 版で通る」を満たさない。HTTP/WS の契約の 2 件が TypeScript 版で通らず、integration の全件の実行が終了コード 1 で終わる。足りないものは 2 件で、Issue #167 と #168 を開いた。ほかの完了条件(parity.md に全テストファイルがある、HTTP/WS の契約のサーバーの起動の仕方を引数で選べる)と段階 1 のほかの項目は満たす。段階 1 の Issue(#122〜#134)と、途中で見つかった #136・#141・#154・#158・#160 はすべて閉じている(PR #135〜#164)

## 確かめた環境

- PC: Linux 7.2.15-1-omarchy、Bun 1.4.4、herdr 0.9.1(`/usr/bin/herdr`)
- 依存は `bun install --ignore-scripts` で入れた
- 検査はすべて `HERDR_*` の環境変数を外して実行した(`env $(env | grep -oE '^HERDR[A-Z_]*' | sed 's/^/-u /') …`)
- integration は、この thread 専用の herdr のセッション `herdr-fleet-rs-e50db2e2`(`HERDR_TEST_SESSION`)で走らせ、終わってから `herdr --session herdr-fleet-rs-e50db2e2 server stop` で止めた。`HERDR_FLEET_STATE_DIR` は worktree の中の `rust/.dev-state/state` にした。HTTP/WS の契約のサーバーは、launcher(`scripts/contract/launch.ts`)が 7400〜7499 から選んだポートで起動した

## 完了条件

| 完了条件 | 確かめたこと | 結果 |
|---|---|---|
| すべての基準が TypeScript 版で通る | 段階 1 までに作る 5 つの基準(下の「段階 1 の項目」の 1 行目)のうち、画面の corpus、会話ログの corpus、fleet CLI の契約、安全上の判定の表は、すべての件が通った。HTTP/WS の契約(`server/` の `*.contract.test.ts` の 15 ファイル、168 件)は、2 件が失敗した。契約を走らせる `bun scripts/ci-tests.ts integration --target ts` は、契約のほかに herdr を使う 9 ファイル(22 件)も走らせ、合わせて 190 件のうち 188 件通過、2 件失敗で、終了コード 1 で終わった。失敗した 2 件はどちらも契約の件である(下の「HTTP/WS の契約の 2 件の失敗」)。UI の回帰は計画の表で「段階 4 で使う」なので、この関門では走らせていない(下の「この関門の読み方」) | 足りない(#167、#168) |
| parity.md に全テストファイルがある | `bun scripts/parity.ts` が `218 test files, 218 rows (65 without a successor yet), 0 problems` を出し、終了コード 0 で終わった。スクリプトとは別に `git ls-files` で数えると、`*.test.ts` と `*.test.tsx` が 172、`scripts/*-regression.ts` が 37、`scripts/*-qa.ts` が 6、`e2e/*.ts` が 1、`scripts/opencode-live-check.ts` と `scripts/pty-compare.ts` が 2 で、合わせて 218 になり、parity.md の行の数と一致した。引き継ぎ先の欄はどの行にもある(空欄の 65 行は ADR `0122-parity-criteria` が段階 7 までに埋めてよいとした) | 満たす |
| HTTP/WS の契約は、サーバーの起動の仕方を引数で選べる | `scripts/ci-tests.ts` が引数 `--target <ts\|rust:パス>` を受け、`HERDR_FLEET_CONTRACT_TARGET` として `bun test` に渡す(ソースで確かめた)。`--target bogus` を渡すと、使い方を示す `Usage: bun scripts/ci-tests.ts unit\|integration [--target ts\|rust:<path>]` を出して終了コード 1 で終わった。`scripts/contract/launch.ts` は `ts` で `scripts/contract/server.ts` を、`rust:<パス>` でその実行ファイルを起動する。`scripts/contract/launch.test.ts` の `the target` の 4 件(既定は ts、実行ファイルがないとき、listen の前に終わるとき、別のポートを告げるとき)が通った。integration は `--target ts` で走らせた | 満たす |

## 段階 1 の項目

| 項目(計画の段階 1) | 確かめたこと | 結果 |
|---|---|---|
| 上の表の「段階 1 で作る」をすべて作り、TypeScript 版で通す | 「段階 1 で作る」の 4 つの基準(会話ログの corpus、fleet CLI の契約、HTTP/WS の契約、安全上の判定の表)はすべてある。このうち HTTP/WS の契約が TypeScript 版で通らない。下の 5 行に、4 つの基準と、完了条件の「すべての基準」に入る画面の corpus の結果を並べた | 足りない(#167、#168) |
| ― 画面の corpus(段階 1 より前の #103 で作った。この項目ではなく、完了条件の「すべての基準」に入る) | `bun test ./server/screen-fixtures.test.ts`(`fixtures/screens/` の 341 件の `case.json` を確かめる)が 343 件通過、0 件失敗 | 満たす |
| ― 会話ログの corpus | `fixtures/conversations/` に 5 つの source(claude、codex、omp、opencode、pi)、230 件の `case.json` がある。`bun test ./server/conversation-fixtures.test.ts` が 233 件通過、0 件失敗 | 満たす |
| ― fleet CLI の契約 | `fixtures/fleet-cli/` に 81 件がある。`bun test ./bin/fleet-cli-fixtures.test.ts` が 92 件通過、0 件失敗 | 満たす |
| ― 安全上の判定の表 | ADR `0122-parity-criteria` の表の 15 個の判定(core 11、child-process 2、orchestrator 2)が、`fixtures/security/<持ち主>/<判定>.json` にすべてある。`scripts/security-fixtures/` の 3 つのテストが 318 件通過、0 件失敗 | 満たす |
| ― HTTP/WS の契約 | `server/` の `*.contract.test.ts` は 15 ファイルで、`bun scripts/contract/check-imports.ts` が `15 black-box files, 0 forbidden imports, 0 contract tests without the marker` を出し、終了コード 0 で終わった。ADR が足すと決めた件(`core.fsmonitor` の印のファイルができないこと、`acceptLoopbackPush` なしのサーバーがベンダーでない push の宛先を拒むこと)は `server/device-access.contract.test.ts` にある。black-box にできない `it` は、ADR が挙げた 5 種類のとおり `server/` の `api`、`device-access`、`output`、`secret`、`submit` の `*.herdr.test.ts` の 5 ファイルに移った(ほかの `*.herdr.test.ts` は、`HerdrRuntime` を試す `server/fleet/runtime.herdr.test.ts` と、launcher 自身を試す `scripts/contract/launch.herdr.test.ts`)。契約の 15 ファイル、168 件のうち 2 件が失敗した(上の完了条件の 1 行目) | 足りない(#167、#168) |
| 作るのは `rust` ブランチの中だけ(main は変えない) | 段階 1 の PR(#135、#137、#139、#140、#142、#143、#146、#147、#149〜#153、#157、#159、#161、#163、#164)は、`gh pr view <n> --json baseRefName` がどれも `rust` だった。同じ番号の範囲の、段階 1 でない PR #145(reviewer の設定)と #162(#120)も、base は `rust` だった。同じ期間に base が `main` の PR(#138、#144、#148、#155、#156)は、どれも使う人(atriumnook)が自分の `fix/…` のブランチから出したもので、段階 1 の作業ではない | 満たす |
| HTTP/WS の契約は、サーバーの起動の仕方(TypeScript か Rust か)を引数で選べるようにする | 上の完了条件の 3 行目のとおり | 満たす |
| `docs/rust-migration/parity.md` に、TypeScript の全テストファイルを並べ、引き継ぎ先の欄を作る | 上の完了条件の 2 行目のとおり | 満たす |

## 検査の結果

| 検査 | 結果 |
|---|---|
| `bun scripts/parity.ts` | `218 test files, 218 rows (65 without a successor yet), 0 problems`、終了コード 0 |
| `bun scripts/contract/check-imports.ts` | `15 black-box files, 0 forbidden imports, 0 contract tests without the marker`、終了コード 0 |
| 画面の corpus の全件(`bun test ./server/screen-fixtures.test.ts`。`bun scripts/screen-fixtures.ts` は引数なしでは使い方を出して終わる書き込み用の道具で、全件の検査はこのテストが行う) | 343 件通過、0 件失敗 |
| `bun scripts/ci-tests.ts unit` | 148 ファイル、2,887 件通過、0 件失敗、終了コード 0。PR #159 のときの 1 件の失敗(#158)は PR #161 で直っていた |
| `HERDR_TEST_SESSION=herdr-fleet-rs-e50db2e2 bun scripts/ci-tests.ts integration --target ts` | 24 ファイル(契約の `*.contract.test.ts` 15 ファイル 168 件と、`*.herdr.test.ts` 7 ファイル、`server/herdr/client.test.ts`、`server/pty/session.test.ts` の 9 ファイル 22 件)、190 件のうち 188 件通過、2 件失敗、終了コード 1(258 秒) |
| `bun run typecheck` | 終了コード 0 |
| `gh run list --branch rust` | 確かめたコミット `bcac92e` の run は、workflow `rust` の [42438422150](https://github.com/atriumnook/herdr-fleet/actions/runs/42438422150)(`push`)で success。報告を書いたあとの最新の run は、`3e9f45f` の [42438876799](https://github.com/atriumnook/herdr-fleet/actions/runs/42438876799)(`push`)で success |

## HTTP/WS の契約の 2 件の失敗

`CLAUDE.md` は integration の既知の失敗を 3 つ挙げている。全件の実行の結果と、その件だけを走らせた結果(`bun test --timeout 15000 <ファイル> -t "<名前>"`、同じセッションと環境)は次のとおり。

| 件 | 全件の実行 | 単独 | `CLAUDE.md` の扱い | PR #159(#134)の結果 |
|---|---|---|---|---|
| `server/submit.contract.test.ts` の `a herdr without terminal attach (Windows) > hands several lines for an agent on a mirrored pane over as one paste, typed or sent, and bare where no agent is` | 失敗(`frame not received within 15000ms`) | 失敗(0 件通過、1 件失敗) | 上流の v0.3.45 でも同じように失敗する | 全件でも単独でも失敗 |
| `server/output.contract.test.ts` の `real terminal output flow control > bounds a stalled observer, releases the operator, and leaves the pane alive` | 失敗(`Timed out: observer high watermark`) | 通過(1 件通過、0 件失敗) | 全件のときだけ負荷で失敗しうる | 全件で失敗、単独で通過 |
| `server/attach-held.contract.test.ts` | 失敗なし | 6 件通過、0 件失敗 | 全件のときだけ負荷で失敗しうる | 全件でも単独でも失敗なし |

parity.md は、2 つのファイルの引き継ぎ先をどちらも `HTTP/WS の契約` とし、失敗する件を除いていない。PR #159 は 2 件を既知の失敗として記録し、Issue は開かなかった。

この関門は、2 件を足りないものに数える。段階 4 の完了条件は Rust の core が同じ契約を通すことだが、TypeScript 版が通らない件では、Rust の core の結果が正しいかを TypeScript 版と比べて決められない。全件の実行が終了コード 1 で終わる間は、「契約が通る」を終了コードで確かめることもできない。

- [#167](https://github.com/atriumnook/herdr-fleet/issues/167): Windows のミラー表示の paste の件が TypeScript 版で通らない。テストと実装のどちらが誤っているかを確かめ、誤っている側を直すことを勧めた。待つ Issue はない
- [#168](https://github.com/atriumnook/herdr-fleet/issues/168): output の flow control の件が全件の実行で失敗する。確かめた 2 回の全件の実行(この関門と PR #159)で、2 回とも失敗した。負荷で落ちる原因を確かめ、原因のある側を直すことを勧めた。待つ Issue はない

## この関門の読み方

- 完了条件の「すべての基準」を、計画の「一致を確かめる基準」の表で、状態が「あり」か「段階 1 で作る」の 5 つの基準と読んだ。UI の回帰は表で「段階 4 で使う」とされている。また `scripts/ui-regression.ts` と `scripts/fleet-screen-regression.ts` はサーバーを `port: 0`(OS が選ぶポート)で起動し、決まりのポートの範囲(7400〜7499)の外で待ち受ける。そのため、この関門では走らせていない
- 計画の「一致を確かめる基準」の表の「状態」の欄は、4 つの基準をまだ「段階 1 で作る」と書いている。基準はできているが、表の書き換えは計画が段階 1 に求めていないので、足りないものには数えない。書き換えは [#172](https://github.com/atriumnook/herdr-fleet/issues/172)(ラベル `rust-migration`)に書いた

## 段階 1 の範囲の外で見つけたこと

- main にだけある TypeScript の変更: 計画は「main は切り替えまで変わらない」と書いているが、`git log --no-merges origin/rust..origin/main` は 9 コミット(PR #138、#144、#148、#155、#156、#166)で、`fixtures/screens/agy/` の 5 件、`server/fleet/` のテストと実装、`scripts/agy-live-check.ts` を含む。段階 1 の完了条件は rust ブランチの TypeScript で確かめるので、足りないものには数えない。取り込み方を [#169](https://github.com/atriumnook/herdr-fleet/issues/169)(ラベル `rust-migration`)に書いた
- 段階 0 から残っていた #119 と #120(段階 6 の workflow の件)は、どちらも段階 1 の範囲の外で、今は閉じている。#120 は確かめたコミット `bcac92e` より前に PR #162 で、#119 はこの関門の間に PR #165 で閉じた

## 2 回目の関門(2026-11-08)

- 確かめた対象: `rust` ブランチのコミット `5cbfd8e`(PR #188 のマージ)
- 確かめた thread: `0d0b5ca0`
- 結論: 計画の「段階 1: 一致を確かめる基準を揃える」の完了条件 2 つと項目 4 つを、すべて満たす。足りないものは 0 件で、Issue は開いていない。1 回目に足りなかった #167 と #168 の件は、integration の全件の実行 3 回のすべてと、その件だけの実行で通った
- 1 回目のあとに閉じた Issue: #167(PR #177)、#168(PR #181)、#172(PR #174)、#173(PR #178)、#179(PR #182)、#180(PR #186)、#169 と #187(main の取り込み。PR #175 と #188)。`git log --no-merges origin/rust..origin/main` は 0 コミットで、main にだけある TypeScript の変更は残っていない。開いている #176 と #189 は、使う人の main での作業を待つ `blocked` の Issue で、段階 1 の範囲の外である

### 確かめた環境(2 回目)

- PC と道具の版は 1 回目と同じ(Linux 7.2.15-1-omarchy、Bun 1.4.4、herdr 0.9.1)。依存は `bun install --ignore-scripts` で入れた
- 検査はすべて `HERDR_*` の環境変数を外して実行した
- integration は、この thread 専用の herdr のセッション `herdr-fleet-rs-0d0b5ca0`(`HERDR_TEST_SESSION`)で走らせ、`HERDR_FLEET_STATE_DIR` を worktree の中の `rust/.dev-state/state` にした。HTTP/WS の契約のサーバーは、launcher(`scripts/contract/launch.ts`)が 7400〜7499 から選んだポートで起動した。終わってから `herdr --session herdr-fleet-rs-0d0b5ca0 server stop` で止めた(終了コード 0)
- integration の 3 回は続けて 1 回ずつ走らせ、そのあいだにほかの検査を走らせなかった。全件のときに負荷で失敗しうる件(#168)の結果に、ほかの検査の負荷が混ざらないようにするためである
- 共有の `/tmp/zsh-job-queue`(#179)は、検査の前に `find /tmp/zsh-job-queue` の一覧を保存し、すべての検査のあとの一覧と `diff` で比べた。差はなく、検査の前に作った印のファイルより新しいファイルを `find -newer` で探しても 0 件だった

### 完了条件(2 回目)

| 完了条件 | 確かめたこと | 結果 |
|---|---|---|
| すべての基準が TypeScript 版で通る | 段階 1 までに作る 5 つの基準(画面の corpus、会話ログの corpus、fleet CLI の契約、HTTP/WS の契約、安全上の判定の表)のすべての件が通った(下の「段階 1 の項目(2 回目)」)。HTTP/WS の契約を走らせる `bun scripts/ci-tests.ts integration --target ts` は、3 回とも 25 ファイル 191 件が通過、0 件失敗、終了コード 0 で終わった。UI の回帰は、1 回目と同じ読み方(上の「この関門の読み方」)で走らせていない | 満たす |
| parity.md に全テストファイルがある | `bun scripts/parity.ts` が `221 test files, 221 rows (67 without a successor yet), 0 problems` を出し、終了コード 0 で終わった。`git ls-files` で別に数えると、`*.test.ts` と `*.test.tsx` が 174、`scripts/*-regression.ts` が 37、`scripts/*-qa.ts` が 6、`e2e/*.ts` が 1、`scripts/opencode-live-check.ts`、`scripts/pty-compare.ts`、`scripts/agy-live-check.ts`(#169 で main から取り込んだ)が 3 で、合わせて 221 になり、parity.md の行の数と一致した。1 回目の 218 から増えた 3 つは、`scripts/contract/test-shell.herdr.test.ts`(#179)、`scripts/agy-live-check.ts`(#169)、`server/fleet/metrics.test.ts`(#187 で main から取り込んだ)である | 満たす |

### 段階 1 の項目(2 回目)

| 項目(計画の段階 1) | 確かめたこと | 結果 |
|---|---|---|
| 上の表の会話ログの corpus、fleet CLI の契約、HTTP/WS の契約、安全上の判定の表をすべて作り、TypeScript 版で通す | 4 つの基準はすべてあり、すべての件が通った。下の 5 行に、4 つの基準と、完了条件の「すべての基準」に入る画面の corpus の結果を並べた | 満たす |
| ― 画面の corpus(完了条件の「すべての基準」に入る) | `bun test ./server/screen-fixtures.test.ts`(`fixtures/screens/` の 347 件の `case.json` を確かめる)が 349 件通過、0 件失敗。`bun scripts/screen-fixtures.ts` は引数なしでは使い方を出して終わる書き込み用の道具で、全件の検査はこのテストが行う | 満たす |
| ― 会話ログの corpus | `fixtures/conversations/` に 5 つの source(claude、codex、omp、opencode、pi)、230 件の `case.json` がある。`bun test ./server/conversation-fixtures.test.ts` が 233 件通過、0 件失敗 | 満たす |
| ― fleet CLI の契約 | `fixtures/fleet-cli/` に 87 件がある。`bun test ./bin/fleet-cli-fixtures.test.ts` が 98 件通過、0 件失敗 | 満たす |
| ― 安全上の判定の表 | ADR `0122-parity-criteria` の表の 15 個の判定が、`fixtures/security/<持ち主>/<判定>.json`(core 11、child-process 2、orchestrator 2)にすべてある。`scripts/security-fixtures/` の 3 つのテストが 318 件通過、0 件失敗 | 満たす |
| ― HTTP/WS の契約 | `bun scripts/contract/check-imports.ts` が `15 black-box files, 0 forbidden imports, 0 contract tests without the marker` を出し、終了コード 0 で終わった。integration の 3 回の全件の実行で、契約の 15 ファイルを含む 25 ファイル 191 件が、3 回とも通過した。#167 と #168 の件の結果は下の「1 回目に足りなかった 2 件」に書いた | 満たす |
| 作るのは `rust` ブランチの中だけ(main は変えない) | 1 回目のあとにマージされた PR(#170、#174、#175、#177、#178、#181、#182、#185、#186、#188)は、`gh pr view <n> --json baseRefName` がどれも `rust` だった(#170 は 1 回目の報告)。同じ期間に base が `main` の PR(#171、#183、#184)は、どれも使う人(atriumnook)が自分の `feat/…` か `fix/…` のブランチから出したもので、段階 1 の作業ではない | 満たす |
| HTTP/WS の契約は、サーバーの起動の仕方(TypeScript か Rust か)を引数で選べるようにする | `scripts/ci-tests.ts` は引数 `--target <ts\|rust:パス>` を受ける。`--target bogus` を渡すと `Usage: bun scripts/ci-tests.ts unit\|integration [--target ts\|rust:<path>]` を出して終了コード 1 で終わった。`scripts/contract/launch.ts` は `ts` で TypeScript のサーバーを、`rust:<パス>` でその実行ファイルを起動する(ソースで確かめた)。launcher のテスト `scripts/contract/launch.test.ts` は unit の全件の中で通った | 満たす |
| `docs/rust-migration/parity.md` に、TypeScript の全テストファイルを並べ、引き継ぎ先の欄を作る | 上の完了条件の 2 行目のとおり | 満たす |

### 1 回目に足りなかった 2 件

| 件 | 1 回目 | 2 回目の全件の実行(3 回) | 2 回目の単独の実行 | 直した PR |
|---|---|---|---|---|
| `server/submit.contract.test.ts` の `hands several lines for an agent on a mirrored pane over as one paste, typed or sent, and bare where no agent is`(#167) | 全件でも単独でも失敗 | 3 回とも失敗なし | 1 件通過、0 件失敗 | #177。ペインのシェルの設定を読まずに `cat -v` を動かすようにした |
| `server/output.contract.test.ts` の `bounds a stalled observer, releases the operator, and leaves the pane alive`(#168) | 全件で失敗、単独で通過 | 3 回とも失敗なし | 1 件通過、0 件失敗 | #181。テストのシェルを専用の HOME から起動するようにした |

- 単独の実行は `bun test --timeout 15000 <ファイル> -t "<名前の一部>"` で、integration と同じセッションと環境で走らせた
- 全件の実行のログには件ごとの通過の行が出ない(`bun test` は失敗した件だけを名前で出す)。2 件が全件の実行で通ったことは、191 件のうち失敗 0 件、skip 0 件(ログに `skip` の行がない)から確かめた
- 直した PR がテストの期待値を弱めていないかを、差分で確かめた。PR #177 と #181 は `expect` の行を変えていない。#180 を直した PR #186 は `expect` を 1 行書き換えたが、同じメッセージ(`id` が 1 の `submit-result`)を取り出す関数 `first()` に置き換えただけで、期待する値 `{ ok: true }` は変わっていない

### 検査の結果(2 回目)

| 検査 | 結果 |
|---|---|
| `bun scripts/parity.ts` | `221 test files, 221 rows (67 without a successor yet), 0 problems`、終了コード 0 |
| `bun scripts/contract/check-imports.ts` | `15 black-box files, 0 forbidden imports, 0 contract tests without the marker`、終了コード 0 |
| 画面の corpus の全件(`bun test ./server/screen-fixtures.test.ts`) | 349 件通過、0 件失敗 |
| `bun scripts/ci-tests.ts unit` | 149 ファイル、2,927 件通過、0 件失敗、終了コード 0 |
| `HERDR_TEST_SESSION=herdr-fleet-rs-0d0b5ca0 bun scripts/ci-tests.ts integration --target ts`(1 回目) | 25 ファイル、191 件通過、0 件失敗、終了コード 0(217 秒) |
| 同(2 回目) | 25 ファイル、191 件通過、0 件失敗、終了コード 0(217 秒) |
| 同(3 回目) | 25 ファイル、191 件通過、0 件失敗、終了コード 0(217 秒) |
| `bun run typecheck` | 終了コード 0 |
| `gh run list --branch rust` | 確かめたコミット `5cbfd8e` の run は、workflow `rust` の [42455073935](https://github.com/atriumnook/herdr-fleet/actions/runs/42455073935)(`push`)で success。これが `rust` の最新の run である |

integration の対象は 1 回目の 24 ファイルから 25 ファイルに増えた。増えたのは `scripts/contract/test-shell.herdr.test.ts`(#179 で足した。テストの herdr のペインの zsh が、使う人のフォルダーではなくテスト自身のフォルダーから起動ファイルを読むことを確かめる)である。
