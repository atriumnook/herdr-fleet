# herdr-fleet Design System

The herdr-fleet design system (https://claude.ai/artifact/62aan9GDYEJmEYXYELbwf5) is the source of
the principles, the state words and the token names. This file is how the code carries it out: the
machine copy of every token is the `:root` block of `src/styles.css` (the light values in its
`[data-theme="light"]` block), and every table below mirrors those blocks value for value. A value
a component needs that is not here goes into both first.

## 1. Principles

Herdr-fleet is used by one engineer who watches many coding agents. The agents work on their own;
the person notices what needs them, answers, and leaves again. The screen recedes, and only what
needs the person and what the person has selected stand out.

- **Attention leads.** Color and motion only mark an agent that needs the person, and the person's
  own selection. Everything else is neutral (`--ink`, `--sub`, `--field`); the only decorative color
  is the ground's glow.
- **State words and colors are fixed.** `Working` (`--working`), `Needs you` and `Failed` (`--needs`),
  `Done` (`--done`), `Idle` (`--idle`): the same words and the same badge on every screen, except the
  sidebar's rows, which show the badge's dot alone so the name keeps the width.
- **One layer of glass.** The header, the sidebar, dialogs and sheets are one frosted layer
  (`--glass` + `--glass-blur`) over the ground (`--bg` and its glows); what sits inside a panel, and
  every card on the ground, is an opaque `--field`. Glass never stacks. The terminal and the chat
  transcript stay on the opaque `--surface`.
- **One place to switch.** What to look at (Pane / Fleet, Chat / Terminal) switches in the header's
  segmented controls; nothing switches it from the bottom of the screen.
- **Two faces.** The UI is set in the OS Japanese gothic (`--font-ui`); mono is for machine values only
  (role, CLI and model names, paths, commands, times). No all-caps or letter-spaced headings.
- **Shape by role.** Radius, spacing and height follow a part's role, the same on every screen.
- **Labels in English, explanations in Japanese.** What is read at a glance (screen and feature names,
  buttons, items, states, headings, counts, progress) is English; what is read word by word (setting
  descriptions, error and notice bodies, confirmation bodies, guidance) is a Japanese sentence, kept in
  `src/lib/i18n.ja.ts`. There is no language switch.

## 2. Color

### Palette

Two themes, dark (the default, and the look before settings load) and light. `:root` holds the dark
values and `[data-theme="light"]` overrides them; the table is taken from those two blocks.

| Role | Token | Dark | Light |
|------|-------|------|-------|
| Ground | `--bg` | `#05070d` | `#eaf0f8` |
| Glow | `--glow-1` | `rgba(80, 220, 255, 0.2)` | `rgba(60, 190, 255, 0.28)` |
| Glow | `--glow-2` | `rgba(140, 110, 255, 0.22)` | `rgba(130, 100, 255, 0.22)` |
| Glow | `--glow-3` | `rgba(40, 255, 200, 0.1)` | `rgba(0, 200, 160, 0.14)` |
| Glass | `--glass` | `rgba(16, 22, 38, 0.46)` | `rgba(255, 255, 255, 0.52)` |
| Glass over cards | `--glass-strong` | `rgba(24, 32, 54, 0.78)` | `rgba(255, 255, 255, 0.82)` |
| Glass edge | `--edge` | `rgba(150, 200, 255, 0.2)` | `rgba(255, 255, 255, 0.9)` |
| Glass top highlight | `--glass-hi` | `rgba(220, 240, 255, 0.28)` | `rgba(255, 255, 255, 1)` |
| Glass depth | `--glass-shadow` | `rgba(0, 4, 16, 0.6)` | `rgba(20, 40, 90, 0.16)` |
| Reading surface | `--surface` | `#0b1020` | `#f7faff` |
| Part face | `--field` | `#121a2e` | `#edf2fa` |
| Part hover | `--field-hover` | `#18223a` | `#e1e9f5` |
| Input face | `--input` | `#0a0f1c` | `#ffffff` |
| Line | `--line` | `#1c2742` | `#d3dcea` |
| Line, strong | `--line-strong` | `#2a3858` | `#b9c6da` |
| Control edge | `--control-edge` | `#5d6f96` | `#74839c` |
| Text | `--ink` | `#d6e2f5` | `#1c2638` |
| Text, strong | `--ink-strong` | `#f2f7ff` | `#0a1222` |
| Text, sub | `--sub` | `#93a1bb` | `#4a576e` |
| Accent | `--accent` | `#7df9ff` | `#00609a` |
| Accent, hover | `--accent-hover` | `#b8fcff` | `#0a7cc0` |
| On accent | `--on-accent` | `#021018` | `#ffffff` |
| Tint | `--tint` | `rgba(125, 249, 255, 0.13)` | `rgba(0, 96, 154, 0.1)` |
| Working | `--working` | `#8fa8ff` | `#3049c0` |
| Needs you | `--needs` | `#ff6b8a` | `#a6183e` |
| Done | `--done` | `#5cf2b0` | `#0a6443` |
| Idle | `--idle` | `#93a1bb` | `#4a576e` |
| Working tint | `--working-tint` | `rgba(143, 168, 255, 0.14)` | `rgba(48, 73, 192, 0.1)` |
| Needs tint | `--needs-tint` | `rgba(255, 107, 138, 0.14)` | `rgba(166, 24, 62, 0.1)` |
| Done tint | `--done-tint` | `rgba(92, 242, 176, 0.12)` | `rgba(10, 100, 67, 0.1)` |
| Needs text | `--needs-text` | `#ffd3dc` | `#8f1838` |
| Meter, plenty | `--meter-ok` | `var(--done)` | `—` |
| Meter, getting low | `--meter-mid` | `#ffd166` | `#8a5a00` |
| Meter, low | `--meter-low` | `var(--needs)` | `—` |
| Scrim | `--scrim` | `rgba(2, 4, 10, 0.6)` | `rgba(20, 40, 90, 0.25)` |
| Terminal bg | `--term-bg` | `#0b1020` | `#f7faff` |
| Terminal fg | `--term-fg` | `#d6e2f5` | `#1c2638` |
| Terminal cursor | `--term-cursor` | `#7df9ff` | `#00609a` |
| Terminal selection | `--term-selection` | `#1d3557` | `#cfe3f7` |

`--glass-blur` is `blur(28px) saturate(180%)` in both themes.

### Terminal theme

xterm.js reads a JavaScript theme, so `terminalTheme()` in `src/lib/settings.ts` mirrors the four
`--term-*` tokens verbatim for each resolved theme (`settings.test.ts` checks the match); no CSS
reads them.

### Rules
- `--accent` marks only the person's selection and action (the selected row's rail, the chosen
  segment, the primary button, focus, the terminal cursor); agent states never use it.
- `--needs` marks only what needs the person: `Needs you`, `Failed`, error notices, the nearest
  card's edge. A destructive action is not red: a confirm stops it.
- Agent state is written as a word as well as colored, and the badge's word is `--ink`. Where a
  sidebar row shows only the dot, the word is its tooltip and accessible name, Working's dot also
  breathes, Idle's is a ring, and a Needs you pane also sits under the worded **Needs you** heading.
- A control drawn by its edge (field, segmented, toggle) uses `--control-edge` (3:1 on every surface
  it sits on); `--line` only groups.
- `theme: "system"` follows `prefers-color-scheme`; `src/lib/settings.ts` writes the resolved
  `data-theme`, `color-scheme`, and the matching PWA `<meta name="theme-color">`.

## 3. Typography

### Scale

| Level | Token | Comfortable | Compact | Typical use |
|-------|-------|-------------|---------|-------------|
| Micro | `--fs-2xs` | `11px` | `10px` | Keycaps, elapsed times, capsule details |
| Caption | `--fs-xs` | `12px` | `11px` | Badges, section headings, field labels, mono metadata |
| Small | `--fs-sm` | `13px` | `12px` | Descriptions, hints, notices, segment options |
| Body | `--fs-md` | `14px` | `13px` | Body copy, rows, buttons, setting names |
| Large | `--fs-lg` | `16px` | `15px` | Header title, the nearest card's name, the prompt card's title |
| Heading | `--fs-xl` | `18px` | `17px` | Dialog titles |
| Input | `--fs-input` | `16px` | `16px` | Every text field (no zoom on a phone) |

The Fleet screen's title is 30px bold, its one size off the scale.

| Token | Value | Usage |
|-------|-------|-------|
| `--font-ui` | `"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans CJK JP", "Noto Sans JP", "Yu Gothic UI", system-ui, sans-serif` | Chrome and chat prose; no font is served |
| `--font-mono` | `"Symbols Nerd Font Mono", ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace` | Machine values |
| `--lh-tight` | `1.2` | Titles |
| `--lh-base` | `1.5` comfortable / `1.45` compact | Body copy |
| `--fw-regular` | `400` | Body |
| `--fw-medium` | `500` | Controls, badges, section headings |
| `--fw-semibold` | `600` | Names and titles |
| `--fw-bold` | `700` | The primary button, screen titles, the brand |
| `--tracking-tight` | `-0.01em` | The brand and the header title |

### Settings
- `theme`: `dark`, `light` or `system`; default `dark`. `density`: `comfortable` or `compact`;
  default `comfortable`.
- Terminal font size is independent: default `13px`, clamped to `10–22px`.
- Terminal and chat font families are comma-separated lists, default empty. They go in front of the
  terminal's built-in fonts (after the bundled Symbols Nerd Font Mono, which only draws icons) and of
  `--font-ui` in the chat's prose (as `--font-chat`), never in place of them; code in the chat keeps
  `--font-mono`. At most 200 characters, with `;`, `{`, `}`, `<`, `>`, `\` and control characters
  stripped and names with spaces quoted. The terminal's built-in list is Latin mono fonts, then
  `Noto Sans Mono CJK JP` per glyph, then `monospace`.
- All settings share one sanitized `localStorage["herdr-fleet:settings"]` record (`src/lib/settings.ts`).

## 4. Spacing & Layout

### Base unit

All spacing derives from a 4px base.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | `4px` | Icon and control gaps, the gap between sidebar rows |
| `--space-2` | `8px` | Menu gaps, the gap between cards, the floating panels' inset |
| `--space-3` | `12px` | A row's inside, control padding |
| `--space-4` | `16px` | A panel's and a dialog's inside, between cards and settings sections |
| `--space-5` | `20px` | The nearest card's inside |
| `--space-6` | `24px` | A screen's outer edge, between sections |
| `--space-8` | `32px` | Large separation |

### Radii

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | `6px` | Segment options, keycaps |
| `--radius-md` | `8px` | Buttons, fields, rows, notices |
| `--radius-lg` | `12px` | Cards, menus, the composer, the reading surface |
| `--radius-xl` | `16px` | Glass panels: header, sidebar, dialogs, sheets |
| `--radius-pill` | `999px` | Badges, capsules, dots |

### Sizes

Comfortable values are `:root`; the compact column is the complete compact override set.

| Token | Comfortable | Compact | Usage |
|-------|-------------|---------|-------|
| `--header-h` | `52px` | `46px` | App header (`100px` at `<=768px`: two rows) |
| `--sidebar-w` | `320px` | `300px` | Sidebar / drawer |
| `--input-h` | `44px` | — | Text fields |
| `--control-h` | `34px` | `32px` | Buttons |
| `--touch-target` | `40px` | — | Coarse-pointer minimum |
| `--keybar-h` | `48px` | — | Terminal key bar |
| `--row-h` | `56px` | `44px` | Sidebar and palette rows |
| `--chip-h` | `20px` | `18px` | Badge and pill height |
| `--icon-size` | `18px` | — | Standard icon |
| `--mark-size` | `22px` | — | Brand mark |
| `--avatar-size` | `28px` | `24px` | A row's agent mark box |
| `--dot-size` | `7px` | — | Connection and PC dots |
| `--rail-w` | `3px` | — | Selected-row rail |
| `--hairline` | `1px` | — | Borders |
| `--content-w` | `820px` | — | Chat and settings content |
| `--palette-w` | `640px` | — | Command palette |
| `--palette-top` | `12vh` | — | Palette top offset |

### Focus and layers

| Token | Value | Usage |
|-------|-------|-------|
| `--ring` | `2px solid var(--accent)` | Global `:focus-visible` outline |
| `--ring-offset` | `2px` | Outline offset |
| `--z-banner` | `5` | Terminal banners |
| `--z-popover` | `10` | Composer completions, the prompt card |
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
- `.app` is a full-viewport column: `.app-header` over `.app-body`; the body is the sidebar plus
  `.terminal-host`. The app's ground is `--bg` with three soft glows; the header and the sidebar are
  each one glass panel over it (`--glass`, 1px `--edge`, `--glass-blur`, `--shadow-panel`). Wider
  than `768px` they float `--space-2` off the edges with `--radius-xl`, and the terminal or chat sits
  on its own opaque `--surface` with a hairline and `--radius-lg`; at `<=768px` the header runs edge
  to edge and the drawer is the same glass, each keeping only the edge that faces the content.
- While a phone's soft keyboard is up (`data-keyboard`), `--app-height` follows `visualViewport` so
  the keyboard does not cover input; otherwise the shell is `100dvh`, because an iPhone home screen
  app reports a visual viewport shorter than the screen without a keyboard.
- Header, left to right: the drawer toggle (phone) or the sidebar toggle (desktop); the context (the
  selected pane's mark and title over PC › workspace › folder, or the brand); the Pane / Fleet
  switch, then the Chat / Terminal switch while a pane is shown on the Pane screen; the connection
  chip (herdr version in its tooltip) and the files, palette, alerts and sign-out actions.
- At `<=768px` the header takes a second row, where the two switches share the width as halves with
  their words; at `<=480px`, the brand name, the context's subtitle, the connection's word, the
  offline pill and desktop-only labels shed. Icons and the selected context remain.
- The sidebar is fixed-width on a desktop and a drawer at `<=768px`. The desktop collapse removes
  its column; the drawer uses a scrim and keeps safe-area insets. On touch, a mostly horizontal swipe
  in from the left `24px` edge opens the drawer and a swipe to the left closes it (`56px` of travel).
- The terminal stack holds a positioned terminal surface, then the composer or the key bar. The xterm
  mount stays alive under the chat lens; changing views never opens a second connection.

## 5. Components

### Button (`.btn`, `.icon-button`)
- `.btn` is a text control at `--control-h`, `--radius-md`, `--fs-md`: standard (`--field`, 1px
  `--line`, `--ink`), `.btn-primary` (`--accent`, `--on-accent`, bold; one per screen or card) and
  `.btn-ghost` (no face or edge). A destructive action is never red: a confirm stops it, and the
  confirm's primary button says what happens.
- `.icon-button` is a square icon control with a mandatory `aria-label`.
- Coarse pointers grow controls to `--touch-target`.

### Segmented control (`.segmented`, `Segmented`)
- The track is `--field` with a 1px `--control-edge` edge, `--radius-md`, `3px` inside. Options are
  `28px` high (`--touch-target` on coarse pointers), `--radius-sm`, `--fs-sm`; the rest read in
  `--sub`. The one `aria-pressed="true"` option reads `--ink-strong` on `--tint`, with a 2px
  `--accent` line along its foot.
- `Segmented` (`src/components/Segmented.tsx`) draws it as a named `role="group"`; the arrow keys
  move between its options (Home and End to either end), Enter or Space chooses.
- Used for Pane / Fleet, Chat / Terminal and Settings choices. No other shape switches the same
  thing: not tabs, a row of buttons, or an ornament along the bottom of the screen.

### Field (`.field`, `.input`, `.select`)
- A stacked label (`--fs-xs` medium `--sub`), an optional hint (`--fs-sm` `--sub`) and the field:
  `--input-h`, the `--input` face, 1px `--control-edge`, `--radius-md`, `--fs-input` on every screen.
- Focus makes the edge 2px of `--accent`.

### Notice (`.notice`)
- What went wrong, in words: a `--needs-tint` face, `--needs-text`, `--fs-sm`, `--radius-md`, 10px
  12px inside, `role="alert"`. The confirm, the new session dialog, the folder browser, the prompt
  card, the composer and the transcript use it; the body is a Japanese sentence.

### Badge (`.badge`)
- Agent states read **Idle**, **Working**, **Needs you**, **Done** (`STATUS_WORD` in
  `src/lib/status.ts`); a state herdr does not know has no badge, never a **—** one. A Fleet run adds
  **Failed** and reads the word of the section it sits in: a starting or unknown run reads
  **Working**, and an ended run, folded under its own button, has none.
- A pill at `--chip-h`: a 7px dot, the word in `--ink` at `--fs-xs` medium, a 1px edge and a face.
  The dot and the edge take the state's color; the face is its tint (`--field` for Idle). Only
  Working's dot breathes; the word never fades.
- `.is-dot` (sidebar rows only): the dot alone at 9px, the word visually hidden and in its tooltip;
  Idle's dot is a ring.

### Pill (`.pill`)
- Mono metadata at `--chip-h`: the herdr version in the sidebar footer, a count beside a heading.
  `herdr offline` is the one header pill, on the needs tint.

### Modal (`.modal*`)
- `.modal-scrim` centers an `aria-modal` dialog at `--z-modal`; `.modal` is a capped scrollable column
  with header, body and footer, and one glass panel (`--glass-strong`, 1px `--edge`, `--glass-blur`,
  `--radius-xl`, `--shadow-panel`; `--field` without blur where transparency is reduced). Header,
  body and footer are `--space-4` inside; the title is `--fs-xl`.
- At `<=640px` it becomes a bottom sheet with top `--radius-xl` corners and safe-area padding.
- Escape, explicit close and a scrim click close a dialog; its first meaningful control takes focus.
  Dialogs and their scrims snap open and closed.
- A confirm (`.confirm-dialog`, `alertdialog`, 420px) asks before something that cannot be undone:
  Cancel has the focus, Tab stays between the two buttons, the action (primary) sits at the right,
  and a failure shows inside it. A no gives the focus back to what opened it.

### Menu / popover (`.menu*`)
- Bordered `--radius-lg` surface with `--shadow-pop`; rows use `--control-h`, `--radius-md`, icon,
  ellipsized main label and optional hint.
- Hover or `aria-selected` uses `--field-hover`. Headings are `--fs-xs` medium `--sub`.
- The sidebar's row menu (`.row-menu`) has no button: a right click, a long press on touch
  (`500ms`, a finger that moves `10px` scrolls instead) or the menu key (`Shift+F10`) opens it
  (`src/lib/longPress.ts`). It is a `.menu` drawn through a portal at fixed coordinates, at the
  press (under the row for the key), above it when the screen ends first, and over the drawer.
  The row stays lit while its menu is up, and a held finger starts no text selection or callout.
  A one-pane row offers Rename workspace, Rename pane, then Close under a hairline; a workspace
  header Rename workspace and Close workspace; a pane under a header Rename pane and Close. Close
  is not red. At `<=640px` it is a `.modal` bottom sheet (`.row-sheet`):
  a grip, the row's name and place, 48px rows and a Cancel button; Tab stays among them. Escape, a press outside and
  focus leaving it close it (on a desktop a scroll or a resize too), and focus returns to the
  row. Arrow keys move between items. A row that leaves the roster takes its open menu with it.
- Close follows herdr's `ui.confirm_close`: a close that takes the workspace with it (a one-pane
  row, Close workspace) asks in a confirm first; a pane that leaves its workspace standing closes
  at once. After a confirmed close, focus lands on the header's workspace-list toggle.

### Sidebar
- No top bar. The sidebar opens with **Needs you** and the PC groups. A session starts from the `+`
  on its PC's header, or from the **New session** button in the dashed **No workspaces yet** box of an
  empty PC. Search lives in the command palette, not the sidebar.
- A PC group header is caret, monitor, name, **Host** for the local machine, a state dot (done =
  connected, working pulse = connecting or reconnecting, needs = error), then a `+` that starts a
  session on that PC (disabled while it is offline). Connected says nothing more; every other state
  is written under the name, with the server's error clamped to two lines and complete in the tooltip.
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
- A workspace header shows drag handle, number, editable label and roll-up status dot; its menu
  opens from the header itself, like a row's. Drag and drop reorders; `Alt+↑/↓` on the handle is the
  keyboard equivalent.
- Every pane row is a `--field` face at `--row-h`, `--radius-md`, `--space-1` apart: a 28px agent or
  shell mark, the editable title (`--fs-md`, `--ink`) over the pane's place (mono, `--sub`), then the
  state at the right end as the badge's dot alone. A pane with no agent has no dot. The selected row
  is `--tint` with its title in `--ink-strong` semibold, an `--accent` rail along its left edge and an
  accent-edged mark box: the person's selection is accent, the state stays with the dot. The rows
  under **Needs you** are the same rows, under a heading that says the state in words. No row carries
  a `⋯`: its menu opens from the row. Inline server failures stay beside their row.
- A title that is a working directory written out (`/home/me/dev/api`, `~/dev/api`, `C:\work\api`)
  shows as its last folder, here, in the header, the palette and every alert; the full path stays
  in the row's tooltip. Line two names what the group header does not: the folder under a
  workspace header (nothing when the title or the workspace is already that folder), the workspace under a folder
  header. A merged single-pane row in the workspace view has no header: it names the workspace
  and the folder, each only when the title or the other does not already say it. The palette,
  which has no header, names the workspace and the folder, once when they are the same.
- Single-pane workspaces merge their workspace handle into the pane row, in both groupings: one
  row, no header, number or fold. A fold stored for such a workspace is ignored until it has a
  header again.
- The footer holds the contextual **Install app** action, **Settings**, and the product name with the
  herdr version.

### Header switches and connection
- Both switches live in the header: Pane / Fleet always, Chat / Terminal while a pane is shown on the
  Pane screen. The Fleet option carries the count of runs that need you (a `--needs` number; read out
  as `Fleet: 1 need you`). Choosing Fleet again keeps Fleet: they are choices, not a toggle.
- Connection is one quiet chip: a dot plus the written live / reconnecting / disconnected state;
  reconnecting pulses the dot. On phones the chip keeps only its dot.

### Fleet run card (`.fleet-run`)
- A run on the Fleet screen, in the order it needs you: Needs you, Failed, Working, Done; ended
  runs fold behind a button at the end. Each card is a `--field` face, `--radius-lg`, 1px `--line`.
- **Needs you and Failed** are nearest (`.is-near`): a `--needs` edge, `--shadow-near`,
  `--space-5` inside, the name at 16px semibold in `--ink-strong`. Needs you carries the one primary
  button (`Open pane to answer`) and its reason in a `--needs-tint` notice with `--needs-text`.
- **Working** sits in the middle: no shadow, `--space-3` `--space-4` inside, a standard `Open pane`
  and a quiet `Interrupt`. Runs a run started indent `28px` per level under it.
- **Done** recedes at opacity 0.72; an ended run at 0.6.
- The badge is the app's `.badge` with the section's word; role, CLI and model are mono `--sub`,
  joined by `·`; the elapsed time is mono at `--fs-2xs`. Section headings are `--fs-xs` medium
  `--sub` in the UI face.
- Usage capsules are `--field` pills with a 1px `--line` (a low one `--meter-low`, a cooldown a
  dashed `--needs`); `Refresh usage` ends their row. Buttons are the app's `.btn`.

### New session dialog
- Agent select comes from `GET /api/agents`; shell-only is always available. Directory defaults to
  the selected pane cwd and name is an optional workspace label.
- Submit calls `POST /api/workspace/create`; the server performs `workspace.create` and, when an
  agent was chosen, `agent.start` in its root pane. Pending and partial agent-start failure are
  explicit before the created pane opens.

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

### Work block (`.work-block`, `.work-row`)
- One per assistant turn: a `▸ Worked for 7s · 1 edit · 2 commands` header (duration = next turn's
  timestamp minus this one's; "Working…" in `--working` behind a breathing dot while the agent runs)
  over one-line rows `▸ [icon] name / summary` in mono, indented under the header; mid-work narration
  sits between rows as dim, one-step-smaller prose. The newest turn opens by default, older ones fold.
  A row expands to the typed input (command, diff, file, checklist, raw) and an Output pane. A failed
  row carries a **Failed** tag on the needs tint.

### Prompt card (`.prompt-card`)
- Appears in chat while the agent is blocked and the visible pane contains a supported Claude, omp,
  pi or codex question, approval or plan menu. It needs you, so it is the nearest card: `--field`,
  a `--needs` edge, `--shadow-near`, `--radius-lg`; its title at `--fs-lg` semibold. The agent's
  own text (`.prompt-card-body`) is in the UI face, not mono. One primary at a time: Send is
  primary only while no option is checked.
- Single options submit immediately; multi-select exposes checks plus Submit; supported custom input
  has its own labelled field. The prompt content hash rejects a stale answer with `prompt_changed`.
- Options are full-width rows (`.prompt-card-option`): the menu's number in mono, the label, its
  description under it in `--sub` (`--fs-md` over `--fs-sm`). No option is filled as a default; a
  checked or typed pick gets `--tint` + an `--accent` border. A `(Recommended)` suffix renders as a
  pill tag in `--sub`.
- `POST /api/pane/prompt/answer` translates the chosen answer into the agent's navigation keys and
  sends them through herdr `pane.send_keys` / text input. The card never fabricates a chat reply.

### Composer (`.composer`)
- Chat mode is ONE reading surface: the stack, the transcript and the composer region all sit on
  the opaque `--surface`, never glass, and the composer column equals the transcript column
  (`--content-w`, same `--space-4` gutter). The only box is the input: `--input`, 1px
  `--control-edge`, `--radius-lg`, no shadow; focus makes its edge 2px of `--accent` (no inner
  outline). Its buttons are `--radius-md`, `--touch-target` on coarse pointers; Send is the one
  primary, Stop a standard button. Above it the agent/status line and the
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
- `Mod+Shift+K` opens a top-offset `--palette-w` dialog searching panes and actions. Recent panes lead
  an empty query; arrows cycle, Enter activates and Escape closes.
- Actions: New session, Switch to chat / terminal, Rename pane, Close pane, Toggle sidebar, Toggle
  theme, Settings, Enable notifications, Sign out, Browse files and Refresh, the conditional ones
  only when they apply, with `.kbd` hints where a global shortcut exists.
- Rename pane and Close pane act on the selected pane, as its row's menu does: Rename brings the row
  into view (the drawer on a phone, the sidebar on a desktop) and opens its name field; Close asks
  first when the pane is its workspace's last (`closePaneEvent` in `Sidebar.tsx`, shared with the
  row menu).

### Settings dialog
- The dialog is the modal's glass panel; each section is a `--field` card (`--radius-lg`, 1px
  `--line`, `--space-4` inside and between). An item's name is English at `--fs-md`; its description
  is a Japanese sentence at `--fs-sm` `--sub` under it. A toggle that is on is an `--accent` track
  with an `--on-accent` knob at the right; off, a `--field` track with a `--control-edge` edge and a
  `--sub` knob at the left.
- Sections: **Appearance** (theme, density, sidebar grouping, terminal font size and font, terminal
  input, wheel scroll speed), **Composer** (Enter sends, suggestion chip), **Chat** (panes open in,
  show thinking, chat font size and font), **Alerts** (Needs you, Done, In the app, a test
  notification), **Quick replies**, **Shortcuts** (the complete platform-resolved table), **Phone**
  (reaching this server from a phone, keep screen on), **Devices** (paired devices and pairing),
  **Install** and **About**.
- A font family is a text field saved when it is left, on Enter or when the dialog closes, not per
  keystroke.
- Revoking a paired device asks in a confirm (`Revoke <name>?`, a Japanese sentence on what it
  means, Revoke as the primary); a no keeps the device and Settings open.

### Keyboard hint (`.kbd`)
- An inline mono keycap: `18px` high, a strong bottom edge, `--radius-sm`, `--fs-2xs`.
- `Mod` resolves to `⌘` on Apple platforms and `Ctrl` elsewhere.

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
- A centered glass panel on the ground replaces the entire shell while authentication is required
  (`--glass`, `--radius-xl`, `--shadow-panel`; `--field` where transparency is reduced). It has a
  real label (`--fs-xs` `--sub`), an autofocused 44px field, the one primary button and a notice
  for a refusal.
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
| Standard | `--dur-base` | `180ms` | Drawer slide, a card's lift |
| Pulse | `--dur-pulse` | `1600ms` | Working and reconnecting dots (trough opacity 0.35; text never pulses) |
| Easing | `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | Finite transitions |
| Pulse easing | `--ease-pulse` | `steps(2, jump-none)` | Endless working and reconnecting dots; avoids drawing every display refresh |

### Rules
- Only state changes move: hover and press, the drawer, settings switches, working and reconnecting
  dots, a Fleet card lifting under the pointer, and the in-app alert.
- Dialogs and their scrims snap open and closed; on a phone their static layout is a bottom sheet.
- `prefers-reduced-motion: reduce` removes pulses, drawer and control transitions, the card lift,
  smooth chat scrolling and toggle motion. State remains legible without animation.

## 7. Depth & Surface

### Strategy

**Tonal shift and hairlines, with shadow reserved for glass panels, the nearest cards and overlays.**
Parts inside a panel have no shadow.

| Type | Value | Usage |
|------|-------|-------|
| Hairline | `var(--hairline) solid var(--line)` | Groups, cards, standard buttons |
| Control edge | `var(--hairline) solid var(--control-edge)` | Fields, segmented tracks, toggles |
| Strong edge | `var(--line-strong)` | Hover separation |
| Dashed edge | `var(--hairline) dashed var(--line)` | Empty states |
| Tonal lift | `--field` on `--surface` or the ground | Rows, cards, tracks |
| Tinted lift | A state's tint over an opaque face | Badges, notices, selection |
| Panel shadow | `--shadow-panel` (`inset 0 1px 0 var(--glass-hi), 0 14px 36px var(--glass-shadow)`) | Glass panels |
| Near shadow | `--shadow-near` (`0 0 24px var(--needs-tint), 0 14px 36px var(--glass-shadow)`) | A card that needs the person: Needs you and Failed runs, the prompt card |
| Drawer shadow | `--shadow-drawer` | Mobile drawer |
| Overlay shadow | `--shadow-pop` | Menus, the palette, the new messages pill |

### Glass layers

One layer of glass floats over the ground (`--bg` and its glows): the header, the sidebar, dialogs,
the row sheet, the Fleet run's detail sheet and the access gate. Everything inside a panel, and
every card on the ground (the Fleet screen's run cards and usage capsules), is an opaque `--field`
face: glass is never stacked.

| Token | Use |
|-------|-----|
| `--glow-1/2/3` | The ground: three soft radial glows over `--bg` (never on text or parts) |
| `--glass`, `--glass-strong` | A panel's fill: `--glass` for the header, the sidebar and the access gate, `--glass-strong` for a dialog or sheet that lies over cards |
| `--edge`, `--glass-hi` | A panel's 1px edge and the inset highlight along its top |
| `--glass-blur` | A panel's `backdrop-filter` |
| `--glass-shadow` | Depth: the nearer a layer, the larger its shadow |

- Depth carries meaning: what needs the person is nearest (`--shadow-near`, a `--needs` edge),
  working cards sit in the middle (no shadow), finished work recedes (opacity 0.72).
- `prefers-reduced-transparency: reduce` and browsers without `backdrop-filter` get an opaque
  `--field` panel without blur.
- The terminal and the chat transcript never sit on glass.

## 8. Accessibility Constraints & Accepted Debt

### Constraints
- WCAG 2.2 AA is the target; do not document numeric contrast without measuring both shipped themes
  and every actual backing surface. The design system lists the measured pairs.
- Global `:focus-visible` uses `--ring`; a field shows focus on its own 2px edge. Interactive controls
  remain keyboard reachable except the touch key bar, which intentionally preserves terminal focus
  and has hardware-key equivalents. A sidebar row's menu opens from the keyboard with the menu key.
- Icon-only controls carry `aria-label`; toggles expose `aria-pressed` or `role="switch"`; segmented
  controls are named groups; the selected pane exposes `aria-current`; dialogs expose `role="dialog"`
  and `aria-modal`.
- Status, loading and composer progress use `role="status"`; failures use `role="alert"`. Agent state
  is a word plus color; a dot alone carries the word as its accessible name.
- Touch targets grow to `--touch-target`; fields stay at `--fs-input` so a phone does not zoom.
- `prefers-reduced-motion` and `prefers-reduced-transparency` are honored. Lucide and inline SVG
  decoration is hidden from assistive tech.
- Global shortcuts use the convention **Mod+Shift+key**: Mod is Command on Apple platforms and Ctrl
  elsewhere. The settings table is the discoverable source of the complete mapping.
- `document.title` is `<pane title> · herdr` while a pane is selected, otherwise `herdr fleet`.

### Accepted debt

| Item | Location | Why accepted | Exit |
|------|----------|--------------|------|
| Terminal content accessibility relies on xterm defaults | `PaneTerminal.tsx` | Screen-reader mode changes terminal DOM and input behavior | Decide with herdr TUI owners |
| Drawer has no focus trap | `.sidebar.is-open` | Closed state leaves the tab order, but open-state trapping is not implemented | Add a shared focus utility |
| Modal focus is initialized, not fully trapped | Dialog components | Escape/scrim/close work; tab containment is not shared | Add the same focus utility |
| Terminal colors exist in CSS and JavaScript | `styles.css`, `settings.ts` | xterm consumes a JS theme | Keep `terminalTheme()` verbatim with `--term-*` |
