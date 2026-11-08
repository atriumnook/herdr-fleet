# transcript の増分の読み取りは、すべての source が共有する 1 つの cache に置き、`Transcripts::paging_bytes_read` で読んだ量を確かめる

- 状態: 採用
- 決めた日: 2026-11-08
- Issue: #205
- 置き換える: `0196-transcript-interface` の決定 7(書き直しの世代を `Source<F>` ごとに持つ)。`0192-phase-2-split` の「ページングの cache は `Source<F>` が持つ」のうち、cache の持ち主。`0192-phase-2-split` の「transcript の seam」の公開の口(`page`、`image`、`tool_output`、`unanswered_questions`)に、`paging_bytes_read` を足す

## 状況

T1(#196)のページングは、呼ばれるたびに transcript を読み直していた。TypeScript は、読んだ範囲と解析したターンをモジュールの変数に残し、追記された分だけを読む(`server/conversation.ts:547-826, 1019-1075`)。Codex のロールアウトは数百 MB になり、エージェントが動いている間は 2 秒ごとに新しいページを読むため(`TRANSCRIPT_WINDOW_BYTES` と `LiveScan` のコメント)である。ADR `0107-crate-split` は、この cache を `Transcripts` の値の責務にしている。

決める必要があったのは次の 3 つである。

- cache をどこに置くか。ADR `0196-transcript-interface` は、TypeScript の上限(答え 32、`liveScans` 32、`clearScans` 32、`settledTurns` 8、`codexTurns` 8)を source ごとに持って全体で最大 4 倍になることを受け入れるか、source の数で割るかを T6 に残した。Issue #205 の受け入れ条件は、上限を TypeScript と同じにすることである
- Mutex をどう持つか。ADR `0192-phase-2-split` の決まりで、状態を読み書きする間だけ持ち、ファイルの読み取りと解析の間は持たない
- 「追記のあとの 2 回目の読み取りが追記された分だけを読む」ことと「上限を超えたら古いものから捨てる」ことを、何で確かめるか。Issue #205 は、確かめ方を T6 が決めて ADR に書くとし、そのために `lib.rs` に口を足すことを許している。ファイルを書くテストは crate の `tests/` に置く決まりで(ADR `0110-workspace-and-ci` の「テストでの扱い」、CI の job `linux` の手順「Parsing crates allow their banned APIs only in tests」)、`tests/` のテストは公開の口しか使えない

## 決定

### cache の持ち主と上限

`Transcripts::new` が `PagingCache`(状態の `Mutex` と、下の読んだバイト数のカウンタを持つ値の `Arc`)を 1 つ作り、4 つの `Source<F>` に渡す。ページングが読み取りの間に残すものは、すべてこの値に入る。

| 持つもの | TypeScript の変数 | 上限 |
|---|---|---|
| ファイルごとの書き直しの世代 | `transcriptRevisions`(`:478`) | 64 |
| 答え | `cache`(`:1075`) | 32 |
| 境目の走査の続き | `clearScans`(`:585`) | 32 |
| 新しいページのターンの始まり | `liveScans`(`:735`) | 32 |
| 新しいページの、最後のターンの始まりより前の確定したターン | `settledTurns`(`:817`) | 8 |
| Codex の実行中のターンの解析 | `codexTurns`(`:777-783`) | 8 件、かつ解析したバイトの合計が 2 × 16 MB |

上限は TypeScript と同じく、4 つの source の合計で数える。上限を超えたときは、最も前に記録したものから捨てる(TypeScript の `remember`。記録し直すと最後に並ぶ。答えは読んだだけでは並びを変えない)。Codex の実行中のターンは、合計が 2 × 16 MB を超える間、古いものから捨てる。いま記録したものが 1 つで超えるときは、それも捨てる(TypeScript と同じ)。

source ごとに上限を持つ案も、source の数で割る案も取らなかった(「検討した代わり」)。

- source ごとの値の型は、型を消して 1 つの値に入れる。確定したターンが持つ format の `Carry`(Claude の `peersSeen`)は `Box<dyn Any + Send>` で持ち、使うときに `downcast` する。Codex の実行中のターンの parser は、trait `LiveParser` の trait object で持つ。そのため `TranscriptFormat` の `Carry` に `Send + 'static` を足し、`TranscriptFormat::live_parser` を足した。既定は `None`(実行中のターンを毎回すべて解析する)で、Codex だけが parser を返す。omp の module は変えていない
- 書き直しの世代も同じ値に入る。ADR `0196-transcript-interface` の決定 7 は、世代だけを `Transcripts` で共有すると、ページングの状態の持ち主が 2 つになるとして、世代を `Source<F>` ごとに持った。ここではページングの状態をすべて 1 つの値に置くので、持ち主は 1 つのままである
- key は TypeScript と同じくパスである(確定したターンはパスとページの始まり、答えはパスと要求)。どの項目も読んだ source を持ち、ほかの source が記録したものは使わない。TypeScript で source を確かめるのは `liveScans` だけだが、1 つのファイルを 2 つの source で読むことはないので、答えは変わらない

残したものは、使う前にファイルと照らす(TypeScript と同じ)。読んだ stream の id(inode、Codex の連なり、pi の枝、書き直しの世代、境目)が同じこと、読み終えた位置がファイルの長さを超えないこと、その位置の直前の 64 バイトが記録したものと同じことである。書き直されたファイルはこの 64 バイトを持たないので、最初から読み直す。

### Mutex の持ち方

lock を持つのは、項目を取り出すときと戻すときだけである。読み取りに使う項目は取り出してから lock を外し、ファイルを読んで解析し終えてから、lock を取り直して戻す。lock は文の中の一時的な値で取り、ファイルを読む `match` の外で外れる。例外は ADR `0196-transcript-interface` の決めた `Source::identify`(live file の stat を 1 回取る間)と、Codex の実行中のターンを戻して上限を当てる間で、どちらもファイルの中身を読まない。答えは `Arc` で持ち、lock の中では `Arc` を複製するだけにした(ターンの複製は lock の外)。

同じファイルを 2 つのスレッドが同時に読むと、後から読むほうは取り出す項目がないので、最初から読む。答えは同じで、読む量だけが増える。

### 読んだ量を数える公開の口

`Transcripts` に次の method を足す。常にコンパイルする(`#[cfg]` を付けない)。決めたのは architect(#205 の thread で相談した)である。

```rust
/// The bytes the paging has read from transcript files through this value since `new`, ...
pub fn paging_bytes_read(&self) -> u64
```

- 数えるもの: ページングが transcript のファイルから読んだバイト数の、`new` からの合計(すべての呼び出しとスレッドを合わせる)。stream の範囲の読み取りと、Codex の metadata の head の読み取りである。値は増えるだけで、呼ぶ側は 1 回の呼び出しの前後の差で測る
- 数えないもの: source の module が自分で読むもの(Codex の連なり、pi の枝の索引と abandoned)、`image`、`tool_output`、`unanswered_questions` の読み取り。前の 3 つは T2〜T4 の cache で、このカウンタでは測らない
- 作り: `PagingCache` は `Arc<Shared>` で、`Shared` は状態の `Mutex` と `AtomicU64` を持つ。カウンタは Mutex の外にあり、数えるときに lock を取らない(加算は `Relaxed`。値は合計で、ほかのデータとの順序を要しない)。`paging.rs` がファイルを開いて読むのは `PagingCache::read_file` の 1 か所だけで、この関数が数える。読み取りを足すときにこの関数を使えば数え漏れはなく、別の読み方を足せばレビューで見つかる
- 常にコンパイルする理由: `tests/` のテストは `cfg(test)` なしでビルドした lib に link するので、`#[cfg(test)]` の item は見えない。cargo の feature と独自の cfg は、どちらも `Cargo.toml` を書く必要があり、`Cargo.toml` はこの Issue では書かない共通のファイルである(ADR `0192-phase-2-split`)
- 名前: `bytes_read` は `Transcripts` のすべての読み取りを数えるように読めるので、数える範囲を crate の語「ページング」で示した
- 段階 4 の core はこの method を使わなくてよい。費用は、ファイルの読み取り 1 回(open、seek、read)ごとに 1 回の加算である

### 確かめ方

1. 読み続けた答えと読み直した答えが同じこと: `tests/warm.rs`。会話ログの corpus の claude、codex、pi、omp の全件で、2 つのテストを走らせる
   - 件の全手順を 1 つの `Transcripts` で走らせ、呼び出しの手順ごとに、その呼び出しだけのために作った新しい `Transcripts` にも同じことを聞く
   - 件の `.jsonl` のファイルを 12 の断片に分けて追記し(行の途中と行の終わりで交互に切る)、断片ごとに新しいページとその前のページを、同じ 2 つの値で読む。1 MB を超えるファイル(`omp/clear-drops-earlier-output/late.jsonl`、16 MB)は、断片ごとに新しい値で全体を読み直すと時間がかかるので、件の手順でだけ読む

   比べるのは、ターン、metadata、abandoned、`cursor` のバイトの位置である。`history_id` と `version` は比べない(書き直しの世代は前の読み取りを覚えている値だけが見つけ、`version` はプロセスごとに違う)。cursor は stream の id とバイトの位置からなり、新しい値の id には、読み続けた値が見つけた書き直しの世代がない。そのため、読み続けた値が答えた stream の cursor は、新しい値がその stream に付ける id に付け替えて渡し、読み続けた値が断った cursor はそのまま渡す(新しい値も断らなければならない)。読み続けた値が誤って cursor を断る誤りは、この付け替えでは見つからず、読み続けた値の答えを期待値と比べる corpus のテスト(`tests/claude.rs` など)が見つける

2. 追記のあとの読み取りが追記された分だけを読むこと: `tests/warm.rs` が、読み取りの前後の `paging_bytes_read` の差を比べる。上限の値は、TypeScript の読み方から手で出し、その元の値(`bytesBefore` の 64 バイト、16 MB の `TRANSCRIPT_WINDOW_BYTES`)は crate の定数を使わずにテストに書いた
   - 変わっていないファイル: 答えは残したものを返し、境目の走査の続きを確かめるために 64 バイトを 2 回読む(`:551` と `:584`)ので、128 バイトである
   - 実行中のターンへの追記: 追記された分を 2 回(境目の走査とターンの始まりの走査)、64 バイトを 6 回、実行中のターン全体を 1 回までである(omp では実行中のターンを毎回すべて解析する。TypeScript と同じ)。ファイルはこの上限の 20 倍より大きい
   - Codex の長いタスクへの追記: 追記された分を 2 回と 64 バイトを 4 回までで、上限の 100 倍より大きいタスクを読み直さない

3. 上限を超えたら古いものから捨てること: 上限 L の場面ごとに、L + 1 個のファイルを 1 回ずつ読み、(場面によっては追記してから)逆順に読み直す。ファイル L〜1 の読み直しは上の読み取りの量の上限以内で、ファイル 0 はファイル全体を読む。読み直したファイルの項目は記録し直されて最後に並ぶだけで件数は増えないので、逆順に読めば、ファイル 0 を読み直す前に残っている項目が捨てられることはない。1 つの場面で越える上限は、できるだけ 1 つにした。上限の値は TypeScript の行を添えてテストに書いた
   - 答え(32): Codex のロールアウト 33 個を変えずに読み直す。Codex には境目の走査がないので、答えが残っていれば 0 バイトを読む
   - 境目の走査(32): omp のファイル 33 個を変えずに読み直す。走査の続きと答えの両方が残っていれば 128 バイトを読む
   - ターンの始まり(32): omp のファイル 33 個に追記してから読み直す。各ファイルを 1 つのターンだけにして、確定したターン(上限 8)をなくした。残っているファイルはファイルのおよそ 1 回分を、捨てられたファイル 0 は境目とターンの始まりの走査が加わって 3 回分以上を読む。この場面は境目の走査の上限も越える
   - 確定したターン(8): 確定したターンが大きく実行中のターンが短い omp のファイル 9 個に追記してから読み直す。9 個は 32 個より少ないので 2 つの走査の項目はすべて残り、ファイル 0 との差は確定したターンを解析し直す分だけになる
   - Codex の実行中のターン(8 件): 長い 1 つのタスクを持つロールアウト 9 個に追記してから読み直す
   - Codex の実行中のターン(2 × 16 MB): 11 MB のロールアウト 3 個に追記してから読み直す。ファイル 0 は 11 MB を解析し直す。この場面が見分けるのは、合計の上限が 22 MB 以上 33 MB 未満であることまでである
   - 書き直しの世代(64): 65 個を読み、ファイル 1 とファイル 0 を同じ inode のまま短く書き直し、1、0 の順に読む。1 は `history_id` が変わり、0 は変わらない(世代を忘れたので、最初に読んだときと同じ id になる)

   上限は、cache の key の並びではなく、読み直しの量と `history_id` で、上限の前後(残るもののうち最も古いものと、捨てられる最初のもの)だけを確かめる。テストは cache の内部の形に依らず、cache の形を変えても、答えと読む量が同じなら落ちない

テストがファイルを書くことについて: `rust/crates/transcript/clippy.toml` はこの crate でのファイルの書き込みを禁じ、CI の clippy はテストにも当たる。ファイルを書くテストはすべて `tests/warm.rs` にあり、ADR `0110-workspace-and-ci` の「テストでの扱い」のとおり、ファイルの先頭に `#![allow(clippy::disallowed_methods, clippy::disallowed_types)]` を理由とともに書いた。`src/` には書いていない(CI の手順が `src/` のこの語で失敗する)。`tests/common/mod.rs` の runner の関数は公開されておらず、`tests/common/` は共通のファイルでこの Issue では書かない(ADR `0192-phase-2-split`)ので、`tests/warm.rs` は手順の実行(ファイルの写し、追記、置き換え、書き直し、削除)を写して持つ。

## 検討した代わり

- source ごとに TypeScript の上限を持つ: 全体で最大 4 倍になり、受け入れ条件(上限を TypeScript と同じにする)を満たさない
- source の数で割る(答え 8、確定したターン 2 など): claude だけを使う人のペインでは、TypeScript の 4 分の 1 しか覚えず、確定したターンを読み直す回数が増える
- source ごとの型のままの cache を、4 つの source を名指す構造体に置く: `paging.rs` が source を名指すことになり、ADR `0192-phase-2-split` の seam(source の違いは `TranscriptFormat` だけを通る)を破る
- `src/` の `#[cfg(test)]` の thread local のカウンタと、`paging.rs` の中のテスト(最初の形): テストがファイルを書くために `src/` で clippy の lint を外すことになり、CI の手順「Parsing crates allow their banned APIs only in tests」が失敗する(ADR `0110-workspace-and-ci` の 7)
- cargo の feature、または独自の `--cfg`: `Cargo.toml` を書く必要がある。独自の cfg は `rust/Cargo.toml` に check-cfg の宣言が要り、宣言がないと `unexpected_cfgs` の警告が `-D warnings` で失敗になる
- 読んだ範囲を知らせる callback を受け取る 2 つ目の constructor: `Transcripts` を作る方法が 2 つになり、読み取りの配置(Codex の連なりと pi の枝では、stream の位置とファイルの位置が違う)が呼ぶ側に漏れる
- cache の中身(種類ごとの key)を公開する: 口が広くなり、key の形と項目の種類の一覧をテストが固定する
- Linux の `/proc/self/io` の `rchar` で数える: 同じテストのプロセスで並行して走るほかのテストの読み取りも数え、Linux にしかない
- 前に読んだ範囲を同じ長さで書き換えてから追記し、読み続けた値の答えに書き換える前の文字が残ることで確かめる: 確かめられるのは確定したターンを解析し直さないことだけで、ターンの始まりと境目の走査が読み直さないことは確かめられず、読む量の上限も言えない

## 依存

なし。外部の crate を足さない。

## 結果

- 段階 4 の core が 1 つの `Transcripts` を持ち続ければ、新しいページの読み取りは、追記された分と実行中の最後のターンだけを読む(Codex では追記された分だけ)。変わっていないファイルは 128 バイトだけ読んで、残した答えを返す
- 残すものの量は、4 つの source を合わせて TypeScript と同じである。答えはページの全ターンを持つので、TypeScript と同じく、最大で 32 ページ分のターンを覚える
- `Transcripts` の公開の口に `paging_bytes_read` が増える。core は使わなくてよい。このカウンタは、source が自分で読むものを含まない
- 新しい source の format は、`Carry` を `Send + 'static` にする。実行中のターンを増分で解析するときは `live_parser` を返す
- ページングにファイルの読み取りを足すときは、`PagingCache::read_file` を使う。cache を足すときは、`tests/warm.rs` が読み続けた答えと読み直した答えを比べ、答えが変われば落ちる

## 確かめたこと

- 増分の読み取りを入れる前の engine(`780c7cf`)で、`tests/warm.rs` の答えを比べる 2 つのテストが通った(`cargo test --locked -p herdr-fleet-transcript --test warm`)
- 増分の読み取りに 1 バイトずらす誤りを 1 つずつ入れて、答えを比べる 2 つのテストを走らせた(誤りは戻した)
  - `liveScans` の走査の続きを 1 バイト先から始める: 断片の追記のテストが 23 件で落ちた(件の手順のテストは通った)
  - 確定したターンの解析を、確定した位置の 1 バイト先から始める: 断片の追記で 145 件、件の手順で 4 件落ちた
  - Codex の実行中のターンの解析の続きを 1 バイト先から始める: 断片の追記で 89 件、件の手順で 4 件落ちた
  - 境目の走査の続きを 1 バイト先から始める: 件の手順のテストが 6 件で落ちた(断片の追記のテストは通った)
- `take` が何も返さない engine(書き直しの世代を除く。答えの `get` は変えていない)で、読み取りの量の 2 つのテストと、上限の 5 つのテスト(境目の走査、ターンの始まり、確定したターン、Codex の実行中のターンの 2 つ)が落ちた。上限のテストでは、残っているはずのファイルも全体を読むため
- 6 つの件数の上限を 1 つずつ L − 1 と L + 1 に変えた engine で、それぞれ少なくとも 1 つの上限のテストが落ちた。境目の走査の上限を 33 にした誤りは、ターンの始まりの場面が見つけた。答えの上限を 33 にした誤りは、omp の場面では境目の走査がファイルを読み直すので見つからず、Codex の答えの場面を足して見つけた。合計の上限を 1 window と 3 window に変えた engine で、2 × 16 MB の場面が落ちた
- CI の job `linux` と同じ `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace` と、`src/` の lint の語を探す grep が通った。`tests/claude.rs`、`codex.rs`、`pi.rs`、`omp.rs` は変えていない
