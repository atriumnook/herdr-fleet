# transcript の crate の公開の口の最終の signature と、ページングの処理と source の間の trait の形を決める

- 状態: 採用
- 決めた日: 2026-11-08
- Issue: #196

## 状況

ADR `0192-phase-2-split` は、`herdr-fleet-transcript` の公開の口の形(`Transcripts` の 4 つの method、`FileSource`、ページの要求と答えの型、画像の型、3 つのエラー、pi のコンテキストの大きさを引く関数、`pub mod opencode`)と、ページングの処理(`paging.rs`)と source ごとの違いの間の trait `TranscriptFormat` を決め、最終の signature を T1(#196)に任せた。T2〜T5(#201〜#204)は `lib.rs`、`errors.rs`、`format.rs`、`paging.rs`、`tests/common/mod.rs` を書けない(ADR `0192-phase-2-split` の「Issue の分け方」)ので、ここで決めた signature は、段階 2 のあいだ変えられない。

ADR `0192-phase-2-split` が決めていなかったのは次の 7 点である。

1. Codex のローカルの画像の起点(ペインの cwd)をどこで渡すか
2. `unanswered_questions` が何を受けるか
3. `ConversationUnavailable` の reason を文字列にするか enum にするか
4. `OpencodeConversations` の `image` と `tool_output` が失敗をどう返すか
5. OpenCode の reader の時計の型
6. `Page` から protocol の `ConversationResponse` への変換を置くか
7. 書き直しの世代(TypeScript の `transcriptRevisions`)を source ごとに持つか、1 つを共有するか

lead の案(公開の口の型と、上の 7 点の選び方)を architect(fleet の run `64dd8d35`、claude)に聞き、答えをこの ADR の決定にした。architect は案の 4 か所を直すよう答え(下の「architect が直した点」)、lead はすべて取り入れた。

## 決定

### 公開の口

```rust
pub type PiContextWindow = Box<dyn Fn(&str, Option<&str>) -> Option<f64> + Send + Sync>;

pub enum FileSource { Claude(PathBuf), Codex(CodexRollout), Pi(PathBuf), Omp(PathBuf) }
pub struct CodexRollout { pub path: PathBuf, pub home: PathBuf, pub cwd: PathBuf }

#[derive(Default)]
pub struct PageRequest { pub before: Option<String>, pub since: Option<String>, pub from: Option<String> }
#[derive(Serialize)]
pub struct Page {
    pub source: ConversationSource, pub turns: Vec<ConversationTurn>, pub metadata: ConversationMetadata,
    pub cursor: Option<String>,                 // null を書く
    pub abandoned: Option<AbandonedTurns>,      // None のときは書かない
    pub history_id: String, pub version: String,
}
pub struct Image { pub media_type: String, pub bytes: Vec<u8> }

pub enum ConversationError {
    HistoryChanged,
    ConversationUnavailable(UnavailableReason),
    ConversationNotStarted { session_id: String, source: ConversationSource, identity: String },
    Opencode(OpencodeError),
}
pub enum UnavailableReason { TranscriptMissing, BranchUnreadable, OpencodeServiceStopped, OpencodeSessionMissing, OpencodeRevertTooDeep }

impl Transcripts {
    pub fn new(pi_context_window: PiContextWindow) -> Self;
    pub fn page(&self, file: &FileSource, page: &PageRequest) -> Result<Page, ConversationError>;
    pub fn image(&self, file: &FileSource, reference: &str) -> Option<Image>;
    pub fn tool_output(&self, file: &FileSource, reference: &str) -> Option<String>;
    pub fn unanswered_questions(&self, rollout: &CodexRollout) -> Vec<QueuedQuestion>;
}

pub mod opencode {
    pub trait OpencodeApi: Send + Sync { fn service_running(&self) -> Result<bool, OpencodeError>; fn get(&self, path: &str) -> Result<serde_json::Value, OpencodeError>; }
    pub enum OpencodeError { Http { status: u16, tag: String }, Other(String) }
    pub type Clock = Box<dyn Fn() -> i64 + Send + Sync>;
    impl OpencodeConversations {
        pub fn new(api: Arc<dyn OpencodeApi>, now: Clock) -> Self;
        pub fn page(&self, session_id: &str, working: bool, page: &PageRequest) -> Result<Page, ConversationError>;
        pub fn image(&self, session_id: &str, reference: &str) -> Result<Option<Image>, ConversationError>;
        pub fn tool_output(&self, session_id: &str, reference: &str) -> Result<Option<String>, ConversationError>;
    }
}
```

7 点の決定と理由:

1. cwd は `CodexRollout` の項目にし、`image` の引数にしない。cwd を使うのは Codex の画像だけ(`server/codex-images.ts:61` の `resolve(cwd, value)`)で、値はロールアウトを探すときにも使う `pane.cwd`(`server/conversation.ts:971, 1097`)と同じである。引数にすると、4 つの source の `image` と `TranscriptFormat::image` が、Codex だけが読む引数を持つ。段階 4 の core は、ペインから `FileSource` を作る 1 つの関数で `CodexRollout { path, home, cwd: pane.cwd }` を作り、page、image、tool_output に同じ値を渡す。page と tool_output は cwd を読まない
2. `unanswered_questions` は `&CodexRollout` を受ける。Codex だけの操作であることを型が示し、Claude のパスを渡すとコンパイルが通らない。呼ぶ側(`server/prompt-api.ts:165`)は会話の route と同じ解決でパスを得るので、core は 1 つの解決の関数を 2 つの route で使える。読めないロールアウトには空の `Vec` を返す。TypeScript は投げる(`server/codex.ts:503`)が、呼ぶ側はそれを null にし(`server/prompt-api.ts:177`)、空の一覧を渡しても `queuedPrompt` は null を返す(`server/prompt.ts:405`)ので、core にとって同じである
3. reason は enum `UnavailableReason` にし、綴りは `as_str` の 1 か所に書く。reason は HTTP の答えに出ない: 会話の route は `ConversationUnavailable` を reason にかかわらず scrollback の答えにし(`server/index.ts:1536, 1539`)、reason を読むコードは `server`、`src`、`shared` に 1 つもない。それでも enum にするのは、T3 と T4 が同じ綴りを別々に書かずに済むためである。core のパスの解決が作る reason(`no_session_path` など)は、段階 4 の core のエラーの型が持つ
4. OpenCode の `image` と `tool_output` は `Result<Option<_>, ConversationError>` を返す。corpus の `opencode/service-stopped` は image と toolOutput にも失敗を期待している。null に変えるのは core である(`server/conversation.ts:55-58` の `unavailableAsNull`)。CLI のそのほかの失敗(タイムアウト、JSON でない返答、500)は `ConversationError::Opencode` で返し、route が 500 にする(`server/opencode-session.ts:310`、`server/index.ts:1540`)。この variant を返すのは `OpencodeConversations` だけである
5. 時計は `i64` の epoch ミリ秒にする。TypeScript の時計は `Date.now()` で整数を返し、corpus の `at` の 4 つの値もすべて整数である。screen の `cursor_usage(screen, now: i64)`(ADR `0192-phase-2-split`)とも揃う
6. `Page` から `ConversationResponse` への `From` は置かない。この変換で決めることは「`version` を本文に入れず ETag にする」(`server/index.ts:1528`)だけで、route が決めることである。`Page` の項目は公開で、段階 4 の route が変換を書ける。`Page` の doc に、`version` を本文に書かないことを書いた
7. 書き直しの世代は `Source<F>` ごとに持つ。ADR `0192-phase-2-split` はページングの状態を `Source<F>` に置き、T6 が足す確定したターンの cache は source ごとの型の `Carry` を持つ。世代だけを共有すると、ページングの状態の持ち主が 2 つになる

architect が直した点: (a) 失敗の enum に `Opencode(OpencodeError)` を足した。案では、T5 が CLI の失敗を返す口がなく、`errors.rs` は T5 が書けない。(b) cwd を `image` の引数から `CodexRollout` に移した。(c) reason を enum に、時計を `i64` にした。(d) `OpencodeConversations::tool_output` の doc に、TypeScript の core が切っていた 2,000,000 UTF-16 単位の上限(`server/conversation.ts:1140`)を reader が印なしで切ると書いた。core が上限を持たずに済むように。

### `TranscriptFormat`(crate の中)

`server/conversation.ts` の source ごとの分岐を、次の method にした。`paging.rs` は source の enum を match しない。

| method | TypeScript の分岐 | 既定 |
|---|---|---|
| 関連型 `Place`、`live_path` | `resolveTranscript` の答え(Codex は home と cwd も) | なし |
| `segments`、`layout_mark` | `transcriptStream` の読む範囲と `history_id` の印(Codex の連なり、pi の枝) | ファイルの全体、印なし |
| `clear_mark`、`is_clear`、`keeps_settings` | `applyHistoryBoundary`、`isContextClear`、`SETTING_TYPES` | 境目なし |
| `turn_marks`、`opens_turn` | `TURN_MARK`、`PEER_MARK`、`opensTurn` | なし |
| 関連型 `Carry`、`parse_turns`、`parse_live` | `parseTurns`、`liveTurns` の `peersSeen`、`codexLiveTurn` | `parse_live` は `parse_turns` |
| `metadata`、`metadata_head` | `parseConversationMetadata` の source の分岐、`metadataHead` | 頭は境目から |
| `abandoned` | `piAbandonedTurns` | なし |
| `tool_output`、`output_in_entry` | `transcriptToolOutput`、`outputInText` | ファイルの全体を境目から |
| `image` | `transcriptImage`、`piTranscriptImage`、`codexTranscriptImage` | なし |

- ページングの処理は、TypeScript の新しいページの読み方(確定したターンと実行中の最後のターンを別々に解析し、`Carry` を渡し、metadata を続けて畳む)を、cache なしで毎回たどる。読み直した答えが TypeScript の cold read と同じになるように、`liveTurns` の分け方を残した。cache は T6 が足す
- 境目の位置は毎回ファイルの先頭から走査する。TypeScript の走査の再開は答えを変えない cache なので T6 に送る
- ファイルの識別は `paging.rs` の `file_stat`(`cfg(unix)` で dev、ino、size、mtime、ctime を読む)の 1 か所にし、`cfg(not(unix))` の同じ名前の関数は作成時刻と更新時刻で代える。書き直しの世代は、その値だけから `PagingState::generation` が決める
- プロセスごとの値(TypeScript の `randomUUID` の 2 つの用途、`PROCESS_VERSION` と書き直しの世代)は、`RandomState` で作った 128 bit の種とカウンタで作る(`ProcessIds`)
- `Mutex` は `Source<F>` の `PagingState` を読み書きする間だけ持つ(`generation` の 1 回)。ファイルの読み取りと解析の間は持たない

### 共通の関数の置き場所

T2〜T5 は共通のファイルを書けないので、2 つ以上の source が使う関数を T1 が置いた。omp が使わない関数は `#[allow(dead_code)]` を付け、V(#206)が外す。V の書くパスは `records.rs`、`skill_activity.rs`、`tool_output.rs` なので、使われない関数はこの 3 つのファイルにだけ置いた。

- `records.rs`: 記録の読み取り(`record`、`parse_line`、`result_text`)、pi 系の記録(`pi_message`、`pi_results`、`pi_image_block`、`pi_notice`、`pi_opens_turn`、`pi_context_clear`、`parse_omp_transcript`)、`tool_summary`、`IMAGE_TYPES`、metadata の共通の部分(`metadata_label`、`token_count`、`context_of`)、寛容な base64 の復号(ADR `0193-phase-2-dependencies`)
- `skill_activity.rs`: `server/skill-activity.ts` のすべて
- `tool_output.rs`: `trimOutput`
- `js_json.rs`: `JSON.stringify(value, null, 2)`(ADR `0193-phase-2-dependencies` の決まり)
- `format.rs`: `output_in_text`、`active_history_text`、`TOOL_REF`

### corpus の runner

- `tests/common/mod.rs` は、TypeScript の runner(`scripts/conversation-fixtures.ts`)の検査をすべて写す。OpenCode の記録した応答だけを `tests/common/opencode.rs` の `RecordedOpencodeApi`(`new`、`set`、`unrecorded` と `OpencodeApi` の実装)に任せ、T1 は `todo!()` の stub を置く
- runner は、Codex の image の手順では `cwd` を、ほかの手順では件のフォルダーを `CodexRollout::cwd` に入れる
- `{"at": …}` が整数でなければ件を失敗にする。TypeScript の runner は小数も通す(`scripts/conversation-fixtures.ts:233`)が、時計は整数を返すので、今の件の答えは変わらない
- 読み手が `ConversationError::Opencode` を返したら、件を失敗にする(TypeScript の `failure` が投げ直すのと同じ。`scripts/conversation-fixtures.ts:389-394`)

### TypeScript と違う振る舞い

- 記録の `timestamp` が文字列でないとき、TypeScript はその値をそのまま `ts` にする(数なら数)が、Rust は `null` にする。protocol の `ts` は `Option<String>`(ADR `0193-protocol-types`)で、数を持てない。corpus の jsonl の `timestamp` は 1,860 件すべて文字列である(python で数えた)
- 書き直しの世代を覚える件数の上限が source ごとに 64 になる(全体で最大 256)。TypeScript は全 source で 64 を共有する(`server/conversation.ts:478`)。違いが出るのは、64 を超えるファイルを読む間に 1 つのファイルを読み直すときだけである。そのとき TypeScript は世代を追い出して忘れ、`history_id` が変わることがあるが、Rust は source ごとに 64 件を覚えるので、追い出す回数が少ない

## 検討した代わり

- cwd を `image` の引数にする(lead の最初の案): 4 つの source の口が Codex だけの引数を持つ
- Codex の画像だけの別の method: 画像を読む口が 2 つになり、core が source で分岐する
- `unanswered_questions` が `&Path` または `&FileSource` を受ける: `&Path` は Claude のパスでも通り、`&FileSource` は 3 つの source が空を返すだけの枝を持つ
- reason を `String` にする(lead の最初の案): T3 と T4 が同じ綴りを別々に書く
- OpenCode だけの失敗の型 `OpencodeReadError`: core が route ごとに 2 つの型を詰め替える。TypeScript では失敗の経路が 1 つで、core の振り分け(409、scrollback、500)も 2 つの source で同じ
- `Page` に `From<Page> for ConversationResponse` を置く: HTTP の決定(version を ETag にする)が解析の crate に入る
- 書き直しの世代を `Transcripts` で 1 つ共有する: ページングの状態の持ち主が 2 つになる
- `TranscriptFormat` の Place を関連型にせず、すべての method に Codex の home を渡す: Codex だけの値が全 source の口に入る

## 依存

なし。この ADR は外部の crate を足さない(段階 2 の crate は ADR `0193-phase-2-dependencies`)。

## 結果

- T2〜T4 は自分の source のフォルダーの `TranscriptFormat` の実装と stub の中身を書き、T5 は `src/opencode/` と `tests/common/opencode.rs` を書く。どれも `lib.rs`、`format.rs`、`paging.rs`、`tests/common/mod.rs` を書かずに済む
- T2〜T4 は、source の状態(pi の索引、Codex の連なり、答えのない質問の走査)を自分の struct の項目として `Mutex` で持ち、ファイルの読み取りの間は持たない
- T6 は、TypeScript の cache の上限(答え 32、`liveScans` 32、`clearScans` 32、`settledTurns` 8、`codexTurns` 8)が source ごとになる(全体で最大 4 倍)ことを受け入れるか、source の数で割るかを決めて記録する
- 段階 4 の core は、ペインから `FileSource` を作る 1 つの関数を持ち、`ConversationError` を route ごとに振り分ける(`HistoryChanged` は 409、`ConversationUnavailable` と `ConversationNotStarted` は scrollback、`Opencode` は 500)
- T3 への申し送り(architect): TypeScript は Codex のローカルの画像を `O_NONBLOCK` で開き、通常のファイルかを確かめてから読む(`server/codex-images.ts:61-64`)。同期の open は FIFO で止まり、core の blocking のスレッドを占め続ける

## 確かめたこと

2026-11-08、Linux(omarchy)、`rust` の `c4a2ed4` から切ったブランチで確かめた。

- `cargo test --locked -p herdr-fleet-transcript --test omp`: omp の 25 件を正順と逆順で通した(`test omp_conversations ... ok`)
- 実装の前の失敗: `Transcripts::page` と `tool_output` の omp の枝を `todo!()` にして同じテストを走らせ、`panicked at crates/transcript/src/lib.rs:117:35` で失敗した
- runner が比べていること: `parse_omp_transcript` の `Error: ` を `Err: ` に変えて走らせ、`omp/failed-request step 0` の 1 件だけが失敗した(戻して通した)
- `js_json.rs` の単体テストの期待値は Bun 1.4.4 の `JSON.stringify` の答えから取り、`stringify_pretty` を serde_json の `to_string_pretty` に替えると 3 つのうち 2 つ(`-0.0` と、整数のキーの順序)が失敗した
- 寛容な base64 の単体テストの期待値は、ADR `0193-phase-2-dependencies` の表と、Bun 1.4.4 の `Buffer.from(…, "base64")` の答え(同じ 18 の入力)から取った
- architect の数えたこと: corpus の reason の期待値は transcript_missing 1、branch_unreadable 2、opencode_service_stopped 3、opencode_session_missing 1、opencode_revert_too_deep 1。`at` の 4 つの値はすべて整数。reason を読むコードは `server`・`src`・`shared` に 0 件
