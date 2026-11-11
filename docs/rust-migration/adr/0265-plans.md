# orchestrator の中の計画と、#240 の 3 の直しの置き場所

- 状態: 採用
- 決めた日: 2026-11-11
- Issue: #265

## 状況

#265(O5)は、TypeScript の計画の処理(`server/fleet/orchestrator.ts:845-934` の `planner`、`submitPlan`、`plan`、`answerPlan`、`closeStalePlan`)を、`rust/crates/orchestrator/src/fleet/plans.rs` に移す。計画の検査と記録は L7(#250)の `plan.rs` と `protocol::plan` にある。受け入れ条件は、`orchestrator.test.ts` の describe `plans`(11 件)と、describe `threads` の 1 件(`:1165`)を Rust のテストに移すことを含む。

#265 の本文は、#240 の 3 を Rust 版に写さないよう求めている。欠陥は、TypeScript の `finalize`(`:1434`)がターンの報告があるときだけ `closeStalePlan` を呼ぶため、報告のないターンのあと起動し直しもすべての候補で失敗すると、進んだ計画が答えを待ったまま残ること。Rust 版の期待は「起動し直しがすべての候補で失敗しても、進んだ計画の回答待ちが残らない」で、ADR `0242-phase-3-split` は #240 の 3 を O5 と O7(#267)に割り当てている。ところが、`close_stale_plan` を呼ぶ条件は O1 の `turns.rs` の `finalize`(`:710-724`)にあり、#265 の書くパスの外にある。

決める前に architect(fleet の run `6dbcddf2`)に聞き、答えに従った。

## 決定

- `plans.rs` に、TypeScript と同じ名前と振る舞いで次を置く。公開の口は `Orchestrator` の method で、`fleet/mod.rs` に足す `pub use` はない

  | method | TypeScript | 返す値 |
  |---|---|---|
  | `submit_plan(&self, target, value: &Value, group) -> Result<Plan, OrchestratorError>` | `submitPlan` | 保存した計画 |
  | `plan(&self, target, group) -> Result<Plan, FleetError>` | `plan` | 保存してある計画 |
  | `answer_plan(&self, target, value: &Value, group, cancel) -> Result<AgentRun, OrchestratorError>` | `answerPlan` | 答えを送ったあとの run |
  | `close_stale_plan(&self, id, submitted_at)`(`pub(crate)`、O1 が置いた hook) | `closeStalePlan` | なし |

- 計画ファイルの読み取りと書き込み、run の計画の印(`PlanMark`)の保存は、plans の `Mutex`(`plans::State`)の中で 1 つの手順として行う。TypeScript は同期の処理なので、2 つの `submitPlan` が同じ版の番号を数えることはない。Rust のサーバーは tokio のマルチスレッドの runtime で動くので、lock がないと、同時に出された 2 つの計画が同じ版の番号になりうる。`fleet/mod.rs` の冒頭の決まり(確認と実行を、その cluster の lock の両側に分けない)に従った。lock は await をまたいで持たない。lead が答えを打ち込まれている間に次の計画を出せるようにするため(テスト「leave a newer plan the lead handed over while the answers went out as it is」)
- `answer_plan` の送信は `notify_now` ではなく、outbox の `send_now` と `submit_when_free` で行う。TypeScript は「fleet のターンが進行中でない」ことを確かめてから、await を挟まずに `notifyNow` を呼ぶ(`:897-899`)。`notify_now` は `submit` を使うので、Rust では確認と新しいターンの登録の間に、別のスレッドの送信が入りうる。`submit_when_free` は、確認と登録を turns の lock の中で 1 つの手順にし、進行中なら TypeScript と同じ文の `run_busy` で断る(ADR `0264-notices` の配達と同じ扱い)
- `close_stale_plan` が計画ファイルに書けなかったときは、標準エラーに書き、計画を開いたままにする。hook は値を返さない(ADR `0264-notices` の outbox と同じ扱い)。TypeScript は投げて、`finalize` の残りが飛ぶ。`submit_plan` と `answer_plan` で書けなかったときは、TypeScript と同じく呼び出し元にエラー(`internal_error`)を返す
- #240 の 3 の直し(`close_stale_plan` を呼ぶ条件)は `turns.rs` の `finalize` に置き、`turns.rs` だけを書く #338 が書く。#265 は書かない。条件は、報告がある場合の今の条件に加え、報告がなく `restart_error.is_some()`(新しい run が thread を引き継がなかった)ときにも呼ぶ、とする。起動し直しを試みなかった場合(報告がなく `needs_restart` が偽、つまり thread が landing 済みのとき)は、TypeScript と同じく閉じない。#267 は #338 を待ち、TypeScript の `orchestrator.test.ts:1402-1430` を移すときに、`:1429` の期待(`closedAt` が `undefined`)を、`closedAt` が数値であることに変える。根拠は #240、#265、#267 の本文
- #267 との約束: `restart_thread` は、新しい run が thread を引き継がなかったときにだけ `Some` を返し、中断では返さない。中断で `Some` を返すと、サーバーの停止で計画が閉じる。TypeScript は中断を投げ直し、`closeStalePlan` まで進まない(`:1564`)

## 検討した代わり

- #265 が `turns.rs` の直しの Issue を待つ案(architect の選択肢 B)。`restart.rs` の `needs_restart` は #267 まで stub で常に `false` を返すので、#265 のテストではこの条件を確かめられない。待っても #265 の検査は増えず、着手が遅れるだけなので取らなかった
- `restart.rs` が、起動し直しに失敗したときに `plans.rs` を呼ぶ案(選択肢 C)。`restart_thread` は `submitted_at` を受け取らず、`finalize` は起動し直しの前に進行中のターンを消すので、`restart.rs` からは読めない。計画を閉じる判定が `turns.rs` と `restart.rs` の 2 つのファイルに分かれるので取らなかった
- 判定をすべて `plans.rs` に移し、`finalize` は `settle_plan(id, pending, restart_failed)` だけを呼ぶ案。O1 が最終の signature で置いた hook を変えることになり、同じく `turns.rs` の Issue が要る。得られるのは条件の 1 つの腕の移動だけなので取らなかった
- `answer_plan` が `notify_now` をそのまま使う案。上の「決定」の理由で、確認と送信の間に別の送信が入りうるので取らなかった

## 依存

なし。

## 結果

- `/api/fleet` の router(#269)は、`submit_plan`、`plan`、`answer_plan` を呼べる。`answer_plan` は中断のために `CancellationToken` を受け取る(`fleet/mod.rs` の冒頭の「Cancelling」)
- 「計画を閉じる」判定の一部(どのターンで呼ぶか)は、TypeScript と同じく `turns.rs` に残る。時刻の比較(計画の `writtenAt` がターンの `submitted_at` より前なら閉じる)は `plans.rs` にある
- #338 は、先に失敗するテストなしで入る。公開の口からの確認は #267 のテストが受け持つ
- 閉じた計画に答えると、`answer_plan` は lead が失敗していても `plan_closed`(「The lead of X went on without answers to version N of its plan.」)を返す。TypeScript と同じく `closedAt` を `isLive` より先に調べるため。#338 が入ると失敗した lead の計画も閉じるので、この文は事実と合わなくなる。文を変えるかは #267 が決める

## 確かめたこと

- `cargo test --locked -p herdr-fleet-orchestrator --test plans`: 実装の前は 12 件すべてが stub の `todo!("#265")` で失敗し、実装のあとは 12 件すべてが通った(Linux、Rust 1.99.1)
- `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace` が通った
