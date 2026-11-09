# herdr-api の生成器が schema の形を Rust の型に写す規則

- 状態: 採用
- 決めた日: 2026-11-09
- Issue: #245

## 状況

ADR `0242-phase-3-split` の「herdr-api の生成」は、herdr の socket API の型を `scripts/herdr-schema.json`(protocol 22)の全体から Rust の生成器で作ると決めた。生成器は herdr-api の `tests/` に置き、生成物 `src/generated.rs` をコミットし、method ごとに `trait Method { const NAME: &str; type Params; }` を実装し、enum は知らない値を保ち、名前の衝突は TypeScript の生成器(`scripts/generate-protocol-types.ts`)と同じく節の名前を前に付ける。この ADR は、その範囲の中で生成物の公開の型の形を決める。決める必要があったのは次の 5 つで、どれも H2(#252)と H3(#257)が使う crate の interface になる。

- 名前の衝突をどう判定するか。schema の 5 つの節で 30 の名前が重なる(`$defs` の 29 と、節の根の `EventEnvelope`)。TypeScript の生成器は `JSON.stringify(def)` で形を比べ、この文字列は `$ref` の節の名前(`#/schemas/event/$defs/PaneInfo` と `#/schemas/success_response/$defs/PaneInfo`)を含む。そのため 14 の名前が「違う形」と判定される(`EventPaneInfo` と `ResponsePaneInfo` など)。`$ref` を指す先の名前に直して比べると、protocol 22 で形の違う名前は 1 つもない。違いは `$ref` の節の名前だけである。TypeScript の生成物は 9 つの根から届く型だけを出し、その中では名前が重ならないので、この判定の違いは生成物に出なかった
- 開いた enum の Rust での形
- `type` などの定数で区別する `oneOf`(`ResponseResult` の 63、`EventData` の 26、`Subscription` の 27 ほか、全部で 8 つ)の形と、知らない `type` の扱い
- 区別する項目のない union(`AgentViewField`、`AgentViewValue`、`PopupSize`、`SubscriptionEventData`)の形
- `Method` の実装の置き方

herdr-api の manifest は serde と serde_json だけに依存し、この Issue では manifest を書かない(ADR `0242-phase-3-split`)。決める前に architect(fleet の run `76447039`、読むだけ)に 5 つの問いを聞き、5 つとも提案のとおりでよいという答えを得た。答えの推奨のうち 3 つ(知っている tag の読み取りのエラーの文に tag を付ける、`Other` に既知の綴りを入れない注意を doc に書く、tag の名前の衝突を panic でなく `Value` にする)を取り込んだ。

## 決定

### 名前の衝突

- 2 つの定義が同じ形かどうかは、`$ref` を、指す先の定義が属する「同じ形の組」に置き換えた JSON で比べる。組は名前ごとに 1 つから始め、形が違うものを分け、分かれなくなるまで繰り返す。そのため、節の名前だけが違う `$ref` は形の違いにならない。一方、指す先の形が違えば、指す側も違う形になる
- 同じ名前の定義がすべて同じ形なら 1 つの型にする。1 つでも違えば、その名前の定義すべてに節の接頭辞を付ける(`Request`、`Response`、`Event`、`SubscriptionEvent`、`Error`)。接頭辞の付け方は TypeScript の生成器と同じ
- 節の根のうちオブジェクトのもの(`SuccessResponse`、`ErrorResponse`、`EventEnvelope`、`SubscriptionEventEnvelope`)も、`title` を名前とする定義として同じ判定に入れる。`success_response` にも同じ形の定義 `EventEnvelope` があり、1 つの型になる
- protocol 22 では接頭辞の付く型はない。herdr 0.9.0 の `ReadSource` のように節で値が違う場合(request は `recent-unwrapped`、応答は `recent_unwrapped`)に接頭辞が付くことは、生成器のテストが小さな schema で確かめる

### 型の写し方

| schema の形 | Rust の型 |
|---|---|
| `properties` を持つオブジェクト(`additionalProperties` がないか `false`) | struct。`required` にない項目は `Option<T>` で、`None` のときは書かない。`required` にあって `null` を許す項目は `Option<T>` で、`None` を `null` と書く |
| `properties` も `additionalProperties` もないオブジェクト(`EmptyParams`) | 項目のない struct `{}`。JSON では `{}` になる(unit struct は `null` になる) |
| `additionalProperties` だけのオブジェクト | `BTreeMap<String, T>` |
| `properties` と、`false` でない `additionalProperties` の両方を持つオブジェクト | `serde_json::Value`(写せない形として一覧に書く) |
| 文字列の `enum` | `open_enum!`: 値ごとの variant と、知らない値を持つ `Other(String)`。`as_str()` で herdr の綴りを返す。等しいかどうかと hash は `as_str()` で決めるので、手で作った `Other("idle")` は `Idle` と等しい |
| 全 variant が同じ項目に違う文字列の定数を必須で持つ `oneOf` | `tagged_union!`: 定数だけの形は unit variant、ほかの項目を持つ形は struct `<union の名前><variant の名前>`(例: `ResponseResultPong`)を持つ variant。知らない定数は `Other(serde_json::Value)` に元の JSON のまま持つ。知っている定数でほかの項目が読めないときはエラーにする。オブジェクトでない値と、定数の項目がない、または文字列でない値もエラーにする(新しい形ではなく、壊れたフレームとして扱う) |
| 区別する項目のない `oneOf` / `anyOf` | `#[serde(untagged)]` の enum。variant は schema の順で、serde はこの順に試す。オブジェクトの variant は struct `<union の名前><項目の名前>` を持つ |
| `[T, null]` の `anyOf` | `Option<T>` |
| `integer` | `format` のとおり(`uint`・`uint64` は `u64`、`uint32` は `u32`、`uint16` は `u16`、`int32` は `i32`、`format` なしは `i64`) |
| `number` | `f64`(schema の `format: float` は 32 ビットの浮動小数点数を表し、f64 はその値を失わずに持てる) |
| 自分自身に戻る項目(`LayoutNode`、`AgentViewFilter`) | 戻る項目を `Box<T>` にする |
| `true`(何でもよい値。`agent_explain` の `explain`) | `serde_json::Value` |
| 生成器が写せない形(`allOf` などの組み合わせ、定義になっていない入れ子のオブジェクト・enum・union、型が 1 つに決まらないもの、Rust の名前が衝突する enum の値・union の variant・tag) | `serde_json::Value`。生成物の冒頭に一覧を書く |

- 型、項目、enum の値、tag は名前の順に並べる。untagged の variant だけは schema の順にする(serde が試す順なので)
- Rust の予約語の項目名(`type`、`match`)は `r#type` のように書く。値や tag から作る名前が `Self` になるときは `VSelf` にする(数字で始まる名前の前にも `V` を付ける)
- 生成した struct も unit variant も、schema にない項目を読み捨てる。新しい herdr が既知の形に足した項目は、読み取りを失敗させないが、書き戻すと消える
- `required` になく `null` も許す項目(schema 全体で 304)は、「項目がない」と「`null`」を同じ `None` にし、書くときは項目を省く。herdr は serde で書かれた server で(`format: uint64` などの書き方から推測した)、両者を同じに読むと仮定した。食い違いは H2 の本物の herdr のテスト(`#[ignore]`)で分かる
- 知っている tag の形の項目が読めないときのエラーの文は、tag で始まる(`pong: invalid type: …`)。H2 の `bad_frame` の文で、どの形が食い違ったかが分かる
- schema が壊れているとき(同じ節に同じ名前の定義が 2 つある、`$ref` の先がない、生成する 2 つの型や 1 つの struct の 2 つの項目が同じ Rust の名前になる)は、生成器が panic し、テストが失敗する

### Method

- method ごとに大きさのない marker の struct を `methods` module に置く(`methods::PaneRead`、`NAME` は `"pane.read"`、`Params` は `PaneReadParams`)。名前は method 名の `.` と `_` で区切った語を大文字で始めてつなぐ(`server.ssh_agent.register` は `ServerSshAgentRegister`)
- `Method::Params` は `Serialize` を求める(H2 の `rpc::<M>(params)` が params を書くため)
- 全 method の名前を `METHOD_NAMES` に並べる。H2 の表のテストが、表の method が schema にあることを確かめるのに使える

### 生成と一致の検査

- 生成器は `rust/crates/herdr-api/tests/generator/mod.rs`、検査は `tests/generated.rs`。`cargo test` が schema から作った結果と `src/generated.rs` を比べ、違えば `STALE` と再生成のコマンドを出して失敗する。`HERDR_API_UPDATE=1` のときだけ書き直す
- 生成物は rustfmt の出力と同じ形で書く(`cargo fmt --check` が生成物を書き換えない)。enum と tagged union の serde の実装は `src/lib.rs` の macro が展開する。rustfmt は macro の `{}` の中を整形しないので、rustfmt の版が変わったときに生成物と食い違いうるのは、struct と untagged の enum の宣言だけになる

## 検討した代わり

- TypeScript の生成器と同じく、`$ref` を文字列のまま比べる: protocol 22 で 14 の名前が 2 つか 3 つの型に分かれる。形が同じなのに、ペインの情報が `EventPaneInfo`(event)と `ResponsePaneInfo`(`session.snapshot`)の別の型になり、H3 が両者を変換する関数を書くことになる。Issue の受け入れ条件は「節によって形の違う同じ名前の型」に接頭辞を付けることで、節の名前だけが違う `$ref` は形の違いではないと判断した
- 開いた enum を newtype `pub struct AgentStatus(pub String)` と定数にする: 呼ぶ側が `match` で値の漏れを compiler に確かめさせられない
- tagged union を serde の `#[serde(tag = "type")]` で derive する: 知らない `type` で読み取りが失敗する。`#[serde(other)]` は unit variant だけで、知らない形の中身を捨てる。新しい herdr が足した応答や event を落とさずに持つため、`Other(Value)` を持つ実装を `src/lib.rs` の macro に書いた
- tagged union の variant を struct variant(`Pong { version: String, … }`)にする: H2 の method と応答の形の表が、method ごとに返す型を名前で書けない
- 区別する項目のない union を、知らない形を持つ形にする: どの variant にも当たらない値を `Other` にすると、知っている形の読み取りの誤りも `Other` に紛れる。この 4 つは schema のとおり閉じた形にした
- `build.rs` で生成する: ADR `0242-phase-3-split` が使わないと決めた

## 依存

なし(serde と serde_json は ADR `0244-phase-3-dependencies` で herdr-api に入っている)。

## 結果

- 呼ぶ側は herdr の応答と event を生成した型で受ける。新しい herdr が足した応答の形、event、enum の値は `Other` に元のまま入り、読み取りは失敗しない。一方、知っている形の項目が変わると(必須の項目が消える、型が変わる)、その形の読み取りはエラーになる。TypeScript は応答を型の確認なしで受けていたので、影響は読む項目だけだった
- H2 の method と応答の形の表は、`ResponseResult` の variant から `ResponseResultPong` などの struct を取り出す関数として書ける
- H3 は、event のペインの情報(`EventDataPaneCreated::pane`)と `session.snapshot` のペインの情報(`SessionSnapshot::panes`)を同じ `PaneInfo` で扱える
- tagged union は、読むときに一度 `serde_json::Value` にしてから形の struct に読み、書くときも `Value` を経る。derive の実装より割り当てが 1 回分多いが、知らない形を元のまま持つためにこの形にした。herdr の socket の 1 行(JSON 1 つ)ごとに 1 回で、問題になれば `#[serde(flatten)]` などに替える
- `SubscriptionEventData` は区別する項目を持たないので、variant の判定は必須の項目(`matched_line`、`agent_status`、`scroll`)の有無による。購読の event の種類は、envelope の `event`(`SubscriptionEventKind`)で判定するほうが確実である
- schema の形が変わって名前に接頭辞が付くと、型の名前が変わり、呼ぶ側の build が失敗する。schema の更新(別の Issue)は、その変更を呼ぶ側にも入れる

## 確かめたこと

- Linux(Omarchy)、Rust 1.99.1 で、`rust/` の `cargo test --locked -p herdr-fleet-herdr-api` が通った(生成器と一致の検査 8 件、型の読み書き 14 件)
- `$ref` を指す先の名前に直して比べると、protocol 22 で形の違う重なった名前が 0 であることを、Python で schema を読んで確かめた(architect も数え直し、同じ結果だった)
- schema を 1 か所変えた一時のコピー(request の `ReadSource` の `recent_unwrapped` を `recent-unwrapped` に変える)と、末尾に 1 行足した生成物の一時のコピーで、一致の検査が `STALE` を出して失敗することを、テスト(`a_schema_changed_in_one_place_makes_the_check_fail`、`a_drifted_generated_file_makes_the_check_fail`)で確かめた
- 生成物を手で 1 行変えると `the_committed_output_matches_the_committed_schema` が失敗することを確かめた
- `cargo fmt --check` が生成物を書き換えないことを確かめた
