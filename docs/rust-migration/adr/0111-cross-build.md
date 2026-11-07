# macOS と Windows 向けのビルドを、手動の workflow `rust-cross` で確かめる

- 状態: 採用
- 決めた日: 2026-11-08
- Issue: #111

## 状況

計画の段階 0 は、空の GPUI アプリが macOS と Windows 向けにビルドできることを、手動の workflow を 1 回走らせて確かめることを求めている(`docs/rust-migration/plan.md` の「段階 0: 土台と試作」)。段階 6 は、macOS と Windows の workflow を手動(`workflow_dispatch`)で、段階の関門と切り替えの前だけに走らせると決めている。

ビルドする対象は #108 の試作 `rust/prototypes/gpui-window/` である。`0108-gpui-prototype` は GPUI(crates.io の `gpui` 0.2.2)を採用し、代わりのアプリを選んでいない。そのため、代わりのアプリで同じことを確かめる必要はない。

制約は次の 2 つ。

- GitHub は、既定のブランチにない workflow を `workflow_dispatch` で起動しない(<https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow>)。このリポジトリの既定のブランチは `main` で、この作業は `main` に触れられない。`workflow_dispatch` だけの workflow は、切り替えで `main` に入るまで一度も走らせられない
- 計画が macOS と Windows を手動に限ったのは、Actions の無料枠のためである(段階 6 の「リポジトリが非公開の間は」)。このリポジトリは公開なので、GitHub の標準の runner は無料で使える

## 決定

`.github/workflows/rust-cross.yml` を置く。

- trigger は次の 2 つだけにする
  - `workflow_dispatch`
  - base が `rust` の `pull_request` のうち、変更したファイル(`paths`)に `.github/workflows/rust-cross.yml` 自身を含むもの
- push と、このファイルを変えないほかの PR では走らない。`pull_request` の trigger は、`workflow_dispatch` を起動できない間に段階 6 の「手動で走らせる」を満たす手段とみなす。走らせたい人が、このファイルを変える PR を出したときだけ走るためである
- ビルドの前に `gate` ジョブ(`ubuntu-24.04`)を置き、PR への push(`synchronize`)では、push の前の head と後の head のあいだでこのファイルが変わったときだけ、ビルドのジョブを走らせる。GitHub は `pull_request` の `paths` を、push したコミットではなく PR 全体の差分(base との three-dot diff)で判定する(<https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#git-diff-comparisons>)。そのため `paths` だけでは、このファイルを変えた PR に ADR だけのコミットを push しても、macOS と Windows のビルドが走る(この PR の 2 回目の run で起きた。下の「確かめたこと」)
  - `gate` は、リポジトリを履歴ごと checkout し(`fetch-depth: 0`。`filter: blob:none` で、ファイルの中身は取らずにコミットとツリーだけを取る)、`git diff --quiet --no-renames <before> <after> -- .github/workflows/rust-cross.yml` の終了コードで決める。差がなければビルドのジョブを skipped にする。PR を開いたとき(`opened`、`reopened`)と `workflow_dispatch` では、常にビルドする
  - push の前の head が clone にないとき(force push のあとなど)は、比べられないので、警告を出してビルドする。黙ってビルドを飛ばすより、余分に 1 回ビルドするほうを選んだ
  - 変わったファイルの一覧は作らず、ログにも出さない。ログに出すのは決まった文と `build=true` か `build=false` だけにする。最初に書いた `gate` は compare の API(`gh api repos/<repo>/compare/<before>...<after>`)でファイル名の一覧を作っていたが、レビューで次の 3 つの欠陥が見つかり、git の差分に替えた。API が返すファイルは比較全体で 300 件までなので、301 件以上を変えた push でこのファイルが漏れると、ビルドを飛ばす。`gh api --paginate` で 2 ページ目に進むと、`.files` がなく jq が失敗する。ファイル名には改行を入れられるので、名前をそのままログに出すと、細工した名前で workflow command(`::add-mask::` など)を実行させたり、別のファイルをこのファイルと見誤らせたりできる
  - `concurrency` の `cancel-in-progress` は置かない。置くと、ビルドの途中で ADR だけのコミットを push したとき、`gate` だけの新しい run がビルド中の run を取り消すためである
- ジョブは matrix で `macos-15` と `windows-2025` の 2 つ。どちらも `rust/prototypes/gpui-window` で `cargo build --release --locked` を実行する。`--locked` で、試作の `Cargo.lock`(`libc` 0.2.189 の固定を含む。`0108-gpui-prototype`)のとおりの版を使う
- runner のラベルは `macos-latest` と `windows-latest` ではなく、版の付いたラベルにする。`-latest` が指すイメージは GitHub が切り替えるので、同じ workflow でも Xcode や Windows SDK の版が変わりうるためである
- Rust は `rust/rust-toolchain.toml`(`0110-workspace-and-ci`。作業の時点で 1.99.1)の版を使う。試作のフォルダーから上にあるこのファイルを rustup が見つけるので、workflow は `rustup toolchain install --no-self-update` を実行するだけで、版を書かない(Linux の workflow `rust.yml` と同じ)。試作は `rust/` の workspace の外にあるが、このファイルの版から外れる理由はない。gpui 0.2.2 は `rust-version` を宣言しておらず、1.99.1 でも macOS と Windows のビルドが通った(下の「確かめたこと」)。最初の版の workflow は `0108-gpui-prototype` と同じ 1.94.0 を指定していたが、`rust-toolchain.toml` が `rust` に入ると、rustup はそちらを優先した(4 回目の run)
- `permissions` は `contents: read`。action は `actions/checkout` だけを使い、コミットの SHA(v7.0.1 の `3d3c42e5aac5ba805825da76410c181273ba90b1`)で固定する。`persist-credentials: false` で、checkout のトークンを作業フォルダーに残さない
- gpui の `build.rs` が要る道具を、ジョブの中で確かめる
  - macOS: Metal のシェーダーを `xcrun -sdk macosx metal` でコンパイルする。Apple の Xcode 26 の release notes によると、Xcode 26 からは Metal のツールチェインを Xcode と別にダウンロードする。そのため、`xcrun -sdk macosx metal --version` が失敗したときだけ `xcodebuild -downloadComponent MetalToolchain` で入れる
  - Windows: release のビルドで HLSL のシェーダーを `fxc.exe` でコンパイルする。gpui は `PATH` と、決まった版(10.0.26100.0)の Windows SDK のフォルダーだけを探す。workflow は、10.0.26100.0 の x64 の `fxc.exe` があればそれを、なければイメージにある最も新しい版の x64 の `fxc.exe` を、`GPUI_FXC_PATH` で渡す。1 つもなければ、そのことをエラーに書いてジョブを止める
- `target/` は cache しない。GitHub は 7 日間使われなかった cache を消す。走らせるのは段階の関門と切り替えの前だけで、run の間はふつう 7 日より空くので、cache はほとんど当たらない

## 検討した代わり

- **`workflow_dispatch` だけにする**: 計画の段階 6 のとおりだが、上の制約により、切り替えまで一度も走らせられない。段階 0 の確認ができないので選ばなかった
- **thread のブランチへの push で走らせる**: push のたびに macOS と Windows のビルドが走る。計画が手動に限った趣旨に合わないので選ばなかった
- **すべての PR で走らせる**: 同じ理由で選ばなかった
- **`gate` を置かず、`paths` だけにする**: この PR の 2 回目の run のように、このファイルを一度変えた PR では、ADR だけを直す push のたびに macOS と Windows のビルドが走る。Issue #111 の「thread のブランチへの push だけで走る trigger は置かない」に反するので選ばなかった
- **ビルドのジョブにだけ `concurrency` と `cancel-in-progress` を置く**: このファイルを変える push が短い間に続いたとき、古いビルドを取り消せる。ただし、`if` で skipped になるジョブが concurrency の group にどう関わるかを確かめていない。この workflow を走らせるのは段階の関門と切り替えの前だけで、公開リポジトリの標準の runner は無料なので、ビルドが 2 回重なっても困らない。確かめていない設定を足すより、置かないほうを選んだ
- **`dtolnay/rust-toolchain` などの第三者の action で Rust を入れる**: runner のイメージには rustup が入っているので要らない。第三者の action を増やすと、固定と更新の確認が増える
- **macOS のジョブで Xcode を 16.4 に固定する(`xcode-select`)**: 確かめた Xcode でビルドし続けられるが、イメージから Xcode 16.4 が消えるとジョブが止まる。Xcode 26 以降に替わったときに Metal のツールチェインを入れる分岐のほうが、イメージが替わっても続けて使えるので、固定しなかった。この分岐はまだ走っていない(「結果」)
- **macOS の x86_64(Intel)でもビルドする**: `macos-15` は arm64 である。段階 0 が確かめるのは「macOS 向けにビルドできるか」で、Intel の Mac を対象にするかは段階 6 で決める

## 依存

- `actions/checkout` v7.0.1(コミット `3d3c42e5aac5ba805825da76410c181273ba90b1`)。入手元 <https://github.com/actions/checkout>、MIT、GitHub が保守している
- crate の追加はない。試作の依存は `0108-gpui-prototype` のとおり

## 結果

- 空の GPUI アプリ(`gpui` 0.2.2、`libc` 0.2.189)は、コードと `Cargo.toml` を変えずに、macOS(arm64)と Windows(x64)向けに release でビルドできる(下の「確かめたこと」)。段階 6 は、この試作と同じ依存から始められる
- ビルドに要ったものは、どちらの runner のイメージにも入っていた。macOS は Xcode 16.4 の Metal のコンパイラ、Windows は Windows SDK 10.0.26100.0 の `fxc.exe` を使った。workflow が追加で入れたものは Rust(`rustup toolchain install`)だけで、Metal のツールチェインのダウンロードは走らなかった
- 確かめたのはビルドが通ることだけである。macOS と Windows で窓が開くか、文字が描かれるかは確かめていない。署名、notarization、インストーラーも作っていない。いずれも段階 6 の作業である
- イメージの Xcode が 26 以上に替わると、Metal のツールチェインのダウンロード(`xcodebuild -downloadComponent MetalToolchain`)が走る。この分岐は今回の run では通っていない。走って失敗したら、ログを読んで直す

### 段階 6 でこの workflow を走らせる手順

1. `rust` へのマージのあとで、`gh workflow run rust-cross.yml --ref rust` を試す。既定のブランチ(`main`)にこの workflow がない間は、GitHub が起動を断る見込みである
2. 起動できなければ、`.github/workflows/rust-cross.yml` を変える PR を `rust` に向けて出す。PR を開いたときと、このファイルを変えるコミットを push したときにビルドが走る。走らせ直すときも、このファイルを変えるコミットを PR に足す。ほかのファイルだけを変えるコミットの push では、`gate` のジョブだけが走り、ビルドのジョブは skipped になる
   - 変える中身がないときは、ファイルの冒頭のコメントに走らせる理由(段階の名前など)を書き足す
3. run の URL、ジョブごとの時間、runner のイメージを、その段階の ADR か PR に書く
4. 切り替えで `main` に入ったあとは、`workflow_dispatch`(手順 1)で走らせる。`pull_request` の trigger を残すかは、そのときに決める

## 確かめたこと

この Issue の PR で、macOS と Windows のビルドのジョブが走った run は 5 回(うち 1 回は途中で取り消した)である。ビルドが失敗して走らせ直した回数は 0 回である。2 回目は ADR を足した push で意図せず起きた run で、3 回目から 5 回目は workflow の誤りを直したコミットの push で起きた(下の表)。どれもビルドの失敗のための走らせ直しではない。ビルドのジョブが skipped になる `gate` だけの run は、この回数に数えない(下の「gate だけの run」)。

| 回 | run | head のコミット | 起動した理由 | 結果 |
|---|---|---|---|---|
| 1 | [42405398892](https://github.com/atriumnook/herdr-fleet/actions/runs/42405398892) | `444b842`(workflow を足した) | PR を開いた(`opened`) | macOS と Windows とも緑(Rust 1.94.0) |
| 2 | [42406033125](https://github.com/atriumnook/herdr-fleet/actions/runs/42406033125) | `3dd0cad`(ADR と `rust` の取り込み) | `synchronize`。`paths` が PR 全体の差分で判定され、workflow を変えていない push でも起動した | 意図しない run なので、ビルドの途中で取り消した(cancelled) |
| 3 | [42406377574](https://github.com/atriumnook/herdr-fleet/actions/runs/42406377574) | `4b6c502`(compare の API で決める `gate` を足した) | `synchronize`。workflow を変えた | `gate` が `build=true`。macOS と Windows とも緑(Rust 1.94.0) |
| 4 | [42407569977](https://github.com/atriumnook/herdr-fleet/actions/runs/42407569977) | `026ce40`(`gate` を git の差分で決めるように替えた) | `synchronize`。workflow を変えた | `gate` が `build=true`。macOS と Windows とも緑。PR の merge ref に `rust/rust-toolchain.toml` が入っていたので、rustup は workflow が指定した 1.94.0 ではなく 1.99.1 でビルドした |
| 5 | [42408357230](https://github.com/atriumnook/herdr-fleet/actions/runs/42408357230) | `6b2cd04`(版の指定を外し、`rust-toolchain.toml` に従わせた) | `synchronize`。workflow を変えた | `gate` が `build=true`。macOS と Windows とも緑(Rust 1.99.1) |

### 5 回目の run(マージする workflow と同じ内容)

| ジョブ | runner のイメージ | OS | ジョブの時間 | `cargo build --release` の時間 | 実行ファイル |
|---|---|---|---|---|---|
| [gate](https://github.com/atriumnook/herdr-fleet/actions/runs/42408357230/job/128510870589) | `ubuntu-24.04`(ubuntu24 20261101.360) | Ubuntu 24.04 | 6 秒 | | |
| [build (macos-15)](https://github.com/atriumnook/herdr-fleet/actions/runs/42408357230/job/128510904131) | `macos-15-arm64` 20261104.0514.1 | macOS 15.8.2(arm64) | 4 分 26 秒 | 4 分 9 秒 | `gpui-window` 5,651,136 バイト |
| [build (windows-2025)](https://github.com/atriumnook/herdr-fleet/actions/runs/42408357230/job/128510904053) | `windows-2025-vs2026` 20261103.298.1 | Windows Server 2025 10.0.26100(x64) | 6 分 34 秒 | 6 分 9 秒 | `gpui-window.exe` 10,850,304 バイト |

ほかの run の時間(ジョブ / `cargo build --release`)は次のとおり。1 回目と 3 回目は Rust 1.94.0、4 回目は 1.99.1 である。

| 回 | macOS | Windows |
|---|---|---|
| 1 | 4 分 10 秒 / 3 分 51 秒 | 5 分 39 秒 / 5 分 17 秒 |
| 3 | 6 分 19 秒 / 5 分 54 秒 | 6 分 30 秒 / 6 分 6 秒 |
| 4 | 5 分 43 秒 / 5 分 12 秒 | 8 分 34 秒 / 7 分 58 秒 |

- ジョブの時間は、`gh run view <run> --json jobs` が返すジョブの `startedAt` から `completedAt` まで。`cargo build --release` の時間は、cargo が出した `Finished` の行の値。同じコードでも run ごとに 1 分から 2 分ほど違った
- ラベル `windows-2025` は、イメージ `windows-2025-vs2026`(Visual Studio 2026 入り)で走った。ラベルの名前とイメージの名前が違うので、段階 6 で読み違えないように書いておく
- イメージに入っているものの一覧: [macos-15-arm64 20261104.0514](https://github.com/actions/runner-images/blob/macos-15-arm64/20261104.0514/images/macos/macos-15-arm64-Readme.md)、[win25-vs2026 20261103.298](https://github.com/actions/runner-images/blob/win25-vs2026/20261103.298/images/windows/Windows2025-VS2026-Readme.md)。5 回とも同じ版のイメージだった
- Rust: 5 回目は、どちらも rustc 1.99.1(58cf8f9c3 2026-10-13)。host は `aarch64-apple-darwin` と `x86_64-pc-windows-msvc`。1 回目と 3 回目は rustc 1.94.0(4a4ef493e 2026-03-02)
- macOS: `xcodebuild -version` は Xcode 16.4(Build version 16F6)、`xcrun -sdk macosx metal --version` は Apple metal version 32023.620。Metal のツールチェインはイメージにあったので、ダウンロードの分岐は走らなかった
- Windows: `fxc.exe` は `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\fxc.exe`。gpui の `build.rs` が決め打ちで探すフォルダーと同じで、workflow もこのフォルダーを先に使う。最も新しい版を探す分岐と、1 つもないときにエラーで止める分岐は走っていない
- コンパイルした crate の数(ログの `Compiling` の行。試作を含む): macOS 455、Windows 440。5 回とも同じだった
- 警告: Rust 1.94.0 の run(1 回目と 3 回目)では、cargo と rustc の警告は 0 件だった。Rust 1.99.1 の run(4 回目と 5 回目)では、cargo が future-incompat の警告を 1 件出した: `the following packages contain code that will be rejected by a future version of Rust`。対象は macOS で `block` 0.1.6 と `proc-macro-error2` 2.0.1、Windows で `proc-macro-error2` 2.0.1。どちらも gpui の間接の依存である。今の版ではビルドは止まらないが、Rust を上げるときに止まりうる。段階 5 で gpui を workspace に入れるときに、`cargo report future-incompatibilities` で中身を読む
- 実行ファイルの大きさは、Rust 1.94.0 と 1.99.1 で違った(macOS 5,264,080 と 5,651,136 バイト、Windows 10,778,112 と 10,850,304 バイト)。4 回目と 5 回目は同じだった
- `gate` の判定(git の差分の版): 4 回目と 5 回目の run の `gate` は `The push changes .github/workflows/rust-cross.yml.` と `build=true` を出した。push の前に、`--filter=blob:none` で clone したこのリポジトリで同じスクリプトを実行し、`3dd0cad..4b6c502` と `105c10f..444b842`(workflow を変えた push)が `build=true`、`4b6c502..254ebb7` と `444b842..3dd0cad`(変えていない push)が `build=false`、clone にない `before`(`0000…`)が警告と `build=true`、`ACTION=opened` が `build=true` になることを確かめた
- 手元(Linux)では、`rust/prototypes/gpui-window` で `cargo metadata --locked --format-version 1` が通ることを、push の前に確かめた(`Cargo.lock` が macOS と Windows の依存も含んでいて、`--locked` で止まらないことの確認)

### gate だけの run

ADR だけを変えたコミットの push で、`gate` だけが走り、ビルドのジョブが skipped になった run は次のとおり。

- [42407013882](https://github.com/atriumnook/herdr-fleet/actions/runs/42407013882)(`254ebb7`)と [42407116033](https://github.com/atriumnook/herdr-fleet/actions/runs/42407116033)(`dacc1b5`): compare の API の版の `gate` で `build=false`。`gate` のジョブは 4 秒ほどで終わった
- [42408980474](https://github.com/atriumnook/herdr-fleet/actions/runs/42408980474)(`cb04253`): git の差分の版の `gate` が `The push leaves .github/workflows/rust-cross.yml unchanged.` と `build=false` を出した。`gate` のジョブは 6 秒で終わった。このあとの ADR だけのコミットの push でも、同じように `gate` だけが走る

skipped になったビルドのジョブは、PR の検査の一覧に `build (${{ matrix.os }})` という名前で出る。matrix を展開する前に skipped になるので、名前の式が展開されないためである。`gh pr checks 116` はこのジョブを `skipping` と表示し(`build (${{ matrix.os }})	skipping	0	…`)、失敗として扱わなかった。この名前のジョブは、ruleset の必須の検査(required status checks)にしない。必須にすると、ADR だけを変える PR では名前が展開されたジョブが報告されず、マージできなくなりうる
