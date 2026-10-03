# herdr web ui

<p align="center">
  <img src="public/icons/icon-192.png" alt="herdr web ui" width="100">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <strong>日本語</strong> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <a href="https://devswha.github.io/herdr-web-ui/">公式サイト</a> ·
  <a href="#install">インストール</a> ·
  <a href="https://devswha.github.io/herdr-web-ui/demo/">デモを試す</a> ·
  <a href="docs/guide.md#quick-start">クイックスタート</a> ·
  <a href="#docs">ドキュメント</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-666666?labelColor=333333" alt="MIT ライセンス"></a>
  <a href="https://github.com/devswha/herdr-web-ui/stargazers"><img src="https://img.shields.io/github/stars/devswha/herdr-web-ui?labelColor=333333&color=666666&logo=github" alt="GitHub スター数"></a>
  <a href="https://github.com/devswha/herdr-web-ui/releases/latest"><img src="https://img.shields.io/github/v/release/devswha/herdr-web-ui?label=release&labelColor=333333&color=666666" alt="最新リリース"></a>
  <a href="https://github.com/herdrdev/herdr"><img src="https://img.shields.io/badge/herdr-0.9.0%2B-666666?labelColor=333333" alt="herdr 0.9.0+"></a>
  <a href="docs/guide.md#on-your-phone"><img src="https://img.shields.io/badge/PWA-installable-666666?labelColor=333333" alt="インストール可能な PWA"></a>
</p>

---

https://github.com/user-attachments/assets/6162cf5a-b29b-4f14-b2a2-7a01564791d6

<p align="center"><sub>ターミナルのペインで動く Claude Code。同じセッションをチャットで、さらにスマートフォンで操作 · 実際の動作を収録 · <a href="https://devswha.github.io/herdr-web-ui/media/herdr-web-ui-film.mp4">▶ 56 秒の紹介動画</a></sub></p>

**エージェントとのやり取りを、読みやすいチャットで。パソコンでもスマートフォンでも。**

[herdr](https://github.com/herdrdev/herdr) のブラウザ・スマートフォン向けクライアントです。すでに実行中のセッションを開き、エージェントの作業を確認して、どこからでも返答できます。

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/344a01d6-dd0d-44d3-a531-262257b48f9e"><img src="docs/media/readme/attach.webp" width="100%" alt="スマートフォンでスクリーンショットを添付して Claude にバグ修正を頼むと、パソコンにも同じメッセージが表示されます。"></a>
      <br><b>スマートフォンから情報を送る</b>
      <br><sub>スクリーンショットの添付、ファイルのメンション、作業中のメッセージ予約。</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/cf3953f8-df95-4efc-bd2b-df515798f364"><img src="docs/media/readme/open.webp" width="100%" alt="Claude がグラフを SVG ファイルとして書き出し、クリックするとファイルビューアーで開きます。スマートフォンではタップで開きます。"></a>
      <br><b>エージェントが作ったファイルを開く</b>
      <br><sub>チャット内のパスから、パソコンでもスマートフォンでもファイルビューアーで開けます。</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/c4170cfb-b1dc-492d-8660-1b09dbac31f8"><img src="docs/media/readme/browse.webp" width="100%" alt="フォルダーボタンでペインのフォルダーを開き、Claude が書いたファイルをビューアーで表示します。スマートフォンではコマンドパレットから同じ操作ができます。"></a>
      <br><b>ペインのファイルを見る</b>
      <br><sub>ペインのフォルダーをたどり、ファイルをプレビュー・ダウンロード。</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/3a8e40f3-7988-4a28-8729-9f8b9ad64610"><img src="docs/media/readme/ssh.webp" width="100%" alt="「PC を追加」で SSH 経由で Linux PC に接続してブリッジをインストールすると、そのセッションがサイドバーに加わり、ターミナルがその PC で動きます。"></a>
      <br><b>すべての PC を、ひとつのサイドバーに</b>
      <br><sub>SSH で Linux や macOS のマシンを追加。<a href="docs/remote-pcs.md">リモート PC →</a></sub>
    </td>
  </tr>
</table>

<p align="center"><sub>どのクリップも、パソコンとスマートフォンを同時に収録した実際の動作です。クリックすると約 20 秒の動画全体を再生できます。</sub></p>

- **チャットとターミナルを、ひとつのペインで** — Claude Code、Codex、omp、omo、gjc、pi のネイティブな会話履歴を表示し、ワンクリックでライブターミナルに切り替えられます。[対応エージェント →](docs/guide.md#supported-agents)
- **タップで承認** — 承認リクエスト、質問、計画メニューがカードになり、問いかけがまだ有効か確認してから回答を送信します。
- **対応が必要なときに通知** — すべてのペインの状態をリアルタイムに表示し、入力が必要なときや完了したときには、アプリを閉じていてもプッシュ通知が届きます。
- **スマートフォンにインストール** — キーボードの上に Esc、Tab、Ctrl、矢印キーが並ぶ PWA。Tailscale のアドレスは QR コードで表示されます。[スマートフォンの設定 →](docs/guide.md#on-your-phone)
- **話して入力** — チャットやターミナルの入力欄に音声で入力できます。韓国語と英語が混ざっても認識し、送信するまで何も送られません。自分の OpenAI API キー、またはブラウザの音声認識を使います。
- **いつもの作業環境をそのままに** — エージェントは herdr が管理し、このアプリはそこに接続します。エージェントを止めずに Settings（設定）からアップデートできます。[すべての機能 →](docs/guide.md#features)

---

<a id="install"></a>

## インストール

```bash
curl -fsSL https://devswha.github.io/herdr-web-ui/install.sh | sh
```

Linux（x64、arm64）または macOS に対応しています。必要な herdr 0.9.0+、Bun 1.4+、Node 18+ がなければ現在のユーザー向けにインストールし、その後アプリを herdr プラグインとしてインストールします。既存の herdr が 0.9.0 より古い場合は、自分で herdr を更新・再起動してからインストーラーを再実行してください。デフォルトの待ち受けアドレスを使用し、Tailscale が起動している場合、HTTPS の設定に成功すると tailnet 内のアクセス用アドレスと QR コードが表示されます。

<p align="center">
  <img src="docs/screenshots/install.png" width="720" alt="インストーラーの出力：Bun、Node、herdr プラグインのインストール後、tailscale serve でアプリへのアクセスを有効にし、スマートフォン用の QR コードを表示します。">
</p>

必要なソフトウェアがすでにそろっている場合は、プラグインだけをインストールできます。

```bash
herdr plugin install devswha/herdr-web-ui
```

herdr が起動した状態で **[localhost:7317](http://localhost:7317)** を開きます。ペインを選ぶか、**New session（新規セッション）** からエージェントを起動してください。スマートフォンで使う場合は、インストーラーの QR コードを読み取り、アプリをホーム画面に追加します。[クイックスタート →](docs/guide.md#quick-start)

サーバーのデフォルトの待ち受けアドレスは `127.0.0.1` です。別のデバイスからアクセスする場合は、[スマートフォンの設定](docs/guide.md#on-your-phone)と[アクセスと安全性](docs/guide.md#access-and-safety)を参照してください。

<a id="docs"></a>

## ドキュメント

まずは[ユーザーガイド](docs/guide.md)をご覧ください：[クイックスタート](docs/guide.md#quick-start) · [対応エージェント](docs/guide.md#supported-agents) · [機能](docs/guide.md#features) · [スマートフォン](docs/guide.md#on-your-phone) · [リモート PC](docs/remote-pcs.md) · [アクセスと安全性](docs/guide.md#access-and-safety) · [設定](docs/guide.md#configuration) · [キーボードショートカット](docs/guide.md#keyboard-shortcuts) · [よくある質問](docs/guide.md#faq)。

さらに詳しく：[仕組み](docs/guide.md#how-it-works) · [チャットの会話履歴](docs/chat-mode-audit.md) · [ターミナルのフロー制御](docs/terminal-flow-control.md) · [アプリのアップデート](docs/app-updates.md) · [変更履歴](CHANGELOG.md)。

<a id="thanks"></a>

## 謝辞

[herdr](https://github.com/herdrdev/herdr) を基盤とし、[chatmux](https://github.com/devswha/chatmux) から着想を得て、[xterm.js](https://xtermjs.org)、[React](https://react.dev)、[Bun](https://bun.sh)、[Lucide](https://lucide.dev) を使用しています。

[@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha) をはじめ、貢献してくださったすべての方に感謝します。

<a id="agent-instructions"></a>

## エージェント向けの手順

アプリのインストールを支援する場合は、[INSTALL.md](INSTALL.md) に従ってください。リポジトリを変更する場合は、[CONTRIBUTING.md](CONTRIBUTING.md) とリポジトリ内の[レビュールール](.github/REVIEW.md)に従い、ローカルの `AGENTS.md` があればその指示にも従ってください。

<a id="development"></a>

## 開発

```bash
git clone https://github.com/devswha/herdr-web-ui.git
cd herdr-web-ui
bun install

bun run server      # API + WebSocket on :7317
bun run dev         # Vite on :5173; run in a second terminal
```

```bash
bun run typecheck
bun run test:unit   # no herdr needed
bun test           # isolated herdr test session
bun run test:ui    # browser regression checks
```

変更の送り方は [CONTRIBUTING.md](CONTRIBUTING.md)、テスト、メディア素材、リリースについては[開発ドキュメント](docs/development.md)、UI の規約については [DESIGN.md](DESIGN.md) を参照してください。セキュリティの問題は [SECURITY.md](SECURITY.md) の手順で非公開で報告してください。

<a id="license"></a>

## ライセンス

[MIT](LICENSE)。Copyright © 2026 devswha.
