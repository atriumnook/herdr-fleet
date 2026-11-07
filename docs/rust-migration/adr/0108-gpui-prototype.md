# デスクトップの画面に GPUI 0.2.2(crates.io)を使う

- 状態: 採用
- 決めた日: 2026-11-08
- Issue: #108

## 状況

段階 5 のデスクトップの画面は GPUI で作る計画である(`docs/rust-migration/plan.md` の「段階 0: 土台と試作」)。その前に、使う人の PC(Linux、Wayland、Hyprland)で、GPUI が Wayland のネイティブの窓を開き、英語と日本語の文字を描けるかを確かめる必要があった。描けなければ代わりを決める。

試作は `rust/prototypes/gpui-window/` に置いた。`Cargo.toml` に空の `[workspace]` を書き、`rust/` の workspace には入れていない。

この ADR が扱うのは Linux(この PC)だけである。macOS と Windows 向けに GPUI のアプリがビルドできるかは #111 が確かめる。

## 決定

- GPUI は crates.io の `gpui = "=0.2.2"` を使う。試作では、Wayland のネイティブの窓(`"xwayland": false`)が開き、`herdr-fleet` と `承認待ち` が描かれた(下の「確かめたこと」)
- `libc` を 0.2.189 以下に抑える。gpui 0.2.2 の依存 `xattr` 0.2.3(`gpui_http_client` → `zed-async-tar` 経由)は、Linux で `libc::ENOATTR` を参照する。`libc` の Linux の定義では、この定数が 0.2.189 まであり(`src/unix/linux_like/linux/mod.rs`)、0.2.190 で消えた。0.2.190 以降では `error[E0425]: cannot find value ENOATTR in crate libc` でビルドが止まる
  - 試作は直接使わない依存として `Cargo.toml` に `libc = "=0.2.189"` を書き、理由をコメントにした。`Cargo.lock` だけの固定は `cargo update` で外れるが、`Cargo.toml` の版の指定は `cargo update` でも守られる
  - `Cargo.lock` も commit する
- 最後の窓が閉じたらアプリを終了する(`cx.on_window_closed` で `cx.windows()` が空なら `cx.quit()`)。gpui 0.2.2 は、窓を閉じてもプロセスを終了しない
- 窓のタイトルは `Window::set_window_title` で付ける。gpui 0.2.2 の Wayland の実装は `TitlebarOptions::title` を読まない(X11、macOS、Windows の実装は読む)。そのため Wayland では、`TitlebarOptions::title` に書いた文字列は窓のタイトルに反映されない。試作の最初の実行では `hyprctl` の `title` が `""` だった
- 段階 5 の画面は、この版と `libc` の上限から始める。gpui を上げるときは、新しい ADR で版と上限を決め直す

## 検討した代わり

- **Zed のリポジトリの gpui を git のコミットで使う**: crates.io の 0.2.2 は 2025-10-22 の公開で、その後の版はない(crates.io の API `https://crates.io/api/v1/crates/gpui` で確かめた)。Zed は gpui を自分の monorepo で開発し続けている。git の依存にすると新しい修正が入るが、Zed の workspace 全体を取ってくることになり、版の目印もない。今回は 0.2.2 で窓と文字の両方が確かめられたので、選ばなかった。0.2.2 で段階 5 に要る機能が足りないとわかったら、この案を新しい ADR で検討する
- **XWayland の上の GPUI**: ネイティブの窓が開いたので要らない
- **GPUI が使えなくなったときの代わり: iced**(crates.io の 0.14.0、2025-12-07 公開、MIT、`rust-version` 1.88)。選んだ理由は次のとおり
  - Wayland のネイティブの窓を winit で開く。描画は wgpu で、Vulkan・Metal・DirectX 12 に対応するので、段階 6 の macOS と Windows にも同じコードで行ける
  - 文字の配置とフォントの代替を cosmic-text で行う。gpui 0.2.2 も Linux では cosmic-text を使う(依存に `cosmic-text` 0.14.2)ので、今回描けた日本語の代替フォントの選び方は iced でも同じ仕組みになる
  - System76 の COSMIC デスクトップが iced を土台にしている
  - ライセンスが MIT だけで、依存の追加で困らない
  - ターミナルの描画(libghostty の画面)は、iced の `canvas` か `shader` の widget で自分で描くことになる。これは GPUI でも同じ(GPUI にもターミナルの部品はない)
  - **iced では窓を開いていない。** iced に替えるときは、この試作と同じ確認(`hyprctl clients -j` と `grim`)を iced でしてから決める
- 代わりの候補で選ばなかったもの: Slint(ライセンスが GPLv3・ロイヤリティ無料・商用の 3 つで、条件を読み分ける手間が増える)、egui(毎フレーム描き直す方式で、Web UI と同じ画面を部品の状態ごとに作るのに向かない)、Tauri(Web の技術で画面を作るので、Web UI と別にデスクトップの画面を作る計画の理由がなくなる)

## 依存

### gpui

- 名前と版: `gpui` 0.2.2(`Cargo.toml` で `=0.2.2` に固定)
- 入手元: crates.io(<https://crates.io/crates/gpui/0.2.2>)。リポジトリは <https://github.com/zed-industries/zed>
- ライセンス: Apache-2.0
- 保守の状況: crates.io の最後の公開は 2025-10-22(0.2.2)で、1 年以上新しい版がない。開発は Zed の monorepo で続いている
- `build.rs` が実行すること(gpui 0.2.2 の `build.rs` を読んだ)
  - Linux: `naga` で `src/platform/blade/shaders.wgsl` を構文解析し、失敗したらビルドを止める。外部のコマンドは実行しない
  - macOS: `bindgen` でシステムのヘッダーから binding を作り、`cbindgen` でヘッダーを書き出し、`xcrun` で Metal のシェーダーをコンパイルする
  - Windows: `fxc.exe`(Windows SDK。`GPUI_FXC_PATH` で場所を指定できる)で HLSL のシェーダーをコンパイルし、`embed-resource` で manifest と resource を埋め込む
- C のコードを扱う、間接の依存の `build.rs`(Linux)
  - `freetype-sys` 0.20.1: `pkg-config` で `freetype2` 24.3.18 以上を探し、見つからなければ同梱の FreeType を C++ でコンパイルする。この PC では見つかった(26.7.20)
  - `yeslogic-fontconfig-sys` 6.0.1: `pkg-config` で `fontconfig` を探し、見つからなければビルドを止める(`RUST_FONTCONFIG_DLOPEN` があれば探さない)
  - `ring` 0.17.14: 同梱の C とアセンブリを `cc` でコンパイルする
  - `wayland-sys` 0.31.11: 機能 `dlopen` が有効なので、何もリンクしない。`libwayland-client.so` は実行時に開く
- 間接の依存を含めた crate の数: 709(試作の crate を除く。`cargo metadata --format-version 1` の `resolve.nodes` を数えた)。ライセンスは MIT・Apache-2.0・BSD・ISC・Zlib・Unicode-3.0・CC0 などの寛容なものと、MPL-2.0 が 3 つ(`cbindgen` 0.28.0 は macOS のビルドだけ、`dwrote` 0.11.5 は Windows だけ、`option-ext` 0.2.0)。MPL-2.0 はファイル単位の copyleft で、実行ファイルを配布するときは、その crate のソースの入手先を受け取る人に示す必要がある

### libc

- 名前と版: `libc` 0.2.189(`Cargo.toml` で `=0.2.189` に固定。試作のコードは使わず、gpui の依存の版を抑えるためだけに書いた)
- 入手元: crates.io。リポジトリは <https://github.com/rust-lang/libc>
- ライセンス: MIT OR Apache-2.0
- `build.rs` が実行すること: `rustc --version` で版を調べ、版とターゲットに応じた cfg を出す。FreeBSD では `freebsd-version`、Emscripten では `emcc -dumpversion` も実行する。C のコードはコンパイルしない

### 必要なシステムのパッケージ(Arch Linux の名前)

- ビルドに要るもの: `gcc`、`pkgconf`、`fontconfig`(`fontconfig.pc`)、`libxcb`、`libxkbcommon`、`libxkbcommon-x11`。`freetype2` はあれば使い、なければ同梱のものをコンパイルする
- 実行に要るもの: `wayland`(`libwayland-client`)、`vulkan-icd-loader` と Vulkan のドライバー(この PC では `vulkan-radeon`)、`libxkbcommon`、`libxkbcommon-x11`、`libxcb`、日本語の字形を持つフォント(この PC では Noto Sans CJK JP と IBM Plex Sans JP)
- 根拠: `ldd target/debug/gpui-window` の出力(`rust/prototypes/gpui-window/records/ldd.txt`)がリンクを示したのは `libxcb`・`libxkbcommon`・`libxkbcommon-x11`(と glibc など)だけ。窓を開いている間の `/proc/<pid>/maps` に現れた共有ライブラリ(`records/maps.txt`)には、ほかに `libvulkan.so.1.4.363`、`libvulkan_radeon.so`、`libwayland-client.so.0.26.0` があった。`libfontconfig` と `libfreetype` は読み込まれていなかった(文字は cosmic-text が描く)

### Rust の版

- 1.94.0(この PC の rustup の既定のツールチェイン)、edition 2024
- gpui 0.2.2 は `rust-version` を宣言していない。1.94.0 で警告なくビルドできたので、試作のフォルダーに `rust-toolchain.toml` は置いていない。Issue #108 が自分の `rust-toolchain.toml` を求めるのは、GPUI が #110 の版より新しい版を求めるときだけである。作業の時点の `origin/rust` には、#110 の `rust/rust-toolchain.toml` はまだなかった

## 結果

- 段階 5 の画面を gpui 0.2.2 で作り始められる。この PC で確かめたのは、Wayland のネイティブの窓が開くこと、日本語を含む文字が描かれること、窓を閉じるとプロセスが終わることだけである。フォントの名前を指定しなくても、日本語は代替フォントで描かれた
- キー入力、日本語の入力(IME)、HiDPI の倍率、クリップボードは確かめていない。段階 5 で画面を作るときに確かめる
- `libc` の上限(0.2.189 以下)を外せない。`rust/` の workspace に gpui を入れるときも、同じ上限が要る。workspace の `Cargo.lock` は 1 つなので、ほかの crate も `libc` 0.2.189 以下で動く必要がある
- 窓のタイトルは `Window::set_window_title` で付ける
- 段階 6 の Windows のビルドには Windows SDK の `fxc.exe` が、macOS のビルドには Xcode(`xcrun` と Metal のコンパイラ)が要る
- デバッグのビルドは大きい。`cargo build` と `cargo clippy` のあとの `target/` が 4.2 GB、実行ファイルが 464 MB になった。CI で `target/` を cache するときは、この大きさを前提にする

## 確かめたこと

PC: AMD Phoenix1(Radeon、Mesa 26.2.5、Vulkan)、16 スレッド。OS: Linux 7.2.15-1-omarchy(Arch Linux 系の Omarchy)。Hyprland 0.56.2。Rust 1.94.0。記録は `rust/prototypes/gpui-window/records/` に置いた。

1. 最初のビルド(`cargo build`。間接の依存は cargo が選んだ最新の版のまま。`libc` は 0.2.191)は、`xattr` 0.2.3 のコンパイルで止まった

   ```text
   error[E0425]: cannot find value `ENOATTR` in crate `libc`
     --> .../xattr-0.2.3/src/sys/mod.rs:12:56
   error: could not compile `xattr` (lib) due to 1 previous error
   ```

   `cargo tree -i xattr@0.2.3` で、経路が `gpui` → `gpui_http_client` → `zed-async-tar` → `xattr` だとわかった。`libc` の 0.2.185 から 0.2.191 までのソースを `grep -rn 'const ENOATTR' src/unix/linux_like/linux` で調べ、0.2.189 まではあり、0.2.190 と 0.2.191 にはないことを確かめた
2. `cargo clean` からのビルドの時間(`libc` 0.2.189 で): `time cargo build` で real 45.1 秒(user 6 分 24 秒、sys 33.6 秒)。依存の取得は済んだ状態で測った(`records/build-time.txt`)
3. `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo build` が通った
4. `./capture.sh screenshot-wayland.png records` で窓を開いた。スクリプトは、窓を浮動にして中央に置き(通知の表示と重ならないように。Hyprland の設定は変えず、この窓だけへの dispatch)、`hyprctl clients -j` を記録し、その窓の範囲だけを `grim -g` で撮り、プロセスを終了する。`hyprctl clients -j` の該当部分(`records/client.json`):

   ```json
   {"class":"herdr-fleet-gpui-window","title":"herdr-fleet GPUI prototype","xwayland":false,"pid":4014257,"at":[1480,613],"size":[480,240],"workspace":"1","floating":true}
   ```

5. スクリーンショット: [`rust/prototypes/gpui-window/screenshot-wayland.png`](../../../rust/prototypes/gpui-window/screenshot-wayland.png)(480×240)。`herdr-fleet` と `承認待ち` が描かれている
6. 閉じたことの確認: プロセスの終了の 0.5 秒後に、`hyprctl clients -j` にその pid の窓は 0 件、`ps -p <pid>` も 0 件。`ps -C gpui-window` にも残っていなかった
7. 窓を閉じたときの終了: 試作を起動し、`hyprctl dispatch 'hl.dsp.window.close({ window = "pid:<pid>" })'` で窓を閉じると、プロセスは 3 秒以内に終了コード 0 で終わった
