# parity.md の行に、実物の CLI を起動する検査 `scripts/*-live-check.ts` をすべて入れる

- 状態: 採用
- 決めた日: 2026-11-08
- Issue: #169
- 置き換える: 0122-parity-criteria(「parity.md」の「行にするファイル」のうち、手で走らせる検査の glob だけ。ほかの決定は `0122-parity-criteria` のまま)

## 状況

Issue #169 で、`main` にだけあった TypeScript の変更を `rust` に取り込んだ。その中に、手で走らせる検査の新しい script `scripts/agy-live-check.ts` がある。fleet の `HerdrRuntime` でテスト用の herdr セッションに実物の `agy` を起動し、fleet と同じ読み取りで画面を判定する検査で、モデルは呼ばない(script の冒頭のコメント)。agy の adapter が頼る振る舞い(信頼の確認画面が出ないこと、auto mode、入力欄の判定、モデルの指定、利用者の `settings.json` を変えないこと)を、agy が自分自身を更新したあとに確かめる。

`0122-parity-criteria` の「parity.md」は、手で走らせる検査として `scripts/opencode-live-check.ts` と `scripts/pty-compare.ts` の 2 つだけを名前で挙げている。`scripts/parity.ts` の glob も同じ 2 つの名前で、`scripts/agy-live-check.ts` は行にならない。行にしないと、段階 7 の完了条件「parity.md の全行に引き継ぎ先がある」がこの検査を問わず、Rust 版の agy の adapter を実物で確かめる手段がないまま切り替えに進みうる。

`scripts/opencode-live-check.ts` と `scripts/agy-live-check.ts` には、共通点が 3 つある: 実物の CLI を起動して fleet の設定や判定を確かめる、モデルを呼ばない、unit の検査に入っていない。確かめることと隔離の範囲は違う。`scripts/opencode-live-check.ts` は、HOME と XDG_* を空のフォルダーに向けて `opencode serve` を起動し、script が模擬のモデルとしてツール呼び出しを渡して、権限の規則、fleet-guard、あとに残ったものを確かめる。`scripts/agy-live-check.ts` は、サインインに要るので利用者の HOME のままで agy を起動し、プロンプトは送らずに、起動の画面、agy のログ、利用者の `settings.json` が変わらないことを確かめる(それぞれの script の冒頭のコメント)。

ADR の README は、前の決定を変えるときは新しい ADR を書き、前の ADR は書き換えないと決めている。

## 決定

- 行にするファイルの glob のうち、手で走らせる検査の `scripts/opencode-live-check.ts` を `scripts/*-live-check.ts` に替える。`scripts/pty-compare.ts` はそのまま名前で残す。ほかの glob は `0122-parity-criteria` のまま
- `scripts/parity.ts` の `GLOBS` と、parity.md の「行にするファイル」を同じように直す
- `scripts/agy-live-check.ts` の行の引き継ぎ先は空欄にする。`scripts/opencode-live-check.ts` の行も空欄で、Rust 版の adapter を実物の CLI でどう確かめるかは、adapter を Rust で作る段階 3(計画の「段階 3: herdr と fleet」)の Issue が決める
- 同じく取り込んだ `scripts/factory-report.test.ts` は、もとの glob `*.test.ts` に当たるので行にし、引き継ぎ先は空欄にする。`scripts/factory-report.ts` は、fleet の出来事の記録(`server/fleet/events.ts` が書く `fleet-events.jsonl`)と GitHub を読んで、プロジェクトの指標(人が手を出した回数、止まっていた時間、起動の失敗など)を Markdown の報告にする script で、出来事の記録を書く orchestrator を Rust で作る段階 3 の Issue が引き継ぎ先を決める。段階 1 では空欄にしてよい(`0122-parity-criteria`)

## 検討した代わり

- `scripts/agy-live-check.ts` を名前で glob に足す: 今の 2 つは行になるが、次に CLI ごとの検査を足すたびに、glob と ADR を直す必要がある。`*-live-check.ts` という名前の決まりで集めれば、足した検査は `bun scripts/parity.ts` が欠けた行として見つける
- 行にせず、parity.md の「除いたファイル」に理由を書く: 除いたファイルは、合否の基準がないか、同じことをほかの行が確かめるもの(`scripts/benchmark-codex-transcript.ts`)である。`scripts/agy-live-check.ts` は合否を終了コードで返し、同じことを確かめる行はない。除くと、Rust 版の agy の adapter を実物で確かめる検査がないまま、切り替えに進みうる

## 依存

なし

## 結果

- `scripts/` に `-live-check.ts` で終わる名前の script を足すと、`bun scripts/parity.ts` がその行の欠けを報告する。手で走らせる検査は、この名前で足す
- parity.md の行は 220 になる(取り込みで足した `scripts/factory-report.test.ts` と `scripts/agy-live-check.ts` の 2 行)
- 取り込んだ `server/fleet/adapters.test.ts` の 3 件の `it` は、どの corpus の件の `about` にも名前が出ないので、parity.md の「一部だけが移ったファイル」の残った部分に足した(33 件から 36 件)。`scripts/parity.ts` は残った部分の内訳を調べないので、件数と名前は `it` の一覧と手で突き合わせた

## 確かめたこと

- `origin/main` を取り込んだあとの thread のブランチで、glob を直す前の `bun scripts/parity.ts` は `missing row: scripts/factory-report.test.ts` と `219 test files, 218 rows (65 without a successor yet), 1 problems` を出し、終了コード 1 で終わった。`scripts/agy-live-check.ts` は欠けた行に挙がらなかった
- glob を直し、2 行を足したあとの `bun scripts/parity.ts` は `220 test files, 220 rows (67 without a successor yet), 0 problems` を出し、終了コード 0 で終わった
- PC は Linux(7.2.15-1-omarchy)、bun 1.4.4
