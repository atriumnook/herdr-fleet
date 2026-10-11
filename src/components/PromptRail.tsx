import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ListOrdered } from "lucide-react";

import "./PromptRail.css";

import type { Emit } from "../ui/bubble.ts";
import { promptTitle, type RailEntry } from "../lib/promptRail.ts";
import { LOCALE, t } from "../lib/i18n.ts";

/** What the rail draws: the prompts read, the one being read, and whether earlier ones are left to load. */
export interface PromptRailModel {
  entries: RailEntry[];
  /** the prompt being read: its index, -1 above the first */
  reading: number;
  /** the pages before the first prompt: none left, one to load, loading, or a load that failed */
  earlier: "none" | "idle" | "loading" | "failed";
  /** the chat's scrollbar width: the rail sits left of it */
  gutter: number;
}

export type PromptRailEvent = { type: "rail-jump"; index: number } | { type: "rail-earlier" };

/** space above the first tick and below the last, so neither sits on the rail's end */
const PAD_PX = 12;

function formatTime(ts: string): string | null {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
}

/** The time and the turn line of a prompt, for its card and its row. */
function metaLine(entry: RailEntry): string {
  return [formatTime(entry.ts), entry.line].filter((item) => item !== null && item.length > 0).join(" · ");
}

/**
 * The prompt rail over the chat's right edge: one tick per prompt the person typed, placed where its
 * turn sits in the conversation, the one being read drawn thick. Pointing at the rail shows the
 * nearest prompt and what its turn did; a click jumps there. The ticks take the keyboard too
 * (↑ ↓ Home End, Enter jumps, Escape leaves). A touch screen has no pointing: a button opens the
 * prompts as a list instead. Which prompt is pointed at, and the list being open, are the view's own.
 */
export function PromptRail({ model, emit }: { model: PromptRailModel; emit: Emit<PromptRailEvent> }) {
  const { entries, reading, earlier, gutter } = model;
  /** the prompt whose card shows: pointed at, or holding the focus */
  const [peek, setPeek] = useState<number | null>(null);
  const [sheet, setSheet] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [cardTop, setCardTop] = useState(0);
  const total = entries.length;
  const shown = peek !== null && peek < total ? peek : null;

  // the card beside its tick, kept inside the rail's height
  useLayoutEffect(() => {
    const rail = track.current;
    if (shown === null || rail === null || card.current === null) return;
    const height = rail.clientHeight;
    const y = PAD_PX + entries[shown]!.at * Math.max(0, height - 2 * PAD_PX);
    const half = card.current.offsetHeight / 2;
    setCardTop(Math.min(Math.max(y, half), Math.max(half, height - half)));
  }, [shown, entries]);

  /** the prompt nearest the pointer's height on the rail */
  const nearest = (event: ReactPointerEvent): number | null => {
    const rail = track.current;
    if (rail === null || total === 0) return null;
    const box = rail.getBoundingClientRect();
    const at = (event.clientY - box.top - PAD_PX) / Math.max(1, box.height - 2 * PAD_PX);
    let best = 0;
    entries.forEach((entry, index) => { if (Math.abs(entry.at - at) < Math.abs(entries[best]!.at - at)) best = index; });
    return best;
  };
  const jump = (index: number): void => emit({ type: "rail-jump", index });

  const focusTick = (index: number): void => {
    track.current?.querySelector<HTMLButtonElement>(`[data-rail-index="${index}"]`)?.focus();
  };
  const onKeyDown = (event: ReactKeyboardEvent): void => {
    const from = peek ?? Math.max(0, reading);
    const to = event.key === "ArrowUp" ? from - 1 : event.key === "ArrowDown" ? from + 1 : event.key === "Home" ? 0 : event.key === "End" ? total - 1 : null;
    if (to !== null) {
      event.preventDefault();
      focusTick(Math.min(Math.max(to, 0), total - 1));
    } else if (event.key === "Escape") {
      event.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur();
      setPeek(null);
    }
  };
  // the tick the keyboard comes in on: the one being read
  const tabStop = Math.min(Math.max(reading, 0), total - 1);
  const pointed = shown === null ? null : entries[shown]!;

  return <nav className="prompt-rail" aria-label={t("Prompts")} style={{ "--rail-gutter": `${gutter}px` } as CSSProperties}>
    {earlier !== "none" && (
      <button type="button" className={`prompt-rail-earlier${earlier === "failed" ? " is-failed" : ""}`} disabled={earlier === "loading"} onClick={() => emit({ type: "rail-earlier" })}
        title={t(earlier === "loading" ? "Loading earlier messages…" : earlier === "failed" ? "Couldn't load earlier messages — retry" : "Earlier messages")}
        aria-label={t(earlier === "loading" ? "Loading earlier messages…" : earlier === "failed" ? "Couldn't load earlier messages — retry" : "Earlier messages")} />
    )}
    <div ref={track} className="prompt-rail-track" onKeyDown={onKeyDown}
      onPointerMove={(event) => { if (event.pointerType === "mouse") setPeek(nearest(event)); }}
      onPointerLeave={(event) => { if (event.pointerType === "mouse" && !track.current?.contains(document.activeElement)) setPeek(null); }}
      onClick={(event) => { if (event.target === event.currentTarget) { const index = nearest(event as unknown as ReactPointerEvent); if (index !== null) jump(index); } }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPeek(null); }}>
      {entries.map((entry, index) => (
        <button key={entry.ts} type="button" data-rail-index={index}
          className={`prompt-rail-tick${index === reading ? " is-reading" : ""}${index === shown ? " is-peek" : ""}`}
          style={{ top: `calc(${PAD_PX}px + ${entry.at} * (100% - ${2 * PAD_PX}px))` }}
          tabIndex={index === tabStop ? 0 : -1}
          aria-label={t("Prompt {n} of {total}: {title}", { n: index + 1, total, title: promptTitle(entry) })}
          aria-current={index === reading ? "location" : undefined}
          onFocus={() => setPeek(index)}
          onClick={(event) => { event.stopPropagation(); jump(index); }} />
      ))}
    </div>
    {pointed !== null && (
      <div ref={card} className="menu prompt-rail-card" role="tooltip" style={{ top: cardTop }}>
        <p className="prompt-rail-card-text">{pointed.text.length > 0 ? pointed.text : promptTitle(pointed)}</p>
        <p className="prompt-rail-card-meta"><span className="prompt-rail-card-count">{shown! + 1} / {total}</span>{metaLine(pointed).length > 0 && <> · {metaLine(pointed)}</>}</p>
      </div>
    )}
    <button ref={opener} type="button" className="btn prompt-rail-open" aria-label={t("Prompts")} title={t("Prompts")} onClick={() => setSheet(true)}>
      <ListOrdered aria-hidden="true" />
    </button>
    {sheet && <PromptSheet model={model} onJump={(index) => { setSheet(false); jump(index); }} onEarlier={() => emit({ type: "rail-earlier" })}
      onClose={() => { setSheet(false); opener.current?.focus({ preventScroll: true }); }} />}
  </nav>;
}

/** The prompts as a list, for a touch screen: a bottom sheet, the one being read marked, a tap jumps there. */
function PromptSheet({ model, onJump, onEarlier, onClose }: { model: PromptRailModel; onJump: (index: number) => void; onEarlier: () => void; onClose: () => void }) {
  const { entries, reading, earlier } = model;
  const list = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // the sheet opens on the prompt being read
  useEffect(() => {
    const row = list.current?.querySelector<HTMLButtonElement>(".is-reading") ?? list.current?.querySelector<HTMLButtonElement>(".prompt-sheet-row");
    row?.scrollIntoView({ block: "center" });
    row?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, []);
  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal prompt-sheet" role="dialog" aria-modal="true" aria-label={t("Prompts")}>
        <span className="row-sheet-grip" aria-hidden="true" />
        <div className="prompt-sheet-head"><span className="prompt-sheet-title">{t("Prompts")}</span><span className="prompt-sheet-count">{entries.length}</span></div>
        <div ref={list} className="prompt-sheet-list">
          {earlier !== "none" && (
            <button type="button" className="btn btn-ghost prompt-sheet-earlier" disabled={earlier === "loading"} onClick={onEarlier}>
              {t(earlier === "loading" ? "Loading earlier messages…" : earlier === "failed" ? "Couldn't load earlier messages — retry" : "Earlier messages")}
            </button>
          )}
          {entries.map((entry, index) => (
            <button key={entry.ts} type="button" className={`prompt-sheet-row${index === reading ? " is-reading" : ""}`} aria-current={index === reading ? "location" : undefined} onClick={() => onJump(index)}>
              <span className="prompt-sheet-number">{index + 1}</span>
              <span className="prompt-sheet-main">
                <span className="prompt-sheet-text">{promptTitle(entry)}</span>
                {metaLine(entry).length > 0 && <span className="prompt-sheet-meta">{metaLine(entry)}</span>}
              </span>
            </button>
          ))}
        </div>
        <button type="button" className="btn row-sheet-cancel" onClick={onClose}>{t("Cancel")}</button>
      </div>
    </div>,
    document.body,
  );
}
