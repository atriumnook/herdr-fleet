# protocol の型の Rust での形と、JavaScript の文字列の振る舞いを写す `protocol::js`

- 状態: 採用
- 決めた日: 2026-11-08
- Issue: #193

## 状況

ADR `0192-phase-2-split` は、段階 2 で protocol に置く型の一覧(`InteractivePrompt` から `ConversationResponse` まで)と、`shared/patch.ts` の `patchText`・`patchFiles` を protocol に置くことを決めた。Rust でどう書くか(任意の項目と null の区別、enum の形、名前、公開のしかた)は決めていない。これらの型は protocol の公開の口で、screen(S1〜S5)、transcript(T1〜T6)、段階 4 の core が使う。

もう 1 つ、TypeScript の文字列の組み込みの振る舞いのうち、Rust の標準と違うものを、どの crate に書くかを決める必要があった。

- JavaScript の `trim` と正規表現の `\s` の空白の集合は、Rust の `char::is_whitespace` と regex の `\s` と違う。JavaScript だけが U+FEFF を含み、Rust だけが U+0085 を含む(Bun 1.4.4 ですべての code point を調べた。「確かめたこと」)
- JavaScript の `.length` と `slice` は UTF-16 の code unit で数える。Rust の `str::len` は UTF-8 のバイトで数える
- 正規表現の `.`(`s` フラグなし)と `m` フラグの `^`・`$` の行末は、`\n`、`\r`、U+2028、U+2029 の 4 つ。regex の `.` は `\n` だけを除き、`(?m)` は `\n` だけを行末とする

protocol 自身の `patch_text` が `trimStart` を使い、screen と transcript の両方が `trim` と `\s` と UTF-16 の長さを使う(architect が数えた行数: protocol に行く shared のファイルで `.trim` が 11 行、screen に行くファイルで 38 行、transcript に行くファイルで 36 行)。

crate の公開の口を足す変更の前には architect に聞くという lead の決まりのとおり、この 2 つを architect(fleet の run `2c2e8884`)に聞いた。問いと答えは、この ADR の決定と「検討した代わり」に書いた。

## 決定

### 型の形

- 型を定義する module(`conversation`、`fleet`、`patch`、`prompt`)は非公開にし、crate の root から `pub use <module>::*` で見せる。同じ型を 2 つのパスで呼べないようにし、後の段階でファイルの分け方を変えても、呼ぶ側を変えずに済ませるため。glob の再 export で名前がぶつかると、`ambiguous_glob_reexports` の警告を CI の clippy(`-D warnings`)が止める
- TypeScript で「必ずあり、null になりうる」項目(`body`、`custom_option_index`、選択肢の `description`、turn の `ts`、metadata の `model` と `reasoning_effort`、context の `window`、abandoned の `summary`)は `Option<T>` にし、`#[serde(deserialize_with = "Option::deserialize")]` を付ける。`None` は `null` と書き、項目がない JSON は `missing field` のエラーにする(serde は、この属性がないと、ない `Option` の項目を `None` として読む)
- TypeScript で「任意」の項目(`queued?`、`end_ts?`、`context?`、`metadata?`、`history_id?`、`abandoned?`、`path?`、`phase?`、`source?`、tool の `error?`・`skill?`・`output_ref?`・`output_size?`・`images?`、`PromptAnswer` の 3 つ、`resetsAt?`)は `Option<T>` にし、`default` と `skip_serializing_if = "Option::is_none"` を付ける。`None` のときは項目を書かない
- `cursor?: string | null` は `Option<Option<String>>` にする。`None` は項目なし、`Some(None)` は `null`、`Some(Some(c))` は値
- `fallback?: true` は `bool` にし、`false` のときは項目を書かない。TypeScript の型が `true` しか許さないため。`error?: boolean` は一般の決まりどおり `Option<bool>` にする
- `ConversationPart` は `#[serde(tag = "kind")]` の enum にする。tool の part は `ToolPart` の newtype の variant にする(TypeScript の `trimOutput` と同じく、transcript が組み立てて書き換えるため)。`ref` という名前の項目は、Rust の予約語なので、`reference` に `#[serde(rename = "ref")]` を付ける。image の part と tool の `images` は同じ `ImageRef { media_type, reference }` を使う
- 名前: エージェントの種類は `FleetAgentKind`(ADR `0192-phase-2-split`)、turn の発言者は `TurnRole`(後の段階で root に fleet の `RoleCandidate`・`RoleSettings` と `ClientRole` が入り、`Role` だけでは区別できないため)、TypeScript で名前のない abandoned の型は `AbandonedTurns`、source の enum は `ConversationSource`
- `InteractivePrompt` の `agent` と notice の `source` は、TypeScript と同じく `String` にする(画面の corpus のカードには `omp` もあり、`FleetAgentKind` にない)
- 数: 応答の側で Rust のコードが作る数(`custom_option_index`、`output_size`、abandoned の `count`・`branches`、context の `used`・`window`)は整数の型にする。`usedPercent` は `f64`、epoch ミリ秒の `resetsAt` と `readAt` は `i64` にする。`PromptAnswer` の `option_index` と `option_indices` は `f64` にする。TypeScript は、`prompt_changed` の判定(`server/prompt-api.ts:300`)のあとで整数か・負でないかを調べ、`"A valid option index is required."` などの文言を返す(`server/prompt.ts:1197, 1218-1219`)。`usize` にすると、`-1` と `1.5` を serde が読み込みの時点で断り、判定の順番と文言が TypeScript と変わる。検査は screen が持つ(ADR `0192-phase-2-split` の「screen の公開の口」)
- JSON の項目名は TypeScript のとおり(`usedPercent`、`readAt`、`resetsAt` は camelCase、ほかは snake_case)
- `deny_unknown_fields` は付けない。TypeScript の読み手は知らない項目を無視する。項目の取りこぼしは、両方の corpus の全件の往復のテストが見つける
- `QueuedQuestion` は HTTP に載らないが、`Deserialize` を付ける。S3 の runner が `case.json` の `unanswered` を読むため

### `protocol::js`

protocol に公開の module `js` を置く。root には再 export しない(`protocol::trim` では、JavaScript の意味の関数だと読めないため)。

- `is_whitespace(char)`、`trim`、`trim_start`、`trim_end`: ECMAScript の WhiteSpace と LineTerminator の集合
- `WHITESPACE`: 正規表現の `\s` の代わりに使う、regex crate の文字クラスの文字列
- `is_line_terminator(char)` と `LINE_TERMINATOR`(文字クラスの文字列): `\n`、`\r`、U+2028、U+2029
- `utf16_len`、`cut_utf16(text, max)`: `.length` と `slice(0, max)`。`slice` がサロゲートの対の途中で切るとき、JavaScript は対の前半を残すが、Rust の `&str` はそれを持てない。`cut_utf16` は対の前で切る(`max` より 1 code unit 短くなる)

置く場所の決まり: `protocol::js` に置くのは、JavaScript の組み込みの振る舞いを写す関数のうち、2 つ以上の crate が使うものだけにする。1 つの crate だけが使うものは、その crate の非公開の module に置く。screen の `Bun.stringWidth` の幅と `Intl.Segmenter` の grapheme(S1 の `text.rs`)、transcript の `JSON.stringify(x, null, 2)` の数の書き方と寛容な base64 の復号(T1)がこれに当たる。それぞれの決まりは ADR `0193-phase-2-dependencies` に書いた。

## 検討した代わり

- `PromptAnswer` の番号を `usize` にする: 上に書いたとおり、検査の順番と文言が TypeScript と変わる
- 型の module を公開し、root にも再 export する(lead の最初の案): 同じ型を 2 つのパスで呼べる
- turn の発言者の enum を `Role` にする(lead の最初の案): 後の段階で入る fleet の役割の型と区別できない
- JavaScript の文字列の関数を crate ごとの非公開のコピーにする(lead の最初の案): 空白の集合とサロゲートの対の扱いを 3 か所以上に手で書くことになり、コピーが食い違っても気づく検査がない。段階 4 以降に protocol に入る `shared/plan.ts`、`shared/secret-prompt.ts` も同じ関数を使い、秘密の入力の判定は desktop も使う(ADR `0107-crate-split`)
- この関数だけの新しい crate: ADR `0107-crate-split` の crate の一覧を置き換える ADR が要り、数十行のために crate が 1 つ増える。screen と transcript の両方が依存する crate は、すでに protocol がある

## 依存

なし。この ADR は外部の crate を足さない。protocol が使う serde、serde_json、regex は ADR `0193-phase-2-dependencies` が足す。

## 結果

- screen、transcript、core は、カードと会話の型を protocol から取る。TypeScript の項目がないことと null の区別は、型の属性が持ち、呼ぶ側は `Option` の値だけを見る
- `trim`、`\s`、`.`、`m` フラグ、UTF-16 の長さを TypeScript から移すときは、`protocol::js` を使う(ADR `0193-phase-2-dependencies` の「TypeScript と Rust の違いの扱い」)
- 受け入れること: protocol の公開の口に、HTTP の型でない module(`js`)が入る。2 つ以上の crate が使う JavaScript の振る舞いが段階 2 の途中で新たに見つかったときは、protocol を直す Issue を別に開いて待つ(段階 2 で protocol を書くのは P0 だけ。ADR `0192-phase-2-split`)

## 確かめたこと

2026-11-08、Linux(omarchy)、rustc 1.99.1、Bun 1.4.4、`rust` の `82f36ce` から切ったブランチで確かめた。

- `rust/crates/protocol/tests/corpus_round_trip.rs`: 画面の corpus のカード 209 件(`expected` に id を足して読み、書き戻してから id を除く)、`unanswered` の 15 件、`answers` の 55 件(`pane_id` と `prompt_id` を足す)と、会話ログの corpus の page の答え 418 件の turns・metadata・page 全体(`version` を除く)、abandoned の 49 件、`unansweredQuestions` の答え 6 件を、型に読んで書き戻し、`serde_json::Value` として比べた(数は値で比べる)。すべて同じ値になった
- 型を先に、任意の項目にも null を書く素朴な形で書き、このテストが失敗するのを見てから属性を足した。失敗は、画面の corpus で 279 件中 264 件、会話ログの corpus で 1,058 件(どれも、corpus にない項目を Rust が `null` で書いた)
- `rust/crates/protocol/tests/types.rs`: `body`・`custom_option_index`・`description`・`model` がない JSON は `missing field` で断られる、`cursor` の 3 つの状態が往復する、`FleetAgentKind` の 6 つの値と `omp` を断ること、`UsageReading` の camelCase の項目名、`PromptAnswer` が `-1` と `1.5` を読むこと
- `rust/crates/protocol/tests/js.rs`: 期待値は Bun 1.4.4 の答え。すべての code point(サロゲートを除く)で `/\s/.test` が真になるのは 25 個で、`is_whitespace` と `WHITESPACE` はちょうどその 25 個に当たる。`/^.$/u.test` が偽になるのは 4 個(`\n`、`\r`、U+2028、U+2029)で、`is_line_terminator` と `LINE_TERMINATOR` はちょうどその 4 個に当たる。`trim` の 3 つ、`"a😀b".length` が 4、`slice(0, 3)` が `"a😀"`
- `rust/crates/protocol/tests/patch.rs`: `shared/patch.test.ts` の 2 件(期待値はその TypeScript のテストから取った)と、空白と行末の違いが出る 5 つの入力(期待値は Bun で `shared/patch.ts` を呼んだ答え: 先頭の U+FEFF は除かれ U+0085 は残る、呼び出しの括弧のあとの U+3000 と改行、JSON にないエスケープ、`\r\n` と U+2028 で区切られた行の 3 つのファイル名)
- architect(fleet の run `2c2e8884`)は、scratchpad の使い捨ての crate で、`deserialize_with = "Option::deserialize"` の `missing field`、`cursor` の往復、tag 付きの enum の newtype の variant と `ref` の rename の往復、`usize` が `-1` を断り `f64` が読むこと、glob の再 export の衝突で `ambiguous_glob_reexports` が出ることを確かめた
