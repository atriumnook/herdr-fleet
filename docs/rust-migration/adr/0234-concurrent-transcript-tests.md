# transcript の書き直しの判定は、時刻だけが変わった stat を最大 50 ms 待ってから決め、並行の読み取りを `tests/concurrent.rs` で確かめる

- 状態: 採用
- 決めた日: 2026-11-09
- Issue: #234
- 置き換える: 0196-transcript-interface.md(「`TranscriptFormat`(crate の中)」の箇条書きのうち、「この順序を確かめる並行のテストは置かない」の 1 項だけ。同じ箇条書きの「書き直しの世代は `file_stat` の値だけから `PagingState::generation` が決める」と「`Mutex` は、live file の stat を 1 回取り、書き直しの世代を読み書きする間だけ持つ」は、`0196-transcript-interface` のまま)

## 状況

ADR `0196-transcript-interface` は、live file の stat を lock の中で取ると決めた。複数のスレッドが同じファイルを読むとき、記録される stat が取った順になり、伸びるだけのファイルが縮んだと読まれないようにするためである。そのうえで、この順序を確かめる並行のテストは置かないと決めた。理由は次のとおりだった。追記の途中で取った stat は、大きさが前と同じで時刻だけが新しいことがある。同じ大きさで時刻が変われば書き直しとする判定(TypeScript と同じ)はこれを書き直しと読むので、8 スレッドのテストは順序を直したあとも 10 回中 7 回失敗した。この誤判定は TypeScript にもあり、Issue #219 にした。

Issue #219 の修正(`rust` のマージコミット `79cce40`)は、この判定を変え、8 スレッドのテストを含む `rust/crates/transcript/tests/concurrent.rs` を置いた。そのため「並行のテストは置かない」という決定と、「8 スレッドのテストを決定的に通せない」という理由は、どちらも事実でなくなった。前の ADR は書き換えない決まり(`docs/rust-migration/adr/README.md`)なので、この ADR でその 1 項を置き換える。#219 の修正の thread は ADR を書かなかったので、修正で決めた判定もこの ADR に記録する。

## 決定

### 時刻だけが変わった stat の扱い

`rust/crates/transcript/src/paging.rs` の `PagingState::generation` と `Source::identify` は、次のように判定する。

- 前回の stat と比べて、同じファイル(unix では dev と inode が同じ)で大きさが増えていれば、追記として前の世代を保つ。同じファイルで、大きさと時刻(unix では mtime と ctime)も同じなら、前の世代を保つ
- 同じファイルで大きさも同じなのに、時刻だけが違う stat を見たときは、すぐには書き直しと決めない。その stat は記録せず、lock を外して `RESTAT_EVERY`(1 ms)待ち、lock を取り直して stat を取り直す。これを `SETTLE`(50 ms)まで続ける
- 待つあいだに大きさが増えれば、追記として前の世代を保つ。50 ms たっても大きさが同じで時刻が違えば、書き直しとして新しい世代にする。大きさが減ったときは、待たずに新しい世代にする
- 決めた stat は記録するので、同じ変更を次に読むときは待たない。50 ms まで待つのは、大きさが増えない変更(`touch`、`chmod`、同じ大きさの書き直し)を初めて読むときだけである

TypeScript の `identifyTranscript`(`server/conversation.ts:482`)も同じ規則で判定する。`transcriptPage` が同期の関数なので、`Bun.sleepSync(1)` で待つ。

ADR `0196-transcript-interface` の残りの 2 項は、この判定のあとも成り立つ。

- 書き直しの世代は、今も `file_stat` の値だけから決まる。待つあいだも、ファイルの中身は読まない
- lock を持つのは、1 回の stat と世代の読み書きのあいだだけである。待つあいだは lock を外す。ADR `0205-incremental-reads` の「Mutex の持ち方」が例外に挙げる `Source::identify` も、ファイルの中身を読まないまま変わらない

### 並行の読み取りのテスト

`rust/crates/transcript/tests/concurrent.rs` の 3 件で確かめる。どれも公開の口(`Transcripts::page`)だけを使う。CI の job `linux` の `cargo test --locked --workspace` が走らせる。

| テスト | 何をして、何を確かめるか | 確かめる判定 |
|---|---|---|
| `an_append_seen_by_its_times_before_its_size_keeps_history_and_cursors` | 時刻だけを変え、5 ms 後に別のスレッドが追記する。そのあいだに読んだページの `history_id` と、前に取った cursor のページが変わらない | 時刻だけが変わった stat を待つこと |
| `rewrites_truncation_and_replacement_still_invalidate_cursors` | 同じ大きさの書き直し、時刻だけの変更(そのあと追記なし)、切り詰め、別のファイルへの置き換えのそれぞれで、`history_id` が変わり、古い cursor は `HistoryChanged` になる | 待ったあとも書き直しを見分けること |
| `eight_readers_share_history_while_a_writer_appends` | 8 スレッドが 1 つの `Transcripts` で 80 回ずつ読み、1 つのスレッドが 160 件の記録を 7 バイトずつ追記する。`history_id` と、前に取った cursor のページが変わらない | stat を lock の中で取る順序 |

判定を変える作業は、この 3 件を通す。

## 検討した代わり

- ADR `0196-transcript-interface` の該当の行を直接書き換える: 前の ADR を書き換えない決まり(`docs/rust-migration/adr/README.md`)に反する
- 置き換えずに残す: 「並行のテストは置かない」が残り、`tests/concurrent.rs` を ADR に反するテストと読まれうる
- 覚えておいた末尾 64 バイトを読み比べて、追記と書き直しを見分ける(#219 の thread が試した案): `fixtures/conversations/codex/growing-task` の手順 14 は、末尾 64 バイトが同じで大きさも同じ書き直しで、末尾の比較ではこれを追記と区別できず、手順 15 が失敗した。追記は前の大きさより前のバイトを変えないので、追記の途中の stat でも末尾は一致し、#219 の場面の判定も決まらない。さらに、lock の中でファイルの中身を読むことになり、ADR `0196-transcript-interface` と `0205-incremental-reads` の lock の決まりに反する

## 依存

なし。

## 結果

- `tests/concurrent.rs` のテストは、`rust` のすべての PR で走る
- 時刻が変わってから大きさが増えるまでが 50 ms を超える追記は、今までどおり書き直しと判定され、`history_id` が変わり、古い cursor は `HistoryChanged` になる。#219 の thread で architect が、この作業と同じ Linux の PC(omarchy)の tmpfs で、時刻だけが変わった stat から大きさが増えるまでの時間を約 13.9 万回測った。最大は 216.2 µs で、1 ms を超えたものはなかった。50 ms は、測っていないディスクのファイルシステム(btrfs、CI の ext4)と、負荷のある CI での遅れを見込んだ値である
- `touch` などで時刻だけが変わったファイルを初めて読むとき、その読み取りは約 50 ms 遅れる

## 確かめたこと

2026-11-09、Linux(omarchy、kernel 7.2.15)、rustc 1.99.1、`rust` の `01d2f14`(`79cce40` を含む)。`/tmp` は tmpfs。

- `cargo test --locked -q -p herdr-fleet-transcript --test concurrent` を 10 回走らせ、10 回とも 3 件が通った(`test result: ok. 3 passed`)
- 待ちを外すために `SETTLE` を 0 にすると、10 回とも `an_append_seen_by_its_times_before_its_size_keeps_history_and_cursors` が `concurrent.rs:99:5`(`history_id` の比較)で失敗した。8 スレッドのテストは 10 回とも通った。変更は戻した
- `Source::identify` の `fs::metadata` を `self.cache.lock()` の前に移し、stat を lock の外で取ると、10 回とも `eight_readers_share_history_while_a_writer_appends` が `concurrent.rs:201:59`(前に取った cursor のページの読み直しが `HistoryChanged`)で失敗した。変更は戻した
- 2 つの失敗から、待つことは 1 件目のテストが、stat を lock の中で取る順序は 8 スレッドのテストが、それぞれ確かめていることがわかる
