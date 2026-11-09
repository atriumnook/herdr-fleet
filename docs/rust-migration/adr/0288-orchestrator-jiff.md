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

- `TimeZone::get`(地域の名前から): 解除の時刻の括弧の中の名前を tz データベースで引く。名前が見つからなければ `Err` を返す(TypeScript の `zonedTime` が NaN を返す場合に当たる)。名前は大文字と小文字を区別せずに引く(`src/tz/db/zoneinfo/enabled.rs`)。Unix では、環境変数 `TZDIR` が示すフォルダー、なければ `/usr/share/zoneinfo`、`/usr/share/lib/zoneinfo`、`/etc/zoneinfo` を探して読み(`tzdb-zoneinfo`。`src/tz/db/zoneinfo/enabled.rs`)、Windows では jiff に同梱のデータを使う(`tzdb-bundle-platform`)
- `TimeZone::system`(サーバーの地域): エラーの文の時計の時刻を、サーバーのプロセスの地域で読む。jiff は環境変数 `TZ` を先に見て、なければ `/etc/localtime` を読む(Windows では OS の設定)。Bun の `Date` も、サーバーのプロセスの地域で時刻を読む。ADR `0242-phase-3-split` は CLI に `TimeZone::system` を使わせない(CLI は `run` に渡された `env` の `TZ` を使うため)が、orchestrator はサーバーのプロセスそのものの地域を読むので、この制約は当たらない

この ADR は、ADR `0244-phase-3-dependencies` の決定を置き換えずに補う。ADR の README のとおり 0244 は書き換えないので、0244 の表の jiff の行は使う crate を cli だけとしているが、jiff を使う crate は cli と orchestrator の 2 つである。

## 検討した代わり

- TZif のファイルを読む関数を orchestrator の中に自分で書く: jiff はすでに workspace にあり、cli が使っている。Rust の標準ライブラリには地域の時刻を扱う機能がない。自作すると、TZif の読み取りと POSIX の `TZ` の規則の解釈を自分で保守し、Windows で使う tz データベースも別に持つ必要がある
- 地域の時刻を扱う別の crate(chrono と chrono-tz など)を足す: 新しい外部 crate が `Cargo.lock` に入り、ADR `0244-phase-3-dependencies` の依存の確認をやり直すことになる。jiff で 2 つの機能が足りる
- #254 の書くパスに manifest を足す: ADR `0242-phase-3-split` の分け方を変えることになる。同じ ADR が manifest と `Cargo.lock` を D と、足りないものを足す別の Issue にだけ書かせるのは、並行する Issue が同じファイルを書かないようにするためである(99 行目と 146 行目)

## 依存

新しい外部 crate はない。jiff 0.2.41 は workspace にすでにあり(`rust/Cargo.toml` の `[workspace.dependencies]`)、入手元、ライセンス、保守の状況、`build.rs` は ADR `0244-phase-3-dependencies` の「依存」のとおり。`Cargo.lock` に新しい package は入らず、変わるのは `herdr-fleet-orchestrator` の `dependencies` に `"jiff"` が 1 行増えることだけである。cli がすでに同じ既定の feature で jiff を使っているので、workspace の build で有効になる jiff の feature も変わらない。

## 結果

- #254 は、解除の時刻を `TimeZone::get` で、エラーの文の時計の時刻を `TimeZone::system` で読める
- crate の間の依存は変わらない(ADR `0107-crate-split` の表のまま)。jiff は外部 crate で、orchestrator が新しく依存する workspace の crate はない
- jiff と TypeScript の違いのうち、次の 3 つは #254 が扱いを決め、TypeScript と違う結果になる場合は PR に書く
  - `TimeZone::system` は、地域を決められないとき(`/etc/localtime` がない環境など)、警告を log に出すだけで UTC と同じに振る舞う `Etc/Unknown` を返し、エラーにしない。失敗を見分けるには `TimeZone::try_system` を使う
  - `TimeZone::system` は、読んだ地域を 5 分のあいだ覚える(`src/tz/system/mod.rs` の `TTL`)。サーバーが動いている間に `TZ` か `/etc/localtime` が変わると、最大 5 分は古い地域で読む
  - `TimeZone::get` が引けるのは tz データベースにある名前だけである。Bun 1.4.4 の `new Intl.DateTimeFormat("en-US", { timeZone })` と、同じ文字列で比べた結果は次のとおり。`Asia/Tokyo`、`asia/tokyo`、`UTC`、`utc`、`EST5EDT` は両方が受け付け、`JST` は両方が受け付けない。`+09:00`(オフセットの形)は TypeScript だけが受け付け、jiff は `Err` を返す。`Etc/Unknown` は jiff だけが受け付け(UTC と同じに振る舞う)、TypeScript は `RangeError` を投げる(`zonedTime` は NaN を返す)。Linux では、`TZDIR` と「決定」に書いた 3 つの場所のどれにも tz データベースがないと、jiff はどの名前も引けない(`tzdb-bundle-platform` が同梱のデータを使うのは Windows と wasm だけ。ADR `0244-phase-3-dependencies` の「依存」)
- `TimeZone::system` はプロセスの環境変数 `TZ` を読む。edition 2024 では `std::env::set_var` が unsafe で、workspace は `unsafe_code = "forbid"` なので、テストの中でプロセスの `TZ` を変えることはできない。サーバーの地域に依存する読み取りをどう確かめるかは、#254 が決める

## 確かめたこと

PC は Linux 7.2.15(omarchy)、rustc 1.99.1、`rust/` で実行した。

- 変える前に `cargo tree --locked -p herdr-fleet-orchestrator -e normal --depth 1` を走らせ、jiff が出ないことを見た。変えたあとは `jiff v0.2.41` が加わった
- `git diff origin/rust...HEAD -- rust/Cargo.lock`(`git fetch origin rust` のあと)の差分は、`herdr-fleet-orchestrator` の `dependencies` に `"jiff"` を足す 1 行だけだった
- `cargo tree -e features -i jiff --workspace --depth 1` で、有効な feature が jiff の既定の feature(と、それが有効にする `alloc`)であり、`origin/rust` の内容(`git archive` で書き出したもの)で走らせた出力と同じであることを見た
- jiff 0.2.41 のソース(`src/tz/timezone.rs`)で、`TimeZone::get(&str) -> Result<TimeZone, Error>` と `TimeZone::system() -> TimeZone` が公開されていること、`system` が `TZ` を先に見て、なければ `/etc/localtime` を読むことを見た。同じソースで、`system` が失敗を `Etc/Unknown` で返すこと、地域を 5 分覚えること(`src/tz/system/mod.rs:69`)、zoneinfo の名前の検索が大文字と小文字を区別しないこと(`src/tz/db/zoneinfo/enabled.rs:557`)、zoneinfo を探す場所(同じファイルの 26 行目と、`TZDIR` を見る 44 行目)を見た
- 地域の文字列 8 つ(`Asia/Tokyo`、`asia/tokyo`、`+09:00`、`UTC`、`utc`、`EST5EDT`、`Etc/Unknown`、`JST`)を、Bun 1.4.4 の `Intl.DateTimeFormat` と、jiff 0.2.41 の `TimeZone::get`(この PC の `/usr/share/zoneinfo` を読む、使い捨ての crate)に渡して比べた。結果は「結果」に書いたとおり
- `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace` が通った(522 件。`origin/rust` を取り込んだあとは 555 件)
