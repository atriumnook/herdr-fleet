# transcript は Codex のローカルの画像を、`O_NONBLOCK` だけを渡して開き、通常のファイルかまで確かめる 1 つの関数で開く。CI はその 1 ファイルにだけ `disallowed_methods` の expect を許す

- 状態: 採用
- 決めた日: 2026-11-09
- Issue: #225
- 置き換える: `0110-workspace-and-ci` の「テストでの扱い」の 2 つ目の項目(`src/` に lint を外す属性を書かない)と、workflow の手順 7 の定義。どちらも、transcript の `src/nonblocking_open.rs` の 1 ファイルを例外にする形に変える。0110 のほかの決定(`clippy.toml` の中身と `custom_flags` の禁止、`tests/` のファイルの先頭の allow、手順 1〜6)は、そのまま有効である

## 状況

`rust/crates/transcript/src/codex/images.rs` は、Codex のユーザーが貼ったローカルの画像を開く。PR #222 の版は、`std::fs::metadata` で通常のファイルかを確かめてから `File::open` で開いていた。確かめてから開くまでの間に、別のプロセスが同じパスを書き手のいない FIFO に置き換えると、`File::open` は書き手が現れるまで戻らず、`Transcripts::image` を呼んだスレッドが解放されない(Issue #225 の「再現」)。

TypeScript は `O_RDONLY | O_NONBLOCK` で開き、開いた fd が通常のファイルかを `fstat` で確かめる(`server/codex-images.ts:61-64`)。`0196-transcript-interface` の「T3 への申し送り」も、この停止を避けるよう求めている。

Rust で同じことをするには、`OpenOptionsExt::custom_flags` にフラグを渡す。次の 3 つがこれを止めていた。

- transcript の `clippy.toml` は `custom_flags` を `disallowed-methods` に並べている。`O_TRUNC` のようなフラグを渡せば、読むためだけでない open ができてしまうため(`0107-crate-split`、`0110-workspace-and-ci`)
- `0110-workspace-and-ci` の workflow の手順 7 は、screen と transcript の `src/` に `clippy::disallowed_methods` の語があれば失敗する
- std は `O_NONBLOCK` の値を公開していない

Issue #225 の coordinator の判断は、まず workspace の依存にすでにある crate の口(選択肢 2)を調べ、使えなければ推奨の選択肢 1 を採る、だった。形は architect(fleet の `6f4aa645`)に問い、その答えに従った。

## 決定

1. **workspace の既存の crate には、使える口がない(選択肢 2 は採れない)。** `cargo tree -i libc --workspace --target all -e all` によると、`Cargo.lock` にある libc 0.2.191 は `sha2` → `cpufeatures` からだけ引き込まれ、x86_64 の Linux の build には入らない(`0193-phase-2-dependencies`)。libc の `open` は FFI の関数で `unsafe` が要り、workspace は `unsafe_code = "forbid"` を設けている(`0107-crate-split`)。libc から使えるのは定数の `O_NONBLOCK` だけになる。rustix や nix のような、安全な open の口を持つ crate は lock にない
2. **非ブロッキングで開いて通常のファイルかまで確かめる関数を、transcript の private な module `src/nonblocking_open.rs` に 1 つだけ置く。** `pub(crate) fn open_regular_file(path: &Path) -> io::Result<(File, Metadata)>` は、`OpenOptions::new().read(true).custom_flags(O_NONBLOCK)` で開き、開いた fd の `metadata`(`fstat`)が通常のファイルでなければ `InvalidInput` を返す。フラグは引数に取らないので、呼ぶ側はほかのフラグを渡せない。確かめるところまでを関数に持たせるのは、非ブロッキングの fd が通常のファイルのときだけ module の外に出るようにするためである。確かめを呼ぶ側に任せると、2 つ目の呼ぶ側が確かめを忘れたとき、FIFO を `O_NONBLOCK` のまま読み、空のファイルと区別できない答え(0 バイトか `WouldBlock`)を受け取る。symlink はたどる(TypeScript と同じ)。unix でない target では `File::open` で開く(パスの open が FIFO の書き手を待つことがないため。Windows では確かめていない)
3. **`custom_flags` を呼ぶ内側の関数 1 つにだけ、理由付きの `#[expect(clippy::disallowed_methods, reason = …)]` を付ける。** `#[allow]` ではなく `#[expect]` にするのは、`custom_flags` の呼び出しを消したのに例外だけが残ることを防ぐためである。抑える警告が出なくなると、clippy は `this lint expectation is unfulfilled` を出し、`-D warnings` で失敗する
4. **`O_NONBLOCK` の値は、その module の private な定数に、計画が挙げる OS(Linux・macOS・Windows)のうち値が要る target だけを名指しで書く。** 表にない unix の target では `compile_error!` でビルドを止める。

   | target | 値 | 出どころ(libc 0.2.191) |
   |---|---|---|
   | Linux の x86_64 | 0o4000(2048) | `src/unix/linux_like/linux/gnu/b64/x86_64/mod.rs:294` |
   | Linux の aarch64 | 0o4000(2048) | `src/unix/linux_like/linux/gnu/b64/aarch64/mod.rs:206` |
   | Apple(`target_vendor = "apple"`) | 0x4 | `src/unix/bsd/mod.rs:275` |

   表にない target に別の動作を用意しないのは、誤った値が、読み取り専用で開いてもファイルを壊しうるためである。x86_64 の Linux の `O_TRUNC` は 0o1000、BSD と Apple は 0x400 で、std の `custom_flags` が外すのはアクセスモードのビット(`O_ACCMODE`)だけである。`File::open` に戻す案は、その target で FIFO で止まる不具合を戻し、テストのない 2 つ目の動作を持つことになる。CI がビルドしてテストするのは x86_64 の Linux だけで、aarch64 の Linux と Apple の行、unix でない分岐は、段階 6 までどの workflow もコンパイルしない
5. **`images.rs` は、開く前のパスの確かめを外し、`open_regular_file` で開き、8 MiB の上限だけを確かめる。** 開く前の確かめを残すと、FIFO のテストはその確かめが `None` を返すことで通り、`O_NONBLOCK` の open を一度も通らない。これで `0196-transcript-interface` の「T3 への申し送り」を解いた
6. **workflow の手順 7 の新しい定義:** screen と transcript の `src/` で、`clippy::disallowed_methods`、`clippy::disallowed_types`、`clippy::style`、`clippy::all` の語を書いてよいのは `crates/transcript/src/nonblocking_open.rs` だけである。そのファイルでも、`clippy::disallowed_types`、`clippy::style`、`clippy::all` の語はなく、`clippy::disallowed_methods` の語は 1 回だけ、`custom_flags(` は 1 回だけで、それは `custom_flags(O_NONBLOCK)` の綴りである。grep が探すフォルダーを読めないとき(終了コード 2)も失敗する。この最後の点は、0110 の手順 7 にもあった穴を塞ぐ。0110 の版は、`crates/screen/src` がないと grep の終了コード 2 を `if` が偽として扱い、一致があっても通っていた(architect が確かめた)。綴りの確認は、呼び出しに別のビットを OR する変更は捕まえるが、定数の値を変える変更は捕まえない。値を確かめるのは x86_64 の Linux のテストだけである(値を 0 にすれば FIFO のテストが止まり、`O_TRUNC` にすれば画像のテストでファイルが空になる)
7. **`clippy.toml` は `custom_flags` を禁じたままにし、理由に例外のファイルを書き足す。** ほかのファイルで `custom_flags` を使えば、clippy が今までどおり error にする
8. **2 つ目の例外は、この ADR を置き換える ADR でだけ足せる。**
9. **FIFO・ディレクトリ・symlink・8 MiB の境目のテストは `tests/codex_images.rs` に置き、公開の `Transcripts::image` を通して確かめる。** FIFO を作るのに `mkfifo` のプロセス(`std::process::Command`)が、ファイルを作るのに書き込みが要り、`0110-workspace-and-ci` はこれらを `tests/` でだけ許すため。std には `mkfifo` がない。`/proc/self/fd/<n>` で無名の pipe を開く方法は、Linux の `fifo_open` が pipefs の inode では書き手を待たない(`is_pipe`)ので、止まる状況を作れない。テストは 1 件ごとに一時フォルダーを作り、終わると消す

### 開くときのフラグと、ADR 0107 の「読むだけ」

アクセスモードは `.read(true)` が決め、std は `custom_flags` からアクセスモードのビットを外す。開くフラグは `O_RDONLY | O_NONBLOCK | O_CLOEXEC`(LD_PRELOAD の probe が見た `flags=0x80800`)で、何も書かない。返すファイルには `O_NONBLOCK` が付いたままになる。Linux の `open(2)` は、このフラグが通常のファイルには効かないと説明しており、TypeScript も付けたまま読む。8 MiB の画像のテストは、付けたまま全体を読み戻せることを確かめる。

### 段階 3〜4 への申し送り

TypeScript は、core に移るファイル(`server/claude-store.ts:210`、`server/pi.ts:35`)と orchestrator に移るファイル(`server/fleet/orchestrator.ts:1644`、`server/fleet/plan.ts:55` と `:121`)でも `O_NONBLOCK` で開き、`claude-store.ts`、`orchestrator.ts`、`plan.ts` は `O_NOFOLLOW` も付ける。core と orchestrator には `custom_flags` の禁止がないが、この表を写さない。最初にそれを要した作業の ADR が、値の出どころを 1 つに決める(libc を依存にするか、この関数を下の crate に移すか)。決めたら、transcript の呼び出しも移す(expand → migrate → contract)。

## 検討した代わり

- **選択肢 2(既存の crate の口)**: 決定 1 のとおり、安全に使える口がない
- **libc を transcript の直接の依存にし、`libc::O_NONBLOCK` を使う**: target ごとの値を書かずに済む。しかし lint の例外はやはり要り、得られるのは定数 1 つだけである。その一方で、libc の `build.rs`(`$RUSTC --version` を実行する。`0193-phase-2-dependencies` の表)が、解析の crate の x86_64 の Linux のビルドに初めて入る。この作業の書くパスに `Cargo.toml` と `Cargo.lock` もない。段階 3〜4 で値の出どころを 1 つにするときに、改めて選べる
- **`clippy.toml` から `custom_flags` を外す**: crate のどこでも任意のフラグで開けるようになり、`0107-crate-split` の「読むためだけに開く」を lint で守れなくなる
- **`#[allow]` で例外にする**: 呼び出しが消えても例外が残る(決定 3)
- **開く関数だけを置き、通常のファイルかの確かめを呼ぶ側に任せる**: 決定 2 のとおり、非ブロッキングの fd が module の外に出る
- **Linux を「mips と sparc 以外のすべての arch」として 0o4000 にする**: Rust があとで足す Linux の arch にも、確かめずに 0o4000 を使う。ビルドしない target の値は誰も確かめ直さない
- **core が開く関数を transcript に渡す(`Transcripts` が opener を受け取る)**: 非ブロッキングで開く理由は core に、通常のファイルかの確かめは transcript に分かれ、`0196-transcript-interface` の公開の口が広がる。`File::open` を渡す呼び手がいると、不具合が黙って戻る
- **非ブロッキングで開く関数だけを持つ crate を新しく作る**: 段階 3〜4 で core と orchestrator も使うようになれば候補になる。今は `0107-crate-split` の置き換えと `Cargo.toml` の変更が要り、呼び手は 1 つしかない
- **選択肢 3(置き換えを許容する)**: 置き換えにはペインの作業フォルダーに書けることが要るが、止まったスレッドは core の blocking のスレッドを占め続ける(`0196-transcript-interface`)。TypeScript と振る舞いが違う
- **`O_RDWR` で開く(Linux では FIFO の open が止まらない)**: 書き込みの権限が要り、読み取り専用の画像を開けない。`OpenOptions::write` も禁じている
- **別のスレッドで開き、時間で打ち切る**: 打ち切っても `open` で止まったスレッドは戻らず、要求のたびに 1 つずつ残る

## 依存

なし。

## 結果

- Codex のローカルの画像は、パスが FIFO(開く直前に置き換わった場合を含む)でもすぐに `None` を返す
- transcript の `src/` で `custom_flags` を使えるのは `src/nonblocking_open.rs` の 1 か所で、渡せるのは `O_NONBLOCK` だけ。transcript の中でほかに非ブロッキングで開く必要が出たら、`open_regular_file` を呼ぶ。別のフラグが要るときは、新しい ADR で決める
- screen の `src/` には例外がない
- Linux の x86_64 と aarch64、Apple のほかの unix の target では、transcript をビルドできない。その target を対象にするときに、libc から値を足す(`compile_error!` のメッセージがそう示す)

## 確かめたこと

2026-11-09、Linux 7.2.15-1-omarchy(x86_64)、Rust 1.99.1 で確かめた。

- 変更の前の失敗: 開く前の確かめを外し、`O_NONBLOCK` を付けない版(`File::open` だけ)で `cargo test --locked -p herdr-fleet-transcript --test codex_images` を走らせると、`a_fifo_with_no_writer_answers_none_at_once` と `a_symlink_to_a_fifo_answers_none_at_once` が `panicked at crates/transcript/tests/codex_images.rs:74:14`(`Transcripts::image answers within 2 seconds`)で失敗した(`test result: FAILED. 3 passed; 2 failed … finished in 2.00s`)。変更の後は 5 件すべてが通った(`finished in 0.06s`)。PR #222 の版(開く前の確かめあり)でも 5 件は通る。止まるのは確かめてから開くまでに置き換わったときで、それは次の probe で確かめた
- 開く直前の置き換え: Issue #225 の lead(codex)が作った probe(`open64` を横取りして、開く直前に通常のファイルを書き手のいない FIFO に置き換える `LD_PRELOAD` のライブラリと、公開の `Transcripts::image` を呼ぶプログラム)を、変更後のコードで作り直して走らせた。`replaced regular image with writerless FIFO before open64 (flags=0x80800)`、`Transcripts::image returned None`、終了コード 0、7 ms。変更の前の記録は `flags=0x80000`、`timeout 2` の終了コード 124、2.003 秒だった。置き換えなしの対照では、通常の PNG が画像として返った
- 定数の値をテストが確かめること: x86_64 の Linux の値を 0 に変えると FIFO の 2 件が 2 秒で失敗し、`O_TRUNC` の 0o1000 に変えると FIFO の 2 件と、symlink の先の画像、8 MiB の件の 4 件が失敗した(戻して通した)
- `#[expect]`: `custom_flags(O_NONBLOCK)` の呼び出しを消すと、`cargo clippy --locked -p herdr-fleet-transcript --all-targets -- -D warnings` が `error: this lint expectation is unfulfilled` で失敗した(戻して通した)
- 手順 7: YAML から取り出し、`crates/screen` と `crates/transcript` の写しに対して `bash --noprofile --norc -eo pipefail` で走らせた。今の木では 0。`crates/screen/src` を消す、例外のファイルに `clippy::disallowed_types` か `clippy::all` を足す、`custom_flags(O_NONBLOCK | 0o1000)` にする、例外のファイルに 2 つ目の `clippy::disallowed_methods` を足す、`records.rs` に allow を足す、同じ名前のファイルを `screen/src` に置く、screen の `lib.rs` に `clippy::all` を足す、の 8 つはそれぞれ 1
- `O_NONBLOCK` の値: libc 0.2.191(`~/.cargo/registry/src/…/libc-0.2.191`)の定義と照らした(決定 4 の表)
- `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace`(37 の test binary)が通った
