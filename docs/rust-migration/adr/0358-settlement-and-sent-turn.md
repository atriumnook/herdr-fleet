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

- 2 は直す。`restart_thread` は、thread のロックの中で run を読み直すときに、`needs_restart` に加えて、fleet が送ったターンが進行中でない(`pending` にない)ことを確かめる(`leave_restart`)。進行中なら起動し直さず、前の run のペインも閉じない。そのターンの決着(`finalize`)が、そのターンの報告から起動し直すかを決め、報告がなければ送った文を `last_message` に渡して起動し直す
- 確かめを thread のロックの中に置くのは、`land` がこのロックを持ったまま送信するため。ロックの外で確かめると、確かめてからロックを取るまでの間に送られた手順を見落とす。確かめは `restart_thread` にあるので、`finalize` と `settle_unsent_turn` のどちらから起動し直すときも、この確かめを通る。`finalize` は自分のターンを先に `pending` から外しているので、進行中のターンは決着の途中で送られた別のターンである
- `restart_thread` は、ロックの中で決めた結果を `Restart`(`Done`、`Deferred`、`Failed(<理由>)`)で返す。ロックの外で `turn_in_flight` を読み直して決めると、ロックの中の判定と食い違いうる(起動し直しに失敗した直後に手順が送られると、失敗の理由がニュースに載らない。2 回目の `/code-review high` の指摘)
- 起動し直しと、そのあとの thread の決着(計画を閉じること、landing の手順の判定、coordinator へのニュース)は、`restart.rs` の `settle_lead_turn` 1 つにまとめ、`finalize` と `settle_unsent_turn` の両方がこれを呼ぶ。決着が読んだターンは `LeadTurn`(fleet が送った文と、送ったターンなら generation と `submitted_at`)で渡す。起動し直しをそのターンに任せたとき(`Deferred`)、`settle_lead_turn` は thread の決着もしない。しないと、報告のないターンのニュース(`ended its turn: no report`)が outbox に入り、手順に取りかかっている lead について coordinator に届く(`/code-review high` の指摘)。`updated_at` の更新と、coordinator への知らせ(outbox にほかの知らせがあるとき)は今までどおり行う
- 起動し直しを任せるとき、`restart_thread` は決着が読んだターン(`LeadTurn`)を、送ったターンの `PendingTurn` の `restart_left` に預ける
  - 送ったターンが lead に届かずに捨てられたとき(`submit_with` で prompt が失敗した、取り消された)は、そのターンの決着が来ない。そのため、預けたターンの `settle_lead_turn` を、その場で別の task で、run の `reconcile_locks` の中で走らせる(`settle_left_restart`)。決着は run ごとに 1 つずつで、fleet が止まったあとは走らせない
  - herdr が、lead が質問の画面で待っているとして prompt を断ったとき(`RuntimeError::Blocked`)は、起動し直さずに thread の決着だけをする(`may_restart` が偽)。起動し直すと、質問の画面ごとペインを閉じるため。報告のないターンのニュースは、このとき coordinator に届く。人が答えれば lead はそのターンを続け、その終わりの決着が起動し直すかを決める。このときも、ほかの送ったターンが進行中なら、thread の決着はそのターンに預ける(`/code-review high` の指摘)
  - 捨てるのは自分の generation のターンだけで、送信の途中に別の送信が置き換えたターンは残す(`drop_turn`)。今までの `drop_pending` は、置き換えたターンまで捨てていた。送ったターンが進行中のまま別の送信がそれを置き換えたときは、新しいターンが預けたターン(`restart_left`)を引き継ぐ
  - 送信の途中に決着が入りうるのは、thread のロックを持たず、`wait_idle` のあとで await を挟む送信である。lead が自分で始めた thread のニュースを lead に届ける `deliver_notices` がそれに当たる(codex のレビューの指摘)。`land` は送信を終えるまでロックを持つので、ロックの中で見る送ったターンは、届いたか捨てられたかのどちらかである
- waiter は、待ったターンの generation を持つ。`finalize` と `report_blocked` は、決着したターンまでの waiter だけを起こし、`settle_unsent_turn` は、決着が読んだ時点で最後に送ったターンまでの waiter だけを起こす。決着の途中で送ったターンの waiter は、そのターンが決着するまで待つ。run の id だけで起こすと、`fleet wait` が、送ったばかりの Create PR のターンの途中で返る(codex のレビューの指摘)。ペインが終わったとき、thread を閉じたときは、今までどおりすべての waiter を起こす
- 1 は直さない。`finalize` と `settle_unsent_turn` の doc に、run の `reconcile_locks` の中からだけ呼ぶことを書いた。同じ run の決着は `reconcile_locks` で 1 つずつ走る(`finalize` と `settle_unsent_turn` を呼ぶのは `reconcile_now` だけで、`reconcile_now` は `reconcile_run` がこのロックの中で呼ぶ)。決着が画面を読む間に送ったターンが終わっても、そのターンの決着は前の決着が終わってから走り、あとから書く

## 検討した代わり

- `read_turn` で、ファイルを読んだときの generation が画面の読み取りのあとで進んでいれば書かない案。1 は起きないので、この確かめが働く場面がない。送ったターンが進行中のときに書かないようにすると、`finalize` の後半が、決着したターンではなくその前のターンの `outcome` で判断する
- 画面を先に読み、ファイルの読み取りと書き込みを await なしで続ける案。`finalize` で画面の読み取りを `pending` から外す前に移すと、その間に送られた手順(`land` は `submit_when_free` ではない)がターンのファイルを消し、決着が読む前に報告がなくなる(#240 の 2 の欠陥を戻す)

## 依存

なし

## 結果

- 決着の途中で fleet が手順を送ったとき、thread は前の run のまま続き、そのペインも閉じない。起動し直し、計画を閉じること、landing の手順の判定、coordinator へのニュースは、送ったターンの決着が、そのターンの報告から行う。計画は、送ったターンの `submitted_at` より前に出たものが閉じる対象になるので、前のターンのあとに出た計画も含まれる
- 送ったターンが lead に届かなければ、預けたターンの決着がその場で thread を起動し直す。起動し直せなければ、ニュースにその理由が載る。lead が質問の画面で待っていたときは起動し直さず、報告のないターンのニュースだけを coordinator に送る。起動し直すかは、人が答えたあとのターンの決着が決める
- 送ったターンの途中でペインが終わると(`on_pane_ended`、`reconcile_now` の `NotFound`)、送信が届く前か後かによらず、run は `stopped` になり、預けた起動し直しはしない。ペインが終わったのは、エージェントが終わったか、人が閉じたかで、どのターンの途中でも run を止めるのが今までの振る舞いである。預けたターンの thread の決着は、起動し直さずに行う(`drop_ended_turn`)ので、報告のないターンのニュースは coordinator に届く。この変更の前は、同じ順序なら、ペインが終わる前に決着が thread を起動し直していた。ここだけは振る舞いが変わる
- `finalize` の残りのうち `close_on_settle` は `turn_in_flight` で、`respawn_after_failure` は generation で止まるので、送ったターンの途中のペインを閉じない
- 1 が起きないことは、決着が run ごとに直列であることに依る。`reconcile_locks` の外から決着を呼ぶ変更をするときは、1 を考え直す

## 確かめたこと

- `rust/crates/orchestrator/tests/restart.rs` に 3 件を足し、実装の前に `rust/` で `cargo test --locked -p herdr-fleet-orchestrator --test restart -- leaves_the_restart_to starts_the_thread_again_under settles_a_steps_turn` を走らせて、3 件とも失敗することを確かめた。`leaves_the_restart_to_the_turn_of_a_step_the_fleet_sent_while_a_turn_that_left_no_report_was_settled`(決着が画面を読む間に Create PR を送る)と `starts_the_thread_again_under_its_lock_only_when_no_step_went_out_while_the_settlement_waited_for_it`(決着が thread のロックを待つ間に送る)は `assertion failed: t.restarts().is_empty()` で失敗した
- `settles_a_steps_turn_that_ended_while_a_turn_before_it_was_settled_after_that_settlement`(1 の順序)では、決着が画面を読む間に送ったターンが報告を書いて終わっても、その時点の `outcome` が前のターンのまま(`Waiting for the helper.`)であることの assert が、実装の前にも通った。最後の assert は、前の決着が前の run を止めたため `left: "Some(NoReport { problem: \"report.json is missing.\" })"`、`right: "Opened the pull request."` で失敗した
- `/code-review high` の指摘のあと、1 件目のテストに outbox のニュースの assert を足し、`["\"Fix\" (…) ended its turn: no report — report.json is missing."]` で失敗することを確かめてから、任せたときに thread の決着をしないようにした
- 確かめを一時的にロックの外(`settle_unsent_turn` の中)に移すと、ロックを待つ間に送るテストだけが失敗した(`restart.rs:1088`)。テストがロックの中に置くことを確かめている
- codex のレビュー(head `1b1bba7`)のあと、2 件を足し、実装の前に失敗することを確かめた。`starts_the_thread_again_when_the_turn_a_settlement_left_the_restart_to_never_reached_the_lead`(lead が始めた thread のニュースを、決着の途中で lead に打ち、herdr が失敗する)は ``assertion `left == right` failed``(`left: 0`、`right: 1`。run は `state: Failed`、`replaced_by: None`)で、`wakes_a_waiter_on_a_step_sent_while_the_turn_before_was_settled_once_the_steps_turn_settles`(送ったターンの決着の途中で Create PR を送り、`fleet wait` する)は `the wait ended before the step's turn did` で失敗した
- その後の `/code-review high` のあと、`keeps_a_lead_that_waits_on_a_question_when_the_turn_a_settlement_left_the_restart_to_is_refused`(herdr が `Blocked` で断る)を足し、実装の前に `assertion failed: t.restarts().is_empty()` で失敗することを確かめた
- 5 回目の `/code-review high` のあと、そのテストにニュースの assert を、`a_cancelled_send_leaves_the_turn_sent_over_it_to_be_settled`(送信の途中に別の送信が置き換え、前の送信が取り消される)を足した。実装を一時的に前の形に戻すと、前者はニュースの assert で、後者は `left: "Waiting for the helper."`、`right: "Went on with this."` で失敗した
- 6 回目の `/code-review high` のあと、`tells_of_the_turn_that_left_no_report_when_the_leads_pane_ends_during_the_step_it_left_the_restart_to`(任せた送ったターンの途中でペインが終わる)を足し、実装の前に、ニュースが前のターンのまま(`ended its turn: waiting`)であることで失敗することを確かめた
- 実装のあと、`cargo test --locked -p herdr-fleet-orchestrator` がすべて通った(Linux、rustc は `rust/rust-toolchain.toml` の版)
