# lead のあとを継ぐ thread(起動し直し)を restart.rs に移す

- 状態: 採用
- 決めた日: 2026-11-11
- Issue: #267

## 状況

#267(O7)は、thread の lead の run が失敗したとき、またはターンが報告なしで終わったときに、thread を別の CLI の新しい run で起動し直す TypeScript の処理を、`rust/crates/orchestrator/src/fleet/restart.rs` に移す。移すのは `server/fleet/orchestrator.ts` の `settleUnsentTurn`(`:1503-1514`)、`restartThread`(`:1526-1529`)、`startThreadAgain`(`:1531-1579`)、`needsRestart`(`:1766`)、`carried`(`:1769-1775`)、`carryFiles`(`:636-640`)、`recoveryTask`(`:1781-1795`)。受け入れ条件は、`orchestrator.test.ts` の describe `a thread outlives its lead run`(`:1196-1843`、22 件)を Rust のテストに移すこと。

O1(#256)は、これらの hook の signature を `restart.rs` に stub で置いた。`turns.rs` の `finalize` と `reconcile_now` が `needs_restart`、`restart_thread`、`settle_unsent_turn` を呼び、`spawn.rs` の `spawn_attempt` と `prepare` が `carry_over` と `carry_files` を呼ぶ。この Issue が書いてよいのは、`restart.rs`、`tests/restart.rs`、`fleet/mod.rs`(`pub use` の追加だけ)と、この ADR だけである。

#267 の本文は、#240 の 3 を Rust 版に写さないよう求めている。欠陥は、起動し直しがすべての候補で失敗したとき、そのターンより前に書かれた計画が答えを待ったまま残ること。ADR `0265-plans` は、計画を閉じる条件の直しを `turns.rs` の `finalize` に置き、`turns.rs` だけを書く #338 に分けた。#338 はまだ開いている。

## 決定

- 7 つの関数を、TypeScript と同じ順序と条件で `restart.rs` に書く。hook の signature は O1 が置いたままにし、`mod.rs` は変えない。crate の外に出す関数はない
- `restart_thread` は、thread のロック(`thread_locks`)の中で run を id で読み直し、`needs_restart` が真のときだけ `start_thread_again` を呼ぶ。ロックの中で読み直すので、ロックを待つ間に人が押した landing の手順(Discard、Merge into main)を見てから起動し直す。`landing.rs` の `on_thread` は private なので、同じロックを `self.inner.thread_locks` から直接使う
- `start_thread_again` は、`launch` を通らずに `spawn_with_fallbacks` を呼ぶ(TypeScript の `spawnWithFallbacks` と同じ。依頼文の検査と depth の検査を通らない)。depth は `run.depth - 1` で、`spawn_attempt` が 1 を足すので、新しい run の depth は前の run と同じになる
- 新しい run が thread を引き継いだときの順序は TypeScript と同じにする。前の run に `replaced_by` を書く、landing の手順を新しい run に渡す、outbox の news を捨てて残りの知らせを新しい run に移す、前の run の `landing` を消す、ペインを閉じる、`stopped` にする、進行中のターンを消す、の順。`replaced_by` をペインを閉じる前に書くのは、閉じている間に新しい run のターンが終わったとき、その決着が前の run ではなく新しい run を起動し直すため(テスト `hands a step pressed during a second restart of the thread to the lead that restart starts`)
- `restart_thread` が `Some` を返すのは、新しい run が thread を引き継がなかったときだけにする。中断(`Cancelled`)では `None` を返す(ADR `0265-plans` の #267 との約束)。起動し直しは呼び手が待つものではないので、`spawn_with_fallbacks` には新しい `CancellationToken` を渡し、実際には中断されない
- `carry_over` は、前の run を registry から読み直してから受け継ぐ。TypeScript の `carried` は、新しい run の記録を作る時点(`createLocation` の await のあと)で、前の run の共有のオブジェクトを読む。起動し直しを始めたときの写しを使うと、ペインを作る間に前の run に入った変更(計画への答え、pull request の読み取り)が新しい run に渡らない(`/code-review high` の指摘)
- 前の run の記録がなくなっていても、`hand_over` は outbox の知らせの移動、ペインを閉じること、進行中のターンを消すことを続ける。outbox の news を捨てる書き込みが失敗しても、知らせの移動は試す(どちらも `/code-review high` の指摘)
- restart の event の `error` は、TypeScript と同じく UTF-16 で 200 単位までに切る(`reason.slice(0, 200)`)。`restart_thread` が返す理由は切らない
- `settle_unsent_turn` は、fleet が送ったターンが進行中(`turn_in_flight`)のときは何もしない。TypeScript にはないこの確かめを足したのは、送ったターンがターンのファイル(`report.json` と handoff)を消したあとに読むと、報告がないと判定して、送ったターンの途中で thread を起動し直すため。確かめと読み取りの間に await はないが、`turns.rs` のロックの外なので、multi-thread の runtime では間に送信が入る余地が残る。この余地をなくすには `turns.rs` に、ロックの中でファイルを読む関数が要るので、#344 に分けた
- `carry_files` が契約のファイルを書けなかったときは、ログに出して新しい run を起動する。TypeScript では書き込みの例外で起動が失敗する。O1 が置いた hook は値を返さず、`spawn.rs` も書けないので、失敗を起動の失敗にはできない
- `answer_plan` が閉じた計画に返す `plan_closed` の文(「The lead of X went on without answers to version N of its plan.」)は変えない。#338 の注意は、失敗した lead に対してもこの文が返り事実と合わないので、変えるかを #267 が決めるよう求めている。変えるには `plans.rs` と fleet CLI の契約の件を書くことになり、この Issue の書くパスの外にある。失敗した lead の計画が閉じるのは #338 が入ってからなので、この文が事実と合わなくなるのもそのあとになる。変える場合は別の Issue にする
- `orchestrator.test.ts:1402-1430` の 1 件は、Rust のテストでは 2 件に分ける。前半(新しい run が blocked 以外を報告したら、引き継いだ計画を閉じる)は今通る。後半(ターンが失敗し、どの run も引き継げなかったとき)は、期待を TypeScript の `closedAt` が `undefined`(`:1429`)から、`closedAt` が数値であることに変え、`#[ignore]` で #338 を待たせる。根拠は #240、#265、#267 の本文の「Rust 版の期待」

## 検討した代わり

- `restart.rs` が、起動し直しに失敗したときに `plans.rs` の `close_stale_plan` を呼ぶ案。ADR `0265-plans` が選択肢 C として退けた。`restart_thread` は `submitted_at` を受け取らず、計画を閉じる判定が 2 つのファイルに分かれる
- #338 が入るまでこの Issue を待つ案。#338 は自分の Issue の中で先に失敗するテストを作れない(`needs_restart` が stub のため)。この Issue が後半のテストを `#[ignore]` で置けば、#338 は `#[ignore]` を外してテストが失敗するのを見てから直せる。待っても検査は増えないので取らなかった
- `settle_unsent_turn` の確かめを置かない案(TypeScript のとおり)。TypeScript では、`readTurn` がターンのファイルを読む前の await(画面の読み取り)の間に送信が入りうる。確かめを足すと、送信が入りうるのは、確かめから読み取りまでの await のない間だけになる。送ったターンの途中で前の run のペインを閉じるのを避けるため、確かめを置いた
- テストの herdr の偽物に、ペインを閉じる呼び出しを止める仕組みを足す案(TypeScript は `runtime.closePane` を置き換える、`:1687`)。`tests/common/` は共通のファイルで、この Issue では書かない(ADR `0242-phase-3-split`)。そこで `tests/restart.rs` の中に、`FakeRuntime` を包んで `close_pane` だけに hook を足す `AgentRuntime` を書き、`common::deps` で組み立てた orchestrator に渡した

## 依存

なし

## 結果

- thread の lead が失敗するか報告なしでターンを終えると、fleet は同じ worktree、同じ branch、同じ fleet で、まだ失敗していない CLI の新しい run を起動し、前の run の契約、計画、pull request、landing の手順、outbox の知らせを渡す。thread は最初の run の id で呼べ、`get` は今の lead を返す
- #338 は、`tests/restart.rs` の `closes_a_plan_the_lead_went_on_from_when_a_turn_failed_and_no_run_could_take_over` の `#[ignore]` を外して、失敗を見てから `finalize` を直す。#338 の書くパスに `rust/crates/orchestrator/tests/restart.rs` を足す必要がある
- API(#269)は、起動し直しを前提にした `/api/fleet` の振る舞い(前の run の id で送った指示が今の lead に届く)を使える

## 確かめたこと

- 実装の前に、`rust/` で `cargo test --locked -p herdr-fleet-orchestrator --test restart` を走らせ、22 件のうち 21 件が失敗した(例: `panicked at crates/orchestrator/tests/restart.rs:299:48: a new run took over`、`timed out: the new lead starting`)。通った 1 件は `stays with its lead when the report says ready, blocked, failed or waiting` で、起動し直しが起きないことを確かめるテストなので、stub でも通る。`#[ignore]` の 1 件は数えていない
- 実装のあと、同じコマンドで 22 件が通り、1 件が ignored になった。`-- --ignored` で後半の 1 件を走らせると、`assertion failed: t.run(&other.id).plan.unwrap().closed_at.is_some()` で失敗する(#338 が直す欠陥)
- `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace` が通った(Linux、rustc は `rust/rust-toolchain.toml` の版)
