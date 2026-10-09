import type { MouseEvent, PointerEvent, ReactNode } from "react";
import { Keyboard } from "lucide-react";

import "./KeyBar.css";

import type { KeyBarKey } from "../lib/keys.ts";
import { t } from "../lib/i18n.ts";
import type { Emit } from "../ui/bubble.ts";

export type { KeyBarKey };

export interface KeyBarModel {
  /** an input method is composing in the input line */
  disabled: boolean;
  /** Control is armed for the next key */
  ctrlArmed: boolean;
  /** on a touch screen: whether the keyboard types straight into the terminal (else the input line); null elsewhere, with no toggle */
  directTyping: boolean | null;
}

export type KeyBarEvent =
  /** every key except Control, which arms the one-shot modifier instead */
  | { type: "key-bar-key"; key: KeyBarKey }
  | { type: "toggle-ctrl" }
  | { type: "toggle-direct" };

/**
 * Cancelling pointerdown AND mousedown keeps focus, and with it the soft
 * keyboard, on xterm's textarea; the click still fires.
 */
function keepFocus(event: PointerEvent<HTMLButtonElement> | MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
}

interface KeyProps {
  disabled?: boolean;
  dataKey: string;
  label?: string;
  pressed?: boolean;
  onPress: () => void;
  children: ReactNode;
}

function Key({ dataKey, label, pressed, onPress, children, disabled }: KeyProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`key${pressed ? " is-armed" : ""}`}
      data-key={dataKey}
      aria-label={label}
      aria-pressed={pressed}
      tabIndex={-1}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={onPress}
    >
      {children}
    </button>
  );
}

type Direction = "up" | "down" | "left" | "right";

const CHEVRON: Record<Direction, string> = {
  up: "M5 12.5l5-5 5 5",
  down: "M5 7.5l5 5 5-5",
  left: "M12.5 5l-5 5 5 5",
  right: "M7.5 5l5 5-5 5",
};

function Chevron({ direction }: { direction: Direction }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={CHEVRON[direction]} />
    </svg>
  );
}

export const ARROWS: ReadonlyArray<{ key: KeyBarKey; label: string; direction: Direction }> = [
  { key: "ArrowUp", label: "Up", direction: "up" },
  { key: "ArrowDown", label: "Down", direction: "down" },
  { key: "ArrowLeft", label: "Left", direction: "left" },
  { key: "ArrowRight", label: "Right", direction: "right" },
];

/**
 * Touch key bar under the terminal. Keys are tabIndex -1 on purpose: they exist
 * for touch, a hardware keyboard already has all of them. Hence role="group", not
 * toolbar: a toolbar promises arrow-key navigation between items, which these skip.
 */
export function KeyBar({ model, emit }: { model: KeyBarModel; emit: Emit<KeyBarEvent> }) {
  const { disabled, ctrlArmed, directTyping } = model;
  const onKey = (key: KeyBarKey): void => emit({ type: "key-bar-key", key });
  return (
    <div className="key-bar" role="group" aria-label={t("Terminal keys")}>
      {/* first: on a narrow cover screen the row scrolls, and the mode toggle must not be the key cut off */}
      {directTyping !== null && (
        <Key disabled={disabled} dataKey="direct" label={t("Type straight into the terminal")} pressed={directTyping} onPress={() => emit({ type: "toggle-direct" })}>
          <Keyboard aria-hidden="true" />
        </Key>
      )}
      <Key disabled={disabled} dataKey="Escape" onPress={() => onKey("Escape")}>
        Esc
      </Key>
      <Key disabled={disabled} dataKey="Tab" onPress={() => onKey("Tab")}>
        Tab
      </Key>
      <Key disabled={disabled} dataKey="Control" pressed={ctrlArmed} onPress={() => emit({ type: "toggle-ctrl" })}>
        Ctrl
      </Key>
      {ARROWS.map((arrow) => (
        <Key disabled={disabled} key={arrow.key} dataKey={arrow.key} label={t(arrow.label)} onPress={() => onKey(arrow.key)}>
          <Chevron direction={arrow.direction} />
        </Key>
      ))}
      <Key disabled={disabled} dataKey="ctrl-c" label={t("Control C")} onPress={() => onKey("ctrl-c")}>
        ^C
      </Key>
    </div>
  );
}
