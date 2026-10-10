import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { TriangleAlert } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import "./PaneTerminal.css";

import { controlCode, isPrintable, keySequence, type KeyBarKey } from "../lib/keys.ts";
import { EMPTY_DRAFT, draftIsEmpty } from "../lib/draft.ts";
import { QUEUE_READY_STATUS } from "../lib/compose.ts";
import { answerHint } from "../lib/promptAnswer.ts";
import { fetchPaneScroll, fetchPaneSelection, scrollPane } from "../lib/api.ts";
import { parseOsc52 } from "../lib/osc52.ts";
import { matchHerdrWidths } from "../lib/terminalWidths.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { paneStorageId } from "../../shared/machines.ts";
import { KeyBar, type KeyBarEvent } from "./KeyBar.tsx";
import type { Emit } from "../ui/bubble.ts";
import { useSelected, useTerminal } from "../ui/presenter.ts";
import { NO_SESSION, type PaneCommand, type PaneSessionEvent, type UiEvent } from "../ui/state.ts";
import { QueuePresenter, type QueueUpEvent } from "../ui/QueuePresenter.tsx";
import type { TerminalInputEvent } from "./TerminalInput.tsx";
import { TerminalInputPresenter } from "../ui/TerminalInputPresenter.tsx";
import { SecretInput } from "./SecretInput.tsx";
import { secretPrompt } from "../../shared/secret-prompt.ts";
import { ChatPresenter, type ChatUpEvent } from "../ui/ChatPresenter.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { ComposerPresenter, type ComposerUpEvent } from "../ui/ComposerPresenter.tsx";
import type { AgentStatus, ClientRole } from "../../shared/protocol.ts";
import type { PaneView } from "../lib/actions.ts";
import { useSettings, terminalTheme, type ResolvedTheme } from "../lib/settings.ts";
import { loadFontStack, TERMINAL_FONT_STACK, terminalFontStack } from "../lib/fontFamily.ts";
import { t } from "../lib/i18n.ts";
import { isAppShortcut } from "../lib/shortcuts.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { fileUriPath, terminalFileLinkProvider } from "../lib/terminalFileLinks.ts";
import { adjustTerminalGlyphs } from "../lib/terminalGlyphs.ts";

/** How long a resize must rest before the grid refits and the pty follows it. */
const RESIZE_SETTLE_MS = 120;

export interface PaneTerminalProps {
  /** The pane this terminal attaches to; null renders the placeholder. */
  paneId: string | null;
  /**
   * herdr's reason it could not restore the selected pane (0.9.3+): the pane has no
   * terminal to attach, so App passes a null paneId and the placeholder says why.
   */
  restoreError?: string | null;
  /** the pane's agent name — the chat lens labels the assistant's voice with it */
  agent?: string | null;
  /** the pane's live agent status: `working` turns composer sends into the queue */
  agentStatus?: AgentStatus;
  /** the lens over the pane: the chat transcript, or the live xterm grid (App remembers it per pane) */
  view: PaneView;
  /** App selected this pane itself (the selected one closed): switching to it must not take the keyboard */
  autoSelected?: boolean;
  /** xterm font size (settings) */
  terminalFontSize: number;
  /** mouse reports sent per wheel event (settings): 1 is xterm's own one report */
  terminalWheelSpeed: number;
  /** fonts tried before the built-in stack (settings); "" keeps the built-in one */
  terminalFontFamily: string;
  /** the resolved UI theme: the xterm theme object mirrors it */
  theme: ResolvedTheme;
  /** The connection's desired role; changes are sent to the server, its ack goes up as role-ack. */
  role?: ClientRole;
  /** Fires with the server-confirmed role (the header toggle shows it). */
  /** Fires on every change of the socket's connected state (the header shows it). */
  /** Every server frame also reaches App: it merges pane-status and schedules refetches. */
  /** what the terminal's socket says of the pane, and what the views inside it send, up to the Root */
  emit: Emit<Extract<PaneSessionEvent, { type: "pane-attached" | "pane-output" | "dismiss-input-error" }>
    | Extract<UiEvent, { type: "open-pane-socket" | "close-pane-socket" | "pane-command" | "draft-open" | "draft-input" | "send-draft" | "discard-draft"
      | "chat-pending-answer-done"
      | "queue-open" | "queue-edit" | "queue-discard" | "composer-draft" | "line-draft" | "composer-send" | "line-send" | "queue-send"
      | "completions-open" | "file-query" | "slash-used" | "attach-files" | "remove-attachment" | "attachments-sent" | "attachments-close" }> | ChatUpEvent>;
}

/** Whether this device types in the terminal's input line or straight into the grid: remembered per device. */
const DIRECT_TYPING_KEY = "herdr-fleet:direct-typing";

function storedDirectTyping(): boolean {
  try { return window.localStorage.getItem(DIRECT_TYPING_KEY) === "1"; } catch { return false; }
}

/** A touch screen as the main pointer: its soft keyboard is what the input line is for. */
function useCoarsePointer(): boolean {
  const query = "(pointer: coarse)";
  const [coarse, setCoarse] = useState(() => typeof window !== "undefined" && window.matchMedia?.(query).matches === true);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const onChange = (): void => setCoarse(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return coarse;
}
export function PaneTerminal({
  paneId,
  restoreError = null,
  agent = null,
  agentStatus,
  view,
  autoSelected = false,
  terminalFontSize,
  terminalWheelSpeed,
  terminalFontFamily,
  theme,
  role = "interact",
  emit,
}: PaneTerminalProps) {
  const openFile = useContext(OpenFileContext);
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;
  const machineId = useMachineId();
  const { uploadPaneImage } = useMachineApi();
  const uploadFileRef = useRef(uploadPaneImage);
  uploadFileRef.current = uploadPaneImage;
  const chatView = view === "chat";
  const chatViewRef = useRef(chatView);
  chatViewRef.current = chatView;
  /** read by the wheel handler, which is attached once for the terminal's life */
  const wheelSpeedRef = useRef(terminalWheelSpeed);
  wheelSpeedRef.current = terminalWheelSpeed;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const paneRef = useRef<string | null>(paneId);
  const emitRef = useRef(emit);
  emitRef.current = emit;
  // the Mediator owns the socket: its messages reach the grid through the sink, keystrokes go out through the link
  const { attachTerminal, terminalLink: link } = useTerminal();
  /** what the grid asks of its socket: the pane shown, its size, the role */
  const command = useCallback((asked: PaneCommand) => emitRef.current({ type: "pane-command", machineId, command: asked }), [machineId]);
  // the attached pane as its socket told the Mediator; until it attached, nothing of it is known
  const told = useSelected((state) => state.pane.session);
  const { outputReady, ended, inputError, inputReady, outputError, unsupported, held } = told.paneId === paneId ? told : NO_SESSION;
  const connected = useSelected((state) => state.pane.connected);
  const observing = useSelected((state) => state.pane.role === "observe");
  // what the socket handlers read mid-stream: stdin, onData and the composer's submit
  const heldRef = useRef(false);
  // one-shot Control from the key bar: the ref is what onData reads, the state is what the bar shows
  const composingRef = useRef(false);
  const [composing, setComposingState] = useState(false);
  const setComposing = useCallback((active: boolean) => { composingRef.current = active; setComposingState(active); }, []);
  const ctrlRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  // observe mode: the ref is what onData and the resize listeners read mid-stream
  const observeRef = useRef(false);
  // a mirrored pane (no terminal attach on its PC): the grid is the pane's own in herdr, adopted like an observer's
  const fixedGridRef = useRef(false);
  // the pty's grid as the server last said it for this pane (pane-geometry), whoever set it
  const sharedGridRef = useRef<{ cols: number; rows: number } | null>(null);
  const secretRef = useRef<string | null>(null);
  const maskedPrompt = told.paneId === paneId ? told.secret : null;
  const secretActive = maskedPrompt !== null;
  // a touch screen writes in the terminal's input line; typing straight into the grid is chosen
  const coarse = useCoarsePointer();
  // A touch screen reads a pane before it answers: picking a pane or a lens there never raises the
  // keyboard by itself, only a tap on the message box or the grid does. A desktop has no keyboard
  // to raise, and the pane it picks takes the typing at once.
  const coarseRef = useRef(coarse); coarseRef.current = coarse;
  // A viewport sizes the pane only while it is in front on a touch screen (a phone's terminal
  // lens), and lets go when it leaves (keep-size). A desktop draws herdr's own grid: herdr's screen
  // sits beside it, and a tab left open must not hold the pane at its size, or herdr's screen
  // shows the top of a taller grid and loses the prompt under its bottom edge.
  const drives = (): boolean => coarseRef.current && !observeRef.current && !fixedGridRef.current
    && !chatViewRef.current && document.visibilityState === "visible";
  const { settings, update: updateSettings } = useSettings();
  const shortcutSettings = useRef(settings.shortcutOverrides);
  shortcutSettings.current = settings.shortcutOverrides;
  const directTyping = settings.terminalInputMode === "direct" || (settings.terminalInputMode === "auto" && (!coarse || storedDirectTyping()));
  const inputLine = !directTyping && !chatView;
  const inputLineRef = useRef(inputLine);
  inputLineRef.current = inputLine;
  // input typed while the terminal could not take it, held for the user to review and send (the Mediator keeps it)
  const heldInput = useSelected((state) => state.pane.draft);
  const draft = paneId !== null && heldInput.owner === paneStorageId(machineId, paneId) ? heldInput.value : EMPTY_DRAFT;
  // transient OSC 52 feedback ("copied") — a pill in the banner column
  const [clipboardNote, setClipboardNote] = useState<string | null>(null);
  const clipboardTimerRef = useRef<number | null>(null);
  // what the chat lens shares with the composer (the Mediator keeps it): the prompt waiting on this pane, a pick
  // typed for it, the agent's suggestion and the settings the conversation reported
  // each one apart: the chat region changes with every read, which must not re-render the terminal
  const chatPrompt = useSelected((state) => (paneId !== null && state.chat.open?.paneId === paneId ? state.chat.prompt : null));
  const pendingAnswer = useSelected((state) => (paneId !== null && state.chat.open?.paneId === paneId ? state.chat.pendingAnswer : null));
  const chatSuggestion = useSelected((state) => (paneId !== null && state.chat.open?.paneId === paneId ? state.chat.suggestion : null));
  const chatMetadata = useSelected((state) => (paneId !== null && state.chat.metadata?.paneId === paneId ? state.chat.metadata.value : null));
  // back at work, the agent has had its answer, maybe from the terminal: the same prompt asked
  // again before the chat's next read must not bring the pick back either
  useEffect(() => {
    if (agentStatus === "working") emitRef.current({ type: "chat-pending-answer-done" });
  }, [agentStatus]);
  const queueOwner = paneId === null ? null : paneStorageId(machineId, paneId);

  paneRef.current = paneId;
  // what a message sent now goes with: held while the agent works
  const agentRef = useRef(agent); agentRef.current = agent;
  const agentStatusRef = useRef(agentStatus); agentStatusRef.current = agentStatus;

  const noteClipboard = useCallback((note: string) => {
    if (clipboardTimerRef.current !== null) window.clearTimeout(clipboardTimerRef.current);
    setClipboardNote(note);
    clipboardTimerRef.current = window.setTimeout(() => {
      clipboardTimerRef.current = null;
      setClipboardNote(null);
    }, 2500);
  }, []);

  // Install before the pane layout effect so resets cancel pending input before the next task.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // xterm activates a link whenever a press and its release land on it: a drag that selects
    // part of a path and a right click do too, and neither means "open this"
    const linkPressed = (event: MouseEvent): boolean => event.button === 0 && !term.hasSelection();
    const term = new Terminal({
      convertEol: false,
      // a steady cursor: a blinking one draws the eye on every pane that waits for input
      cursorBlink: false,
      // xterm keeps no scrollback: the attach stream lives in the alternate screen and herdr
      // owns scrollback (wheel and touch go to it). With scrollback on, the fit addon reserves
      // a scrollbar column - 15px by fallback wherever scrollbars are overlays - and the last
      // columns of the hero surface go dead.
      scrollback: 0,
      allowProposedApi: true,
      fontSize: terminalFontSize,
      // a chosen family follows in the font effect below, once its faces have loaded
      fontFamily: TERMINAL_FONT_STACK,
      theme: terminalTheme(theme),
      linkHandler: {
        activate: (event, uri) => {
          if (!linkPressed(event)) return;
          const path = fileUriPath(uri);
          if (path !== null) openFileRef.current?.(path);
          else if (/^https?:\/\//i.test(uri)) window.open(uri, "_blank", "noopener,noreferrer");
        },
        allowNonHttpProtocols: true,
      },
      // Option+drag selects on macOS, as Shift+drag does elsewhere; a plain drag is forced below
      macOptionClickForcesSelection: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    matchHerdrWidths(term);
    // an address in the terminal opens in a new tab; the page never navigates away from the pane
    term.loadAddon(new WebLinksAddon((_event, uri) => { window.open(uri, "_blank", "noopener,noreferrer"); }));
    term.registerLinkProvider(terminalFileLinkProvider(() => term.buffer.active, (path, event) => { if (linkPressed(event)) openFileRef.current?.(path); }));
    term.open(host);
    const compositionStart = () => setComposing(true);
    const compositionEnd = () => setComposing(false);
    host.addEventListener("compositionstart", compositionStart);
    host.addEventListener("compositionend", compositionEnd);
    const stopGlyphs = adjustTerminalGlyphs(term);
    // Let the browser emit a paste event, which xterm already handles (including
    // bracketed paste). Otherwise Ctrl+V becomes 0x16, triggering the agent's
    // image-paste shortcut against the server's clipboard and canceling text paste.
    // Returning false skips xterm's key handling without preventing browser defaults.
    // With text selected, Ctrl+C (and Ctrl+Shift+C) copies it instead of interrupting the pane.
    // A non-Latin layout (Korean, Russian...) reports its own character as the key, so the
    // physical key names the letter then; a Latin layout keeps its own (Dvorak's C is not KeyC).
    // An app shortcut is the app's alone: xterm would still type it, and Ctrl+Shift+↓ reached the
    // pane it had just switched to as ESC[1;6B.
    term.attachCustomKeyEventHandler((event) => {
      if (isAppShortcut(event, shortcutSettings.current)) return false;
      if (!event.ctrlKey || event.altKey || event.metaKey) return true;
      const typed = event.key.toLowerCase();
      const key = /^[a-z]$/.test(typed) ? typed : /^Key([A-Z])$/.exec(event.code)?.[1]?.toLowerCase() ?? typed;
      if (key === "v") return false;
      if (key === "c" && term.hasSelection()) {
        if (event.type === "keydown") {
          event.preventDefault();
          copySelection();
          term.clearSelection();
        }
        return false;
      }
      return true;
    });
    // herdr reads the wheel as mouse reports. Were reporting ever off, xterm would turn
    // a wheel into arrow keys, which walk an agent's prompt history instead of scrolling.
    // A selecting drag takes the wheel itself (see below); after one, a wheel scrolls the
    // highlight's text away, so the highlight goes with it.
    // xterm sends one mouse report per wheel event whatever its delta, so herdr scrolls
    // the same few lines per notch: at a wheel speed above 1 a real wheel is replayed to send
    // that many reports. The replays and the touch translation below are untrusted, so neither
    // repeats. A replay is the same event, keys held included: xterm ignores a wheel with
    // Shift down, and a replay without it scrolled where the wheel itself did not.
    term.attachCustomWheelEventHandler((event) => {
      if (drag) {
        dragWheel(event);
        return false;
      }
      // a terminal that reports nothing to herdr leaves the wheel to the browser, to pan the mount
      if (reportsNothing()) return false;
      if (term.hasSelection()) term.clearSelection();
      const reporting = term.modes.mouseTrackingMode !== "none";
      // a trackpad pinch arrives as a wheel with Ctrl down: it is not scrolling, and goes once as before
      if (reporting && event.isTrusted && event.target && !event.ctrlKey) {
        for (let sent = 1; sent < wheelSpeedRef.current; sent += 1) {
          event.target.dispatchEvent(new WheelEvent("wheel", {
            bubbles: true, cancelable: true, deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
            clientX: event.clientX, clientY: event.clientY,
            ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
          }));
        }
      }
      return reporting;
    });
    termRef.current = term;
    fitRef.current = fit;

    // A grid that is not this browser's own (herdr's, or another device's) may be larger than
    // the mount. The mount then scrolls (PaneTerminal.css) and a drag pans it. Until the user
    // pans, the view keeps the cursor's row in sight: the top of the grid while the row fits
    // there, else the bottom rows, where a prompt sits. A mirror has no cursor; xterm's own
    // rests on the last row with text, which serves the same.
    const adopted = (): boolean => !drives();
    // A grid this view does not size still takes its wheel and drags to herdr, which scrolls the
    // pane's history; only an observer (its reports are dropped) and a mirror (it reports nothing)
    // have none to send them to.
    const reportsNothing = (): boolean => observeRef.current || fixedGridRef.current;
    let panned = false;
    const followCursor = (): void => {
      host.toggleAttribute("data-adopted-grid", adopted());
      const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
      if (!adopted() || panned || !screen) return;
      const row = screen.offsetHeight / term.rows;
      const cursorBottom = screen.offsetTop + (term.buffer.active.cursorY + 1) * row;
      const max = host.scrollHeight - host.clientHeight;
      host.scrollTop = cursorBottom <= host.clientHeight ? 0 : cursorBottom - row >= max ? max : cursorBottom - host.clientHeight;
    };

    /** herdr's text for the last drag, while its highlight is still the selection */
    let copiedText: string | null = null;
    let selectionGeneration = 0;
    let disposed = false;
    // Run after xterm's own copy listener, including for Cmd+C and context-menu
    // Copy. Its buffer contains only the visible part of a scrolled selection.
    const onCopy = (event: ClipboardEvent): void => {
      if (!term.hasSelection() || copiedText === null || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", copiedText);
      event.preventDefault();
    };
    host.addEventListener("copy", onCopy);
    const copySelection = (): void => {
      const text = copiedText ?? term.getSelection();
      if (!text) return;
      // Native copy still works in a user gesture when a Chromium/PWA site has
      // denied the async clipboard permission, or plain HTTP has no clipboard API.
      if (document.execCommand("copy")) {
        noteClipboard("copied to clipboard");
        return;
      }
      if (!navigator.clipboard) {
        noteClipboard("clipboard write blocked by the browser");
        return;
      }
      void navigator.clipboard.writeText(text).then(
        () => { if (!disposed) noteClipboard("copied to clipboard"); },
        () => { if (!disposed) noteClipboard("clipboard write blocked by the browser"); },
      );
    };
    const selectionChange = term.onSelectionChange(() => {
      if (!term.hasSelection()) {
        copiedText = null;
        selectionGeneration++;
      }
    });

    // herdr's attach stream turns mouse reporting on, so xterm hands every click to the
    // pty and selects only with Shift (Option on macOS) held. `herdr terminal attach`
    // ignores left clicks and drags - selection lives in herdr's own TUI client - so a
    // left drag here selects as if the modifier were held, and letting go copies, as the
    // herdr TUI does. Touch keeps its drag-to-scroll.
    //
    // xterm keeps no scrollback (herdr owns it), so a drag that outlives one screen is
    // tracked in herdr's history rows: a wheel, or dragging past the top or bottom edge,
    // scrolls the pane through the API, the highlight is repainted over the visible part,
    // and letting go copies herdr's own text for the range, soft-wrapped lines joined.
    // Without the API (plain HTTP, observe mode, an older remote bridge, a failed read)
    // only the visible selection is copied, as xterm has it.
    interface Cell { row: number; col: number }
    interface Drag {
      pane: string;
      /** the pressed cell on screen */
      anchor: Cell;
      /** the cell under the pointer on screen, its row clamped to the screen */
      cursor: Cell;
      /** the history row at the top of the screen, once herdr has told us */
      top: number | null;
      /** the pressed cell's history row */
      anchorRow: number;
      offset: number;
      maxOffset: number;
      /** the drag left the first screen: it is painted here, not by xterm */
      scrolled: boolean;
      /** pointer beyond the top (-1) or bottom (1) edge, which keeps scrolling */
      edge: -1 | 0 | 1;
      wheelPixels: number;
      sentOffset: number;
      sending: boolean;
    }
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    let drag: Drag | null = null;
    let edgeTimer: number | null = null;
    const cellAt = (event: MouseEvent): { cell: Cell; edge: -1 | 0 | 1 } => {
      const rect = (term.element?.querySelector(".xterm-screen") ?? host).getBoundingClientRect();
      const col = Math.floor((event.clientX - rect.left) / (rect.width / term.cols));
      const row = Math.floor((event.clientY - rect.top) / (rect.height / term.rows));
      return {
        cell: { row: Math.max(0, Math.min(term.rows - 1, row)), col: Math.max(0, Math.min(term.cols - 1, col)) },
        edge: row < 0 ? -1 : row >= term.rows ? 1 : 0,
      };
    };
    const ordered = (a: Cell, b: Cell): [Cell, Cell] =>
      a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
    /** the drag's range in history rows, both ends inclusive */
    const historyRange = (d: Drag): [Cell, Cell] =>
      ordered({ row: d.anchorRow, col: d.anchor.col }, { row: d.top! + d.cursor.row, col: d.cursor.col });
    const repaint = (d: Drag): void => {
      const [start, end] = historyRange(d);
      const first = d.top!;
      const last = first + term.rows - 1;
      if (end.row < first || start.row > last) {
        term.clearSelection();
        return;
      }
      const from = start.row < first ? { row: 0, col: 0 } : { row: start.row - first, col: start.col };
      const to = end.row > last ? { row: term.rows - 1, col: term.cols - 1 } : { row: end.row - first, col: end.col };
      term.select(from.col, from.row, to.row * term.cols + to.col + 1 - (from.row * term.cols + from.col));
    };
    /** one request at a time; the latest wanted offset wins */
    const sendScroll = (d: Drag): void => {
      if (d.sending || d.sentOffset === d.offset) return;
      d.sending = true;
      const target = d.offset;
      void scrollPane(d.pane, target, machineId).catch(() => {}).finally(() => {
        d.sending = false;
        d.sentOffset = target;
        sendScroll(d);
      });
    };
    /** positive lines show older text */
    const scrollDrag = (d: Drag, lines: number): void => {
      if (d.top === null) return;
      const offset = Math.max(0, Math.min(d.maxOffset, d.offset + lines));
      if (offset === d.offset) return;
      d.offset = offset;
      d.top = d.maxOffset - offset;
      d.scrolled = true;
      repaint(d);
      sendScroll(d);
    };
    const dragWheel = (event: WheelEvent): void => {
      const d = drag;
      if (!d || d.top === null) return;
      const lineHeight = (term.element?.querySelector(".xterm-screen")?.getBoundingClientRect().height ?? term.rows) / term.rows;
      d.wheelPixels += event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * lineHeight : event.deltaY;
      const lines = Math.trunc(d.wheelPixels / lineHeight);
      if (lines === 0) return;
      d.wheelPixels -= lines * lineHeight;
      scrollDrag(d, -lines);
    };
    const stopEdge = (): void => {
      if (edgeTimer !== null) window.clearInterval(edgeTimer);
      edgeTimer = null;
    };
    const onMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0) return;
      if ((event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents) return;
      if (!term.element?.contains(event.target as Node)) return;
      // with reporting off xterm already selects on a plain drag; only the history tracking is ours
      if (term.modes.mouseTrackingMode !== "none") Object.defineProperty(event, isMac ? "altKey" : "shiftKey", { value: true });
      copiedText = null;
      selectionGeneration++;
      const pane = paneRef.current;
      const { cell } = cellAt(event);
      const d: Drag = {
        pane: pane ?? "", anchor: cell, cursor: cell, top: null, anchorRow: 0, offset: 0, maxOffset: 0,
        scrolled: false, edge: 0, wheelPixels: 0, sentOffset: 0, sending: false,
      };
      drag = d;
      if (!pane || !navigator.clipboard || observeRef.current) return;
      void fetchPaneScroll(pane, machineId).then((scroll) => {
        if (!scroll || drag !== d || d.scrolled) return;
        d.offset = d.sentOffset = scroll.offset_from_bottom;
        d.maxOffset = scroll.max_offset_from_bottom;
        d.top = d.maxOffset - d.offset;
        d.anchorRow = d.top + d.anchor.row;
      }, () => {});
    };
    // capture on window: ahead of xterm's own document listener, which would repaint a
    // scrolled drag from its stale screen anchor
    const onMouseMove = (event: MouseEvent): void => {
      const d = drag;
      if (!d) return;
      const { cell, edge } = cellAt(event);
      // past an edge the edge row is taken whole, as xterm does
      d.cursor = edge < 0 ? { row: 0, col: 0 } : edge > 0 ? { row: term.rows - 1, col: term.cols - 1 } : cell;
      if (d.top === null) return;
      if (edge !== d.edge) {
        d.edge = edge;
        stopEdge();
        if (edge !== 0) edgeTimer = window.setInterval(() => scrollDrag(d, -d.edge), 60);
      }
      if (d.scrolled || edge !== 0) {
        event.stopPropagation();
        // painted here from now on, even where herdr has no further to scroll
        d.scrolled = true;
        repaint(d);
      }
    };
    // a release outside the window never arrives: stop scrolling the shared pane
    const onBlur = (): void => {
      stopEdge();
      drag = null;
    };
    const onMouseUp = (event: MouseEvent): void => {
      const d = drag;
      if (!d || event.button !== 0) return;
      drag = null;
      stopEdge();
      // Window bubble runs after xterm's document listener, still inside the
      // release gesture. A timer here loses clipboard permission in some browsers.
      if (d.scrolled) repaint(d);
      if (!term.hasSelection()) return;
      const visibleText = term.getSelection();
      copiedText = visibleText;
      copySelection();
      const generation = selectionGeneration;
      const current = (): boolean => !disposed && paneRef.current === d.pane && generation === selectionGeneration;
      let range: [Cell, Cell] | null = null;
      if (d.scrolled) range = historyRange(d);
      else if (d.top !== null) {
        const position = term.getSelectionPosition();
        if (position) {
          // xterm's end column is exclusive, herdr's inclusive
          const end = position.end.x > 0
            ? { row: d.top + position.end.y, col: position.end.x - 1 }
            : { row: d.top + position.end.y - 1, col: term.cols - 1 };
          range = [{ row: d.top + position.start.y, col: position.start.x }, end];
        }
      }
      if (!range) return;
      const text = fetchPaneSelection(d.pane, range[0], range[1], machineId).catch(() => {
        if (current() && d.scrolled) noteClipboard("could not read the selection from herdr");
        return visibleText;
      }).then((value) => {
        if (!current()) throw new Error("selection changed");
        // A redraw can remove the range before herdr reads it. Keep what the user
        // actually selected instead of replacing a successful copy with nothing.
        copiedText = value || visibleText;
        return copiedText;
      });
      // Reserve the write NOW, supplying the server text when it arrives. Never
      // start a fresh clipboard write from a delayed response or an older drag.
      if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
        void blob.catch(() => {});
        // Denied (the case native copy covers), the clipboard keeps only the visible rows of a
        // scrolled drag: say so, since the whole text waits for an explicit Copy or Ctrl+C
        void navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]).catch(() => {
          if (current() && d.scrolled) noteClipboard("copied the visible part; Copy or Ctrl+C copies the whole selection");
        });
      } else {
        // Native copy already captured the visible text; the full text stays
        // available for the next explicit Copy where delayed items are unsupported.
        void text.then(() => {
          if (current() && d.scrolled) noteClipboard("copied the visible part; Copy or Ctrl+C copies the whole selection");
        }, () => {});
      }
    };
    host.addEventListener("mousedown", onMouseDown, { capture: true });
    window.addEventListener("mousemove", onMouseMove, { capture: true });
    window.addEventListener("blur", onBlur);
    window.addEventListener("mouseup", onMouseUp);

    // OSC 52: the pane program asked the terminal to set the clipboard - the pty
    // cannot reach the browser clipboard, so xterm hands us the sequence and
    // navigator.clipboard completes the hop (text only; queries are ignored)
    const osc52 = term.parser.registerOscHandler(52, (payload) => {
      const text = parseOsc52(payload);
      if (text !== null) {
        void navigator.clipboard?.writeText(text).then(
          () => noteClipboard("copied to clipboard"),
          () => noteClipboard("clipboard write blocked by the browser"),
        );
      }
      return true;
    });

    let outputGeneration = 0;
    // what the socket says, as the grid takes it: the Mediator tells the state the rest
    const detachTerminal = attachTerminal({ output: (message, acknowledge) => {
        if (message.pane_id !== paneRef.current) return;
        // raw pty bytes: append, never repaint, so xterm keeps the screen and selection
        const owner = message.pane_id;
        const generation = outputGeneration;
        term.write(message.data, () => {
          acknowledge?.();
          if (paneRef.current !== owner || generation !== outputGeneration) return;
          followCursor();
          const lines: string[] = [];
          const buffer = term.buffer.active;
          for (let row = 0; row < buffer.length; row++) {
            const line = buffer.getLine(row);
            const text = line?.translateToString(!buffer.getLine(row + 1)?.isWrapped) ?? "";
            if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
            else lines.push(text);
          }
          const prompt = secretPrompt(lines.join("\n"), term.cols);
          secretRef.current = prompt;
          term.options.disableStdin = observeRef.current || prompt !== null || heldRef.current;
          emitRef.current({ type: "pane-output", paneId: owner, secret: prompt });
        });
      }, message: (message) => {
      if (message.type === "attach-resumed") {
        if (message.pane_id === paneRef.current) {
          heldRef.current = false;
          term.options.disableStdin = observeRef.current || secretRef.current !== null;
        }
      } else if (message.type === "pty-exit") {
        // an ended pane takes no input: a file dropped on it must not upload and paste either
        if (message.pane_id === paneRef.current) term.options.disableStdin = true;
      } else if (message.type === "role-ack") {
        // the server is the authority on the role; only after this ack may an
        // interact client size the pane again
        const nowObserving = message.mode === "observe";
        observeRef.current = nowObserving;
        term.options.disableStdin = nowObserving || secretRef.current !== null || heldRef.current;
        if (drives()) {
          try {
            fit.fit();
          } catch {
            /* not laid out yet */
          }
          const pane = paneRef.current;
          if (pane) command({ kind: "resize", paneId: pane, cols: term.cols, rows: term.rows, force: true });
        }
        panned = false;
        followCursor();
      } else if (message.type === "pane-geometry") {
        // every client adopts the pty's grid, the one sizing it too: it hears its own size back,
        // or the size of a device that took the pane after it (the latest wins). A fixed grid is
        // a mirror's: nobody here sizes it
        if (message.pane_id !== paneRef.current) return;
        if (message.fixed) fixedGridRef.current = true;
        // the chat lens entered later draws its hidden screen for this grid: the screen it reads
        // (a masked prompt) is drawn for it
        sharedGridRef.current = { cols: message.cols, rows: message.rows };
        if (term.cols !== message.cols || term.rows !== message.rows) term.resize(message.cols, message.rows);
        panned = false;
        followCursor();
      } else if (message.type === "error") {
        // the state says these (Mediator); the grid writes an error it knows nothing of
        if (message.code === "input_not_ready" || message.code === "input_failed") return;
        if (message.code === "attach_held") {
          // a pane this terminal already left: its wait is not this pane's
          if (message.pane_id !== undefined && message.pane_id !== paneRef.current) return;
          // not an end: the server attaches as soon as the other bridge lets go
          heldRef.current = true;
          term.options.disableStdin = true;
          return;
        }
        if (message.code === "terminal_unsupported") {
          if (message.pane_id !== undefined && message.pane_id !== paneRef.current) return;
          term.options.disableStdin = true;
          return;
        }
        if (message.code === "output_stalled" || message.code === "attach_conflict") {
          term.options.disableStdin = true;
          return;
        }
        term.writeln(`\r\n\u001b[31m[herdr-fleet] ${message.code}: ${message.message}\u001b[0m`);
      }
    }, disconnected: () => {
      outputGeneration++;
      // the reconnect attaches afresh: it says attach_held again if the other bridge still has
      // the pane, and a pane it gets straight away sends no attach-resumed to clear this
      heldRef.current = false;
    } });
    emitRef.current({ type: "open-pane-socket", machineId });

    // onKey runs after xterm drains a pending IME commit, immediately before the
    // key's onData. Remap only that CR, preserving composition text and its order.
    let shiftEnter = false;
    const onShiftEnter = term.onKey(({ key, domEvent: event }) => {
      shiftEnter = !term.options.disableStdin && key === "\r" && event.key === "Enter" && event.shiftKey
        && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing && event.keyCode !== 229;
    });
    // Let xterm finish pending IME text before remapping the key's following data.
    // Cmd+Backspace uses the terminal's Ctrl+U line-deletion shortcut on macOS.
    let commandBackspace = false;
    const onCommandBackspace = term.onKey(({ key, domEvent: event }) => {
      commandBackspace = !term.options.disableStdin && isMac && key === "\x7f" && event.type === "keydown"
        && event.key === "Backspace" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
        && !event.isComposing && event.keyCode !== 229;
    });
    const onData = term.onData((data) => {
      if (shiftEnter && data === "\r") data = "\x1b\r";
      shiftEnter = false;
      if (commandBackspace && data === "\x7f") data = "\x15";
      commandBackspace = false;
      const current = paneRef.current;
      if (!current || observeRef.current || secretRef.current !== null || heldRef.current) return;
      let input = data;
      if (ctrlRef.current && isPrintable(data)) {
        ctrlRef.current = false;
        setCtrlArmed(false);
        input = controlCode(data) ?? data;
      }
      if (link.sendInput(current, input)) return;
      // A closed socket, an attachment still opening, or a failed synchronous send:
      // keep printable input for explicit review, never replay it automatically.
      emitRef.current({ type: "draft-input", owner: paneStorageId(machineId, current), input });
    });

    // Browsers expose dropped files as bytes, not local paths. Save them beside
    // the pane and paste the returned paths; never send Enter with a drop.
    // Batches upload one after another, so overlapping drops paste their paths in the order dropped.
    let fileQueue: Promise<void> = Promise.resolve();
    const uploadFiles = (files: File[]): void => {
      const pane = paneRef.current;
      if (!pane || !link.connected() || term.options.disableStdin) return;
      fileQueue = fileQueue.then(() => uploadBatch(pane, files));
    };
    const uploadBatch = async (pane: string, files: File[]): Promise<void> => {
      if (paneRef.current !== pane || !link.connected() || term.options.disableStdin) return;
      try {
        const paths: string[] = [];
        for (const file of files) paths.push(await uploadFileRef.current(pane, file));
        // An upload can finish after the user has switched panes or lost input access.
        if (paneRef.current !== pane || chatViewRef.current || !link.connected() || term.options.disableStdin) return;
        term.paste(paths.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(" ") + " ");
        term.focus();
      } catch (error) {
        if (paneRef.current === pane) noteClipboard(error instanceof Error ? error.message : String(error));
      }
    };
    const onFilePaste = (event: ClipboardEvent): void => {
      // xterm handles text (and bracketed paste) itself. A file-only clipboard
      // needs the upload route instead; copied paths must remain native text.
      if (event.clipboardData?.getData("text/plain")) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      uploadFiles(files);
    };
    const onDragOver = (event: DragEvent): void => {
      if (!event.dataTransfer) return;
      if (!event.dataTransfer.types.some((type) => type === "Files" || type === "text/plain")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = term.options.disableStdin ? "none" : "copy";
    };
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      if (!event.dataTransfer || !link.connected() || term.options.disableStdin) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) {
        uploadFiles(files);
        return;
      }
      const text = event.dataTransfer.getData("text/plain");
      if (text) {
        term.paste(text);
        term.focus();
      }
    };
    host.addEventListener("paste", onFilePaste, { capture: true });
    host.addEventListener("dragover", onDragOver);
    host.addEventListener("drop", onDrop);

    // Dragging a window edge fires this every frame. Each resize of the pty makes herdr
    // reflow the pane and the program in it redraw (Claude Code repaints its whole
    // conversation), so a drag of a long session sent over a hundred resizes and the app
    // lagged: fit once the size has settled.
    let resizeTimer: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        // the grid belongs to the pty while observing, and to herdr when fixed: only the view moves
        // (a soft keyboard opening must not leave the prompt under it)
        if (adopted()) {
          panned = false;
          followCursor();
          return;
        }
        try {
          fit.fit();
        } catch {
          return;
        }
        const current = paneRef.current;
        if (current) command({ kind: "resize", paneId: current, cols: term.cols, rows: term.rows, force: false });
      }, RESIZE_SETTLE_MS);
    });
    observer.observe(host);

    // Touch screens never emit wheel events and xterm.js has no touch scrolling:
    // translate a single-finger drag on the terminal into wheel events, so the
    // normal buffer scrolls its own viewport and the alternate buffer (with mouse
    // reporting on) forwards the gesture to herdr, exactly like a mouse wheel.
    // The text follows the finger, as everywhere on a phone: dragging down brings
    // older lines in. Each event carries the finger's position, since xterm reports
    // a wheel at the cell under it (without one, every report said row 1, column 1).
    // A terminal that reports nothing has no history to send a wheel to (an observer's reports are
    // dropped, a mirror reports nothing): there the drag pans the mount, both ways, to the cells past its edge.
    let touchX = 0;
    let touchY = 0;
    let tracking = false;
    const onTouchStart = (event: TouchEvent): void => {
      tracking = event.touches.length === 1;
      const first = event.touches[0];
      if (tracking && first) {
        touchX = first.clientX;
        touchY = first.clientY;
      }
    };
    const onTouchMove = (event: TouchEvent): void => {
      if (!tracking || event.touches.length !== 1) return;
      event.preventDefault();
      const first = event.touches[0];
      if (!first) return;
      // finger moving down (y > touchY) shows older lines: a wheel scrolling up, negative deltaY
      const delta = touchY - first.clientY;
      const across = touchX - first.clientX;
      touchX = first.clientX;
      touchY = first.clientY;
      if (reportsNothing()) {
        panned = true;
        host.scrollBy(across, delta);
        return;
      }
      if (delta !== 0) {
        const target = term.element ?? host;
        target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: delta, clientX: first.clientX, clientY: first.clientY }));
      }
    };
    const onTouchEnd = (): void => {
      tracking = false;
    };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: false });
    host.addEventListener("touchend", onTouchEnd, { passive: true });

    // A phone in front sizes the pane: coming back (another device may have taken the pane
    // meanwhile, and this viewport never changed, so the ResizeObserver above stays silent) it
    // takes it again, and leaving (another app, the screen locked) it lets go at once.
    const refit = (): void => {
      const current = paneRef.current;
      if (!current || !drives()) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      command({ kind: "resize", paneId: current, cols: term.cols, rows: term.rows, force: true });
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") return refit();
      const current = paneRef.current;
      if (current && coarseRef.current) command({ kind: "keep-size", paneId: current });
    };
    window.addEventListener("focus", refit);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      observer.disconnect();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", onTouchEnd);
      host.removeEventListener("mousedown", onMouseDown, { capture: true });
      window.removeEventListener("mousemove", onMouseMove, { capture: true });
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("mouseup", onMouseUp);
      host.removeEventListener("copy", onCopy);
      stopEdge();
      selectionChange.dispose();
      window.removeEventListener("focus", refit);
      document.removeEventListener("visibilitychange", onVisible);
      onShiftEnter.dispose();
      onCommandBackspace.dispose();
      onData.dispose();
      host.removeEventListener("paste", onFilePaste, { capture: true });
      host.removeEventListener("dragover", onDragOver);
      host.removeEventListener("drop", onDrop);
      osc52.dispose();
      if (clipboardTimerRef.current !== null) window.clearTimeout(clipboardTimerRef.current);
      detachTerminal();
      emitRef.current({ type: "close-pane-socket", machineId });
      stopGlyphs();
      host.removeEventListener("compositionstart", compositionStart);
      host.removeEventListener("compositionend", compositionEnd);
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one terminal for the mount; theme/font follow in their own effect
  }, []);

  // the theme follows the settings without a remount
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalTheme(theme);
  }, [theme]);

  // the font follows too, and a font change moves the grid. xterm measures the cell (and the DOM
  // renderer its glyph widths) when fontFamily or fontSize changes, and setting the same value
  // again changes nothing: so a chosen family is set only once its faces loaded, or the cell would
  // stay measured from a fallback
  const fontFamily = terminalFontStack(terminalFontFamily);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let superseded = false;
    const apply = (): void => {
      // a newer font, or an unmounted terminal, took over while the faces loaded
      if (superseded || termRef.current !== term) return;
      if (term.options.fontSize === terminalFontSize && term.options.fontFamily === fontFamily) return;
      term.options.fontSize = terminalFontSize;
      term.options.fontFamily = fontFamily;
      if (!drives()) return;
      try {
        fitRef.current?.fit();
      } catch {
        return;
      }
      const pane = paneRef.current;
      if (pane) command({ kind: "resize", paneId: pane, cols: term.cols, rows: term.rows, force: true });
    };
    if (fontFamily === TERMINAL_FONT_STACK) apply();
    else void loadFontStack(fontFamily, terminalFontSize).then(apply);
    return () => { superseded = true; };
  }, [terminalFontSize, fontFamily]);

  // the chat lens covers the grid: a phone lets go of the pane, and the hidden screen keeps the
  // pty's grid. The terminal lens on a phone sizes the pane again, fitted anew: a resize while
  // covered may have been skipped by a zero-size layout
  useEffect(() => {
    const shared = sharedGridRef.current;
    const grid = termRef.current;
    const adopt = (): void => {
      if (shared && grid && (grid.cols !== shared.cols || grid.rows !== shared.rows)) grid.resize(shared.cols, shared.rows);
    };
    if (chatView) {
      const pane = paneRef.current;
      if (pane) command({ kind: "keep-size", paneId: pane });
      adopt();
      return;
    }
    if (!drives()) {
      adopt();
      if (!autoSelected && !coarseRef.current) grid?.focus();
      return;
    }
    const term = termRef.current;
    try {
      fitRef.current?.fit();
    } catch {
      return;
    }
    const pane = paneRef.current;
    if (pane && term) command({ kind: "resize", paneId: pane, cols: term.cols, rows: term.rows, force: true });
    if (!autoSelected && !coarseRef.current) term?.focus();
  }, [chatView]);

  // Reset synchronously on pane changes: old composition timers must never see the new pane.
  useLayoutEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term) return;
    // everything known of the pane before goes: written, ready, held, ended, errors, a masked prompt
    emitRef.current({ type: "pane-attached", paneId });
    setComposing(false);
    heldRef.current = false;
    fixedGridRef.current = false;
    sharedGridRef.current = null;
    // the next pane's grid is this browser's again unless it says otherwise (pane-geometry)
    hostRef.current?.toggleAttribute("data-adopted-grid", observeRef.current);
    secretRef.current = null;
    term.options.disableStdin = observeRef.current;
    // the pane's held input, as this device kept it
    emitRef.current({ type: "draft-open", owner: paneId ? paneStorageId(machineId, paneId) : null });
    term.reset();
    if (!paneId) return;
    try {
      fit?.fit();
    } catch {
      /* not laid out yet; the ResizeObserver will follow up */
    }
    command({ kind: "attach", paneId, cols: term.cols, rows: term.rows, keepSize: chatViewRef.current });
    // the attach leaves the pane at its size: a phone in front takes it
    if (drives()) command({ kind: "resize", paneId, cols: term.cols, rows: term.rows, force: true });
    // the chat lens covers the grid and its composer takes the keyboard: focusing the hidden
    // grid sent the keys straight to the pane, and showed a phone's IME text mid-screen
    if (!chatViewRef.current && !autoSelected && !coarseRef.current) term.focus();
    return () => {
      command({ kind: "detach", paneId });
    };
  }, [paneId]);

  // the user picked the pane App had switched to on its own (the same row or lens again,
  // which changes neither the pane nor the lens): the grid takes the keyboard now
  const autoSelectedRef = useRef(autoSelected);
  useEffect(() => {
    const wasAuto = autoSelectedRef.current;
    autoSelectedRef.current = autoSelected;
    if (wasAuto && !autoSelected && !chatViewRef.current && !coarseRef.current) termRef.current?.focus();
  }, [autoSelected]);

  // key-bar taps go through xterm so the onData -> socket path above is reused
  const pressKey = useCallback((key: KeyBarKey) => {
    const term = termRef.current;
    if (!term) return;
    if (composingRef.current) return;
    term.input(keySequence(key, term.modes.applicationCursorKeysMode));
    // with the input line, the keyboard belongs to it: a key tap must not move it to the grid
    if (!inputLineRef.current) term.focus();
  }, []);

  const toggleCtrl = useCallback(() => {
    if (composingRef.current) return;
    const armed = !ctrlRef.current;
    ctrlRef.current = armed;
    setCtrlArmed(armed);
    if (!inputLineRef.current) termRef.current?.focus();
  }, []);

  // ask the server for the role change; the role-ack handler applies the local
  // consequences (stdin gate, grid adoption or reclamation) once it is confirmed.
  // The initial default is skipped: the server already treats fresh connections as interact.
  const lastSentRole = useRef<ClientRole>(role);
  useEffect(() => {
    if (role === lastSentRole.current) return;
    lastSentRole.current = role;
    command({ kind: "mode", role });
  }, [role]);

  const sendDraft = useCallback(() => emit({ type: "send-draft" }), [emit]);
  const discardDraft = useCallback(() => emit({ type: "discard-draft" }), [emit]);

  // A message from the composer, the input line or a held message goes up with what only this
  // terminal knows: the pane, and its program's paste mode. The Mediator decides where it goes
  // (an answer, a held message, a submit) and sends it straight to the socket, not through onData:
  // an armed key-bar Ctrl must not turn a one-letter message into a control key.
  const bracketedPaste = (): boolean => termRef.current?.modes.bracketedPasteMode ?? false;
  const composerEmit = useCallback((event: ComposerUpEvent) => {
    // the stop button: Escape interrupts the agent's current turn in every supported TUI (Claude
    // Code, omp, codex) without killing the process the way ^C would
    if (event.type === "abort-turn") {
      const term = termRef.current;
      if (term && link.connected()) term.input("\u001b");
      return;
    }
    if (event.type !== "send-message") { emitRef.current(event); return; }
    const pane = paneRef.current;
    if (pane === null) return;
    emitRef.current({ type: "composer-send", owner: paneStorageId(machineId, pane), machineId, paneId: pane, text: event.text, via: event.via,
      bracketedPaste: bracketedPaste(), working: agentRef.current !== null && agentStatusRef.current === "working" });
  }, [machineId]);
  const lineEmit = useCallback((event: TerminalInputEvent) => {
    if (event.type !== "send-line") { emitRef.current(event); return; }
    const pane = paneRef.current;
    if (pane === null) return;
    emitRef.current({ type: "line-send", owner: paneStorageId(machineId, pane), paneId: pane, text: event.text, bracketedPaste: bracketedPaste() });
  }, [machineId]);
  // a submit the socket took scrolls the grid to its end, where the message goes in
  const started = useSelected((state) => state.sends.started);
  useEffect(() => { if (started > 0) termRef.current?.scrollToBottom(); }, [started]);

  const pressEnter = useCallback((): boolean => {
    const pane = paneRef.current;
    if (pane === null || !link.connected()) return false;
    const sent = link.sendInput(pane, "\r");
    termRef.current?.scrollToBottom();
    return sent;
  }, []);

  const toggleDirect = useCallback(() => {
    if (composingRef.current) return;
    updateSettings({ terminalInputMode: directTyping ? "line" : "direct" });
  }, [directTyping, updateSettings]);
  // the key bar's keys are this terminal's: they go to the pane, or arm Control, or switch how it is typed into
  const keyBarEmit = useCallback((event: KeyBarEvent) => {
    if (event.type === "key-bar-key") pressKey(event.key);
    else if (event.type === "toggle-ctrl") toggleCtrl();
    else if (event.type === "toggle-direct") toggleDirect();
  }, [pressKey, toggleCtrl, toggleDirect]);

  // the input line keeps a tapped grid from raising the keyboard; typing straight into it gives it
  // back. Only turning direct typing on raises it: a pane or lens picked with it on does not.
  const directTypingRef = useRef(directTyping);
  useEffect(() => {
    const turnedOn = directTyping && !directTypingRef.current;
    directTypingRef.current = directTyping;
    const textarea = hostRef.current?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    if (!textarea) return;
    if (inputLine) {
      textarea.setAttribute("inputmode", "none");
      if (document.activeElement === textarea) textarea.blur();
    } else {
      textarea.removeAttribute("inputmode");
      if (coarse && !chatView && turnedOn) termRef.current?.focus();
    }
  }, [inputLine, coarse, chatView, directTyping, paneId]);

  // While the agent runs, append to its held messages. Each requires an explicit send.
  // a question in Codex's queue leaves the composer alone: Codex keeps working, and a
  // message ("stop, don't touch prod") must reach it, not become the answer; its card answers it
  // a fallback card is answered with its own buttons: what the user types still goes to the agent
  const answering = chatView && chatPrompt !== null && !chatPrompt.queued && !chatPrompt.fallback ? chatPrompt : null;
  // ...and while it is open in the terminal it holds the input: nothing is sent into it
  const heldByOpenQueue = chatView && chatPrompt !== null && chatPrompt.queued === "open";
  const busy = agent !== null && agentStatus === "working" && answering === null;
  const readyForQueue = agentStatus !== undefined && QUEUE_READY_STATUS[agentStatus] === true;

  // Send now goes up with what only this terminal knows, as a composer message does
  const queueEmit = useCallback((event: QueueUpEvent) => {
    if (event.type !== "queue-send") { emitRef.current(event); return; }
    const pane = paneRef.current;
    if (pane === null) return;
    emitRef.current({ type: "queue-send", owner: event.owner, id: event.id, text: event.text, paneId: pane, bracketedPaste: bracketedPaste() });
  }, []);

  return (
    // data-direct-typing: xterm's own field raises the soft keyboard here (lib/viewport.ts)
    <div className={`terminal-stack${chatView ? " is-chat" : ""}`} data-direct-typing={coarse && directTyping && !chatView ? "" : undefined}>
      {paneId === null && restoreError !== null && (
        <div className="terminal-placeholder is-restore-error" role="status">
          <div className="terminal-placeholder-inner">
            <TriangleAlert aria-hidden="true" />
            <span>{t("herdr could not restore this pane.")}</span>
            <span className="terminal-placeholder-detail">{restoreError}</span>
          </div>
        </div>
      )}
      {paneId === null && restoreError === null && (
        <div className="terminal-placeholder">
          <div className="terminal-placeholder-inner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
              <path d="M7 9l3 3-3 3" />
              <path d="M12.5 15h4.5" />
            </svg>
            <span>{t("Select a pane to open its terminal")}</span>
          </div>
        </div>
      )}
      <div className="terminal-banners">
        {paneId !== null && held && (
          <div className="terminal-banner terminal-banner-warning" role="status">
            <span>{t("Another app has this pane open. It connects here as soon as that app lets go.")}</span>
          </div>
        )}
        {paneId !== null && !chatView && unsupported && (
          <div className="terminal-banner terminal-banner-soon" role="status">
            <span>{t("Live terminal is coming to Windows PCs: herdr cannot attach a terminal there yet. The chat lens works now.")}</span>
          </div>
        )}
        {paneId !== null && outputError && (
          <div className="terminal-banner terminal-banner-warning terminal-banner-output-error" role="status">
            <span>{outputError}</span>
            <a className="btn" href={`?machine=${encodeURIComponent(machineId)}&pane=${encodeURIComponent(paneId)}`}>{t("Reconnect")}</a>
          </div>
        )}
        {!chatView && inputError && <div className="terminal-banner" role="status">{inputError}<button className="btn" onClick={() => emit({ type: "dismiss-input-error" })}>{t("Dismiss")}</button></div>}
        {!chatView && !observing && connected && !inputReady && !held && !ended && <div className="terminal-banner" role="status">{t("Waiting for terminal input…")}</div>}
        {/* the chat lens says these itself (ChatView), inline; the pills are the grid's */}
        {paneId !== null && !chatView && ended && !outputError && (
          <div className="terminal-banner" role="status">
            terminal ended{!draftIsEmpty(draft) ? " — held input discarded" : ""}
          </div>
        )}
        {paneId !== null && !chatView && !ended && !connected && (
          <div className="terminal-banner terminal-banner-warning" role="status">
            reconnecting to herdr fleet…
            {!draftIsEmpty(draft) && <span className="draft-held"> input held: “{draft.text}”</span>}
          </div>
        )}
        {paneId !== null && !ended && connected && !draftIsEmpty(draft) && (
          <div className="terminal-banner terminal-banner-draft" role="status">
            <span className="draft-label">{t("Input held until the terminal is ready:")}</span>
            <code className="draft-text">{draft.text.length > 0 ? draft.text : "—"}</code>
            {draft.droppedSpecial > 0 && (
              <span className="draft-dropped">{t(draft.droppedSpecial === 1 ? "{count} special key dropped" : "{count} special keys dropped", { count: draft.droppedSpecial })}</span>
            )}
            <span className="draft-actions">
              <button type="button" className="draft-send" disabled={draft.text.length === 0 || observing || secretActive || held} onClick={sendDraft}>
                {t("Send")}
              </button>
              <button type="button" className="draft-discard" onClick={discardDraft}>
                {t("Discard")}
              </button>
            </span>
          </div>
        )}
        {paneId !== null && !ended && observing && (
          <div className="terminal-banner terminal-banner-observe" role="status">
            view only — the operator’s screen size is untouched
          </div>
        )}
        {clipboardNote && (
          <div className="terminal-banner" role="status">
            {clipboardNote}
          </div>
        )}
      </div>
      <div className="terminal-surface">
        <div className={`pane-terminal${paneId === null ? " is-idle" : ""}`} ref={hostRef} />
        {paneId !== null && chatView && (
          <RenderBoundary resetKey={paneId} fallback={(retry) => (
            <div className="chat-view"><div className="chat-empty" role="alert">
              <p>{t("The chat can't be shown. The terminal still works.")}</p>
              <button type="button" className="btn" onClick={retry}>{t("Try again")}</button>
            </div></div>
          )}>
          <ChatPresenter paneId={paneId} connected={connected} ended={ended} agent={agent} agentStatus={agentStatus} emit={emit} />
          </RenderBoundary>
        )}
      </div>
      {/* the queue is the composer's, so it shows under the chat lens only: there alone is an open
          Codex question known (heldByOpenQueue), and Send now must not type into one */}
      {queueOwner !== null && <QueuePresenter owner={queueOwner} shown={chatView && !observing && !ended} canSend={connected && !held && !secretActive}
        heldByOpenQueue={heldByOpenQueue} ready={readyForQueue} emit={queueEmit} />}
      {/* the composer belongs to the chat lens: in terminal mode the grid itself is
          the input surface (key bar included), so a second box would only duplicate it */}
      {paneId !== null && maskedPrompt !== null && !observing && !ended && connected && outputReady && <SecretInput
        key={`${paneId}:${maskedPrompt}`} prompt={maskedPrompt}
        onSend={(value) => link.sendSecret(paneId, maskedPrompt, value)}
        onCancel={() => { if (link.connected()) link.sendInput(paneId, "\u0003"); }}
      />}
      {paneId !== null && chatView && !secretActive && !observing && !ended && (
        <ComposerPresenter
          key={paneId}
          paneId={paneId}
          autoFocus={!autoSelected && !coarse}
          agent={agent}
          agentStatus={agentStatus}
          emit={composerEmit}
          metadata={chatMetadata}
          connected={connected && !held}
          queueMode={busy}
          answerHint={answering === null ? null
            : pendingAnswer?.promptId === answering.id ? t("Confirm your answer in the card above, or type another…") : answerHint(answering)}
          // no suggestion under any card, a fallback or queued one included
          suggestion={chatPrompt === null ? chatSuggestion : null}
        />
      )}
      {paneId !== null && !secretActive && !observing && !ended && inputLine && <TerminalInputPresenter key={paneId} owner={paneStorageId(machineId, paneId)} onComposing={setComposing} connected={connected && !held} onEnter={pressEnter} emit={lineEmit} />}
      {paneId !== null && !secretActive && !observing && !chatView && <KeyBar model={{ disabled: composing, ctrlArmed, directTyping: coarse ? directTyping : null }} emit={keyBarEmit} />}
    </div>
  );
}
