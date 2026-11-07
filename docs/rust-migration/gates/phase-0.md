# 段階 0 の関門の報告

- 確かめた日: 2026-11-08
- 確かめた対象: `rust` ブランチのコミット `97e1e24`(PR #116 のマージ)
- 確かめた thread: `134e1f18`
- 結論: 計画(`docs/rust-migration/plan.md`)の「段階 0: 土台と試作」の完了条件 3 つと、段階 0 に書かれた項目のすべてを満たす。足りないものは 0 件で、この関門では Issue を開いていない。段階 0 の Issue(#107〜#111)はすべて閉じている(PR #114〜#118)

## 確かめた環境

- PC: Linux 7.2.15-1-omarchy、Hyprland 0.56.2
- Rust: `rust/rust-toolchain.toml` が固定した rustc 1.99.1(58cf8f9c3 2026-10-13)。rustup は `rust/` の下のどのフォルダーでも、このファイルの版を使う(試作 2 つも同じ)
- Zig: 0.17.0(`mise where zig@0.17.0` の `zig` を `ZIG` 環境変数で渡した。terminal-vt の `build.rs` が使う)
- 検査はすべて `HERDR_*` の環境変数を外して実行した。herdr のセッションとポートは使っていない

## 完了条件

| 完了条件 | 確かめたこと | 結果 |
|---|---|---|
| workflow が緑 | `gh run list --branch rust` の最新の run が、workflow `rust` は [42410430116](https://github.com/atriumnook/herdr-fleet/actions/runs/42410430116)(`push`、`97e1e24`)で success、workflow `rust-cross` は [42410444613](https://github.com/atriumnook/herdr-fleet/actions/runs/42410444613)(`workflow_dispatch`、`97e1e24`)で success。`rust` の run では、job `linux` の fmt、clippy、test、解析の crate の依存の検査、禁じた API の許可の検査がすべて success。`rust-cross` の run では、`gate`、`build (macos-15)`、`build (windows-2025)` がすべて success。手元でも `rust/` で `cargo fmt --check`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --workspace` が終了コード 0 で終わった(下の「手元の検査」) | 満たす |
| 試作 3 つの結論が ADR にある | GPUI の試作は `0108-gpui-prototype`、libghostty-vt の試作は `0109-terminal-emulator`、macOS と Windows 向けのビルドは `0111-cross-build` に、決定と「確かめたこと」がある。手元で試作 2 つの検査も通った(下の「手元の検査」) | 満たす |
| crate の分け方の ADR がある | `0107-crate-split` がある。この ADR の crate の一覧の 11 個と、`rust/crates/` の 11 個の crate の名前と依存(各 `Cargo.toml` の `[dependencies]`)が一致した | 満たす |

## 段階 0 の項目

| 項目(計画の段階 0) | 確かめたこと | 結果 |
|---|---|---|
| `rust/` の Cargo workspace | `rust/Cargo.toml` に `[workspace]`(`members = ["crates/*"]`、`resolver = "3"`)がある。試作は workspace に入れず、それぞれの `Cargo.toml` に空の `[workspace]` を書いている(`0108-gpui-prototype`、`0109-terminal-emulator`)。決定は `0110-workspace-and-ci` | 満たす |
| `rust-toolchain.toml`(版を固定) | `rust/rust-toolchain.toml` が `channel = "1.99.1"` と `rustfmt`、`clippy` を固定している。手元の `rustc --version` も、3 つのフォルダー(`rust/`、`rust/prototypes/gpui-window`、`rust/prototypes/terminal-vt`)で 1.99.1 だった | 満たす |
| Linux の workflow(push と PR ごとに `cargo fmt --check`、`cargo clippy -D warnings`、`cargo test`) | `.github/workflows/rust.yml` の trigger は、`rust` への `push` と、base が `rust` の `pull_request`(`paths` の絞り込みなし)。job `linux`(`ubuntu-24.04`)が `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace` を実行する。thread のブランチへの push では走らないが、そのブランチの変更は base が `rust` の PR で検査される(`0110-workspace-and-ci` の「きっかけ」)。最新の run は上の表のとおり success | 満たす |
| GPUI が、この PC(Linux、Wayland、Hyprland)で窓を開き、文字を描ける | `0108-gpui-prototype` の「確かめたこと」に、Wayland のネイティブの窓(`hyprctl clients -j` の `"xwayland": false`)が開き、`herdr-fleet` と `承認待ち` が描かれたスクリーンショット(`rust/prototypes/gpui-window/screenshot-wayland.png`、480×240)と、窓を閉じるとプロセスが終了コード 0 で終わったことがある。この関門では窓を開き直していない(使う人のデスクトップに窓を出すため)。代わりに、同じ試作の `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo build` を手元で通した | 満たす |
| libghostty-vt を Rust から使える(Zig でのビルド、C API のバインディング)。記録したペインのバイト列を解析し、Ghostty 本体と同じ画面になる | `0109-terminal-emulator` が、Ghostty v1.4.0 のソースを Zig 0.17.0 でビルドして静的にリンクし、手で書いた `extern "C"` で呼ぶと決めている。記録 7 件で、libghostty-vt の画面が Ghostty 1.4.0 の `write_screen_file` の出力とバイト単位で一致した。手元で `rust/prototypes/terminal-vt` の `cargo test` を走らせ、この一致を確かめるテストが通った(下の「手元の検査」) | 満たす |
| macOS と Windows 向けに、空の GPUI アプリがビルドできる(workflow を手動で 1 回) | `0111-cross-build` に、PR #116 の上の run [42409532572](https://github.com/atriumnook/herdr-fleet/actions/runs/42409532572)(macOS 15 arm64 と Windows Server 2025 x64 で `cargo build --release --locked` が成功)がある。マージのあとで `rust` の上で `workflow_dispatch` で起動した run [42410444613](https://github.com/atriumnook/herdr-fleet/actions/runs/42410444613) でも、`build (macos-15)` と `build (windows-2025)` が success だった | 満たす |
| 試作が通らない場合の代わりを決める | GPUI の代わりは iced 0.14.0(`0108-gpui-prototype` の「検討した代わり」)。libghostty-vt の代わりは `alacritty_terminal` 0.26.0 で、記録 7 件のうち 6 件で画面の文字が一致した(`0109-terminal-emulator`)。macOS と Windows 向けのビルドは代わりを要しない(`0108-gpui-prototype` が GPUI を採用したので、`0111-cross-build` は同じ試作をビルドした) | 満たす |
| `improve-codebase-architecture` で crate の分け方を決め、ADR と `docs/rust-migration/GLOSSARY.md` に書く | 報告 `docs/rust-migration/architecture/2026-11-08-typescript-review.html`、ADR `0107-crate-split`、`docs/rust-migration/GLOSSARY.md`(太字の見出しの語が 49 個)がある。`0107-crate-split` の「手順のうち、人に聞くところを置き換えた判断」に、skill の手順を決まりに従って置き換えたことが書かれている | 満たす |

## 手元の検査

コマンド(`rust/` で実行。`PATH` に `~/.cargo/bin`、`ZIG` に Zig 0.17.0 を入れ、`HERDR_*` を外した):

```bash
cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
cd prototypes/gpui-window && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo build
cd ../terminal-vt && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

| フォルダー | コマンド | 結果 |
|---|---|---|
| `rust/` | `cargo fmt --check` | 終了コード 0 |
| `rust/` | `cargo clippy --workspace --all-targets -- -D warnings` | 終了コード 0(警告なし) |
| `rust/` | `cargo test --workspace` | 終了コード 0。走ったテストは 0 件(crate はまだ雛形) |
| `rust/prototypes/gpui-window` | `cargo fmt --check` | 終了コード 0 |
| `rust/prototypes/gpui-window` | `cargo clippy --all-targets -- -D warnings` | 終了コード 0(警告なし) |
| `rust/prototypes/gpui-window` | `cargo build` | 終了コード 0 |
| `rust/prototypes/terminal-vt` | `cargo fmt --check` | 終了コード 0 |
| `rust/prototypes/terminal-vt` | `cargo clippy --all-targets -- -D warnings` | 終了コード 0(警告なし) |
| `rust/prototypes/terminal-vt` | `cargo test` | 終了コード 0。7 件が通った。`libghostty_vt_matches_ghostty_on_every_fixture`(記録 7 件の全件で Ghostty の画面と一致)、`alacritty_terminal_against_ghostty`、`rows_match_libghostty_vt`、`structs_match_the_library_manifest`(手で書いた構造体を、ライブラリの型の一覧と比べる)ほか 3 件 |

workflow `rust` の、解析の crate の依存の検査と禁じた API の許可の検査も、同じ shell の行を手元で実行した。`herdr-fleet-screen` と `herdr-fleet-transcript` の依存は `herdr-fleet-protocol` と `herdr-fleet-herdr-api` だけで、禁じた package はなかった。`crates/screen/src` と `crates/transcript/src` に `clippy::disallowed_*` などの許可はなかった。

## #111 の rust-cross.yml の trigger(codex の reviewer の P1)

結論: 段階 0 の関門を止める理由にはならない。ただし、`pull_request` の trigger を置いた理由は、マージのあとの run で成り立たなくなった。外すかどうかは、すでにある #120 で決める(この関門では新しい Issue を開かない)。この関門は、#120 で `pull_request` の trigger と `gate` ジョブを外し、計画の段階 6 のとおり `workflow_dispatch` だけにすることを勧める。

判断の根拠:

- 計画の段階 6 は、macOS と Windows の workflow を「手動(`workflow_dispatch`)で、段階の関門と切り替えの前だけに走らせる」と決め、その理由として、リポジトリが非公開の間の Actions の無料枠を挙げている
- `0111-cross-build` は、`workflow_dispatch` に加えて、base が `rust` でこのファイル自身を変える `pull_request` でも走らせると決めた。理由は「GitHub は既定のブランチ(`main`)にない workflow を `workflow_dispatch` で起動しないので、`workflow_dispatch` だけでは切り替えまで一度も走らせられない」ことだった
- `pull_request` の trigger で走るのは、このファイルを変える PR を誰かが出したときだけで、その PR への push でも、`gate` ジョブがこのファイルの変化のない push のビルドを止める。PR #116 の上では、ADR だけを変えた push の run(42407013882、42407116033、42408980474、42410286673)でビルドのジョブが skipped になった(`0111-cross-build` の「gate だけの run」と PR #116 のコメント)。つまり、走るのは誰かが意図して走らせたときだけで、計画が段階 6 で手動に限った目的(無料枠を使いすぎない)には反しない。また、このリポジトリは公開なので、標準の runner は無料である
- 一方、`rust` の上で `gh workflow run rust-cross.yml --ref rust` を実行すると起動でき、両 OS のビルドが success だった(run [42410444613](https://github.com/atriumnook/herdr-fleet/actions/runs/42410444613)、event `workflow_dispatch`、`gh api repos/atriumnook/herdr-fleet/actions/runs/42410444613` の `path` は `.github/workflows/rust-cross.yml`)。この run は、PR #116 の `pull_request` の run でこの workflow が GitHub に登録されたあとのものである(#120)。登録された今は、`workflow_dispatch` だけで段階 6 の「手動で走らせる」ができるので、計画と違う trigger を残す理由がない
- P1 として「blocked にする」ことは勧めない。段階 0 の完了条件(workflow が緑、試作の結論が ADR にある)は、この trigger を残しても外しても変わらず、trigger は `.github/workflows/rust-cross.yml` の `on:` を直す 1 つの PR で外せるからである

## 段階 0 から残っている Issue

次の 2 つは段階 0 の作業から出た Issue で、開いている。どちらも段階 0 の完了条件と項目を欠かせるものではないので、足りないものには数えない。

- #119: 計画の段階 6 に、macOS と Windows の workflow の trigger の決定(`0111-cross-build`)への参照を書き足す。#120 で trigger を `workflow_dispatch` だけに戻せば、計画との違いがなくなるので、#120 の結論に合わせて書く
- #120: `0111-cross-build` の「段階 6 でこの workflow を走らせる手順」の 1 にある「GitHub が起動を断る見込み」を、run 42410444613 の結果に直し、`pull_request` の trigger と `gate` を残すかを決め直す。上の結論のとおり、外すことを勧める

## あとの段階が知っておくこと

いずれも計画が段階 0 に求めていないもので、足りないものには数えない。

- workspace の 11 個の crate は雛形で、`cargo test --workspace` が走らせるテストは 0 件である。中身とテストは、計画の段階 2 以降でそれぞれの crate を作るときに足す
- workflow `rust` は workspace だけを検査し、`rust/prototypes/` の試作 2 つはビルドしない。libghostty-vt を本番の crate に入れるときに、workflow に Zig 0.17.0 を入れる手順を足す(`0109-terminal-emulator` の「あとの段階が従うこと」)
- gpui 0.2.2 の依存のために `libc` を 0.2.189 以下に抑える必要がある。gpui を workspace に入れると、workspace のほかの crate も同じ上限で動く必要がある(`0108-gpui-prototype` の「結果」)
