import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { MessagesSquare, Plus, SquareTerminal, X } from "lucide-react";
import { t } from "../lib/i18n.ts";
import { Segmented } from "./Segmented.tsx";
import type { Emit } from "../ui/bubble.ts";
import type { SidePanelModel } from "../ui/sidePanelView.ts";
import type { SidePanelTab } from "../ui/state.ts";
import "./SidePanel.css";

export type SidePanelEvent =
  | { type: "side-panel"; open: boolean; tab?: SidePanelTab }
  | { type: "open-side-terminal"; machineId: string; paneId: string; another?: boolean }
  | { type: "show-side-terminal"; key: string; paneId: string }
  | { type: "tree-close-pane"; machineId: string; paneId: string }
  | { type: "show-screen"; screen: "pane" };

export interface SidePanelProps {
  model: SidePanelModel;
  /** the side chat about the pane, on this PC */
  chat: ReactNode;
  /** the shown terminal's grid */
  terminal: ReactNode;
  emit: Emit<SidePanelEvent>;
}

/** where this device keeps the panel's width (a desktop's column; a sheet takes its own) */
const WIDTH_KEY = "herdr-fleet:side-panel-width";
const MIN_WIDTH = 320;
const MAX_SHARE = 0.6;

function storedWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value) && value >= MIN_WIDTH ? value : null;
  } catch {
    return null;
  }
}

const clampWidth = (width: number): number => Math.round(Math.max(MIN_WIDTH, Math.min(width, window.innerWidth * MAX_SHARE)));

/**
 * The side panel, beside the pane shown on either screen: a side chat that answers questions about
 * the pane's conversation without joining it, and the terminals of the pane's workspace. Each tab
 * keeps what it shows while the other is in front, so a terminal's screen and a chat's place stay.
 * On a desktop its edge is dragged to widen it, and a shortcut puts the keyboard in the tab's input.
 */
export function SidePanel({ model, chat, terminal, emit }: SidePanelProps) {
  const [width, setWidth] = useState<number | null>(storedWidth);
  const panel = useRef<HTMLElement>(null);
  // a shortcut's ask for the keyboard, taken once: a pane picked later does not take it again
  const focused = useRef(model.focusSeq);
  useEffect(() => {
    if (!model.open || model.focusSeq === focused.current) return;
    focused.current = model.focusSeq;
    const take = () => {
      const input = panel.current?.querySelector<HTMLElement>(`[data-side-tab="${model.tab}"] textarea`);
      input?.focus({ preventScroll: true });
      return input != null;
    };
    // a terminal being opened has no grid yet: once more when it may
    if (!take()) window.setTimeout(take, 600);
  }, [model.open, model.focusSeq, model.tab]);

  if (!model.open) return null;
  const { about } = model;
  const tab = (id: SidePanelTab, label: string, icon: ReactNode) => (
    <button type="button" aria-pressed={model.tab === id} onClick={() => emit({ type: "side-panel", open: true, tab: id })}>
      {icon}<span>{label}</span>
    </button>
  );
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    const node = panel.current;
    if (node === null) return;
    event.preventDefault();
    const right = node.getBoundingClientRect().right;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    let last = width;
    const move = (moved: globalThis.PointerEvent) => { last = clampWidth(right - moved.clientX); setWidth(last); };
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
      try { if (last !== null) localStorage.setItem(WIDTH_KEY, String(last)); } catch { /* kept for this page only */ }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
  };
  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = clampWidth((width ?? panel.current?.offsetWidth ?? MIN_WIDTH) + (event.key === "ArrowLeft" ? 24 : -24));
    setWidth(next);
    try { localStorage.setItem(WIDTH_KEY, String(next)); } catch { /* kept for this page only */ }
  };
  return (
    <>
      <button type="button" className="side-panel-scrim" aria-label={t("Close side panel")} onClick={() => emit({ type: "side-panel", open: false })} />
      <aside ref={panel} className="side-panel" aria-label={t("Side panel")} style={width === null ? undefined : { ["--side-panel-w" as string]: `${width}px` }}>
        <div className="side-panel-resize" role="separator" aria-orientation="vertical" aria-label={t("Side panel width")} tabIndex={0}
          onPointerDown={resize} onKeyDown={nudge} />
        <header className="side-panel-head">
          <Segmented label={t("Side panel")} className="side-panel-tabs">
            {tab("chat", t("Side chat"), <MessagesSquare aria-hidden="true" />)}
            {tab("terminal", t("Terminal"), <SquareTerminal aria-hidden="true" />)}
          </Segmented>
          <button type="button" className="icon-button" aria-label={t("Close side panel")} title={t("Close side panel")} onClick={() => emit({ type: "side-panel", open: false })}>
            <X />
          </button>
        </header>
        {about && <p className="side-panel-about" title={about.cwd ?? undefined}><span>{t("About")}</span> <b>{about.title}</b></p>}
        <section className="side-panel-body" aria-label={t("Side chat")} data-side-tab="chat" hidden={model.tab !== "chat"}>
          {about === null ? <p className="side-panel-quiet">{t("Open a pane to ask about it.")}</p>
            : !model.chatHere ? <p className="side-panel-quiet">{t("A side chat is for a pane on this PC.")}</p>
              : <div className="side-panel-chat">{chat}</div>}
        </section>
        <section className="side-panel-body" aria-label={t("Terminal")} data-side-tab="terminal" hidden={model.tab !== "terminal"}>
          {about === null
            ? <p className="side-panel-quiet">{t("Open a pane to open a terminal in its folder.")}</p>
            : <SideTerminals model={model} about={about} terminal={terminal} emit={emit} />}
        </section>
      </aside>
    </>
  );
}

function SideTerminals({ model, about, terminal, emit }: { model: SidePanelModel; about: NonNullable<SidePanelModel["about"]>; terminal: ReactNode; emit: Emit<SidePanelEvent> }) {
  const { list, shown, inPane, opening, failed } = model.terminals;
  const open = (another: boolean) => emit({ type: "open-side-terminal", machineId: about.machineId, paneId: about.paneId, another });
  let body: ReactNode;
  if (inPane) {
    body = (
      <div className="side-panel-start">
        <p>{t("This terminal is the pane open on the Pane screen.")}</p>
        <button type="button" className="btn" onClick={() => emit({ type: "show-screen", screen: "pane" })}>{t("Show it")}</button>
      </div>
    );
  } else if (shown !== null) {
    body = <div className="side-panel-terminal">{terminal}</div>;
  } else if (failed !== null) {
    body = (
      <div className="side-panel-start">
        <p className="side-panel-error" role="alert">{failed}</p>
        <button type="button" className="btn" onClick={() => open(false)}>{t("Try again")}</button>
      </div>
    );
  } else {
    body = <p className="side-panel-quiet">{t("Opening a shell in this pane's folder…")}</p>;
  }
  return (
    <>
      <div className="side-terminal-tabs" role="toolbar" aria-label={t("Terminals")}>
        {list.map((paneId, index) => (
          <span key={paneId} className="side-terminal-tab" data-shown={paneId === shown}>
            <button type="button" aria-pressed={paneId === shown} title={about.cwd ?? undefined}
              onClick={() => emit({ type: "show-side-terminal", key: about.key, paneId })}>
              {t("Terminal {n}", { n: index + 1 })}
            </button>
            {/* closing a terminal ends its shell: only the one in front, so the tab names which */}
            {paneId === shown && (
              <button type="button" className="side-terminal-close" aria-label={t("Close terminal")} title={t("Close terminal")}
                onClick={() => emit({ type: "tree-close-pane", machineId: about.machineId, paneId })}>
                <X aria-hidden="true" />
              </button>
            )}
          </span>
        ))}
        <button type="button" className="icon-button" aria-label={t("New terminal")} title={t("New terminal")} disabled={opening} onClick={() => open(true)}>
          <Plus aria-hidden="true" />
        </button>
      </div>
      {body}
    </>
  );
}
