# orchestrator の土台の interface と、ターンの決着の順序

- 状態: 採用
- 決めた日: 2026-11-11
- Issue: #256
- 置き換える: 0242-phase-3-split(一部だけ。「Issue の分け方」の、O1 が `thread.ts` の関数を直接呼び、テストが本物の git を通すという一文と、「orchestrator の状態の持ち方」の `LandingTools` の範囲の 2 点。ほかの決定は 0242 のまま)

## 状況

ADR `0242-phase-3-split` は、orchestrator を `Arc<Inner>` の handle にし、run を `RunRegistry` に持たせ、処理のまとまり(cluster)ごとのファイルに `State` と hook を置くと決めた。O1(#256)がその土台を作るにあたり、0242 が決めていない次の点を決める必要があった。どれも O2〜O8、HR、API、CC が使う crate の interface に関わる。

- orchestrator の公開の method が返すエラーの型
- git の読み取りのうち、TypeScript が `LandingTools` の外の deps で受けている 5 つ(`gitRoot`、`gitHead`、`diffStat`、`excludeWorktrees`、`runSetup`)の受け方。止めた tokio の時計の上では、子プロセスを待つ間に時間の上限が過ぎるので、テストは本物の git を動かせない(0242 の「非同期と時刻」)
- `spawnWithFallbacks` を O1 の `spawn.rs` と O2 の `candidates.rs` にどう分けるか
- ターンの決着(`turns.rs`)が呼ぶ hook の名前、持ち主の Issue、signature
- main の欠陥 #189 の 4(HANDOFF を書かずに終わった非対話のペインを、人が閉じるまで残す)の Rust 版の振る舞い。2026-11-11 の時点で main に直しはない(`git log origin/main -S closeOnSettle -- server/fleet/orchestrator.ts` は `e6494c5` だけ)
- main の欠陥 #240 の 2(決着が読む前の report.json を、landing の手順の送信が消しうる)の、決着の側の順序

決める前に architect(fleet の run `6e032d37`)に 6 つの問いを聞き、答えに従った。答えが示した前提: core は tokio の multi-thread の runtime で動き(`rust/crates/core/Cargo.toml` の `rt-multi-thread`)、orchestrator のテストは current-thread の runtime で動く。TypeScript が「2 つの await の間にはほかの処理が割り込まない」ことに頼る箇所は、Rust ではテストが通っても本番で競合しうる。

## 決定

### 状態の持ち方の決まり(`fleet/mod.rs` の module の説明に書いた)

- run を変えるのは `Orchestrator::change`(新しい run は `Orchestrator::insert`)だけにする。TypeScript の `save` に当たり、registry に保存し、state の変化を出来事として記録し、`on_changed` を呼ぶ。cluster は `RunRegistry::update` と `insert` を直接呼ばない(呼ぶと出来事が抜ける)。例外は、constructor が結果ファイルから run の `result` を読み戻す箇所で、TypeScript も保存せず、出来事も出さない
- await のたびに run を id で読み直す。TypeScript の hook は共有のオブジェクトを書き換え、`finalize` の最後に 1 回保存した。Rust の hook は id を受け、自分の変更を自分で保存する
- TypeScript が「確かめてから、await を挟まずに動く」箇所(ターンが進行中でなければ送る、など)は、確認と動作を、その状態を持つ cluster の lock の中で行う
- TypeScript が await せずに呼ぶ hook(`void this.deliverNotices(run)`、`void this.tellCoordinator(run)`)は `tokio::spawn` で動かす。決着の中で await すると、呼び手が持つ run の lock を待って止まる

### エラーの型

`pub enum OrchestratorError { Fleet(FleetError), Runtime(RuntimeError), WaitTimeout { run, timeout_ms }, Io(Arc<io::Error>) }`。`code()` が API と CLI の使うコードを返す(`Io` は `internal_error`、`WaitTimeout` は `wait_timeout`)。`is_cancelled()` は TypeScript の `isAbortError` に当たる。起動の失敗と準備ができないことは、runtime から来ても orchestrator 自身が判定しても(`readyError`、`readyScreen`)、`RuntimeError::StartFailed` と `RuntimeError::NotReady` の 1 つの形で表す。O2 の候補の切り替えは 1 つの variant だけを見ればよい。`Io` を `Arc` で包むのは、`io::Error` が `Clone` を持たないため。

### runs.json の書き込みの失敗

TypeScript は registry の書き込みの失敗を投げる(`registry.ts:69-82`)。spawn では、ペインを作ったあとに投げるので、ペインが残る。決着では、`reconcileRun` の `catch` が飲み込み、残りの決着を飛ばす。Rust 版は `change` と `insert` の 1 か所で標準エラーに書いて続ける。変更はメモリーに残り、次の保存がファイル全体を書き直す(`registry.rs` の `update` の説明)。outbox の書き込みは扱いを変えない: outbox はファイルに書いてからメモリーを変える(`outbox.rs`)ので、失敗を無視すると知らせが消える。

### git と GitHub の port

2 つ目の trait は作らず、TypeScript が別の deps で受けていた 5 つの関数を `LandingTools` に入れる(12 の method)。thread を始める 1 つの操作(`startThread`)が `gitRoot`、`excludeWorktrees`、`gitHead` と `LandingTools` の `gitBranch` を続けて呼ぶので、port を 2 つにすると 1 つの操作が 2 つに分かれ、テストを書く側はどの port にどの読み取りがあるかを覚える必要がある。12 の method の本物の impl は、0242 のとおり O6(#266)が書く。core が本物を組み立てるのは LIVE で、O6 のあとなので、それまで呼ぶ者はない。名前は「landing」でも、`git_root` や `run_setup` も持つ。0242 と #256 が決めた名前を保つことと、port を 1 つにすることを、名前の正確さより優先した。

### spawn の分け方

- 役割の解決(`findAgent` と `unknown_role`、role override、primary のモデル、`requireThinkingLevel`、CLI の種類、設定にある候補の一覧。`orchestrator.ts:441-451`)は O1 の `spawn.rs` の `resolve_role` に置く。O1 の spawn のテスト(知らない役割、知らない thinking の段階)が確かめるのは、O2 が書き換えないコードになる
- `candidates.rs` の `spawn_with_fallbacks` の O1 の stub は、`resolve_role`、`parse_candidate`、`apply_model_policy`(O1 では値をそのまま返す)、`spawn_attempt` の順に呼び、primary の候補だけを試す。no-op では spawn できないので、no-op でない stub に `// stub: #263` を書いた。O2 までの間は、`avoid` と `edits: false` の確認(`orchestrator.ts:460-462`)を飛ばす。LIVE が Rust の core を動かすのは O2 のあとである
- spawn の計画を O2 に渡す hook `keep_spawn_plan` を、task を渡す前に呼ぶ(`orchestrator.ts:619`)。multi-thread の runtime では、最初のターンが別の worker で決着して計画を探しうるため
- ターンの API エラーによるクールダウンは、`turns.rs` が `UsageGate::note_failure` を直接呼ぶ(`orchestrator.ts:1470`)。転送しかしない hook は置かない。#263 の受け入れ条件の「ターンのエラーによるクールダウン」は、O2 が書く `UsageGate` の `UsageTracker` への impl が受け持つ

### hook と持ち主

| hook | 持ち主 | 呼ぶ所 |
|---|---|---|
| `spawn_with_fallbacks`、`keep_spawn_plan`、`respawn_after_failure`、`read_usage_screen`、`apply_model_policy` | #263 | `launch`、`spawn_attempt`、`finalize` |
| `read_thread_work` | #262 | `finalize` |
| `deliver_notices`、`tell_coordinator`(`tokio::spawn` で)、`restore_notices` | #264 | `reconcile_run`、`finalize`、constructor |
| `close_stale_plan` | #265 | `finalize` |
| `settle_thread_turn`、`settle_merges`、`stale_step`、`restore_landing_steps` | #266 | `finalize`、constructor |
| `needs_restart`、`restart_thread`、`settle_unsent_turn`、`carry_over`、`carry_files` | #267 | `finalize`、`reconcile_run`、`spawn_attempt` |
| `merged_without_person(&self, thread, reading, seen: MergeSeen)` | #268 | #266 の `settle_thread_turn` と `refresh_pull_requests` |

- `carry_files`(`carryFiles`)は #267 の受け入れ条件の一覧にないが、ターンを引き継ぐ lead の処理なので #267 に渡す
- constructor の順序は TypeScript と同じ: 結果フォルダーの掃除、run の `result` と保存済みの state の読み戻し、動いていたターンの追跡の再開、outbox の読み込みと `stale_step` による掃除、`restore_notices`、`restore_landing_steps`
- `submit` のほかに `submit_when_free` を置く。ターンが進行中なら `run_busy` で断り、確認と新しいターンの登録を 1 つの lock の中で行う。landing の手順(#266)と計画の回答(#265)が使う。TypeScript の `if (this.pending.has(run.id)) throw …` のあと await なしで `submit` する形に当たる
- ターンが進行中かを外から聞く `turn_in_flight(id)` を置く(TypeScript の `pending.has`)

### #189 の 4: 報告なしで終わった非対話のペイン

TypeScript と同じく、報告なしで決着したペインはすぐには閉じない(移したテスト「keeps the pane of a non-interactive turn that ended without its handoff」)。そのうえで、`UNREPORTED_CLOSE`(15 分)のあいだ何も送られなければ閉じる。

- timer が発火したら、run の決着の lock の中で、次をすべて確かめてから、`closeOnSettle` と同じ `close_settled_pane` で閉じる: 新しいターンが送られていない(世代が同じ)、ターンが進行中でない、run が生きていて非対話で決着している、報告がまだない、設定の `closeOnSettle` が今も真、herdr も決着していると言う
- サーバーを起動し直したときは、保存された run のうち、非対話で決着していて報告のないものに timer を張り直す。張り直さないと、再起動のあとはペインが残り続け、欠陥が戻る
- 定数は `QUIET`(人のいない project の停滞の判定、#268)と分ける。2 つの方針が 1 つの定数を共有すると、片方を変えるともう片方も動く。deps で上書きする口は置かず、テストは止めた時計を 15 分進める
- この決まりで、adapter が知らない質問の画面で止まったエージェント(TypeScript がペインを残す理由)も、15 分でペインを失う。決着の時の画面は `lastOutput` に残り、待っていた者に渡っている

### #240 の 2: 決着が読む前の report.json

`finalize` は、世代の確認、`handoff.md` と `report.json` の読み取り、進行中のターンの削除、settle check の取り消しを、`turns::State` の 1 つの lock の中で行い、そのあとで herdr の画面の読み取りを await する。`submit` は、世代の加算、進行中のターンの登録、ターンのファイル(`handoff.md` と `report.json`)の削除を同じ lock の中で行う。fleet が送っていないターンの始まりでファイルを消す処理(`reconcile_run`、#176 の 4)も同じ lock の中で確かめる。landing の手順の送信によるファイルの削除は、決着の読み取りの前に済む(決着は新しい世代を見て何もしない)か、読み取りの後に起きるかのどちらかになる。公開の口 `land` から競合を再現するテストは O6 が書く。

### そのほかの決まり

- テストの共通部分(`tests/common/`)の `FakeLanding` は、12 の method の呼び出しをすべて記録し、テストごとに method の答えを差し替えられる。差し替えないときの答えは TypeScript の `setup()`(`orchestrator.test.ts:98-100`)と同じ: リポジトリ、head、ブランチ、pull request はなし。TypeScript が本物を使う読み取りは、リポジトリでないフォルダーで git が返す値(変更なし、マージされていない、何も残さない、setup のコマンドは成功)
- `/api/fleet` が `tokio::spawn` で動かす method の future が `Send` であることを、テスト `the_futures_the_api_spawns_are_send` が確かめる
- まだ呼ばれない stub と土台の項目には、`#[expect]` ではなく `#[allow(dead_code, reason = …)]` を付ける。満たされない `expect` は、呼び出しを足す Issue(そのファイルの持ち主ではない)で失敗するため

### レビューで直した点

`/code-review high` の指摘で、次を直した。

- `wait` は、ターンがもう答えるかの判定と待つ者の登録を、`turns::State` の 1 つの lock の中で行う。2 つに分けると、別の worker の決着がその間に入り、待つ者が時間切れまで起こされない。時間切れか取り消しで終わった待つ者は、表から外す
- `reconcile_run` で herdr が run を知らないと答えたとき、読み直した run が生きているかを確かめる。起動の失敗で `failed` になった run を `stopped` で上書きしない(テスト `keeps_a_failed_verdict_reached_while_herdr_was_asked`)
- `close_done` は、run の決着の lock の中で、herdr の状態を聞いたあとにもう一度ターンが進行中でないかを確かめてから閉じる
- ペインを作ったあとでサーバー自身のファイル(結果フォルダー、指示文)が書けなかったときも、起動の失敗と同じく run を `failed` にしてペインを閉じる。`AgentRun` は JSON を通さず直接組み立てる(テスト `fails_the_run_and_closes_its_pane_when_its_result_folder_cannot_be_made`)
- `submit` は、herdr が `working` を見たという印を上書きせず、足す(`|=`)
- timer の表は、task を起動してからその handle を入れるまで lock を持つ。すぐに発火した task が自分の項目を消せずに残すことを防ぐ

次の 3 件は直さず、理由を PR に書いた。

- `RuntimeError::NotFound` が herdr の 3 つのコードを 1 つにまとめ、`code()` が `agent_not_found` を返す。variant の形は ADR `0242-phase-3-split` と #256 の受け入れ条件が決めている。`focus` や `interrupt` で herdr の元のコードと文を CLI に出すかは、fleet CLI の契約と照らして HR(#261)と CC(#274)が確かめる
- spawn の gate の中で `registry.all()` がすべての run を複製する。TypeScript も同じ所で `registry.all()` を呼ぶ。registry の口は L5 のもの
- `state_name` が `AgentState` の綴りを手で持つ。protocol は O1 の書くパスの外で、variant が増えればコンパイラが気づく

## 検討した代わり

- `ThreadTools` という 2 つ目の trait に 5 つの関数を置き、本物の impl を O1 が書く案。1 つの操作が 2 つの port に分かれ、呼ぶ者のない本物の impl が 2 つ目のファイルにできるので取らなかった
- 役割の解決を `candidates.rs` の stub に置く案。O1 のテストが確かめるコードを O2 が書き換えることになるので取らなかった
- runs.json の書き込みの失敗を TypeScript と同じく投げる案。spawn ではペインが残り、決着では残りの処理が飛ぶので取らなかった
- #189 の 4 を、サーバーの定期の timer(`server/index.ts:2051-2055`)で `updatedAt` を見て掃除する案。再起動のあとも働くが、新しい公開の method と core の配線が要り、O1 の書くパスの外になるので取らなかった
- #189 の 4 の待ち時間に `QUIET` を使い回す案。上の理由で取らなかった
- core を current-thread の runtime で動かし、TypeScript の「await の間は割り込まれない」を保つ案。ADR `0244-phase-3-dependencies` が core に multi-thread を選んでおり、保証がテストで確かめられない性質に頼ることになるので取らなかった

## 依存

なし。

## 結果

- O2〜O8 は、上の表の hook の中身を自分のファイルに書き、signature を変えない。直しが要るときは、0242 の決まりどおり、直す Issue を別に開いて待つ
- HR(#261)は `AgentRuntime` を実装し、herdr のコードを `RuntimeError` に変える
- API(#269)は `OrchestratorError::code()` からステータスを決める(TypeScript の `api.ts` の `STATUS` の表、`Io` は 500)
- O6(#266)は `LandingTools` の 12 の method の本物の impl を書き、`settle_thread_turn` で、新しいターンが運ぶ手順を `turn_in_flight` で見分ける
- 報告なしで終わった非対話のペインは、15 分で閉じる。API のエラーでターンが失敗した非対話のペイン(`failed`)は、`closeOnSettle` も `closeDone` も扱わず、人が閉じるまで残る。#189 の 4 の範囲の外で、TypeScript と同じ。PR に書いた

## 確かめたこと

Linux(Omarchy、kernel 7.2.15)、`rust/` で、2026-11-11 に実行した。

- 実装の前に、移したテストと足したテスト(この時点の 48 件)を `cargo test --locked --no-fail-fast -p herdr-fleet-orchestrator --test spawn --test turns --test result_files --test agent_kinds` で走らせ、すべてが stub の `todo!("#256")` の panic で失敗した(`panicked at crates/orchestrator/src/fleet/spawn.rs:100:9: not yet implemented: #256`)
- main の欠陥の 4 件のテストは、実装を TypeScript の振る舞い(#240 の 2: 画面の await のあとでファイルを読む、#189 の 4: timer を張らない、#176 の 4: 送っていないターンでファイルを消さない、再起動で timer を張り直さない)に一時的に戻すと、それぞれ失敗し、戻すと通った
- architect の答えのあとで 2 件を足した。再起動のあとの #189 の 4 のテストは、上のとおり timer の張り直しを外すと失敗することで確かめた。future が `Send` であることのテストは型の検査なので、先に失敗させられない
- `/code-review high` の指摘を直したあとで 2 件を足した(下の「レビューで直した点」)。どちらも、直しを外すと失敗し、戻すと通った
- 同じコマンドで、spawn 16 件、turns 19 件、result_files 7 件、agent_kinds 10 件の計 52 件がすべて通った。`cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace` も通った
