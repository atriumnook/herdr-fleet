# TypeScript のテストの引き継ぎ先

TypeScript 版のテストのファイルごとに、そのテストが Rust 版でどの検査に引き継がれるか(引き継ぎ先)を書く。計画(`docs/rust-migration/plan.md`)の「一致を確かめる基準」が、この一覧を置くと決めている。引き継ぎ先のない行が残っている間は、切り替えの準備ができていない(計画の段階 7 の完了条件「parity.md の全行に引き継ぎ先がある」)。行にするファイルと引き継ぎ先の値は、ADR `0122-parity-criteria` の「parity.md」に従う(手で走らせる検査の glob だけは ADR `0169-parity-live-checks`)。

- 作った日: 2026-11-08(Issue #134。段階 1 のほかの Issue #123〜#133 がマージされたあとの `rust`)
- 一覧とファイルの突き合わせ: `bun scripts/parity.ts`。下の「一覧」の行と、下の「行にするファイル」の glob が `git ls-files` から選んだファイルを比べ、欠けた行、余った行、2 回出た行、決まった値でない引き継ぎ先を挙げて、終了コード 1 で終わる
- `scripts/parity.ts` は unit の検査(`bun scripts/ci-tests.ts unit`)に入れていない。入れると、テストのファイルを足す PR がすべてこのファイルを書き換えることになり、並行する thread の PR が同じ行の近くで衝突する。段階の関門の thread が走らせ、足りない行を足す

## 行にするファイル

`git ls-files` のうち、次の glob に当たるファイルを 1 ファイル 1 行で並べる。

- `*.test.ts` と `*.test.tsx`(どのフォルダーでも)
- `scripts/*-regression.ts`、`scripts/*-qa.ts`(ブラウザーで画面を確かめる回帰検査)
- `e2e/*.ts`
- 手で走らせる検査の `scripts/*-live-check.ts`(実物の CLI を起動して確かめる検査。今は `scripts/agy-live-check.ts` と `scripts/opencode-live-check.ts`)と `scripts/pty-compare.ts`。`scripts/*-live-check.ts` の glob は ADR `0169-parity-live-checks` で広げた

### 除いたファイル

| ファイル | 除いた理由 |
|---|---|
| `scripts/benchmark-codex-transcript.ts` | 計測の script。Codex の transcript を読み直す時間を、全体を読む場合と差分だけを読む場合で測り、JSON で出す。時間に合否の基準はない。2 つの読み方の結果が一致することも `assert` で確かめるが、同じことを `server/conversation.test.ts` の `it`(incrementally reads one growing Codex task across split UTF-8, partial records and a rewrite)が確かめる。その `it` は行にあり、会話ログの corpus にも移った(`fixtures/conversations/codex/growing-task`) |

テストの runner と道具(`scripts/screen-fixtures.ts`、`scripts/conversation-fixtures.ts`、`scripts/fleet-cli-fixtures.ts`、`scripts/security-fixtures/*.ts`、`scripts/contract/*.ts` のうちテストでないもの、`scripts/test-herdr.ts`、`scripts/ci-tests.ts`)は glob に当たらないので行にしない。これらを試すテストのファイルは行にある。

## 引き継ぎ先の欄

「引き継ぎ先」に書ける値は次の 4 種類と空欄だけで、`scripts/parity.ts` がほかの値を拒む。1 つのファイルの部分ごとに引き継ぎ先が違うときは、値を「、」で並べる。`なし: <理由>` はセルの最後に置く(理由の中の「、」を、値の区切りと読まないため)。セルの中の `|` は `\|` と書く。

| 値 | 意味 |
|---|---|
| 基準の名前: `画面の corpus`、`会話ログの corpus`、`fleet CLI の契約`、`HTTP/WS の契約`、`安全上の判定の表`、`UI の回帰` | 計画の「一致を確かめる基準」の表の基準。Rust 版も同じ基準を通す |
| `<crate> の crate のテスト` | ADR `0107-crate-split` の crate(`rust/crates/` のフォルダーの名前)のテスト。例: `transcript の crate のテスト` |
| `そのまま残す` | TypeScript のテストを、切り替えのあとも同じファイルのまま走らせる |
| `なし: <理由>` | 引き継ぎ先を持たない。理由を書く |
| 空欄 | まだ決まっていない。段階 7 までに埋める(ADR `0122-parity-criteria`) |

「残った部分」は、1 つのファイルの一部だけが引き継ぎ先に移ったときに、移らずに残ったものを書く。残ったものは 2 種類ある: 名前がどの `about` にも出ない `it` と、`about` に名前は出るが、その `about` が「一部の assert は元のテストに残る」と書いた `it` である。後者は「`it` の一部」と数える。そのファイルの、移った `it` と残ったものは、下の「一部だけが移ったファイル」に並べる。残ったものの引き継ぎ先は、段階 1 ではまだ決まっていない。

### 段階 1 で埋めた行

段階 1 では、次の行を埋めた。ほかの行は空欄で、引き継ぎ先は段階 2〜7 の Issue が決める。

- `src/` の Web UI のテスト: `そのまま残す`。Rust の core は Web UI を変えずに配信する(ADR `0122-parity-criteria`)
- `server/fleet/opencode-guard.test.ts`: `そのまま残す`。fleet-guard(`opencode/fleet-guard/guard.js`)は OpenCode が読み込む JavaScript のプラグインで、Rust 版も同じフォルダーを同梱する(ADR `0122-parity-criteria` の「安全上の判定の表」)
- `scripts/contract/` のテスト: `そのまま残す`。HTTP/WS の契約の launcher と import の検査を試すテストで、launcher は Rust の core にも同じものを使う(ADR `0122-parity-criteria` の「基準は 3 つの形で作る」)。段階 1 のあとで足した `scripts/contract/test-shell.herdr.test.ts` も `そのまま残す` にした。契約のテストが使うテスト用の herdr(`scripts/test-herdr.ts`)のペインが、使う人の zsh の設定を読まないことを確かめるテストで、Rust の core に当てるときも同じテスト用の herdr を使う(Issue #179)
- `*.contract.test.ts`: `HTTP/WS の契約`。どのファイルも先頭に `// black-box: scripts/contract/launch.ts` の印があり、`bun scripts/contract/check-imports.ts` が、印のないものと、決まった範囲の外を import するものを拒む
- 基準の runner を TypeScript 版に当てるテスト: `server/screen-fixtures.test.ts` は `画面の corpus`、`server/conversation-fixtures.test.ts` は `会話ログの corpus`、`bin/fleet-cli-fixtures.test.ts` は `fleet CLI の契約`、`scripts/security-fixtures/*.test.ts` は `安全上の判定の表`
- `scripts/ui-regression.ts` と、それが import する回帰検査: `UI の回帰`。計画の「UI の回帰」は `bun run test:ui` で、`test:ui` はビルドのあとに `scripts/ui-regression.ts` を走らせる(`package.json`)。`ui-regression.ts` が import しない回帰検査と `*-qa.ts` は、`test:ui` に入っていないので空欄にした
- corpus の件の `about` に名前の出たテストのファイル: その corpus の基準。`fixtures/screens/` と `fixtures/conversations/` の `case.json`、`fixtures/fleet-cli/*.json`、`fixtures/security/` の表の `about` の各行が「`<ファイル>: <it の名前>`」と書いた `it` を、移った `it` とした(1 つの `about` が、行を分けて、または「; 」でつないで、いくつかの `it` を挙げることがある)。`about` の名前と `it` の名前は、次のどれかで当たったとする
  - `about` の名前が `it` の名前を含む(`about` は `describe` の名前を前に付けることがある)
  - `about` の名前から、末尾の括弧書きと、最後の ` > ` までの `describe` の名前を除いた 20 文字以上の部分を、`it` の名前が含む(`about` が `it` の名前を短く書いた場合)
  - 名前に `${…}` を含む `it`(値ごとに `it` を作るもの)は、`${…}` を任意の文字列として当てる
- 移った `it` のうち、`about` が「元のテストに残る」部分を書いたもの(「stays in the test」「left to the test」「left out」「which a case cannot」など)は、`about` を 1 件ずつ読んで「一部だけが移ったファイル」に残った部分として書いた。「(the Claude half)」のように 1 つの `it` を source ごとの件に分けたものは、どの部分も corpus にあるので、残った部分にしない
- `server/files.test.ts` の 1 件(never runs a command the repository's own config names (core.fsmonitor)): `HTTP/WS の契約`。ADR `0122-parity-criteria` が、同じ件を black-box にして `server/device-access.contract.test.ts` に足すと決め、Issue #125(PR #142)で足した

画面の corpus は段階 1 より前の #103 で作った。そのとき corpus の件にした `it` は、`server/prompt.test.ts`(106 件、コミット `5442691`)と `server/fleet/adapters.test.ts`(17 件、コミット `e486a83`)から消した。ほかの corpus と表に移した `it` は、元のファイルにも残している(ADR `0122-parity-criteria` の「既存の TypeScript のテストは消さない」)。

## 一覧

| ファイル | 引き継ぎ先 | 残った部分 |
|---|---|---|
| `bin/fleet-cli-fixtures.test.ts` | fleet CLI の契約 | |
| `bin/fleet.test.ts` | fleet CLI の契約 | |
| `e2e/fleet-live.ts` | | |
| `scripts/agy-live-check.ts` | | |
| `scripts/android-ime-regression.ts` | | |
| `scripts/chat-browser-qa.ts` | | |
| `scripts/chat-conversation-regression.ts` | UI の回帰 | |
| `scripts/chat-history-browser-qa.ts` | | |
| `scripts/chat-prompt-regression.ts` | UI の回帰 | |
| `scripts/chat-queue-regression.ts` | UI の回帰 | |
| `scripts/chat-size-regression.ts` | UI の回帰 | |
| `scripts/composer-attachment-regression.ts` | UI の回帰 | |
| `scripts/composer-completion-regression.ts` | UI の回帰 | |
| `scripts/composer-reconnect-regression.ts` | UI の回帰 | |
| `scripts/composer-send-regression.ts` | UI の回帰 | |
| `scripts/contract/check-imports.test.ts` | そのまま残す | |
| `scripts/contract/launch.herdr.test.ts` | そのまま残す | |
| `scripts/contract/launch.test.ts` | そのまま残す | |
| `scripts/contract/test-shell.herdr.test.ts` | そのまま残す | |
| `scripts/conversation-fixtures.test.ts` | | |
| `scripts/default-view-regression.ts` | UI の回帰 | |
| `scripts/devices-regression.ts` | UI の回帰 | |
| `scripts/directory-browser-regression.ts` | UI の回帰 | |
| `scripts/droplet-regression.ts` | UI の回帰 | |
| `scripts/file-viewer-regression.ts` | | |
| `scripts/fleet-screen-regression.ts` | UI の回帰 | |
| `scripts/generate-protocol-types.test.ts` | | |
| `scripts/mobile-viewport-regression.ts` | UI の回帰 | |
| `scripts/needs-input-regression.ts` | UI の回帰 | |
| `scripts/notification-startup-regression.ts` | UI の回帰 | |
| `scripts/opencode-live-check.ts` | | |
| `scripts/output-browser-qa.ts` | | |
| `scripts/pi-image-browser-qa.ts` | | |
| `scripts/project-groups-regression.ts` | | |
| `scripts/prompt-rail-regression.ts` | UI の回帰 | |
| `scripts/pty-compare.ts` | | |
| `scripts/push-settings-regression.ts` | UI の回帰 | |
| `scripts/screen-fixtures.test.ts` | | |
| `scripts/secret-input-regression.ts` | UI の回帰 | |
| `scripts/security-fixtures/child-process.test.ts` | 安全上の判定の表 | |
| `scripts/security-fixtures/core.test.ts` | 安全上の判定の表 | |
| `scripts/security-fixtures/orchestrator.test.ts` | 安全上の判定の表 | |
| `scripts/side-panel-regression.ts` | UI の回帰 | |
| `scripts/skill-activity-browser-qa.ts` | | |
| `scripts/terminal-cjk-punctuation-regression.ts` | | |
| `scripts/terminal-cjk-width-regression.ts` | UI の回帰 | |
| `scripts/terminal-colors-links-regression.ts` | | |
| `scripts/terminal-command-backspace-regression.ts` | UI の回帰 | |
| `scripts/terminal-copy-regression.ts` | UI の回帰 | |
| `scripts/terminal-dispose-browser-qa.ts` | | |
| `scripts/terminal-draft-regression.ts` | UI の回帰 | |
| `scripts/terminal-file-input-regression.ts` | UI の回帰 | |
| `scripts/terminal-file-links-regression.ts` | | |
| `scripts/terminal-font-regression.ts` | UI の回帰 | |
| `scripts/terminal-input-regression.ts` | UI の回帰 | |
| `scripts/terminal-reclaim-regression.ts` | | |
| `scripts/terminal-session-regression.ts` | UI の回帰 | |
| `scripts/ui-regression.ts` | UI の回帰 | |
| `scripts/wake-lock-regression.ts` | UI の回帰 | |
| `server/access.test.ts` | 安全上の判定の表 | |
| `server/agent-name.test.ts` | | |
| `server/api.contract.test.ts` | HTTP/WS の契約 | |
| `server/api.herdr.test.ts` | | |
| `server/attach-held.contract.test.ts` | HTTP/WS の契約 | |
| `server/attach-output.test.ts` | | |
| `server/chat-history.test.ts` | 会話ログの corpus | |
| `server/claude-session.contract.test.ts` | HTTP/WS の契約 | |
| `server/claude-store.test.ts` | | |
| `server/claude-turn-boundaries.test.ts` | 会話ログの corpus | |
| `server/codex-binding.contract.test.ts` | HTTP/WS の契約 | |
| `server/codex-images.test.ts` | 会話ログの corpus | 1 件の `it` の一部(下の「一部だけが移ったファイル」) |
| `server/codex-processes.test.ts` | | |
| `server/codex.contract.test.ts` | HTTP/WS の契約 | |
| `server/codex.test.ts` | 会話ログの corpus | 33 件の `it`、5 件の `it` の一部(下の「一部だけが移ったファイル」) |
| `server/collector.test.ts` | | |
| `server/commands.test.ts` | | |
| `server/completion.test.ts` | | |
| `server/conversation-fixtures.test.ts` | 会話ログの corpus | |
| `server/conversation-metadata.test.ts` | 会話ログの corpus | 1 件の `it` の一部(下の「一部だけが移ったファイル」) |
| `server/conversation.test.ts` | 会話ログの corpus | 5 件の `it`、4 件の `it` の一部(下の「一部だけが移ったファイル」) |
| `server/device-access.contract.test.ts` | HTTP/WS の契約 | |
| `server/device-access.herdr.test.ts` | | |
| `server/devices.test.ts` | | |
| `server/directories.test.ts` | | |
| `server/explain-route.test.ts` | | |
| `server/explain.test.ts` | 安全上の判定の表 | 20 件の `it`(下の「一部だけが移ったファイル」) |
| `server/file-view.test.ts` | 安全上の判定の表 | 8 件の `it`(下の「一部だけが移ったファイル」) |
| `server/files.test.ts` | HTTP/WS の契約 | 5 件の `it`(下の「一部だけが移ったファイル」) |
| `server/fleet/adapters.test.ts` | 画面の corpus、安全上の判定の表 | 36 件の `it`(下の「一部だけが移ったファイル」) |
| `server/fleet/agents.test.ts` | | |
| `server/fleet/api.test.ts` | | |
| `server/fleet/brief.test.ts` | | |
| `server/fleet/config.test.ts` | | |
| `server/fleet/entrances.test.ts` | | |
| `server/fleet/metrics.test.ts` | | |
| `server/fleet/models.test.ts` | 安全上の判定の表 | 22 件の `it`(下の「一部だけが移ったファイル」) |
| `server/fleet/opencode-guard.test.ts` | そのまま残す | |
| `server/fleet/orchestrator.test.ts` | | |
| `server/fleet/plan.test.ts` | | |
| `server/fleet/runtime.herdr.test.ts` | | |
| `server/fleet/settings.test.ts` | | |
| `server/fleet/thread.test.ts` | | |
| `server/fleet/usage.test.ts` | 安全上の判定の表 | 24 件の `it`、1 件の `it` の一部(下の「一部だけが移ったファイル」) |
| `server/herdr-marker.test.ts` | | |
| `server/herdr/client.test.ts` | | |
| `server/machines-refresh.test.ts` | | |
| `server/machines.test.ts` | 安全上の判定の表 | 6 件の `it`(下の「一部だけが移ったファイル」) |
| `server/mirror-input.test.ts` | | |
| `server/mirror.test.ts` | | |
| `server/omp.contract.test.ts` | HTTP/WS の契約 | |
| `server/opencode-cli.test.ts` | | |
| `server/opencode-conversation.test.ts` | 会話ログの corpus | 3 件の `it`(下の「一部だけが移ったファイル」) |
| `server/opencode-messages.test.ts` | 会話ログの corpus | 1 件の `it` の一部(下の「一部だけが移ったファイル」) |
| `server/opencode-session.test.ts` | 会話ログの corpus | 3 件の `it`、2 件の `it` の一部(下の「一部だけが移ったファイル」) |
| `server/output-window.test.ts` | | |
| `server/output.contract.test.ts` | HTTP/WS の契約 | |
| `server/output.herdr.test.ts` | | |
| `server/pane-grid.contract.test.ts` | HTTP/WS の契約 | |
| `server/pane-grid.test.ts` | | |
| `server/pi-models.test.ts` | | |
| `server/pi-tree.test.ts` | 会話ログの corpus | 3 件の `it`、5 件の `it` の一部(下の「一部だけが移ったファイル」) |
| `server/pi.contract.test.ts` | HTTP/WS の契約 | |
| `server/pi.test.ts` | 会話ログの corpus | 7 件の `it`、1 件の `it` の一部(下の「一部だけが移ったファイル」) |
| `server/ping.contract.test.ts` | HTTP/WS の契約 | |
| `server/process-start.test.ts` | | |
| `server/projects.test.ts` | | |
| `server/prompt.contract.test.ts` | HTTP/WS の契約 | |
| `server/prompt.test.ts` | 画面の corpus | 40 件の `it`(下の「一部だけが移ったファイル」) |
| `server/pty/session.test.ts` | | |
| `server/push.test.ts` | 安全上の判定の表 | 28 件の `it`(下の「一部だけが移ったファイル」) |
| `server/reattach.contract.test.ts` | HTTP/WS の契約 | |
| `server/screen-fixtures.test.ts` | 画面の corpus | |
| `server/secret.contract.test.ts` | HTTP/WS の契約 | |
| `server/secret.herdr.test.ts` | | |
| `server/side-chat-context.test.ts` | | |
| `server/side-chat.test.ts` | | |
| `server/side-terminal.test.ts` | | |
| `server/skill-activity.test.ts` | 会話ログの corpus | 1 件の `it`、4 件の `it` の一部(下の「一部だけが移ったファイル」) |
| `server/submit.contract.test.ts` | HTTP/WS の契約 | |
| `server/submit.herdr.test.ts` | | |
| `server/tailscale.test.ts` | | |
| `server/tool-output.test.ts` | | |
| `shared/fleet.test.ts` | | |
| `shared/patch.test.ts` | | |
| `shared/plan.test.ts` | | |
| `shared/secret-prompt.test.ts` | | |
| `src/components/ChatView.test.ts` | そのまま残す | |
| `src/components/Composer.test.ts` | そのまま残す | |
| `src/components/DevicesPanel.test.ts` | そのまま残す | |
| `src/components/DirectoryBrowser.test.ts` | そのまま残す | |
| `src/components/Droplet.test.ts` | そのまま残す | |
| `src/components/FileViewer.test.ts` | そのまま残す | |
| `src/components/KeyBar.test.ts` | そのまま残す | |
| `src/components/MachineSidebar.test.ts` | そのまま残す | |
| `src/components/Markdown.test.ts` | そのまま残す | |
| `src/components/NewSessionDialog.test.ts` | そのまま残す | |
| `src/components/QueuedMessages.test.ts` | そのまま残す | |
| `src/components/Segmented.test.ts` | そのまま残す | |
| `src/components/SettingsDialog.test.ts` | そのまま残す | |
| `src/components/Sidebar.test.ts` | そのまま残す | |
| `src/components/fleet/FleetScreen.test.ts` | そのまま残す | |
| `src/lib/authLink.test.ts` | そのまま残す | |
| `src/lib/checklist.test.ts` | そのまま残す | |
| `src/lib/compose.test.ts` | そのまま残す | |
| `src/lib/composerDraft.test.ts` | そのまま残す | |
| `src/lib/conversationFetch.test.ts` | そのまま残す | |
| `src/lib/diff.test.ts` | そのまま残す | |
| `src/lib/draft.test.ts` | そのまま残す | |
| `src/lib/droplet.test.ts` | そのまま残す | |
| `src/lib/edgeSwipe.test.ts` | そのまま残す | |
| `src/lib/filePaths.test.ts` | そのまま残す | |
| `src/lib/fontFamily.test.ts` | そのまま残す | |
| `src/lib/formatBytes.test.ts` | そのまま残す | |
| `src/lib/goals.test.ts` | そのまま残す | |
| `src/lib/i18n.test.ts` | そのまま残す | |
| `src/lib/install.test.ts` | そのまま残す | |
| `src/lib/keyboard.test.ts` | そのまま残す | |
| `src/lib/keys.test.ts` | そのまま残す | |
| `src/lib/longPress.test.ts` | そのまま残す | |
| `src/lib/markdown.test.ts` | そのまま残す | |
| `src/lib/mentions.test.ts` | そのまま残す | |
| `src/lib/messageQueue.test.ts` | そのまま残す | |
| `src/lib/needsInput.test.ts` | そのまま残す | |
| `src/lib/notificationTarget.test.ts` | そのまま残す | |
| `src/lib/notifications.test.ts` | そのまま残す | |
| `src/lib/osc52.test.ts` | そのまま残す | |
| `src/lib/paletteSearch.test.ts` | そのまま残す | |
| `src/lib/paneName.test.ts` | そのまま残す | |
| `src/lib/phone.test.ts` | そのまま残す | |
| `src/lib/plainQuestion.test.ts` | そのまま残す | |
| `src/lib/projectGroups.test.ts` | そのまま残す | |
| `src/lib/promptAnswer.test.ts` | そのまま残す | |
| `src/lib/promptRail.test.ts` | そのまま残す | |
| `src/lib/push.test.ts` | そのまま残す | |
| `src/lib/settings.test.ts` | そのまま残す | |
| `src/lib/shortcuts.test.ts` | そのまま残す | |
| `src/lib/snapshot.test.ts` | そのまま残す | |
| `src/lib/snapshotRequests.test.ts` | そのまま残す | |
| `src/lib/sshOutput.test.ts` | そのまま残す | |
| `src/lib/status.test.ts` | そのまま残す | |
| `src/lib/terminalBoxGlyphs.test.ts` | そのまま残す | |
| `src/lib/terminalDispose.test.ts` | そのまま残す | |
| `src/lib/terminalDraft.test.ts` | そのまま残す | |
| `src/lib/terminalFileLinks.test.ts` | そのまま残す | |
| `src/lib/terminalGlyphs.test.ts` | そのまま残す | |
| `src/lib/terminalWidths.test.ts` | そのまま残す | |
| `src/lib/todos.test.ts` | そのまま残す | |
| `src/lib/transcript.test.ts` | そのまま残す | |
| `src/lib/turnRevision.test.ts` | そのまま残す | |
| `src/lib/wakeLock.test.ts` | そのまま残す | |
| `src/lib/workBlocks.test.ts` | そのまま残す | |
| `src/lib/ws.test.ts` | そのまま残す | |
| `src/motion.test.ts` | そのまま残す | |
| `src/pwa-notification.test.ts` | そのまま残す | |
| `src/pwa.test.ts` | そのまま残す | |
| `src/ui/diff.test.ts` | そのまま残す | |
| `src/ui/fleetView.test.ts` | そのまま残す | |
| `src/ui/mediator.test.ts` | そのまま残す | |
| `src/ui/presenter.test.ts` | そのまま残す | |
| `src/ui/sidePanelView.test.ts` | そのまま残す | |
| `src/ui/state.test.ts` | そのまま残す | |

## 一部だけが移ったファイル

ファイルごとに、移った `it` の数と、残ったもの(一部の assert が元のテストに残る `it` と、残った `it`)の名前を並べる。名前は、テストのファイルに書かれたとおり(`${…}` を含む)。ただし、Markdown の表示で消えないように、`<` は `&lt;`、`|` は `\|` と書いた。

### `server/codex-images.test.ts`

移った部分:

- 会話ログの corpus: 4 件の `it`

移った `it` のうち、一部の assert が元のテストにだけ残るもの(1 件。残った assert の引き継ぎ先は未定):

- fetches only referenced raster images within the retained history and bounds local reads: ローカルの画像の大きさの上限 8 MiB(件に 8 MiB を超えるファイルを置かない)。根拠: `fixtures/conversations/codex/image` の `about`

### `server/codex.test.ts`

移った部分:

- 会話ログの corpus: 28 件の `it`

移った `it` のうち、一部の assert が元のテストにだけ残るもの(5 件。残った assert の引き継ぎ先は未定):

- reads a paginated rollout through the history it continues, without the turns a backtrack discarded: 小さいバイト数の予算での読み取り(`codexHistoryTail`、画面との照合に使う)。根拠: `fixtures/conversations/codex/chain-backtrack` の `about`
- shows less history, never the wrong one, when no rollout holds a cut, and finds it once one does: 欠けた連なりの期限が切れたあと(`forgetHistoryChains`、時計)に、現れた rollout を見つける部分。根拠: `fixtures/conversations/codex/chain-missing-cut` の `about`
- bounds tool output and history and tolerates malformed or partially written records: `parseCodexTranscript` の 100 ターンの上限(`maxTurns`)。根拠: `fixtures/conversations/codex/malformed-and-bounds` の `about`
- bounds citation parsing with many unmatched backtick lengths: 解析にかかる時間の上限(1 秒未満)。根拠: `fixtures/conversations/codex/memory-backtick-runs` の `about`
- scans a rollout once however many ask at the same time: 2 つの読み手が同時に読んでも、追記を 1 回だけ読むこと。根拠: `fixtures/conversations/codex/questions-appended-ask` の `about`

残った部分(33 件。引き継ぎ先は未定):

- reads CODEX_HOME from the process's environment, and nothing from one without it
- takes the last assignment, keeps spaces in it, and ends it at the next variable
- reads the thread a TUI was resumed on from its command line
- accepts files inside the store and rejects traversal, external symlinks, missing files and directories
- reads the Windows paths Codex stores with the \\?\ prefix as the plain ones herdr reports (#518)
- requires a unique substantial rendered assistant match and handles terminal wrapping
- matches an answer that links a file, which Codex shows as the label and a path relative to the cwd
- reads a session whose answers are all short by its newest answers shown together, in order
- does not read short answers that two rollouts share, or ones above the welcome card
- does not take a fork's inherited answers for its parent
- does not count the links of one answer as several answers, wherever they point
- keeps a unique long-answer match when another rollout shares its short answers
- needs 64 letters and digits together, 16 in each answer and 12 distinct
- does not read short answers another rollout said inside longer ones
- does not take a fork for its parent however many turns ago it inherited the answers
- takes no answer with a link for evidence: the screen shows its target its own way
- reads no short answers that another rollout's linked answers show as
- reads no short answers when a rollout was not read whole, the one that shows them included
- does not read short answers when two rollouts show that way, sharing nothing
- reads short answers in bounded time however many unclosed links the answers hold
- reads short answers in bounded time however many links a large answer has
- does not bind using user context, tool output or a previous session above the welcome card
- matches a complete first prompt and one answer, including whitespace wrapping
- matches a short greeting only when the complete exchange is unique
- requires exact prompt punctuation and the full answer
- rejects composers, indented quotes, later turns and a missing welcome card
- keeps older later exchanges and longer answers as competing evidence
- does not admit pre-start timestamps or missing prompt metadata (control)
- matches tiny first answers only with the exact submitted exchange (regression)
- matches the first short reply before Codex's completed-turn footer
- does not discard answer text or an unrecognized completion footer
- preserves a literal footer-shaped final paragraph without native chrome
- skips known Codex notices before the submitted prompt (regression)

### `server/conversation-metadata.test.ts`

移った部分:

- 会話ログの corpus: 12 件の `it`

移った `it` のうち、一部の assert が元のテストにだけ残るもの(1 件。残った assert の引き継ぎ先は未定):

- tolerates absent metadata, unexpected types and a torn append without losing valid settings: scrollback を読む部分(transcript を読まない)。根拠: `fixtures/conversations/codex/metadata-malformed` の `about`

### `server/conversation.test.ts`

移った部分:

- 会話ログの corpus: 45 件の `it`

移った `it` のうち、一部の assert が元のテストにだけ残るもの(4 件。残った assert の引き継ぎ先は未定):

- refuses a cursor once the rollouts before the live file change, instead of pointing at other turns: 欠けた連なりの期限が切れたあと(`forgetHistoryChains`、時計)に rollout が現れる部分。根拠: `fixtures/conversations/codex/chain-missing-cut-pages` の `about`
- expands inherited Codex tool output without exposing output discarded by a backtrack: 読めなくなった rollout の場所にフォルダーを置く部分(件はファイルを消す)。根拠: `fixtures/conversations/codex/inherited-tool-output` の `about`
- trims a huge tool result and caps the turn list: `parseOmpTranscript` のターンの数の上限(`maxTurns`。ページは使わない)。根拠: `fixtures/conversations/omp/huge-tool-result` の `about`
- incrementally reads one growing Codex task across split UTF-8, partial records and a rewrite: 疑似乱数の長さで切って追記する部分(件は 7 つの決まった位置で切る)。根拠: `fixtures/conversations/codex/growing-task` の `about`

残った部分(5 件。引き継ぎ先は未定):

- strips escapes in time linear in a malformed answer's length
- accepts the path herdr reports only inside the user's own store
- accepts a Windows PC's native path, and refuses the same ways out
- reads one window for the newest page even when no turn starts in it; an older page reaches the turn's start
- preserves literal paste lookalikes, partial wrappers and mismatched ids

### `server/explain.test.ts`

移った部分:

- 安全上の判定の表: 2 件の `it`

残った部分(20 件。引き継ぎ先は未定):

- holds the person's last three prompts, the agent's text before the question and its tool calls since
- reads the narration for a question screen that came up mid-turn
- stays within the cap, keeps every choice and says the quotes are data
- counts the cap on the text as sent, escapes included, for input full of newlines
- is checked before anything runs
- uses no tool, no MCP server, no personal setting and keeps no session
- runs a fake claude in the server's own work folder, emptied first, with the prompt on stdin
- uses only a real folder: a link in its place is refused
- does not ask Claude while its account is at its limit
- asks the account again once its turn comes: the limit may have been reached while it waited
- reports a refused call, so a rate limit can put Claude in cooldown
- reports an exit with nothing on stdout, with what stderr said
- runs one call at a time: the next waits for the one before to end
- lets two calls wait at most, and refuses one more as busy
- stops waiting when the request is closed, and frees its place in the line
- answers the same prompt from the call under way, then from the kept answer, until it is old
- gives up on the answer when the request is closed, while the call goes on and its answer is kept
- sends SIGTERM when the time runs out, then SIGKILL to the whole process group of a CLI that ignores it
- says when claude is not found
- reports a call that ran out of time

### `server/file-view.test.ts`

移った部分:

- 安全上の判定の表: 3 件の `it`

残った部分(8 件。引き継ぎ先は未定):

- resolves absolute, ~ and pane-relative paths
- tells media, text and binary apart, and is null for a folder or nothing
- refuses parent traversal outside the Claude scratch fallback folder
- resolves an in-folder Claude scratch fallback link
- refuses absolute paths and symlink escapes from the scratch fallback
- finds a bare name deeper in the pane's folder, and lists several of that name
- opens files under a root and refuses the rest, a symlink out or a sibling with the same prefix included
- lets a file open from the temp folder and the fleet's results without a pane, and from the pane's folder with one

### `server/files.test.ts`

移った部分:

- HTTP/WS の契約: 1 件の `it`

残った部分(5 件。引き継ぎ先は未定):

- walks a non-git tree, skips heavy directories, and ranks matches
- uses tracked and untracked non-ignored files in a git repository
- clamps the result limit to one through one hundred
- preserves Unicode and newline filenames returned by git
- honors git ignores from a nested working directory

### `server/fleet/adapters.test.ts`

移った部分:

- 画面の corpus: 17 件の `it`(コミット `e486a83` で corpus の件にし、このファイルから消した)
- 安全上の判定の表: 1 件の `it`

残った部分(36 件。引き継ぎ先は未定。`takes the model and effort, with instructions in the first prompt, and every run's results folder (a reviewer reads its lead's)` のすぐあとの 3 件は、Issue #169 で main から取り込んだ `it`。この `it` の名前は、Issue #187 で取り込んだ main のコミット `dd8beb8` が変えた):

- launches with the model at its thinking level, the role's tools, a fleet name and the instruction file
- keeps a :level the model already carries
- calls a turn failed by its last Error: line only when no HANDOFF follows
- appends the instruction file, names the session and lets the agent write its result folder
- takes a :level suffix as the effort, and has no level below low
- takes edit, write and codemode away from a role that edits no file
- passes the instructions as developer_instructions on one argv line, and the level as reasoning effort
- tells codex to ask for a fleet command outside its sandbox when the sandbox keeps it from the fleet server
- runs the lowest level as low, the lowest effort codex's models take
- escapes what a TOML basic string cannot hold raw
- is given the folder of all result folders, so it asks to trust one folder once rather than one per run
- has no instruction option or level: the instructions lead the first prompt
- is typed as /usage and read as the included share, until the next reset date
- reads the pager as cursor-agent 2026.09.23 drew it under ja_JP
- reads the narrow layout, a reset date in the next year, and nothing before the pager shows
- takes the model and effort, with instructions in the first prompt, and every run's results folder (a reviewer reads its lead's)
- leaves the level to a model id that names one, as agy drops such a model given --effort as well
- trusts the run's own folder and runs in auto mode in the sandbox, for the session only
- refuses a force push and a push that deletes a remote branch, and lets an ordinary push through
- starts the TUI standalone and takes everything else in its config: no model flag, no thinking level, instructions in the first prompt
- never writes an ask, and never allows everything
- is the default agent, with its rules and the guard plugin of this pane alone
- reads, searches and runs the short list of read-only commands and the fleet command
- refuses what it does not list, the web, a subagent, and a .env file
- refuses a second command, a substitution or a redirect that comes with a listed one
- lets git history through only in the form that runs no helper and writes no file
- edits only its result file: that path, and its folder as an external directory
- merges only when it is the project's coordinator, and only the forms the fleet asks for
- keeps the defaults, and the person's own denies
- refuses a push that overwrites the remote, in the forms git takes it
- edits inside its work folder and its result folder, and nowhere else
- tells a role that edits nothing what its shell allows, and the coordinator what a merge is
- refuses an opencode that is not version 2 while starting, not once ready: it has no ready check (fixtures/screens: its help)
- leaves a model its list lacks to the TUI: the list holds what the catalog knows, but not every text the TUI accepts
- splits a :level suffix off a model for the CLIs that take the level apart
- knows only the kinds it has an adapter for

### `server/fleet/models.test.ts`

移った部分:

- 安全上の判定の表: 2 件の `it`

残った部分(22 件。引き継ぎ先は未定):

- reads agy's tab-separated lines and skips its progress line
- reads cursor's `id - name` lines, and drops the zero-width characters its names carry
- reads pi's table as provider/model
- reads opencode's GET /api/model as provider/model, and leaves out what is not one
- reads one page of codex's model/list and where the next begins
- asks a CLI once and keeps the answer for minutes
- answers a failed ask with the reason, and asks again once the minute is over
- refuses a model a complete list lacks, after asking again once
- refuses nothing when the list is not complete, when there is no model, or when the CLI cannot be asked
- accepts a listed id and the same model without its effort, and nothing else
- accepts a listed id with or without its variant, and nothing else
- is not asked again for a minute, then is
- holds a spawn up for no longer than the wait, then lets the model through
- is asked anew by a fresh lookup, not answered by an older one still under way
- reads every page, skipping what is not an answer
- agy lists in its own emptied folder, without an API key or herdr session, and with its self-update held off
- opencode lists from the running service by `opencode api`, asking again once for a place the service has not loaded, in its own emptied folder
- opencode with no service running gives no list and starts nothing: `api` is never run
- opencode 1.x, which does not know `service`, fails the same way before anything else is run
- opencode's reply is bounded in size and in time
- codex app-server runs in its own emptied folder, with CODEX_HOME and no API key or herdr session
- refuses a link in place of the folder

### `server/fleet/usage.test.ts`

移った部分:

- 安全上の判定の表: 3 件の `it`

移った `it` のうち、一部の assert が元のテストにだけ残るもの(1 件。残った assert の引き継ぎ先は未定):

- agy runs in its own emptied folder, without an API key or herdr session, and with its self-update held off: `AGY_CLI_DISABLE_AUTO_UPDATE` を足して自己更新を止める部分(表は `childEnv` の環境だけを比べる)。根拠: `fixtures/security/child-process/childEnv.json` の `about`

残った部分(24 件。引き継ぎ先は未定):

- splits agy by model group, and pi and opencode by provider; the other CLIs are one account each
- reads codex app-server's primary and secondary windows (codex-cli 0.157.0)
- reads agy's /usage buckets per model group as used shares (agy 1.2.16)
- reads Claude Code's /usage: the shared windows, not a per-model one, with their reset in the named zone
- takes a reset with no year as the next one, keeps a window whose reset it cannot read, and reads nothing from an API-key session
- asks claude for /usage without keeping a session or loading the person's settings, and fails on an error answer
- refuses a link in place of the folder, and leaves what it points at alone
- is null for other failures and undefined for a rate limit that names no time
- takes an ISO time, a relative one or the next clock time
- refuses a candidate whose window is at the threshold until that window resets
- counts a window read without its reset time for a day only
- cools an account down on a rate limit, for the time named, else a full window's reset, else the default
- clears one account's cooldown, a CLI's or all
- asks a probe once per TTL, keeps the last reading when it fails, and survives a restart
- refreshes by itself the CLIs that have a probe (codex, claude, agy) once their last try is old, and never cursor
- never runs two probes of one CLI at once, however many refreshes ask
- backs off a CLI that keeps failing (not installed, not signed in), up to hourly, until it answers or a person presses refresh
- keeps a spawn's own probe at the plain TTL however often the CLI failed
- is built with probes for codex, claude and agy only: never cursor
- has cursor's screen read only when neither its last reading nor its last try is recent
- gives up on a probe that never answers, so spawns go on
- replaces what it knew of a CLI with what the probe answers, clearing an earlier failure but not a cooldown
- drops what a stored file holds in a shape it cannot read
- still notes a cooldown when its file cannot be written

### `server/machines.test.ts`

移った部分:

- 安全上の判定の表: 1 件の `it`

残った部分(6 件。引き継ぎ先は未定):

- separates equal pane IDs while preserving historical local storage
- lists this PC only, and offers no setup, proxy or management routes
- follows herdr's own word when it gives one, and the platform otherwise
- mirrors a PC whose bridge cannot run the PTY sidecar, whatever herdr declares
- counts the sidecar as runnable only with both node and node-pty
- takes a node for Node only when it answers in time and is not Bun

### `server/opencode-conversation.test.ts`

移った部分:

- 会話ログの corpus: 2 件の `it`

残った部分(3 件。引き継ぎ先は未定):

- a pane herdr reports no session for is read from its scrollback
- the label is read from the pane's agent session when the pane has none of its own
- with no service running it is read from its scrollback, and the output and image are none

### `server/opencode-messages.test.ts`

移った部分:

- 会話ログの corpus: 34 件の `it`

移った `it` のうち、一部の assert が元のテストにだけ残るもの(1 件。残った assert の引き継ぎ先は未定):

- an ended step is not: 空の一覧の `stillWriting`。根拠: `fixtures/conversations/opencode/still-writing-ended` の `about`

### `server/opencode-session.test.ts`

移った部分:

- 会話ログの corpus: 37 件の `it`

移った `it` のうち、一部の assert が元のテストにだけ残るもの(2 件。残った assert の引き継ぎ先は未定):

- a cursor the service refuses means the history changed; any other failure stays one: JSON でない応答の失敗(記録した応答では書けない)。根拠: `fixtures/conversations/opencode/cursor-refused` の `about`
- is null when the model list cannot be read: モデルの一覧が普通の Error を投げる場合(件では 500 の応答にした)。根拠: `fixtures/conversations/opencode/context-window-unreadable` の `about`

残った部分(3 件。引き継ぎ先は未定):

- what is held stays bounded however long the turn goes
- a pasted image's bytes are not kept between polls
- two panels asking for one page share one read

### `server/pi-tree.test.ts`

移った部分:

- 会話ログの corpus: 26 件の `it`

移った `it` のうち、一部の assert が元のテストにだけ残るもの(5 件。残った assert の引き継ぎ先は未定):

- shows only the branch the leaf stands on after /tree: バイトの範囲の数(`piBranchSegments`)。根拠: `fixtures/conversations/pi/tree-abandoned-branch` の `about`
- moves the conversation when a /tree branch is appended, and invalidates the page: 追記のあとに、最初のページの null の cursor を渡す部分(件の cursor は文字列だけ)。根拠: `fixtures/conversations/pi/tree-branch-appended` の `about`
- tells two /tree moves apart when their branches share every range but the last: 2 回目の移動のあとに null の cursor を渡す部分(件の cursor は文字列だけ)。根拠: `fixtures/conversations/pi/tree-two-moves` の `about`
- starts over when the file is rewritten or cut, so a stale tree cannot be read: 索引の entry の数。根拠: `fixtures/conversations/pi/tree-rewritten` の `about`
- reads a straight line as the whole file: バイトの範囲(`piBranchSegments`)。根拠: `fixtures/conversations/pi/tree-straight-line` の `about`

残った部分(3 件。引き継ぎ先は未定):

- indexes an append without rereading what it already scanned
- says nothing rather than guess at a tree it cannot walk
- indexes the entries around a record longer than several read chunks

### `server/pi.test.ts`

移った部分:

- 会話ログの corpus: 11 件の `it`

移った `it` のうち、一部の assert が元のテストにだけ残るもの(1 件。残った assert の引き継ぎ先は未定):

- starts a fresh history when /new or /resume moves the pane to another file: 2 つ目のファイルに、最初のページの null の cursor を渡す部分(件の cursor は文字列だけ)。根拠: `fixtures/conversations/pi/new-session-file` の `about`

残った部分(7 件。引き継ぎ先は未定):

- accepts a session file inside the store
- refuses paths that leave the store
- refuses a link out of the store, a directory and a file that is not jsonl
- names a session pi has not written yet only when its path is in the store
- resolves the directories around an unwritten session before trusting its place
- follows PI_CODING_AGENT_SESSION_DIR the way Codex follows CODEX_HOME
- looks under the agent directory PI_CODING_AGENT_DIR names, where pi keeps its sessions

### `server/prompt.test.ts`

移った部分:

- 画面の corpus: 106 件の `it`(コミット `5442691` で corpus の件にし、このファイルから消した)

残った部分(40 件。引き継ぎ先は未定):

- rejects invalid answer shapes
- reads the options without the preview box and offers no typed answer
- answers from the native cursor, and keeps its id when only the cursor moves
- offers a numbered menu at the screen's end as options answered by their number
- answers without it once its read is late, rather than waiting on herdr
- is not read while Claude works
- moves to the row and confirms it while the menu stays the card's
- moves to a previewed option and confirms it while the box is redrawn for it
- waits out a screen caught half drawn after a move
- presses no Enter into a menu that took the place of the card's under its moves
- presses no Enter on a row an arrow key typed in the terminal moved the cursor to
- types a custom answer only into the question it was written for
- answers pi's dialog once its cursor is on the row, and no other dialog in its place
- presses no Enter once the asking ended under its moves, though the same menu shows again
- a read by another device while the answer redraws the menu ends no asking
- starts nothing that cannot be undone for a request that was given up
- types omp's custom answer into the row its Enter opens
- answers pi's text dialog
- ticks a multiple choice row by row
- after its first key that is not a move, an answer sends the rest of its keys unseen
- leaves Codex's queue alone while the question just answered is still on the screen
- Codex back at work says nothing about a question in its queue
- sends nothing for a request given up before its turn, even to the row the cursor is on
- answers Claude's second option after redrawing its background-agent footer
- a screen read that comes back after the wait authorises no key
- a lookup that herdr never answers is cut off with the wait
- answers pi's text dialog on a herdr whose screen reads take 400 ms
- goes on ticking a multiple choice whose descriptions a narrowed pane wraps
- answers a question of Codex's collapsed queue, and opens no queue for a request given up
- a key herdr may have pressed, its reply lost, has ended the asking
- a key that never reached herdr has ended nothing
- a read held up before its screen read ends the asking its empty screen shows
- a read that began under an answer and comes back after it changes nothing
- an asking is kept however many panes ask
- a prompt keeps its id from read to read while it waits
- refuses an answer to a prompt that went away and was asked again
- refuses a second answer to the id of a prompt already answered, the same one asked again
- refuses an answer to a prompt asked again after the agent went back to work unseen
- logs prompt answer requests with pane_id, prompt_matched and outcome
- regression: takes no typed answer where the card offers none, its Submit row out of view

### `server/push.test.ts`

移った部分:

- 安全上の判定の表: 3 件の `it`

残った部分(28 件。引き継ぎ先は未定):

- refuses to subscribe a loopback endpoint through the API by default
- keeps one owner-only VAPID key pair across restarts
- refuses a malformed key file instead of rotating the key under every device
- keeps subscriptions across restarts
- delivers the real finish after a late unknown snapshot arrives during a new Codex turn
- delivers one done alert per Codex finish while an agent handoff keeps working
- sends a status alert the device can decrypt, signed with the server's key
- keeps equal pane IDs, titles, status baselines and push links separated by PC
- measures the first change after a restart against the seeded baseline
- does not let a later snapshot overwrite a status an event already reported
- names the pane by its current title, falling back to the seeded one
- tells the device a pane's terminal ended, under its last known title
- forgets a device its push service reports gone
- keeps a device through a failure that is not a goodbye
- calls off a derived Codex finish when it is seen or a new turn begins
- calls off a question answered before it goes out, and sends one left waiting
- tells a finish only after a turn that worked a while, and not one followed by the next prompt
- follows what the device chose: no questions, every finish, or no finish at all
- keeps a device's choice through a re-registration without one, and a restart
- cancels the remaining delay group after an earlier device already received its finish
- settles only after a delivery already under way, when a later group is called off
- persists device ownership and refuses revoked and legacy subscriptions after restart
- keeps a pending alert across re-registration but drops it after device revocation
- delivers nothing to a subscription without an owner (from the removed open-LAN mode)
- calls off the waiting alert of a pane that closed while events were lost
- takes a clean pane's snapshot status as its baseline and announces nothing
- calls off an alert still waiting for a pane that is at rest by the snapshot
- leaves a pane with a newer event, and done versus idle, as they are

### `server/skill-activity.test.ts`

移った部分:

- 会話ログの corpus: 11 件の `it`

移った `it` のうち、一部の assert が元のテストにだけ残るもの(4 件。残った assert の引き継ぎ先は未定):

- Codex literal read calls update immutable snapshots on success/failure and ignore shell lookalikes: コマンドの文字列に `codexReadCall` を直接当てる部分。根拠: `fixtures/conversations/codex/skill-literal-read` の `about`
- Codex native completed read events work through code-mode wrappers, deduplicate and survive incremental snapshots: item に `codexReadSkills` を直接当てる部分。根拠: `fixtures/conversations/codex/skill-native-read` の `about`
- Codex selected instructions become assistant skill evidence, not a user bubble or exposed prompt: 文字列に `selectedSkill` を直接当てる部分。根拠: `fixtures/conversations/codex/skill-selected-instructions` の `about`
- the legacy &lt;skill> form, and text that only looks like an invocation, as pi reads them: `skillInvocationPrompt` だけを呼ぶ部分。根拠: `fixtures/conversations/omp/skill-lookalike` の `about`

残った部分(1 件。引き継ぎ先は未定):

- a standalone .md skill (pi --skill review.md) is a skill too
