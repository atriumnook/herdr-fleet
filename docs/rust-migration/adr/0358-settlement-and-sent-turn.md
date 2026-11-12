# ターンの決着は、その途中で fleet が送ったターンがある間は thread を起動し直さず、thread の決着をそのターンに任せる

- 状態: 採用
- 決めた日: 2026-11-12
- Issue: #358

## 状況

ターンの決着(`turns.rs` の `finalize` と、`restart.rs` の `settle_unsent_turn`)は、ターンのファイルを `turns` のロックの中で読んだあとも、画面の読み取り(`read_turn` の `runtime.read`)、`read_thread_work`、起動し直しのための thread のロック(`thread_locks`)の待ちと、await を挟んで続く。この間に入りうる送信は、決着が始まる前に `reconcile_locks.wait_idle` を通り、base branch の読み取りなどの await で止まっていたものだけである。`land` は、base branch の読み取りから送信までを thread のロックの中で行う(`landing.rs` の `land_step`)。

#344 の `/code-review high` は次の 2 つを挙げた。どちらも TypeScript の `settleUnsentTurn` と `finalize` に同じ形がある。

1. `read_turn` は、読んだファイルを画面の読み取りの await のあとで run に書く。この await の間に送ったターンが決着していると、そのターンの `result` と `outcome` を前のターンの値で上書きする。
2. 前のターンが報告を残さなかったとき、`restart_thread` は、送ったばかりのターン(人が押した Create PR など)の途中で thread を起動し直し、前の run のペインを閉じる。`settle_unsent_turn` からは fleet の最後のメッセージを渡さないので、新しい run は送った手順の文を知らずに始まる。

## 決定

- 2 は直す。`restart_thread` は、thread のロックの中で run を読み直すときに、`needs_restart` に加えて、fleet が送ったターンが進行中でない(`turn_in_flight` が偽)ことを確かめる。進行中なら起動し直さず、前の run のペインも閉じない。そのターンの決着(`finalize`)が、そのターンの報告から起動し直すかを決め、報告がなければ送った文を `last_message` に渡して起動し直す
- 確かめを thread のロックの中に置くのは、`land` がこのロックを持ったまま送信するため。ロックの外で確かめると、確かめてからロックを取るまでの間に送られた手順を見落とす。確かめは `restart_thread` にあるので、`finalize` と `settle_unsent_turn` のどちらから起動し直すときも、この確かめを通る。`finalize` は自分のターンを先に `pending` から外しているので、進行中のターンは決着の途中で送られた別のターンである
- `restart_thread` は、ロックの中で決めた結果を `Restart`(`Done`、`Deferred`、`Failed(<理由>)`)で返す。呼び手は `Deferred` を見て、起動し直しをそのターンに任せたことを知る。ロックの外で `turn_in_flight` を読み直して決めると、ロックの中の判定と食い違いうる(起動し直しに失敗した直後に手順が送られると、失敗の理由がニュースに載らない。2 回目の `/code-review high` の指摘)
- 起動し直しをそのターンに任せたとき(`Deferred`)、決着は thread の決着も任せる。`settle_unsent_turn` は `settle_thread_turn` と waiter への知らせをしない(このとき待っている waiter は、送ったターンの waiter である)。`updated_at` の更新と coordinator への知らせ(outbox にほかの知らせがあるとき)は今までどおり行う。`finalize` は `close_stale_plan` と `settle_thread_turn` をしない。しないと、報告のないターンのニュース(`ended its turn: no report`)が outbox に入り、手順に取りかかっている lead について coordinator に届く(`/code-review high` の指摘)。`finalize` の残り(waiter への知らせなど)は、#240 の 2 の場合と同じく今までどおり走る
- 1 は直さない。`finalize` と `settle_unsent_turn` の doc に、run の `reconcile_locks` の中からだけ呼ぶことを書いた。同じ run の決着は `reconcile_locks` で 1 つずつ走る(`finalize` と `settle_unsent_turn` を呼ぶのは `reconcile_now` だけで、`reconcile_now` は `reconcile_run` がこのロックの中で呼ぶ)。決着が画面を読む間に送ったターンが終わっても、そのターンの決着は前の決着が終わってから走り、あとから書く

## 検討した代わり

- `read_turn` で、ファイルを読んだときの generation が画面の読み取りのあとで進んでいれば書かない案。1 は起きないので、この確かめが働く場面がない。送ったターンが進行中のときに書かないようにすると、`finalize` の後半が、決着したターンではなくその前のターンの `outcome` で判断する
- 画面を先に読み、ファイルの読み取りと書き込みを await なしで続ける案。`finalize` で画面の読み取りを `pending` から外す前に移すと、その間に送られた手順(`land` は `submit_when_free` ではない)がターンのファイルを消し、決着が読む前に報告がなくなる(#240 の 2 の欠陥を戻す)

## 依存

なし

## 結果

- 決着の途中で fleet が手順を送ったとき、thread は前の run のまま続き、そのペインも閉じない。起動し直し、計画を閉じること、landing の手順の判定、coordinator へのニュースは、送ったターンの決着が、そのターンの報告から行う。計画は、送ったターンの `submitted_at` より前に出たものが閉じる対象になるので、前のターンのあとに出た計画も含まれる
- 送ったターンの途中でペインが終わると、run は `stopped` になり、起動し直されない。送ったターンの送信が失敗すると(`submit_with` が `drop_pending` して `failed` にする)、やはり起動し直されない。どちらも、決着の途中かどうかに関係なく、今までの振る舞いと同じである。`finalize` の残りのうち `close_on_settle` は `turn_in_flight` で、`respawn_after_failure` は generation で止まるので、送ったターンの途中のペインを閉じない
- 1 が起きないことは、決着が run ごとに直列であることに依る。`reconcile_locks` の外から決着を呼ぶ変更をするときは、1 を考え直す

## 確かめたこと

- `rust/crates/orchestrator/tests/restart.rs` に 3 件を足し、実装の前に `rust/` で `cargo test --locked -p herdr-fleet-orchestrator --test restart -- leaves_the_restart_to starts_the_thread_again_under settles_a_steps_turn` を走らせて、3 件とも失敗することを確かめた。`leaves_the_restart_to_the_turn_of_a_step_the_fleet_sent_while_a_turn_that_left_no_report_was_settled`(決着が画面を読む間に Create PR を送る)と `starts_the_thread_again_under_its_lock_only_when_no_step_went_out_while_the_settlement_waited_for_it`(決着が thread のロックを待つ間に送る)は `assertion failed: t.restarts().is_empty()` で失敗した
- `settles_a_steps_turn_that_ended_while_a_turn_before_it_was_settled_after_that_settlement`(1 の順序)では、決着が画面を読む間に送ったターンが報告を書いて終わっても、その時点の `outcome` が前のターンのまま(`Waiting for the helper.`)であることの assert が、実装の前にも通った。最後の assert は、前の決着が前の run を止めたため `left: "Some(NoReport { problem: \"report.json is missing.\" })"`、`right: "Opened the pull request."` で失敗した
- `/code-review high` の指摘のあと、1 件目のテストに outbox のニュースの assert を足し、`["\"Fix\" (…) ended its turn: no report — report.json is missing."]` で失敗することを確かめてから、任せたときに thread の決着をしないようにした
- 確かめを一時的にロックの外(`settle_unsent_turn` の中)に移すと、ロックを待つ間に送るテストだけが失敗した(`restart.rs:1088`)。テストがロックの中に置くことを確かめている
- 実装のあと、`cargo test --locked -p herdr-fleet-orchestrator` で 595 件が通った(Linux、rustc は `rust/rust-toolchain.toml` の版)
