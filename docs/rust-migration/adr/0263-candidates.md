# 候補の選び方で、役割を断る CLI、使用量の画面の読み手、spawn の計画の持ち方を決める

- 状態: 採用
- 決めた日: 2026-11-11
- Issue: #263

## 状況

O2(#263)は、O1(#256)が `candidates.rs` に置いた hook(`spawn_with_fallbacks`、`keep_spawn_plan`、`respawn_after_failure`、`read_usage_screen`、`apply_model_policy`)の中身と、`UsageGate` を `UsageTracker`(L3)に、`ModelGate` を `ModelCatalog`(L4)に実装する impl を書く。hook の signature は ADR `0256-orchestrator-foundation` が決めている。TypeScript(`server/fleet/orchestrator.ts:440-497`、`:1586-1626`、`:1926-1937`)をそのまま移せない点が 3 つあった。

- TypeScript の候補の選び方は、役割を断る CLI を `edits: false` と `readOnlyArgs` だけで判定する(`orchestrator.ts:461`)。ADR `0248-launch-adapters` は、この判定を `Adapter::refusal(&RoleFit)` に移し、#189 の 8 と #190 の 2 つの判定を足し、`RoleFit` は O2 が作ると決めた
- TypeScript の adapter は、使用量の画面を読む関数 `usageScreen` を持つ。Rust の `Adapter`(L2)は打つコマンド `usage_command` だけを持ち、画面の読み取りは screen の crate の `cursor_usage` にある(段階 2)
- TypeScript の `spawnPlans` は、`finalize` で毎回消す。run の記録が決着の前に消えると、`finalize` は途中で戻り(`turns.rs` の「the record went away」)、計画が残る

## 決定

- `RoleFit` は ADR `0248-launch-adapters` のとおりに作る。`read_only` は `edits: false`、`spawning` は `AgentDefinition::may_spawn`(役割の上書きか定義の `spawning`)、`reads_outside_folders` は役割の名前が `reviewer` であること。候補を調べる順は、呼んだ側の `avoid`、`refusal`、`ModelGate::unknown`、`UsageGate::unavailable` で、TypeScript と同じ。その結果、agy は fleet コマンドを使う役割と reviewer の候補を飛ばし、飛ばした理由を run の `skipped` に残す。TypeScript との違いはこの 2 つの判定だけで、ADR `0248-launch-adapters` が決めたもの
- 使用量の画面の読み手は、`candidates.rs` の中の関数 `usage_screen(kind)` が CLI の種類から選ぶ(cursor は `screen::cursor_usage`)。`read_usage_screen` は、`usage_command` と読み手の両方がある CLI の非対話の run でだけ、最後に `claim_screen` を呼び、true が返ったときにコマンドを打つ。`claim_screen` は true を返すと、その時刻を試した時刻として記録する。そのため、ほかの条件で打たないときは呼ばない。呼ぶ順は TypeScript と同じ
- spawn の計画(`State::plans`)は、`respawn_after_failure` が決着のたびに取り出して消す。`keep_spawn_plan` は、新しい計画を入れる前に、記録がないか生きていない run の計画を捨てる。記録が消えた run の計画が残り続けないため
- `respawn_after_failure` が呼ぶ `spawn_with_fallbacks` の future は `Box::pin` で包む。代わりの run の最初のターンも `finalize` を通り、`finalize` がこの hook を呼ぶ。包まないと、async fn の future の型が自分自身を含み、コンパイルできない
- 移したテストのうち、TypeScript が `HerdrError("pane_not_found", "pane vanished")` を投げる 1 件(「does not fall back on errors that are not the model's」)は、`RuntimeError::NotFound` を返す。HR(#261)が herdr の `pane_not_found` をこの variant に変える(`runtime.rs`)ので、エラーの文は herdr が返した `pane vanished` ではなく、`RuntimeError::NotFound` の決まった文になる。テストは、そのエラーがそのまま呼んだ側に返り、次の候補を試さないことを確かめる
- cursor の `/usage` のテストは、Esc の振る舞いを差し替える口(TypeScript の `interruptImpl`)を要する。共通の `FakeRuntime`(`tests/common/`、この Issue では書かない)にはないので、テストのファイルの中で `FakeRuntime` を包む `EscRuntime` を作り、`OrchestratorDeps::runtime` に入れる

## 検討した代わり

- `Adapter` に `usage_screen` の関数のポインターを足す案。`launch` は L2 のファイルで、この Issue の書くパスの外にあり、CLI は cursor の 1 つだけなので取らなかった。2 つ目の CLI が画面で使用量を答えるようになったら、`launch` に移す
- `RoleFit` を作らず、TypeScript と同じく `edits: false` だけを見る案。ADR `0248-launch-adapters` の決定と、#189 の 8・#190 の欠陥を Rust 版に写さない方針に反するので取らなかった
- 共通の `FakeRuntime` に `interrupt` の差し替えを足す案。`tests/common/` は ADR `0242-phase-3-split` がこの Issue に書かせないファイルなので取らなかった

## 依存

なし。

## 結果

- O7(#267)と API(#269)は、`spawn` が `avoid`、`refusal`、モデル一覧、使用量で候補を飛ばし、`skipped` に理由を残すことを前提にできる
- core(LIVE)は、`UsageTracker` と `ModelCatalog` を `Arc<dyn UsageGate>`、`Arc<dyn ModelGate>` として `OrchestratorDeps` に渡せる
- 画面で使用量を答える CLI を足すときは、`usage_screen` に読み手を足す

## 確かめたこと

- `cargo test --locked -p herdr-fleet-orchestrator --test candidates`: 28 件が通る。うち 25 件は `orchestrator.test.ts` の describe `model thinking policy`(3)、`model fallbacks`(5)、`a model the CLI does not offer`(2)、`usage routing`(14)と `agent kinds` の 1 件で、期待値は TypeScript のテストのもの。残りの 3 件は、agy が fleet コマンドを使う役割と reviewer を飛ばすことと、`ModelCatalog` の impl が完全な一覧にないモデルを飛ばすこと
- 実装の前(trait の impl だけを足した stub)に同じコマンドを走らせ、28 件のうち 24 件が失敗した
