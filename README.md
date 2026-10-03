# herdr web ui

<p align="center">
  <img src="public/icons/icon-192.png" alt="herdr web ui" width="100">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <a href="https://devswha.github.io/herdr-web-ui/">website</a> ·
  <a href="#install">install</a> ·
  <a href="https://devswha.github.io/herdr-web-ui/demo/">try the demo</a> ·
  <a href="docs/guide.md#quick-start">quick start</a> ·
  <a href="#docs">docs</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-666666?labelColor=333333" alt="MIT license"></a>
  <a href="https://github.com/devswha/herdr-web-ui/stargazers"><img src="https://img.shields.io/github/stars/devswha/herdr-web-ui?labelColor=333333&color=666666&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/devswha/herdr-web-ui/releases/latest"><img src="https://img.shields.io/github/v/release/devswha/herdr-web-ui?label=release&labelColor=333333&color=666666" alt="Latest release"></a>
  <a href="https://github.com/herdrdev/herdr"><img src="https://img.shields.io/badge/herdr-0.9.0%2B-666666?labelColor=333333" alt="herdr 0.9.0+"></a>
  <a href="docs/guide.md#on-your-phone"><img src="https://img.shields.io/badge/PWA-installable-666666?labelColor=333333" alt="Installable PWA"></a>
</p>

---

https://github.com/user-attachments/assets/6162cf5a-b29b-4f14-b2a2-7a01564791d6

<p align="center"><sub>Claude Code in a terminal pane, the same session as a chat, then on the phone · recorded live · <a href="https://devswha.github.io/herdr-web-ui/media/herdr-web-ui-film.mp4">▶ the 56-second film</a></sub></p>

**Your agents, in plain conversation. On your desktop and your phone.**

A browser and phone client for [herdr](https://github.com/herdrdev/herdr). Open the sessions you already run, read what your agents are doing, and answer them from wherever you are.

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/344a01d6-dd0d-44d3-a531-262257b48f9e"><img src="docs/media/readme/attach.webp" width="100%" alt="The phone attaches a screenshot and asks Claude to fix the bug; the desktop shows the same message."></a>
      <br><b>Send context from your phone</b>
      <br><sub>Attach a screenshot, mention files, queue messages while the agent works.</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/cf3953f8-df95-4efc-bd2b-df515798f364"><img src="docs/media/readme/open.webp" width="100%" alt="Claude writes a chart as an SVG file; a click opens it in the file viewer, and a tap on the phone does too."></a>
      <br><b>Open what the agent made</b>
      <br><sub>A path in the chat opens in the file viewer, on the desktop and the phone.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/c4170cfb-b1dc-492d-8660-1b09dbac31f8"><img src="docs/media/readme/browse.webp" width="100%" alt="The folder button opens the pane's folder and the file Claude wrote opens in the viewer; the phone does the same from the command palette."></a>
      <br><b>Browse a pane's files</b>
      <br><sub>Walk the pane's folder and preview or download any file.</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/3a8e40f3-7988-4a28-8729-9f8b9ad64610"><img src="docs/media/readme/ssh.webp" width="100%" alt="Add PC connects to a Linux PC over SSH, installs the bridge, and its session joins the sidebar with a terminal running on that PC."></a>
      <br><b>Every PC in one sidebar</b>
      <br><sub>Add Linux and macOS machines over SSH. <a href="docs/remote-pcs.md">Remote PCs →</a></sub>
    </td>
  </tr>
</table>

<p align="center"><sub>Each clip is a live recording of the desktop and a phone at once. Click one for the full ~20-second video.</sub></p>

- **Chat and terminal, one pane** — native Claude Code, Codex, omp, omo, gjc and pi transcripts, with the live terminal a click away. [Supported agents →](docs/guide.md#supported-agents)
- **Approve with a tap** — approvals, questions and plan menus become cards, checked to be current before your answer is sent.
- **Know when you're needed** — live status for every pane and push alerts when an agent needs input or finishes, even with the app closed.
- **Install it on your phone** — a PWA with Esc, Tab, Ctrl and arrows above the keyboard, and a QR code to your Tailscale address. [Phone setup →](docs/guide.md#on-your-phone)
- **Speak instead of typing** — dictate into the chat or the terminal line, Korean and English mixed. Nothing goes out until you send it; it uses your own OpenAI key or the browser's speech recognition.
- **Keep your workflow** — herdr owns the agents; this app connects to them. Update from Settings without stopping them. [All features →](docs/guide.md#features)

---

## install

```bash
curl -fsSL https://devswha.github.io/herdr-web-ui/install.sh | sh
```

Linux (x64, arm64) or macOS. Installs missing herdr 0.9.0+, Bun 1.4+ and Node 18+ prerequisites for your user, then installs the app as a herdr plugin. If an existing herdr installation is older than 0.9.0, update and restart herdr yourself before rerunning the installer. With the default listen address and Tailscale running, successful HTTPS setup provides a tailnet address and QR code.

Windows x64, in PowerShell:

```powershell
irm https://devswha.github.io/herdr-web-ui/install.ps1 | iex
```

Requires [Git for Windows](https://git-scm.com/download/win). Installs missing herdr and Bun for your user, then installs the same plugin. No Node or WSL is needed. Open **Phone setup** in herdr for phone access. Windows terminals use the [screen mirror](docs/remote-pcs.md#windows-pcs), with typing and a fixed grid, until herdr supports terminal attach there.

<p align="center">
  <img src="docs/screenshots/install.png" width="720" alt="Installer output: Bun, Node and the herdr plugin install, then tailscale serve publishes the app and a QR code for the phone appears.">
</p>

Already have the prerequisites? Install just the plugin:

```bash
herdr plugin install devswha/herdr-web-ui
```

With herdr running, open **[localhost:7317](http://localhost:7317)**. Pick a pane or start an agent with **New session**. To use your phone, scan the installer's QR code and add the app to your home screen. [Quick start →](docs/guide.md#quick-start)

The server listens on `127.0.0.1` by default. For access from another device, see [phone setup](docs/guide.md#on-your-phone) and [access and safety](docs/guide.md#access-and-safety).

## docs

Start with the [user guide](docs/guide.md): [quick start](docs/guide.md#quick-start) · [supported agents](docs/guide.md#supported-agents) · [features](docs/guide.md#features) · [phone](docs/guide.md#on-your-phone) · [remote PCs](docs/remote-pcs.md) · [access and safety](docs/guide.md#access-and-safety) · [configuration](docs/guide.md#configuration) · [keyboard shortcuts](docs/guide.md#keyboard-shortcuts) · [FAQ](docs/guide.md#faq).

For a closer look: [how it works](docs/guide.md#how-it-works) · [chat transcripts](docs/chat-mode-audit.md) · [terminal flow control](docs/terminal-flow-control.md) · [app updates](docs/app-updates.md) · [changelog](CHANGELOG.md).

## thanks

Built on [herdr](https://github.com/herdrdev/herdr), with inspiration from [chatmux](https://github.com/devswha/chatmux), and powered by [xterm.js](https://xtermjs.org), [React](https://react.dev), [Bun](https://bun.sh) and [Lucide](https://lucide.dev).

Thanks to everyone who has contributed, including [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha).

## agent instructions

Helping someone install the app? Follow [INSTALL.md](INSTALL.md). For repository changes, follow [CONTRIBUTING.md](CONTRIBUTING.md) and the committed [review rules](.github/REVIEW.md), plus the local `AGENTS.md` instructions when present.

## development

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

See [CONTRIBUTING.md](CONTRIBUTING.md) to send a change, [development](docs/development.md) for tests, media and releases, and [DESIGN.md](DESIGN.md) for UI conventions. Report security problems privately: [SECURITY.md](SECURITY.md).

## license

[MIT](LICENSE). Copyright © 2026 devswha.
