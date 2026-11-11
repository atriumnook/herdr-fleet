# herdr の crate が herdr_api を再 export する

- 状態: 採用
- 決めた日: 2026-11-11
- Issue: #328

## 状況

HR(#261)の `HerdrRuntime` は、`Herdr::call::<M>` と `Herdr::rpc::<M>` に herdr の method の型(`herdr_api::methods::AgentGet` など)を渡し、params の型(`AgentStartParams` など)を作る。ところが orchestrator の manifest の依存に herdr-api はなく(ADR `0107-crate-split` の表でも、orchestrator の依存は protocol、screen、herdr、child-process)、herdr も protocol も `herdr_api` を再 export していなかった。そのため orchestrator は method の型を名指しできず、`HerdrRuntime` を compile できなかった。

herdr の公開の口は、すでに herdr_api の型を引数と戻り値に出している: `Herdr::rpc` と `Herdr::call` の `M: Method` と `M::Params`、`EventSource::subscribe` の `Vec<herdr_api::Subscription>`、`pane_status` の `herdr_api::PaneInfo`。

crate の公開の口の変更なので、architect(fleet の run `9da49253`、読むだけ)に問い、その答えに従った。

## 決定

`rust/crates/herdr/src/lib.rs` に `pub use herdr_api;` の 1 行を足す。orchestrator は `herdr::herdr_api::methods::AgentGet`、`herdr::herdr_api::AgentStartParams` のように書く。orchestrator の manifest には herdr-api を足さない。

型を公開の口に出す crate がその依存を再 export すれば、呼ぶ側はその crate だけで口を使える。herdr の wire の型を持つのは herdr の crate で、orchestrator は herdr の crate を通してだけ herdr と話す。core は herdr-api への直接の依存を持ったままでよい(ADR `0107-crate-split` の core の行)。

## 検討した代わり

- orchestrator の `[dependencies]` に `herdr-api.workspace = true` を足す: `Cargo.lock` と ADR `0107-crate-split` の表が変わる。ADR `0242-phase-3-split` は、並行する Issue が同じ `Cargo.lock` を書かないよう、manifest の変更を 1 つの Issue に集めた。前の ADR は書き換えないので、表を置き換える ADR も要る
- 要る型だけを並べて再 export する(`pub use herdr_api::{methods, AgentStartParams, …}`): HR や段階 4 の Issue が method を足すたびに、手で保つ一覧が伸びる

## 依存

なし(herdr の manifest にすでにある herdr-api を再 export するだけで、manifest と `Cargo.lock` は変わらない)。

## 結果

- orchestrator のコードとテストは、herdr_api の型を `herdr::herdr_api` から名指す。HR の `herdr_runtime.rs` と `tests/herdr_runtime.rs` が最初の使い手である
- orchestrator が herdr-api の型を使うことは、orchestrator の manifest には現れない。その代わり、依存の辺、`Cargo.lock`、ADR `0107-crate-split` の表を変えずに済む

## 確かめたこと

2026-11-11、Linux(Omarchy、kernel 7.2.15)、`rust/` で、この 1 行と HR の変更を入れて次が通った。

- `cargo check --locked -p herdr-fleet-orchestrator --tests`
- `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace`
