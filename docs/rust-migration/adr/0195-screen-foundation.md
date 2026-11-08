# screen の答え方の型、`screen_checks` の返す型、まだの系統の stub の形

- 状態: 採用
- 決めた日: 2026-11-08
- Issue: #195
- 置き換える: 0193-protocol-types(一部だけ。core が `POST /api/pane/prompt/answer` の本文を `PromptAnswer` の型で読むという前提。core は本文を `serde_json::Value` で読み、`pane_id` と `prompt_id` をそこから調べ、答えは `screen::Answer::from` に渡す。`PromptAnswer` の形は変えず、答えを書く側の型として残す)

## 状況

ADR `0192-phase-2-split` の「screen の公開の口」は、herdr-fleet-screen の公開の関数の signature を決め、次のことを S1(#195)に残した。

- `Answer`、`AnswerStep`、`InvalidAnswer`、`QueueFront`、`Answering` の形
- `screen_checks` の返す型の形
- 答え方 `Answering` を、各系統の module がどう埋めるか(`answer_keys` は responder の名前で分岐しない)

あわせて、S2〜S5 は自分の系統のフォルダーと自分のテストのファイルだけを書き、共通のファイル(`lib.rs`、`card.rs`、`answer.rs`、`text.rs`、`tests/common/mod.rs`)を書かない。そのため、S1 が置く stub と型は、S2〜S5 が値を作り始めても共通のファイルを書き直さずに済む形でなければならない。CI の clippy は `-D warnings` で走るので、S1 の時点で誰も作らない値(まだの系統の responder など)が dead code の警告を出さない形も要る。

crate の公開の口を決めるので、lead の決まりのとおり architect(fleet の run `164d2a19`、`spawn --role architect --read-only`)に、lead の案と 5 つの問いを渡して聞いた。答えの 8 つの変更をすべて採り、この ADR の決定にした。

最初の決定では、`Answer` の 3 つの項目を型付きの `Option`(`option_index: Option<f64>` など)にし、TypeScript の 2 つの文言(`"Custom text must be a string."`、`"Option indices must be an array."`)を入れなかった。PR のレビュー(codex の reviewer)が、この形では次の 2 つが起きることを示した。

- `{"option_index": 0, "option_indices": null}` を pi の Yes/No の確認に渡すと、`null` がないものとして読まれ、Enter を押すキー(承認)が返る。TypeScript は `null !== undefined` なので答えを 2 つと数え、`"Exactly one answer is required."` で断る(`server/prompt.ts:1165-1166`)
- Issue #195 の受け入れ条件は、`server/prompt.test.ts` の `rejects invalid answer shapes` の件を TypeScript のテストの期待値で Rust に置くことを求める。57・58 行の期待値(`must be a string`、`must be an array`)を Rust の別の値に変えていた

そこで `Answer` の形を architect(fleet の run `b9e45672`)にもう一度聞き、答えのとおりに直した(下の「公開の型」)。

## 決定

### 公開の型

```rust
#[serde(from = "Value")] pub struct Answer { option_index: Option<Value>, option_indices: Option<Value>, custom_text: Option<Value> }
impl From<serde_json::Value> for Answer { /* オブジェクトなら 3 つのキーを取り出し、オブジェクトでなければ 3 つとも None */ }
#[serde(untagged)] pub enum AnswerStep { Keys { keys: Vec<Key> }, Text { text: String } }
pub enum Key { Up, Down, Enter, Escape, Space, Tab, Right, BackTab, OpenQueue, CloseQueue, CtrlK, CtrlU }
pub enum InvalidAnswer { NotExactlyOne, CustomTextNotString, OptionIndicesNotArray, NoCustomAnswer, NoSelections, OutsideRange, InvalidOptionIndex }
pub struct QueueFront { pub question: String, pub options: Vec<String> }
pub struct ParsedPrompt { card: InteractivePrompt, responder: Responder, answering: Answering }
pub struct ScreenChecks {
    pub startup_error: fn(&str) -> Option<String>,
    pub question: Option<fn(&str) -> Option<String>>,
    pub ready_error: Option<fn(&str) -> Option<String>>,
    pub input_ready: Option<fn(&str) -> bool>,
    pub draft: Option<fn(&str) -> bool>,
    pub turn_error: fn(&str) -> Option<String>,
}
```

- `Answer` は、TypeScript の `PromptAnswer` から `pane_id` と `prompt_id` を除いた 3 つの項目を、リクエストの JSON のとおりに持つ。各項目は「ない」(`None`)か、JSON の値そのもの(`null` を含む)である。TypeScript は `!== undefined` で「ない」と `null` を分けるので、`null` は「ある」と数える。文字列か、配列か、整数で範囲の中かは、`answer_keys` が TypeScript の文言と順序で調べる。項目は非公開で、作る口は `From<serde_json::Value>` の 1 つにする。`Deserialize` は `#[serde(from = "Value")]` で付ける(corpus の runner が `case.json` の `answers` を読む)。serde の derive で項目ごとに読む形を取らないのは、TypeScript と違う答えになる入力が 2 つあるため(serde_json 1.0.154 で architect が確かめた): derive は配列 `[1]` を位置で読んで 1 番を選び(TypeScript は答えがないとして断る)、重複したキー `{"option_index":0,"option_index":1}` をエラーにする(`JSON.parse` は後ろの値を取り、`Value` も後ろの値を取る)。`From<Value>` は失敗しない。答えの項目を読むのは TypeScript でも `answerKeys` だけ(`server/prompt.ts:1162-1224`)なので、「ない」と `null` の区別は `answer.rs` だけが知る。型付きの作り方(`Answer::option(usize)` など)は足さない。呼ぶ側はどれも JSON を持つ(段階 4 の core はリクエストの本文、runner は `case.json`)。desktop は screen に依存しない(ADR `0107-crate-split`)
- `AnswerStep` は JSON で `{"keys": [...]}` か `{"text": "..."}` になる(TypeScript の `AnswerStep` と同じ)。TypeScript の型は両方の項目を任意にしているが、`answerKeys` が作る値はどれも片方だけを持つので、enum にする。`Serialize` だけを持つ
- `Key` は、TypeScript のコードが送るキーの一覧(`KEY`、`server/prompt.ts:32-46`、と `answerKeys` の `ctrl+k`・`ctrl+u`)。herdr のキーの名前は `Key::as_str` の 1 か所にだけ書き、`Serialize` はその名前を書く。`KEY.backspace` は送るコードがない(`git grep` でテストのほかに 0 件)ので入れない。公開の enum にしたのは、段階 4 の core が送るキーの種類で処理を分けるため(`server/prompt-api.ts:361` は上下の移動かを見て、`:407` はキーからカーソルの位置を数える)。名前を文字列で持つと、綴りの誤りがコンパイルで見つからない
- `InvalidAnswer` の `Display` は TypeScript の文言(`server/prompt.ts:1166-1219`)。TypeScript の文言のうち、次の 2 つは Rust に入れない
  - `"The prompt was not produced by parseInteractivePrompt."`: `answer_keys` は `ParsedPrompt` を受けるので、複写したカードを渡せない(ADR `0192-phase-2-split`)
  - `"This agent does not support multiple selections."`: 下の「答え方」のとおり、カードの `multi_select` は答え方が複数の選択を持つかで決まるので、この誤りに届く入力がない。TypeScript でも、`multi_select` が真になる omp-question と claude-question はどちらも複数の選択のキーを持つ(`:249, 500, 1206-1212`)ので、届かない
- `ScreenChecks` は関数ポインターを持つ `Copy` の struct。TypeScript の adapter の任意の method(`question?`、`readyError?`、`inputReady?`、`draft?`)は `Option` にする。orchestrator は、判定が「ない」ことで画面を読むかを決めている(`server/fleet/orchestrator.ts:524` は `question` か `readyError` があるときだけ起動直後の画面を読み、`:597` は `inputReady` がなければ入力欄を待たず、`:1223-1224` と `:1454` は `draft` と `question` がなければ画面を読まない)。`turn_error` の引数は `&str` にする。TypeScript の 3 つの実装(`server/fleet/adapters.ts:100, 110, 404`)はどれも、出力がなければ undefined を返すので、出力のないターンは呼ぶ側が `last_output.as_deref().and_then(checks.turn_error)` と書けば同じになる。6 つの adapter の判定は、どれも画面の文字列だけを読み、起動の引数を読まない(`:162-475`)ので、値を捕捉しない関数ポインターで足りる

### 答え方 `Answering`

```rust
pub(crate) struct Answering { selected: usize, options: OptionKeys, typed: Option<Typed>, multiple: Option<Multiple> }
pub(crate) enum OptionKeys { Menu { escape: Option<usize> }, Steps(Vec<Vec<AnswerStep>>) }
pub(crate) struct Typed { row: usize, before: Vec<Key>, after: Vec<Key> }
pub(crate) struct Multiple { checked: Vec<usize>, toggle: Key, finish: Vec<Key> }
```

- 1 つの選択(`OptionKeys::Menu`): カーソルを選択肢の行へ動かして Enter を押す。`escape` の行だけは Escape を押す(Codex の承認の「No」、TypeScript の `rejectWithEscapeIndex`)。`OptionKeys::Steps` は、選択肢ごとに送る手順を持つ(fallback のカード、TypeScript の `optionSteps`)
- 自由入力(`Typed`): カーソルを `row` へ動かし、`before` を押し、文字を打ち、`after` を押す。`None` はカードが自由入力を受けないこと
- 複数の選択(`Multiple`): 選択肢を順に見て、付けたい印と画面の印(`checked`)が違う選択肢ごとに、カーソルを動かして `toggle` を押し、最後に `finish` を押す。カードの `multi_select` は `card::finish` が `multiple.is_some()` から決める(各系統の module は `CardFields` に `multi_select` を書かない)。同じ事実を 2 か所に書くと、解析が食い違えて書いても型で防げないため
- 選択肢の番号は、そのままメニューの行の番号として扱う(TypeScript の `answerKeys` と同じ)

TypeScript の 18 の responder は、どれも次の値で表せる(`answerKeys`、`server/prompt.ts:1162-1224` と、claude-question の `customSteps`、`:509-514` で確かめた)。

| responder | `typed` の `before` / `after` | `multiple` の `toggle` / `finish` | `options` |
|---|---|---|---|
| claude-question(1 つの選択) | `[]` / `[Enter]` | なし | `Menu` |
| claude-question(複数の選択) | `[]` / `[Down, Enter]` | `Enter` / `[Right]` | `Menu` |
| claude-question(下書きのある行) | `[CtrlK, CtrlU]` / `[Enter]` か `[Down, Enter]` | 同上 | `Menu` |
| claude-plan | `[]` / `[BackTab]` | なし | `Menu` |
| codex-question | `[Tab]` / `[Enter]` | なし | `Menu` |
| codex-async-question | `[]` / `[Enter]` | なし | `Menu` |
| codex-queued-question、omp-question(1 つの選択) | `[Enter]` / `[Enter]` | なし | `Menu` |
| omp-question(複数の選択) | なし | `Space` / `[Tab, Enter]` | `Menu` |
| pi-input | `[CtrlK, CtrlU]` / `[Enter]` | なし | `Menu` |
| codex-approval | なし | なし | `Menu`(`escape` は No の行) |
| fallback-menu、fallback-keys | なし | なし | `Steps` |
| ほか(claude-submit、claude-approval、claude-confirm、codex-menu、omp-approval、pi-question、pi-confirm、pi-model) | なし | なし | `Menu` |

`answer_keys` は、TypeScript と同じ順序で調べる: 答えの項目がちょうど 1 つあるか(`null` も数える)、自由入力なら文字列で、空でなく、`typed` があるか、複数の選択なら配列で、`multiple` があって空でなく、要素がどれも整数で範囲の中か、1 つの選択なら番号が整数で範囲の中か。数でない値は、`Number.isInteger` が偽になるのと同じく、範囲の外として扱う。

### カードと content id

- `card::finish(agent, fields, fallback, responder, answering)` が `ParsedPrompt` を作る。content id は、`agent`、`CardFields` のすべての項目、`multi_select`、fallback のカードの画面(`FallbackScreen`: 時計の行を置き換えた question と body、画面全体、時計の行の位置)を持つ 1 つの struct を serde_json で書いたバイト列の sha256 の 16 進の全体(64 桁)。body は id を作ったあとで 12,000 の UTF-16 の code unit に切る(ADR `0192-phase-2-split`、`0193-phase-2-dependencies`)
- fallback のカード(S4)は `FallbackScreen` を渡し、id は question と body をその値で読む。TypeScript は 2 回ハッシュする(`server/prompt.ts:205-208, 1359`)が、Rust は同じ項目を 1 回でハッシュする。TypeScript とバイト列を合わせないことは ADR `0192-phase-2-split` が決めている

### 系統の module と stub

- `card::Responder` は系統ごとの enum を包む(`Claude(claude::Responder)` など 5 つ)。各系統の `Responder` から包む側への `From` を `card.rs` に置き、`finish` は `impl Into<Responder>` を受ける。S1 の時点では誰も `Responder::Claude` などを作らないが、`From` の impl の中で作るので dead code の警告が出ない(rustc 1.99.1 で、impl を外すと `variant Claude is never constructed` になることを architect が確かめた)。`OptionKeys::Steps` も `From<Vec<Vec<AnswerStep>>>` で同じようにする。`#[allow(dead_code)]` は共通のファイルに書かない。`#[expect(dead_code)]` は、S2〜S4 が値を作った時点で期待が外れて警告になり、S2〜S4 が共通のファイルを書くことになるため使わない
- 各系統の module は `PARSERS: &[fn(&str) -> Option<ParsedPrompt>]`(`parsePrompt` が試す順)と `tail_is_active(responder, screen)`(TypeScript の `promptTailIsActive` のその系統の部分)を持つ。lib.rs の `parse_prompt` は、agent の系統の `PARSERS` を順に呼び、`tail_is_active` が真になった最初のカードを返す。TypeScript は候補をすべて先に解析するが、解析は副作用を持たないので、最初に当たったところで止めても答えは同じ
- まだの系統(claude、codex、fallback、checks)の stub: `Responder` は空の enum、`PARSERS` は空の slice、`tail_is_active` は `match responder {}`。`todo!()` は値を返さなければならない関数だけに置く: `claude::suggestion`、`codex::queued_question_count`、`codex::queued_prompt`、`fallback::parse`、`checks::for_kind`、`checks::cursor_usage`。S2・S3 は、自分の enum に variant を、`PARSERS` に関数を足すだけで済む
- lib.rs の公開の関数は、系統の module の関数を呼ぶだけの最終の本体を持つ。`codex_questions_collapsed` は TypeScript(`server/prompt.ts:1137`)のとおり `parse_prompt("codex", screen).is_none() && codex::queued_question_count(screen) > 0` を lib.rs に書き、S3 は `queued_question_count` だけを書く。`ScreenChecks` は lib.rs に置き、項目が公開なので S5 は `checks/` の中で値を作れる

### `text.rs` に置くもの

- 2 つ以上の系統が使う行の読み取り: `strip_ansi`、`split_lines`(`split(/\r?\n/)`)、`screen_lines`、`clean_line`、`is_divider`、`normalize_text`、`find_last_index`、`wrapped`、`nearest_question`、`parse_border_menu`、`find_menu_dividers`、`parse_numbered_rows`、`menu_rows`、`sequential_rows`、`MenuRow`、`NumberedRow`、`SELECTED`、`NUMBERED_OPTION`
- 画面の終わりの判定の共通の部分: `clean_lines`(TypeScript の `cleanLines`。codex-async が最後の 4 行を見る)、`visible_lines`、`ends`
- JavaScript の正規表現を書くための `js_regex`(`{s}`、`{S}`、`{.}`、`{ws}` を ADR `0193-phase-2-dependencies` の書き換えに置き換える)
- 文字の幅と grapheme: `string_width`(Bun 1.4.4 の `Bun.stringWidth`。`src/jsc/bindings/ANSIHelpers.h` の `consumeANSI` の状態機械を、状態と遷移ごとに写した)、`grapheme_width`、`graphemes`。`string_width` は、制御文字で区切った区間ごとに unicode-width の `str::width` で数えて足す。Bun は制御文字で grapheme を切り、エスケープシーケンスでは切らない(`stringWidth.cpp` の `UTF16WidthAccumulator`)ので、`❤ TAB U+FE0F` は 1 桁、`❤ ESC[31m U+FE0F` は 2 桁になる(Bun 1.4.4 で確かめた)。ADR `0193-phase-2-dependencies` の「残りの文字から制御文字を除き」は、除いたあとに前後をつなぐとこの 2 つを同じ 2 桁に数えるので、区間に分ける形にした。一般カテゴリが Mc の文字(デーヴァナーガリーの母音記号など)は、Bun が 0 桁、unicode-width が 1 桁と数える。ADR `0193-phase-2-dependencies` の確認の範囲(画面の corpus の文字)の外で、合わせるには Bun の幅の表が要るので、#218 にした
- 1 つの系統だけが使うものは、その系統の module に置く: `hintAtEnd` は `pi.rs`、`withoutClaudeTasks` は `claude/`(S2)
- S1 が使わない関数(`parse_numbered_rows`、`menu_rows`、`sequential_rows`、`string_width`、`grapheme_width`、`graphemes`)には、使う Issue の番号を書いた `#[allow(dead_code)]` を付ける。V(#206)が外す(V の書くパスに `screen/src/text.rs` がある)

### TypeScript の値のうち移さないもの

- `menuLabels`: 読むコードがない(`git grep -n menuLabels` は `server/prompt.ts` の中で値を書く行だけを見つけ、`server/prompt-api.ts` には出てこない)
- `KEY.backspace`: 送るコードがない

## 検討した代わり

- `ScreenChecks` を trait object にする: trait の既定の method で「ない」を表すと、「ない」と「あるが何も見つけない」の区別が消え、claude・codex・pi の run でもターンが終わるたびに画面を読むことになる。区別を残すには `has_question()` のような method を判定ごとに足すことになり、同じ事実を 2 つの method で持つ。kind で match する enum も同じ
- `turn_error` を `fn(Option<&str>)` にする(lead の最初の案): TypeScript の 3 つの実装は、どれも出力がないときに何も返さないので、`Option` の層が何も運ばない
- `AnswerStep` のキーを `String` にする: 綴りの誤りがコンパイルで見つからず、S2〜S4 が使うキーの定数を S1 が `answer.rs` に置くと、S1 の時点で使われない定数に dead code の警告が出る
- `Key` に serde の rename と `as_str` の両方で名前を書く(lead の最初の案): 同じ名前を 2 か所に書く
- まだの系統の `PARSERS` に `todo!()` の関数を入れる(lead の最初の案): その agent の画面を読むと panic する。空の slice なら、S2・S3 は関数を足すだけで済む
- dead code を `#[allow(dead_code)]` で止める(lead の最初の案): V が書けない `card.rs` と `answer.rs` に `allow` が残る
- `Answer` を型付きの項目にし、2 つの文言を入れない(最初の決定): 上の「状況」のとおり、`null` を含む答えが承認として通り、Issue #195 の受け入れ条件のテストの期待値を変えることになる
- `Answer` の項目ごとの enum(`enum Given<T> { Value(T), Other }` など): 文字列か、配列か、数かの判定が型の deserialize に移り、文言と順序は `answer_keys` に残るので、`server/prompt.ts:1165-1223` と比べるときに 2 か所を読むことになる。配列の要素も「数でない」ことをカードの判定のあとまで持つ必要があり(1 つの選択のカードに `{"option_indices":["a"]}` を渡すと、TypeScript は要素を見る前に `"This prompt requires one or more selections."` を返す)、`Given<Vec<Given<f64>>>` と入れ子になる
- `Answer::parse(&Value) -> Result<型付きの答え, InvalidAnswer>` と `answer_keys` に分ける: 1 つの操作のために呼ぶ側が 2 回呼び、`InvalidAnswer` を返す関数が 2 つになる。要素の判定は上と同じ理由で parse に移せない
- `Answer` を公開の項目の derive にし、`default` と「ある」を読む `deserialize_with` を付ける: 配列 `[1]` と重複したキーで TypeScript と違う答えになる(上の「公開の型」)
- `CardFields` に `multi_select` を残す: カードの `multi_select` と `Answering::multiple` が同じ事実を 2 か所に持つ

## 依存

なし。この ADR は外部の crate を足さない。使う crate は ADR `0193-phase-2-dependencies` が足した。

## 結果

- S2〜S4 は、自分の系統の `Responder` の variant、`PARSERS` の関数、`tail_is_active` の分岐を、自分のフォルダーの中に書く。カードは `card::finish` で作り、答え方は `Answering` の値として埋める。S5 は `checks::for_kind` と `checks::cursor_usage` を書く。どれも共通のファイルを書かずに済む
- `answer_keys` は、どの JSON の答えにも TypeScript と同じ判定、文言、順序で答える(`null`、型の誤り、重複したキー、オブジェクトでない本文を含む)。screen の公開の口(`From<Value>`)に serde_json の型が出る。screen はもともと serde_json に依存している(ADR `0192-phase-2-split`)
- 段階 4 への申し送り
  - core は、`POST /api/pane/prompt/answer` の本文を `serde_json::Value` で読み、`pane_id` と `prompt_id` をそこから調べ、答えは `screen::Answer::from` に渡す。derive の struct で読むと、重複したキーをエラーにし、`null` と型の誤りで TypeScript の判定の順序(`pane_id`、`prompt_id`、409 の `prompt_changed`、400 の `invalid_answer`。`server/prompt-api.ts:300-307`)が変わる。`Answer::from` は失敗しないので、この順序をそのまま保てる。protocol の `PromptAnswer` に `Deserialize` を残すかは段階 4 が決める
  - f64 に収まらない数(`1e400`)は、serde_json が本文全体を `number out of range` で断る。TypeScript は `Infinity` と読み、`"A valid option index is required."` を返す(どちらも確かめた)。合わせるかは段階 4 が決める
  - `parse_pi_dialog(screen, moved)` は `pub(crate)` で、`moved` が真になる呼び出しは段階 4 の答えの経路(`server/prompt-api.ts:354`)だけ。ADR `0192-phase-2-split` の「段階 2 で移す範囲」のとおり、段階 4 が公開の形を決める
  - core が使う `Key::OpenQueue` と `Key::CloseQueue` は、S1 の時点では crate の中で使われない。公開の enum の variant なので警告は出ない

## 確かめたこと

2026-11-08、Linux(omarchy)、rustc 1.99.1、Bun 1.4.4、`rust` の `c4a2ed4` から切ったブランチで確かめた。

- `rust/` で `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace` が通った。`cargo test --locked -p herdr-fleet-screen --test pi_omp -- --nocapture` は `28 of 28 cases of the slice PiOmp passed` を出した(pi 24 件、omp 3 件、other 1 件)。`answers` のある 9 件の 10 の答えのキーも同じテストで確かめた。screen の単体テストは 18、`tests/pi_omp.rs` のテストの関数は 11 で、すべて通った
- 実装の前に、公開の口と `todo!()` の stub だけでテストを走らせ、`1 of 28 cases of the slice PiOmp passed`、`27 cases failed` で失敗するのを見た(通った 1 件は、読み手のない agent の件で、答えが null)
- CI の「Parsing crates allow their banned APIs only in tests」の grep と「Parsing crates have no I/O dependencies」の `cargo tree` の検査を手元で走らせ、どちらも何も見つけなかった。`src/` に `std::fs`、`std::process`、`std::net` は出てこない
- `text.rs` の単体テストの期待値: `string_width` は ADR `0193-phase-2-dependencies` の表の 27 の文字列と、制御文字とエスケープシーケンスが grapheme を切るかを見る 4 つの文字列(どれも Bun 1.4.4 の値)。`clean_line`、`is_divider`、`normalize_text`、`wrapped`、`parse_numbered_rows`、`menu_rows`、`sequential_rows` は、`server/prompt.ts` を scratchpad に複写して export を足し、Bun 1.4.4 で同じ入力に呼んだ値。そのとき、手で数えた値の 1 つ(区切り線のすぐ下から description が始まる行)が TypeScript と違い、TypeScript の値に直した
- `Answer` の形を直す前に、`rejects_invalid_answer_shapes` の 57・58 行の件を TypeScript の文言に戻し、`null` を含む答えのテスト `a_null_field_is_an_answer_given` を足して走らせた。`the answer is refused: [Keys { keys: [Enter] }]`(`{"option_index": 0, "option_indices": null}` が承認として通った)と、`custom_text: 42` を読めない `invalid type: integer \`42\`, expected a string` で失敗するのを見た。直したあとは通った。期待値は、同じ pi のカードに Bun 1.4.4 で `answerKeys` を呼んだ 18 の答え
- `tests/pi_omp.rs` の `answers_omps_cards_as_typescript_does` の期待値は、Bun 1.4.4 で omp の corpus の 3 つの画面(複数の選択の 1 つは、最初の行に印を付けた形)に `parseInteractivePrompt` と `answerKeys` を呼んだ値。`rejects_invalid_answer_shapes` は `server/prompt.test.ts:53-59` の件で、文言の全体は `server/prompt.ts` のもの
- runner が受け持ちの外の `sameIdAs`、`sameIdAs` の食い違い、期待値との違いで失敗することを、合成した件で確かめた(`tests/pi_omp.rs` の `the_runner_*`)
- PR のレビュー(codex の reviewer と `/code-review high`)の指摘で、ほかに次のものを直した: runner の件の名前を `/` でつなぐ(Windows の区切りで `sameIdAs` と食い違わないように)、`sameIdAs` を件に書かれたとおりの並びで比べる(TypeScript のテストは配列を比べるので、重複した名前も失敗にする)、空の agent を断る(`agentOf`)、`Answering::menu` と `card::option` を共通のファイルに置く(S2〜S4 が同じ関数を自分のフォルダーに書かないように)、content id の入力を複写せずに参照で書く、`OptionKeys::Steps` の添字を `get` で引く、`parse_pi_dialog` の `moved` が真の経路のテスト(期待値は Bun 1.4.4 の `parsePiDialog` の値)
- `string_width` の状態機械は、Bun 1.4.4 の `src/jsc/bindings/ANSIHelpers.h` と `stringWidth.cpp`(GitHub の `oven-sh/bun` の tag `bun-v1.4.4`)を読んで写した
