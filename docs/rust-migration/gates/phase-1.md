# 段階 1 の関門の報告

- 確かめた日: 2026-11-08
- 確かめた対象: `rust` ブランチのコミット `bcac92e`(PR #164 のマージ)。報告を書く間に `rust` は `3e9f45f`(PR #165。`docs/rust-migration/plan.md` の段階 6 に 1 行を足しただけ)に進んだ。テストとスクリプトは変わっていないので、検査の結果はこのコミットにも当てはまる
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
| すべての基準が TypeScript 版で通る | 段階 1 までに作る 5 つの基準(下の「段階 1 の項目」の 1 行目)のうち、画面の corpus、会話ログの corpus、fleet CLI の契約、安全上の判定の表は、すべての件が通った。HTTP/WS の契約は `bun scripts/ci-tests.ts integration --target ts` が 190 件のうち 188 件通過、2 件失敗で、終了コード 1 で終わった(下の「HTTP/WS の契約の 2 件の失敗」)。UI の回帰は計画の表で「段階 4 で使う」なので、この関門では走らせていない(下の「この関門の読み方」) | 足りない(#167、#168) |
| parity.md に全テストファイルがある | `bun scripts/parity.ts` が `218 test files, 218 rows (65 without a successor yet), 0 problems` を出し、終了コード 0 で終わった。スクリプトとは別に `git ls-files` で数えると、`*.test.ts` と `*.test.tsx` が 172、`scripts/*-regression.ts` が 37、`scripts/*-qa.ts` が 6、`e2e/*.ts` が 1、`scripts/opencode-live-check.ts` と `scripts/pty-compare.ts` が 2 で、合わせて 218 になり、parity.md の行の数と一致した。引き継ぎ先の欄はどの行にもある(空欄の 65 行は ADR `0122-parity-criteria` が段階 7 までに埋めてよいとした) | 満たす |
| HTTP/WS の契約は、サーバーの起動の仕方を引数で選べる | `scripts/ci-tests.ts` が引数 `--target <ts\|rust:パス>` を受け、`HERDR_FLEET_CONTRACT_TARGET` として `bun test` に渡す(ソースで確かめた)。`--target bogus` を渡すと、使い方を示す `Usage: bun scripts/ci-tests.ts unit\|integration [--target ts\|rust:<path>]` を出して終了コード 1 で終わった。`scripts/contract/launch.ts` は `ts` で `scripts/contract/server.ts` を、`rust:<パス>` でその実行ファイルを起動する。`scripts/contract/launch.test.ts` の `the target` の 4 件(既定は ts、実行ファイルがないとき、listen の前に終わるとき、別のポートを告げるとき)が通った。integration は `--target ts` で走らせた | 満たす |

## 段階 1 の項目

| 項目(計画の段階 1) | 確かめたこと | 結果 |
|---|---|---|
| 上の表の「段階 1 で作る」をすべて作り、TypeScript 版で通す | 4 つの基準はすべてある。通るかは基準ごとに次のとおり | 足りない(#167、#168) |
| ― 画面の corpus(段階 1 より前の #103 で作った) | `bun test ./server/screen-fixtures.test.ts`(`fixtures/screens/` の 341 件の `case.json` を確かめる)が 343 件通過、0 件失敗 | 満たす |
| ― 会話ログの corpus | `fixtures/conversations/` に 5 つの source(claude、codex、omp、opencode、pi)、230 件の `case.json` がある。`bun test ./server/conversation-fixtures.test.ts` が 233 件通過、0 件失敗 | 満たす |
| ― fleet CLI の契約 | `fixtures/fleet-cli/` に 81 件がある。`bun test ./bin/fleet-cli-fixtures.test.ts` が 92 件通過、0 件失敗 | 満たす |
| ― 安全上の判定の表 | ADR `0122-parity-criteria` の表の 15 個の判定(core 11、child-process 2、orchestrator 2)の表が、`fixtures/security/<持ち主>/<判定>.json` にすべてある。`scripts/security-fixtures/` の 3 つのテストが 318 件通過、0 件失敗 | 満たす |
| ― HTTP/WS の契約 | `server/` の `*.contract.test.ts` は 15 ファイルで、`bun scripts/contract/check-imports.ts` が `15 black-box files, 0 forbidden imports, 0 contract tests without the marker` を出し、終了コード 0 で終わった。ADR が足すと決めた件(`core.fsmonitor` の印のファイルができないこと、`acceptLoopbackPush` なしのサーバーがベンダーでない push の宛先を拒むこと)は `server/device-access.contract.test.ts` にある。black-box にできない `it` は `*.herdr.test.ts` の 7 ファイルにある。`bun scripts/ci-tests.ts integration --target ts`(24 ファイル)は 188 件通過、2 件失敗 | 足りない(#167、#168) |
| 作るのは `rust` ブランチの中だけ(main は変えない) | 段階 1 の PR(#135、#137、#139、#140、#142、#143、#146、#147、#149〜#153、#157、#159、#161、#163、#164)は、`gh pr view <n> --json baseRefName` がどれも `rust` だった。同じ期間に base が `main` の PR(#138、#144、#148、#155、#156)は、どれも使う人(atriumnook)が自分の `fix/…` のブランチから出したもので、段階 1 の作業ではない | 満たす |
| HTTP/WS の契約は、サーバーの起動の仕方(TypeScript か Rust か)を引数で選べるようにする | 上の完了条件の 3 行目のとおり | 満たす |
| `docs/rust-migration/parity.md` に、TypeScript の全テストファイルを並べ、引き継ぎ先の欄を作る | 上の完了条件の 2 行目のとおり | 満たす |

## 検査の結果

| 検査 | 結果 |
|---|---|
| `bun scripts/parity.ts` | `218 test files, 218 rows (65 without a successor yet), 0 problems`、終了コード 0 |
| `bun scripts/contract/check-imports.ts` | `15 black-box files, 0 forbidden imports, 0 contract tests without the marker`、終了コード 0 |
| 画面の corpus の全件(`bun test ./server/screen-fixtures.test.ts`。`bun scripts/screen-fixtures.ts` は引数なしでは使い方を出して終わる書き込み用の道具で、全件の検査はこのテストが行う) | 343 件通過、0 件失敗 |
| `bun scripts/ci-tests.ts unit` | 148 ファイル、2,887 件通過、0 件失敗、終了コード 0。PR #159 のときの 1 件の失敗(#158)は PR #161 で直っていた |
| `HERDR_TEST_SESSION=herdr-fleet-rs-e50db2e2 bun scripts/ci-tests.ts integration --target ts` | 24 ファイル、190 件のうち 188 件通過、2 件失敗、終了コード 1(258 秒) |
| `bun run typecheck` | 終了コード 0 |
| `gh run list --branch rust` | 最新の run は workflow `rust` の [42438422150](https://github.com/atriumnook/herdr-fleet/actions/runs/42438422150)(`push`、`bcac92e`)で success |

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
- 計画の「一致を確かめる基準」の表の「状態」の欄は、4 つの基準をまだ「段階 1 で作る」と書いている。基準はできているが、表の書き換えは計画が段階 1 に求めていないので、足りないものには数えない

## 段階 1 の範囲の外で見つけたこと

- main にだけある TypeScript の変更: 計画は「main は切り替えまで変わらない」と書いているが、`git log --no-merges origin/rust..origin/main` は 9 コミット(PR #138、#144、#148、#155、#156、#166)で、`fixtures/screens/agy/` の 5 件、`server/fleet/` のテストと実装、`scripts/agy-live-check.ts` を含む。段階 1 の完了条件は rust ブランチの TypeScript で確かめるので、足りないものには数えない。取り込み方を [#169](https://github.com/atriumnook/herdr-fleet/issues/169)(ラベル `rust-migration`)に書いた
- 段階 0 から残っていた #119 と #120(段階 6 の workflow の件)は、この関門の間に閉じた(PR #165、#162)。どちらも段階 1 の範囲の外である
