# orchestrator の plan.rs と transcript は、`O_NOFOLLOW` と `O_NONBLOCK` の値を rustix から取る。orchestrator は開く関数を private な module 1 つにまとめる

- 状態: 採用
- 決めた日: 2026-11-11
- Issue: #318
- 置き換える: `0225-nonblocking-image-open` の決定 1(workspace の lock に、安全な open の口を持つ crate がない)、決定 4(`O_NONBLOCK` の値の表と `compile_error!`)、決定 6(workflow の手順 7 の定義)。0225 のほかの決定(`open_regular_file` 1 つで開いて通常のファイルかまで確かめること、`#[expect]` を文 1 つに付けること、`clippy.toml` で `custom_flags` を禁じたままにすること、2 つ目の例外は 0225 を置き換える ADR でだけ足せること、テストを `tests/codex_images.rs` に置くこと)は、そのまま有効である

## 状況

ADR `0284-report-rustix` は、orchestrator の `report.rs` が手で持っていた `O_NOFOLLOW`・`O_NONBLOCK`・`ELOOP` の値を rustix の定数に置き換え、開き方を決めた(決定 1: std の `OpenOptions` で開き、`custom_flags` には `rustix::fs::OFlags` の値を `.bits().cast_signed()` で渡す)。同じ値を写したコードが 2 か所残っていた。

- `rust/crates/orchestrator/src/plan.rs`: #250 が report.rs から写した `O_NOFOLLOW`・`O_NONBLOCK` の定数、値の表にない unix の target を止める `compile_error!`、`open_no_follow`。呼ぶのは `read_code_lines` と `read_plan` の 2 か所
- `rust/crates/transcript/src/nonblocking_open.rs`: ADR `0225-nonblocking-image-open` の決定 4 の `O_NONBLOCK` の値の表と `compile_error!`

0225 の「段階 3〜4 への申し送り」は、値の出どころが決まったら transcript の呼び出しも移すと書いている。0284 で出どころは rustix に決まった。

Issue #318 は、形を 0284 の決定 1 にすること、orchestrator では report.rs と plan.rs の `open_no_follow` を private な module 1 つにまとめること(#284 の architect `a4baf9fa` が勧めた)、transcript の manifest に rustix を足すことを決めている。この ADR は、その決定と、Issue が ADR に書くよう求めた判断(解析の crate に `build.rs` を持つ外部 crate を初めて入れること)、workflow の手順 7 の新しい定義を記録する。crate の公開の口は変えないので、architect には改めて問わなかった。

## 決定

1. **orchestrator の `src/safe_open.rs` に、`O_NOFOLLOW | O_NONBLOCK` で開く `open_no_follow` と、その失敗が symlink によるかを答える `is_symlink_loop` を置く。** module は private で(`lib.rs` の `mod safe_open;`)、関数は `pub(crate)` である。report.rs(2 つとも)と plan.rs(`open_no_follow` を 2 か所)がこれを呼ぶ。中身は 0284 の決定 1〜3 のまま移した: std の `OpenOptions` に rustix の `OFlags::NOFOLLOW | OFlags::NONBLOCK` を渡す、symlink の判定は `raw_os_error()` を `rustix::io::Errno::LOOP` と比べる、Linux と Apple 以外の unix の target を `compile_error!` で止める、unix でない target では開く前に `symlink_metadata` で symlink を断る。plan.rs は、`O_NOFOLLOW` と `O_NONBLOCK` の定数と、値のための `compile_error!` を消した。開いたファイルの `fstat` の照合は module に入れない。report.rs は `is not a regular file` と、plan.rs は `<path> is not a file` や `not a file` と、呼ぶ側ごとに違う文言で答えるため。module の名前は brief の `safe_open.rs` にした
2. **transcript の manifest に `[target.'cfg(unix)'.dependencies]` の `rustix = { workspace = true, features = ["fs"] }` を足す。** `nonblocking_open.rs` は `custom_flags(OFlags::NONBLOCK.bits().cast_signed())` で開く。`O_NONBLOCK` の定数の表と `compile_error!` は消した。transcript は `ELOOP` を見ない(symlink はたどる)ので、target を止める理由が残らない。`rustix::fs::open` は使わない(0284 の「検討した代わり」のとおり、`O_CLOEXEC` を足さないため)
3. **解析の crate(transcript)のビルドに、rustix の `build.rs` が入ることを受け入れる。** rustix の `build.rs` は、環境変数 `RUSTC`(`RUSTC_WRAPPER` があればそれ)で rustc を起動し、短いコードが compile できるかで言語の機能を試して `cargo:rustc-cfg` を出す。書くのは cargo の `OUT_DIR` の中だけで、ネットワークは使わない(ADR `0244-phase-3-dependencies` の「依存」の表)。受け入れる理由は 2 つある。今 transcript を使う crate は core だけで、core は child-process を通じてすでに rustix に依存している(`cargo tree -e features -i rustix`)ので、workspace のビルドで動く `build.rs` は増えない。あとで transcript を使い child-process を使わない crate を作ると、そのビルドでは rustix の `build.rs` が新しく動くが、それが起動するのは rustc だけである。0225 は libc の `build.rs` を理由の 1 つにして libc を退けたが、libc では得られるのが定数 1 つだけだったのに対し、rustix はすでに workspace の依存にあり、orchestrator と同じ値の出どころにできる
4. **workflow の手順 7(`Parsing crates allow their banned APIs only in tests`)の新しい定義。** 0225 の決定 6 から、次を変える。
   - 例外のファイル(`crates/transcript/src/nonblocking_open.rs`)の `custom_flags(` は 1 回だけで、その行は行頭の空白を除いて `options.custom_flags(OFlags::NONBLOCK.bits().cast_signed());` に一致する。前の `custom_flags(O_NONBLOCK)` の綴りと、`const O_NONBLOCK` の行の値の確認は消した(定数がなくなったため)
   - screen と transcript の `src/` で、コメントの行(空白のあと `//` で始まる行)を除き、語 `rustix` を書いてよいのは例外のファイルだけで、その行は行頭の空白を除いて `use rustix::fs::OFlags;` に一致する。rustix の `fs` の feature は、ファイルを開く・書く・消す関数(`rustix::fs::open`、`unlink` など)も公開する。transcript の `clippy.toml` はこれらを禁じていない(この Issue の書くパスにない)ので、手順 7 が、解析の crate が rustix から使うものを `OFlags` だけに限る。`OFlags` の値を `custom_flags` 以外で使っても、ファイルには何も起きない
   - screen と transcript は、rustix に別の名前を付けて依存してはならない(`foo = { package = "rustix", … }`、workspace の別名を通すものも含む)。別の名前で依存すると、`src/` は語 `rustix` を書かずに `foo::fs::unlink` を呼べ、前の項目の確認をすり抜けるため(codex のレビューの指摘)。手順 7 は `cargo metadata --locked --format-version 1 --no-deps` の 2 つの crate の依存のうち、package の名前が `rustix` で `rename` があるものを探し、あれば失敗する。workspace の crate(`protocol` など)の別名は、今もあり、rustix ではないので対象にしない。rustix を再び公開する別の crate に依存して使う道は、この確認の外に残る。今の 2 つの crate の依存(regex、serde、serde_json、sha2、base64、unicode-normalization、unicode-segmentation と workspace の crate)は、どれも rustix を公開しない
   - grep が探すフォルダーを読めないとき(終了コード 2)に失敗すること、ほかの lint の語の確認は、0225 のまま残す
5. **plan.rs の FIFO のテストを、plan.rs の unit テストに足す。** `read_plan` が FIFO の位置の plan に `plan_unreadable`(`not a file`)を、`read_code_lines` が FIFO を指すコードの展示に `invalid_plan`(`code.rs is not a file`)を、2 秒以内に返すことを確かめる。期待値は `server/fleet/plan.ts` の `readPlan`(`unreadable("not a file")`)と `readCodeLines`(`${path} is not a file`)から取った。`tests/plan_store.rs` はこの Issue の書くパスにないので、公開の関数を `src/plan.rs` のテストの module から呼ぶ

## 検討した代わり

- **transcript の `clippy.toml` に rustix の関数を並べて禁じる**: lint で守れるが、`disallowed-methods` は 1 つずつパスを書く必要があり、rustix の `fs` の関数は数十ある。rustix が関数を足すたびに追う必要もある。`clippy.toml` はこの Issue の書くパスにない。手順 7 で「`OFlags` の `use` 1 行だけ」と限れば、足された関数も含めて止まる
- **transcript の `open_regular_file` を orchestrator や下の crate と共有する**: transcript は symlink をたどり、orchestrator はたどらない。開いたあとの確かめも違う。共有するには、ADR `0107-crate-split` の crate の依存の向きを変えるか、新しい crate が要る。Issue は値の出どころを揃えることだけを求めている
- **2 つを別の Issue に分ける**: Issue は分けてもよいと書いている。書くパスは重ならないが、どちらも 0284 の決定 1 の形に揃える同じ変更なので、1 つの PR にした。分ければ、保護するパス(`.github/`)を書かない plan.rs の側は使う人を待たずにマージされうるが、この brief は 1 つの thread に両方を渡した
- **orchestrator の module に `fstat` の照合も入れる**: 決定 1 のとおり、呼ぶ側ごとに答えの文言が違う。Issue #318 も入れないと決めている

## 依存

新しい外部 crate はない。rustix 1.1.6 は workspace にすでにあり、入手元、ライセンス、保守の状況、`build.rs` が実行することは ADR `0244-phase-3-dependencies` の「依存」のとおり。`Cargo.lock` に新しい package は入らず、変わるのは `herdr-fleet-transcript` の `dependencies` に `"rustix"` が 1 行増えることだけである。x86_64 の Linux で transcript が新しく引き込むのは、rustix と、その依存の bitflags と linux-raw-sys である(`cargo tree -p herdr-fleet-transcript --target x86_64-unknown-linux-gnu`)。

ADR `0244-phase-3-dependencies` の表の rustix の行は、使う crate を child-process だけとしている。0284 で orchestrator(`fs`)が加わり、この ADR で transcript(`fs`)が加わった。どれも unix の target だけで使う。

## 結果

- transcript と orchestrator の `src/` に、target ごとのフラグの値を手で持つ定数はない。transcript は、値の表にない target で `compile_error!` に止められることがなくなった(Linux の x86_64 以外の target はビルドしていない)。orchestrator は 0284 のとおり、Linux と Apple 以外の unix の target を `compile_error!` で止める(`ELOOP` の確認のため)
- orchestrator の中で `O_NOFOLLOW | O_NONBLOCK` で開くときは、`safe_open::open_no_follow` を呼ぶ。別のフラグが要るときは、0284 の決定 1 の形で rustix の定数を `custom_flags` に渡す
- 解析の crate が rustix から使えるのは `OFlags` だけで、手順 7 がそれを確かめる。ほかの rustix の口が要るときは、この ADR を置き換える ADR で決める
- core に移る `server/claude-store.ts:210` と `server/pi.ts:35` の open(0225 の「段階 3〜4 への申し送り」)も、0284 の決定 1 の形にする

## 確かめたこと

2026-11-11、Linux 7.2.15-1-omarchy(x86_64)、rustc 1.99.1、`rust/` で、`HERDR_*` を外して実行した。

- plan.rs の FIFO のテストを先に足し、置き換える前の plan.rs から `O_NONBLOCK` を外して `cargo test --locked -p herdr-fleet-orchestrator --lib plan::tests` を走らせると、`turns_a_fifo_down_without_waiting_for_a_writer` が `panicked at crates/orchestrator/src/plan.rs:763:14`(`the read answers within 2 seconds`)で失敗した(2.00 秒)。戻すと通った
- 置き換えたあと、`safe_open.rs` から `OFlags::NONBLOCK` を外すと同じテストが `plan.rs:716:14` で、`OFlags::NOFOLLOW` を外すと `tests/plan_store.rs` の `is_not_read_through_a_symlink` が `:405:51` で失敗した。transcript の `OFlags::NONBLOCK` を `OFlags::empty()` にすると、`tests/codex_images.rs` の `a_fifo_with_no_writer_answers_none_at_once` と `a_symlink_to_a_fifo_answers_none_at_once` が `:72:14` で失敗した(2.00 秒)。どれも戻して通した
- 手順 7 を YAML から取り出し、screen と transcript の写しに対して `bash --noprofile --norc -eo pipefail` で走らせた。今の木では 0。次の 12 通りはそれぞれ 1: `crates/screen/src` を消す、`custom_flags` に `OFlags::TRUNC` を OR する、`custom_flags(0o4000)` にする、`OFlags::TRUNC` を `let` に入れて渡す、2 つ目の `custom_flags` を足す、例外のファイルで `rustix::fs::unlink` を呼ぶ、`use rustix::fs;` にする、`records.rs` に `use rustix::fs::OFlags;` を足す、screen の `lib.rs` に同じ行を足す、`use` の行のあとに別の `use` を続ける、例外のファイルに 2 つ目の `clippy::disallowed_methods` を足す、`records.rs` に `#[allow(clippy::disallowed_methods)]` を足す。`records.rs` に `// rustix …` のコメントの行を足した写しは 0(コメントは許す)
- 別の名前の依存の確認は、`rust/` の木で手順 7 を走らせて確かめた。今の木では 0。transcript の manifest に `fsx = { package = "rustix", … }` を足すと 1(`herdr-fleet-transcript depends on rustix as fsx`)、`rust/Cargo.toml` の `[workspace.dependencies]` に `fsy = { package = "rustix", … }` を足し、transcript が `fsy.workspace = true` で使うと 1(`… as fsy`)。どちらも `Cargo.lock` は変わらず、`--locked` の失敗ではなく、この確認で止まった。戻して 0 を見た
- 手順 6(`Parsing crates have no I/O dependencies`)を同じく取り出して走らせ、0 を見た
- `cargo check --locked -p herdr-fleet-orchestrator -p herdr-fleet-transcript --target x86_64-pc-windows-gnu` が通った(unix でない分岐)
- `cargo metadata` で更新した `Cargo.lock` の差分は、`herdr-fleet-transcript` の `dependencies` の `"rustix"` の 1 行だけだった
- `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace`(73 の test binary、796 件、失敗 0)が通った
