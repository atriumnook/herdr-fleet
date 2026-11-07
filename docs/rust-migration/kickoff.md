# Rust への置き換えの開始

## 開始の前に(人が行う)

1. fleet の自律モード(`feat/fleet-autonomous` の PR)を main にマージし、`~/git/herdr-fleet` を main の最新にして、稼働中のサーバーを起動し直す。自律モードのない fleet では、coordinator が thread の終わりを知らされず、作業が最初の thread で止まる
2. `rust` ブランチを GitHub に push する
3. GitHub の設定
   - main を守る ruleset: PR を必須にし、マージできるのを使う人だけにする。force push と削除を止める
   - Issue とコメントを書ける人を collaborators だけにする(公開する場合。interaction limits)
   - ラベルを作る: `rust-migration`、`tracking`、`blocked`、`in-progress`、`phase:0`〜`phase:7`
   - マージした PR のブランチを自動で消す(Automatically delete head branches)
   - Actions を有効にする。非公開のままなら、支払いの上限(spending limit)を 0 のままにする
4. 使う CLI(claude、codex など)にサインインし、使用量に余裕があることを確かめる
5. `rust` をチェックアウトした独立した clone `~/git/herdr-fleet-rs` を用意し、最新であることを確かめる。linked worktree(`git worktree add` で作ったもの)は使わない。herdr は linked worktree から thread の worktree を作らない(`linked_worktree_source`)ので、fleet の thread が始まらない

## 最初の指示

ターミナルで次を実行するか(`fleet` が PATH にない場合は、稼働中の fleet の `bin/fleet.ts` を bun で実行する)、Fleet 画面でこのフォルダーのプロジェクトの会話に、下の本文を送る。

```bash
bun ~/git/herdr-fleet/bin/fleet.ts project --cwd ~/git/herdr-fleet-rs --task "$(sed -n '/^<!-- prompt -->$/,/^<!-- \/prompt -->$/p' ~/git/herdr-fleet-rs/docs/rust-migration/kickoff.md | sed '1d;$d')"
```

<!-- prompt -->
herdr-fleet を Rust に置き換える作業を、docs/rust-migration/plan.md の段階 0 から段階 7 まで、最後まで進めてください。私はこの指示のあと戻りません。途中で私に質問しても答えは来ないので、判断は計画・ADR・決まりに従って自分たちで行ってください。

- 守ることは .herdr-fleet/standing.md と CLAUDE.md の「rust ブランチ」の節に、あなたの進め方は .herdr-fleet/agents/coordinator.md に書いてあります。この指示より、それらが優先します
- 最初に、ラベル rust-migration と tracking の tracking issue がなければ作り、計画へのリンクと今の段階を書いてください。次に、Issue と thread の今の状態を読み、まだ Issue に分けていない段階があれば、その段階を Issue に分ける thread を始めてください。分けてあれば、続きの作業を始めてください
- 元のアプリ(main と、稼働中の fleet)には一切触れないでください。あなたたちは、その稼働中の fleet の上で動いています。止めると作業がすべて止まります
- 進められない作業は blocked の Issue にして止め、依存しない作業を続けてください。すべてが blocked になったら、tracking issue に一覧を書いて止まってください
- 終わりは、rust から main への PR が開き、報告が tracking issue に書かれた状態です。PR のマージと稼働中のサーバーの入れ替えは私が行います
<!-- /prompt -->

## 途中で様子を見るとき

- 経過: tracking issue と、ラベル `rust-migration` の Issue
- 止まっている作業: ラベル `blocked` の Issue
- 動いている thread: Fleet 画面の、`~/git/herdr-fleet-rs` のプロジェクト
- 途中で指示を足すときは、そのプロジェクトの会話に書く。coordinator は、fleet からでない発言を使う人の指示として扱う
