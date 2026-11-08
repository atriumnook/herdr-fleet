# 段階 2 の関門の報告

- 確かめた日: 2026-11-09
- 確かめた対象: `rust` ブランチのコミット `4d0a692`(PR #239 のマージ)。報告を書き始めたとき(`git fetch origin` のあと)の `origin/rust` の先頭である
- 確かめた thread: `57c49b3a`
- 結論: 計画(`docs/rust-migration/plan.md`)の「段階 2: 解析の crate」の完了条件「画面の corpus と会話ログの corpus の全件を、Rust の実装が通す」と、段階 2 の項目 3 つを、すべて満たす。ADR `0192-phase-2-split` が段階 2 に入れたもの(外部 crate と protocol の型、増分の読み取り、CI の job `ts-corpus`、`#[allow(dead_code)]` の削除、parity.md の段階 2 の行、GLOSSARY)も満たす。足りないものは 0 件で、Issue は開いていない。段階 2 の Issue #192〜#206 と、途中で見つかった #218・#219・#225・#234 はすべて閉じている(PR #207、#208、#213、#216、#217、#220〜#224、#226〜#229、#231〜#233、#235、#236)

## 確かめた環境

- PC: Linux 7.2.15-1-omarchy、Bun 1.4.4、herdr 0.9.1、cargo 1.99.1、rustc 1.99.1(`rust/rust-toolchain.toml` の版。rustup は `~/.cargo/bin` から使った)
- 検査はすべて `HERDR_*` の環境変数を外して実行した(`env $(env | grep -oE '^HERDR[A-Z_]*' | sed 's/^/-u /') …`)。TypeScript の 2 つの corpus のテストには `HERDR_TEST_MODE=unit HERDR_SOCKET=/nonexistent/herdr.sock` を付けた
- この関門の検査は herdr のセッションを使わず、HTTP のサーバーも起動しない。node_modules は入れていない(2 つの corpus のテストと `bun scripts/parity.ts` は node_modules なしで走る。ADR `0194-ts-corpus-job`)

## 完了条件

| 完了条件 | 確かめたこと | 結果 |
|---|---|---|
| 画面の corpus の全件を、Rust の実装が通す | `cargo test --locked -p herdr-fleet-screen --test corpus -- --nocapture` が `347 of 347 cases of the slice every passed` を出し、`every_screen_case` が通った(1 件通過、0 件失敗)。受け持ちごとの件数は `{"Checks": 64, "Claude": 95, "Codex": 49, "Fallback": 111, "PiOmp": 28}` で、合わせて 347 件。`find fixtures/screens -name case.json` も 347 件で一致した。TypeScript の `bun test ./server/screen-fixtures.test.ts` は 349 件通過、0 件失敗で、349 件は件ごとのテスト 347 件と、件ごとでないテスト 2 件(件があることの確認と、`sameIdAs` を全件で確かめるテスト。ADR `0192-phase-2-split` の「CI で TypeScript の corpus を走らせる」)である。Rust の `check_all` は `sameIdAs` も corpus の全体で確かめる | 満たす |
| 会話ログの corpus の全件を、Rust の実装が通す | `cargo test --locked -p herdr-fleet-transcript --test corpus -- --nocapture` の `every_conversation_case` が通った(この binary の 9 件通過、0 件失敗。ほかの 8 件は runner 自身のテスト)。source ごとの件数は `{"claude": 41, "codex": 51, "omp": 25, "opencode": 76, "pi": 37}` で、合わせて 230 件。`find fixtures/conversations -name case.json` も 230 件で、source ごとのフォルダーの件数も一致した。`check_all` は、全件を順に走らせて、期待値のない手順も含めて失敗を集め、逆の順でもう 1 回走らせて同じ答えかを確かめる(`rust/crates/transcript/tests/common/mod.rs` の `check_cases`)。TypeScript の `bun test ./server/conversation-fixtures.test.ts` は 233 件通過、0 件失敗で、233 件は件ごとのテスト 230 件と、件ごとでないテスト 3 件(件があることの確認、全件を逆の順で走らせるテスト、すべての source の呼び出しの振り分けの確認)である | 満たす |

### main の取り込み(#238、PR #239)で増えた件

PR #239 は corpus の件を増やしていない。`git diff --stat 5fc064d 4d0a692 -- fixtures/screens fixtures/conversations` は空で、PR #239 が変えた fixtures は `fixtures/fleet-cli/` の 6 件(fleet CLI の契約。段階 3 の基準)だけだった。ADR `0192-phase-2-split` を書いたときのコミット `b7d77b8` からも、`git diff --stat b7d77b8 4d0a692 -- fixtures/screens fixtures/conversations` は空である。ADR が書いた件数(画面 347 件、会話ログ 230 件)が、今の件数と同じである。

Goal の「画面の corpus は 349 件になった」の 349 は、TypeScript のテストの件数(347 件と、件ごとでない 2 件)である。段階 1 の 2 回目の関門(`docs/rust-migration/gates/phase-1.md`)も 347 件の `case.json`、349 件のテストと書いている。

PR #239 が変えた TypeScript のうち、Rust の解析が写す側のファイル(`server/prompt.ts`、`server/conversation.ts`、`server/fleet/adapters.ts` など)は 1 つも変わっていない。変わったのは `shared/fleet.ts` の report の型と関数(`RunReport`、`TurnOutcome`、`needsPerson` など)と `server/fleet/` の orchestrator などで、段階 2 の crate は使わない。`b7d77b8` から `4d0a692` までに解析の TypeScript が変わったのは `server/conversation.ts` の 1 コミット `bea0abf`(#219)だけで、同じ PR #233 が Rust の側も直し、`rust/crates/transcript/tests/concurrent.rs` にテストを足した。

## 段階 2 の項目

| 項目(計画の段階 2) | 確かめたこと | 結果 |
|---|---|---|
| 承認画面の解析を Rust で作る | `rust/crates/screen/src/lib.rs` に、ADR `0192-phase-2-split` の「screen の公開の口」の関数 `parse_interactive_prompt`、`parse_fallback_prompt`、`codex_queued_prompt`、`codex_questions_collapsed`、`parse_claude_suggestion` と、`answer_keys`(`answer.rs` からの re-export)がある。受け持ちの件(Claude 95 件、Codex 49 件、汎用のメニュー 111 件、pi・omp・other 28 件)は、全件のテストの中で通った。受け持ちごとのテスト `tests/claude.rs`、`codex.rs`、`fallback.rs`、`pi_omp.rs` も通った。`grep -rnE "todo!\|unimplemented!" rust/crates/{protocol,screen,transcript}/src` は 0 件で、stub は残っていない | 満たす |
| adapter の画面の判定を Rust で作る | `screen_checks(kind: FleetAgentKind) -> ScreenChecks` と `cursor_usage` が `rust/crates/screen/src/lib.rs` にある。adapter の判定の 64 件は全件のテストの中で通り、`tests/checks.rs` の 9 件(`cursorUsage` の期待値を `server/fleet/adapters.test.ts` から取ったテストを含む)も通った | 満たす |
| 会話ログの解析(各 CLI)を Rust で作る | `rust/crates/transcript/src/` に `claude`、`codex`、`pi`、`omp`、`opencode` の module がある。ファイルを読む 4 つの source は `Transcripts` の `page`、`image`、`tool_output`、`unanswered_questions` から、OpenCode は `opencode::OpencodeConversations` の `page`、`image`、`tool_output` から読む。source ごとのテスト(`tests/claude.rs`、`codex.rs`、`pi.rs`、`omp.rs`、`opencode.rs`、`codex_images.rs`)と、全件のテストの 230 件が通った | 満たす |

### ADR 0192 が段階 2 に入れたもの

| 項目(ADR `0192-phase-2-split`) | 確かめたこと | 結果 |
|---|---|---|
| 外部 crate と依存の ADR、protocol の型、両方の corpus の `expected` の往復のテスト(P0、#193) | 依存の ADR `0193-phase-2-dependencies` と、型の ADR `0193-protocol-types` がある。`rust/Cargo.toml` の `[workspace.dependencies]` の外部 crate 7 つ(base64 0.23.1、regex 1.13.1、serde 1.0.229、serde_json 1.0.154、sha2 0.11.1、unicode-normalization 0.1.26、unicode-segmentation 1.13.3)の版と feature は、`0193-phase-2-dependencies` の表と同じで、`rust/Cargo.lock` の版も同じである。表の unicode-width 0.2.3 は、ADR `0218-bun-string-width` が外すと決め、`Cargo.lock` に 0 件である。3 つの crate の依存(`crates/{protocol,screen,transcript}/Cargo.toml`)も表の「使う crate」と同じである。ADR が protocol に置くとした型 `InteractivePrompt`、`InteractivePromptOption`、`PromptAnswer`、`QueuedQuestion`、`UsageReading`、`UsageWindow`、`FleetAgentKind`、`ConversationTurn`、`ConversationPart`、`SkillActivity`、`ConversationMetadata`、`AbandonedTurns`、`ConversationResponse` と、関数 `patch_text`、`patch_files` が `rust/crates/protocol/src/` にある。往復のテスト `rust/crates/protocol/tests/corpus_round_trip.rs` の `screen_corpus_cards_questions_and_answers` と `conversation_corpus_pages_and_unanswered_questions` は、`cargo test --locked --workspace` の中で 2 件とも通った | 満たす |
| 増分の読み取り(T6、#205) | `rust/crates/transcript/tests/warm.rs` の 20 件が通った。このうち `reading_on_answers_as_a_new_value_does_at_every_step_of_the_corpus` は、ファイルを読む 4 つの source の corpus のすべての手順を、1 つの `Transcripts` と、呼び出しごとに新しい `Transcripts` で読み、答えを比べる(ADR の「読み続けた答えが、毎回新しい `Transcripts` で読んだ答えと同じ」)。比べないのは `history_id` と `version` で、その理由はファイルの冒頭のコメントにある | 満たす |
| CI で TypeScript の 2 つの corpus を走らせる(CI0、#194) | `.github/workflows/rust.yml` に job `ts-corpus` があり、`bun test server/screen-fixtures.test.ts server/conversation-fixtures.test.ts` を走らせる。`rust` の最新の run(下の「検査の結果」)で success だった | 満たす |
| S1 と T1 の `#[allow(dead_code)]` の削除(V、#206) | `grep -rn dead_code rust/crates/{protocol,screen,transcript}/` が出すのは `screen/tests/common/mod.rs:9` と `transcript/tests/common/mod.rs:16` の 2 か所だけで、どちらも ADR が「corpus の runner」で残すと決めた `tests/common/mod.rs` の先頭の `#![allow(dead_code)]` である。`src/` には 0 件 | 満たす |
| parity.md の段階 2 の行(V、#206) | 下の「parity.md の段階 2 の行」 | 満たす |
| GLOSSARY(V、#206) | `docs/rust-migration/GLOSSARY.md` に、ADR が挙げた 5 つの語 `ParsedPrompt`、`Answering`、`TranscriptFormat`、`FleetAgentKind`、content id が、どれもある(`grep -c` で 1、1、1、1、2) | 満たす |
| 作るのは `rust` ブランチの中だけ | 段階 2 の PR(#207、#208、#213、#216、#217、#220〜#224、#226〜#229、#231〜#233、#235、#236)と PR #239 は、`gh pr list --state merged` の `baseRefName` がどれも `rust` だった。同じ期間に base が `main` の PR(#209〜#212、#214、#215、#230、#237)は、どれも使う人(atriumnook)のアカウントで出された fleet の機能の PR で、段階 2 の作業ではない | 満たす |

## parity.md の段階 2 の行

parity.md の「段階 2 で埋めた行」は、段階 2 の PR が Rust のテストにした TypeScript の `it` を 12 件と書いている。12 件それぞれの Rust のテストの関数を `grep "fn <名前>"` で探し、12 件ともあった。どのテストも `cargo test --locked --workspace` の中で通った。

| TypeScript のファイル | `it` の数 | parity.md が挙げる Rust のテスト | 見つかった関数 |
|---|---|---|---|
| `shared/patch.test.ts` | 2 | `protocol の crate のテスト`(#193 の PR #208) | `rust/crates/protocol/tests/patch.rs` の `finds_a_patch_given_whole_or_as_the_string_an_exec_script_hands_to_apply_patch`、`names_each_file_a_patch_touches_once_in_order` |
| `server/conversation.test.ts` | 2 | `rust/crates/transcript/tests/concurrent.rs`(#219 の PR #233) | `an_append_seen_by_its_times_before_its_size_keeps_history_and_cursors`、`rewrites_truncation_and_replacement_still_invalidate_cursors` |
| `server/fleet/adapters.test.ts` | 5 | `rust/crates/screen/tests/checks.rs`(#200 の PR #228) | `calls_a_turn_failed_by_its_last_error_line_only_when_no_handoff_follows`、`refuses_an_opencode_that_is_not_version_2_while_starting_not_once_ready`、`is_typed_as_usage_and_read_as_the_included_share_until_the_next_reset_date`、`reads_the_pager_as_cursor_agent_2026_09_23_drew_it_under_ja_jp`、`reads_the_narrow_layout_a_reset_date_in_the_next_year_and_nothing_before_the_pager_shows` |
| `server/opencode-session.test.ts` | 2 | `rust/crates/transcript/src/opencode/tests.rs`(#204 の PR #223) | `what_is_held_stays_bounded_however_long_the_turn_goes`、`a_pasted_images_bytes_are_not_kept_between_polls` |
| `server/prompt.test.ts` | 1 | `rust/crates/screen/tests/pi_omp.rs`(#195 の PR #216) | `rejects_invalid_answer_shapes` |

この 5 つのファイルの表の行は、引き継ぎ先の欄にそれぞれの crate のテストを挙げている(parity.md の 152、162、190、204、220 行目)。`bun scripts/parity.ts` は `225 test files, 225 rows (70 without a successor yet), 0 problems` を出して終了コード 0 で終わった。引き継ぎ先が空欄の 70 行は、ADR `0122-parity-criteria` が段階 7 までに埋めてよいとした。

## 検査の結果

| 検査 | 結果 |
|---|---|
| `cargo fmt --check`(`rust/` で) | 終了コード 0 |
| `cargo clippy --locked --workspace --all-targets -- -D warnings` | 終了コード 0、warning なし |
| `cargo test --locked --workspace` | 終了コード 0。テストの binary 31 個と doc-tests 9 個で、202 件通過、0 件失敗、0 件 ignored |
| `cargo test --locked -p herdr-fleet-screen --test corpus -- --nocapture` | `347 of 347 cases of the slice every passed`、1 件通過、0 件失敗 |
| `cargo test --locked -p herdr-fleet-transcript --test corpus -- --nocapture` | 230 件(claude 41、codex 51、omp 25、opencode 76、pi 37)の `every_conversation_case` を含む 9 件通過、0 件失敗 |
| `bun test ./server/screen-fixtures.test.ts` | 349 件通過、0 件失敗、終了コード 0 |
| `bun test ./server/conversation-fixtures.test.ts` | 233 件通過、0 件失敗、終了コード 0 |
| `bun scripts/parity.ts` | `225 test files, 225 rows (70 without a successor yet), 0 problems`、終了コード 0 |
| `git log --no-merges origin/rust..origin/main` | 0 コミット(main にだけある変更はない) |
| `gh run list --branch rust` | 確かめたコミット `4d0a692` の run は、workflow `rust` の [42536082379](https://github.com/atriumnook/herdr-fleet/actions/runs/42536082379)(`push`)で success。`gh run view 42536082379 --json jobs` で、job `linux` と `ts-corpus` がどちらも success。これが `rust` の最新の run である |

`bun scripts/screen-fixtures.ts` は、引数なしでは使い方を出して終わる、期待値を書き込むための道具である(段階 1 の関門の報告と同じ)。TypeScript の件数は、全件を確かめる `server/screen-fixtures.test.ts` と `server/conversation-fixtures.test.ts` で数えた。

## 段階 2 の範囲の外

- 開いている `rust-migration` の Issue のうち、#176、#189、#190、#240 は、使う人の main での作業を待つ `blocked` の Issue で、段階 2 の範囲の外である。#105 は全体の経過を追う Issue である
- 計画の「一致を確かめる基準」の表の、fleet CLI の契約、HTTP/WS の契約、安全上の判定の表を Rust で通すことは、段階 3 と段階 4 の完了条件で、この関門では確かめていない
