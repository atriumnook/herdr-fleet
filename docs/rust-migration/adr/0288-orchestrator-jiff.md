# orchestrator の依存に jiff を足す

- 状態: 採用
- 決めた日: 2026-11-09
- Issue: #288

## 状況

ADR `0244-phase-3-dependencies` の表は、jiff を使う crate を cli だけにした。しかし段階 3 の #254(L3、使用量)は、orchestrator の中で次の 2 つの時刻を TypeScript と同じに読む。

- `claude -p /usage` の解除の時刻(`Oct 4, 9:50pm (Asia/Tokyo)`): TypeScript の `zonedTime`(`server/fleet/usage.ts:75`)は、括弧の中の IANA の地域の名前を `Intl.DateTimeFormat` の `timeZone` に渡して、その地域の時計の時刻を UTC の時刻に直す。地域が見つからなければ NaN を返す。地域の名前から UTC の時刻を出すには tz データベースが要る
- エラーの文の時計の時刻(`try again at 3:45 PM`): TypeScript(`server/fleet/usage.ts:138-146`)は `Date.prototype.setHours` で、サーバーの地域の時刻として読む。サーバーの地域(環境変数 `TZ` か `/etc/localtime`)を読むにも tz データベースが要る

ADR `0242-phase-3-split` の「Issue の分け方」により、#254 は crate の manifest と `rust/Cargo.lock` を書けない。そのため、manifest を書くこの Issue を別に開いた(ADR `0244-phase-3-dependencies` の「あとの Issue で feature や crate が足りないと分かったら、足す Issue を別に開いて待つ」。ADR `0277-child-process-serde-json` と同じ形)。

## 決定

`rust/crates/orchestrator/Cargo.toml` の `[dependencies]` に `jiff.workspace = true` を足す。feature は crate の側では足さず、workspace の指定(jiff の既定の feature: `std`、`tz-system`、`tz-fat`、`tzdb-bundle-platform`、`tzdb-zoneinfo`、`tzdb-concatenated`、`perf-inline`)をそのまま使う。

orchestrator が使う jiff の機能は次の 2 つである。

- `TimeZone::get`(地域の名前から): 解除の時刻の括弧の中の名前を tz データベースで引く。名前が見つからなければ `Err` を返すので、TypeScript の `zonedTime` が NaN を返す場合に当たる。Unix では `/usr/share/zoneinfo` を読み(`tzdb-zoneinfo`)、Windows では jiff に同梱のデータを使う(`tzdb-bundle-platform`)
- `TimeZone::system`(サーバーの地域): エラーの文の時計の時刻を、サーバーのプロセスの地域で読む。jiff は環境変数 `TZ` を先に見て、なければ `/etc/localtime` を読む(Windows では OS の設定)。Bun の `Date` がサーバーのプロセスの地域を使うのと同じである。ADR `0242-phase-3-split` は CLI に `TimeZone::system` を使わせない(CLI は `run` に渡された `env` の `TZ` を使うため)が、orchestrator はサーバーのプロセスそのものの地域を読むので、この制約は当たらない

この ADR は、ADR `0244-phase-3-dependencies` の決定を置き換えずに補う。ADR の README のとおり 0244 は書き換えないので、0244 の表の jiff の行は使う crate を cli だけとしているが、jiff を使う crate は cli と orchestrator の 2 つである。

## 検討した代わり

- TZif のファイルを読む関数を orchestrator の中に自分で書く: jiff はすでに workspace にあり、cli が使っている。Rust の標準ライブラリには地域の時刻を扱う機能がない。自作すると、TZif の読み取りと POSIX の `TZ` の規則の解釈を自分で保守し、Windows で使う tz データベースも別に持つ必要がある
- 地域の時刻を扱う別の crate(chrono と chrono-tz など)を足す: 新しい外部 crate が `Cargo.lock` に入り、ADR `0244-phase-3-dependencies` の依存の確認をやり直すことになる。jiff で 2 つの機能が足りる
- #254 の書くパスに manifest を足す: ADR `0242-phase-3-split` の分け方を変えることになる。同じ ADR が manifest と `Cargo.lock` を D と、足りないものを足す別の Issue にだけ書かせるのは、並行する Issue が同じファイルを書かないようにするためである(99 行目)

## 依存

新しい外部 crate はない。jiff 0.2.41 は workspace にすでにあり(`rust/Cargo.toml` の `[workspace.dependencies]`)、入手元、ライセンス、保守の状況、`build.rs` は ADR `0244-phase-3-dependencies` の「依存」のとおり。`Cargo.lock` に新しい package は入らず、変わるのは `herdr-fleet-orchestrator` の `dependencies` に `"jiff"` が 1 行増えることだけである。cli がすでに同じ既定の feature で jiff を使っているので、workspace の build で有効になる jiff の feature も変わらない。

## 結果

- #254 は、解除の時刻を `TimeZone::get` で、エラーの文の時計の時刻を `TimeZone::system` で読める
- crate の間の依存は変わらない(ADR `0107-crate-split` の表のまま)。jiff は外部 crate で、orchestrator が新しく依存する workspace の crate はない
- `TimeZone::system` はプロセスの環境変数 `TZ` を読む。edition 2024 では `std::env::set_var` が unsafe で、workspace は `unsafe_code = "forbid"` なので、テストの中でプロセスの `TZ` を変えることはできない。サーバーの地域に依存する読み取りをどう確かめるかは、#254 が決める

## 確かめたこと

PC は Linux 7.2.15(omarchy)、rustc 1.99.1、`rust/` で実行した。

- 変える前に `cargo tree --locked -p herdr-fleet-orchestrator -e normal --depth 1` を走らせ、jiff が出ないことを見た。変えたあとは `jiff v0.2.41` が加わった
- `git diff origin/rust...HEAD -- rust/Cargo.lock`(`git fetch origin rust` のあと)の差分は、`herdr-fleet-orchestrator` の `dependencies` に `"jiff"` を足す 1 行だけだった
- `cargo tree -e features -i jiff --workspace --depth 1` で、有効な feature が jiff の既定の feature(と、それが有効にする `alloc`)であることを見た
- jiff 0.2.41 のソース(`src/tz/timezone.rs`)で、`TimeZone::get(&str) -> Result<TimeZone, Error>` と `TimeZone::system() -> TimeZone` が公開されていること、`system` が `TZ` を先に見て、なければ `/etc/localtime` を読むことを見た
- `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace` が通った(522 件。`origin/rust` を取り込んだあとは 555 件)
