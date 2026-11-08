# workflow `rust` に、TypeScript の実装で 2 つの corpus を走らせる job `ts-corpus` を足す

- 状態: 採用
- 決めた日: 2026-11-08
- Issue: #194

## 状況

ADR `0122-parity-criteria` は、TypeScript の答えとの一致を CI で確かめるかを段階 2 に残し、ADR `0192-phase-2-split` は、それを CI0(#194)で確かめると決めた。段階 2 の Issue は、画面の corpus(`fixtures/screens/`)や会話ログの corpus(`fixtures/conversations/`)の件が誤っていると判断して、期待値を変えることがある。決まり(`.herdr-fleet/standing.md` の関門 5)は、そのときの根拠を TypeScript の振る舞いなどの独立の情報源に求める。ところが、今の workflow `rust`(ADR `0110-workspace-and-ci`)が走らせるのは Rust の検査だけで、件を Rust の答えに合わせて書き換えても、Rust のテストは通り、TypeScript の実装との食い違いは CI で見えない。

決める必要があったのは次のこと。

- job が何を走らせ、何を走らせないか
- bun をどこから、どの版で、どう確かめて入れるか。ADR `0110-workspace-and-ci` は、使う action を `actions/checkout` だけにしている
- 件と TypeScript の実装の両方が誤っていたときに、どう直すか

前提と制約:

- `server/screen-fixtures.test.ts` と `server/conversation-fixtures.test.ts` は、node_modules がなくても通る(下の「確かめたこと」)
- `bunfig.toml` の `preload` は、`bun test` のたびに `scripts/test-herdr.ts` を読む。これは `HERDR_TEST_MODE=unit` のとき herdr を起動しない(`scripts/test-herdr.ts` の `useTestHerdr` の最初の行)。CI では herdr を使わない
- 決まりにより、workflow の権限は `contents: read` のままにし、secrets を使わず、リポジトリの設定(ruleset で必須の check を決めることを含む)を変えない

## 決定

### job `ts-corpus`(`.github/workflows/rust.yml`)

- 同じ workflow `rust` の 2 つ目の job にする。きっかけ(`rust` への push と、base が `rust` のすべての pull request)、`permissions: contents: read`、`concurrency` は、job `linux` と共有する
- runner は `ubuntu-24.04`、`timeout-minutes: 15`、手順は `shell: bash`(`-eo pipefail`)。作業フォルダーはリポジトリの根
- 手順は次の順に走らせる
  1. `actions/checkout`(job `linux` と同じ SHA `3d3c42e5aac5ba805825da76410c181273ba90b1`、`persist-credentials: false`)
  2. bun を入れる(下の「bun の入れ方」)
  3. `bun --version` が `1.4.4` を返すことを確かめる
  4. `HERDR_TEST_MODE=unit HERDR_SOCKET=/nonexistent/herdr.sock bun test server/screen-fixtures.test.ts server/conversation-fixtures.test.ts`
- `bun install` はしない。2 つのテストは node_modules を使わない。依存を入れると、npm からの取得が job に加わり、その取得の失敗でも job が赤になる。`bun test` は、node_modules がなくても import できないパッケージを npm から取得しない(bun 1.4.4 で確かめた。「確かめたこと」)ので、`--no-install` は付けない
- job の環境に置く `HERDR_*` は、テストのコマンドに付けた `HERDR_TEST_MODE=unit` と、存在しない socket を指す `HERDR_SOCKET` の 2 つだけで、どちらもそのコマンドにだけ渡す。job の `env` に置くのは `BUN_VERSION` と `BUN_SHA256` だけ
- cache は置かない。bun の zip は 51,794,595 バイトで、2 つのテストは手元で 0.7 秒で終わる。cache が節約できるのは zip の取得だけで、cache の action を足すと第三者の action が増える
- ruleset で `ts-corpus` を必須の check にはしない(決まりで設定を変えないため)。merge の前の関門は、決まりの関門 2 のとおり、エージェントが `gh pr checks <番号> --watch` で workflow のすべての job の結果を読むことで守る

### bun の入れ方

- 取得する: `https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip` を `curl --fail --location --retry 3 --retry-max-time 150 --connect-timeout 15 --max-time 60` で `$RUNNER_TEMP/bun/bun.zip` に保存する。この URL が失敗したら、警告を出し、同じ asset を REST API から取得する。`https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.4.4` が返す release の JSON を `$RUNNER_TEMP/bun/release.json` に保存し、その `assets` から、名前が `bun-linux-x64.zip` の asset の id を `jq --exit-status` で引き(2026-11-08 の値は 665259752)、`https://api.github.com/repos/oven-sh/bun/releases/assets/<id>` を `Accept: application/octet-stream` で取得する。どちらの URL から取っても、次の照合は同じ
  - asset の id を workflow に書かず、毎回 tag から引く理由: 書いておくと、版を上げる PR が id を変え忘れても、1 つ目の URL が通る間は気づかれない。1 つ目の URL が失敗したときに初めて古い版の zip を取り、照合で失敗する
  - 時間の上限を付ける理由: 応答が途中で止まった取得は、`--fail` と `--retry` では終わらない。上限がないと、job の `timeout-minutes` まで待って、2 つ目の URL を試さずに赤になる。1 回の試みは 60 秒(`--max-time`)まで、再試行は最初の試みから 150 秒(`--retry-max-time`)を過ぎたら始めないので、1 回の取得は最長で約 210 秒で終わる。2 つ目の URL に進むと取得は 3 回(1 つ目の URL、tag、asset)になり、最長で約 630 秒かかる。そのため `timeout-minutes` を 15 分にした。10 分のままでは、3 回の取得が上限まで延びたときに job が先に打ち切られる(再レビューの指摘)。zip は runner で、REST API から約 12 秒で取得できた(下の run 42465384924 の、手順の始まりから `downloaded from` までの時間で、1 つ目の URL の 4 回の 504 を含む)
  - 取得をファイルに書く理由: curl は再試行の前に `--output` のファイルを書き直すが、pipe に出した途中のデータは取り消せない。tag の JSON を pipe で `jq` に渡すと、途中で切れた応答と再試行で届いた応答がつながり、`jq` が失敗する(再レビューで、手元の HTTP サーバーで再現された)
  - 2 つ目の URL を置く理由: 2026-11-08 の作業中、`releases/download` の URL は、手元からも runner からも、`bun-linux-x64.zip` に 10 分以上 HTTP 504 を返し続けた(runner の run は https://github.com/atriumnook/herdr-fleet/actions/runs/42464358524 と https://github.com/atriumnook/herdr-fleet/actions/runs/42465082588)。同じ時刻に、同じ release の `SHASUMS256.txt` と `bun-darwin-aarch64.zip` は 302 を返し、REST API の asset の URL は `bun-linux-x64.zip` を返した。GitHub Status は `All Systems Operational` だった。この取得の失敗は TypeScript の実装とも件とも関係がない。2 つ目の URL で取れれば、job はこの失敗で赤にならない
  - REST API の URL を 1 つ目にしない理由: 認証のない REST API の呼び出しは、IP ごとに 1 時間 60 回までに制限される。runner の IP はほかの利用者と共有されうるので、毎回の取得に使うと、制限で失敗しうる。2 つ目の取得は REST API を 2 回呼ぶ(tag と asset)。認証に `GITHUB_TOKEN` を使えば制限は緩むが、この job は secrets を使わない
- 照合する: release `bun-v1.4.4` の `SHASUMS256.txt` にある `bun-linux-x64.zip` の行の sha256(`bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c`)を workflow の `BUN_SHA256` に書き、`sha256sum --check --strict` で比べる。一致しなければ、zip を開く前に job が失敗する
- 開く: `unzip` で `$RUNNER_TEMP/bun/bun-linux-x64/bun` に取り出し、そのフォルダーを `$GITHUB_PATH` に足す
- 版は 1.4.4 にする。fleet が使う bun(`~/.local/share/mise/installs/bun/1.4.4`)と同じ版で、手元と CI で同じ版の TypeScript の実装の答えを比べるため
- `bun-linux-x64.zip`(AVX2 を使う版)を使う。GitHub がホストする `ubuntu-24.04` の x64 の runner で、この版がテストを通した(「確かめたこと」)。`baseline`(AVX2 を使わない版)は、AVX2 のない CPU で動かすためのもので、要らない
- 版を上げるときは、`BUN_VERSION` と `BUN_SHA256` を同じ PR で変え、新しい sha256 を、その release の `SHASUMS256.txt` から取る。この ADR を置き換える ADR を書く

### 件と TypeScript の実装の両方が誤っていたとき

- 件だけを変えて TypeScript の実装を変えない PR は、`ts-corpus` で赤になる。これは意図した振る舞いである。Rust の答えに合わせて件を変えたことが、merge の前に見える
- 件と TypeScript の実装のどちらも誤っていると分かったときは、段階 2 の Issue の中では直さず、別の Issue(ラベル `rust-migration`)にする。その Issue が、TypeScript の実装と件を 1 つの PR で直す(ADR `0192-phase-2-split`)。その PR では `ts-corpus` が緑のまま件が変わる。誤りの根拠は、決まりの関門 5 のとおり、独立の情報源(仕様、Issue、実物の画面やログ)で示す

## 検討した代わり

- `oven-sh/setup-bun` で bun を入れる: 第三者の action が増える。ADR `0110-workspace-and-ci` は、使う action を `actions/checkout` だけにしている
- `curl -fsSL https://bun.sh/install | bash` で入れる: 取得したスクリプトを照合せずに実行する。入る版もスクリプトの中身で決まる
- `bun install --ignore-scripts` をしてからテストを走らせる: 2 つのテストは依存を使わない。依存を入れると、npm の取得と、その失敗による赤が job に加わる
- release の `SHASUMS256.txt` を CI で取得して照合する: 同じ release から取った値で照合しても、release の差し替えには気づけない。workflow に書いた値なら、変えるには PR が要る
- `SHASUMS256.txt.asc` の PGP 署名を CI で確かめる: 署名の鍵を鍵サーバーから取得する手順と、その鍵の指紋の固定が要る。workflow に sha256 を書いたので、CI は毎回その値で照合し、release の zip が後から差し替えられれば失敗する。署名が確かめるのは、sha256 を取ったときの `SHASUMS256.txt` が Oven の公開したものかで、これは workflow に値を書く前に手元で 1 回確かめれば足りる(「確かめたこと」)
- job `linux` の手順に足す: `linux` は `rust/` を作業フォルダーにした Rust の検査で、bun を入れると Rust の検査の失敗と bun の取得の失敗が同じ job の赤になる。job を分ければ、PR の check の名前でどちらが失敗したかが分かる
- TypeScript の全テストを走らせる: herdr を使うテストがあり、CI では herdr を使わない。この job の目的は、段階 2 が変えうる 2 つの corpus の件と TypeScript の実装の一致だけである

## 依存

| 名前 | 版 | 入手元 | ライセンス | 保守の状況 | `build.rs` |
|---|---|---|---|---|---|
| bun(`bun-linux-x64.zip`) | 1.4.4(release `bun-v1.4.4`、2026-10-22 公開)。sha256 `bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c` | GitHub の release(`github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip`。失敗したら同じ asset を `api.github.com/repos/oven-sh/bun/releases/assets/665259752` から) | MIT。静的にリンクした JavaScriptCore と WebKit は LGPL-2、ほかのライブラリはそれぞれのライセンス(bun のリポジトリの `LICENSE.md`)。CI で実行するだけで、配布しない | Oven が保守している。1.4.4 は 2026-10-22 に公開された | なし(crate ではない) |

`actions/checkout` は ADR `0110-workspace-and-ci` と同じ SHA を使い、新しく足さない。crate は足さない。

## 結果

- `rust` への push と base `rust` のすべての PR に、workflow `rust` の job `ts-corpus` が付く。画面の corpus と会話ログの corpus のどれかの件が TypeScript の実装の答えと合わないと赤になる
- 段階 2 の PR は、件の期待値を変えると赤になる。TypeScript の実装が件を通している以上、Rust の答えと件が食い違うのは、Rust の実装が誤っているか、件と TypeScript の実装の両方が誤っているかのどちらかである。前者は Rust の実装を直す。後者は、上の「件と TypeScript の実装の両方が誤っていたとき」のとおり別の Issue にして、その Issue を待つ
- bun の版を上げるときは、`BUN_VERSION` と `BUN_SHA256` を同じ PR で変える。片方だけを変えると、照合か版の確認で job が失敗する
- 2 つ目の URL の手順は、1 つ目の URL が失敗したときだけ走る。2026-11-08 の run では走った(下の「確かめたこと」)が、1 つ目が通る間は CI で走らない
- `ts-corpus` は ruleset の必須の check ではないので、赤のままでも GitHub はマージを止めない。止めるのは、決まりの関門 2 に従ってマージの前に workflow のすべての job を読むエージェントである
- `ts-corpus` は TypeScript の 2 つのテストファイルだけを走らせる。それ以外の TypeScript のテストは、CI で走らない

## 確かめたこと

2026-11-08、Linux 7.2.15-1-omarchy(Arch Linux 系の Omarchy)で確かめた。

- `gh release download bun-v1.4.4 -R oven-sh/bun -p SHASUMS256.txt` で取得した `SHASUMS256.txt` の `bun-linux-x64.zip` の行は `bf8ccbfb…395c`。`gh release view bun-v1.4.4 -R oven-sh/bun --json assets` の asset の `digest` も `sha256:bf8ccbfb…395c` で、同じ値だった。`SHASUMS256.txt.asc` の署名を、Bun のリポジトリの `dockerhub/debian/Dockerfile`(`main` のコミット `2596ac5d391d47804c93a42bdbe615804aa62387`)に埋め込まれた公開鍵で確かめた。空の `GNUPGHOME` に鍵を入れ、`gpg --batch --assert-signer F3DCC08A8572C0749B3E18888EAB4D40A7B22B59 --verify --output SHASUMS256.verified.txt SHASUMS256.txt.asc` が `Good signature from "Robobun <robobun@oven.sh>"` を出して終了コード 0 で終わり、署名された本文の `bun-linux-x64.zip` の行も `bf8ccbfb…395c` だった。取得した zip に `sha256sum -c` を当てると `完了`(一致)。取り出した `bun --version` は `1.4.4`
- node_modules のないツリーで通ること: `git archive HEAD` を一時フォルダーに取り出し(node_modules はない)、`env -i PATH=/usr/bin:/bin HOME=<空のフォルダー> HERDR_TEST_MODE=unit HERDR_SOCKET=/nonexistent/herdr.sock <取得した bun> test server/screen-fixtures.test.ts server/conversation-fixtures.test.ts` が `582 pass`、`0 fail`、`Ran 582 tests across 2 files.` で終わった。同じコマンドを `unshare -rn`(ネットワークのない名前空間。`curl https://github.com` は `Could not connect to server` で失敗した)で走らせても `582 pass`、`0 fail`
- `bun test` が import できないパッケージを取得しないこと: node_modules のないフォルダーで、`is-number` を import するテストを、空の HOME とネットワークありで、`--no-install` を付けずに走らせた。`Cannot find package 'is-number'` で失敗し、`~/.bun/install/cache` には transpiler の cache(`@t@`)のほかに何もできなかった。`--no-install` を付けても同じ結果だった
- 期待値を 1 つ変えると失敗すること: 上の一時フォルダーで、`fixtures/screens/claude/a-command-line-that-reads-tip-is-part-of-a-scrolled-approval-1/case.json` の `title` を `"Command approval"` から変えると、`(fail) screen corpus > claude/a-command-line-that-reads-tip-is-part-of-a-scrolled-approval-1`、`581 pass`、`1 fail`、終了コード 1
- workflow の「Install bun」の手順を YAML から取り出し、`RUNNER_TEMP` と `GITHUB_PATH` を一時フォルダーに向けて `bash --noprofile --norc -eo pipefail` で走らせた。この時点で 1 つ目の URL は 504 を返していた
  - workflow の値のまま: `::warning::the release download URL failed; taking the same asset through the REST API`、`downloaded from https://api.github.com/repos/oven-sh/bun/releases/assets/665259752`、`bun.zip: 完了`、終了コード 0 で、`$GITHUB_PATH` に `…/bun/bun-linux-x64` が書かれた
  - `BUN_SHA256` を 0 が 64 個の値にする: `sha256sum: 警告: 1 個の計算したチェックサムが一致しませんでした` で終了コード 1。zip は開かれず、`$GITHUB_PATH` に何も書かれなかった
  - `BUN_VERSION` を存在しない版にする(両方の URL が失敗する): tag の REST API が `curl: (22) The requested URL returned error: 404` を返し、終了コード 22 で、`$GITHUB_PATH` に何も書かれなかった
- PR の run で確かめた(PR の途中の commit。わざと変えた期待値は、次の commit で戻した)
  - 緑: https://github.com/atriumnook/herdr-fleet/actions/runs/42465384924 。1 つ目の URL が 504 で、`downloaded from https://api.github.com/repos/oven-sh/bun/releases/assets/665259752`、`/home/runner/work/_temp/bun/bun.zip: OK`、`582 pass`。job は 21 秒で終わった
  - 赤: https://github.com/atriumnook/herdr-fleet/actions/runs/42465449664 。上と同じ件の `title` を `"Command approval (broken on purpose)"` に変えた commit で、`(fail) screen corpus > claude/a-command-line-that-reads-tip-is-part-of-a-scrolled-approval-1`、`581 pass`、`1 fail`、`Process completed with exit code 1.`
  - 戻したあとの緑: https://github.com/atriumnook/herdr-fleet/actions/runs/42465520043 。`ts-corpus` と `linux` がどちらも success
  - レビューの指摘で取得の手順を今の形(時間の上限、tag から asset の id を引く)に直したあとの緑: https://github.com/atriumnook/herdr-fleet/actions/runs/42465978445 。1 つ目の URL が 504 を 4 回返し、`##[warning]the release download URL failed; taking the same asset through the REST API` のあと、0.4 秒で `downloaded from https://api.github.com/repos/oven-sh/bun/releases/assets/665259752`、`bun.zip: OK`。runner の `jq` が使えることもこの run で確かめた。テストの手順は、赤と緑を確かめた run から変えていない
