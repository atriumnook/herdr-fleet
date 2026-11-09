# 役割のファイルの frontmatter を saphyr で読む

- 状態: 採用
- 決めた日: 2026-11-09
- Issue: #279

## 状況

役割のファイル(同梱の `agents/*.md`、利用者とプロジェクトの `.herdr-fleet/agents/*.md`)の frontmatter は YAML で、TypeScript は `Bun.YAML.parse` で読む(`server/fleet/agents.ts:12-17`)。Rust の orchestrator でこれを読むのは #247(L1)で、`rust/Cargo.lock` に YAML の crate はなく、ADR `0244-phase-3-dependencies` の一覧にもない。#247 の architect(fleet の run `acd0f35f`、読むだけ)に、YAML の部分集合を自分で書くか crate を足すかを聞き、crate を足すと決めた。理由は次の 3 つ。

- 本番のサーバーは、役割の読み込みの警告を捨てる(`server/index.ts:534` と `:558` は warnings を渡さない)。自作の部分集合が読めないファイルは、知らせなしに飛ばされ、同じ名前の同梱の役割に置き換わる(`server/fleet/agents.ts:66-69`)
- `edits: false` の読み取りは、スカラーの型の決め方に依存する。Bun 1.4.4 は YAML 1.2 の core schema で読み、`True`・`FALSE` を真偽値に、`yes`・`no` を文字列にする。自作の型の決め方がこれと食い違うと、編集しない役割が編集する役割として起動しうる
- 全体の決まりで、選ぶ順は「実績があり保守されているライブラリ > 自作」である

あわせて、fleet.json の `FleetConfig` の `roles`・`models`・`projects` は利用者が名前を決める map で、ADR `0244-phase-3-dependencies` の「map の順」の決まりにより `IndexMap` にする。`projects` の並びは設定の画面に出る(`server/fleet/settings.ts:84` が fleet.json の順で並べる)。orchestrator はまだ indexmap に依存していない。

ADR `0242-phase-3-split` の「Issue の分け方」により、#247 は manifest と `Cargo.lock` を書けない。そのため、この Issue で足す。

## 決定

`rust/crates/orchestrator/Cargo.toml` の `[dependencies]` に、次の 3 つを足す。

| 依存 | 指定 | 使い道 |
|---|---|---|
| saphyr | `version = "0.3.3"`、`default-features = false` | 役割のファイルの frontmatter を、YAML 1.2 の core schema で `saphyr::Yaml` に読む |
| saphyr-parser | `"0.3.3"` | `saphyr_parser::Parser` で `saphyr::YamlLoader` に読ませる。重複したキーを後の値で読む設定(`YamlLoader::allow_duplicate_keys(true)`)は、この形でしか使えない |
| indexmap | `indexmap.workspace = true` | `FleetConfig` の `roles`・`models`・`projects` を、fleet.json に書かれた順のまま持つ |

- saphyr を workspace の `[workspace.dependencies]` に書かず orchestrator の manifest に直接書くのは、使う crate が orchestrator だけで、この Issue の書くパスに `rust/Cargo.toml` がないため。2 つ目の crate が使うときに workspace へ移す
- `default-features = false` は、既定の feature `encoding`(`encoding_rs` で UTF-8 以外の符号化を読む)を外す。役割のファイルは UTF-8 の文字列として読んでから渡す(TypeScript も `readFileSync(filePath, "utf8")`)
- saphyr-parser を直接の依存にするのは、saphyr が `Parser` を再 export しないため(`saphyr` 0.3.3 の `src/lib.rs:150-173`)。`LoadableYamlNode::load_from_str` は既定の loader で読み、重複したキーを `duplicated key in mapping` のエラーにする。Bun は後の値を使う。saphyr-parser は saphyr の依存としてどのみち入る crate で、直接の依存にしても package は増えない
- 読み方は次の形になる(試作で確かめた。下の「確かめたこと」)

  ```rust
  let mut loader: saphyr::YamlLoader<saphyr::Yaml> = saphyr::YamlLoader::default();
  loader.allow_duplicate_keys(true);
  saphyr_parser::Parser::new_from_str(source).load(&mut loader, true)?;
  if let Some(error) = loader.error() { /* 読み取りのエラー */ }
  let documents = loader.into_documents();
  ```

### saphyr が Bun 1.4.4 と違う点

同じ YAML を saphyr 0.3.3(上の読み方)と Bun 1.4.4 の `Bun.YAML.parse` で読み比べた(下の「確かめたこと」)。違ったのは次の 8 点。#247 が、Bun に合わせるかどうかを点ごとに決める。

| 入力 | Bun 1.4.4 | saphyr 0.3.3 |
|---|---|---|
| merge key: `base: &b {x: 1, y: 1}` と `m: {<<: *b, y: 2}` | 展開する。`m` は `{"y":2,"x":1}` | 展開しない。`m` は `<<` というキーを持ち、値は `base` の mapping(`{"<<":{"x":1,"y":1},"y":2}`) |
| merge key の列: `m: {<<: [*a, *b], w: 0}`(`a` は `{x: 1}`、`b` は `{x: 2, z: 3}`) | 展開し、先の mapping が勝つ。`m` は `{"x":1,"z":3,"w":0}` | 展開しない。`<<` の値は 2 つの mapping の列 |
| 独自の tag: `a: !custom x` | tag を捨て、`"x"` | `Yaml::Tagged`(tag `!custom`、中身 `"x"`)。中身だけを読むには `Tagged` を外す |
| 文字列でないキー: `1: a`、`true: b`、`null: c`、`? [x]` | キーを文字列にする(`"1"`、`"true"`、`"null"`、列は `"x"`) | キーを型のまま持つ(`Integer(1)`、`Boolean(true)`、`Null`、`Sequence`)。文字列のキーで引いても当たらない |
| 空の frontmatter、またはコメントだけ | `null`(TypeScript は `{}` として扱う) | 文書が 0 個 |
| 2 つの文書: `a: 1`、`...`、`b: 2` | 文書の配列(TypeScript は `frontmatter must be a mapping` で断る) | 文書が 2 個 |
| alias を重ねて 100000 個を超えるノードに展開される入力(6 段、各段 10 個) | 同じオブジェクトを共有して読む | 読み取りのエラー(`alias expansion exceeded the maximum node budget`)。上限は `YamlLoader::alias_limit` で変えられる |
| 読み取りのエラーの文(`a: [1, 2` で終わる入力) | `YAML Parse error: Unexpected token` | `while parsing a flow sequence, expected ',' or ']' at byte 9 line 2 column 1` |

次の点は同じだった。

- 明示の tag: `a: !!str 1` は両方 `"1"`。`!!int "12"` は両方 `"12"`(文字列のまま)、`!!bool "true"` は両方 `"true"`(文字列のまま)、`!!float 1` は両方 1
- 真偽値: `True`・`FALSE`・`TRUE` は真偽値、`tRuE`・`yes`・`no`・`on`・`off` は文字列。`%YAML 1.1` の指示があっても `yes` は文字列
- null: `Null`・`NULL`・`~`・`null`・値なしは null、`nUll` は文字列
- 数: `0o17` は 15、`0x1F` は 31、`017` は 17、`1e3` は 1000、`.inf`・`-.Inf`・`.nan`、`1.10` は 1.1、`1_000` は文字列、i64 を超える `12345678901234567890` は同じ f64 の値。saphyr は整数(`Integer`)と小数(`FloatingPoint`)を分け、JavaScript は分けない(`1e3` は saphyr では `FloatingPoint(1000.0)`)
- 日付の形の `2001-12-14` は両方文字列
- 重複したキー `a: 1`、`a: 2` は両方 `{"a":2}`(saphyr は `allow_duplicate_keys(true)` のとき)
- alias、二重引用符のエスケープ、単一引用符、`|` と `>`、flow の列、タブでの字下げ(両方エラー)
- 同梱の役割と同じ形の frontmatter(`name`、`agent`、`edits: false`、`fallbackModels: [opus, sonnet]`、`tools: read, write`、`description: >`、`thinking: high`)は同じ値

## 検討した代わり

- YAML の部分集合を自分で書く: 「状況」の 3 つの理由で採らない(#247 の architect の答え)
- yaml-rust2 0.13.0(MIT OR Apache-2.0): `Null`・`NULL` を文字列にする(Bun と saphyr は null。saphyr `src/scalar.rs:210`)。重複したキーを読み取りのエラーにし、後の値で読む設定がない。saphyr より推移的な依存は少ない。saphyr を入れられない事情(ライセンス、保守)は、下の「依存」を読んだ範囲で見つからなかったので、saphyr にした
- saphyr の既定の loader(`Yaml::load_from_str`)だけを使い、saphyr-parser を足さない: 重複したキーがあるファイルを読み取りのエラーにする。Bun は読めるので、そのファイルが知らせなしに同梱の役割に置き換わる(「状況」の 1 つ目)
- saphyr の既定の feature を残す: `encoding_rs` が入る。UTF-8 以外の符号化を読む場面がない

## 依存

この Issue で `rust/Cargo.lock` に新しく入った package は次の 9 個(版、作られた日、版の数、最新の版の公開日は 2026-11-09 に crates.io の API で読んだもの)。indexmap 2.14.2 と hashbrown 0.17.1(hashlink が使う)、syn 3.0.9・proc-macro2・quote(thiserror-impl が使う)はすでに `Cargo.lock` にあった。

| crate | 版 | 入手元 | ライセンス | 保守の状況 | `build.rs` |
|---|---|---|---|---|---|
| saphyr | 0.3.3 | crates.io、https://github.com/saphyr-rs/saphyr | MIT OR Apache-2.0 | 2026-10-27 公開。22 版。2024-04 から続く。リポジトリは GitHub の saphyr-rs の organization にある | なし(`build = false`) |
| saphyr-parser | 0.3.3 | crates.io、https://github.com/saphyr-rs/saphyr | MIT OR Apache-2.0 | 2026-10-27 公開。22 版。saphyr と同じリポジトリ | なし(`build = false`) |
| hashlink | 0.12.2 | crates.io、https://github.com/djc/hashlink | MIT OR Apache-2.0 | 2026-09-07 公開。22 版。2019 年から続く | なし(`build = false`) |
| ordered-float | 5.5.1 | crates.io、https://github.com/reem/rust-ordered-float | MIT | 2026-10-25 公開。61 版。2014 年から続く。saphyr は `default-features = false` で使う | なし(`build = false`) |
| num-traits | 0.2.19 | crates.io、https://github.com/rust-num/num-traits | MIT OR Apache-2.0 | 2024-05-03 公開。32 版。rust-num の organization が保守する | あり。autocfg で、環境変数 `RUSTC` の rustc に式 `1f64.total_cmp(&2f64)` を compile させ、通れば `cargo:rustc-cfg=has_total_cmp` を出す。compile の結果は cargo の `OUT_DIR` の中にだけ書く。ネットワークは使わない |
| autocfg | 1.5.1 | crates.io、https://github.com/cuviper/autocfg | Apache-2.0 OR MIT | 2026-05-22 公開。18 版。num-traits の `build.rs` だけが使う(build-dependency) | なし(`build = false`) |
| arraydeque | 0.5.1 | crates.io、https://github.com/andylokandy/arraydeque | MIT/Apache-2.0 | 2023-02-05 公開。13 版。最後の公開から 3 年 9 か月、新しい版がない。saphyr-parser が `default-features = false` で使う。固定長の両端キューで、`src/` に `unsafe` を含む行が 73 行ある | なし(`build.rs` のファイルがない) |
| thiserror | 2.0.21 | crates.io、https://github.com/dtolnay/thiserror | MIT OR Apache-2.0 | 2026-09-23 公開。92 版。2019 年から続く | あり。cargo の `OUT_DIR` に `private.rs` を書く。環境変数 `RUSTC`(`RUSTC_WRAPPER`・`RUSTC_WORKSPACE_WRAPPER` があればそれを通す)で rustc を起動し、同梱の `build/probe.rs` を `OUT_DIR/probe` に compile して、不安定の機能 `error_generic_member_access` が使えるかを試す(終わると `OUT_DIR/probe` を消す)。rustc を `--version` で起動して版を読み、`cargo:rustc-cfg` を出す。ネットワークは使わない |
| thiserror-impl | 2.0.21 | crates.io、https://github.com/dtolnay/thiserror | MIT OR Apache-2.0 | 2026-09-23 公開。91 版。thiserror の手続きマクロで、build のときに動く | なし(`build = false`) |

saphyr と saphyr-parser の `src/` に `unsafe` はない(`grep -rn unsafe` で 0 件)。arraydeque は新しい版が出ていないが、saphyr-parser が使うのは、文字の iterator から読む `BufferedInput`(`Parser::new_from_iter`、`src/input/buffered.rs`)の先読みのバッファーだけである。上の読み方の `Parser::new_from_str` は `StrInput` で読み、arraydeque のコードを通らない。arraydeque に問題が見つかれば、saphyr の版を上げるか yaml-rust2 に替える Issue を開く。

## 結果

- #247(L1)は、役割のファイルの frontmatter を、上の「決定」の読み方で `saphyr::Yaml` に読める。`FleetConfig` の map を `indexmap::IndexMap` で書ける
- #247 は、「saphyr が Bun 1.4.4 と違う点」の 8 点について、Bun に合わせるか、違いを残して PR に書くかを決める。役割のファイルの読み取りで値が変わりうるのは、merge key、独自の tag、文書の数(0 個は `{}`、2 個以上は `frontmatter must be a mapping`)、alias の展開の上限。文字列でないキーは、`name`・`edits` などの文字列のキーで引く限り結果を変えない。エラーの文は、本番のサーバーが警告を捨てるので画面には出ないが、`discoverAgents` に warnings を渡すテストや呼び出し元では文が変わる
- `Cargo.lock` に 9 個の package が入る。orchestrator を build するたびに num-traits と thiserror の `build.rs` が rustc を起動する

## 確かめたこと

PC は Linux 7.2.15(omarchy)、rustc と cargo 1.99.1、Bun 1.4.4。`rust/` で実行した。

- 足す前: `cargo tree --locked -p herdr-fleet-orchestrator -e normal --depth 1` の出力に `saphyr`・`saphyr-parser`・`indexmap` の行がなかった(`grep -cE 'saphyr|indexmap'` が 0)
- 足したあと: 同じコマンドの出力に `indexmap v2.14.2`、`saphyr v0.3.3`、`saphyr-parser v0.3.3` の行が出た。cargo は `Locking 9 packages` と書き、上の「依存」の 9 個を足した
- `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace`(314 件)が通った
- 読み比べ: workspace の外の使い捨ての crate(saphyr `=0.3.3` と saphyr-parser `=0.3.3`、`default-features = false`)で、上の読み方で読んだ値を JSON に写して書き、同じファイルを Bun 1.4.4 の `Bun.YAML.parse` で読んで JSON にした。入力は 22 件(merge key 2 件、明示の tag、独自の tag、真偽値、null、重複したキー、数、日付、役割の形、文字列でないキー、2 つの文書 2 件、空、コメントだけ、閉じない flow の列、alias、文字列、タブでの字下げ、`%YAML 1.1` の指示、複雑なキー、alias の展開)。Bun が単一の文書を値のまま返し、saphyr が文書の列を返すことのほかの違いは、上の表の 8 点だった。既定の loader(`Yaml::load_from_str`)は重複したキーの件だけを `duplicated key in mapping at byte 5 line 2 column 1` で断り、ほかの件の成否は上の読み方と同じだった
- saphyr、saphyr-parser、num-traits、thiserror、arraydeque の manifest、`build.rs`、saphyr の `src/loader.rs`(`allow_duplicate_keys`、`alias_limit`、`load_from_parser`)を `~/.cargo/registry/src/` で読んだ
