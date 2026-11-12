# ターンの決着は、その途中で fleet が送ったターンがある間は thread を起動し直さない

- 状態: 採用
- 決めた日: 2026-11-12
- Issue: #358

## 状況

ターンの決着(`turns.rs` の `finalize` と、`restart.rs` の `settle_unsent_turn`)は、ターンのファイル(`report.json` と handoff)を `turns` のロックの中で読んだあとも、画面の読み取り(`read_turn` の `runtime.read`)、`read_thread_work`、起動し直しのための thread のロック(`thread_locks`)の待ちと、await を挟んで続く。送信の入口(`send`、`land`、`answer_plan`)は `reconcile_locks.wait_idle` を通るので、この間に入りうる送信は、決着が始まる前に `wait_idle` を通り、base branch の読み取りなどの await で止まっていたものだけである。`land` は、base branch の読み取りから送信までを thread のロックの中で行う(`landing.rs` の `land_step`)。

#344 の `/code-review high` は、次の 2 つを挙げた。どちらも TypeScript の `settleUnsentTurn` と `finalize` に同じ形がある。

1. `read_turn` は、読んだファイルを画面の読み取りの await のあとで run に書く。この await の間に送ったターンが決着していると、そのターンの `result` と `outcome` を、前のターンの値で上書きする。
2. 前のターンが報告を残さなかったとき、`restart_thread` は、送ったばかりのターン(人が押した Create PR など)の途中で thread を起動し直し、前の run のペインを閉じる。`settle_unsent_turn` から起動し直すときは fleet の最後のメッセージを渡さないので、新しい run は、送った手順の文を知らずに始まる。

## 決定

- 2 は直す。`restart_thread` は、thread のロックの中で run を読み直すときに、`needs_restart` に加えて、fleet が送ったターンが進行中でない(`turn_in_flight` が偽)ことを確かめる。進行中なら起動し直さずに `None` を返し、前の run のペインも閉じない。起動し直すかどうかは、その送ったターンの決着(`finalize`)が、そのターンの報告から決める。送ったターンも報告なしで終われば、`finalize` が送った文を `last_message` に渡して起動し直す
- 確かめを thread のロックの中に置くのは、`land` がこのロックを持ったまま送信するため。決着がロックを待つ間に手順が送られても、ロックを取ったあとの確かめがそれを見る。ロックの外(`settle_unsent_turn` の中)で確かめると、確かめてからロックを取るまでの間に送られた手順を見落とす
- 確かめは `restart_thread` に置くので、`finalize` と `settle_unsent_turn` の両方に効く。`finalize` は、確かめの前に自分のターンを `pending` から外しているので、進行中のターンがあれば、それは決着の途中で送られた別のターンである
- 1 は直さない。同じ run の決着は `reconcile_locks` で 1 つずつ走る(`reconcile_run`。`finalize` と `settle_unsent_turn` を呼ぶのは `reconcile_now` だけ)。そのため、決着が画面を読む間に送ったターンが終わっても、そのターンの決着は、前の決着が終わるまで始まらない。前の決着が書いた値は、あとから走る送ったターンの決着が上書きする。上書きの順序が逆になることはない

## 検討した代わり

- `read_turn` で、ファイルを読んだときの generation を覚えておき、画面の読み取りのあとで generation が進んでいれば run に書かない案。1 は上の理由で起きないので、この確かめは働く場面がない。送ったターンが進行中のときに書かないようにすると、`finalize` の後半(`close_stale_plan`、`settle_thread_turn` のニュース)が、決着したターンではなく、その前のターンの `outcome` を読んで判断することになる
- 画面を先に読み、ファイルの読み取りと run への書き込みを await なしで続ける案。`finalize` で画面の読み取りを `pending` から外す前に移すと、その間に送られた手順(`land` は `submit_when_free` ではない)がターンのファイルを消し、決着が読む前に報告がなくなる(#240 の 2 の欠陥を戻す)
- `settle_unsent_turn` の中で、起動し直しの前に `turn_in_flight` を確かめる案。thread のロックを待つ間に送られた手順を見落とす(上の決定の 2 つ目)

## 依存

なし

## 結果

- 決着の途中で fleet が手順を送ったとき、thread は前の run のまま続き、そのペインも閉じない。起動し直しは、送ったターンの決着が、そのターンの報告と送った文から決める
- 決着の途中で手順が送られ、起動し直さなかったとき、`settle_unsent_turn` と `finalize` の残り(`settle_thread_turn`)は今までどおり走る。報告のないターンのニュースは、今までどおり outbox の `news` の枠に入る。coordinator に届く前に送ったターンが決着すれば、そのニュースが同じ枠に入って置き換える。このニュースを止めるかどうかは、この Issue では決めない
- 1 が起きないことは、決着が run ごとに直列であることに依っている。`reconcile_locks` の外から決着を呼ぶ変更をするときは、1 を考え直す

## 確かめたこと

- `rust/crates/orchestrator/tests/restart.rs` に 3 件を足し、実装の前に `rust/` で `cargo test --locked -p herdr-fleet-orchestrator --test restart -- leaves_the_restart_to starts_the_thread_again_under settles_a_steps_turn` を走らせて、3 件とも失敗することを確かめた
  - `leaves_the_restart_to_the_turn_of_a_step_the_fleet_sent_while_a_turn_that_left_no_report_was_settled`(決着が画面を読む間に Create PR を送る): `panicked at crates/orchestrator/tests/restart.rs:1036:5: assertion failed: t.restarts().is_empty()`
  - `starts_the_thread_again_under_its_lock_only_when_no_step_went_out_while_the_settlement_waited_for_it`(決着が thread のロックを待つ間に Create PR を送る): `panicked at crates/orchestrator/tests/restart.rs:1059:5: assertion failed: t.restarts().is_empty()`
  - `settles_a_steps_turn_that_ended_while_a_turn_before_it_was_settled_after_that_settlement`(1 の順序): 決着が画面を読む間に、送ったターンが報告を書いて終わっても、その時点の `outcome` は前のターンのまま(`Waiting for the helper.`)であることを確かめる assert は、実装の前にも通った。送ったターンの決着が前の決着を待つことの確かめになる。最後の assert は `left: "Some(NoReport { problem: \"report.json is missing.\" })"`、`right: "Opened the pull request."` で失敗した。前の決着が thread を起動し直して前の run を止めたので、送ったターンが決着しなかったため
- 実装のあと、`cargo test --locked -p herdr-fleet-orchestrator --test restart` で 30 件が通った(Linux、rustc は `rust/rust-toolchain.toml` の版)
