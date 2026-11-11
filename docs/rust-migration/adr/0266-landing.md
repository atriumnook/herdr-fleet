# thread の landing を orchestrator に移すときの、公開の口と TypeScript との違い

- 状態: 採用
- 決めた日: 2026-11-11
- Issue: #266
- 置き換える: なし

## 状況

#266(O6)は、TypeScript の landing の処理(`server/fleet/orchestrator.ts:740-846` の `landable`、`baseBranchOf`、`checks`、`diff`、`land`、`landStep`、`onThread`、`:937-1157` の `readPullRequest`、`settleLeadStep`、`settleMerges`、`settleMerge`、`onLead`、`mergedOnGitHub`、`refreshPullRequests`、`closeThread`、`:1478-1488` の `settleThreadTurn`、`:1283-1288` の `staleStep`、`:1898-1931` の `leadStep` と `coordinatorStep`)と、`LandingTools` の本物(`:171-182` の `LANDING_TOOLS`)を、`rust/crates/orchestrator/src/fleet/landing.rs` に移す。O1(ADR `0256-orchestrator-foundation`)が hook の signature と stub を置き、O4(ADR `0264-notices`)が `settle_thread_turn` に `queue_turn_news` の呼び出しを置いた。

移すにあたって、次のことを決める必要があった。

- Orchestrator の公開の method の形(`land`、`checks`、`diff`、`refresh_pull_requests`)
- `LandingTools` の本物の型の名前と、`fleet/mod.rs` の re-export。`fleet/mod.rs` は #265 の thread が書いており、#266 の書くパスにない
- lead の手順を、ターンが進行中でないことの確認と 1 つの手順で送る方法。`notify_now`(`notices.rs`)は `submit` で送り、`notices.rs` も #266 の書くパスにない
- main の欠陥 #176 の 7(人のいない project で、pull request のない thread のターンの終わりごとに `gh pr view` を待つため、coordinator への知らせと `wait` が遅れる)を作らない形と、受け入れ条件の「`settleThreadTurn` は、知らせの文を作る前に hook を await する」との関係
- main の欠陥 #240 の 2(landing の手順の送信が、決着がまだ読んでいない report.json を消す)の、landing の側の扱い

決める前に architect(fleet の run `5c055b5b`)に聞き、答えに従った。従わなかったのは、`notify_now` の 1 行を変える案だけで、理由は「決定」の 3 に書いた。

## 決定

1. 公開の method は、`send(target, message, group, cancel)` と同じ並びにする(ADR `0262-threads-projects` の引数の規則)。`checks` と `diff` が返すエラーは `landable` と `diff_unavailable` の `FleetError` だけなので、`get` と同じく `FleetError` を返す。GitHub に聞けなかったときは `pr_error` に入る

   ```rust
   pub async fn land(&self, target: &str, action: LandAction, comments: &[LineComment], group: Option<&str>, cancel: &CancellationToken) -> Result<AgentRun, OrchestratorError>
   pub async fn checks(&self, target: &str, group: Option<&str>) -> Result<LandingChecks, FleetError>
   pub async fn diff(&self, target: &str, group: Option<&str>) -> Result<DiffText, FleetError>
   pub async fn refresh_pull_requests(&self)
   ```

   空の `comments` は、TypeScript の `!options.comments?.length` と同じく、指定なしと同じに扱う。`checks` と `diff` は Issue の一覧にないが、`orchestrator.test.ts` の describe `landing` の 16 件目が呼び、`landable` と `base_branch_of` を使うので、`landing.rs` に置く。

2. `LandingTools` の本物は `GitLanding`(`#[derive(Debug, Clone)]`、`new()`、`Default`、`with_github(GitHub)`)にする。テストの偽物 `FakeLanding` と対になる名前で、`GitHub` の `new()`・`with_program` と同じ形にそろえた。12 の method は `crate::thread` の関数と `GitHub::read_pull_request` をそのまま呼ぶ。`fleet/mod.rs` の `pub use landing::GitLanding;` は #339 で足す。それまでは struct と inherent impl に `#[allow(dead_code, reason = …)]` を付ける。`#[expect]` にしないのは、re-export を足す別の変更で expect が満たされなくなり、ビルドが失敗するため(ADR `0256-orchestrator-foundation` と同じ理由)。この行が最初に要るのは LIVE(#270)で、#270 にコメントした。

3. lead の手順は、`landing.rs` の `send_lead_step` で、`outbox.send_now` と `submit_when_free` を組み合わせて送る。TypeScript と同じく、手順を run に書く前に `turn_in_flight` を確かめ、進行中なら `run_busy` で断る。`submit_when_free` の lock の中の確認は、この確認のあとに別の worker が始めたターンを見つけるためのもの。送信がエラーで終わったとき(`run_busy`、outbox に書けない、`Cancelled` など)は、run の `landing.at` がまだ自分の書いた値なら、書く前の `landing` に戻す。`submit` が failed や blocked の run を返したときは、TypeScript と同じく `sent: true` の手順を残す。merge の手順も、outbox に入れられなかったときは同じく戻す。TypeScript はどちらの場合も手順を残すが、残った `sent: true` の lead の手順は、lead の次の関係のないターンの決着で、行われたものとして消える(`/code-review` の指摘)。architect は `run_busy` のときだけ戻す案を答えたが、この指摘を受けて、エラーのとき全般に広げた。

   architect は、`notify_now` の `self.submit(` を `self.submit_when_free(` に変え、`landing.rs` から `notify_now` を呼ぶ形を勧めた。TypeScript で `notifyNow` を呼ぶ 3 か所(`:811`→`:814`、`:896`→`:899`、`:1125-1130`)は、どれも直前に進行中でないことを確かめており、Rust では 3 か所とも `submit_when_free` が要るため。しかし、#266 の thread への指示は「書くパスの外を変えない」で、`notices.rs` はその外にある。そのため architect が示した代わりの案を取り、`notify_now` を変えて写しを置き換える Issue を #340 として開いた。

4. #176 の 7: `settle_thread_turn` は、人のいない project で、run に pull request が記録されていない(`pr` が `None`)thread では、`queue_turn_news` を呼んだあとで、別の task(box した future を `tokio::spawn`)で `read_pull_request` を呼ぶ。その task は reconcile の lock も thread の lock も持たない。同じ thread について読み取りが進行中なら、新しい task は読まない(`landing::State` の `asking`。gh が遅い間に lead が続けてターンを終えても、`gh` は 1 つだけ動く)。読み終えたら run を id で読み直し、サーバーが止まっておらず、run がまだあり、`landed` も `replaced_by` もなく、project がまだ `autonomous` で、MERGED と読んだときだけ、`merged_without_person(id, &reading, MergeSeen::Polled)` を await する。GitHub に聞けなかったときは、TypeScript の `.catch(() => null)` と同じく何もしない。

   pull request が記録された thread(TypeScript の `:1481-1484` の分岐で、`pr` が OPEN か、人のいない project で `pr` があるとき)は、決着の中で読み、MERGED なら `merged_without_person(id, &reading, MergeSeen::TurnEnded)` を await してから `queue_turn_news` を呼ぶ。受け入れ条件の「知らせの文を作る前に hook を await する」は、この分岐で満たす。pull request のない thread のあとでの読み取りは、決着の外の読み取りとして扱う。同じ Issue の #176 の 7(知らせと `wait` が `gh` を待たない)と、字義どおりの「知らせの前に await する」は両立しないため。ADR `0264-notices` は、#176 の 7 のために `gh` の読み取りを `queue_turn_news` のあとに回してよいと書いている。

   あとで読む task が `TurnEnded` でなく `Polled` で呼ぶのは、`TurnEnded` の hook のあとにはターンの知らせが続き、その知らせが hook の保存した `pr` と `landed` を引用し、hook の入れた知らせを置き換える、と ADR `0264-notices` が決めているため。知らせを入れたあとで `TurnEnded` を呼ぶと、入れた知らせには pull request の行がなく、coordinator はマージを聞かない。`Polled` は「あとに知らせの続かない、決着の外で読んだマージ」として #268 に申し送った(#268 へのコメント)。

5. #240 の 2: 決着の側の順序は O1 が置いた(`finalize` は turns の lock の中で、pending を外す前に報告のファイルを読み、新しいターンは pending を登録したあとでファイルを消す)。landing の側では、`settle_thread_turn` は、`turn_in_flight(id)` のとき(lead の手順を運ぶ新しいターンが進行中のとき)、その手順を判定しない。新しいターンの決着が判定する。ターンの知らせは書く。`land` は始めに reconcile の lock が空くのを待つだけで、決着は thread の lock を取らないので、`land` が `base_branch_of` を待つ間にターンの決着が始まりうる。

6. `settle_lead_step` は、判定の結果(`landing` に error を付ける、または消す)を、run の `landing.at` が判定した手順の `at` と同じときだけ書く。判定の await の間に `land` が次の手順を書きうるため。TypeScript は判定のあとに `delete run.landing` を無条件に書き(`:975`)、新しい手順を消しうる。

7. 人のいない project でマージを読んだときは、TypeScript の処理を hook で置き換える(ADR `0242-phase-3-split` の codex の R4)。`refresh_pull_requests` の自律の分岐は、`queueNews(threadMerged)` と `tellCoordinator`(`:1044-1047`)の代わりに `merged_without_person(…, MergeSeen::Polled)` を、`settle_thread_turn` の自律の MERGED の分岐は、`mergedOnGitHub`(`:1483`)の代わりに `merged_without_person(…, MergeSeen::TurnEnded)` を呼ぶ。人のいる project の分岐は TypeScript のまま。

8. O8(#268)が thread を閉じるのに使う口を `pub(crate)` で置く

   | 口 | 持ち主 | 使う所 |
   |---|---|---|
   | `read_pull_request(&self, id) -> Result<Option<PullRequestReading>, GhError>`(読んだ PR を run の `pr` に保存する) | #266 | #268 の停滞の監督 |
   | `on_lead(&self, id, work)`(thread の lock の中で lead を読み直し、landed なら何もしない) | #266 | #268 |
   | `merged_on_github(&self, id, &reading)` | #266 | #268 |

9. run の `base_branch` が空の文字列なら、記録がないものとして扱い、main のチェックアウトのブランチを読む(TypeScript の `run.baseBranch ? … : gitBranch(…)`)。`close_thread` は、run に repository かブランチの記録がないときも、ペインを閉じたあとで thread を閉じる(`landed` と `resolved_at` を書く)。worktree とブランチは消さない

10. `land` の future が `start_project` の future をそのまま持つと、debug ビルドのテストのスレッド(2 MiB)でスタックが溢れることがあった(1 回観測)。`land_step` の中の `start_project` は box して await する。`land` の future は 15,664 バイトになった。

## 検討した代わり

- `notify_now` の 1 行を変えて、`landing.rs` から呼ぶ案(architect の推奨): 写しが残らない。#266 の書くパスの外の `notices.rs` を変えるので取らず、#340 に回した
- あとで読む task が `TurnEnded` で hook を呼び、続けて `queue_turn_news` を書き直す案: 約束の字義は保てるが、最初の知らせがすでに届いていると、coordinator は同じターンの知らせを 2 回受け取る(blocked の報告なら同じ質問が 2 回届く)
- あとで読む task は `pr` を保存するだけにし、`refresh_pull_requests` が MERGED の thread も読み直す案: 定期の読み直しのたびに hook が呼ばれ、TypeScript の「`pr` が OPEN でなくなるので、マージの知らせは 1 回だけ」が成り立たなくなり、O8 が回数を数えることになる
- `impl dyn LandingTools { pub fn git(..) }` で本物を返し、re-export を要らなくする案: `fleet/mod.rs` を書かずに済むが、core に慣れない呼び方を強いる。re-export の 1 行には ADR `0262-threads-projects` の前例(#332)がある

## 依存

なし。

## 結果

- core(LIVE、#270)は、#339 のあとで `GitLanding::new()` を `OrchestratorDeps::landing` に渡せる
- API(#269)は、`land`、`checks`、`diff`、`refresh_pull_requests` をそのまま呼べる。`checks` と `diff` のエラーは `From<FleetError>` で変換する
- #267(起動し直し)は、`land` と `settle_thread_turn` の手順の扱いを使う。`on_thread` は `landing.rs` の private な関数で、#267 が要るなら `pub(crate)` にする
- #268 は、`merged_without_person` の中身を書く。`Polled` は 2 か所から呼ばれ、同じマージについて `Polled` と `TurnEnded` の両方が呼びうる。マージの知らせは 1 回だけ入れる。`autonomy.rs` の `MergeSeen::Polled` の doc comment は #268 が書き直す
- #340 のあとは、lead の手順も `notify_now` から送る

## 確かめたこと

Linux(Omarchy、kernel 7.2.15)、`rust/` で、2026-11-11 に実行した。

- 実装の前に、`tests/landing.rs` の 19 件(移した 16 件と、Discard だけがサーバー自身で消すこと、#240 の 2、#176 の 7 の 3 件)を `cargo test --locked -p herdr-fleet-orchestrator --test landing` で走らせ、18 件が失敗した。15 件は stub の `todo!` の panic(例: `panicked at crates/orchestrator/src/fleet/landing.rs:44:9`)、3 件は期待値との違い(#176 の 7 は `GitHub is still asked` で `left: 0` / `right: 1`、ほかに `timed out: the saved merges after the restart` と、知らせに merge の手順がない差)。`start a thread on the branch the main checkout is on` の 1 件は、O3(#262)の `start_thread` と O1 の `read_thread_work` がすでに満たしているので、先に失敗させられない
- 実装のあとで、同じコマンドで 19 件が通った。20 回続けて走らせ、20 回とも通った
- `/code-review high` の指摘で 2 件を足した。outbox に書けないときに手順を thread に残さない件と、空の `base_branch` を記録なしとして読む件。直しの前の `landing.rs` では、前者は `left: Some(LandingStep { action: Pr, …, sent: Some(true), error: None })` / `right: None`、後者は手順の文が `Merge into  for thread …` になって失敗し、直したあとは通った。21 件が通る
- `GitLanding` は、`landing.rs` の `#[cfg(test)]` のテストで、一時のフォルダーに `git init -b trunk` したリポジトリに対して `git_root`、`git_branch`、`is_merged` を trait を通して呼び、存在しない `gh` で `read_pull_request` がエラーになることを確かめた
- スタックの余裕: `RUST_MIN_STACK` を 1 MiB にすると `tests/landing.rs` は通り、512 KiB にすると溢れた。既存の `tests/notices.rs`、`tests/threads.rs`、`tests/turns.rs` も 512 KiB で溢れるので、この crate の既存のテストと同じ余裕である
- `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace` が通った
