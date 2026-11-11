# thread と project を始める method の公開の signature

- 状態: 採用
- 決めた日: 2026-11-11
- Issue: #262

## 状況

#262 は、TypeScript の `startThread`、`threads`、`resolve`、`startProject` と `projectCoordinator`(`server/fleet/orchestrator.ts:360-411`、`:727-735`、`:937-939`)を、orchestrator の `fleet/threads.rs` と `fleet/projects.rs` に移す。このうち 4 つは公開の method で、API(#269)と O4〜O8 のテストが呼ぶ crate の interface になる。TypeScript は `startThread` に 6 項目の object `ThreadRequest` を、`startProject` に 3 項目の object `ProjectRequest` を渡す(`orchestrator.ts:55-74`)。

Rust の `fleet/mod.rs` は処理のまとまり(cluster)の module を private で宣言する(`mod threads;`)。そのため、`threads.rs` に置いた `pub struct` は、`fleet/mod.rs` が re-export しない限り、結合テストからも `api` module からも名指しできない。`fleet/mod.rs` は O1 だけが書くファイル(ADR `0242-phase-3-split` の「共通のファイル」)で、#262 は書けない。

決める前に architect(fleet の run `565263a5`)に、request の型を受けるか引数を並べるかを method ごとに聞き、答えに従った。

## 決定

| method | signature |
|---|---|
| thread を始める | `pub async fn start_thread(&self, request: ThreadRequest, cancel: &CancellationToken) -> Result<AgentRun, OrchestratorError>` |
| project の thread の一覧 | `pub async fn threads(&self, caller_run: Option<&str>, cwd: Option<&str>) -> Result<Vec<ThreadSummary>, FleetError>` |
| thread を済みにする、開き直す | `pub fn resolve(&self, target: &str, resolved: bool, group: Option<&str>) -> Result<AgentRun, FleetError>` |
| project の coordinator を始める | `pub async fn start_project(&self, task: &str, cwd: Option<&str>, from_pane: Option<&str>, cancel: &CancellationToken) -> Result<AgentRun, OrchestratorError>` |
| project の生きている coordinator | `pub(crate) fn project_coordinator(&self, project: &str) -> Option<AgentRun>` |

- `ThreadRequest` は `threads.rs` に置く。項目は TypeScript と同じ 6 つ(`title`、`task`、`brief`、`cwd`、`depth`、`caller_run`)で、`SpawnRequest` と同じく所有する `String` を持ち、`Default` を derive する。API は method を `tokio::spawn` の task で動かすので、所有する値をそのまま task に移せる
- `fleet/mod.rs` に `pub use threads::ThreadRequest;` の 1 行を足す。この 1 行は #332 として開いたが、coordinator が #262 の書くパスに `fleet/mod.rs` を足し、#262 の PR に含めた(この行のほかに `fleet/mod.rs` は変えない)
- 分け方の規則: 引数が clippy の `too_many_arguments` の上限(self を含めて 7)を超えるか、省略できる同じ型の引数が 3 つ以上並ぶ method は request の struct を受け、それ以外は引数を並べる。既存の `spawn(SpawnRequest, cancel)` と、引数を並べる `send`・`wait`・`read`(`fleet/turns.rs`)もこの規則に合う。`start_thread` は `cancel` を合わせて 8 つになり、`task`・`cwd`・`caller_run` の 3 つが `Option<&str>` になるので、struct にする。ほかの 3 つは 2〜3 項目なので、引数を並べる
- `start_thread` を struct にする理由:
  1. TypeScript のテストは `startThread` を 75 回呼び、その大半は O4〜O8 の describe にある。引数を並べると、O4〜O8 のテストのファイルがそれぞれ自分の helper を書くことになる。共通の helper を置く `tests/common/` は O1 のファイルで、O4〜O8 は書けない
  2. API が body を解析する関数(`server/fleet/api.ts:257-273` の `threadRequest`)を移すとき、戻り値の型に `ThreadRequest` を使える
  3. `task`・`cwd`・`caller_run` は同じ型なので、入れ違えてもコンパイラが見つけない
  4. 公開の signature の形を、段階 3 の間だけ効くファイルの持ち主の決まりで決めないため
- `threads` と `resolve` は `get` と同じく `FleetError` を返す。runtime と io の失敗がない(`git_root` は `Option` を返す)
- `project_coordinator` は project のパスを受ける。`start_project` は thread を持たず、#264(`coordinatorOf` の後半)と #266(landing の手順、`settleMerges`)は thread の `project` を渡す。`coordinatorOf` は #264 が `notices.rs` に置く
- 空の文字列: TypeScript の `request.callerRun ? … : …`、`request.fromPane ? … : …`、`base ? … : …` は、空の文字列を「ない」と同じに扱う。Rust でも、空の `caller_run`、`from_pane`、`git_head` と `git_branch` の答えは `None` と同じに扱う

## 検討した代わり

- すべての method で引数を並べる: `fleet/mod.rs` を変えずに済むが、上の理由の 1〜3 が残る
- `start_thread` が既存の `SpawnRequest` と `caller_run` を受ける: `role`、`model`、`thinking`、`worktree`、`interactive`、`direction`、`group`、`caller_pane_id`、`avoid` の 9 項目を黙って捨てることになる。`model` を指定した呼び手は、それが使われると読む
- method が builder を返し、その型を外から名指しさせない: `api` の解析の関数が戻り値に型を書けない
- `mod threads;` を `pub mod threads;` にする: 同じ型に 2 つの path(`fleet::ThreadRequest` と `fleet::threads::ThreadRequest`)ができ、cluster の分け方が公開の path になる
- `start_project` も `ProjectRequest` を受ける: 3 項目で `send(target, message, group, cancel)` と同じ形になる。struct にすると、テストの呼び出しが長くなり、公開の型が 1 つ増える

## 依存

なし

## 結果

- O4〜O8 のテストと API は、`ThreadRequest { title: …, ..ThreadRequest::default() }` で thread を始める。project の coordinator は `start_project(task, cwd, from_pane, cancel)` で始める
- 新しい公開の method は、上の分け方の規則で、struct を受けるか引数を並べるかを決める

## 確かめたこと

- `rust/crates/orchestrator/tests/threads.rs`(12 件)と `tests/projects.rs`(移した 5 件と、API が task で動かす future が `Send` であることの 1 件)。実装の前は、移した 17 件が stub の `todo!("#262")` で失敗した
- 2 つの変異でテストが落ちることを確かめた: `read_thread_work` を何もしない形に戻すと `carry_what_the_leads_turn_left_…` が落ち、`start_project` の project ごとの lock を外すと `keep_one_coordinator_per_project_…` が落ちる。後者のテストでは、偽物の `create_location` が答える前に 1 回譲る。TypeScript の偽物は promise で答えるので、1 つ目の start が coordinator を探してから run を保存するまでの間に 2 つ目が走る。Rust の偽物はすぐ答えるので、譲らないとこの間が生まれず、lock がなくても通ってしまう
- `rust/` で `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace`(871 件)、`cargo test --locked -p herdr-fleet-orchestrator --test threads --test projects` が通った(Linux、2026-11-11)
