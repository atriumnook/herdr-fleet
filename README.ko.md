# herdr web ui

<p align="center">
  <img src="public/icons/icon-192.png" alt="herdr web ui" width="100">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <strong>한국어</strong>
</p>

<p align="center">
  <a href="https://devswha.github.io/herdr-web-ui/">웹사이트</a> ·
  <a href="#install">설치</a> ·
  <a href="https://devswha.github.io/herdr-web-ui/demo/">데모 체험</a> ·
  <a href="docs/guide.md#quick-start">빠른 시작</a> ·
  <a href="#docs">문서</a>
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

<p align="center"><sub>터미널 pane의 Claude Code를 같은 세션 그대로 채팅으로, 이어서 폰으로 · 실제 화면 녹화 · <a href="https://devswha.github.io/herdr-web-ui/media/herdr-web-ui-film.mp4">▶ 56초 영상</a></sub></p>

**에이전트와 평소 대화하듯. 데스크톱에서도, 폰에서도.**

[herdr](https://github.com/herdrdev/herdr)를 브라우저와 폰에서 쓰는 클라이언트입니다. 이미 돌리고 있는 세션을 열어 에이전트가 무엇을 하는지 읽고, 어디서든 답할 수 있습니다.

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/344a01d6-dd0d-44d3-a531-262257b48f9e"><img src="docs/media/readme/attach.webp" width="100%" alt="폰에서 스크린샷을 첨부해 Claude에게 버그 수정을 부탁하면, 데스크톱에도 같은 메시지가 보입니다."></a>
      <br><b>폰에서 맥락을 보내세요</b>
      <br><sub>스크린샷을 첨부하고, 파일을 언급하고, 에이전트가 일하는 동안 메시지를 대기열에 넣습니다.</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/cf3953f8-df95-4efc-bd2b-df515798f364"><img src="docs/media/readme/open.webp" width="100%" alt="Claude가 차트를 SVG 파일로 만들면, 클릭 한 번으로 파일 뷰어에서 열리고 폰에서는 탭으로 열립니다."></a>
      <br><b>에이전트가 만든 결과물 열기</b>
      <br><sub>채팅에 나온 경로를 누르면 데스크톱과 폰 모두 파일 뷰어로 열립니다.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/c4170cfb-b1dc-492d-8660-1b09dbac31f8"><img src="docs/media/readme/browse.webp" width="100%" alt="폴더 버튼으로 pane의 폴더를 열고 Claude가 쓴 파일을 뷰어로 엽니다. 폰에서는 명령 팔레트로 같은 일을 합니다."></a>
      <br><b>pane의 파일 둘러보기</b>
      <br><sub>pane의 폴더를 탐색하고 어떤 파일이든 미리 보거나 내려받습니다.</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/3a8e40f3-7988-4a28-8729-9f8b9ad64610"><img src="docs/media/readme/ssh.webp" width="100%" alt="Add PC로 SSH를 통해 Linux PC에 연결하고 브리지를 설치하면, 그 PC의 세션이 터미널과 함께 사이드바에 들어옵니다."></a>
      <br><b>모든 PC를 사이드바 하나에</b>
      <br><sub>Linux와 macOS 머신을 SSH로 추가합니다. <a href="docs/remote-pcs.md">원격 PC →</a></sub>
    </td>
  </tr>
</table>

<p align="center"><sub>모든 클립은 데스크톱과 폰을 동시에 녹화한 실제 동작입니다. 누르면 약 20초짜리 전체 영상을 볼 수 있습니다.</sub></p>

- **채팅과 터미널을 pane 하나에** — Claude Code, Codex, omp, omo, gjc와 pi의 대화 기록을 그대로 보여 주고, 클릭 한 번이면 라이브 터미널로 넘어갑니다. [지원 에이전트 →](docs/guide.md#supported-agents)
- **탭 한 번으로 승인** — 승인 요청, 질문, 계획 메뉴가 카드로 뜹니다. 답을 보내기 전에 그 질문이 아직 유효한지 확인합니다.
- **내가 필요할 때 알림** — 모든 pane의 상태를 실시간으로 보여 주고, 에이전트가 입력을 기다리거나 일을 끝내면 앱이 닫혀 있어도 푸시 알림을 보냅니다.
- **폰에 설치해서 쓰기** — 키보드 위에 Esc, Tab, Ctrl, 방향키가 붙은 PWA입니다. Tailscale 주소는 QR 코드로 받아 갑니다. [폰 설정 →](docs/guide.md#on-your-phone)
- **작업 방식은 그대로** — 에이전트는 herdr가 관리하고, 이 앱은 거기에 연결만 합니다. 에이전트를 멈추지 않고 Settings(설정)에서 업데이트합니다. [전체 기능 →](docs/guide.md#features)

---

<a id="install"></a>

## 설치

```bash
curl -fsSL https://devswha.github.io/herdr-web-ui/install.sh | sh
```

Linux(x64, arm64)와 macOS를 지원합니다. herdr 0.9.0 이상, Bun 1.4 이상, Node 18 이상 중 없는 것을 현재 사용자 계정에 설치한 뒤, 앱을 herdr 플러그인으로 설치합니다. 이미 설치된 herdr가 0.9.0보다 오래됐다면 herdr를 직접 업데이트하고 다시 시작한 다음 설치 스크립트를 다시 실행하세요. 기본 수신 주소를 쓰고 Tailscale이 켜져 있으면, HTTPS 설정이 끝났을 때 tailnet 주소와 QR 코드가 나옵니다.

<p align="center">
  <img src="docs/screenshots/install.png" width="720" alt="설치 스크립트 출력: Bun, Node, herdr 플러그인이 설치되고 tailscale serve가 앱을 공개한 뒤 폰용 QR 코드가 나옵니다.">
</p>

필요한 도구가 이미 있다면 플러그인만 설치해도 됩니다.

```bash
herdr plugin install devswha/herdr-web-ui
```

herdr가 실행 중인 상태에서 **[localhost:7317](http://localhost:7317)**을 여세요. pane을 고르거나 **New session**으로 에이전트를 시작합니다. 폰에서 쓰려면 설치 스크립트가 보여 준 QR 코드를 찍고 앱을 홈 화면에 추가하세요. [빠른 시작 →](docs/guide.md#quick-start)

서버는 기본적으로 `127.0.0.1`에서만 받습니다. 다른 기기에서 접속하려면 [폰 설정](docs/guide.md#on-your-phone)과 [접근과 보안](docs/guide.md#access-and-safety)을 보세요.

<a id="docs"></a>

## 문서

[사용자 가이드](docs/guide.md)부터 보세요: [빠른 시작](docs/guide.md#quick-start) · [지원 에이전트](docs/guide.md#supported-agents) · [기능](docs/guide.md#features) · [폰](docs/guide.md#on-your-phone) · [원격 PC](docs/remote-pcs.md) · [접근과 보안](docs/guide.md#access-and-safety) · [설정](docs/guide.md#configuration) · [키보드 단축키](docs/guide.md#keyboard-shortcuts) · [FAQ](docs/guide.md#faq).

더 자세히: [동작 방식](docs/guide.md#how-it-works) · [채팅 기록](docs/chat-mode-audit.md) · [터미널 흐름 제어](docs/terminal-flow-control.md) · [앱 업데이트](docs/app-updates.md) · [변경 기록](CHANGELOG.md).

문서는 영어로 쓰여 있습니다.

<a id="thanks"></a>

## 감사

[herdr](https://github.com/herdrdev/herdr) 위에서 만들었고, [chatmux](https://github.com/devswha/chatmux)에서 영감을 받았으며, [xterm.js](https://xtermjs.org), [React](https://react.dev), [Bun](https://bun.sh), [Lucide](https://lucide.dev)를 사용합니다.

기여해 주신 모든 분께 감사드립니다. 특히 [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha)님께 감사드립니다.

<a id="agent-instructions"></a>

## 에이전트용 안내

누군가의 설치를 돕고 있다면 [INSTALL.md](INSTALL.md)를 따르세요. 저장소를 바꿀 때는 [CONTRIBUTING.md](CONTRIBUTING.md)와 커밋된 [리뷰 규칙](.github/REVIEW.md)을 따르고, 로컬에 `AGENTS.md`가 있으면 그 지침도 따르세요.

<a id="development"></a>

## 개발

```bash
git clone https://github.com/devswha/herdr-web-ui.git
cd herdr-web-ui
bun install

bun run server      # API + WebSocket, :7317
bun run dev         # Vite, :5173 (다른 터미널에서 실행)
```

```bash
bun run typecheck
bun run test:unit   # herdr 없이 실행
bun test           # 격리된 herdr 테스트 세션
bun run test:ui    # 브라우저 회귀 테스트
```

변경을 보내려면 [CONTRIBUTING.md](CONTRIBUTING.md)를, 테스트·미디어·릴리스는 [개발 문서](docs/development.md)를, UI 규칙은 [DESIGN.md](DESIGN.md)를 보세요. 보안 문제는 [SECURITY.md](SECURITY.md)에 따라 비공개로 알려 주세요.

<a id="license"></a>

## 라이선스

[MIT](LICENSE). Copyright © 2026 devswha.
