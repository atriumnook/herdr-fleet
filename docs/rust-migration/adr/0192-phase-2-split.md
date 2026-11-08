# 段階 2 を 14 の Issue に分け、解析の crate の公開の口と corpus の runner の形を決める

- 状態: 採用
- 決めた日: 2026-11-08
- Issue: #192

## 状況

計画(`docs/rust-migration/plan.md`)の段階 2 は、承認画面の解析、adapter の画面の判定、会話ログの解析(各 CLI)を Rust で作り、画面の corpus(`fixtures/screens/`、347 件)と会話ログの corpus(`fixtures/conversations/`、230 件)の全件を Rust の実装で通す。置き場所は ADR `0107-crate-split` が決めた `herdr-fleet-screen` と `herdr-fleet-transcript` で、どちらも `herdr-fleet-protocol` に依存する。Rust の runner がこれらの件を cargo test から読むことは ADR `0122-parity-criteria` が決めている。

段階 2 の作業を、並行する thread が 1 つずつ受け持つ Issue に分ける前に、次のことを決める必要があった。どれも crate の interface に関わり、あとから変えにくい。

- 2 つの Issue が同じパスを同時に書かないように、どの Issue が何を先に書くか
- 外部の crate を、どの Issue が足すか
- 承認画面の解析と transcript の解析の、公開する口の形
- Rust の corpus の runner の形と、途中の Issue でも CI が緑のままでいる方法

今の `rust` の状態(2026-11-08、コミット `b7d77b8`):

- `rust/crates/protocol`、`screen`、`transcript` の `src/lib.rs` は、責務を書いたコメントだけで、型も関数もない
- workspace は外部の crate に依存しない(ADR `0107-crate-split` と `0110-workspace-and-ci` の「依存」)

TypeScript のコードの構成のうち、分け方を左右したもの(行番号は `b7d77b8`):

- `server/prompt.ts` では、どのエージェントの系統の解析も共通の部分を通る: responder の union(48-66)、`ParsedPrompt`(68-79)、カードの id を作る `finishPrompt`(198-212)、responder ごとに分岐する `promptTailIsActive`(822-869)、`parsePrompt` の振り分け(1115-1126)、responder ごとに分岐する `answerKeys`(1152-1224)
- `server/conversation.ts` のページング(404-850)は、source ごとの分岐を `transcriptStream`、`applyHistoryBoundary`、`opensTurn`、`parseTurns`、`liveTurns`、`metadataHead`、`outputInText`、`activeHistoryText` に持つ。Codex のロールアウトの連なりと pi の枝は、読む範囲と `history_id` を決める
- pi と omp は 1 つの parser(`server/transcript-records.ts` の `parseOmpTranscript`)を共有する
- `server/transcript-records.ts`、`server/tool-output.ts`、`server/skill-activity.ts`、`server/conversation-metadata.ts`、`server/conversation-errors.ts` は、2 つ以上の source が使う
- 画面の corpus の `sameIdAs` の 78 の関係は、どれも 1 つのフォルダーと 1 つの呼び出しの種類の中にある

もとにした報告は `docs/rust-migration/architecture/2026-11-08-parsing-crates-review.html`(`improve-codebase-architecture` の手順で調べたもの)。決める前に architect(`spawn --role architect --read-only`、run `8099c90a`)に聞き、答えの分け方と interface をこの ADR の決定にした。

## 決定

### Issue の分け方

段階 2 を次の 14 の Issue にする(ラベル `rust-migration` と `phase:2`)。screen はエージェントの系統(承認画面の解析を分ける単位: Claude、Codex、omp と pi、汎用のメニュー、adapter の画面の判定)ごとに、transcript は source(claude、codex、pi、omp、opencode)ごとに分ける。パスの `screen/` などは `rust/crates/screen/` などを指す。この ADR の中の P0、S1 などの略称は、表の Issue を指す。

| Issue | 中身 | 待つ Issue | 書くパス |
|---|---|---|---|
| #193(P0) | 段階 2 の外部 crate と依存の ADR、protocol の型と `patchText`・`patchFiles`、両方の corpus の `expected` を型に読み書きする往復のテスト | なし | `rust/Cargo.toml`、`rust/Cargo.lock`、`{protocol,screen,transcript}/Cargo.toml`、`protocol/src/`、`protocol/tests/`、依存の ADR |
| #194(CI0) | workflow `rust` に、TypeScript の 2 つの corpus を走らせる job `ts-corpus` | なし | `.github/workflows/rust.yml`、その ADR |
| #195(S1) | screen の土台(公開の口のすべて、共通の行の読み取り、カードと content id、答えのキー、corpus の runner)と pi・omp・other の 28 件 | P0、CI0 | `screen/src/`、`screen/tests/common/`、`screen/tests/pi_omp.rs` |
| #197(S2) | Claude のカードと `parseClaudeSuggestion` の 95 件 | S1 | `screen/src/claude/`、`screen/tests/claude.rs` |
| #198(S3) | Codex のカードと待ち行列の 49 件 | S1 | `screen/src/codex/`、`screen/tests/codex.rs` |
| #199(S4) | `parseFallbackPrompt` の 111 件 | S1 | `screen/src/fallback/`、`screen/tests/fallback.rs` |
| #200(S5) | adapter の画面の判定の 64 件と `cursorUsage` | S1 | `screen/src/checks/`、`screen/tests/checks.rs` |
| #196(T1) | transcript の土台(公開の口、`TranscriptFormat`、読み直すページングの処理、共通の記録の読み取り、OpenCode を除く corpus の runner)と omp の 25 件 | P0、CI0 | `transcript/src/`、`transcript/tests/common/`、`transcript/tests/omp.rs` |
| #201(T2) | Claude Code の 41 件 | T1 | `transcript/src/claude/`、`transcript/tests/claude.rs` |
| #202(T3) | Codex の 51 件 | T1 | `transcript/src/codex/`、`transcript/tests/codex.rs` |
| #203(T4) | pi の 37 件 | T1 | `transcript/src/pi/`、`transcript/tests/pi.rs` |
| #204(T5) | OpenCode の 76 件と、記録した応答を返す runner | T1 | `transcript/src/opencode/`、`transcript/tests/common/opencode.rs`、`transcript/tests/opencode.rs` |
| #205(T6) | 増分の読み取り(cache)と、読み続けた答えと読み直した答えが同じことのテスト | T2、T3、T4 | `transcript/src/paging.rs`、`transcript/src/format.rs`、要るときは `transcript/src/{claude,codex,pi}/`、`transcript/tests/warm.rs` |
| #206(V) | 両方の corpus の全件のテスト、S1 と T1 の `#[allow(dead_code)]` の削除、`parity.md` の段階 2 の行、GLOSSARY | S2〜S5、T2〜T6 | `screen/tests/corpus.rs`、`transcript/tests/corpus.rs`、`screen/src/text.rs`、`transcript/src/{records,skill_activity,tool_output}.rs`、`docs/rust-migration/parity.md`、`docs/rust-migration/GLOSSARY.md` |

同時に走りうる組は、P0 と CI0、S1 と T1、S2〜S5 と T2〜T5、T5 と T6 で、どの組も書くパスが重ならない。共通のファイル(`lib.rs`、`text.rs`、`card.rs`、`answer.rs`、`format.rs`、`paging.rs`、`tests/common/mod.rs`、manifest、`Cargo.lock`)を書くのは、土台の Issue(P0、S1、T1)と、それを待つ T6 と V だけである。あとの Issue が共通のファイルに直しが要ると分かったときは、ADR `0122-parity-criteria` の段階 1 と同じく、直す Issue を別に開いてそれを待つ。外部 crate がさらに要るときも、依存を足す Issue を別に開いて待つ。

エージェントごとに画面と transcript を 1 つの Issue にする分け方は取らない。1 つの Issue が 2 つの crate と 200 件を超え、汎用のメニュー(S4)と adapter の判定(S5)は系統をまたぐので、結局は共通の Issue が要る。

### 外部 crate

段階 2 の外部 crate は P0 がまとめて足す。`Cargo.lock` と crate の manifest は 1 つのファイルで、slice ごとに足すと並行する Issue が同じファイルを書くため。

- protocol: serde(derive)、serde_json(`patchText` が JSON の文字列のリテラルを読む。`shared/patch.ts:19`)、regex
- screen: regex、sha2(カードの content id)、serde と serde_json(content id の入力の符号化、`AnswerStep`)、unicode-width(`Bun.stringWidth`。`server/prompt.ts:433, 441`)、unicode-segmentation(`Intl.Segmenter` の grapheme。`server/prompt.ts:428`)、unicode-normalization(NFKC。`server/prompt.ts:383`)
- transcript: serde、serde_json(feature `preserve_order`。`JSON.stringify(input, null, 2)` の結果が期待値に 768 件あり、キーの順序が答えに出る。feature は workspace の中で合わさるので `[workspace.dependencies]` に 1 回だけ書く)、regex、sha2(Codex の画像の ref は値の sha256 の 16 進で、期待値に 21 件ある。`server/codex-images.ts:36`)、base64(OpenCode のカーソルは JSON の base64url で、記録した応答のキーに 28 件ある。`server/opencode-session.ts:300`)

足さないもの: 乱数の crate(TypeScript の randomUUID の 3 つの用途は、どれも「プロセスごとに違い、プロセスの中で重ならない値」で足り、OS の乱数で初期化される `std::hash::RandomState` から作る値とカウンタで作れる)、block_on(下の OpenCode の port を同期にする)、tempfile と filetime(`std::env::temp_dir`、`std::fs`、`std::fs::File::set_times` で足りる)。

P0 の依存の ADR には、計画の「守ること」の項目(版、入手元、ライセンス、保守の状況、`build.rs` が実行すること)に加えて、slice ごとに違う訳し方をしないための決まりを書く: JavaScript の正規表現から Rust の regex への書き換え(先読みを使う `server/prompt.ts:377, 540, 941` の書き換え方、`\b` と `\w` を ASCII だけにすること、`.` と `\s` の範囲)、UTF-16 の長さで数える箇所(`server/tool-output.ts` の `output_size` は期待値に出る)、`JSON.stringify` と serde_json の違い(数の書き方、対のないサロゲート)、寛容な base64 の復号。

### protocol に置く型

`InteractivePrompt`(`InteractivePromptOption`、kind と queued の enum を含む)、`PromptAnswer`、`QueuedQuestion`、`UsageReading`、`UsageWindow`、エージェントの種類の enum、`ConversationTurn`、`ConversationPart`、`SkillActivity`、`ConversationMetadata`、abandoned の型、`ConversationResponse`(source の enum を含む)と、`shared/patch.ts` の `patchText` と `patchFiles`。段階 2 で protocol を書く Issue は P0 だけにする。

- エージェントの種類の enum の名前は `FleetAgentKind`(`shared/fleet.ts:14` と同じ)にする。protocol には HTTP の `AgentKind`(`shared/protocol.ts:293`、kind と label の組)も入るので、`AgentKind` は名前が衝突する
- 入れないもの: `AnswerStep`(screen と core の間だけで渡し、HTTP に載らないので screen に置く)、`ThinkingLevel`(段階 2 のどの関数も使わない。段階 3 で入れる)、page の答え(TypeScript の `RecognizedConversation`。transcript の答えは `history_id` と `cursor` を必ず持つが、protocol の `ConversationResponse` は scrollback の答えも表すので、これらが任意の項目になっている。transcript の型にする)
- P0 の往復のテスト(両方の corpus の `expected` を型に読み、同じ JSON に書き戻す)で、TypeScript の「項目がない」(`fallback?`、`queued?`、`end_ts?`、`context?`)と「null」(`body`、`custom_option_index`)の区別を 1 か所で固める

### screen の公開の口

```rust
pub struct ParsedPrompt { /* 公開のカード、答え方、responder。項目は非公開 */ }
impl ParsedPrompt { pub fn card(&self) -> &InteractivePrompt; }
pub fn parse_interactive_prompt(agent: &str, screen: &str) -> Option<ParsedPrompt>;
pub fn parse_fallback_prompt(agent: &str, screen: &str) -> ParsedPrompt;
pub fn codex_queued_prompt(screen: &str, unanswered: &[QueuedQuestion], front: Option<&QueueFront>) -> Option<ParsedPrompt>;
pub fn codex_questions_collapsed(screen: &str) -> bool;
pub fn parse_claude_suggestion(screen: &str) -> Option<String>;
pub fn answer_keys(prompt: &ParsedPrompt, answer: &Answer) -> Result<Vec<AnswerStep>, InvalidAnswer>;
pub fn screen_checks(kind: FleetAgentKind) -> /* adapter の画面の判定 */;
pub fn cursor_usage(screen: &str, now: i64) -> Option<UsageReading>;
```

- 解析は、公開のカードと答え方を持つ 1 つの値 `ParsedPrompt` を返す。TypeScript は公開のカードから WeakMap で非公開の値を引き(`server/prompt.ts:85`)、複写したカードには `InvalidAnswer` を返す(`server/prompt.ts:1163-1164`)。値が両方を持てば、この失敗は型の上で起きない。core は `ParsedPrompt` を手元に残し、カードを複写して送る
- 答え方(自由入力の前と後に送るキー、複数選択の行の切り替えと選び終えるキーなど)は、各系統の module が `Answering` の値として埋める。`answer_keys` は responder の名前で分岐しない。TypeScript の `answerKeys` は responder の名前の一覧で分岐する(`server/prompt.ts:1170-1186, 1199-1204`)が、そうすると各系統の Issue が共通の `answer.rs` を書くことになる。「答えはちょうど 1 つ」、範囲、負の数の検査と文言は `answer.rs` の 1 か所に置く
- `Responder` は、系統ごとの enum を包む enum にする(`Responder::Claude(claude::Responder)` など)。画面の終わりの判定(TypeScript の `promptTailIsActive`)も、包む側から各系統の関数に渡す。S1 は、まだの系統に空の enum と `todo!()` の stub を置く
- エージェントの種類(`FleetAgentKind`)から adapter の画面の判定(`startupError`、`question`、`readyError`、`inputReady`、`draft`、`turnError`)を引く `screen_checks` と、Cursor の使用量の画面を読む `cursor_usage` を screen に置く。返す型の形は S1 が決める。段階 3 の orchestrator の adapter は起動の引数を持ち、画面の判定はこの口を呼ぶ

カードの content id:

- 入力は TypeScript と同じ項目にする: agent、kind、title、question、表示のために切る前の body、options、multi_select、custom_option_index、queued、fallback、fallback のカードでは時計の行を置き換えた画面とその行の位置(`server/prompt.ts:198-213, 1359`)。S1 の `card.rs` は、S4 がこの 2 つを足して渡す口を最初から持つ。ハッシュは sha256 にする。std の `DefaultHasher` は鍵が固定なので、画面の文字を操れる人が衝突を作れる。承認の画面に出るコマンドは、リポジトリの内容から来うる
- 値は sha256 の 16 進の全体(64 桁)にし、TypeScript の 12 桁に切らない。content id はプロセスの外に出ない: core は、プロセスごとの乱数と asking の番号でハッシュし直してから id を外に出し(`server/prompt-api.ts:41, 76`)、`prompt.id` を読むのは `server/prompt-api.ts` だけである。12 桁(48 bit)では、約 2^24 回の計算で、内容の違う 2 つの承認を同じ asking に見せる衝突を作れる。全体にしても、corpus(同じ id になる件だけを比べる)にも Web UI にも影響しない
- TypeScript とバイト列を合わせない。合わせるには、解析ごとに違う TypeScript のオブジェクトの項目の並びと `JSON.stringify` の書き方を、18 種類の responder の解析が別々に写すことになる。合わせるのは「同じ内容なら同じ id、違う内容なら違う id」だけにする

### transcript の seam

```rust
pub(crate) trait TranscriptFormat { type Carry: Default + Clone; /* source ごとの違いの method */ }
pub(crate) struct Source<F: TranscriptFormat> { format: F, /* ページングの cache */ }
pub struct Transcripts { claude: Source<claude::Claude>, codex: Source<codex::Codex>, pi: Source<pi::Pi>, omp: Source<omp::Omp> }
```

- `Transcripts::page`、`image`、`tool_output`、`unanswered_questions` は、`lib.rs` の中で `FileSource` を 1 回だけ match して、該当する `Source` に渡す。ページングの処理(`paging.rs`)は source の enum を match しない。engine の中で match すると、どの source がどこで違うかを engine が知り(今の TypeScript の形)、T2〜T4 の全員が `paging.rs` を書くことになる
- trait の method は `server/conversation.ts` の source ごとの分岐から取る: 読む範囲の並びとそれを `history_id` に含める印(Codex の連なり、pi の枝。既定は 1 ファイルの全体)、履歴の境目(`/clear`、`context_clear`、モデルと thinking の設定の記録。既定はなし)、ターンの始まりの印と判定、ターンの解析と解析の間で受け渡す状態 `Carry`(Claude の `peersSeen`)、metadata(`server/conversation-metadata.ts` の source の分岐を各 source の module に分ける)と metadata の頭、abandoned(pi だけ)、ツールの出力、画像
- `Carry` は T1 から trait に入れておく。T6 が増分の読み取りを入れるとき、確定したターンと実行中のターンの間で Claude の `peersSeen` を渡すため。入れておかないと、T6 が全 source の module を書き直す
- source ごとの状態(pi の索引、Codex の連なり、答えのない質問の走査の結果)は、各 source の struct が自分の項目として持つ。`Transcripts` のページングの cache(読んだ範囲と解析したターン)とは別で、ページングの cache は T6 が足す。TypeScript の `forgetTranscriptState` が消さない `piIndexes`、`questionScans`、`linesBeforeCut` も含め、ADR `0107-crate-split` のとおり `Transcripts` の値がすべての cache を持つ
- ファイルの識別(dev、ino、size、mtime、ctime)は `cfg(unix)` の 1 つの関数に閉じ込める。std は Windows で dev と ino を返さないので、unix 以外では dev と ino を使わない識別を `cfg(not(unix))` の同じ名前の関数に置き、Windows で正しく動くかは段階 6 で確かめる。直す場所は 1 つになる
- pi のコンテキストの大きさは、引数で受け取った検索の関数で求める(ADR `0107-crate-split`)
- T1 のページングは呼ばれるたびに読み直す。増分の読み取り(TypeScript の `liveScans`、`settledTurns`、境目の走査の再開、応答の cache、Codex の実行中のターン。`server/conversation.ts:668-826`)は T6 が足す。cache は corpus の答えを変えないので、T1 は corpus だけで確かめ終われる。書き直しの世代(`:471-480`)と境目の位置は答えを変えるので T1 に入れる。T6 は「1 つの `Transcripts` で読み続けた答えが、毎回新しい `Transcripts` で読んだ答えと同じ」ことを corpus の全手順で確かめる

### OpenCode

```rust
pub trait OpencodeApi {
    fn service_running(&self) -> Result<bool, OpencodeError>;
    fn get(&self, path: &str) -> Result<serde_json::Value, OpencodeError>;
}
pub enum OpencodeError { Http { status: u16, tag: String }, Other(String) }
```

- port は同期の trait にする。`OpencodeConversations` の method は `&mut self` を取り、core は `spawn_blocking` の中で呼ぶ。transcript のファイルの読み取りも同期(TypeScript の `transcriptPage` も同期)で、呼び方が 1 つになる。`async fn` を trait に書くと、dyn にできず、返す future が Send かを示せず、runner も future を動かす手段が要る
- 失うものは 2 つ: revert のときの 2 つの GET の並行(`server/opencode-session.ts:344`)は `opencode api` を 1 回起動する時間だけ遅くなる。モデル一覧の読み込みの重なりの除去(`:177`)は、`&mut self` で読み込みが 1 つずつになるので要らなくなる
- 時計は関数で受ける(corpus の手順 `at` のため)。TypeScript が `Date.now()` を直接読む `windows()`(`:175, 188`)も受けた時計を使う
- `OpencodeConversations` は `Transcripts` と別の値にする。core が別の Mutex で持てば、遅い `opencode api` がファイルの transcript の読み取りを待たせない

### corpus の runner

- crate の `tests/common/mod.rs`(screen は S1、transcript は T1 が書く)に、件の読み込みと形の検査、期待値との比べ方、call から公開の関数への dispatch、件をどの Issue が受け持つかを決める `slice_of`、受け持ちの件を通す `check`、受け持ちを区別せずに全件を通す `check_all`(V が使う)を置く。各 Issue が足すのは `tests/<名前>.rs` の 1 ファイルで、中身は `common::check(<受け持ち>)` を呼ぶだけにする。分け方を各テストのファイルの filter に書くと、同じ分け方を 5 か所に書くことになり、どの filter にも当たらない件が出うる
- 受け持ち: screen は S1 が pi・omp・other の `parseInteractivePrompt`、S2 が claude の `parseInteractivePrompt` と `parseClaudeSuggestion`、S3 が codex の `parseInteractivePrompt`・`codexQueuedPrompt`・`codexQuestionsCollapsed`、S4 が `parseFallbackPrompt`、S5 が adapter の判定。transcript はフォルダー(source)で分ける
- 公開の関数は S1 と T1 が最終の signature で置き、まだの系統の中身は `todo!()` にする。各テストは自分の受け持ちの件だけを走らせるので stub は呼ばれず、CI は緑のまま進む。全件を走らせる 1 つのテストに「まだの件」の一覧を持たせる案は、すべての Issue がその一覧を書くので取らない
- `sameIdAs`: 今の corpus では受け持ちをまたぐ関係は 0 件なので、各 Issue のテストの中ですべて確かめられる。common の check は、`sameIdAs` に受け持ちの外の件が挙がっていたら失敗させる。V の全件のテストは corpus 全体で確かめる
- 比べ方: 期待値と答えを `serde_json::Value` にして比べ、数は値で比べる。TypeScript の runner は JSON として読み直した値で比べる(`scripts/screen-fixtures.ts:101`)が、serde_json は `1` と `1.0` を別の Number として扱うため
- `tests/common/mod.rs` の先頭に `#![allow(dead_code)]` を書く(テストの binary ごとに使わない関数があるため)。corpus のファイルを読み書きするのは `tests/common/` の runner の module だけにし、禁じた API の allow はその module に理由とともに書く(ADR `0122-parity-criteria` の「段階 2 への注意」)

### 段階 2 で移す範囲

- corpus の呼び出しから届くコードは、段階 2 で中身を移す。そのうち、crate の中では公開の関数が使い、crate の外では core だけが呼ぶ関数(`queuedQuestionCount`、`sameText`、`parsePiDialog`、`promptTailIsActive`)は `pub(crate)` にし、呼ぶ側(`server/prompt-api.ts`)を移す段階 4 の Issue が公開の形を決める。crate の中で使うので、`pub(crate)` のままでも使われない関数にはならない
- corpus から届かないコードは、呼ぶ側を移す Issue が移す。Codex の画面との照合(`matchCodexTranscript`、`matchShortCodexAnswers`、`matchCodexFirstExchange`、`server/codex.ts:733, 810, 929`)は、候補を sqlite と ps で集める `codexTranscriptPath` を core に移す段階 4 の Issue が transcript に移す。今移すと、呼ぶ側のないまま入力の形を推測することになる。`resumedThread` と `codexHomeInPsLine` は ps と argv の読み取りで、ADR `0107-crate-split` の表の core の部分に当たる
- `cursorUsage` は corpus に件がないが S5 で移し、期待値は `server/fleet/adapters.test.ts` の該当する `it` から取る。S5 が adapter の画面の判定をすべて移せば、段階 3 の orchestrator は画面の判定を 1 か所から呼べる
- 段階 4 への申し送り: `server/prompt-api.ts:337-357` は、responder、選択中の行、`parsePiDialog`、`promptTailIsActive` を組み合わせて、答えのキーを送ってよい画面かを判定する。段階 4 では `Responder` を公開せず、この判定を screen の関数にすると、core は responder の名前を知らずに済む

### CI で TypeScript の corpus を走らせる

ADR `0122-parity-criteria` は、TypeScript の答えとの一致を CI で確かめるかを段階 2 に残した。CI0 で確かめる。段階 2 の Issue は、件が誤っていると判断して期待値を変えることがあり、決まり(standing の関門 5)はその根拠を TypeScript の振る舞いなどの独立の情報源に求める。workflow `rust` に job `ts-corpus` を足し、`bun test server/screen-fixtures.test.ts server/conversation-fixtures.test.ts` を走らせれば、Rust の答えに合わせて件を変えた PR は merge の前に赤になる。2 つのテストは node_modules なしで通る(582 件、0.64 秒)ので、`bun install` は要らない。bun は第三者の action を使わず、版を固定した release の zip を sha256 で照合して入れる(ADR `0110-workspace-and-ci` が action を checkout だけにした方針に合わせる)。job の中身と bun の依存は CI0 の ADR に書く。

### GLOSSARY

段階 2 で名前を付けた語(`ParsedPrompt`、答え方 `Answering`、`TranscriptFormat`、`FleetAgentKind`、content id)は V が `docs/rust-migration/GLOSSARY.md` に足す。段階 2 の途中の Issue は GLOSSARY を書かない(並行する Issue が同じファイルを書かないため)。この Issue(#192)の書くパスは `docs/rust-migration/architecture/` と `docs/rust-migration/adr/` だけなので、この ADR の PR では足さない。

## 検討した代わり

- 型と外部 crate を slice ごとに足す: `Cargo.lock`、crate の manifest、protocol の `lib.rs` を並行する Issue が書く。型の多くは複数の Issue が使う(`InteractivePrompt` は S1〜S4、`ConversationTurn` は T1〜T5、`QueuedQuestion` は S3 と T3)
- 答えのキーの分岐をすべて S1 の `answer_keys` に書く(lead の最初の案): 各系統の Issue が自分の答え方を直すたびに `answer.rs` を書くことになる
- WeakMap に当たる登録表を screen に持つ: 隠れた状態を持つ。答えるときに画面を読み直す案は、答えのキーが見せたカードではなく今の画面で決まり、TypeScript と振る舞いが変わる
- content id を 12 桁のままにする: corpus は通るが、上に書いた衝突の余地が残る。12 桁にする理由(画面に出す、URL に載せる)は Rust 版にない
- 増分の読み取りを T1 に入れる(lead の最初の案): T1 が TypeScript の約 1,400 行になり、T2〜T6 が待つ最長の経路に乗る。OpenCode の runner を T5 に移したのも同じ理由
- Claude のカード(S2)を question と approval に分ける: どの解析も当たらないことを確かめる Claude の件(期待値が null)が、どちらの Issue にも属さない。95 件、TypeScript の約 420 行で 1 つの Issue に収まる
- Codex の会話(T3)の連なりを別の Issue にする: `codex-home` の木を持つ 9 件だけが連なりを使うが、受け持ちが 2 つのテストのファイルに分かれる。T3 の進み方を見て、要れば分ける
- T6 を段階 2 から外す: 段階 2 の完了条件(両方の corpus を通す)は T6 なしでも満たせる。ADR `0107-crate-split` がページングの cache を `Transcripts` の責務にしており、段階 4 の core が cache のない transcript を呼ぶと、数百 MB のロールアウトを毎回すべて読むので、段階 2 に入れた
- CI で TypeScript の corpus を走らせない: Rust の答えに合わせて件を変えた PR を、レビューだけで止めることになる

## 依存

なし。この ADR は外部の crate を足さない。段階 2 の外部 crate は P0 の ADR、bun は CI0 の ADR が足す。

## 結果

- 段階 2 の Issue は上の表のとおりに進む。P0 と CI0 のあと、S1 と T1 が並行し、そのあと S2〜S5 と T2〜T5 の 8 つが並行する。T6 は T2〜T4 を、V はすべてを待つ
- 共通のファイルを書くのは土台の Issue だけなので、あとの Issue が共通のファイルの直しを見つけると、直す Issue を待つ分だけ遅れる
- screen の公開の口は `ParsedPrompt` を返し、core(段階 4)はカードの値ではなく `ParsedPrompt` を持つ
- transcript に source を足すときは、`TranscriptFormat` を実装する module を 1 つ足し、`lib.rs` の match に 1 行足す
- OpenCode の読み手は同期で、core は `spawn_blocking` で呼ぶ
- CI0 のあと、段階 2 のどの PR も、TypeScript の 2 つの corpus が通らなければ赤になる

## 確かめたこと

2026-11-08、Linux(omarchy)、`rust` ブランチの `b7d77b8` で確かめた。Rust のコードは書いていないので、cargo の検査はない。

- TypeScript の 2 つの corpus のテストを node_modules なしで走らせた。`env $(env | grep -oE '^HERDR[A-Z_]*' | sed 's/^/-u /') HERDR_TEST_MODE=unit HERDR_SOCKET=/nonexistent/herdr.sock bun test server/screen-fixtures.test.ts server/conversation-fixtures.test.ts` の結果は `582 pass / 0 fail`(644 ms、Bun 1.4.4)
- 画面の corpus の件を、上の受け持ちの決まりで python で分けた。結果は S1 28、S2 95、S3 49、S4 111、S5 64(計 347)で、`sameIdAs` が受け持ちをまたぐ関係は 0 件
- 会話ログの corpus の件の数は claude 41、codex 51、omp 25、opencode 76、pi 37(計 230)
- 期待値と記録した応答の中の数を grep で数えた(architect): `codex-<sha256>` の ref が 21 件、`api.json` のキーの base64url のカーソルが 28 件、2 桁の字下げの JSON の `input` が 768 件
- 表の「書くパス」を突き合わせ、同時に走りうる組(P0 と CI0、S1 と T1、S2〜S5 と T2〜T5、T5 と T6)で重なるパスがないことを確かめた
