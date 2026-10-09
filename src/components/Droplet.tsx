import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { flickVelocity, type DropletNotice, type PressSample } from "../lib/droplet.ts";
import { t } from "../lib/i18n.ts";
import type { Emit } from "../ui/bubble.ts";
import type { UiEvent } from "../ui/state.ts";
import { AgentMark } from "./AgentMark.tsx";
import "./Droplet.css";

/**
 * The in-app alert (lib/droplet.ts): a drop falls from the top edge and spreads into a card,
 * like the iPhone's Dynamic Island. It hangs from the safe area's top, so a phone with an
 * island, one with a notch, and a desktop window all take the same path: no device is
 * guessed. One shows at a time; a newer one folds the current one away and takes its place.
 * A tap opens the pane, a flick up puts it away, and it leaves by itself after a while (the
 * state machine keeps which one shows and its clock; the finger's drag is this view's own).
 */

/** a drag up this far, or a flick up this fast, puts it away */
const DISMISS_DRAG_PX = -18;
const DISMISS_VELOCITY = -0.42; // px per ms
/** a press that moved less than this is a tap */
const TAP_SLOP_PX = 6;

export interface DropletModel {
  notice: DropletNotice;
  /** the pane's name, as the sidebar shows it */
  title: string;
  phase: "in" | "out";
}

export type DropletEvent = Extract<UiEvent, { type: "droplet-press" | "droplet-release" | "droplet-dismiss" | "droplet-open" }>;

/** One notice's card: the parent keys it by the notice, so a new one starts undragged. */
export function Droplet({ model, emit }: { model: DropletModel; emit: Emit<DropletEvent> }) {
  const { notice: current, title, phase } = model;
  const [drag, setDrag] = useState(0);
  // a press that dragged ends in a click on a mouse: that click is not a tap
  const dragged = useRef(false);
  const press = useRef<{ id: number; y: number; samples: PressSample[]; moved: boolean } | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    // a right-click ends in no click: holding for it would leave the card up for good
    if (phase === "out" || event.button !== 0) return;
    dragged.current = false;
    press.current = { id: event.pointerId, y: event.clientY, samples: [{ y: event.clientY, t: event.timeStamp }], moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    emit({ type: "droplet-press" }); // held while touched
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.id !== event.pointerId) return;
    const dy = event.clientY - p.y;
    if (Math.abs(dy) > TAP_SLOP_PX) p.moved = true;
    p.samples.push({ y: event.clientY, t: event.timeStamp });
    // up follows the finger, down only gives a little
    setDrag(Math.max(-120, Math.min(24, dy < 0 ? dy : dy * 0.35)));
  };
  const endPress = (event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const p = press.current;
    if (!p || p.id !== event.pointerId) return;
    press.current = null;
    const dy = event.clientY - p.y;
    const velocity = flickVelocity(p.samples, event.clientY, event.timeStamp);
    if (!cancelled && !p.moved) return; // a tap: onClick opens it
    dragged.current = true;
    if (!cancelled && (dy <= DISMISS_DRAG_PX || velocity <= DISMISS_VELOCITY)) {
      emit({ type: "droplet-dismiss" });
      return;
    }
    setDrag(0);
    emit({ type: "droplet-release" });
  };

  const what = t(current.kind === "blocked" ? "Needs input" : current.kind === "done" ? "Finished" : "terminal ended");
  const detail = current.machineName ? `${current.machineName} · ${what}` : what;
  return (
    <div className="droplet" role="status" aria-live="polite" data-phase={phase} data-kind={current.kind} data-dragging={drag !== 0 ? "" : undefined} style={{ "--droplet-drag": `${drag}px` } as CSSProperties}>
      <svg className="droplet-defs" width="0" height="0" aria-hidden="true" focusable="false">
        <filter id="droplet-goo" x="-50%" y="-50%" width="200%" height="200%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation="9" result="blur" />
          {/* alpha sharpened back into an edge: shapes that blur into each other read as one liquid */}
          <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9" />
        </filter>
      </svg>
      <div className="droplet-goo" aria-hidden="true">
        <span className="droplet-anchor" />
        <span className="droplet-blob" />
      </div>
      <button
        type="button"
        className="droplet-card"
        aria-label={`${title}, ${detail}. ${t("Open pane")}`}
        onClick={() => {
          if (dragged.current) {
            dragged.current = false;
            return;
          }
          if (phase === "out") return;
          emit({ type: "droplet-open" });
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endPress(event, false)}
        onPointerCancel={(event) => endPress(event, true)}
      >
        <span className="droplet-mark">{current.pane.agent ? <AgentMark agent={current.pane.agent} size={22} /> : <span className="droplet-mark-blank" />}</span>
        <span className="droplet-text">
          <span className="droplet-title">{title}</span>
          <span className="droplet-detail">{detail}</span>
        </span>
        <span className="droplet-dot" aria-hidden="true" />
      </button>
    </div>
  );
}
