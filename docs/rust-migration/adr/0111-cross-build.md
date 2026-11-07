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
- ジョブは matrix で `macos-15` と `windows-2025` の 2 つ。どちらも `rust/prototypes/gpui-window` で `cargo build --release --locked` を実行する。`--locked` で、試作の `Cargo.lock`(`libc` 0.2.189 の固定を含む。`0108-gpui-prototype`)のとおりの版を使う
- runner のラベルは `macos-latest` と `windows-latest` ではなく、版の付いたラベルにする。`-latest` が指すイメージは GitHub が切り替えるので、同じ workflow でも Xcode や Windows SDK の版が変わりうるためである
- Rust は 1.94.0。`rustup toolchain install` で入れる(`0108-gpui-prototype` と同じ版。gpui 0.2.2 は `rust-version` を宣言していない)。`rust/rust-toolchain.toml`(#110)ができたら、そちらに合わせる
- `permissions` は `contents: read`。action は `actions/checkout` だけを使い、コミットの SHA(v7.0.1 の `3d3c42e5aac5ba805825da76410c181273ba90b1`)で固定する。`persist-credentials: false` で、checkout のトークンを作業フォルダーに残さない
- gpui の `build.rs` が要る道具を、ジョブの中で確かめる
  - macOS: Metal のシェーダーを `xcrun -sdk macosx metal` でコンパイルする。Apple の Xcode 26 の release notes によると、Xcode 26 からは Metal のツールチェインを Xcode と別にダウンロードする。そのため、`xcrun -sdk macosx metal --version` が失敗したときだけ `xcodebuild -downloadComponent MetalToolchain` で入れる
  - Windows: release のビルドで HLSL のシェーダーを `fxc.exe` でコンパイルする。gpui は `PATH` と、決まった版(10.0.26100.0)の Windows SDK のフォルダーだけを探す。イメージにある最も新しい x64 の `fxc.exe` を探し、`GPUI_FXC_PATH` で渡す
- `target/` は cache しない。GitHub は 7 日間使われなかった cache を消す。走らせるのは段階の関門と切り替えの前だけで、run の間はふつう 7 日より空くので、cache はほとんど当たらない

## 検討した代わり

- **`workflow_dispatch` だけにする**: 計画の段階 6 のとおりだが、上の制約により、切り替えまで一度も走らせられない。段階 0 の確認ができないので選ばなかった
- **thread のブランチへの push で走らせる**: push のたびに macOS と Windows のビルドが走る。計画が手動に限った趣旨に合わないので選ばなかった
- **すべての PR で走らせる**: 同じ理由で選ばなかった
- **`dtolnay/rust-toolchain` などの第三者の action で Rust を入れる**: runner のイメージには rustup が入っているので要らない。第三者の action を増やすと、固定と更新の確認が増える
- **macOS の x86_64(Intel)でもビルドする**: `macos-15` は arm64 である。段階 0 が確かめるのは「macOS 向けにビルドできるか」で、Intel の Mac を対象にするかは段階 6 で決める

## 依存

- `actions/checkout` v7.0.1(コミット `3d3c42e5aac5ba805825da76410c181273ba90b1`)。入手元 <https://github.com/actions/checkout>、MIT、GitHub が保守している
- crate の追加はない。試作の依存は `0108-gpui-prototype` のとおり

## 結果

- 空の GPUI アプリ(`gpui` 0.2.2、`libc` 0.2.189)は、コードと `Cargo.toml` を変えずに、macOS(arm64)と Windows(x64)向けに release でビルドできる(下の「確かめたこと」)。段階 6 は、この試作と同じ依存から始められる
- ビルドに要ったものは、どちらの runner のイメージにも入っていた。macOS は Xcode 16.4 の Metal のコンパイラ、Windows は Windows SDK 10.0.26100.0 の `fxc.exe` を使った。workflow が追加で入れたものは Rust 1.94.0(`rustup toolchain install`)だけで、Metal のツールチェインのダウンロードは走らなかった
- 確かめたのはビルドが通ることだけである。macOS と Windows で窓が開くか、文字が描かれるかは確かめていない。署名、notarization、インストーラーも作っていない。いずれも段階 6 の作業である
- イメージの Xcode が 26 以上に替わると、Metal のツールチェインのダウンロード(`xcodebuild -downloadComponent MetalToolchain`)が走る。この分岐は今回の run では通っていない。走って失敗したら、ログを読んで直す

### 段階 6 でこの workflow を走らせる手順

1. `rust` へのマージのあとで、`gh workflow run rust-cross.yml --ref rust` を試す。既定のブランチ(`main`)にこの workflow がない間は、GitHub が起動を断る見込みである
2. 起動できなければ、`.github/workflows/rust-cross.yml` を変える PR を `rust` に向けて出す。ファイルを変えるコミットが PR に入るたびに走る。走らせ直すときも、このファイルを変えるコミットを PR に足す
   - 変える中身がないときは、ファイルの冒頭のコメントに走らせる理由(段階の名前など)を書き足す
3. run の URL、ジョブごとの時間、runner のイメージを、その段階の ADR か PR に書く
4. 切り替えで `main` に入ったあとは、`workflow_dispatch`(手順 1)で走らせる。`pull_request` の trigger を残すかは、そのときに決める

## 確かめたこと

この Issue の PR で workflow を 1 回走らせ、macOS と Windows の両方のジョブが緑になった。失敗して走らせ直した回数は 0 回である。

- run: <https://github.com/atriumnook/herdr-fleet/actions/runs/42405398892>(trigger は `pull_request`。workflow を足したコミット `444b842` の上で走った)
- 日時: 2026-11-07 19:16 から 19:22(UTC)

| ジョブ | runner のイメージ | OS | ジョブの時間 | `cargo build --release` の時間 | 実行ファイル |
|---|---|---|---|---|---|
| [build (macos-15)](https://github.com/atriumnook/herdr-fleet/actions/runs/42405398892/job/128501888675) | `macos-15-arm64` 20261104.0514.1 | macOS 15.8.2(arm64) | 4 分 10 秒 | 3 分 51 秒 | `gpui-window` 5,264,080 バイト |
| [build (windows-2025)](https://github.com/atriumnook/herdr-fleet/actions/runs/42405398892/job/128501888545) | `windows-2025-vs2026` 20261103.298.1 | Windows Server 2025 10.0.26100(x64) | 5 分 39 秒 | 5 分 17 秒 | `gpui-window.exe` 10,778,112 バイト |

- ジョブの時間は、`gh run view 42405398892 --json jobs` が返すジョブの `startedAt` から `completedAt` まで。`cargo build --release` の時間は、cargo が出した `Finished` の行の値
- ラベル `windows-2025` は、イメージ `windows-2025-vs2026`(Visual Studio 2026 入り)で走った。ラベルの名前とイメージの名前が違うので、段階 6 で読み違えないように書いておく
- イメージに入っているものの一覧: [macos-15-arm64 20261104.0514](https://github.com/actions/runner-images/blob/macos-15-arm64/20261104.0514/images/macos/macos-15-arm64-Readme.md)、[win25-vs2026 20261103.298](https://github.com/actions/runner-images/blob/win25-vs2026/20261103.298/images/windows/Windows2025-VS2026-Readme.md)
- Rust: どちらも rustc 1.94.0(4a4ef493e 2026-03-02)。host は `aarch64-apple-darwin` と `x86_64-pc-windows-msvc`
- macOS: `xcodebuild -version` は Xcode 16.4(Build version 16F6)、`xcrun -sdk macosx metal --version` は Apple metal version 32023.620。Metal のツールチェインはイメージにあったので、ダウンロードの分岐は走らなかった
- Windows: `fxc.exe` は `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\fxc.exe`。gpui の `build.rs` が決め打ちで探すフォルダーと同じ版だった
- コンパイルした crate の数(ログの `Compiling` の行。試作を含む): macOS 455、Windows 440。cargo と rustc の警告は 0 件(ログで `warning` を含む行は、checkout が出した git の hint の 1 行だけだった)
- 手元(Linux)では、`rust/prototypes/gpui-window` で `cargo metadata --locked --format-version 1` が通ることを、push の前に確かめた(`Cargo.lock` が macOS と Windows の依存も含んでいて、`--locked` で止まらないことの確認)
