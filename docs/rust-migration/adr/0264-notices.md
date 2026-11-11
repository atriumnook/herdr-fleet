# 知らせの配達と、thread の質問を outbox に入れる呼び出しの置き場所

- 状態: 採用
- 決めた日: 2026-11-11
- Issue: #264
- 置き換える: 0242-phase-3-split(一部: `landing.rs` を書く Issue)、0256-orchestrator-foundation(一部: hook と持ち主の表)

## 状況

#264(O4)は、TypeScript の知らせの処理(`server/fleet/orchestrator.ts:1256-1356` の `coordinatorOf`、`tellCoordinator`、`queueNews`、`hearerOf`、`notifyNow`、`typed`、`deliverNotices`、`hasDraft`、`retryNotices`)と、知らせの文(`:1797-1836`、`:1882-1892` の `threadLabel`、`threadTurnEnded`、`threadQuestion` と見出し)を、`rust/crates/orchestrator/src/fleet/notices.rs` に移す。受け入れ条件は、`orchestrator.test.ts` の describe `thread questions`(9 件)を Rust のテストに移すことを含む。

その 9 件のうち 8 件は、lead のターンが blocked の報告で終わったとき、質問が outbox に入ることを前提にしている。TypeScript でこれを入れるのは `settleThreadTurn` の最後の 2 行(`orchestrator.ts:1485-1486`)で、Rust では `settle_thread_turn` が O6(#266)の `landing.rs` にある stub で、何もしない。`landing.rs` は #264 の書くパスの外にある。#266 は #264 を待つ(#266 の本文「Blocked by #264」)ので、#264 のテストを通すには、#264 が `landing.rs` の stub に手を入れるか、別の Issue を待つことになる。

決める前に architect(fleet の run `8335a748`)に聞き、答えに従った。

## 決定

- `landing.rs` の `settle_thread_turn` の本体に、#264 は次の 1 行だけを書く。`// stub: #266` の印は残す(V が stub の残りを grep で数えるため。0242 の「stub」)

  ```rust
  self.queue_turn_news(id, config, restart_error.as_deref());
  ```

- 知らせの文を組み立てる処理は、すべて `notices.rs` の `queue_turn_news` に置く。run を id で読み直し、`thread_question` を、それがなく `autonomous` のときは `thread_turn_ended` を選び、起動し直せなかった理由があれば `\n  The fleet could not start the thread again on another CLI: <理由>` を足して、`queue_news` に渡す(`orchestrator.ts:1485-1486` と同じ)。id で読み直すのは、#266 と #268 がこの呼び出しの前に保存した `pr`、`landed`、landing の手順の決着を、`thread_turn_ended` が文に入れるため
- #266 との約束: 知らせが引く run の項目(landing の手順の決着、`pr`、`landed`)は、この呼び出しの前に保存する。人のいない project でマージを読んだときの `merged_without_person` も、この呼び出しの前に await する(0242 の codex の R4、#266 の受け入れ条件)。呼び出しを本体の最後に置くことは約束しない。#176 の 7(pull request のない thread のターンの終わりで、知らせと `wait` が `gh` を待たない)のために、#266 が `gh` の読み取りをこの呼び出しのあとに回すことがありうるため
- hook の表に 1 行を足す

  | hook | 持ち主 | 呼ぶ所 |
  |---|---|---|
  | `queue_turn_news(&self, id, config, restart_error: Option<&str>)` | #264 | #266 の `settle_thread_turn` |

- ほかの cluster が使う口を `pub(crate)` で置く。O5、O6、O8 が `notices.rs` を書かずに済むようにするため

  | 口 | 使う Issue と TypeScript の呼び出し |
  |---|---|
  | `queue_news(thread, Option<String>)` | #268 の `threadMerged` と `threadClosedAfterMerge`(`orchestrator.ts:1045`、`:1112`) |
  | `notify_now(id, text, cancel)` と `typed(id, &sent)` | #265 の計画の回答(`:899`)、#266 の lead への手順(`:814`)、#268 の停滞の知らせ(`:1130`) |
  | `start_delivering(coordinator)`(配達の lock を取る) | #268 の停滞の知らせ(`:1126` の `delivering.has`) |
  | `thread_label`、`thread_turn_ended`、`QUESTIONS_HEADER`、`NEWS_HEADER`、`STEPS_HEADER` | #266 の `coordinatorStep` と `land`(`:827`、`:1867`)、#267 のテスト(`orchestrator.test.ts:1824-1843`)、#268 の知らせの文 |

- 配達の lock: TypeScript の `delivering`(`Set`)を、`notices::State` の集合と、drop で外れる guard(`Delivering`)にした。確認と取得は notices の `Mutex` の中の 1 つの手順で行う
- 配達の送信は `submit` ではなく `submit_when_free` で行う。TypeScript は「fleet のターンが進行中でない」ことを確かめたあと、画面の読み取り(`hasDraft`)を await してから `submit` する(`orchestrator.ts:1318-1324`)。その await の間に `send` や landing の手順が新しいターンを始めると、TypeScript は 2 つ目の指示文を入れる。Rust では `submit_when_free` が確認と新しいターンの登録を 1 つの lock の中で行い、進行中なら `run_busy` で断る(0256 の「`submit_when_free`」)。断られた知らせは outbox に残り、coordinator の次の決着で届く。`fleet/mod.rs` の冒頭の決まり(確認と実行を、その cluster の lock の両側に分けない)に従った
- draft のある間の再試行は、`Timers` の `TimerKind::DraftRetry` で張る。張った timer があれば張らない(TypeScript の `draftRetries.has`)。`stop` は他の timer と同じく止める
- outbox のファイルに書けなかったとき(`queue_news`、配達のあとの削除、`stale_step` による掃除)は、標準エラーに書いて続ける。TypeScript は投げて、`finalize` の残りが飛ぶ(`reconcileRun` の catch)。Rust の hook は値を返さないので、`notices.rs` の中の 1 か所で扱う。outbox はファイルに書いてからメモリーを変えるので、書けなかった知らせは TypeScript でも Rust でも届かない。違いは、Rust では `finalize` の残り(waiter への知らせ、ペインを閉じること)が動くことだけ。例外は `restore_notices` で、outbox に書けなかった知らせは run の `notice` に残し、次の起動で入れ直す(TypeScript では constructor が投げ、`delete run.notice` が書かれずに残る)
- `due_to` は、`stale_step` で古い手順を選ぶのも、知らせを聞く run を探すのも、outbox の lock の外で行い、そのあと番号で outbox から消す。#266 が `stale_step` で registry を読むようになっても、outbox の lock の中で registry の lock を取らない
- 配達の送信が `run_busy` 以外の理由で断られたときは、標準エラーに書く
- 古いサーバーが run に残した知らせ(`run.notice`)の移行(`restore_notices`)は、TypeScript の `upsert` と同じく、run の変更を listener に知らせずに書き戻す。constructor の `resume_turns` が `result` を書き戻すときと同じ書き方
- news の slot は thread ごとに 1 つで、`queue_news` は前の文を置き換える。#268 が `merged_without_person` の `TurnEnded` で自分の知らせを入れても、このあとの `queue_turn_news` で置き換わる。#268 が知らせたいことは、`thread_turn_ended` が引く run の項目に書くか、#268 で別の形を決める

## 検討した代わり

- 直す Issue を別に開き、#264 がそれを待つ案。直す Issue が `landing.rs` から呼ぶ関数は #264 が `notices.rs` に作るので、直す Issue は #264 を待ち、#264 は直す Issue を待つ。待ち合いが輪になるので取らなかった
- 8 件のテストに `#[ignore]` を付け、#266 で外す案。テストを弱めることになり(決まりの関門 5)、#266 の受け入れ条件に外す項目がないので取らなかった
- `turns.rs` の `finalize` と `restart.rs` の `settle_unsent_turn` から `queue_turn_news` を直接呼ぶ案。呼ぶ所が 2 か所になり、O1 の `turns.rs` を書くことになるので取らなかった
- 文の組み立てを `landing.rs` に直接書く案。知らせの文が 2 つのファイルに分かれ、#264 の受け入れ条件(`threadQuestion` などは `notices.rs` にある)に反するので取らなかった

## 依存

なし。

## 結果

- #264 は、Issue の書くパスにない `rust/crates/orchestrator/src/fleet/landing.rs` のうち、`settle_thread_turn` の本体の 1 行とその上の注記だけを書く。この thread から coordinator にはメッセージを送れない(fleet のコマンドが別の group の run を見つけない)ので、#264 と #266 にコメントで残し、PR の「仮定」に書いた。0242 が「各ファイルは書くパスに挙げた Issue だけが書く」と決めた目的は、同時に走りうる Issue の書くパスを重ねないことで、これは保たれる。2026-11-11 の時点で `landing.rs` に触れたコミットは #256 の `ef0d125` だけで、#266、#267、#268 はいずれも #264 を(直接か #266 を通して)待つ
- #266 は、上の約束を守って、`settle_thread_turn` の本体に landing の手順、pull request の読み取り、`merged_without_person` の呼び出しを足す。`queue_turn_news` の呼び出しは消さない
- #265、#266、#268 は、上の表の口を使い、`notices.rs` を書かない
- `fleet/mod.rs` からは、`#264` の stub の印として残っていた `TimerKind::DraftRetry` と `Timers::has` の `#[allow(dead_code)]` を外した

## 確かめたこと

Linux(Omarchy、kernel 7.2.15)、`rust/` で、2026-11-11 に実行した。

- 実装の前に、`tests/notices.rs` の 12 件(移した 9 件と、配達の lock、`run.notice` の移行、outbox に残った landing の手順の 3 件)を `cargo test --locked -p herdr-fleet-orchestrator --test notices` で走らせ、11 件が期待値との違いで失敗した(例: `left: ["fix the retry"]` / `right: ["fix the retry", "[fleet] Threads ask the person. …"]`)。`are only questions` の 1 件は、知らせを送らないことを確かめる件で、何もしない stub の振る舞いが期待値と同じなので、先に失敗させられない
- 配達の lock のテストは、herdr が coordinator の画面を返すのに 40 ms かかる runtime の包みで、2 つの thread が同時に coordinator に知らせる。lock と `submit_when_free` の両方を外すと、coordinator に 2 つ目の指示文が入って失敗し、どちらか一方を残すと通った
- 実装のあとで、同じコマンドで 12 件が通った
- `/code-review high` の指摘で 2 件を足した。outbox に書けないときに `run.notice` を残す件と、人のいない project で coordinator が thread のターンの終わりを聞く件(期待値は `orchestrator.test.ts:2144-2162`)。どちらも、直しを戻すと失敗し(前者は `notice` が消え、後者は見出しを入れ替えると違う)、戻すと通った
- 14 件が通り、`cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace`(955 件が通り、失敗 0、既存の ignore が 11)も通った
