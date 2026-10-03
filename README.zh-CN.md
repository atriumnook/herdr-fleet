# herdr web ui

<p align="center">
  <img src="public/icons/icon-192.png" alt="herdr web ui" width="100">
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <a href="https://devswha.github.io/herdr-web-ui/">官网</a> ·
  <a href="#install">安装</a> ·
  <a href="https://devswha.github.io/herdr-web-ui/demo/">体验演示</a> ·
  <a href="docs/guide.md#quick-start">快速入门</a> ·
  <a href="#docs">文档</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-666666?labelColor=333333" alt="MIT 许可证"></a>
  <a href="https://github.com/devswha/herdr-web-ui/stargazers"><img src="https://img.shields.io/github/stars/devswha/herdr-web-ui?labelColor=333333&color=666666&logo=github" alt="GitHub 星标数"></a>
  <a href="https://github.com/devswha/herdr-web-ui/releases/latest"><img src="https://img.shields.io/github/v/release/devswha/herdr-web-ui?label=release&labelColor=333333&color=666666" alt="最新版本"></a>
  <a href="https://github.com/herdrdev/herdr"><img src="https://img.shields.io/badge/herdr-0.9.0%2B-666666?labelColor=333333" alt="herdr 0.9.0+"></a>
  <a href="docs/guide.md#on-your-phone"><img src="https://img.shields.io/badge/PWA-installable-666666?labelColor=333333" alt="可安装的 PWA"></a>
</p>

---

https://github.com/user-attachments/assets/6162cf5a-b29b-4f14-b2a2-7a01564791d6

<p align="center"><sub>在终端窗格中运行 Claude Code，同一会话切换为聊天，再到手机上继续 · 实机录制 · <a href="https://devswha.github.io/herdr-web-ui/media/herdr-web-ui-film.mp4">▶ 56 秒演示影片</a></sub></p>

**在电脑和手机上，随时与智能体对话。**

[herdr](https://github.com/herdrdev/herdr) 的浏览器与手机客户端。打开已经运行的会话，查看智能体正在做什么，无论身在何处都能回复。

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/344a01d6-dd0d-44d3-a531-262257b48f9e"><img src="docs/media/readme/attach.webp" width="100%" alt="手机附加一张截图并让 Claude 修复错误，电脑上显示同一条消息。"></a>
      <br><b>从手机发送上下文</b>
      <br><sub>附加截图、引用文件，在智能体工作时排队发送消息。</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/cf3953f8-df95-4efc-bd2b-df515798f364"><img src="docs/media/readme/open.webp" width="100%" alt="Claude 将图表写成 SVG 文件，点击即可在文件查看器中打开，手机上轻点也一样。"></a>
      <br><b>打开智能体生成的文件</b>
      <br><sub>点击聊天中的路径即可在文件查看器中打开，电脑和手机都可以。</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/c4170cfb-b1dc-492d-8660-1b09dbac31f8"><img src="docs/media/readme/browse.webp" width="100%" alt="文件夹按钮打开窗格的文件夹，Claude 写入的文件在查看器中打开；手机上可通过命令面板完成同样操作。"></a>
      <br><b>浏览窗格的文件</b>
      <br><sub>浏览窗格所在文件夹，预览或下载任意文件。</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/3a8e40f3-7988-4a28-8729-9f8b9ad64610"><img src="docs/media/readme/ssh.webp" width="100%" alt="“添加电脑”通过 SSH 连接一台 Linux 电脑并安装 bridge，它的会话加入侧边栏，终端在那台电脑上运行。"></a>
      <br><b>一个侧边栏，管理所有电脑</b>
      <br><sub>通过 SSH 添加 Linux 和 macOS 电脑。<a href="docs/remote-pcs.md">远程电脑 →</a></sub>
    </td>
  </tr>
</table>

<p align="center"><sub>每段片段都是同时录制电脑和手机的真实操作。点击可播放约 20 秒的完整视频。</sub></p>

- **聊天与终端，共用一个窗格** — 阅读 Claude Code、Codex、omp、omo、gjc 和 pi 的原生会话记录，一键切换到实时终端。[支持的智能体 →](docs/guide.md#supported-agents)
- **轻点即可批准** — 审批请求、问题和计划菜单会显示为卡片，发送回答前会先确认提示仍然有效。
- **需要你时及时提醒** — 实时显示每个窗格的状态；智能体需要输入或完成任务时发送推送通知，即使应用已关闭也能收到。
- **安装到手机** — PWA 在键盘上方提供 Esc、Tab、Ctrl 和方向键，Tailscale 地址以二维码显示。[手机设置 →](docs/guide.md#on-your-phone)
- **开口代替打字** — 在聊天或终端输入行中语音输入，韩语和英语混说也能识别；文字只放进输入框，由你决定何时发送。使用你自己的 OpenAI API 密钥，或浏览器自带的语音识别。
- **沿用现有工作流** — 智能体由 herdr 管理，本应用负责连接；在 Settings（设置）中更新应用，无需停止智能体。[全部功能 →](docs/guide.md#features)

---

<a id="install"></a>

## 安装

```bash
curl -fsSL https://devswha.github.io/herdr-web-ui/install.sh | sh
```

支持 Linux（x64、arm64）或 macOS。安装程序会为当前用户补齐 herdr 0.9.0+、Bun 1.4+ 和 Node 18+ 依赖，然后将应用安装为 herdr 插件。如果已安装的 herdr 低于 0.9.0，请先自行更新并重启 herdr，再重新运行安装程序。使用默认监听地址且 Tailscale 正在运行时，HTTPS 配置成功后会提供 tailnet 内的访问地址和二维码。

<p align="center">
  <img src="docs/screenshots/install.png" width="720" alt="安装程序输出：安装 Bun、Node 和 herdr 插件，然后通过 tailscale serve 提供应用访问地址，并显示供手机扫描的二维码。">
</p>

已经安装了所需依赖？只需安装插件：

```bash
herdr plugin install devswha/herdr-web-ui
```

在 herdr 运行时，打开 **[localhost:7317](http://localhost:7317)**。选择一个窗格，或点击 **New session（新建会话）** 启动智能体。要在手机上使用，请扫描安装程序提供的二维码，并将应用添加到主屏幕。[快速入门 →](docs/guide.md#quick-start)

服务器默认监听 `127.0.0.1`。如需从其他设备访问，请参阅[手机设置](docs/guide.md#on-your-phone)和[访问与安全](docs/guide.md#access-and-safety)。

<a id="docs"></a>

## 文档

从[用户指南](docs/guide.md)开始：[快速入门](docs/guide.md#quick-start) · [支持的智能体](docs/guide.md#supported-agents) · [功能](docs/guide.md#features) · [手机](docs/guide.md#on-your-phone) · [远程电脑](docs/remote-pcs.md) · [访问与安全](docs/guide.md#access-and-safety) · [配置](docs/guide.md#configuration) · [键盘快捷键](docs/guide.md#keyboard-shortcuts) · [常见问题](docs/guide.md#faq)。

深入了解：[工作原理](docs/guide.md#how-it-works) · [聊天记录](docs/chat-mode-audit.md) · [终端流量控制](docs/terminal-flow-control.md) · [应用更新](docs/app-updates.md) · [更新日志](CHANGELOG.md)。

## 致谢

本项目基于 [herdr](https://github.com/herdrdev/herdr) 构建，灵感来自 [chatmux](https://github.com/devswha/chatmux)，并使用了 [xterm.js](https://xtermjs.org)、[React](https://react.dev)、[Bun](https://bun.sh) 和 [Lucide](https://lucide.dev)。

感谢所有贡献者，包括 [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha)。

## 智能体操作指南

正在协助他人安装应用？请遵循 [INSTALL.md](INSTALL.md)。修改仓库时，请遵循 [CONTRIBUTING.md](CONTRIBUTING.md) 和仓库中的[审查规则](.github/REVIEW.md)，以及本地 `AGENTS.md` 中的说明（如有）。

## 开发

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

提交改动请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)，测试、媒体素材和发布流程请参阅[开发文档](docs/development.md)，界面规范请参阅 [DESIGN.md](DESIGN.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

[MIT](LICENSE)。Copyright © 2026 devswha.
