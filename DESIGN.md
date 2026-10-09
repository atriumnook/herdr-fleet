# herdr web ui Design System

Extracted from the shipped client (`src/styles.css`, `src/components/*`), not invented. The machine
copy of every token is the `:root` block in `src/styles.css`; every table below mirrors it value for
value. When a component needs a value that is not here, add it to both first.

## 1. Principles

The herdr-fleet design system (https://claude.ai/artifact/62aan9GDYEJmEYXYELbwf5) is the source
of the principles, the status words and the token names; this file mirrors the tokens as
`src/styles.css` holds them. Herdr-fleet is used by one engineer who watches many coding agents:
the screen recedes, and only what needs the person and what the person has selected stand out.

- **Attention leads.** Color and motion only mark an agent that needs the person, and the
  person's own selection. Everything else is neutral (`--ink`, `--sub`, `--field`); the only
  decorative color is the backdrop's glow.
- **Status words and colors are fixed.** `Working` (`--working`), `Needs you` and `Failed`
  (`--needs`), `Done` (`--done`), `Idle` (`--idle`): the same words and the same badge on every
  screen.
- **One layer of glass.** The sidebar, header, dialogs and sheets are one frosted layer
  (`--glass` + `--glass-blur`) over the backdrop; what sits inside it is an opaque `--field`.
  Glass never stacks. The terminal and the chat transcript stay on the opaque `--surface`.
- **One place to switch.** What to look at (Pane / Fleet, Chat / Terminal) switches in the header.
- **Two faces.** The UI is set in the OS Japanese gothic (`--font-ui`); mono is for machine values
  only (role, CLI and model names, paths, commands, times). No all-caps or letter-spaced headings.
- **Shape by role.** Radius, spacing and height follow a part's role, the same on every screen.
- **Labels in English, explanations in Japanese.** What is read at a glance (screen and feature
  names, buttons, items, statuses, headings, counts, progress) is English; what is read word by
  word (setting descriptions, error and notice bodies, confirmation bodies, guidance) is a
  Japanese sentence. There is no language switch.

## 2. Color

### Palette

One palette, aurora. `:root` holds the dark values (the default and the look before settings
load); `[data-theme="light"]` overrides them. The table is generated from those two blocks.

| Role | Token | Dark | Light |
|------|-------|------|-------|
| Ground | `--bg` | `#05070d` | `#eaf0f8` |
| Glow | `--glow-1` | `rgba(80, 220, 255, 0.2)` | `rgba(60, 190, 255, 0.28)` |
| Glow | `--glow-2` | `rgba(140, 110, 255, 0.22)` | `rgba(130, 100, 255, 0.22)` |
| Glow | `--glow-3` | `rgba(40, 255, 200, 0.1)` | `rgba(0, 200, 160, 0.14)` |
| Glass | `--glass` | `rgba(16, 22, 38, 0.46)` | `rgba(255, 255, 255, 0.52)` |
| Glass/strong | `--glass-strong` | `rgba(24, 32, 54, 0.78)` | `rgba(255, 255, 255, 0.82)` |
| Glass edge | `--edge` | `rgba(150, 200, 255, 0.2)` | `rgba(255, 255, 255, 0.9)` |
| Reading surface | `--surface` | `#0b1020` | `#f7faff` |
| Part surface | `--field` | `#121a2e` | `#edf2fa` |
| Part hover | `--field-hover` | `#18223a` | `#e1e9f5` |
| Input | `--input` | `#0a0f1c` | `#ffffff` |
| Line | `--line` | `#1c2742` | `#d3dcea` |
| Line/strong | `--line-strong` | `#2a3858` | `#b9c6da` |
| Control edge | `--control-edge` | `#5d6f96` | `#74839c` |
| Text | `--ink` | `#d6e2f5` | `#1c2638` |
| Text/strong | `--ink-strong` | `#f2f7ff` | `#0a1222` |
| Text/sub | `--sub` | `#93a1bb` | `#4a576e` |
| Accent | `--accent` | `#7df9ff` | `#00609a` |
| Accent/hover | `--accent-hover` | `#b8fcff` | `#0a7cc0` |
| On accent | `--on-accent` | `#021018` | `#ffffff` |
| Tint | `--tint` | `rgba(125, 249, 255, 0.13)` | `rgba(0, 96, 154, 0.1)` |
| Working | `--working` | `#8fa8ff` | `#3049c0` |
| Needs you | `--needs` | `#ff6b8a` | `#a6183e` |
| Done | `--done` | `#5cf2b0` | `#0a6443` |
| Idle | `--idle` | `#93a1bb` | `#4a576e` |
| Working/tint | `--working-tint` | `rgba(143, 168, 255, 0.14)` | `rgba(48, 73, 192, 0.1)` |
| Needs/tint | `--needs-tint` | `rgba(255, 107, 138, 0.14)` | `rgba(166, 24, 62, 0.1)` |
| Done/tint | `--done-tint` | `rgba(92, 242, 176, 0.12)` | `rgba(10, 100, 67, 0.1)` |
| Needs/text | `--needs-text` | `#ffd3dc` | `#8f1838` |
| Meter/plenty | `--meter-ok` | `var(--done)` | `—` |
| Meter/getting low | `--meter-mid` | `#ffd166` | `#8a5a00` |
| Meter/low | `--meter-low` | `var(--needs)` | `—` |
| Scrim | `--scrim` | `rgba(2, 4, 10, 0.6)` | `rgba(20, 40, 90, 0.25)` |
| Terminal bg | `--term-bg` | `#0b1020` | `#f7faff` |
| Terminal fg | `--term-fg` | `#d6e2f5` | `#1c2638` |
| Terminal cursor | `--term-cursor` | `#7df9ff` | `#00609a` |
| Terminal selection | `--term-selection` | `#1d3557` | `#cfe3f7` |

### Terminal theme

xterm.js reads a JavaScript theme, so `src/lib/settings.ts` `terminalTheme()` mirrors these four
CSS tokens verbatim for each resolved theme (`settings.test.ts` checks the match).

| Role | Token | Dark | Light | xterm key |
|------|-------|------|-------|-----------|
| Background | `--term-bg` | `#0b1020` | `#f7faff` | `background` |
| Foreground | `--term-fg` | `#d6e2f5` | `#1c2638` | `foreground` |
| Cursor | `--term-cursor` | `#7df9ff` | `#00609a` | `cursor` |
| Selection | `--term-selection` | `#1d3557` | `#cfe3f7` | `selectionBackground` |

### Rules
- `--accent` marks only the person's selection and action (the selected row's rail, the chosen
  segment, the primary button, focus, the terminal cursor); agent states never use it.
- `--needs` marks only what needs the person: `Needs you`, `Failed`, error notices, the nearest
  layer's edge. Destructive buttons are not red; a confirmation stops them.
- Agent state is always written as a word as well as colored; the badge text is `--ink`.
- A control drawn by its edge (field, segmented, toggle) uses `--control-edge` (3:1 on every
  surface it sits on); `--line` only groups.
- `theme: "system"` follows `prefers-color-scheme`; `src/lib/settings.ts` writes the resolved
  `data-theme`, `color-scheme`, and matching PWA `<meta name="theme-color">`.

## 3. Typography

### Scale

| Level | Token | Comfortable | Compact | Typical use |
|-------|-------|-------------|---------|-------------|
| Micro | `--fs-2xs` | `11px` | `10px` | Badges, hints, kbd |
| Meta | `--fs-xs` | `12px` | `11px` | Subtitles, field labels |
| Small | `--fs-sm` | `13px` | `12px` | Controls, row titles |
| Body | `--fs-md` | `14px` | `13px` | Body and dialog copy |
| Large | `--fs-lg` | `16px` | `15px` | Header title, modal title |
| Display | `--fs-xl` | `18px` | `17px` | Markdown h1 |
| Input | `--fs-input` | `16px` | `16px` | Mobile-safe text input |

| Token | Value | Usage |
|-------|-------|-------|
| `--font-ui` | `"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans CJK JP", "Noto Sans JP", "Yu Gothic UI", system-ui, sans-serif` | Chrome and chat prose |
| `--font-mono` | `"Symbols Nerd Font Mono", ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "D2Coding", monospace` | Paths, keys, terminal-adjacent metadata |
| `--lh-tight` | `1.2` | Titles |
| `--lh-base` | `1.5` comfortable / `1.45` compact | Body copy |
| `--fw-regular` | `400` | Body |
| `--fw-medium` | `500` | Controls |
| `--fw-semibold` | `600` | Labels and titles |
| `--fw-bold` | `700` | Brand |
| `--tracking-tight` | `-0.01em` | Brand and primary titles |
| `--tracking-caps` | `0.06em` | Uppercase operational labels |

### Settings
- `theme`: `dark`, `light`, or `system`; default `dark`.
- `density`: `comfortable` or `compact`; default `comfortable`.
- Terminal font size is independent: default `13px`, clamped to `10–22px`.
- Terminal and chat font families are comma-separated lists, default empty. They go in front of the
  terminal's built-in fonts (after the bundled Symbols Nerd Font Mono, which only draws icons) and of
  `--font-ui` in the chat's prose (as `--font-chat`), never in place of them; code in the chat keeps
  `--font-mono`. At most 200 characters, with `;`, `{`, `}`, `<`,
  `>`, `\` and control characters stripped and names with spaces quoted.
- Composer Enter behavior and folded thinking visibility are preferences, not typography tokens.
- All settings share one sanitized `localStorage["herdr-web-ui:settings"]` record.

## 4. Spacing & Layout

### Base unit

All spacing derives from a 4px base.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | `4px` | Tight icon and control gaps |
| `--space-2` | `8px` | Row and menu gaps |
| `--space-3` | `12px` | Control padding |
| `--space-4` | `16px` | Section and modal padding |
| `--space-5` | `20px` | Wide modal padding |
| `--space-6` | `24px` | Card breathing room |
| `--space-8` | `32px` | Large separation |

### Radii

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | `6px` | Chips and inner controls |
| `--radius-md` | `8px` | Buttons, inputs, selected rows |
| `--radius-lg` | `12px` | Menus and chat surfaces |
| `--radius-xl` | `16px` | Modals and composer |
| `--radius-pill` | `999px` | Pills and dots |

### Sizes

Comfortable values are `:root`; the final column is the complete compact override set.

| Token | Comfortable | Compact | Usage |
|-------|-------------|---------|-------|
| `--header-h` | `52px` | `46px` | App header |
| `--sidebar-w` | `320px` | `300px` | Sidebar/drawer |
| `--control-h` | `34px` | `32px` | Buttons and fields |
| `--touch-target` | `40px` | — | Coarse-pointer minimum |
| `--keybar-h` | `48px` | — | Terminal key bar |
| `--row-h` | `56px` | `44px` | Roster and palette rows |
| `--chip-h` | `20px` | `18px` | Badge/pill height |
| `--icon-size` | `18px` | — | Standard icon |
| `--mark-size` | `22px` | — | Brand mark |
| `--avatar-size` | `32px` | `26px` | Roster mark box |
| `--dot-size` | `7px` | — | Connection dot |
| `--rail-w` | `3px` | — | Selected-row rail |
| `--hairline` | `1px` | — | Borders |
| `--content-w` | `820px` | — | Chat/settings content |
| `--palette-w` | `640px` | — | Command palette |
| `--palette-top` | `12vh` | — | Palette top offset |

### Focus and layers

| Token | Value | Usage |
|-------|-------|-------|
| `--ring` | `2px solid var(--accent)` | Global `:focus-visible` outline |
| `--ring-offset` | `2px` | Outline offset |
| `--z-banner` | `5` | Terminal banners |
| `--z-popover` | `10` | Composer completions |
| `--z-scrim` | `15` | Mobile drawer scrim |
| `--z-drawer` | `20` | Mobile drawer |
| `--z-modal` | `30` | Dialog and palette scrims |
| `--z-droplet` | `40` | In-app alert, over dialogs |

### In-app alert

One set for both themes: the card is island black wherever it shows.

| Token | Value | Usage |
|-------|-------|-------|
| `--droplet-bg` | `#000` | Drop, anchor and card |
| `--droplet-text` | `#f5f5f7` | Pane name |
| `--droplet-text-dim` | `rgba(245, 245, 247, 0.62)` | Ended detail, blank mark |
| `--droplet-blocked` | `#ff8a80` | Needs-input detail and dot |
| `--droplet-done` | `#9fd47a` | Finished detail and dot |
| `--droplet-mark-bg` | `rgba(255, 255, 255, 0.1)` | Agent mark disc |
| `--droplet-ring` | `rgba(255, 255, 255, 0.1)` | Card hairline |
| `--droplet-shadow` | `rgba(0, 0, 0, 0.35)` | Drop shadow under the liquid |

### Shell
- `.app` is a full-viewport column: `.app-header` over `.app-body`; the body is sidebar plus
  `.terminal-host`. While a phone's soft keyboard is up (`data-keyboard`), `--app-height` follows
  `visualViewport` so the keyboard does not cover input; otherwise the shell is `100dvh`, because an
  iPhone home screen app reports a visual viewport shorter than the screen without a keyboard.
- Header anatomy, left to right: mobile drawer toggle / desktop sidebar toggle; flexible context
  title plus PC/workspace/cwd subtitle; segmented Chat/Terminal switch; the connection chip (herdr
  version in its tooltip) and meta actions for palette, notifications, settings and lock. Theme
  lives in Settings and the palette; the herdr version also sits in the sidebar footer.
- The sidebar is fixed-width on desktop and a `<=768px` drawer. The desktop collapse removes its
  column; the drawer uses a scrim and keeps safe-area insets. On touch, a mostly horizontal swipe in
  from the left `24px` edge opens the drawer and a swipe to the left closes it (`56px` of travel).
- The terminal stack contains a positioned terminal surface, then composer or key bar. The xterm
  mount stays alive under the chat lens; changing views never creates a second connection.
- At `<=480px`, labels shed in priority order: version, brand name, context subtitle, connection
  text and desktop-only control labels. Icons and selected context remain.

## 5. Components

### Button (`.btn`, `.icon-button`)
- `.btn` is a medium text control. Variants: neutral, `.btn-primary`, `.btn-danger`, `.btn-ghost`.
  Primary uses `--accent`; danger uses danger tint plus blocked border; ghost removes fill/edge.
- `.icon-button` is a square unlabeled visual control with mandatory `aria-label`; `.is-outlined`
  adds the border. Both families use `--control-h`, `--radius-md`, focus ring, hover and disabled.
- Coarse pointers grow controls to `--touch-target`.

### Segmented control (`.segmented`)
- One `aria-pressed="true"` option receives hover fill and strong text; the group itself is an
  elevated, bordered `--radius-md` track.
- Used for Chat/Terminal, theme and density. It is not a generic tab list.

### Keyboard hint (`.kbd`)
- An inline mono keycap: `18px` high, strong bottom edge, `--radius-sm`, `--fs-2xs`.
- `Mod` resolves to `⌘` on Apple platforms and `Ctrl` elsewhere.

### Modal (`.modal*`)
- `.modal-scrim` centers an `aria-modal` dialog at `--z-modal`; `.modal` is a capped scrollable
  column with header, body and footer and `--shadow-pop`.
- At `<=640px`, it becomes a bottom sheet with top `--radius-xl` corners and safe-area padding.
- Escape, explicit close and scrim click close dialogs; first meaningful control receives focus.
- A confirm (`.confirm-dialog`, `alertdialog`, 420px) asks before something that cannot be undone:
  Cancel has the focus, Tab stays between the two buttons, the danger action sits at the right,
  and a failure shows inside it. A no gives the focus back to what opened it.

### Field (`.field`, `.input`, `.select`)
- Stacked uppercase label, optional hint and `--input` field. Desktop fields use `--fs-sm`;
  small-screen fields retain `--fs-input` to avoid focus zoom.
- Focus names the edge with accent; errors use blocked/danger tokens and `role="alert"`.

### Menu / popover (`.menu*`)
- Bordered `--radius-lg` surface with `--shadow-pop`; rows use `--control-h`, `--radius-md`, icon,
  ellipsized main label and optional hint.
- Hover or `aria-selected` uses `--field-hover`. Headings are dim uppercase micro labels.
- The sidebar's row menu (`.row-menu`) is a `.menu` drawn through a portal at fixed coordinates,
  under its `⋯` with right edges aligned, above it when the screen ends first, and over the drawer.
  A one-pane row offers Rename workspace, Rename pane, then Close under a hairline; a workspace
  header Rename workspace and Close workspace; a pane under a header Rename pane and Close. The
  danger item takes `--needs`. At `<=640px` it is a `.modal` bottom sheet (`.row-sheet`):
  a grip, the row's name and place, 48px rows and a Cancel button; Tab stays among them. Escape, a press outside and
  focus leaving it close it (on a desktop a scroll or a resize too), and focus returns to the
  `⋯`. Arrow keys move between items. A row that leaves the roster takes its open menu with it.
- Close follows herdr's `ui.confirm_close`: a close that takes the workspace with it (a one-pane
  row, Close workspace) asks in a confirm first; a pane that leaves its workspace standing closes
  at once. After a confirmed close, focus lands on the header's workspace-list toggle.

### Badge (`.badge`)
- Agent states read **READY**, **RUN**, **INPUT**, **DONE**; unknown reads **—**.
- Idle is elevated/dim; working, blocked and done use their own tint and text. RUN carries a small
  breathing dot before the word; the word itself never fades.
- The written label and unknown dashed edge keep color from being the only signal.

### Pill (`.pill`)
- Mono metadata at `--chip-h`. The herdr version is a sidebar-footer pill; offline is the one header pill and uses danger tokens.

### Sidebar roster row and footer
- No top bar. The sidebar opens with the plan panel (when Settings puts it there), **Needs you**
  and the PC groups. A session starts from the `+` on its PC's header, or from the **New session**
  button in the dashed **No workspaces yet** box of an empty PC. **Add PC** lives in Settings →
  Remote PCs and in the command palette. Search lives in the command palette, not the roster.
- Appearance's **Sidebar grouping** is **By workspace** by default, with numbered, foldable
  workspace headers and merged single-pane rows. **By folder** opts into the grouping below.
  The choice applies immediately and persists in the browser's existing Settings record. Workspace
  and folder fold keys remain independent when switching modes; original workspace keys are retained.
- In folder mode, within each PC, panes with the same full cwd share a folder group, including panes from
  different workspaces. Trailing separators and Windows slash styles are normalized; case and
  symlinks are not resolved. Unknown cwd stays with its workspace rather than merging unrelated sessions.
- Every folder has a caret, folder glyph, basename, full-path subtitle and pane count, even for
  one pane. Its indented contents use the existing spacing and border tokens. Folder folds are
  remembered per PC and path; opening a pane unfolds its folder, but status updates do not.
- Folder order follows the first workspace in server order; workspace handles still reorder
  workspaces, not filesystem directories. Workspace names and rename actions remain inside the group.
- A workspace header shows drag handle, number, editable label, roll-up status and its `⋯`.
  Drag/drop reorders; `Alt+↑/↓` on the handle is the keyboard equivalent.
- Every pane row is two lines: agent/shell mark, then the editable title alone on line one (full
  width), and the status chip followed by the pane's place on line two. Mark boxes are neutral;
  the selected row gets the `--accent` rail and an accent-edged mark box. The row ends in one `⋯`
  (`.row-menu-toggle`: shown on hover, focus, selection and while its menu is open; always on
  touch) that opens the row menu. Inline server failures stay beside their row.
- A title that is a working directory written out (`/home/me/dev/api`, `~/dev/api`, `C:\work\api`)
  shows as its last folder, here, in the header, the palette and every alert; the full path stays
  in the row's tooltip. Line two names what the group header does not: the folder under a
  workspace header (nothing when the title or the workspace is already that folder), the workspace under a folder
  header. A merged single-pane row in the workspace view has no header: it names the workspace
  and the folder, each only when the title or the other does not already say it. The palette,
  which has no header, names the workspace and the folder, once when they are the same.
- A PC group header is caret, monitor, name, “Host” for the local machine, a state dot
  (done = connected, working pulse = connecting/reconnecting, blocked = error), then a `+` that
  starts a session on that PC (disabled while it is offline) and, for an SSH PC, its manage
  button. Connected says
  nothing more; every other state is written under the name, with the server's error clamped to
  two lines and complete in the tooltip.
- Single-pane workspaces merge their workspace handle into the pane row, in both groupings: one
  row, no header, number or fold. A fold stored for such a workspace is ignored until it has a
  header again.
- Footer holds the contextual **Install app** action, Settings with the plan meters beside it,
  product name and herdr version.

### Plan meters (`.usage*`)
- Beside Settings, one button holding up to four chips (three and `+N` past that), one per
  account in the user's order: provider mark, mono `--fs-2xs` percent of the limit closest to
  running out (used, or left when Settings says so), and a 2px bar on a `--line-strong` track
  filled to that percent. From 80% used the percent and bar take `--needs`; the accent stays
  chrome. A chip whose numbers are stale or missing dims. An account hidden in Settings is
  left out of the strip and the popover; with every account hidden, neither shows.
- The button opens a popover above the footer (`--shadow-pop`, `--radius-lg`), as wide as the
  footer and scrolling when it outgrows the sidebar: per account its mark, name and plan pill with
  the email or login right-aligned and ellipsized, then one row per limit (label, reset time, right-aligned percent) over a 4px bar. A problem
  note is dim, red for an expired sign-in or a failed request.
- At the top of the sidebar (Settings → Where), a panel with one row per account: mark, provider
  and plan (the account only when two of one provider show), a 5px bar, the limit's window and its
  reset as `1d 3h (10/4 15:00)` (time left in short units, then the local date and time), and the
  percent large (`--fs-xl`) as tall as those three lines. The bar is coloured by what is left:
  `--meter-ok` from half, `--meter-mid` from a fifth, `--meter-low` under it (the percent too).

### New session dialog
- Agent select comes from `GET /api/agents`; shell-only is always available. Directory defaults to
  the selected pane cwd and name is an optional workspace label.
- Submit calls `POST /api/workspace/create`; the server performs `workspace.create` and, when an
  agent was chosen, `agent.start` in its root pane. Pending and partial agent-start failure are
  explicit before the created pane opens.

### Header context and connection
- A selected pane shows agent mark + title over workspace + cwd. With no selection, the brand fills
  the context slot.
- The segmented Chat/Terminal view switch lives in the header. There is no floating view-toggle pill.
- Connection is one quiet chip: a dot plus the written live/reconnecting/disconnected state;
  reconnecting pulses the dot. On phones the chip keeps only its dot.

### Chat turn (`.chat-turn`)
- The chat lens is a centered `--content-w` transcript over the still-attached terminal surface.
  Structured Claude/omp transcripts fall back to ANSI-stripped pane scrollback when unavailable.
- The register is Codex / gajae-code-app: a quiet document. User turns are right-aligned neutral
  cards (`--field`, hairline edge, `--radius-lg` with a `--radius-sm` tail corner, ≤80% wide,
  no avatar or name) and open a new exchange with a hairline above. Assistant turns have no header: the answer is plain prose; a meta row (MD / TXT
  copy, time) fades in on hover (always visible on coarse pointers).
- Markdown supports headings, lists, links, quotes, tables, inline/fenced code and code-copy actions.
  Code blocks never scroll inside: one longer than 30 lines opens at its first 20 behind **Show all N lines**.
  Thinking renders as a folded block only when **Show thinking** is enabled.
- Auto-follow stops when the reader scrolls up; later output raises a **New messages** pill.

### Work block (`.work-block`, `.work-row`)
- One per assistant turn: a `▸ Worked for 7s · 1 edit · 2 commands` header (duration = next turn's
  timestamp minus this one's; "Working…" in `--working` behind a breathing dot while the agent runs) over
  one-line rows `▸ [icon] name / summary` in mono, indented under the header; mid-work narration
  sits between rows as dim, one-step-smaller prose. The newest turn opens by default, older ones
  fold. A row expands to the typed input (command, diff, file, checklist, raw) and an Output pane.

### Prompt card (`.prompt-card`)
- Appears in chat while the agent is blocked and the visible pane contains a supported Claude, omp,
  omo or codex question, approval or plan menu.
- A form of several questions (omo) shows a row of step chips (`.prompt-card-steps`) under the
  header: a chip per question, pill-shaped, mono number or a check once answered (`--accent`), the
  one asked now with an `--accent` border, `--tint` fill and a `--accent` number. The title
  then reads `Question 1 of 2`; the review after the last question keeps the chips, all checked.
- Single options submit immediately; multi-select exposes checks plus Submit; supported custom input
  has its own labelled field. The prompt content hash rejects a stale answer with `prompt_changed`.
- Options are full-width rows (`.prompt-card-option`): the menu's number in mono, the label, its
  description under it in `--sub`. No option is filled as a default; a checked or typed pick
  gets `--tint` + an `--accent` border. A `(Recommended)` suffix renders as a tag.
- `POST /api/pane/prompt/answer` translates the chosen answer into the agent's navigation keys and
  sends them through herdr `pane.send_keys` / text input. The card never fabricates a chat reply.

### Composer (`.composer`)
- Chat mode is ONE surface: the stack, the transcript and the composer region all sit on `--bg`,
  and the composer column equals the transcript column (`--content-w`, same `--space-4` gutter).
  The only card is the input box: `--field`, hairline border, `--radius-xl`, `--shadow-card`;
  focus turns its border `--accent` (no inner outline). Above it the agent/status line and the
  completion popover; inside, ONE row — attach control | auto-growing textarea | Send / Queue /
  Stop — with the controls bottom-aligned so they stay beside the last line as the box grows;
  the image strip is its own row above that line.
- The status line ends, on fine pointers, with `/` commands and `@` files keycaps (plus `Mod+Enter`
  sends when **Enter sends** is off); the placeholder is just `Message <agent>…`.
- `/` completions come from `GET /api/pane/commands` and group built-in, user and project commands;
  `@` completions query `GET /api/pane/files`. Arrow keys navigate, Enter/Tab accepts, Escape closes.
- Paste, picker or drag/drop accepts up to four png/jpeg/gif/webp files per action. Each gets a local
  preview, uploads through `POST /api/pane/image`, and inserts a removable editable `@path` mention.
- While a phone's keyboard is up, a tap on the transcript or a drag down it (`32px`) puts the
  keyboard away. Each only blurs the field, so the draft stays.
- On a touch screen, picking a pane (drawer, palette, notification) or switching its lens never
  raises the keyboard: the user reads first, and a tap on the message box or the grid raises it.
  A desktop's picked pane takes typing at once.
- Enter sends and Shift+Enter breaks by default; with **Enter sends** off, Mod+Enter sends. IME Enter
  is ignored. While working, Stop sends Escape and Queue stores the next message.

### Command palette
- `Mod+Shift+K` opens a top-offset `--palette-w` dialog searching panes and actions. Recent panes
  lead an empty query; arrows cycle, Enter activates and Escape closes.
- Actions cover new session, lens/sidebar/theme, settings, notifications, lock and refresh, with
  `.kbd` hints where a global shortcut exists.

### Settings dialog
- Appearance: Dark / Light / System, Comfortable / Compact, terminal font `10–22px`, terminal font
  family.
- Composer: Enter sends. Chat: Show thinking, chat font size and family. Shortcuts: the complete
  platform-resolved table.
- A font family is a text field saved when it is left, on Enter or when the dialog closes, not
  per keystroke.
- Remote PCs follows Devices: an **Add PC** row (label, one-line description, button) opens the PC
  setup dialog and closes Settings behind it; when that dialog closes, focus lands on the header's
  workspace-list toggle. Under the row, once the server has answered, the bridge auto-update switch.
- Install reflects installed, promptable or browser-instructions state; About links the repository.
- Subscription usage: the on switch with one description, then (when on) Used / Remaining and one
  hairline card of accounts (`.usage-accounts`, `--radius-md`): an uppercase `--field` header
  with **Nearest limit first** at its right once the user has ordered, then one 38px row per account
  (mark, name, dim ellipsized email, then 28px move-up, move-down and eye controls in fixed columns;
  a move that cannot happen keeps its column but is not shown). A hidden account's row fades and
  its eye closes; it stays listed so it can be shown again.

### Terminal host, key bar and drawer
- xterm has `scrollback: 0`; wheel/touch gestures reach herdr's alternate-screen scrollback. The
  mount clips its own gutter and hides the unused xterm scrollbar.
- Terminal banners stack top-right for ended, reconnecting, observe and held-draft review states.
- The mobile key bar is Esc, Tab, one-shot Ctrl, arrows and `^C`; it never steals xterm focus.
- The mobile drawer slides over a scrim. Closed visibility removes its controls from the tab order.

### In-app alert
- While the app is on screen, a pane that needs input, finishes a turn (by the device's Finished
  choice) or ends drops a card from the top edge: a black drop falls from above the safe area,
  spreads into the card, and its text shows. It hangs from `env(safe-area-inset-top)` only, so a
  Dynamic Island, a notch and a desktop window take the same path; no device is guessed.
- One at a time; a newer one folds the current one away first. Tap opens the pane; a drag or flick
  up puts it away; it leaves by itself 3.6s after its text shows, and waits while touched.
- Not for the pane already open, and not while the app is hidden (system notifications cover that).
- Reduced motion: it fades in and out where it rests, without falling or spreading.

### Token gate
- A centered password card replaces the entire shell while authentication is required. It has a real
  label, autofocused field, primary Unlock button and linked alert text.
- Success mounts the shell; Lock unsubscribes push, deletes auth and returns to the gate.

### Role (no control surface)
- `interact` types and resizes; `observe` does neither. The server enforces both and the WS protocol
  carries `role` / `role-ack`.
- The app connects as `interact` and exposes no role switch. An observe acknowledgement still gates
  local input, adopts server geometry and displays the view-only banner.

## 6. Motion & Interaction

### Timing

| Type | Token | Value | Usage |
|------|-------|-------|-------|
| Micro | `--dur-fast` | `120ms` | Hover, active, toggle and control state |
| Standard | `--dur-base` | `180ms` | Drawer slide; reserved dialog timing token |
| Pulse | `--dur-pulse` | `1600ms` | Working and reconnecting dots (trough opacity 0.35; text never pulses) |
| Easing | `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | Finite transitions |
| Pulse easing | `--ease-pulse` | `steps(2, jump-none)` | Endless working and reconnecting dots; avoids drawing every display refresh |
| Spring easing | `--ease-spring` | `cubic-bezier(0.32, 0.72, 0, 1)` | Voice recording pill enter (180ms, scale 0.96->1 + opacity, from the mic button) and exit (120ms) |

### Rules
- Only state changes move: hover/press, the drawer, settings switches, working and reconnecting.
- Dialogs and their scrims snap open and closed; they have no entrance or exit animation. On mobile,
  their static layout changes to a bottom sheet.
- The voice recording waveform is the one surface allowed to draw every frame: only while
  recording, driven by the live microphone level, transform-only (`scaleY` on 7 bars). The pill is
  a state change, not a dialog, so the snap rule above does not apply to it.
- `prefers-reduced-motion: reduce` removes pulses, drawer/control transitions, smooth chat scrolling
  and settings toggle motion. State remains legible without animation.
- Under reduced motion the voice pill swaps its bars for one level bar updated at 4 Hz and drops
  the ring and the morph; the **Recording** label and the timer stay.

## 7. Depth & Surface

### Strategy

**Tonal shift + hairline, with shadow reserved for overlays.** Resting shell surfaces have no shadow.

| Type | Value | Usage |
|------|-------|-------|
| Hairline | `var(--hairline) solid var(--line)` | Shell, fields, controls |
| Strong edge | `var(--line-strong)` | Hover/focus separation |
| Dashed edge | `var(--hairline) dashed var(--line)` | Unknown/empty states |
| Tonal lift | `--field` on `--surface` | Selection, chips, tracks |
| Tinted lift | Named tint over an opaque surface | Primary and agent states |
| Drawer shadow | `--shadow-drawer` | Mobile drawer |
| Overlay shadow | `--shadow-pop` | Menus, palette and modal cards |
| Card shadow | `--shadow-card` | The composer's input box — the one resting card in chat mode |

### Glass layers (Liquid / Spatial)

Screens built on the Passive View architecture (the Fleet screen first) float their chrome over a
backdrop instead of tiling opaque panels. Every palette has these tokens: aurora sets its own,
the others derive them from their surfaces with `color-mix`.

| Token | Use |
|-------|-----|
| `--glow-1/b/c`, `--backdrop-grid` | The screen's backdrop: three soft glows over `--bg`, plus aurora's dot grid |
| `--glass`, `--glass-strong` | A floating layer's fill: `--glass` for groups, `--glass-strong` for the item lifted inside one and for sheets |
| `--edge`, `--glass-hi` | Its 1px edge and the inset highlight along its top |
| `--glass-sheen-a/b` | The faint iridescent sweep across a layer (aurora) |
| `--glass-blur` | `backdrop-filter` of a layer |
| `--glass-shadow` | Depth: the nearer a layer, the larger its shadow |

- Depth carries meaning: what waits on the person is nearest (largest shadow, a state-colored edge),
  finished work recedes (smaller shadow, lower opacity).
- `prefers-reduced-transparency: reduce` and browsers without `backdrop-filter` get `--glass-strong`
  without blur; `prefers-reduced-motion` drops the lift on hover.
- The terminal and the chat transcript never sit on glass.

## 8. Accessibility Constraints & Accepted Debt

### Constraints
- WCAG 2.2 AA is the target; do not document numeric contrast without measuring both shipped themes
  and every actual backing surface.
- Global `:focus-visible` uses `--ring`; interactive controls remain keyboard reachable except the
  touch key bar, which intentionally preserves terminal focus and has hardware-key equivalents.
- Icon-only controls carry `aria-label`; toggles expose `aria-pressed` or `role="switch"`; selected
  pane exposes `aria-current`; dialogs expose `role="dialog"` and `aria-modal`.
- Status, loading and composer progress use `role="status"`; failures use `role="alert"`. Agent state
  is text plus color, and unknown adds a dashed edge.
- Touch targets grow to `--touch-target`; fields stay `--fs-input` where mobile zoom is a risk.
- `prefers-reduced-motion` is honored. Lucide/inline SVG decoration is hidden from assistive tech.
- Global shortcuts use the convention **Mod+Shift+key**: Mod is Command on Apple platforms and Ctrl
  elsewhere. The settings table is the discoverable source of the complete mapping.
- `document.title` is `<pane title> · herdr` while selected, otherwise `herdr web ui`.

### Accepted debt

| Item | Location | Why accepted | Exit |
|------|----------|--------------|------|
| Terminal content accessibility relies on xterm defaults | `PaneTerminal.tsx` | Screen-reader mode changes terminal DOM and input behavior | Decide with herdr TUI owners |
| Drawer has no focus trap | `.sidebar.is-open` | Closed state leaves the tab order, but open-state trapping is not implemented | Add a shared focus utility |
| Modal focus is initialized, not fully trapped | Dialog components | Escape/scrim/close work; tab containment is not shared | Add the same focus utility |
| Terminal colors exist in CSS and JavaScript | `styles.css`, `settings.ts` | xterm consumes a JS theme | Keep `terminalTheme()` verbatim with `--term-*` |
