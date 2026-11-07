# ターミナルのバイト列の解析に libghostty-vt を使う

- 状態: 採用
- 決めた日: 2026-11-08
- Issue: #109

## 状況

計画(`docs/rust-migration/plan.md`)の段階 5 では、GPUI のデスクトップの画面で、ペインのターミナルを libghostty で描く。段階 0 では、その前に次の 2 点を試作で確かめ、使えない場合の代わり(`alacritty_terminal`、`vte`)を決める。

- libghostty-vt を Rust から使えるか。Zig でビルドでき、その C API を Rust から呼べるか
- 記録したペインのバイト列を libghostty-vt で解析した画面が、Ghostty 本体の画面と同じになるか

前提と制約は次のとおり。

- libghostty-vt の C API は、ヘッダー(`include/ghostty/vt.h`)に「未完成で、安定していない。必ず変わる」と書かれている
- この PC の Ghostty は 1.4.0(Omarchy のパッケージ `ghostty 1.4.0-1`。`ghostty --version` は `1.4.0+omarchy.1`)で、比べる相手はこれにした
- 試作の crate(`rust/prototypes/terminal-vt/`)は `rust/` の workspace に入れない。`Cargo.toml` に空の `[workspace]` を書いた

## 決定

- ターミナルのバイト列の解析と画面の状態の保持には libghostty-vt を使う。代わりの `alacritty_terminal` は使わない
- libghostty-vt は、Ghostty v1.4.0 のソース(コミット `83fb95624b0439ee660c2679b43b38c8b63769cd`)を Zig 0.17.0 でビルドし、静的ライブラリ `libghostty-vt.a` としてリンクする。ビルドは `build.rs` が行う(下の「依存」)
- バインディングは、使う関数と構造体だけを手で書いた `extern "C"` にする(試作では関数 7 つと構造体 3 つ。テストでは型の一覧を返す関数を足して 8 つ)。手で書いた構造体の大きさとフィールドの位置は、ライブラリ自身が返す型の一覧(`ghostty_type_json()` の JSON)と比べるテストで確かめる。C API は版ごとに変わるので、Ghostty のコミットを上げたときに、宣言と実物の食い違いがこのテストで失敗として出る
- Ghostty のコミットは固定する。上げるときは、`fixtures/` の全件で、libghostty-vt の画面が Ghostty の画面と一致するテストを通す
- 段階 5 でも libghostty-vt が使えなくなった場合の代わりは `alacritty_terminal` とする。7 件のうち 6 件で画面の文字が一致し、残りの 1 件も行ごとの文字は同じだった(下の「確かめたこと」)

## 検討した代わり

- `alacritty_terminal` 0.26.0: 同じ 7 件で、6 件が一致した。一致しなかった `nvim-japanese` の違いと理由は「確かめたこと」に書いた。選ばなかった理由は 2 つある。1 つ目は、比べる相手が Ghostty の画面で、libghostty-vt はその Ghostty と同じコードなので、7 件すべてがバイト単位で一致したこと。2 つ目は、alacritty のセルは、書かれていないセルと空白を書いたセルを区別しない(どちらも `' '`)ので、Ghostty が残す行末の空白を再現できないこと。比べるときは、両方の行末の空白を削った
- `vte` 0.15.0 だけを使う: `vte` はエスケープシーケンスの解析器で、画面(セルの格子、スクロールバック、代替画面)を持たない。使うには画面の状態を自分で書くことになるので、画面としては試していない。`alacritty_terminal` は `vte` 0.15.0 を解析器として使っているので、`vte` の解析は `alacritty_terminal` を通して確かめたことになる
- bindgen でバインディングを生成する: ビルドのたびに libclang が要る。試作で使う C API は関数 7 つと構造体 3 つで、手で書いた宣言の誤りは型の一覧との比較テストで見つかるので、手で書いた

## 依存

| 名前 | 版 | 入手元 | ライセンス | 保守の状況 | `build.rs` が実行すること |
| --- | --- | --- | --- | --- | --- |
| libghostty-vt(Ghostty のソース) | v1.4.0、コミット `83fb95624b0439ee660c2679b43b38c8b63769cd` | https://github.com/ghostty-org/ghostty | MIT | Ghostty の開発元が保守している。C API は未完成と明記されている | この crate の `build.rs` が、下の手順でソースの取得、Zig でのビルド、リンクの指定を行う |
| Zig | 0.17.0(Ghostty 1.4.0 の `build.zig.zon` の `minimum_zig_version`) | mise(`mise install zig@0.17.0`)。この PC の PATH にはないので、`ZIG` 環境変数で場所を渡す | MIT | Zig Software Foundation が開発している | なし(`build.rs` から呼ばれる) |
| `alacritty_terminal` | 0.26.0 | crates.io | Apache-2.0 | Alacritty の開発元が保守している | なし(`build.rs` を持たない) |
| `vte` | 0.15.0(`alacritty_terminal` の依存) | crates.io | Apache-2.0 OR MIT | Alacritty の開発元が保守している | なし(`build.rs` を持たない) |
| `serde_json` | 1.0.154(テストだけで使う) | crates.io | MIT OR Apache-2.0 | serde の開発元が保守している | 対象の CPU の種類から、コンパイルの条件を決める |

この crate の `build.rs` が実行すること:

1. Ghostty のソースを用意する。環境変数 `GHOSTTY_SOURCE_DIR` があれば、そのフォルダーをそのまま使う(`git rev-parse HEAD` が固定したコミットと違えば警告を出す)。なければ `$OUT_DIR/ghostty-src` で `git init`、`git fetch --depth 1 https://github.com/ghostty-org/ghostty.git <コミット>`、`git checkout FETCH_HEAD` を行う。取得は一度だけで、そのコミットがあれば取得しない
2. ソースのフォルダーで `zig build -Demit-lib-vt -Doptimize=ReleaseFast --prefix $OUT_DIR/ghostty-vt` を実行する。`zig` は環境変数 `ZIG` があればそれ、なければ PATH の `zig`。Zig は、Ghostty の `build.zig.zon` と `pkg/*/build.zig.zon` に URL とハッシュで固定された依存を取得し、ハッシュを確かめる。この PC の 1 回目のビルドでは、zlib、wuffs、pixels、highway、ghostty-themes を `deps.files.ghostty.org` から取得した
3. `$OUT_DIR/ghostty-vt/lib/libghostty-vt.a` を静的にリンクし、libm と libc をリンクする。このライブラリが外に求める記号は libc のものだけだった(`nm -u` で、ライブラリの中で定義されていない記号を調べた)

依存 crate のうち `build.rs` を持つものは、次のことだけをする。どれもネットワークには出ない(`build.rs` を読んで確かめた)。

- `libc`、`rustix`、`proc-macro2`、`quote`、`serde`、`serde_core`、`zmij`: `rustc` を実行して版を調べ、コンパイルの条件を決める
- `parking_lot_core`: 環境変数でスレッドのサニタイザーの有無を見る
- `signal-hook`: 使っていない機能(`extended-siginfo-raw`)のときだけ C をコンパイルする。この crate では何もしない

## 結果

できるようになること:

- Rust から libghostty-vt を呼び、ペインのバイト列から、Ghostty 1.4.0 と同じ画面の文字を得られる。記録した 7 件で、Ghostty の `write_screen_file` の出力とバイト単位で一致した
- libghostty-vt の formatter で、画面を平文、VT のシーケンス、HTML のどれでも書き出せる(試作で使ったのは平文だけ)

できないこと、制約:

- ビルドに Zig 0.17.0 が要る。この crate の外の Rust のビルドとは別の道具になる
- 1 回目のビルドは、ネットワーク(GitHub と `deps.files.ghostty.org`)に出る。オフラインでビルドするには、ソースを置いて `GHOSTTY_SOURCE_DIR` を渡し、Zig の依存を Zig のキャッシュ(`~/.cache/zig`)に入れておく
- この PC では、Zig のキャッシュが空の状態からの `zig build` に 2 分 20 秒かかった。Zig のキャッシュがある状態で、`target/` を消してからの `cargo test` は 1 分 23 秒だった
- C API は安定していない。Ghostty の版を上げると、宣言を直す必要が出ることがある
- macOS と Windows でのビルド、描画用の API(`render.h`)、キー入力の符号化、速さは試していない

あとの段階が従うこと:

- 段階 5 のターミナルの crate は、この試作と同じく、固定した Ghostty のコミットを Zig でビルドして libghostty-vt をリンクする。手で書く宣言には、型の一覧との比較テストを付ける
- Ghostty のコミットを上げるときは、`fixtures/` の記録で、Ghostty の画面との一致を確かめる。画面の違いを見つけたら、その記録を `fixtures/` に足す
- Linux の workflow でこの試作や段階 5 の crate をビルドするには、workflow に Zig 0.17.0 を入れる手順が要る。段階 5 で本番の crate に libghostty-vt のビルドを入れるとき、workflow にその手順を足す

## 確かめたこと

使った PC と版: Linux 7.2.15-1-omarchy、Hyprland 0.56.2、Ghostty 1.4.0(`1.4.0+omarchy.1`)、rustc 1.94.0、Zig 0.17.0、util-linux 2.42.4 の `script`、Claude Code 2.1.319、codex-cli 0.167.0。

### 記録

7 件を `rust/prototypes/terminal-vt/fixtures/` に置いた。各件の内容、列数と行数、取り方は `fixtures/README.md` にある。取ったのは `script`(`scripts/record-all.sh`)で、モデルにプロンプトを送っていない。エージェント CLI(Claude Code と Codex)は、空の設定フォルダーで起動し、入力を送らずに初回の画面を記録した。

### Ghostty の画面の取り方

`scripts/capture_ghostty.py` で、各件のバイト列を、同じ列数と行数の Ghostty 1.4.0 に流し、Ghostty の `write_screen_file:paste,plain` の動作が書き出したファイルを `ghostty-screen.txt` に置いた。手順は次のとおり(詳細は `fixtures/README.md`)。

1. Hyprland の `hl.exec_cmd(..., { float = true })` で、浮動の Ghostty の窓を開く。オプションは `--config-default-files=false --gtk-single-instance=false --window-decoration=none --window-padding-x=0 --window-padding-y=0 --window-width=<列数> --window-height=<行数>` と、`--keybind=ctrl+shift+f12=write_screen_file:paste,plain`
2. 窓の中の `scripts/ghostty_replay.py` が、端末の大きさが件の大きさと同じことを確かめ、tty を raw にして、バイト列をそのまま書く
3. 書き終えて 1 秒後に、Hyprland の `hl.dsp.send_shortcut` で、その窓に Ctrl+Shift+F12 を送る。Ghostty が画面をファイルに書き、そのパスを pty に貼る。`ghostty_replay.py` がそのファイルを写して終わり、窓が閉じる

装飾と余白を付けたままだと、40x12 を求めた窓の端末は 39x11 になった。装飾と余白をなくすと、40x12、100x30、90x28 のどれも求めたとおりになった。どの件でも、`ghostty_replay.py` が大きさを確かめてからバイト列を書いた。

`write_screen_file` は、Ghostty のソースの `src/Surface.zig` で、使っている画面(主画面か代替画面)のスクロールバックと画面の全体を、`unwrap = true`(折り返した行をつなぐ)、`trim = false` の平文で書く。試作は、libghostty-vt の formatter を同じ設定(選択範囲なし、平文、`unwrap = true`、`trim = false`)で呼んだ。

### テスト

```
cd rust/prototypes/terminal-vt
export ZIG=$(mise where zig@0.17.0)/zig
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test -- --nocapture
```

3 つとも通った。テストは `fixtures/` だけを読み、Ghostty を起動しない。記録ごとの結果は次のとおり。

| 記録 | 大きさ | libghostty-vt | `alacritty_terminal` |
| --- | --- | --- | --- |
| `claude-startup` | 100x30 | 一致(37 行、バイト単位で同じ) | 一致 |
| `codex-startup` | 100x30 | 一致(14 行、バイト単位で同じ) | 一致 |
| `less-sgr` | 90x28 | 一致(28 行、バイト単位で同じ) | 一致 |
| `nvim-japanese` | 100x30 | 一致(29 行、バイト単位で同じ) | 8 行目が不一致 |
| `scroll-wrap` | 60x10 | 一致(34 行、バイト単位で同じ) | 一致 |
| `sgr-colors` | 80x24 | 一致(27 行、バイト単位で同じ) | 一致 |
| `wide-chars` | 40x12 | 一致(10 行、バイト単位で同じ) | 一致 |

libghostty-vt は 7 件中 7 件、`alacritty_terminal` は 7 件中 6 件が一致した。`alacritty_terminal` の比較は、両方の各行の行末の空白と、末尾の空行を削ってから行ごとに行った。

`nvim-japanese` の 8 行目では、Ghostty の画面は `長い行: いろは…ゑひもせすん、これは折り返されるはずの行です。` の 1 行で、`alacritty_terminal` の画面は `…ゑひもせ` で行が終わり、`すん、…` が次の行になった。原因は次のとおり。

- nvim は 1 回目の描画で、`…せ` で 100 列目まで埋めたあと、続けて `すん、…` を書いている。端末が自動で折り返し、行に「折り返した」という印が付く
- nvim は 2 回目の描画(`output.bin` の 4950 バイト目付近)で、同じ行を `…せ` まで書き、`\r\n` で次の行に移ってから `すん、…` を書いている。折り返しは起きない
- Ghostty は、1 回目に付いた折り返しの印を行に残す。`alacritty_terminal` は、セルを書き直すときに印を消す。`write_screen_file` は印のある行を次の行とつなぐので、2 つの画面の文字は、行のつなぎ方だけが違う

行をつながずに比べると、各行の文字が同じことを、一時的なテストで確かめた(libghostty-vt を `unwrap = false` にし、`alacritty_terminal` で行をつながずに、行末の空白を削って比べた。7 件すべてで全行が同じだった)。このテストはコミットしていない。`tests/alacritty.rs` は、一致する 6 件の名前を固定して確かめる。
