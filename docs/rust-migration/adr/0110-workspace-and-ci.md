# Cargo workspace、Rust の版、Linux の workflow

- 状態: 採用
- 決めた日: 2026-11-08
- Issue: #110

## 状況

段階 0(`docs/rust-migration/plan.md`)の土台として、`rust/` の Cargo workspace、Rust の版の固定、push と PR ごとに検査を走らせる Linux の workflow が要る。決める必要があったのは次のこと。

- workspace の形と、crate の雛形の書き方。crate の名前・責務・依存は `0107-crate-split` が決めている
- 固定する Rust の版。Issue #110 は「作業の時点の最新の stable」を求める
- workflow がいつ、どの runner で、何を走らせるか。どの action を使い、どう固定するか
- `0107-crate-split` が #110 に任せた、解析の crate(screen と transcript)の決まりの検査(clippy.toml と `cargo tree`)

前提と制約:

- `rust/prototypes/` の試作(`gpui-window`、`terminal-vt`)は、それぞれの `Cargo.toml` に空の `[workspace]` を持ち、この workspace に入らない(`0108-gpui-prototype`、`0109-terminal-emulator`)。`rust/rust-toolchain.toml` は、試作のフォルダーで実行する cargo にも当たる
- 決まり(`.herdr-fleet/standing.md`)により、リポジトリの設定と Actions の設定は変えない。macOS と Windows の workflow は段階 6 で、手動でだけ走らせる(計画の段階 6)
- この時点で、workspace は外部の crate に依存しない(`0107-crate-split` の「依存」)

## 決定

### workspace

- `rust/Cargo.toml` は仮想 workspace(`[package]` を持たない)で、`members = ["crates/*"]`、`resolver = "3"`
- `[workspace.package]` に、すべての crate で同じ値を置く: `version = "0.0.0"`、`edition = "2024"`、`license = "MIT"`(リポジトリの `LICENSE` と同じ)、`publish = false`。各 crate は `version.workspace = true` のように受け継ぐ
- `rust-version` は書かない。使う版は `rust-toolchain.toml` が決めており、crate は公開しない(`publish = false`)ので、別に MSRV を宣言する理由がない。2 か所に同じ版を書くと、片方だけを変えた PR を CI が見つけられない
- `[workspace.dependencies]` に、`0107-crate-split` の別名(`screen = { package = "herdr-fleet-screen", path = "crates/screen" }` など)を置く。core の別名は置かない(Rust の組み込みの `core` crate を隠すため。core に依存する crate もない)。各 crate は `protocol.workspace = true` のように別名で依存する
- `[workspace.lints.rust]` に `unsafe_code = "forbid"` を置き、herdr-fleet-vt を除くすべての crate が `[lints] workspace = true` で受け継ぐ。`0107-crate-split` は `unsafe` を herdr-fleet-vt に閉じ込めると決めており、ほかの crate で `unsafe` を書くとコンパイルが失敗する。herdr-fleet-vt の `Cargo.toml` には、受け継がない理由をコメントで書いた
- 各 crate は `rust/crates/<部分>/` にあり、`src/lib.rs`(bin だけの crate は `src/main.rs`)の 1 行目のコメントが `0107-crate-split` の表の責務の文をそのまま写す。bin の名前は `0107-crate-split` のとおり: herdr-fleet-core は lib と bin `herdr-fleet`、herdr-fleet-cli は bin `fleet`、herdr-fleet-desktop は bin `herdr-fleet-desktop`
- herdr-fleet-vt は空の雛形にする。`0109-terminal-emulator` は libghostty-vt の採用を決めたが、バインディングを crate に移すのは #110 の範囲外である
- `rust/.gitignore` は `target/` と `.dev-state/`(決まりの隔離した state フォルダーの置き場所)を無視する
- `rust/Cargo.lock` はリポジトリに入れる。workspace は実行ファイルを作り、CI は `--locked` で、入れた lock のとおりにビルドする

### Rust の版

- `rust/rust-toolchain.toml` は `channel = "1.99.1"`、`components = ["rustfmt", "clippy"]`、`profile = "minimal"`
- 1.99.1 は、2026-11-08 に `https://static.rust-lang.org/dist/channel-rust-stable.toml` が stable として返した版である(`version = "1.99.1 (58cf8f9c3 2026-10-13)"`、`date = "2026-10-15"`)。Issue #110 が作業の時点の最新の stable を求めているので、これを選んだ。edition 2024 は 1.85 以上を求めるので、1.99.1 で足りる
- `profile = "minimal"` は rustc、cargo、rust-std だけを入れ、`components` で rustfmt と clippy を足す。CI が使わない rust-docs を取得しないため
- 版を上げるときは、`rust/rust-toolchain.toml` の `channel` を変え、この ADR を置き換える ADR を書く
- 試作が別の版を求める場合は、試作のフォルダーに自分の `rust-toolchain.toml` を置く(Issue #110 の注意)。2026-11-08 の時点では、2 つの試作とも 1.99.1 でビルドとテストが通る(「確かめたこと」)ので、どちらにも置かない

### workflow(`.github/workflows/rust.yml`)

- きっかけ: `rust` への push と、base が `rust` のすべての pull request。`paths` で絞らない(どの PR にも検査が付くように)
- `permissions: contents: read`。runner は `ubuntu-24.04`。`ubuntu-latest` は GitHub が指す先を変えるので、OS の版を固定する
- 同じ pull request に新しい push があると、前の run を取り消す(`concurrency` の `cancel-in-progress` は pull request のときだけ真)。`rust` への push の run は取り消さず、マージごとに結果を残す
- 手順は `shell: bash`(`bash --noprofile --norc -eo pipefail`)で走らせる。既定の shell は `pipefail` を持たず、パイプの前のコマンドの失敗を見逃す
- 手順は、作業フォルダー `rust/` で次の順に走らせる
  1. `actions/checkout`(`persist-credentials: false`。後の手順は GitHub の資格を使わない)
  2. `rustup toolchain install --no-self-update`。runner に入っている rustup が `rust-toolchain.toml` の版と components を入れる
  3. `cargo fmt --check`
  4. `cargo clippy --locked --workspace --all-targets -- -D warnings`
  5. `cargo test --locked --workspace`
  6. 解析の crate の依存の検査: `cargo tree --workspace -e normal --no-dedupe` で、herdr-fleet-screen と herdr-fleet-transcript を根とする木に、herdr-fleet-herdr、herdr-fleet-child-process、tokio、axum、hyper、reqwest が出たら失敗する(`0107-crate-split` の「解析の crate の決まり」)。package の名前を行全体で比べるので、herdr-fleet-herdr-api は当たらない。`cargo tree` 自体が失敗したときと、2 つの crate が木の根に見つからないとき(名前を変えたときなど)も失敗する
    - `0107-crate-split` が書いたコマンドは crate ごとの `cargo tree -p <crate> -e normal` だが、それでは crate ごとに feature を解決する。workspace の別の crate が共有の依存(protocol など)の optional な依存を feature で有効にすると、上の clippy、test のビルドにはその依存が入るのに、`-p` の木には出ない(「確かめたこと」で再現した)。そこで、ビルドと同じく workspace 全体で解決した木を見る。見る範囲(通常の依存)と禁じる名前は `0107-crate-split` のまま
  7. screen と transcript の `src/` に `clippy::disallowed_methods`、`clippy::disallowed_types`、`clippy::style`、`clippy::all` の語があれば失敗する(下の「テストでの扱い」)
- 使う action は `actions/checkout` だけで、コミットの SHA `3d3c42e5aac5ba805825da76410c181273ba90b1`(タグ v7.0.1)で固定する。Rust の導入にも cache にも action を使わない
- `timeout-minutes: 30`。今の検査は 1 分かからないので、止まった run が Actions の時間を使い続けないための上限である
- cache は置かない。外部の crate がなく、ビルドは数秒で終わる。外部の crate を足す ADR が、要るなら cache を決める

### 解析の crate の clippy.toml

- `rust/crates/screen/clippy.toml` は、`std::fs`、`std::process`、`std::net`、`std::os::unix::net`、`std::os::unix::fs` の型と関数と、ファイルシステムを見る `std::path::Path` のメソッド(`exists`、`is_file`、`metadata`、`read_dir` など)、`OpenOptionsExt` の `custom_flags` と `mode`、名前解決をする `ToSocketAddrs::to_socket_addrs`、`std::process::id` を `disallowed-types` と `disallowed-methods` に並べる
- `rust/crates/transcript/clippy.toml` は、ファイルを書く関数(`std::fs::write`、`File::create`、`OpenOptions::write`、`std::os::unix::fs::chown` など)、フラグで書き込みや切り詰めを指定できる `OpenOptionsExt::custom_flags` と `mode`、`std::process`、`std::net`、`std::os::unix::net`、`ToSocketAddrs::to_socket_addrs` を並べる。読み取り(`File::open`、`std::fs::read`、`metadata`、`read_dir`)は禁じない
- clippy は、検査する crate のフォルダー(`CARGO_MANIFEST_DIR`)から上へ clippy.toml を探すので、2 つのファイルはその crate にだけ当たる。CI は clippy を `-D warnings` で走らせるので、禁じた型や関数を使うと失敗する。`0107-crate-split` が代わりとして挙げたソースの grep は使わない(clippy が crate ごとの clippy.toml を読むことを確かめたため)
- clippy.toml は禁じる API を 1 つずつ並べたもので、並べていない API は止まらない。新しい API が見つかったら一覧に足す
- clippy.toml が見るのは、その crate のソースだけである。依存する crate(protocol)の中の I/O は、上の `cargo tree` の検査も含めて見ない

### テストでの扱い

`0107-crate-split` は、screen のテストが画面の corpus(`fixtures/screens/`)を、transcript のテストが会話ログの corpus と一時ファイルを使うと決めている。clippy は `--all-targets` でテストのコードも検査し、`disallowed-methods` にはテストだけを外す設定がない。そこで次のようにする。

- ファイルを読み書きするテストは、crate の `tests/` に置き、そのファイルの先頭に `#![allow(clippy::disallowed_methods, clippy::disallowed_types)]` を書く。allow はそのファイルにだけ当たる
- `src/`(`#[cfg(test)]` の module を含む)には、これらの lint を外す属性を書かない。上の workflow の手順 7 が、`src/` にその語があれば失敗する。`tests/` のテストは crate の公開した関数だけを呼ぶので、corpus のテストは公開した解析の関数を通る

## 検討した代わり

- `dtolnay/rust-toolchain` などの action で Rust を入れる: runner の rustup と `rust-toolchain.toml` で同じことができ、第三者の action を増やさずに済む
- `Swatinem/rust-cache` で cache する: 今はビルドが数秒で、cache が節約する時間がない。第三者の action を増やす
- `channel = "stable"` などの版の名前で固定する: Issue #110 が正確な版番号を求めている。stable は 6 週間ごとに変わり、新しい clippy の lint で、コードを変えていない PR が赤になる
- `ubuntu-latest`: 上に書いたとおり、OS の版が知らないうちに変わる
- workflow を `paths: rust/**` で絞る: Issue #110 が、どの PR にも検査が付くことを求めている
- `cargo tree` の検査に build-dependencies を含める(`-e normal,build`)、禁じる名前を足す(ureq、async-std など): 検査のコマンドと名前の一覧は `0107-crate-split` が決めている。広げるときは、`0107-crate-split` を置き換える ADR で決める
- テストの corpus を `include_str!` で埋め込み、テストでも clippy.toml を外さない: transcript のテストは一時ファイルを書く必要があり、埋め込みでは足りない
- 試作を workspace に入れる、または CI で試作をビルドする: 試作は自分の版の固定と依存(GPUI、Zig)を持つ使い捨てのコードで、`0108-gpui-prototype` と `0109-terminal-emulator` が workspace の外に置くと決めている

## 依存

| 名前 | 版 | 入手元 | ライセンス | 保守の状況 | `build.rs` |
|---|---|---|---|---|---|
| Rust(rustc、cargo、rustfmt、clippy) | 1.99.1 | rustup が `static.rust-lang.org` から取得する | MIT または Apache-2.0 | Rust プロジェクトが 6 週間ごとに stable を出している | なし |
| `actions/checkout` | v7.0.1(コミット `3d3c42e5aac5ba805825da76410c181273ba90b1`、2026-07-20 公開) | GitHub(`github.com/actions/checkout`) | MIT | GitHub が保守している。2026-10-17 にも push があり、archive されていない | なし |

crate は足さない。

## 結果

- 段階 1 以降の Issue は、`rust/crates/<部分>/` の雛形にコードを足す。crate を足すか分け直すときは、`0107-crate-split` を置き換える ADR を書く
- `rust` への push と base `rust` のすべての PR に、workflow `rust` の job `linux` が付く。fmt、clippy の警告、テストの失敗、解析の crate の禁じた依存のどれかがあると赤になる
- herdr-fleet-vt 以外の crate では `unsafe` を書けない
- screen で `std::fs`・`std::process`・`std::net` を、transcript でファイルの書き込み・`std::process`・`std::net` を使うと、clippy が失敗する
- workflow は試作をビルドしない。試作が 1.99.1 で壊れても CI は気づかない
- clippy と rustfmt の版は 1.99.1 に固定され、版を上げる PR でだけ変わる

## 確かめたこと

2026-11-08、Linux 7.2.15-1-omarchy(Arch Linux 系の Omarchy)、rustup 1.29.3、Rust 1.99.1 で確かめた。

- `rust/` で `cargo fmt --check`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --workspace` が通った(テストは 0 件)。`rustc --version` は `rustc 1.99.1 (58cf8f9c3 2026-10-13)` で、`rust-toolchain.toml` の版が使われた
- `cargo metadata --format-version 1 --no-deps` の package の名前、target の種類と bin の名前、通常の依存を、`0107-crate-split` の表と python で比べた。結果は `adr crates: 11 cargo packages: 11 same names: True`、`mismatches: 0`
- 各 crate の `lib.rs`(または `main.rs`)の 1 行目が、`0107-crate-split` の表の責務の文と一致することを python で比べた。結果は `mismatches: 0`
- clippy が clippy.toml の設定に従って error を出すことを、わざと違反させて確かめた(確かめたあと元に戻した)。screen に `fs::read_to_string`、`process::Command::new`、`net::TcpStream::connect` を、transcript に `fs::write`、`OpenOptions::new().append(true)`、`File::create` と、読み取りの `fs::read_to_string` を書いた。clippy は禁じた 6 か所をすべて `use of a disallowed method` / `use of a disallowed type` の error にし、transcript の読み取りは通した。`use std::{fs, net, process};` の形で import しても当たった。レビューで漏れを指摘された `Path::exists`、`Path::read_dir`、`Path::is_file` も、足したあとに同じように error になった。レビューで指摘された `OpenOptions::new().read(true).custom_flags(0x200)`(Linux の `O_TRUNC`)、`("example.com", 443).to_socket_addrs()`、`std::process::id()`、`std::os::unix::fs::chown` も、足したあとは screen と transcript の両方で error になった
- workspace 全体で解決する理由を再現した: 一時的に protocol に optional な依存 herdr を足し、core から feature `herdr` で有効にすると、crate ごとの `cargo tree -p` の検査は終了コード 0 で通り、workspace 全体の検査は `herdr-fleet-screen -> herdr-fleet-herdr` と `herdr-fleet-transcript -> herdr-fleet-herdr` を出して 1 で失敗した。元に戻すと 0。screen の名前を一致しないものにすると `herdr-fleet-screen is not a member of the workspace` で 1(確かめたあと元に戻した)
- `tests/` のテストの扱い: screen の `tests/` に、先頭に allow を書いたファイル(`std::fs::read_to_string`、`File::open`、`create_dir_all` を呼ぶ)を置くと clippy が通り、allow を消すと 3 か所が error になった(確かめたあと消した)
- workflow の手順 6 と 7 を、YAML から取り出して `bash --noprofile --norc -eo pipefail` で走らせた。crate ごとの `cargo tree` だった手順 6 の版は、そのままでは終了コード 0、package の名前を存在しないものにすると 101、禁じる名前に herdr-fleet-protocol を足すと 1。手順 7 は、そのままでは 0、transcript の `lib.rs` に `#![allow(clippy::disallowed_methods)]` を足すと 1
- `cargo tree -p herdr-fleet-screen -e normal` は herdr-fleet-herdr-api、herdr-fleet-protocol、herdr-fleet-screen だけを、transcript は herdr-fleet-herdr-api、herdr-fleet-protocol、herdr-fleet-transcript だけを出した
- 試作が 1.99.1 で通ることを確かめた。`rust/prototypes/gpui-window` で `cargo +1.99.1 check --locked` が通った(警告は依存の proc-macro-error2 2.0.1 の future-incompat の通知だけ)。`rust/prototypes/terminal-vt` は、`origin/rust` の `3ca35c2` から `git archive` で一時フォルダーに取り出し、`ZIG` に Zig 0.17.0 を渡して `cargo +1.99.1 test --locked` を走らせ、4 つのテストの binary の 7 件がすべて通った
- workflow が違反を見つけることを、PR の途中のコミットで確かめた。わざと `cargo fmt --check` に違反させたコミットの run が赤、元に戻したコミットの run が緑になった。赤の run は https://github.com/atriumnook/herdr-fleet/actions/runs/42406636289(`cargo fmt --check` が `Diff in .../rust/crates/herdr-api/src/lib.rs` を出して終了コード 1)、緑の run は https://github.com/atriumnook/herdr-fleet/actions/runs/42406707544 。runner の rustup は `rust-toolchain.toml` から 1.99.1 を入れた(`rustc 1.99.1 (58cf8f9c3 2026-10-13)`)
