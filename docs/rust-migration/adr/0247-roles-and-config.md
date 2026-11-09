# 役割のファイルの YAML を saphyr で読み、lead と coordinator を agy に載せない検査を adapter に置く

- 状態: 採用
- 決めた日: 2026-11-09
- Issue: #247

## 状況

#247(L1)は、`server/fleet/agents.ts`、`brief.ts`、`config.ts`、`entrances.ts` と `parseCandidate`(`server/fleet/orchestrator.ts:191`)を orchestrator の `agents.rs`、`brief.rs`、`config.rs`、`entrances.rs` に移す。移す前に、次の 3 つを決める必要があった。

- 役割のファイルの frontmatter は YAML で、TypeScript は `Bun.YAML.parse` で読む(`agents.ts:12-17`)。`rust/Cargo.lock` に YAML の crate はなく、ADR `0244-phase-3-dependencies` の一覧にもない。manifest と `Cargo.lock` は、ADR `0242-phase-3-split` の「Issue の分け方」により #247 では書けない
- #189 の 8: agy の sandbox の中では fleet コマンドが動かない(CLAUDE.md の「エージェント CLI の癖」)。それなのに、役割の定義で lead か coordinator を agy に載せれば起動する。この検査を L1 と L2(#248)のどちらに、どの形で置くか。main の直しはまだない
- 4 つの module の公開の形。O1(#256)、O2(#263)、ST(#260)、API(#269)が使う

crate の公開の口に関わるので、architect(fleet の run `acd0f35f`、`spawn --role architect --read-only`)に問いと調べたことを渡して聞いた。この ADR の決定は、その答えのとおりである。

## 決定

### YAML の frontmatter

- YAML の部分集合を自分で書かず、crate の saphyr 0.3.3 で読む。orchestrator の manifest に `saphyr`(`default-features = false`)、`saphyr-parser`、`indexmap.workspace = true` を足すことは、別の Issue #279 で行い、#247 はそれを待つ
- saphyr の値は、`agents.rs` の非公開の関数 `parse_yaml` と `to_json` だけが読み、`serde_json::Value` に変える。その先は `loadDir`(`agents.ts:36-53`)の `typeof` の検査を 1 対 1 で写す。crate を替えても、変えるのはこの 2 つの関数だけで済む
- 読み方は Bun 1.4.4 の `Bun.YAML.parse` に合わせる。合わせ方は次のとおりで、どれも Bun の出力を期待値にしたテストがある(`tests/agents.rs`)
  - 重複したキーは後の値にする(`YamlLoader::allow_duplicate_keys(true)`。そのため `saphyr_parser::Parser` で読む)
  - スカラーの型は saphyr に決めさせず(`early_parse(false)`)、自分で決める。quoted とブロックのスカラーは tag によらず文字列、plain のスカラーは tag がないか `!!bool`・`!!int`・`!!float`・`!!null` なら YAML 1.2 の core schema で読み(空で tag がなければ null)、ほかの tag なら文字列。saphyr の既定は、core schema の外の tag の付いた plain のスカラーの型を推す(`!foo true` が真偽値になる)が、Bun は文字列にする
  - merge key `<<` は、quoted でも alias を通しても展開する。そのマッピング自身のキーが勝ち、列で並べたマッピングは先のものが勝つ。saphyr は展開しない
  - JSON で書けない数(`.inf`、`.nan`)は null にする(Bun と同じ)
  - 文字列でないキーは、JavaScript の `String()` の値にする(ADR `0279-orchestrator-yaml` の「文字列でないキー」)。列は要素を `,` でつなぎ、null の要素は空の文字列にし、入れ子の列も同じようにつなぐ。マッピングは `[object Object]` にする。そのため `? [edits]` と次の行の `: false` は `edits: false` になり、TypeScript と同じく編集しない役割として起動する。数のキーの書き方は JavaScript と違う(`1.0` は Bun では `"1"`、Rust では `"1.0"`)が、数を名前にする役割の項目はないので、読み取る値は変わらない
  - UTF-8 として不正なバイトは U+FFFD に置き換えて読む(TypeScript の `readFileSync(file, "utf8")` と同じ)
- `parse_frontmatter` は公開しない。YAML の crate の型が orchestrator の公開の口に出ないようにするため。`agents.test.ts` の `reads a file without frontmatter as all body` は、frontmatter のないファイルを `discover_agents` に読ませて移した

### lead と coordinator を agy に載せない(#189 の 8)

- fleet コマンドを使う役割かどうかは、fleet.json の上書きのあとの `spawning` で決める。`roles.<name>.spawning` があればそれ、なければ役割のファイルの値、どちらもなければ false(`orchestrator.ts:500` の `canSpawn` と同じ値)。L1 は、この値を返す `AgentDefinition::may_spawn(&self, over: &RoleOverride) -> bool` を置く。O1、O2、ST はこれを使い、既定値 false を 3 か所に書かない
- 「agy の sandbox では fleet コマンドが動かない」という CLI の事実は、L2 の agy の adapter に置き(`AGY_SANDBOX_NOTE` と同じ事実なので、持ち主を 1 つにする)、O2(候補を飛ばし、理由を `run.skipped` に入れる)と ST(設定の変更を `invalid_settings` で断る)が呼ぶ。`AgentDefinition` と `RoleOverride` から L2 の型を作る関数は、L1 と L2 を待つ O1 が置く(#248 と #256 にコメントした)
- L1 は役割のファイルの読み込みでは断らない。同梱の役割に lead と coordinator を agy に載せたものがないことは、`roles.test.ts` の `never puts the coordinator or a lead on agy, first or as a fallback` を移したテストで確かめる

### 公開の形

- `FleetConfig` と `AgentDefinition` は orchestrator に置く。どちらも HTTP に出ない(`shared/` にない)
- `FleetConfig` の `roles`・`models`・`projects` は `IndexMap` にする(ADR `0244-phase-3-dependencies` の「map の順」。`projects` の並びは設定の画面に出る、`settings.ts:84`)。fleet.json に書かれた順を保つ。JavaScript の object は整数に見えるキー(`"10"`)を昇順で先頭に並べるが、`IndexMap` は並べ替えない。役割とモデルの名前が整数だけのことはまずなく、`projects` のキーは絶対パスなので、合わせない。数は `f64` にする(同じ ADR の「数の型」の `FleetSettings` と同じく、fleet.json の値は切り捨てるだけで上限がない)
- 設定を探す場所は引数で受ける。`user_fleet_dir(xdg_config_home, home)` は呼ぶ側が渡す環境変数の値と home から作り(空の `XDG_CONFIG_HOME` は未設定として扱う、`config.ts:24` の `||`)、`load_config`・`load_standing_orders` は利用者のフォルダーを、`AgentDirs` は同梱と利用者の役割のフォルダーを、`EntranceStore` は home を受ける。4 つの module はプロセスの環境変数も home も読まない。edition 2024 では `std::env::set_var` が unsafe で、`unsafe_code = "forbid"` の下ではテストが環境変数を変えられないため
- 同梱の役割のフォルダーは、ADR `0242-phase-3-split` の fleet-guard と同じく、crate のフォルダー(`CARGO_MANIFEST_DIR`)から 3 つ上の `agents/` にする。配布するときの場所は段階 6 で決める
- `RoleSource` は小文字で serialize し、`as_str` を持つ(`/api/fleet/roles` と出来事の記録の両方が `"bundled" | "user" | "project"` と書く)
- 候補の並べ方 `role_candidates(kind, primary, fallbacks)` を `parse_candidate` の隣に置く(TypeScript は `orchestrator.ts:451` と `settings.ts:116` に同じ並べ方を書いている)
- TypeScript で `FleetError` でない `Error` を投げる箇所(`requireThinkingLevel`、entrances のファイルの書き込みの失敗)は、code `internal_error` の `FleetError` にする。`/api/fleet` はこの `Error` を `internal_error`(500)で返す(`api.ts:304`)ので、API の Issue は `internal_error` を 500 にする

### TypeScript と違う振る舞い

- `brief.rs` の `overlap` は、パスを区間ごとに比べる。TypeScript は `relative()` の文字列が `..` で始まるかを見る(`brief.ts:57`)ので、名前が `..` で始まるフォルダー(`/repo/..cache`)を親の外と読み、同じパスを 2 つの run が書けてしまう。Rust は親の中と読む
- 役割のフォルダーのファイルは名前の順に読む。TypeScript の `readdirSync` の順は決まっていない(`settings.ts:105` のコメント)ので、名前の順は TypeScript が取りうる順の 1 つである
- 役割のファイルを名前の順に読むので、同じフォルダーの中の 2 つのファイルが同じ名前の役割を書くと、名前があとのファイルが勝つ。TypeScript では `readdirSync` の順で決まり、移行の間に同じフォルダーを読む 2 つの fleet で、勝つファイルが違いうる
- 警告とエラーの文のうち、理由の部分は Bun と違う。YAML の構文のエラー(`fleet: skipping invalid role file <パス>: ` のあと)、JSON の構文のエラー(Bun は `JSON Parse error: Unexpected EOF`、Rust は `EOF while parsing a value at line 1 column 0`)、ファイルの読み取りの失敗(Bun は `EISDIR: illegal operation on a directory, read`、Rust は `Is a directory (os error 21)`)、entrances の `Cannot read <ファイル>: <理由>` が当たる。本番のサーバーは役割と設定の警告を捨てる(`server/index.ts:534`、`:558`)が、API の Issue(#269)が `entrance_unreadable` の message をそのまま返すと、画面の文が変わる
- saphyr 0.3.3 は、マッピングの `:` のあとのタブ(`description:<タブ>x`)を読み取りのエラーにする。Bun 1.4.4 は `{"description":"x"}` と読む。Rust はこのファイルを警告を付けて飛ばし、同じ名前の同梱の役割があればそれを使う。直すには frontmatter の文字列を saphyr に渡す前に書き換える必要があり、引用符の中のタブと見分けなければならないので、この Issue では直さない
- CRLF の改行の frontmatter で、引用符の中の値が複数の行にわたるとき(`description: "a<CRLF>  b"`)、Bun は改行を残して `"a\nb"` と読み、saphyr は YAML 1.2 のとおり空白に折りたたんで `"a b"` と読む。単一引用符も同じで、空行を挟むと Bun は `"a\n\nb"`、saphyr は `"a\nb"` になる。LF の同じファイル、引用符のない値、`>` と `|` は両方同じ値になる。Bun のほうが YAML の仕様から外れているので、合わせない
- alias を重ねて 100000 個を超えるノードに展開される frontmatter は、saphyr が読み取りのエラーにし(ADR `0279-orchestrator-yaml` の表)、Rust はこのファイルを警告を付けて飛ばす。Bun は同じオブジェクトを共有して読む。役割のファイルにこの形を書く理由はない
- `fleet.json` を serde_json で読むので、`JSON.parse` が読めて serde_json が読めないファイルは、ファイル全体を `invalid JSON` の警告で飛ばす。f64 の範囲を超える数(`1e999`。`JSON.parse` は Infinity にする)、128 段より深い入れ子、対になっていない surrogate の escape(`"\ud83d"`。`JSON.parse` はそのまま文字列にする)が当たる。serde_json の feature を変えるには manifest を書く必要があり、ADR `0242-phase-3-split` により #247 では書けない

## 検討した代わり

- YAML の部分集合のパーサーを `agents.rs` に自分で書く: 選ばなかった。本番のサーバーは役割の読み込みの警告を捨てる(`server/index.ts:534`、`:558`)ので、部分集合が読めないファイルは知らせなしに飛ばされ、同じ名前の同梱の役割に置き換わる(`agents.ts:66-69`)。また `edits: false` の読み取りはスカラーの型の決め方に依存し、型の決め方が Bun と違うと、編集しない役割が編集する役割として起動しうる
- yaml-rust2 0.13.0: 選ばなかった。`Null`・`NULL` を文字列にし(Bun は null)、重複したキーを読み取りのエラーにする(Bun は後の値)
- #189 の 8 の検査を、役割のファイルの読み込みで行う(agy に載せた lead のファイルを飛ばす): 選ばなかった。fleet.json の上書き(`roles.lead.agent: agy`)や `spawn --model agy:<model>` は読み込みのあとで決まるので、起動のときの検査はどのみち要り、同じ規則を 2 か所に書くことになる。ファイルを飛ばすと役割が消えるか同梱の役割に黙って置き換わるが、候補を飛ばせば役割は残り、次の候補で起動する
- fleet コマンドを使う役割を名前(lead、coordinator)で決める: 選ばなかった。利用者の役割でも `spawning: true` なら fleet は `fleet spawn` と `fleet wait` を使うよう指示する(`orchestrator.ts:682-687`)
- frontmatter に新しいキーを足す: 選ばなかった。移行の間は同じ役割のファイルを TypeScript の fleet と Rust の fleet が読む

## 依存

#279 が orchestrator に足す(この ADR は足さない。版、ライセンス、保守の状況、`build.rs` は #279 の ADR に書く)。

- saphyr 0.3.3(crates.io、MIT OR Apache-2.0)、`default-features = false`(UTF-8 以外の符号化を読む `encoding_rs` を外す)
- saphyr-parser 0.3.3(saphyr の依存としてすでに入る crate。`Parser` を saphyr が再 export しないので直接の依存にする)
- indexmap(workspace にすでにある)

## 結果

- O1、O2、ST、API は、`discover_agents`、`find_agent`、`role_version`、`load_config`、`load_standing_orders`、`parse_candidate`、`role_candidates`、`check_brief`・`render_brief`・`write_scope`・`overlap`、`EntranceStore` を使う。設定を探す場所は、core が環境変数を読んで渡す
- agy の reviewer や worker の指示文にも、fleet コマンドの `list`・`send`・`read` の行と「fleet コマンドは失敗する」という agy の note が並ぶ矛盾は、この決定では残る(architect の指摘。直す場所は O1 の指示文の組み立てか L2 の note で、#248 にコメントした)
- 利用者が fleet.json で lead の `spawning` を false にして agy に載せた場合は断らない

## 確かめたこと

- Bun 1.4.4(この PC、Linux)で `Bun.YAML.parse` と TypeScript の `discoverAgents`・`mergeConfig`・`parseCandidate`・`EntranceStore.skill()` を走らせ、その出力を `tests/{agents,config,entrances}.rs` の期待値にした。例: `edits: False` は `false`、`edits: no` は文字列、`model: Null` は null、`<<: {edits: false}` と `"<<": {edits: false}` は `edits: false`、`edits: !!bool "false"` は文字列、`model: !!str 1` は `"1"`
- `cargo test --locked -p herdr-fleet-orchestrator --test agents --test roles --test brief --test config --test entrances` で 47 件が通る(rustc 1.99.1、#279 のマージのあと)。テストは先に書き、stub の `todo!()` で失敗することを見た
- `HOME` と `XDG_CONFIG_HOME` を空の一時フォルダーに向けて同じテストを走らせ、通ったあとも一時フォルダーが空であることを見た
