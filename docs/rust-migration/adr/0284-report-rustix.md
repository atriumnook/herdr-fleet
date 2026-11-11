# orchestrator の report.rs は、std の `OpenOptions` に rustix の `O_NOFOLLOW` と `O_NONBLOCK` を渡して report.json を開く

- 状態: 採用
- 決めた日: 2026-11-10
- Issue: #284

## 状況

`rust/crates/orchestrator/src/report.rs` は、`report.json` を TypeScript の `server/fleet/report.ts:21` と同じく `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` で開く。symlink をたどらず(`ELOOP` で失敗する)、書き手のいない FIFO でも開くのを待たないためである。#249(PR #278)は crate の manifest を書けなかったので、std が公開していない `O_NOFOLLOW` と `O_NONBLOCK`、エラー番号の `ELOOP` の値を、Linux の x86_64・aarch64 と Apple の target ごとに libc 0.2.191 から写して定数にし、表にない unix の target を `compile_error!` で止めていた。#249 のレビュー C3 は、この値の保守を workspace の依存にすでにある rustix(1.1.6、ADR `0244-phase-3-dependencies`)に任せるよう求めた。

ADR `0225-nonblocking-image-open` の「段階 3〜4 への申し送り」は、core か orchestrator で最初にこれらのフラグを要した作業の ADR が、値の出どころを 1 つに決めると書いている。この Issue がそれに当たる。

開き方と依存は architect(fleet の `a4baf9fa`)に問い、その答えに従った。

## 決定

1. **開くのは std の `OpenOptions` のまま、std が公開していないフラグの値だけを rustix から取る。** `OpenOptions::new().read(true).custom_flags((OFlags::NOFOLLOW | OFlags::NONBLOCK).bits().cast_signed())` で開く。`O_CLOEXEC` は std が必ず付け、アクセスモードは `read(true)` が決める。`bits()` の型は、Linux の linux_raw のバックエンドでは `c_uint`、Apple などの libc のバックエンドでは `u32` で、`cast_signed()`(Rust 1.87 で安定)はビットを変えずに `i32` にする
2. **symlink の判定は、open のエラーの `raw_os_error()` を `rustix::io::Errno::LOOP.raw_os_error()` と比べる。** std の `io::ErrorKind::FilesystemLoop` は、workspace の Rust 1.99.1 では不安定の機能(`io_error_more`)で使えない。エラーと文言の対応は変えない: `NotFound` は `is missing`、`ELOOP` は `is not a regular file`、それ以外は `cannot be read`(report.ts:21-23 と同じ)
3. **手で持っていた `O_NOFOLLOW`・`O_NONBLOCK`・`ELOOP` の定数を消し、`compile_error!` は Linux と Apple 以外の unix の target だけを止める形に狭める。** フラグの値は rustix が target ごとに持つので、Linux の arch を x86_64 と aarch64 に限る理由はなくなった。一方、`O_NOFOLLOW` で symlink を開いたときのエラー番号は OS ごとに違う。Linux と Apple の open(2) は `ELOOP` を返すと説明しているが、FreeBSD の open(2) は `EMLINK` を返すと説明している(確かめていない)。そのような target では、symlink の `report.json` が `is not a regular file` ではなく `cannot be read` になる。前の `compile_error!` は、新しい target を足す人にこの確認を求めていたので、その役目を残す(`/code-review high` の指摘)。unix でない target の分岐(開く前に `symlink_metadata` で symlink を断る処理と `SymlinkRefused`)はそのまま残す。rustix の `fs` は Windows にないため
4. **`rust/crates/orchestrator/Cargo.toml` に `[target.'cfg(unix)'.dependencies]` の `rustix = { workspace = true, features = ["fs"] }` を足す。** feature は `fs` だけを書く。使うのは `rustix::fs::OFlags`(`fs` が要る)、`OFlags::bits`、`rustix::io::Errno::LOOP` と `raw_os_error`(`rustix::io` は feature なしで使える)で、`std` を要る項目はない(「確かめたこと」の単独の crate で確かめた)。ADR `0244-phase-3-dependencies` のとおり、crate は自分が使う feature だけを書く。`rust/Cargo.toml` は変えない
5. **FIFO のテストに 2 秒の上限を付ける。** `O_NONBLOCK` を付け忘れると、上限のないテストは失敗せずに止まる。transcript の `tests/codex_images.rs` と同じく、別のスレッドで `read_report` を呼び、`recv_timeout` で待つ。期待値は変えない
6. **`src/plan.rs` の同じ定数と、transcript の `O_NONBLOCK` は、別の Issue(#318)で移す。** どちらもこの Issue の書くパスにない。plan.rs の `open_no_follow` は #250(PR #287)が report.rs から写したもので、Issue #284 のコメントは plan.rs も含めるよう求めている。transcript を移すには、ADR `0225-nonblocking-image-open` の決定 1・4・6(lock に rustix がないこと、定数の表、CI の手順 7 が確かめる綴り)を置き換える ADR が要る。どちらも決定 1 の形にすれば、`custom_flags` に渡す値を rustix の定数にするだけで済む

この ADR は、ADR `0244-phase-3-dependencies` の決定を置き換えずに補う。ADR の README のとおり 0244 は書き換えないので、0244 の表の rustix の行は使う crate を child-process(`process`、`std`)だけとしているが、rustix を使う crate は child-process と orchestrator(`fs`)の 2 つである。どちらも unix の target だけで使う。

## 検討した代わり

- **`rustix::fs::open(path, OFlags::RDONLY | NOFOLLOW | NONBLOCK | CLOEXEC, Mode::empty())` で開き、`File::from(OwnedFd)` にする**: フラグを整数にせずに済む。しかし rustix の `open` は `O_CLOEXEC` を足さない(linux_raw の `open` が足すのは `O_LARGEFILE` だけ。rustix 1.1.6 の `src/backend/linux_raw/fs/syscalls.rs:55-57`)。書き忘れると、orchestrator が起動する子プロセス(エージェントの CLI、gh、git)に fd が漏れ、それを `read_report` を通すテストでは見つけられない(architect の試作で、`CLOEXEC` を外しても 9 件すべてが通った)。workspace にファイルを開く 2 つ目の方法が入り、`OFlags` は `TRUNC` や `CREATE` も渡せるので、ADR `0225-nonblocking-image-open` の「読むためだけに開く」を守るには `rustix::fs::open` も clippy で禁じる必要が出る。`&Path` を渡すのと `Errno` を `io::Error` にするのに `std` の feature も要る
- **libc を直接の依存にする**: 定数は取れるが、libc の `open` は `unsafe` が要り、workspace は `unsafe_code = "forbid"`(ADR `0107-crate-split`)なので、得られるのは定数だけである。rustix はすでに workspace の依存にある
- **`O_NOCTTY` も付ける**: report.ts も std も付けない。違いが出るのは、`report.json` の位置に端末のデバイスがあり、サーバーが制御端末のない session leader のときだけで、テストで確かめられない。TypeScript と同じにする
- **plan.rs も同じ PR で移し、2 つの `open_no_follow` を orchestrator の private な module 1 つにまとめる**: architect はこれを勧めた。この Issue の書くパスに `src/plan.rs` と `src/lib.rs` がないため、別の Issue にした(決定 6)

## 依存

新しい外部 crate はない。rustix 1.1.6 は workspace にすでにあり、入手元、ライセンス、保守の状況、`build.rs` が実行することは ADR `0244-phase-3-dependencies` の「依存」のとおり。`Cargo.lock` に新しい package は入らず、変わるのは `herdr-fleet-orchestrator` の `dependencies` に `"rustix"` が 1 行増えることだけである。rustix の target ごとの依存(Linux の linux-raw-sys、Apple などの libc と errno)は、child-process が rustix を使うので、すでに lock にある。

## 結果

- フラグとエラー番号の値は rustix が target ごとに持つ。Linux はどの arch でも orchestrator をビルドできるようになる。Linux と Apple 以外の unix の target は、前と同じく `compile_error!` で止まる。その target を対象にするときは、open(2) が `O_NOFOLLOW` の symlink に返すエラーを確かめ、`is_symlink_loop` に教える
- unix でない target(Windows)の orchestrator は rustix に依存しない
- orchestrator の中で、ほかに `O_NOFOLLOW` や `O_NONBLOCK` を要る open は、決定 1 の形で rustix の定数を `custom_flags` に渡す。`rustix::fs::open` は使わない

## 確かめたこと

2026-11-10、Linux 7.2.15(x86_64)、rustc 1.99.1、`rust/` で、`HERDR_*` を外して実行した。

- 上限付きの FIFO のテストを先に書き、置き換える前のコードから `O_NONBLOCK` を外して `cargo test --locked -p herdr-fleet-orchestrator --test report` を走らせると、`is_no_report_from_a_folder_or_a_fifo` が `panicked at crates/orchestrator/tests/report.rs:264:10: read_report answers within 2 seconds: Timeout` で失敗した(2.00 秒)
- 置き換えたあとの report のテストは 9 件が通った。置き換えたコードから `OFlags::NOFOLLOW` を外すと `is_never_read_through_a_symlink` が `tests/report.rs:150:5` で、`OFlags::NONBLOCK` を外すと FIFO のテストが `:264:10` で、`Errno::LOOP` を `Errno::NOENT` に変えると symlink のテストが `:150:5` で失敗した
- `cargo check --locked -p herdr-fleet-orchestrator --target x86_64-pc-windows-gnu` が通った(unix でない分岐)
- rustix 1.1.6 を `default-features = false, features = ["fs"]` だけで使う使い捨ての crate(scratchpad に置き、`Cargo.lock` は workspace のものを写した)で、`(OFlags::NOFOLLOW | OFlags::NONBLOCK).bits().cast_signed()` と `Errno::LOOP.raw_os_error()` がコンパイルできることを見た。`cargo tree -e features -i rustix` で、有効な feature が `fs` だけであることも見た。値は `0o404000`(消した x86_64 の定数 `0x20000 | 0o4000` と同じ)と 40 だった
- `cargo metadata` で更新した `Cargo.lock` の差分は、`herdr-fleet-orchestrator` の `dependencies` の `"rustix"` の 1 行だけだった
- architect の試作で、開いた fd のフラグ(`/proc/self/fdinfo` の `flags:`)が `02504000`(`O_CLOEXEC | O_NOFOLLOW | O_LARGEFILE | O_NONBLOCK`)であり、symlink を開いたエラーの `raw_os_error()` が `Some(40)`、`Errno::LOOP.raw_os_error()` が 40 であることを見た
- Apple の target はこの PC に入っていないのでビルドしていない。rustix の libc のバックエンドが libc の `O_NOFOLLOW`・`O_NONBLOCK`・`ELOOP` をそのまま使うことを、rustix 1.1.6 のソース(`src/backend/libc/fs/types.rs:284` と `:287`、`src/backend/libc/io/errno.rs:527`)で読んだ。消した定数も同じ libc から写したものである
- `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace`(665 件)が通った
