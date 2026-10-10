import { describe, expect, it } from "bun:test";
import type { MouseEvent, PointerEvent } from "react";
import { menuPress, type PressPoint } from "./longPress.ts";

const pointer = (pointerType: string, x = 10, y = 20) => ({ pointerType, clientX: x, clientY: y }) as unknown as PointerEvent;
const mouse = (x: number, y: number) => {
  const event = { clientX: x, clientY: y, defaultPrevented: false, stopped: false,
    preventDefault() { event.defaultPrevented = true; }, stopPropagation() { event.stopped = true; } };
  return event as unknown as MouseEvent & { defaultPrevented: boolean; stopped: boolean };
};

function rig(delay = 30) {
  const opens: Array<PressPoint | null> = [];
  const handlers = menuPress(delay)((at) => opens.push(at));
  return { opens, handlers };
}

describe("a row's menu without a button", () => {
  it("opens at a right click, and under the row for the menu key", () => {
    const { opens, handlers } = rig();
    const click = mouse(40, 50);
    handlers.onContextMenu(click);
    handlers.onContextMenu(mouse(0, 0));
    expect(opens).toEqual([{ x: 40, y: 50 }, null]);
    expect(click.defaultPrevented).toBe(true);
  });

  it("opens at a finger held still, once, and swallows the click that ends the press", async () => {
    const { opens, handlers } = rig();
    handlers.onPointerDown(pointer("touch", 12, 34));
    await Bun.sleep(60);
    // Android also fires contextmenu for the same press: it does nothing more
    handlers.onContextMenu(mouse(12, 34));
    handlers.onPointerUp();
    // the lifted finger makes no mouse events: they would close the menu from its backdrop
    const lift = mouse(12, 34);
    handlers.onTouchEnd(lift as unknown as Parameters<typeof handlers.onTouchEnd>[0]);
    expect(lift.defaultPrevented).toBe(true);
    const click = mouse(12, 34);
    handlers.onClickCapture(click);
    expect(opens).toEqual([{ x: 12, y: 34 }]);
    expect(click.stopped).toBe(true);
    // the next tap selects as usual
    const tap = mouse(12, 34);
    handlers.onPointerDown(pointer("touch", 12, 34));
    handlers.onPointerUp();
    const tapLift = mouse(12, 34);
    handlers.onTouchEnd(tapLift as unknown as Parameters<typeof handlers.onTouchEnd>[0]);
    handlers.onClickCapture(tap);
    expect(tapLift.defaultPrevented).toBe(false);
    expect(tap.stopped).toBe(false);
  });

  it("does nothing for a short tap, a finger that scrolls, or a mouse held down", async () => {
    const { opens, handlers } = rig();
    handlers.onPointerDown(pointer("touch"));
    handlers.onPointerUp();
    handlers.onPointerDown(pointer("touch", 10, 20));
    handlers.onPointerMove(pointer("touch", 10, 45));
    handlers.onPointerDown(pointer("mouse"));
    await Bun.sleep(60);
    expect(opens).toEqual([]);
  });

  it("opens once when the browser's contextmenu comes before the timer", async () => {
    const { opens, handlers } = rig();
    handlers.onPointerDown(pointer("touch", 5, 6));
    handlers.onContextMenu(mouse(5, 6));
    await Bun.sleep(60);
    const click = mouse(5, 6);
    handlers.onClickCapture(click);
    expect(opens).toEqual([{ x: 5, y: 6 }]);
    expect(click.stopped).toBe(true);
  });
});
