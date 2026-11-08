# workflow `rust-cross` を `workflow_dispatch` だけで走らせる

- 状態: 採用
- 決めた日: 2026-11-08
- Issue: #120
- 置き換える: 0111-cross-build(trigger、`gate` ジョブ、走らせる手順だけ。ほかの決定は `0111-cross-build` のまま。下の「決定」)

## 状況

`0111-cross-build` は、macOS と Windows 向けのビルドの workflow `.github/workflows/rust-cross.yml` を、`workflow_dispatch` に加えて、base が `rust` でこのファイル自身を変える `pull_request` でも走らせると決めた。PR への push では、`gate` ジョブが push の前と後の head を比べ、このファイルに差がなければビルドのジョブを skipped にする。`pull_request` の trigger を置いた理由は、「GitHub は既定のブランチ(`main`)にない workflow を `workflow_dispatch` で起動しないので、`workflow_dispatch` だけでは切り替えまで一度も走らせられない」ことだった。「段階 6 でこの workflow を走らせる手順」の 1 も、`rust` の上での dispatch は「GitHub が起動を断る見込みである」と書いた。

この見込みは外れた。#111 の作業が `rust` に入ったあと(`rust` の `97e1e24`)で `gh workflow run rust-cross.yml --ref rust` を実行すると、GitHub は run を作った。

- run: <https://github.com/atriumnook/herdr-fleet/actions/runs/42410444613>
- event `workflow_dispatch`、branch `rust`、head `97e1e24c5fd70dcf5d8ea1d43c7ef73e2192d9d0`、作った時刻 2026-11-07T20:18:49Z
- 結果: success。`gate` は 4 秒で success になった(`workflow_dispatch` では常にビルドする)。`build (macos-15)` は 4 分 51 秒、`build (windows-2025)` は 6 分 32 秒で、どちらも success。時間は `gh run view 42410444613 --json jobs` が返すジョブの `startedAt` から `completedAt` まで

このとき、この workflow はすでに GitHub に登録されていた。`gh api repos/atriumnook/herdr-fleet/actions/workflows` は、`.github/workflows/rust-cross.yml` を id `410597677`、状態 `active`、`created_at` 2026-11-08T04:16:30+09:00(2026-11-07T19:16:30Z)で返す。この時刻は、#111 の作業の PR の最初の `pull_request` の run(42405398892)を作った時刻と同じである。登録の前に dispatch できたかは確かめていない。

計画の段階 6 は、macOS と Windows の workflow を「手動(`workflow_dispatch`)で、段階の関門と切り替えの前だけに走らせる」と決めている。段階 0 の関門の報告(`docs/rust-migration/gates/phase-0.md` の「#111 の rust-cross.yml の trigger」)は、`pull_request` の trigger を置いた理由がこの run で成り立たなくなったとして、この Issue で `pull_request` の trigger と `gate` ジョブを外すことを勧めた。あわせて、外したあとも dispatch できるかは確かめていないので、外す PR のマージのあとで `gh workflow run rust-cross.yml --ref rust` を実行して確かめ、起動できなければ `pull_request` の trigger と `gate` を戻すよう求めた(Issue #120 の atriumnook のコメント)。

ADR の README は、前の決定を変えるときは新しい ADR を書き、前の ADR は書き換えないと決めている。この ADR は事実の訂正(手順 1 の見込み)と、決定の変更(trigger と `gate`)の両方を含むので、`0111-cross-build` を直さず、新しい ADR にした。

## 決定

- `.github/workflows/rust-cross.yml` の trigger は `workflow_dispatch` だけにする。`pull_request` の trigger と `gate` ジョブを外し、ビルドのジョブから `needs: gate` と `if: needs.gate.outputs.build == 'true'` を外す
- 置き換えるのは、`0111-cross-build` の次の部分である
  - 「決定」の trigger の 2 項目と、`gate` ジョブとその下の項目(`cancel-in-progress` を置かないことを含む)
  - 「検討した代わり」の「`workflow_dispatch` だけにする」と「`gate` を置かず、`paths` だけにする」と「ビルドのジョブにだけ `concurrency` と `cancel-in-progress` を置く」
  - 「結果」のうち、`rust/rust-toolchain.toml` の版を上げる PR でこのファイルも変えてビルドを走らせる、という手順
  - 「段階 6 でこの workflow を走らせる手順」の全体(下の手順に替える)
- ほかの決定は `0111-cross-build` のまま変えない: matrix の `macos-15` と `windows-2025`、`cargo build --release --locked`、版の付いた runner のラベル、`rust/rust-toolchain.toml` の版の Rust、`permissions: contents: read`、SHA で固定した `actions/checkout` と `persist-credentials: false`、Metal のツールチェインと `fxc.exe` の手順、`target/` を cache しないこと
- Issue #111 の受け入れ条件の 1 は、trigger を「`workflow_dispatch` と、base が `rust` の `pull_request` のうち `paths` が `.github/workflows/rust-cross.yml` 自身のものだけ」と決めていた。その理由は、同じ Issue の「注意」にある「`workflow_dispatch` だけでは、この workflow を一度も走らせられない」である。この理由は run 42410444613 で成り立たなくなったので、この ADR がその条件を置き換える。#111 はすでに閉じている。この ADR が変えるのはこれからの trigger で、#111 の作業が `rust` に入った時点で #111 の条件を満たしていたことは変わらない。受け入れ条件の 4(`rust` へのマージのあとで dispatch を試し、起動できなければこのファイルを変える PR で走らせる)は、dispatch を試して起動できたので、PR で走らせる側を使わずに終わった

### 段階 6 でこの workflow を走らせる手順

1. 段階の関門か切り替えの前に、`gh workflow run rust-cross.yml --ref rust` を実行する。リポジトリが非公開の間は、その前に計画の段階 6 のとおり Actions の無料枠の残りを確かめ、足りなければ走らせずに `blocked` の Issue にする
2. `gh run list --workflow rust-cross.yml --limit 1` で run を見つけ、`gh run watch <run>` で終わりを待つ
3. run の URL、ジョブごとの時間、runner のイメージ(ジョブのログの `Runner image` の行)を、その段階の ADR か PR に書く
4. GitHub が起動を断ったとき(`gh workflow run` が HTTP のエラーを出して、0 でない終了コードで終わる)は、エラーの文を Issue に書き、`0111-cross-build` の `pull_request` の trigger と `gate` ジョブを戻す PR を `rust` に出す。戻す PR はこのファイルを変えるので、`pull_request` の run はその PR の merge commit の workflow(戻した trigger を持つ)で起動し、マージの前にその PR の上でビルドが走る(#111 の作業の PR の最初の run 42405398892 も、`rust` にこの workflow がない状態で同じように起動した)。戻したあとは、`0111-cross-build` の手順 2 のとおり、このファイルを変える PR で走らせる
5. 切り替えで `main` に入ったあとも、手順 1 と同じ `gh workflow run` で走らせる(`--ref` は、そのとき走らせるブランチ)

## 検討した代わり

- **`0111-cross-build` のまま、`pull_request` の trigger と `gate` を残す**: このファイルを変える PR を開いたときにビルドが走るので、workflow の変更をマージの前に macOS と Windows で確かめられる。ただし、置いた理由(dispatch できない)はなくなった。残すと、計画の段階 6 の「手動(`workflow_dispatch`)で」と食い違い、計画だけを読んだ人が理由を探す必要が残る(#119 はそのために計画へ参照を足す Issue だった)。`gate` ジョブは workflow の 38 行(`gate:` の行から `$GITHUB_OUTPUT` に書く行まで。うち `run:` の shell が 18 行)を占め、比べられない push(push の前の head が clone にないとき、`git diff` が終了コード 2 以上で失敗したとき)では余分にビルドする。skipped になったビルドのジョブは、PR の検査の一覧に `build (${{ matrix.os }})` という展開されない名前で出る。この workflow の変更をマージの前に確かめられることより、trigger が計画と一致し、`gate` の 38 行と展開されない名前の検査がなくなることを選んだ
- **`pull_request` の trigger を残し、`gate` だけを外す(`paths` だけにする)**: GitHub は `pull_request` の `paths` を PR 全体の差分で判定するので、このファイルを一度変えた PR では、ほかのファイルだけを変える push のたびに macOS と Windows のビルドが走る(`0111-cross-build` の 2 回目の run)。Issue #111 の「thread のブランチへの push だけで走る trigger は置かない」に反するので選ばなかった
- **マージの前に、thread のブランチで dispatch して確かめる(`gh workflow run rust-cross.yml --ref <thread のブランチ>`)**: `pull_request` の trigger を外した版が dispatch できるかを、マージの前に確かめられる。ただし、決まり(`.herdr-fleet/standing.md`)が事前に認めた workflow の起動は `rust` のブランチの上だけである。選ばず、マージのあとに `rust` の上で確かめる

## 依存

なし。`actions/checkout` は `0111-cross-build` と同じもの(v7.0.1、コミット `3d3c42e5aac5ba805825da76410c181273ba90b1`)を、ビルドのジョブだけが使う。

## 結果

- この workflow が走るのは、誰かが `gh workflow run`(または GitHub の画面の Run workflow)で起動したときだけになる。PR と push では走らない。`.github/workflows/rust-cross.yml` を変える PR でも走らないので、PR の検査の一覧に `rust-cross` のジョブは出ない
- この workflow や、ビルドに関わるもの(`rust/rust-toolchain.toml`、`rust/prototypes/gpui-window/` の依存)を変えた PR は、マージの前に macOS と Windows でビルドを確かめられない。計画の段階 6 は、走らせるのを段階の関門と切り替えの前に限っているので、こうした変更でビルドが通らなくなったことは、次の関門の run で見つかる。`0111-cross-build` の「結果」にある、Rust 1.99.1 で gpui の間接の依存に出る future-incompat の警告は、版を上げたときに止まりうる候補として残る。段階 6 の作業で、関門の前のほかにも走らせる必要が出たら、計画を直す Issue を出す
- 外したあとも dispatch できるかは、この ADR を書いた時点では確かめていない。この ADR を入れる PR のマージのあとで、`gh workflow run rust-cross.yml --ref rust` を 1 回実行して確かめ、run の URL と結果を Issue #120 のコメントに書く。起動できなければ、上の手順 4 のとおり戻す
- 計画の段階 6 への参照は #119 で扱う。この ADR のあとは、計画の「手動(`workflow_dispatch`)で」と workflow の trigger が一致する

## 確かめたこと

- run 42410444613: `gh run view 42410444613 --json event,headBranch,headSha,conclusion,createdAt,jobs` が、event `workflow_dispatch`、headBranch `rust`、headSha `97e1e24c5fd70dcf5d8ea1d43c7ef73e2192d9d0`、conclusion `success` と、上の「状況」のジョブの時刻を返した(2026-11-08 に実行)
- 登録: `gh api repos/atriumnook/herdr-fleet/actions/workflows` が、上の「状況」の id、状態、`created_at` を返した。`gh run list --workflow rust-cross.yml` の最も古い run は 42405398892(`pull_request`、2026-11-07T19:16:30Z)で、`rust-cross` の `workflow_dispatch` の run は 42410444613 の 1 つだけだった
- 変えた workflow: `yq '.on, (.jobs|keys)' .github/workflows/rust-cross.yml` が、`on` は `workflow_dispatch` だけ、ジョブは `build` だけを返した。ビルドのジョブの手順は、`needs` と `if` の 2 行を除いて変えていない(`git diff`)。actionlint はこの PC に入っていないので走らせていない
- この ADR を入れる PR(base `rust`、このファイルを変える)では、`gh pr checks` に workflow `rust` の `linux` だけが出て、`rust-cross` の run はできなかった。`pull_request` の run は PR の merge commit の workflow を使い、その workflow に `pull_request` の trigger がないためである
