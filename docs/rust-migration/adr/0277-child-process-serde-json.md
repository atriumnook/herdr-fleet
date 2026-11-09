# child-process の依存に serde_json を足す

- 状態: 採用
- 決めた日: 2026-11-09
- Issue: #277

## 状況

ADR `0244-phase-3-dependencies` の表は、child-process の外部の依存を tokio、tokio-util、rustix の 3 つにした。しかし段階 3 の次の 2 つの Issue は、child-process の中で JSON を読む。

- #253(C2): `opencode api GET <path>` の返答を JSON として読む。TypeScript の `server/opencode-cli.ts` は、終了コード 0 で JSON として読めない返答を読み直し(147 行目)、エラーの返答の本文から `_tag` を読む(152 行目)。ADR `0107-crate-split` も「`record`(JSON の値をオブジェクトとして読む小さな関数)は、Rust では serde_json の機能で足りる」と書いており、child-process が serde_json を使う前提である
- #246(C1): C2 が中身を書く `opencode` の module の stub を、最終の signature で置く。`get` は、transcript の trait `OpencodeApi::get`(`rust/crates/transcript/src/opencode/mod.rs:33`)と同じく `serde_json::Value` を返す。core はこの client を包んで transcript の trait を実装する(ADR `0107-crate-split`)。C1 のテストは、安全上の判定の表(`fixtures/security/child-process/*.json`)も serde_json で読める

ADR `0242-phase-3-split` の「Issue の分け方」により、C1 と C2 は child-process の manifest を書けない。そのため、manifest を書くこの Issue を別に開いた(ADR `0244-phase-3-dependencies` の「あとの Issue で feature や crate が足りないと分かったら、足す Issue を別に開いて待つ」)。

## 決定

`rust/crates/child-process/Cargo.toml` の `[dependencies]` に `serde_json.workspace = true` を足す。feature は crate の側では足さず、workspace の指定(`float_roundtrip`、`preserve_order`)をそのまま使う。ほかの 8 つの crate(protocol、herdr-api、herdr、screen、transcript、orchestrator、core、cli)と同じ書き方である。

この ADR は、ADR `0244-phase-3-dependencies` の決定を置き換えずに補う。ADR の README のとおり 0244 は書き換えないので、0244 の表の child-process の行(tokio、tokio-util、rustix)と、serde_json を足した crate の一覧(herdr-api、herdr、orchestrator、core、cli)には child-process が載っていない。child-process の外部の依存は、その 3 つに serde_json を足した 4 つである。

## 検討した代わり

- C1 と C2 が、JSON を読む小さな関数を child-process の中に自分で書く: `get` の返り値を transcript の trait と同じ `serde_json::Value` にできず、core が包むときに値を変換し直す必要がある。JSON の読み取りを crate ごとに書き分けることにもなる
- C1 か C2 の書くパスに manifest を足す: ADR `0242-phase-3-split` の分け方を変えることになる。同じ ADR が manifest と `Cargo.lock` を D と、足りないものを足す別の Issue にだけ書かせるのは、並行する Issue が同じファイルを書かないようにするためである(146 行目)。C1 や C2 が書くと、段階 3 のほかの Issue と並行して `Cargo.lock` を書きうる

## 依存

新しい外部 crate はない。serde_json 1.0.154 は workspace にすでにあり(`rust/Cargo.toml` の `[workspace.dependencies]`)、入手元、ライセンス、保守の状況、`build.rs` は段階 2 で入れたときの ADR `0193-phase-2-dependencies` のとおり。`Cargo.lock` に新しい package は入らず、変わるのは `herdr-fleet-child-process` の `dependencies` に `"serde_json"` が 1 行増えることだけである。

## 結果

- C1 は `opencode` の stub の `get` を `serde_json::Value` を返す signature で置け、テストは安全上の判定の表を serde_json で読める
- C2 は `opencode api` の返答を serde_json で読める。JSON として読めない返答を見分けて読み直し、エラーの本文から `_tag` を読むのに使う
- child-process は transcript にも protocol にも依存しないまま(ADR `0107-crate-split` の表のまま)で、crate の間の依存は変わらない

## 確かめたこと

PC は Linux 7.2.15(omarchy)、rustc 1.99.1、`rust/` で実行した。

- 変える前に `cargo tree -p herdr-fleet-child-process -e normal --depth 1` を走らせ、serde_json が出ないことを見た(rustix、tokio、tokio-util の 3 つだけ)。変えたあとは `serde_json v1.0.154` が加わった
- `git diff origin/rust...HEAD -- rust/Cargo.lock`(`git fetch origin rust` のあと)の差分は、`herdr-fleet-child-process` の `dependencies` に `"serde_json"` を足す 1 行だけだった
- `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace`(235 件)が通った
