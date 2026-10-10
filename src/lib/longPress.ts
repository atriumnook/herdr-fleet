/**
 * A row's menu without a button of its own: a right click, the keyboard's menu key (both a
 * `contextmenu` event) or, on touch, a long press opens it at the press. iOS Safari fires no
 * `contextmenu` for a long press, so the press is timed here; where a browser fires one as
 * well (Android), whichever comes first opens the menu and the other does nothing. What the
 * lifted finger would still send is swallowed: the mouse events a browser makes from a touch
 * would land on the sheet's backdrop and close the menu, and the click would select the row.
 */
import type { MouseEvent, PointerEvent, TouchEvent } from "react";

export interface PressPoint {
  x: number;
  y: number;
}

export interface MenuPressHandlers {
  onContextMenu: (event: MouseEvent) => void;
  onPointerDown: (event: PointerEvent) => void;
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onTouchEnd: (event: TouchEvent) => void;
  onClickCapture: (event: MouseEvent) => void;
}

export const LONG_PRESS_MS = 500;
// a finger that moves this far is scrolling the list, not pressing a row
const SLOP_PX = 10;

/**
 * One tracker for a list of rows: a finger presses one row at a time. Each row binds its own
 * `open`, which gets the press's point (null when the keyboard asked: no point to open at) and
 * the row the handlers sit on.
 */
export function menuPress(delayMs = LONG_PRESS_MS): (open: (at: PressPoint | null, row: HTMLElement) => void) => MenuPressHandlers {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: PressPoint = { x: 0, y: 0 };
  // the press opened the menu: the click (and a late contextmenu) it ends with does nothing
  let opened = false;
  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return (open) => ({
    onContextMenu: (event) => {
      event.preventDefault();
      if (opened) return;
      const pressing = timer !== null;
      cancel();
      if (pressing) opened = true;
      // the menu key's event carries no pointer: it opens under the row instead
      const keyboard = event.clientX === 0 && event.clientY === 0;
      open(keyboard ? null : { x: event.clientX, y: event.clientY }, event.currentTarget as HTMLElement);
    },
    onPointerDown: (event) => {
      cancel();
      opened = false;
      if (event.pointerType !== "touch") return;
      start = { x: event.clientX, y: event.clientY };
      const at = start;
      const row = event.currentTarget as HTMLElement;
      timer = setTimeout(() => {
        timer = null;
        opened = true;
        open(at, row);
      }, delayMs);
    },
    onPointerMove: (event) => {
      if (timer !== null && Math.hypot(event.clientX - start.x, event.clientY - start.y) > SLOP_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    // no mousedown, mouseup or click after a press that opened the menu
    onTouchEnd: (event) => {
      if (opened) event.preventDefault();
    },
    onClickCapture: (event) => {
      if (!opened) return;
      opened = false;
      event.preventDefault();
      event.stopPropagation();
    },
  });
}
