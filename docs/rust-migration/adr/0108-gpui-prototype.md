# デスクトップの画面に GPUI 0.2.2(crates.io)を使う

- 状態: 採用
- 決めた日: 2026-11-08
- Issue: #108

## 状況

段階 5 のデスクトップの画面は GPUI で作る計画である(`docs/rust-migration/plan.md` の「段階 0: 土台と試作」)。その前に、使う人の PC(Linux、Wayland、Hyprland)で、GPUI が Wayland のネイティブの窓を開き、英語と日本語の文字を描けるかを確かめる必要があった。描けなければ代わりを決める。

試作は `rust/prototypes/gpui-window/` に置いた。`Cargo.toml` に空の `[workspace]` を書き、`rust/` の workspace には入れていない。

## 決定

- GPUI は crates.io の `gpui = "=0.2.2"` を使う。試作では、Wayland のネイティブの窓(`"xwayland": false`)が開き、`herdr-fleet` と `承認待ち` が描かれた(下の「確かめたこと」)
- `Cargo.lock` を commit し、次の 2 つの依存を古い版に固定する。`cargo update` をすると、次の理由でビルドが壊れる
  - `libc` を 0.2.185 に固定する。gpui 0.2.2 の依存 `xattr` 0.2.3(`gpui_http_client` → `zed-async-tar` 経由)は Linux で `libc::ENOATTR` を参照する。`libc` 0.2.186 以降の Linux の定義にはこの定数がなく、`error[E0425]: cannot find value ENOATTR in crate libc` でビルドが止まる。0.2.185 には `pub const ENOATTR: c_int = crate::ENODATA;` がある(`src/unix/linux_like/linux/mod.rs`)
  - `nix` を 0.31.2 に固定する。`nix` 0.31.3 が `libc` 0.2.186 以上を求めるため(`gpui_util` → `command-fds` 経由)
- 窓のタイトルは `Window::set_window_title` で付ける。gpui 0.2.2 で `TitlebarOptions::title` を読むのは X11 の実装(`src/platform/linux/x11/window.rs`)だけで、Wayland の窓のタイトルは空のままだった(試作の最初の実行で `hyprctl` の `title` が `""`)
- 段階 5 の画面は、この版と固定から始める。gpui を上げるときは、新しい ADR で版と固定を決め直す

## 検討した代わり

- **Zed のリポジトリの gpui を git のコミットで使う**: crates.io の 0.2.2 は 2025-10-22 の公開で、その後の版はない。Zed は gpui を自分の monorepo で開発し続けている。git の依存にすると新しい修正が入るが、Zed の workspace 全体を取ってくることになり、版の目印もない。今回は 0.2.2 で窓と文字の両方が確かめられたので、選ばなかった。0.2.2 で段階 5 に要る機能が足りないとわかったら、この案を新しい ADR で検討する
- **XWayland の上の GPUI**: ネイティブの窓が開いたので要らない
- **GPUI が使えなくなったときの代わり: iced**(crates.io の 0.14.0、2025-12-07 公開、MIT、`rust-version` 1.88)。選んだ理由は次のとおり
  - Wayland のネイティブの窓を winit で開く。描画は wgpu で、Vulkan・Metal・DirectX 12 に対応するので、段階 6 の macOS と Windows にも同じコードで行ける
  - 文字の配置とフォントの代替を cosmic-text で行う。gpui 0.2.2 も Linux では cosmic-text を使う(依存に `cosmic-text` 0.14.2)ので、今回描けた日本語の代替フォントの選び方は iced でも同じ仕組みになる
  - System76 の COSMIC デスクトップの土台として保守されている
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
- 間接の依存を含めた crate の数: 709(試作の crate を除く。`cargo metadata` の resolve)。ライセンスは MIT・Apache-2.0・BSD・ISC・Zlib・Unicode-3.0・CC0 などの寛容なものと、MPL-2.0 が 3 つ(`cbindgen` 0.28.0 は macOS のビルドだけ、`dwrote` 0.11.5 は Windows だけ、`option-ext` 0.2.0)。MPL-2.0 はファイル単位の copyleft で、実行ファイルを配布するときは、その crate のソースの入手先を受け取る人に示す必要がある

### 必要なシステムのパッケージ(Arch Linux の名前)

- ビルドに要るもの: `gcc`、`pkgconf`、`fontconfig`(`fontconfig.pc`)、`libxcb`、`libxkbcommon`、`libxkbcommon-x11`。`freetype2` はあれば使い、なければ同梱のものをコンパイルする
- 実行に要るもの: `wayland`(`libwayland-client`)、`vulkan-icd-loader` と Vulkan のドライバー(この PC では `vulkan-radeon`)、`libxkbcommon`、`libxkbcommon-x11`、`libxcb`、日本語の字形を持つフォント(この PC では Noto Sans CJK JP と IBM Plex Sans JP)
- 根拠: `ldd target/debug/gpui-window` がリンクを示したのは `libxcb`・`libxkbcommon`・`libxkbcommon-x11`(と glibc など)だけ。窓を開いている間の `/proc/<pid>/maps` には、ほかに `libvulkan.so.1.4.363`、`libvulkan_radeon.so`、`libwayland-client.so.0.26.0` があった。`libfontconfig` と `libfreetype` は読み込まれていなかった(文字は cosmic-text が描く)

### Rust の版

- 1.94.0(この PC の rustup の既定のツールチェイン)、edition 2024
- gpui 0.2.2 は `rust-version` を宣言していない。1.94.0 で警告なくビルドできたので、試作のフォルダーに `rust-toolchain.toml` は置いていない。作業の時点の `origin/rust` には、#110 の `rust/rust-toolchain.toml` はまだなかった

## 結果

- 段階 5 の画面を gpui 0.2.2 で作り始められる。この PC で確かめたのは、Wayland のネイティブの窓が開くことと、日本語を含む文字が描かれることだけである。フォントの名前を指定しなくても、日本語は代替フォントで描かれた
- キー入力、日本語の入力(IME)、HiDPI の倍率、クリップボードは確かめていない。段階 5 で画面を作るときに確かめる
- `Cargo.lock` の `libc` 0.2.185 と `nix` 0.31.2 の固定を外せない。`rust/` の workspace に gpui を入れるときも、同じ固定が要る(workspace の `Cargo.lock` は 1 つなので、ほかの crate も `libc` 0.2.185 で動く必要がある)
- 窓のタイトルは `Window::set_window_title` で付ける(`TitlebarOptions::title` は Wayland では効かない)
- 段階 6 の Windows のビルドには Windows SDK の `fxc.exe` が、macOS のビルドには Xcode(`xcrun` と Metal のコンパイラ)が要る
- デバッグのビルドは重い。`target/` が 3.4 GB、実行ファイルが 464 MB になった。CI では `target/` の cache の大きさに気をつける

## 確かめたこと

PC: AMD Phoenix1(Radeon、Mesa 26.2.5、Vulkan)、16 スレッド。OS: Linux 7.2.15-1-omarchy(Arch Linux 系の Omarchy)。Hyprland 0.56.2。Rust 1.94.0。

1. 最初のビルド(`cargo build`。間接の依存は cargo が選んだ最新の版のまま)は、`xattr` 0.2.3 のコンパイルで止まった

   ```text
   error[E0425]: cannot find value `ENOATTR` in crate `libc`
     --> .../xattr-0.2.3/src/sys/mod.rs:12:56
   error: could not compile `xattr` (lib) due to 1 previous error
   ```

   `cargo tree -i xattr@0.2.3` で、経路が `gpui` → `gpui_http_client` → `zed-async-tar` → `xattr` だとわかった。`libc` を 0.2.190 と 0.2.186 に下げても定数はなく、0.2.185 にはあった。`cargo update -p nix@0.31.3 --precise 0.31.2` と `cargo update -p libc --precise 0.2.185` で固定した
2. 固定のあとの、`cargo clean` からのビルドの時間: `time cargo build` で real 47.0 秒(user 6 分 25 秒、sys 32.8 秒)。依存の取得は済んだ状態で測った
3. `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo build` が通った
4. `./capture.sh "$PWD/screenshot-wayland.png" <フォルダー>` で窓を開いた。スクリプトは、窓を浮動にして中央に置き(通知の表示と重ならないように。Hyprland の設定は変えず、この窓だけへの dispatch)、`hyprctl clients -j` を記録し、その窓の範囲だけを `grim -g` で撮り、プロセスを終了する。`hyprctl clients -j` の該当部分:

   ```json
   {"class":"herdr-fleet-gpui-window","title":"herdr-fleet GPUI prototype","xwayland":false,"pid":3984376,"at":[1480,613],"size":[480,240],"workspace":"1","floating":true}
   ```

5. スクリーンショット: [`rust/prototypes/gpui-window/screenshot-wayland.png`](../../../rust/prototypes/gpui-window/screenshot-wayland.png)(480×240)。`herdr-fleet` と `承認待ち` が描かれている
6. 閉じたことの確認: プロセスの終了の 0.5 秒後に、`hyprctl clients -j` にその pid の窓は 0 件、`ps -p <pid>` も 0 件。`ps -C gpui-window` にも残っていなかった
