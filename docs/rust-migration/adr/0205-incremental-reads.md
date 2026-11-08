# transcript の増分の読み取りは、すべての source が共有する 1 つの cache に置き、読んだバイト数と cache の中身をテストで確かめる

- 状態: 採用
- 決めた日: 2026-11-08
- Issue: #205
- 置き換える: `0196-transcript-interface` の決定 7(書き直しの世代を `Source<F>` ごとに持つ)。`0192-phase-2-split` の「ページングの cache は `Source<F>` が持つ」のうち、cache の持ち主

## 状況

T1(#196)のページングは、呼ばれるたびに transcript を読み直していた。TypeScript は、読んだ範囲と解析したターンをモジュールの変数に残し、追記された分だけを読む(`server/conversation.ts:547-826, 1019-1075`)。Codex のロールアウトは数百 MB になり、エージェントが動いている間は 2 秒ごとに新しいページを読むため(`TRANSCRIPT_WINDOW_BYTES` のコメント)である。ADR `0107-crate-split` は、この cache を `Transcripts` の値の責務にしている。

決める必要があったのは次の 3 つである。

- cache をどこに置くか。ADR `0196-transcript-interface` は、TypeScript の上限(答え 32、`liveScans` 32、`clearScans` 32、`settledTurns` 8、`codexTurns` 8)を source ごとに持って全体で最大 4 倍になることを受け入れるか、source の数で割るかを T6 に残した。Issue #205 の受け入れ条件は、上限を TypeScript と同じにすることである
- Mutex をどう持つか。ADR `0192-phase-2-split` の決まりで、状態を読み書きする間だけ持ち、ファイルの読み取りと解析の間は持たない
- 「追記のあとの 2 回目の読み取りが追記された分だけを読む」ことと「上限を超えたら古いものから捨てる」ことを、何で確かめるか。Issue #205 は、確かめ方を T6 が決めて ADR に書くとしている

## 決定

### cache の持ち主と上限

`Transcripts::new` が `PagingCache`(`Arc<Mutex<PagingState>>`)を 1 つ作り、4 つの `Source<F>` に渡す。ページングが読み取りの間に残すものは、すべてこの値に入る。

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

### 確かめ方

1. 読み続けた答えと読み直した答えが同じこと: `tests/warm.rs`。会話ログの corpus の claude、codex、pi、omp の全件で、2 つのテストを走らせる
   - 件の全手順を 1 つの `Transcripts` で走らせ、呼び出しの手順ごとに、その呼び出しだけのために作った新しい `Transcripts` にも同じことを聞く
   - 件の `.jsonl` のファイルを 12 の断片に分けて追記し(行の途中と行の終わりで交互に切る)、断片ごとに新しいページとその前のページを、同じ 2 つの値で読む。1 MB を超えるファイル(`omp/clear-drops-earlier-output/late.jsonl`、16 MB)は、断片ごとに新しい値で全体を読み直すと時間がかかるので、件の手順でだけ読む

   比べるのは、ターン、metadata、abandoned、`cursor` のバイトの位置である。`history_id` と `version` は比べない(書き直しの世代は前の読み取りを覚えている値だけが見つけ、`version` はプロセスごとに違う)。cursor は stream の id とバイトの位置からなり、新しい値の id には、読み続けた値が見つけた書き直しの世代がない。そのため、読み続けた値が答えた stream の cursor は、新しい値がその stream に付ける id に付け替えて渡し、読み続けた値が断った cursor はそのまま渡す(新しい値も断らなければならない)。読み続けた値が誤って cursor を断る誤りは、この付け替えでは見つからず、読み続けた値の答えを期待値と比べる corpus のテスト(`tests/claude.rs` など)が見つける

2. 追記のあとの読み取りが追記された分だけを読むこと: `paging.rs` のテスト。ページングが transcript のファイルから読んだバイト数を、テストのときだけコンパイルされる thread local のカウンタ(`#[cfg(test)]`)で数える。公開の口は足さない。数えるのはページングの読み取りだけで、source の module が自分で読むもの(pi の枝の索引、Codex の連なり、pi の abandoned)は数えない。それらは T2〜T4 の cache である

   上限の値は、TypeScript の読み方から手で出した。変わっていないファイルを読むと、答えは残したものを返し、境目の走査の続きを確かめるために 64 バイトを 2 回読む(`:551` と `:584`)ので、128 バイトになる。実行中のターンに追記したときは、追記された分を 2 回(境目の走査とターンの始まりの走査)、64 バイトを 6 回、実行中のターン全体を 1 回までである(omp では実行中のターンを毎回すべて解析する。TypeScript と同じ)。Codex の長いタスクに追記したときは、追記された分を 2 回と 64 バイトを 4 回までで、1 MB 近いタスクを読み直さない

3. 上限を超えたら古いものから捨てること: `paging.rs` のテストが `PagingCache` の中身を読む。65 個のファイルを順に読んだあとに残る key の並び(世代は 2 番目から 65 番目、答えと走査は 34 番目から、確定したターンは 58 番目から)、Codex の 9 個のロールアウトのあとの 8 件、11 MB の実行中のターンを 3 つ読んだあとの 2 件を、上の表の上限から手で出した値と比べる

テストがファイルを書くことについて: `rust/crates/transcript/clippy.toml` はこの crate でのファイルの書き込みを禁じ、CI の clippy はテストにも当たる。ADR `0122-parity-criteria` は、ファイルを変える手順を走らせる runner の module だけに `#[allow]` を理由とともに書くとしている。`tests/warm.rs` はその runner に当たり、module の先頭に書いた。`paging.rs` のテストは、一時ファイルを書く関数ごとに書いた(ADR `0107-crate-split` はテストでの一時ファイルを認めている)。`tests/common/mod.rs` の runner の関数は公開されておらず、`tests/common/` は共通のファイルでこの Issue では書かない(ADR `0192-phase-2-split`)ので、`tests/warm.rs` は手順の実行(ファイルの写し、追記、置き換え、書き直し、削除)を写して持つ。

## 検討した代わり

- source ごとに TypeScript の上限を持つ: 全体で最大 4 倍になり、受け入れ条件(上限を TypeScript と同じにする)を満たさない
- source の数で割る(答え 8、確定したターン 2 など): claude だけを使う人のペインでは、TypeScript の 4 分の 1 しか覚えず、確定したターンを読み直す回数が増える
- source ごとの型のままの cache を、4 つの source を名指す構造体に置く: `paging.rs` が source を名指すことになり、ADR `0192-phase-2-split` の seam(source の違いは `TranscriptFormat` だけを通る)を破る
- 読んだバイト数を `Transcripts` の公開の関数で返す: crate の interface が、テストのためだけの関数で増える。Issue #205 は許していたが、`#[cfg(test)]` の数え方で足りた
- Linux の `/proc/self/io` の `rchar` で数える: 同じテストのプロセスで並行して走るほかのテストの読み取りも数え、Linux にしかない
- 前に読んだ範囲を同じ長さで書き換えてから追記し、読み続けた値の答えに書き換える前の文字が残ることで確かめる: 公開の口だけで確かめられるが、確かめられるのは確定したターンを解析し直さないことだけで、ターンの始まりと境目の走査が読み直さないことは確かめられない

## 依存

なし。外部の crate を足さない。

## 結果

- 段階 4 の core が 1 つの `Transcripts` を持ち続ければ、新しいページの読み取りは、追記された分と実行中の最後のターンだけを読む(Codex では追記された分だけ)。変わっていないファイルは 128 バイトだけ読んで、残した答えを返す
- 残すものの量は、4 つの source を合わせて TypeScript と同じである。答えはページの全ターンを持つので、TypeScript と同じく、最大で 32 ページ分のターンを覚える
- 新しい source の format は、`Carry` を `Send + 'static` にする。実行中のターンを増分で解析するときは `live_parser` を返す
- ページングに cache を足すときは、`tests/warm.rs` が読み続けた答えと読み直した答えを比べる。cache を足した変更が答えを変えれば、このテストが落ちる

## 確かめたこと

- 増分の読み取りを入れる前の engine(`780c7cf`)で `cargo test --locked -p herdr-fleet-transcript --test warm` を走らせ、2 つのテストが通った
- 増分の読み取りに 1 バイトずらす誤りを 1 つずつ入れて、`tests/warm.rs` を走らせた(誤りは戻した)
  - `liveScans` の走査の続きを 1 バイト先から始める: 断片の追記のテストが 23 件で落ちた(件の手順のテストは通った)
  - 確定したターンの解析を、確定した位置の 1 バイト先から始める: 断片の追記で 145 件、件の手順で 4 件落ちた
  - Codex の実行中のターンの解析の続きを 1 バイト先から始める: 断片の追記で 89 件、件の手順で 4 件落ちた
  - 境目の走査の続きを 1 バイト先から始める: 件の手順のテストが 6 件で落ちた(断片の追記のテストは通った)
- cache が何も返さないようにした engine(世代のほかは、取り出す項目がいつもない)で、読んだバイト数の 2 つのテストが落ちた(変わっていないファイルで 128 バイトのところ 1,218,981 バイト、Codex の追記で 420 バイトまでのところ 1,847,166 バイト)。古いものを捨てないようにした engine で、上限の 3 つのテストが落ちた
- `tests/claude.rs`、`codex.rs`、`pi.rs`、`omp.rs` を変えずに、`cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace` が通った
