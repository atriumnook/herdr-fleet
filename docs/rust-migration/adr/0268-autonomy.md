# 人のいない project の監督を orchestrator に移すときの、TypeScript との違い

- 状態: 採用
- 決めた日: 2026-11-11
- Issue: #268
- 置き換える: なし

## 状況

#268(O8)は、使う人がいない間に project を進める監督(`server/fleet/orchestrator.ts:1060-1131` の `superviseProjects`、`reconcileThread`、`callStandstill`、`tellWhenFree` と、`:1812-1830` の知らせの文 `threadMerged`、`standstill`、`threadClosedAfterMerge`)を、`rust/crates/orchestrator/src/fleet/autonomy.rs` に移す。人のいない project でマージを読んだときの扱いは、O1(ADR `0256-orchestrator-foundation`)が置いた hook `merged_without_person(thread, reading, seen: MergeSeen)` の中身として書く。この hook は、#266(ADR `0266-landing`)が 3 か所から呼ぶ。

- `settle_thread_turn` が、pull request を記録した thread のターンの決着の中で MERGED と読んだとき(`TurnEnded`)。このあとにターンの知らせが続き、知らせは run の `pr` と `landed` を引用する(ADR `0264-notices`)
- `refresh_pull_requests` の自律の分岐(`Polled`)
- pull request を記録していない thread のターンの知らせを入れたあとで、別の task で読んだとき(#176 の 7。`Polled`)

移すにあたって、Issue が挙げた main の欠陥(#176 の 1・2・3・5、#189 の 3)を Rust 版で作らない形を決める必要があった。#176 は 2026-11-11 の時点で main でも直っていない(Issue は open)ので、期待値の根拠は Issue #268 の「Rust 版の期待」である。#189 の 3(`checkAnomalies`)は main の `7d2f878` で `checkAnomalies` ごとなくなり、`rust` にも入っている。そのため、着手した時点の `rust` の TypeScript には `checkAnomalies` がない。

書くパスは `autonomy.rs` と `tests/autonomy.rs` だけで、`notices.rs`、`landing.rs`、`fleet/mod.rs` は書かない(ADR `0242-phase-3-split`)。crate の interface は変えない。`supervise_projects` は `Orchestrator` の公開の method として `autonomy.rs` に置き、`MergeSeen` の re-export は O1 が置いたものを使う。`fleet/mod.rs` に足す行はない。

## 決定

1. **ターンの決着の中で読んだマージ(`TurnEnded`)。** lead の report が `progress` か `waiting`(lead がまだ続ける)と言うときは、thread を閉じない。それ以外(report がないときを含む)は、TypeScript と同じく `merged_on_github` で閉じる。lead がマージしたあとで helper を待つためにターンを切ると、report は `waiting` になる。このとき thread を閉じると、lead が Issue を閉じる前に thread が閉じる(#176 の 1)。hook は coordinator への知らせを入れない。続くターンの知らせが、`Pull request #N: MERGED` と、閉じたときは `, and the thread is closed` を引用するため。同じ thread について、まだ届けていないマージの知らせ(決定 4 の slot)があれば消す。ターンの知らせと同じことを 2 回伝えないため。ただし、ターンの知らせが lead の質問(`threadQuestion`。report が `blocked` か `human_action` を持つとき)なら、質問は pull request も閉じたことも引用しないので、決定 2 と同じ文(閉じたとき)か `threadMerged`(閉じないとき)を、別の行で伝える(`/code-review` の指摘)。`TurnEnded` で閉じるときも、`Polled` で閉じるときと同じく thread の lock(`on_lead`)の中で閉じる。2 つが同時に同じ thread を閉じないため。

2. **決着の外で読んだマージ(`Polled`)。** TypeScript の `refreshPullRequests` と同じく、thread を閉じずに、coordinator に `threadMerged` を 1 回だけ伝える(同じ thread について 2 回目は伝えない)。ただし、thread の fleet(lead と helper)のどの run も働いておらず、lead の最後の report が `ready` か `dropped`(lead の作業が終わった)のときは、thread を閉じ、次の文を伝える。

   ```text
   "<title>" (<id>, <branch>): GitHub shows pull request #<N> merged and its lead's last report says <state>, so the fleet closed the thread. Close its issue if it is still open.
   ```

   「閉じた」と伝えるのは、閉じたあとで run を読み直し、`landed` が書かれていたときだけである(repository かブランチの記録がないと、`merged_on_github` は閉じずに戻る。`/code-review` の指摘)。

   閉じる場合を足したのは、#266 が pull request のない thread のターンのあとの読み取りを `Polled` にしたためである。TypeScript は、lead が 1 つのターンで pull request を開いてマージした thread を、そのターンの終わりに閉じていた(`orchestrator.test.ts` の describe `a project run without the person` の 2 件目と 3 件目)。`Polled` で閉じないと、lead が 1 つのターンで pull request を開いてマージするたびに、thread とそのペインが静かな時間(15 分)だけ残る。文は `threadClosedAfterMerge` の形にそろえた。`threadMerged` の「the thread closes once its lead's turn ends」は、閉じたあとには当たらないため。

3. **静かな時間のあとの照合(`reconcileThread`)。**
   - thread が「落ち着いている」と見るのは、lead だけでなく、thread の fleet のどの run も働いていない(fleet のターンが進行中でなく、herdr の状態が `working` でも `starting` でもない)ときにする。TypeScript は lead の状態だけを見るので、helper の結果を待つ lead が静かな時間を越えると、helper が働いていても thread を閉じた(#176 の 1)
   - 照合するのは、人のいない project のすべての生きている thread で、coordinator が生きているかによらない。TypeScript は生きている coordinator ごとにその thread を照合するので、coordinator が終わると thread と worktree とブランチが残り続けた(#176 の 3)。閉じた知らせは outbox に残り、project の次の coordinator が受け取る(`hearerOf` の決まりのまま)
   - ある project で thread を閉じた回の監督では、その project の停滞の知らせを送らず、静かになった時刻をその時点に置き直す。閉じた知らせが coordinator に届く前に停滞の知らせが割り込まないため。TypeScript では、`void this.tellCoordinator(closed)` が最初の await までに配達の lock を取るので、同じ回の `callStandstill` は送らない。Rust の `tokio::spawn` はその場で走らないので、同じ結果を明示的に作った

4. **マージの知らせの置き場所。** 監督がマージについて伝える文(`threadMerged`、決定 2 の文、`threadClosedAfterMerge`)は、outbox の slot `merge`、section `news` に入れる。thread の質問やターンの終わりの知らせ(slot `news`)とは別の slot なので、どちらも相手を上書きしない。同じ section なので、1 つのメッセージで、人のいない project の見出し `NEWS_HEADER` の下に並んで届く(#176 の 2)。`queue_news` は slot `news` だけを書くので、`autonomy.rs` は `outbox.put` を直接呼ぶ。`notices.rs` を書かないため。

5. **停滞の知らせ(`tellWhenFree`)。** 配達の lock(`start_delivering`)を取り、知らせを送り終えるまで持つ。送信は `outbox.send_now` と `submit_when_free` の組み合わせで行い、最後の await(下書きの確認)のあとに始まった fleet のターンを、turns の lock の中で見つけて `run_busy` で断る(#176 の 5)。`notify_now` は `submit` で送るので使わない。この組み合わせは `landing.rs` の `send_lead_step` と同じ形の写しで、`notices.rs` の private な `has_draft` も `draft_in_input` として写した。どちらも #340(`notify_now` を `submit_when_free` で送る)で 1 か所にできるので、#340 にコメントした。

6. **#189 の 3。** 監督が herdr に問い合わせるのは、停滞の知らせを送ろうとする coordinator の状態と画面だけで、1 回の監督で 1 回である。thread と helper については、registry の状態とターンの表だけを見る。main の #238 のあと(`checkAnomalies` がない)の振る舞いと同じ。

7. **テスト。** `orchestrator.test.ts` の describe `a project run without the person` の 11 件を `tests/autonomy.rs` に移した。次の点が TypeScript と違う。
   - TypeScript の reviewer は agy で動く。Rust の fleet は agy の reviewer を断る(main の #190、ADR `0248-launch-adapters`)ので、pi で動かす。11 件のどれも CLI の種類に依らない
   - 2 件目と 3 件目は、coordinator が聞く文が決定 2 のとおり 2 行に分かれる(#266 の #176 の 7 による)
   - 3 件目と 11 件目は、fleet が送っていないターンの決着(`settle_unsent_turn`、#267)を使う。#267 が入る前は `#[ignore]` にし、#267 が rust に入ったあとで外した。11 件目は、最後のターンを fleet が送ったターンにした件でも確かめる

8. **監督が覚えていること。** 静かになった時刻、停滞を伝えたこと、thread が落ち着いた時刻、GitHub に聞いた時刻、マージを伝えたことは、監督のたびの終わりに、終わった run と閉じた thread の分を消す(`/code-review` の指摘)。

## 検討した代わり

- `TurnEnded` でも `Polled` でも閉じず、静かな時間のあとの照合だけで閉じる案: Issue の「閉じるのを待つ」を字のとおりに満たす。しかし、マージのたびに thread のペインが 15 分残り、同時に動く run の上限を占める。lead の report は、lead が続けるかどうかを lead 自身が書いたものなので、決定 1 と 2 ではこれで判断した
- `Polled` で閉じる条件を `TurnEnded` と同じ(report が `progress` か `waiting` でなければ閉じる)にする案: report のない lead も閉じることになり、`orchestrator.test.ts` の 11 件目(ポーリングで見つけたマージで、report のない lead の thread を開いたままにする)と合わない
- 決着の外で読んだマージのときに、まだ届けていないターンの知らせを `queue_turn_news` で書き直す案: TypeScript と同じ 1 行の文になる。しかし、配達がメッセージを打ち込んでいる間に書き直すと、書き直した知らせが outbox に残り、同じターンの知らせが 2 回届く。ADR `0266-landing` が退けた案と同じ問題がある
- `notify_now` を使う案: `submit` で送るので、下書きの確認のあとに始まったターンを見つけられない(#176 の 5)。#340 が入れば使える

## 依存

なし。

## 結果

- core(LIVE、#270)と API(#269)は、`refresh_pull_requests` のあとで `supervise_projects` を呼ぶ(TypeScript のサーバーと同じ順)
- #340 は、`autonomy.rs` の `tell_when_free` の送信と `draft_in_input` も、`notify_now` と `notices.rs` の確認に置き換えられる。#340 の書くパスには `autonomy.rs` がないので、置き換えるときは書くパスに足す
- 人のいない project で thread が閉じる時期は、lead の report に依る。lead が report を書かずにターンを終えると、`TurnEnded` では閉じ、`Polled` では閉じない

## 確かめたこと

Linux(Omarchy、kernel 7.2.15)、`rust/` で、2026-11-11 に実行した。

- 実装の前に、`supervise_projects` を `todo!` の stub にして `cargo test --locked -p herdr-fleet-orchestrator --test autonomy` を走らせ、16 件のうち 13 件が失敗した(`not yet implemented: #268`、`timed out: the thread closed`、`left: None` / `right: Some(Merged)` など)。先に通った 3 件(1 件目、4 件目、8 件目)は、#264 と turns がすでに満たしている
- 実装のあとで、同じコマンドで 16 件が通り、2 件が ignored になった。20 回続けて走らせ、20 回とも通った
- `/code-review high` の指摘で、質問で終わったターンでマージを読んだ件を足した。直す前のコードでは、coordinator が閉じたことを聞かずに失敗し(`tests/autonomy.rs:1065` の assert)、直したあとは通った。17 件が通り、2 件が ignored
- #267 が rust に入ったあとで rust を取り込み、`#[ignore]` の 2 件を外した。同じコマンドで 19 件すべてが通った
- #176 の 5 の件は、`tell_when_free` を TypeScript と同じ形(配達の lock を持たず、`submit` で送る)に一時的に戻すと、coordinator に 2 つのメッセージが入って失敗し、戻すと通った
- `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace` が通った(#267 を取り込んだあとで 1053 件が通り、13 件が ignored。ignored に `tests/autonomy.rs` の件はない)
